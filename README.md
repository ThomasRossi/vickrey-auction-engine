# @kickbacks/auction-engine

A single-slot sealed-bid second-price (**Vickrey**) ad auction engine, packaged as a framework-agnostic TypeScript library. Designed to drop into the [kickbacks.ai](https://github.com/andrewmccalip/kickbacks) backend without bringing any of its HTTP, routing, auth, or persistence assumptions along for the ride.

```bash
npm install
npm test         # 83 tests, ~300ms
npm run bench    # hot-path microbenchmarks
```

---

## What this is, and why it looks the way it does

This document explains the design decisions behind the engine. For a runnable example of how a host wires the engine into a Fastify backend, see `examples/fastify-host.ts`.

### The auction: why second-price, not English, not first-price

The original kickbacks backend was advertised as an English auction. English (ascending, open-cry) is the wrong tool for ad serving for two structural reasons:

1. **There is no "round."** An ad impression is a one-shot decision made in milliseconds; there is no time for bidders to react to one another. English auctions require multiple rounds and visible bids — neither exists in this setting.
2. **Bidders cannot see each other.** Advertiser bids are confidential. An English auction's price-discovery mechanism depends on visibility; with sealed bids, "English" just collapses to first-price.

First-price is also a poor fit, because it incentivises **bid shading** — advertisers bid below their true value to avoid overpaying, then build bid-shading models to estimate how much to shade, and you spend the next year fighting those models. The whole industry walked through this around 2018; the takeaway was: don't.

**Second-price (Vickrey)** is the sealed-bid auction where the winner pays the second-highest bid (or the reserve, whichever is higher). Its defining property is that **bidding your true value is the dominant strategy** — there is no game-theoretic reason to bid anything but your real willingness-to-pay. This collapses the entire bid-shading problem.

With a single ad slot, second-price is also exactly what Generalized Second-Price (GSP) reduces to — so there is no extra complexity from picking Vickrey over GSP at this scale.

The clearing rule, end to end, lives in `src/engine/auction.ts`:

> 1. Filter eligible candidates (active, has budget, targeting matches).
> 2. Drop anything below the reserve.
> 3. Rank by effective bid. In pure-CPM mode that's just the bid; in eCPM mode it's `bid × qualityFactor`.
> 4. Winner: argmax. Clearing price: `max(secondHighestEligible, reserve)`.
> 5. Break ties with a seeded RNG, so delivery is fair and tests are reproducible.

### In practice: what an advertiser does, and what the engine sees

The abstract auction theory above is easy to lose the plot on, so here is the concrete end-to-end. There are three actors: the **advertiser**, who wants their ad shown; the **host backend**, which owns the campaigns table and the HTTP routes; and the **engine**, which clears auctions and settles money.

**1. The advertiser creates a campaign.** Through the host's UI or admin API, they specify:

- **A max CPM.** "I am willing to pay up to $X for a thousand impressions." Under second-price, this is genuinely the most they'll ever pay — they will usually pay less, and they have no reason to bid anything other than their true value. This is the `max_cpm_micros` column on the `campaigns` table.
- **A budget, expressed in 1,000-impression blocks.** Inventory in this engine is sold by the block, not by dollar budget. The advertiser buys, say, 500 blocks = 500,000 impressions; the campaign starts with `remaining_impressions = 500_000`. (Why blocks? Pricing is easier to reason about, pacing math is simpler, and "your campaign delivered 87% of what you bought" is a more honest metric than "your campaign spent 87% of its dollars" when the second-price clearing means the actual dollar spend is unpredictable.)
- **Targeting.** Rules that determine *which* portfolio requests this campaign is allowed to compete in. A campaign with no targeting rules can clear against any request. A campaign with strict rules only clears when the request matches all of them. Three dimensions are supported, all stored in the `targeting` JSONB column:
  - `surface_ids` — which placement(s) the ad is eligible for. The "surface" is wherever an ad slot lives in the product. For Kickbacks today there is essentially one surface (the spinner that fills the waiting line while the model is generating a response), so **in practice this will almost always be left empty** — meaning "all surfaces." It exists in the schema because the moment a second surface ships (a banner on the export page, a card on the settings screen, anything), advertisers need to be able to opt in or out of it, and retrofitting that into a running ledger is painful. Cheap to ignore now, expensive to add later.
  - `surface_version_range` — a `[min, max]` pair (either side nullable) gating on a surface revision number. Useful when the layout of a placement changes in a way that breaks creatives. If a campaign was built for the old v1 spinner with a 320×50 banner and v2 ships a 728×90 layout, the advertiser can pin `[null, 1]` and not auto-serve into the new dimensions. Like `surface_ids`, **expected to be empty for v1** — there is only one version of the surface.
  - `geos` — a list of ISO country codes the campaign is allowed in. Empty = all geos. This *will* get used: advertisers care about jurisdiction (compliance, currency, language).

  Example of a fully-specified targeting payload, for what it'll look like once there's more than one surface:

  ```json
  {
    "surface_ids": [1],
    "surface_version_range": [2, null],
    "geos": ["US", "CA"]
  }
  ```

  Read: "only the spinner surface (id 1), only v2 or later of it, and only when the request comes from a US or Canadian user." For a campaign that's happy to run anywhere on anything, the payload is just `{ "surface_ids": [], "surface_version_range": [null, null], "geos": [] }` — and that's what almost every Kickbacks v1 campaign will look like.
- **Schedule.** `starts_at_ms` and `ends_at_ms`. Outside this window the campaign is invisible.
- **Mode.** `live` or `demo` — demo campaigns only clear against demo portfolio requests, and vice versa.
- **Optionally, a quality factor.** A precomputed multiplier reflecting relevance / engagement / whatever the host wants to rank by beyond raw CPM. Defaults to 1.0. Only used in eCPM mode; in pure mode the engine forces it to 1 so ranking stays in integer space.

That's the complete advertiser-facing contract. There is no bid frequency to set, no rotation strategy to configure, no shading parameter to tune. You set your max value and your budget, and the engine handles the rest.

**2. The host loads campaigns into the in-memory index.** The auction does not hit Postgres on the hot path — it would be too slow at ad-tech rates. Instead, the host maintains an in-memory `CampaignIndex` that the engine queries synchronously. The host's job is to keep this index warm: poll the `campaigns` table every few seconds, or subscribe to `LISTEN/NOTIFY`, or whatever fits. On refresh, the host filters out anything that fails `isCampaignLive` (active, not killed, within schedule, budget remaining) and pre-groups the survivors by `(surface_id, surface_version, geo, mode)` so that `candidatesFor(request)` is an O(1) hashmap lookup, not a scan.

The engine ships `isCampaignLive`, `matchesTargeting`, and `isEligible` in `src/engine/eligibility.ts` precisely so the host's index-loader uses the same predicates as the engine's mental model — eliminating the class of bug where the index says "this campaign is eligible" and the engine disagrees.

**3. A portfolio request arrives.** The client calls `/v1/portfolio` with a user id, the surface they're browsing, the surface version, the geo, the mode, and how many ads they want queued. The host hands this off as a `PortfolioRequest`. The engine:

- Asks `CampaignIndex.candidatesFor(req)` for the matching candidates. Each comes back as a `CandidateBid`: campaign id, advertiser id, `cpm_micros`, `quality_factor`, `remaining_impressions`.
- Runs `clearPortfolio` to find the top `depth` distinct winners with their second-price clearing prices.
- Asks `PacingStore` to reserve capacity for each winner (one batched Redis round-trip). Any winner whose token-bucket is empty is dropped from the queue.
- Mints a signed token for each surviving winner stamping `(campaign_id, advertiser_id, clearing_price_micros, user_id_hash, mode, surface_id, issued_at_ms)`.
- Reads the user's balance from `LedgerRepo` and returns the queue.

**4. The client renders ads. The user views one for 3+ seconds, or clicks.** The client posts the event to `/v1/metrics` with the session token from the queue. The engine verifies the token, dedupes against replays, and posts a single double-entry transaction to the ledger: the advertiser is debited the clearing price (50× it for a click), the user is credited their share (or zero in demo mode).

**5. The host drains the outbox.** A worker reads new `outbox` rows and updates the `balances` projection. Separately, the host also reads the ledger to decrement `campaigns.remaining_impressions` for each settled event — when a campaign hits zero, the next index refresh stops returning it as eligible, and it naturally drops out of auctions without any kill switch having to fire.

That's the complete loop. **Advertiser sets max CPM and budget once; everything else is automatic.** They don't tune bids per request, they don't manage rotation, they don't pick a winner — they just declare their willingness to pay and let the auction sort it out.

### The serving model: why a queue, not per-impression auctions

A naive design runs a fresh auction for every ad impression: the client asks the server, the server clears, the server returns one ad. That sounds clean, but it has two real problems:

1. **Latency.** Every impression eats a server round-trip. The user sees a hole in the UI while you wait.
2. **Coupling.** If the network blips mid-session, the user has zero ads queued and the experience degrades to a blank surface.

So the engine doesn't run auctions per impression. Instead, **`/v1/portfolio` returns a short ranked queue of `depth` ads with a TTL**. The client drains the queue locally — rotating to the next ad after the rotation interval — and refetches before exhaustion. The engine clears `depth` distinct slots in one pass (`clearPortfolio` in `src/engine/auction.ts`), excluding each winner from the next slot's pool so the queue isn't a single ad repeated `depth` times.

This pattern is also what the kickbacks client already expects, so the server now matches the client's natural rhythm instead of fighting it.

The portfolio response carries server-authoritative `ttl_ms`, `rotation_interval_ms`, and `view_threshold_ms` — the client never sends these. That's deliberate: a malicious client could otherwise claim "the view threshold was met in 1ms" and steal payouts.

### Why session tokens?

This is the most important piece of the design and the easiest to get wrong, so it warrants its own section.

When the server queues an ad, the auction has already determined three things that matter for settlement:
- **Which campaign won.**
- **What clearing price was struck** (the second-price, not the advertiser's max).
- **Who the user is, on what surface, in what mode (live vs. demo).**

When the client later reports "the user viewed this ad for 3.2 seconds, charge it," the server needs to bind that report back to the original clearing decision. The naive option is a database table: `served_tokens(id, campaign_id, clearing_price, user_id, ...)`, write a row on every served ad, look it up on every settled event. This works, but at ad-tech throughput it means **two writes and one read per impression cycle, on the hot path, just to remember a decision the server already made.**

So instead, the engine **stamps the entire decision into a cryptographically signed token** and hands that token to the client. The client returns the token at `/v1/metrics`. The server verifies the HMAC, reads the clearing price out of the token's payload, and posts the ledger entry — **with no server-side lookup on the hot path**. The token is the database.

The format (in `src/engine/token.ts`) is a fixed 64-byte binary layout — 32 bytes of payload (campaign id, advertiser id, clearing price, user id hash, mode, surface id, issued-at) plus a 32-byte HMAC-SHA256 — base64url-encoded to ~88 characters. JSON was deliberately avoided to keep sign/verify allocation-free and roughly 1µs each.

This pattern has three consequences worth knowing:

- **The token is the authoritative price.** Settlement always charges the price stamped in the token, *not* whatever the advertiser's max bid happens to be at settlement time. Bid changes after the token is issued cannot affect what gets billed for that impression. This is what makes the second-price guarantee actually hold under real-world bid-table churn.
- **Tampering is detected automatically.** If any byte of the payload is flipped — even just the clearing price — the HMAC no longer matches and `verify()` returns `null`. The settlement path treats this like a bad token and refuses.
- **Tokens expire.** `verify()` checks the issued-at against a configured `tokenLifetimeMs`. Expired tokens are rejected, so an attacker can't stockpile tokens to spend later.

There is still a `served_tokens` table in the Postgres schema, but it's written *asynchronously via the outbox* for forensics and reporting — not on the serving path. The serving path is in-memory + sign-and-return.

### Settlement: idempotency, the outbox, and why the ledger is double-entry

Settlement (`src/engine/settlement.ts`) is what turns a confirmed `/v1/metrics` event into money moving on the books. Three things make it more interesting than "decrement a counter":

**1. The network retries.** Mobile clients, broken connections, retry logic that wasn't supposed to fire — the same `(token, event_id)` pair can arrive at the server twice. If you naively double-charge the advertiser on every retry, you have a billing bug that destroys advertiser trust the first time it happens.

So settlement claims an **idempotency key** in Redis (`SET key '1' NX EX ttl`) on `(mode, token_hash, event_id)`. If the key already exists, we return `'duplicate'` and post nothing. The Postgres ledger also carries a `UNIQUE (source_token_hash, event_id, event_kind)` constraint as belt-and-suspenders for the rare case Redis loses state.

**2. The ledger is real money.** Charging an advertiser and crediting a user are two halves of the same transaction; they cannot drift apart. So the ledger (`ledger_entries`) is **append-only and double-entry**: every row records both the advertiser debit and the user credit (zero in demo mode). The schema enforces `credit_micros <= debit_micros` so the system can never pay out more than it took in.

Crucially: the balances the client sees are **not** stored next to the user account. They are a projection of the ledger, materialised by an outbox worker. This means the client's view of "how much have I earned" can always be reconciled back to specific events, and a balance bug is a query bug, not a money bug.

**3. The hot path can't wait for projections.** When `/v1/metrics` is called, we want one Postgres transaction and one Redis round-trip — full stop. So settlement uses the **transactional outbox pattern**: the same SQL transaction that writes the `ledger_entries` row also writes a row to `outbox`. A separate worker process drains the outbox into the `balances` materialised view (and any other downstream consumer that wants to know about settled events). This decouples ingestion from projection: a slow projection worker cannot back-pressure the hot path.

We don't need Kafka for this. Kafka is the right answer when you have multiple independent downstreams that all want at-least-once delivery; for one projection worker, a Postgres outbox is simpler, ACID, and easy to operate. Revisit if scale demands.

**4. The 50× click weight.** A click is worth roughly 50× an impression by the configured `clickWeight`. This is just a multiplier on the stamped clearing price — same code path as an impression, same ledger row shape.

### Proof of work: making fabricated events expensive

The signed session token guarantees that the server's clearing decision can't be tampered with on the way to settlement. What it can't guarantee is that an event actually happened. A reverse-engineered client can request a legitimate portfolio, receive a real signed token, and then post `/v1/metrics` events that are byte-for-byte indistinguishable from honest traffic — they just claim views that never rendered to a screen. Idempotency stops **replays**, not **fabrications**: each forged event picks a fresh `event_id` and bypasses the idempotency key.

This isn't theoretical. The kickbacks team has seen exactly this attack in the wild, with a script that emulates the cadence of a real client to harvest payouts at scale.

The defense is a small **SHA-256 hash-cash proof of work** the client must produce per metrics event:

> Find `solution` such that `sha256(nonce ‖ solution)` has at least `K` leading zero bits.

The nonce is **deterministically derived from `(sessionToken, eventId)`** so the server doesn't need to store anything per puzzle. The difficulty `K` is set by `EngineConfig.powDifficultyBits` and reported to the client in the portfolio response so it knows how much work to do. The settlement path recomputes the puzzle from the submitted `token` and `eventId`, verifies the solution in one SHA-256, and rejects with `bad_pow` if it doesn't meet the bar.

**Why bind the puzzle to `eventId`, not just the token.** The engine allows more than one event per token — an impression at the 3 s mark, then a click later. If the puzzle were token-scoped, an attacker would solve it once and then spam an unbounded number of fake events under the same solution. Per-event binding means **N fake events cost N puzzle solves** — the asymmetry that makes the attack expensive scales linearly with fraud volume rather than being amortised away.

**Why a time floor.** Hash-cash only works because the only way to find the solution is to grind. CPU clients grind at roughly the rate `K` was calibrated for; a GPU or ASIC grinds much faster and could land a valid solution in milliseconds. To bound this, settlement also rejects events whose `nowMs - tokenIssuedAtMs < powMinElapsedMs`. Honest clients are unaffected — they're going to wait the view threshold anyway — but fast solvers get cut off below the intended cost floor.

**Why it isn't security theatre.** Hash-cash doesn't *stop* a determined attacker with a GPU farm and patience; it makes fabrication **cost CPU time per fake event**. With `K` calibrated so honest devices spend ~3 s of one worker thread per impression (in practice ~18–20 bits on a typical phone), a 16-core attacker fakes at most a handful of events per second per token they hold — versus an unbounded rate without it. That's the difference between "free fraud" and "a CPU-bound business problem the attacker has to solve." Combined with rate limits at the host layer, it's enough.

**Where it lives.** The puzzle library is a subpath export, not part of the engine core:

```ts
import {
  issuePuzzle,   // fresh random puzzle
  derivePuzzle,  // deterministic puzzle from a binding string
  solve,         // grind a solution (client / tests only)
  verify,        // one SHA-256
} from '@kickbacks/auction-engine/pow';
```

`src/pow/` has zero engine awareness — no token, no event, no auction. The engine wires it into settlement; any other surface in the host (abusive form submissions, rate-limited APIs, anything that wants per-request cost) can use it the same way.

**Wiring on the server.** Already done — set the two new config knobs:

```ts
createEngine(deps, {
  // ...existing fields...
  powDifficultyBits: 18,   // server-authoritative; clients can't lower it
  powMinElapsedMs: 1_500,  // reject events that solve too fast
});
```

`runPortfolio` returns `powDifficultyBits` in the result; `settleEvent` reads `req.powSolution` and rejects with `bad_pow` or `pow_too_fast` if anything is off. The check runs **before** the idempotency claim, so a failed PoW doesn't waste a Redis slot.

**Wiring on the client.** Port the solver (it's ~15 lines of SHA-256 in a loop) into a Web Worker / coroutine / background thread so the UI stays responsive. When the ad renders:

1. Note `tokenIssuedAtMs` (or just "now").
2. Pick the `event_id` you'll submit with the impression — it must be the same one the puzzle is bound to.
3. Compute `nonce = sha256(`${sessionToken}:${eventId}`).slice(0, 16 hex)` and grind a solution at the difficulty the portfolio response specified.
4. When the view threshold elapses (you're going to wait anyway), POST `/v1/metrics` with the solution alongside `token`, `event_id`, `kind`, `viewed_ms`.

For clicks, do the same with the click's `event_id`. Different event, different puzzle, different solve.

**Rollout plan.** Ship with `powDifficultyBits: 0` so the wire format change deploys without rejecting any traffic. Confirm clients are sending `pow_solution`. Then ratchet difficulty up over a few releases — the server skips PoW entirely when configured difficulty is 0, so the change is safely staged.

**Calibrating `K`.** Run `solve(issuePuzzle(K))` on representative target hardware (low-end phone, mid-range phone, laptop). Pick the `K` where the lowest-end device lands within the view threshold. Typical answer is 18–20 bits.

### Money lives in integer micros

Every monetary value in the engine — bids, reserves, clearing prices, debits, credits — is stored as an integer number of **micros** (CPM × 10⁶). Floats appear only as the `qualityFactor` multiplier and are floored back to micros before any ledger write.

This is not pedantry. JavaScript's `number` is a 64-bit float, and `0.1 + 0.2 !== 0.3`. If you let those errors accumulate across millions of impressions, you eventually end up debiting an advertiser more than the auction said they owed. Integers eliminate that class of bug at the type level.

### Demo mode is a flag, not a fork

The signed-out preview on the client runs a **real** auction with **real** creatives — but the advertiser is charged to a demo ledger and the user gets no credit. The engine implements this by carrying a `mode: 'live' | 'demo'` field through the entire pipeline:

- The mode is stamped into the session token at portfolio time.
- The settlement path reads it back from the token and routes the ledger entry accordingly.
- The user credit is set to zero in demo mode; the advertiser debit is unchanged.

There is no separate `runDemoPortfolio` function. There is no `if demo { ... } else { ... }` branch in the auction. The same code clears the auction, mints the token, verifies the token, and posts the ledger entry; the only difference is which row of the `ledger_entries` table it lands in.

This matters because **the preview must represent the real product**. If demo and live diverge, the preview stops being a preview and starts being a parallel implementation that drifts. Don't reintroduce the fork.

---

## Architecture: the boundary, the ports, the host

The engine is a **library**, not a service. It exposes two async functions:

```ts
const engine = createEngine(deps, cfg);
engine.runPortfolio(request) // returns the ranked queue + tokens + balances
engine.settleEvent(request)  // verifies the token, posts the ledger entry
```

Everything else — the HTTP framework, route handlers, JSON schemas, authentication, rate limiting, structured logging, snake_case wire format — lives in the **host** backend that imports this library. The engine has no opinion on any of it.

The bridge between the engine and the outside world is a small set of **ports** (`src/engine/ports.ts`):

| Port | What it does | Production impl |
|---|---|---|
| `CampaignIndex` | Returns already-targeted candidate bids for a request | In-memory cache, host-refreshed from Postgres |
| `PacingStore` | Reserves pacing capacity for a winner | Redis token-bucket (one Lua script, one RTT) |
| `IdempotencyStore` | `SET NX EX` for dedupe | Redis |
| `LedgerRepo` | Writes a ledger entry + outbox row in one tx | Postgres |
| `TokenSigner` | Signs and verifies session tokens | HMAC-SHA256 over fixed binary layout |
| `Clock` | Returns current time | `Date.now()` |
| `Rng` | Allocation-free seeded RNG for tie-breaks | xorshift32 |

Each port has a real adapter in `src/adapters/{redis,postgres,memory}/` and an in-memory fake under `adapters/memory/` for tests. Anything the engine wants to do that doesn't fit through one of these ports is, by design, the host's problem.

### The hot path, end-to-end

For one `runPortfolio` call serving `depth` ads to one user:

1. One synchronous call into `CampaignIndex` — in-memory, host-managed cache.
2. One pass of `clearPortfolio` — O(depth × N) where N = eligible candidates, no sorting, no allocations beyond a small `Uint8Array` bitmap. Measured: ~3 µs at N = 200, depth = 5 on an M1 laptop.
3. One batched Redis round-trip to reserve pacing capacity for the winners (atomic Lua token-bucket).
4. `depth` HMAC signs, each ~1 µs.
5. One Postgres read for the user's balance (could be cached by the host).

For one `settleEvent` call:

1. One HMAC verify, ~1 µs.
2. One PoW verify (one SHA-256) — skipped entirely when `powDifficultyBits` is 0.
3. One Redis `SET NX EX` for idempotency.
4. One Postgres transaction: insert into `impressions` or `clicks`, insert into `ledger_entries`, insert into `outbox`. All under one `BEGIN/COMMIT`.

That's the entire serving and settlement loop. There is no per-impression auction, no served-tokens lookup on the hot path, no synchronous projection update.

---

## Repo layout

```
src/
  index.ts                       Public API: createEngine(deps, cfg)
  engine/
    auction.ts                   Vickrey clearing (clearOneSlot, clearPortfolio)
    eligibility.ts               Pure predicates for index-loader use
    pricing.ts                   Money math (micros, click weight, user share)
    portfolio.ts                 Orchestration: filter → clear → pace → mint
    settlement.ts                Verify token → idempotency → post ledger
    token.ts                     Binary HMAC sign/verify
    rng.ts                       xorshift32, fnv1a32, deriveSeed
    types.ts                     Internal domain types
    ports.ts                     CampaignIndex, PacingStore, LedgerRepo, ...
  pow/
    index.ts                     Generic SHA-256 hash-cash; subpath export
                                 @kickbacks/auction-engine/pow
  adapters/
    memory/                      In-memory fakes for tests
    redis/                       Token-bucket pacing (Lua), SET NX EX idempotency
    postgres/                    LedgerRepo with transactional outbox
  sql/
    0001_init.sql                Schema: campaigns, ledger, outbox, balances, ...
test/
  *.spec.ts                      83 tests across all of the above
bench/
  auction.bench.ts               Microbenchmarks for the hot path
examples/
  fastify-host.ts                Reference wiring (NOT shipped — documentation)
```

---

## Running it

```bash
npm install
npm test                              # full vitest suite
npm test -- portfolio                 # just the end-to-end portfolio + settlement
npm test -- auction                   # just the auction property tests
npx vitest run test/portfolio.spec.ts --reporter=verbose
                                      # verbose per-test output
npm run test:watch                    # live re-run on file change
npm run bench                         # hot-path microbenchmarks
npm run typecheck                     # tsc --noEmit
npm run build                         # emit dist/
```

There is no `start` script — this is a library, not a service. To see it serving real HTTP traffic, adapt `examples/fastify-host.ts` into the host backend.

---

## Adapting it

When you merge this into the kickbacks backend, the engine itself should not need to change. You'll be doing four things:

1. **Wire the ports.** Construct a `pg.Pool`, an `ioredis` client, and a secret; pass them to the `create*` factories in `adapters/`. See `examples/fastify-host.ts` for a worked example.
2. **Provide the campaign index.** This is yours. The engine doesn't know how you want to refresh it; common patterns are a 5s polling loader or `LISTEN/NOTIFY` from Postgres. Either way, what `candidatesFor()` returns must be in-memory — the engine never hits the DB on the hot path.
3. **Map snake_case ↔ camelCase at the route layer.** The engine deals in camelCase domain types; the wire format is snake_case. Convert once at the boundary. Fastify's JSON Schema works well for this.
4. **Run the outbox worker.** A small process that reads unprocessed `outbox` rows, updates the `balances` projection, and stamps `processed_at`. The engine writes to the outbox; it does not drain it.

If you find yourself wanting to add an HTTP framework dependency to `src/engine/`, you're modifying the wrong layer. The boundary is there on purpose.

---

## Things this engine deliberately does not do (yet)

- **Frequency capping.** Easy to add as another eligibility predicate when it matters.
- **Multi-slot auctions.** GSP across multiple positions is a different (harder) problem; not needed for a single-slot ad surface.
- **OpenRTB.** Real-time bidding integrations belong in a separate adapter if and when external demand arrives.
- **Bid shading.** Not needed — Vickrey makes truthful bidding dominant. Don't reintroduce this.
- **Click fraud detection beyond cost-per-event.** Token verification, idempotency, and per-event proof of work bound how cheap fabrication can be. Anything more sophisticated — behavioural models, device attestation, IP reputation — belongs in a separate service that can reject events before they reach `settleEvent`.
