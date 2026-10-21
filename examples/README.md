# Examples

The launch examples use the public `@black-market/sdk` 0.12.0 package and viem.
Build this checkout before running its examples; in a consumer project install
`@black-market/sdk@0.12.0` for opt-in UFG treasuries and current proof semantics.
The default chain-4663 launch cases retain
the October8 mined fixed pool-bound V4 config6/V2 and canonical Abyss config1 deployment.
The SDK additionally knows the October11 zero-author-royalty Dynamic Fee Hook;
its registration does not change the fixed cases' selection or fee schedule.
HMM Fixed/Dynamic V2 are additional admitted October17 presets; their required
512-byte typed launch tail and explicit bid/reference guards are demonstrated by
`hmm-launch-config.ts`. The generic HMM profile keys now select V2 only.
Existing fixed cases are intentionally unchanged. See the lifecycle guide for
the breaking migration, per-swap funding and fee-owner configuration/pause ABIs.
Historical October5 config5 evidence is not relabeled as these graphs. Discovery
is read-only; fixed launch examples default to an unsigned dry run. Only
`--broadcast` (or deliberate `--resume` continuation) authorizes real writes.

Use Node 24+ to run these TypeScript files directly, for example
`pnpm build && node examples/quickstart.ts`. No extra runtime dependency or
`--experimental-strip-types` flag is needed. The build emits the SDK used by the
examples; their relative support imports use explicit `.ts` extensions for Node ESM.

| Script | Behavior |
| --- | --- |
| `quickstart.ts` | Reads the current mainnet orchestrator, checks its registry binding, and discovers admitted profiles. No wallet or writes. |
| `hmm-launch-config.ts` | Pure HMM V2 fixed/dynamic config construction with caller-chosen bid/reference guards and an automatically appended 512-byte launch tail; no RPC, signatures or writes. |
| `ufg-launch-config.ts` | Pure fixed/dynamic UFG quote-only config6 construction, canonical reserve tail and config hash; no RPC, wallet or writes. |
| `launch.ts` | Reviews/reconstructs an explicit saved plan and selected atomic/staged mode; optional offchain config6/V2 salt mining. Prints simulation, progress, and an admitted unsigned next transaction when evidence permits. |
| `generate-lifecycle-commitment-fixture.ts` | Frozen independent historical config4/Abyss ABI bytes/hash/identity vector. Its pre-cutover allocations are not an executable 0.7.1 plan. |
| `launch-lifecycle-smoke.ts` | Actual SDK launch/recovery/custody/fee operations, only on an explicitly authorized owned disposable loopback graph. |
| `launch-erc20-*.ts`, `launch-erc404-*.ts` | Eleven independent fixed cases: unsigned end-to-end planning by default; `--broadcast` adds guarded local signing, chain verification and mandatory API publication/indexing. |

## UFG treasury configuration

Run `pnpm build && node examples/ufg-launch-config.ts` for a pure consumer example.
Real UFG plans use the proxy as creator and a principal-namespaced nonce, with
`ufg: { config }` on `prepareAndPlanLifecycleLaunch`; the principal remains the
planning/signing account. Use only reward-free ERC20, full treasury reserve share,
launch-token burn policies, Abyss QUOTE/QUOTE_ORACLE or the UFG fixed/dynamic
presets. Approvals go to the proxy. The existing eleven launch cases and their
selected non-UFG offerings are intentionally unchanged.

The opt-in owned-fork regression is `test/integration/ufg-launch.fork.mjs`; see the
[lifecycle guide](../docs/launch-lifecycle.md#ufg-owned-fork-check).

## Deployed read-only discovery

```sh
pnpm install
pnpm examples
# Optional: RPC_URL=https://your-robinhood-rpc pnpm examples
```

`CHAIN_ID` defaults to `4663`. Local `31337` and workbench `46631` require a matching
RPC and explicit `LAUNCH_ORCHESTRATOR`, `LAUNCH_IMPLEMENTATION_REGISTRY`, and
`LAUNCH_FEE_OWNER_REGISTRY`. The example checks RPC chain identity and registry binding.
Profile discovery verifies live registry admission and certified dependencies; it does
not build/sign a launch, choose a developer fee, or select market economics.

## Unsigned saved-plan review

Supply full `LaunchPlanV1` JSON using the selected RPC's current deployment:

```sh
pnpm build
node examples/launch.ts \
  --plan plan.json --rpc https://rpc.mainnet.chain.robinhood.com/ --mode staged --mine
```

`--mine` uses `prepareAndPlanLifecycleLaunch` to finalize config6/V2 salts and admit the
requested mode in one SDK-owned invocation. Persist its exact returned plan before
begin. `--receipts receipt-references.json` takes a JSON array of SDK receipt
references, with bigint block numbers encoded as decimal strings; `--confirmations N`
restores the selected canonical recovery depth. The CLI checks source chain identity
before discovery. It never signs, submits source-chain transactions, uploads metadata,
or publishes a launch. Modes never fall back silently.

Executable admission requires actual stateful measurement and exact validated replay.
`--limits current-limits.json` is optional tightening policy, not a required backend:
missing caps stay explicit uncertainty, while supplied malformed/stale/mismatched
provenance rejects. Encode bigint values as decimal strings. Robinhood `4663` reads
pinned native Nitro compute/poster evidence and requires native `eth_simulateV1`.
A **separate disposable loopback fork** (`--fork-rpc URL`) remains available for
generic EVM, not as a Nitro metering substitute. Unsigned review reports
`transportPreflight: "not-requested"` unless a consumer supplies its active submission
RPC to build-next. See the
[lifecycle guide](../docs/launch-lifecycle.md#execution-constraints-and-stateful-simulation).

Robinhood defaults to a 50M aggregate simulation gas-used budget. Inspect
`simulation.deferredTransactionIds`: admitted/proved means the proven prefix,
not every future transaction or eventual activation. Deferred commands have no
gas/price/estimate/admission; obtain each fresh immediate envelope through
`buildNextTransaction` after canonical progress advances. Reviewed envelopes are
replayed directly, without measuring/replaying the suffix again. The saved-plan
CLI prints proof coverage and never signs. Override `limits.maxSimulationGas` only
for a provider that supports the selected budget. Examples requiring actual
activation outputs for `buySlippageBps` or economic review refuse if activation is
deferred; use a suitably higher-budget provider rather than inventing buy outputs.


For a real new graph, create the saved plan using `readLifecycleProfiles` with its
explicit chain/core and admitted pool-bound config6 profile. Supply that graph's RPC
to `launch.ts`; do not substitute the historical known preset. Applications may use
the existing `LAUNCH_ORCHESTRATOR`, `LAUNCH_IMPLEMENTATION_REGISTRY`, and
`LAUNCH_FEE_OWNER_REGISTRY` overrides from the same authentic deployment evidence.
The SDK certifies actual registry/creation-code/runtime/constructor bindings and
requires real execution proof; setting configuration does not certify a graph.

## Real HTTP metadata sessions

The real HTTP integration suite uses the public `LaunchApiClient` against a separately
running service. Reads are unsigned; metadata-session writes require a disposable key
and an owned loopback service with real application storage:

```sh
LAUNCH_API_TEST_URL=http://127.0.0.1:18763 pnpm test:api
LAUNCH_API_TEST_URL=http://127.0.0.1:18763 \
LAUNCH_API_TEST_PRIVATE_KEY="$DISPOSABLE_TEST_PRIVATE_KEY" pnpm test:api:write
```

These are metadata-only session tests, not token deployment or image/transaction
publication. No image store, indexer, wallet balance, or chain transaction is needed.
See [service prerequisites](../docs/launch-lifecycle.md#real-http-api-integration).

## Individual token creation

**Without a mode flag, these files are dry runs: no transactions are signed or
broadcast, and no metadata/image is uploaded or published. `--broadcast` signs,
spends real funds and publishes to your configured API. Mainnet execution is
irreversible.** Choose one case per intended launch.

### Two-step flow: dry run, then broadcast

```sh
# 1. Discover, build funding and plan; print the complete economic review and save artifacts.
node examples/launch-erc20-v4.ts
# 2. After reviewing the output, explicitly execute the same case.
node examples/launch-erc20-v4.ts --broadcast
```

The default output starts with **DRY RUN — no transactions signed or broadcast.**
It performs the same profile discovery, quote/funding builds, image descriptor
freezing, economics, salt preparation and planner admission as execution, then
exits `0` on successful planning. It saves `plan.json`, `economic-review.json`,
`planning.json` and all other planning evidence in a fresh `launch-results/` directory.
The creator's public address is derived locally (including authenticated keystore
decryption when selected), but no wallet signer is created. The final output line
is the exact case command with `--broadcast` appended.

**Choosing `--broadcast` is the authorization. It deliberately skips manual
economic-review admission: there is no interactive hash prompt or hash input.**
The full review is still printed and saved, including its computed provenance hash.
The broadcast run plans afresh with current state, fresh random identity and funding
builds; it does not submit the dry run's saved plan. Planner admission, unchanged
economic authority, deadlines, image verification and canonical/reorg barriers remain
mandatory before signing and publication.
`--resume <recovery-dir>` retains its existing continuation/publication behavior;
it does not become a dry run and does not need `--broadcast`. Unknown, duplicated
or combined mode flags fail before configuration or artifact creation with usage text.

### Setup once

Use **Node 24+**. In this repository run `pnpm install`. In a consumer project install
both public dependencies with `pnpm add @black-market/sdk viem` (or
`npm install @black-market/sdk viem`) and copy the selected files with
`launch-example.ts`, `launch-example-support.ts`, and `launch-example-kyber.ts`
into `examples/`, using the matching updated SDK build.
Copy `examples/.env.example` to `.env` in the directory you will run commands from:

```sh
cp examples/.env.example .env
chmod 600 .env
```

Edit `.env` once:

```dotenv
PRIVATE_KEY=
LAUNCH_API_URL=
RPC_URL=
```

Configure **exactly one** signer: your funded EOA's 32-byte `PRIVATE_KEY`, or
`EXAMPLE_KEYSTORE_PATH` pointing to a local V3 scrypt/AES-128-CTR JSON keystore.
`EXAMPLE_KEYSTORE_PASSWORD` defaults to the empty string; both/neither signer
sources reject. The keystore must be a regular owner-only file owned by your user;
the bounded loader authenticates its Keccak MAC and declared address before deriving
the creator. It uses Node crypto and existing viem, with no extra dependency.
Dry-run configuration derives only the public creator address; signing methods are
constructed only in broadcast or nonterminal resume execution.
Never commit the keystore/password or use a published test key for a real launch.
Set `LAUNCH_API_URL` to your actual HTTPS or owned loopback service root. There is
no default wallet, guessed metadata API, or silent API skip. The API needs actual
application storage and an indexer observing the same chain as the execution RPC.
Existing environment variables take precedence over the working-directory `.env`,
loaded once using Node's native `process.loadEnvFile`. No shell interpolation is used.

`EXAMPLE_BUY_AMOUNT_WEI` sets the exact **native ETH conversion input per opening
buy**, not the eventual WETH/USDG amount. Use a positive canonical decimal uint256
wei string; the default is `10000000000000` (**0.00001 ETH**). Kyber's app-compatible
exact-input domain additionally requires each aggregate input to be below `2^255`.
The runner aggregates ETH inputs per quote, obtains one fresh
`POST EXAMPLE_KYBER_API_URL/api/v1/quote/kyber/build?chainId=4663` build per quote,
and binds native zero-address input, exact input, sender/recipient equal to the
actual funding escrow, **50 bps conversion slippage**, and the same 300-second
launch-purpose deadline as the plan. The API owns fresh route preview; a preview
GET is not executable funding. `EXAMPLE_KYBER_API_URL` defaults to `LAUNCH_API_URL`
(the app's public trade default is `https://api.abyss.trading`); an explicit override
must meet the same HTTPS/owned-loopback safety rules.

Each funding row is `LifecycleFundingKind.Swap`, native zero-address `inputAsset`,
the reviewed router target and original built calldata. The runner decodes the
reviewed `swap` entry point and checks currencies, escrow recipient, exact input,
output floor, executor payload, flags and absence of redirected inputs/extra fees.
`amountOutMinimum = floor(amountOut * 9950 / 10000)` is the exact quote budget.
That budget is divided across the quote's ordered buys, with the integer remainder
in the last such buy, so their inputs sum exactly to the API minimum. No WETH/USDG
wallet balance or ERC20 approval is needed; the creator needs native ETH **plus gas**.
Registry target/spender/runtime admission is checked on the launch graph and
rechecked before signatures. Refusal, unavailable route, changed binding or expiry
stops unsigned with retained evidence: **never fall back to native-wrap, direct ERC20
funding, a separate wallet swap, dropped buys, or rewritten quote bytes/deadline**.

Optional `EXAMPLE_TOKEN_NAME`, `EXAMPLE_TOKEN_SYMBOL`, and
`EXAMPLE_TOKEN_DESCRIPTION` override each case's default metadata. Text is NFC
normalized and trimmed, with the unchanged API/lifecycle bounds (name: 100 Unicode
codepoints/128 UTF-8 bytes; symbol: 32 codepoints/bytes; description: 2000 codepoints).
`EXAMPLE_IMAGE_PATH` optionally loads 1 byte through 5 MiB of actual PNG/JPEG/WebP
bytes. The frozen image SHA-256/type/length is reviewed and signed, uploaded using
only the exact API-issued PUT URL/headers, and completed/verified before execution.
Without it the session remains metadata-only; no artwork is invented. API image
verification may reject malformed or animated files even when their type is valid.
With an image set, success additionally requires matching staged/published image
SHA-256/type/length, the same non-null public image URL in the publication and
indexed token DTO, and one bounded no-redirect GET of that URL returning **HTTP
200**, an image content-type family and nonempty bytes. Byte-identical output
must match the signed type/length/SHA-256. Different served bytes may be an API/CDN
transformation: `published-image.json` records the actual SHA-256/type/length and
that limited family/nonempty-body check, explicitly not byte identity. HTTP/type/
empty/oversized failures stop nonzero with evidence; no image retry or metadata-only
fallback occurs. The final canonical RPC barrier runs after this GET.


The target is **USD 5000**, not a fixed token/WETH ratio. Optional
`EXAMPLE_TARGET_MARKET_CAP_USD` accepts a positive exact USD decimal (up to 18
fractional digits). It does not grant signing permission or override the USD seed.
The runner makes one bounded, uncached GET to
`LAUNCH_API_URL/api/v1/token-prices?chainId=4663&limit=100`, without pagination,
redirects or retries. It selects the reviewed chain-4663 WETH address and requires
ready metadata, 18 decimals, `priced: true`, `source: "anchor"`, and direct
Chainlink-anchor provenance bound to WETH and the reviewed aggregator
`0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`. The exact positive uint256
`priceUsdX18` is an **indicative API-published launch seed**, not an executable
swap quote or on-chain execution authority. HTTP/body/validation failure or a missing
WETH row stops unsigned; there is no manual price or alternate-source fallback.
Each request has a 30-second timeout and a 1 MiB streamed response limit.
The review and console preserve API origin, index/graph blocks, upstream observation
timestamp and age, and local retrieval time. Retrieval does not make an old upstream
observation fresh. The API may continue publishing its price as upstream age grows;
the runner does not impose a 15-minute contract-round freshness gate.
USDG markets use the SDK-exported chain-4663 Global Dollar address, **6 decimals**
and the reviewed `usdPeg` source at exactly `1e18` USD-X18, matching the app. There
is no substituted WETH/USD value. Every market has its own quote precision, USD
seed, token/quote orientation and aligned valuation; multi-quote FDVs are not additive.


Before any attribution or transaction signature, the runner saves
`economic-review.json` and exact owner-only recovery and prints its financial summary.
The computed hash binds all quotes, target, actual supply, predicted per-market
token order, every allocation, fees, protected buys, Kyber conversion bytes/minima/
deadline, metadata/image and finalized plan. It is provenance evidence, never an
authorization input. Dry runs stop here without signing; broadcast runs save
`economic-admission.json` with `authorization: "--broadcast"` and that hash as
evidence of the chosen mode, not another gate.
Before every later signature the runner rereads the same configured API snapshot and
rechecks the immutable review, target, supply, finalized plan and predicted token
order. Any exact price, API origin, chain, WETH/decimals or direct-anchor identity,
kind or source change stops execution. Failed or unpriced reads also reject.
Index/graph blocks and observation/retrieval times may advance with the identical
price and source; they never replace the original review. Changed economics require
a new explicit review, never silent plan rewriting or submission replay. Actual
RPC chain, balances, nonce, prediction, deadline and native execution proof remain
execution authority; API block fields are observations, not RPC canonicality pins.
The original plan deadline must still be future at metadata signing/staging and
before each later signature, including **after asynchronous quote/authority reads**.
Expiry requires a new explicit review; the runner never extends the saved deadline.


Blank `RPC_URL` uses the SDK official Robinhood chain-4663 mainnet endpoint; HTTPS
providers and explicit owned loopback HTTP execution RPCs are supported.
The creator is derived locally from the configured signer; deployment/WETH addresses
come from `getAddresses(4663)`. The runner checks chain identity, EOA, deployed core
and registry, admitted profiles, funding escrow/core/native binding and each quote's
actual decimals. WETH keeps the registered P1 `(1,4096)` oracle. USDG discovers
`OracleConfigRegistered` history at a pinned block, rereads the factory mapping at
that same block, and selects a compatible registered config deterministically by
increasing max tick move, decreasing cardinality, then config ID. Factory configs
are generic, not a separate hardcoded USDG ID. No compatible config, unavailable
history, or a changed canonical pin fails loudly. V4 cases require config6/V2;
an old config5 profile is never selected instead.
V4 fixed cases encode max `10000`, min `1000` pips and sensitivity `7654321`
fee-pips × seconds/tick; all are immutable. The reviewed `FixedFeePoolHookV1` charges
the fixed maximum `10000` pips (1%) on applicable amounts. Minimum and sensitivity
are stored and exposed, not used for a dynamic fee calculation. The current defaults
resolve the matching October8 mined config6 graph. Position maxima exactly cover market budgets and budgets
exactly cover minted supply. Actual unused inventory burns before buys, never to the
creator. Verification accounts for burn `Transfer` logs, reduced `totalSupply`, an
empty core token balance, and creator balance equal only to paid opening-buy output.
Optional `NFT_BASE_URI` supplies your actually hosted ERC404 NFT metadata base URI.
Blank uses an empty base URI: NFT units/mirror behavior remain real, but the example
does not claim hosted NFT metadata exists.

The fixed Robinhood examples require native sequential Nitro `eth_simulateV1`, including
an isolated pinned ArbOS capability probe and exact fee-bearing replay. Generic
Anvil/Hardhat forks cannot certify Nitro compute/poster metering and are not a fallback.
Unsupported native simulation, insufficient funds or failed admission stop before API
staging/broadcast. Each immediate next envelope is additionally proved afresh against
the saved `reviewedTransaction` and preflighted read-only through the same execution
RPC before signing. Calldata, value, gas and gas price must remain exactly as reviewed.
There is no mode fallback, admission override, automatic submission replay or reduced case.

### Commands and launch matrix

Every command below defaults to a dry run. Append `--broadcast` to execute the
selected case; the table's atomic/staged mode is independent of the CLI dry-run/
broadcast choice.

```sh
node examples/launch-erc20-v4.ts
node examples/launch-erc20-abyss.ts
node examples/launch-erc404-v4.ts
node examples/launch-erc404-abyss.ts
node examples/launch-erc20-staking-v4.ts
node examples/launch-erc20-dividends-abyss.ts
node examples/launch-erc20-burn-mixed.ts
node examples/launch-erc404-dividends-mixed.ts
node examples/launch-erc20-multi-quote.ts
node examples/launch-erc20-depth-v4.ts
node examples/launch-erc20-dividends-multiquote-mixed.ts
```

| File suffix | Token / rewards | Markets and permanent positions | Mode / opening buys |
| --- | --- | --- | --- |
| `erc20-v4` | ERC20 / none | V4: 1 | atomic / 1 |
| `erc20-abyss` | ERC20 / none | Abyss: 1 | atomic / 1 |
| `erc404-v4` | ERC404 / none | V4: 1 | staged / 1 |
| `erc404-abyss` | ERC404 / none | Abyss: 1 | atomic / 1 |
| `erc20-staking-v4` | ERC20 / staking | V4: 2 | staged / 2 |
| `erc20-dividends-abyss` | ERC20 / dividends | Abyss: 3 | staged / 1 |
| `erc20-burn-mixed` | ERC20 / token-only burn 3000 bps | dual-fee V4: 2; Abyss: 1 | staged / 1 per market |
| `erc404-dividends-mixed` | ERC404 / dividends | V4: 2; Abyss: 3 | staged / 1 per market |
| `erc20-multi-quote` (new) | ERC20 / none | V4 WETH: 1; V4 USDG: 1; Abyss WETH: 1 | staged / 1 per market (3 total) |
| `erc20-depth-v4` (new) | ERC20 / none | V4 WETH: 4, Early Scarcity / progressive Depth | staged / 1 |
| `erc20-dividends-multiquote-mixed` (new) | ERC20 / dividends 4000 bps | V4 WETH: 2; V4 USDG: 2; Abyss WETH: 3 | staged / 1 per market (3 total) |

The three new cases are **additions**, not replacements yet: the eight existing
descriptors/topologies remain intact until the user validates new cases with real
runs. At most one V4 market per quote is permitted; Abyss may reuse a quote.

ERC20 supply is `1_000_000e18`; ERC404 supply is `10_000e18`, NFT unit `100e18`.
`deriveLaunchPoolRecipe` prices against **the entire actual minted supply**, even
in mixed-market cases. Per-market budgets divide that supply, with integer remainder
assigned to the last market. One position uses the recipe's full one-sided range
and budget-funded liquidity; multi-position markets use `deriveLaunchPositionRanges`
with the exact requested count, `positionGaps: "adjacent"` and an explicitly
extended final tail. Staircase remains the existing multi-position default; the
new four-position Depth case uses **Early Scarcity**, increasing inventory from
low-price scarcity to more inventory at higher prices. This is the requested Depth
shape in the current SDK vocabulary, not a literal reproduction of the separate
eight-position design catalogue. Spacing is 60 and LP fee is 3000 pips for both
venues. Predicted address order sets orientation independently per quote; multi-quote
markets aim at the same USD valuation, not the same raw sqrt price. Per-position
maxima exactly cover each budget, except documented integer mint-rounding dust.
Each buy defaults to `0.00001 ETH` through its quote's Kyber funding conversion.
The unified SDK invocation sets
every ordered buy's minimum from its actual stateful diagnostic output with **50 bps
(0.5%) slippage**, then proves and saves only the final protected commitment. The draft's
one-wei minima are diagnostic inputs, never the submitted protection.
Rewards use 4000 bps where selected; token-only burn is 3000 bps in the burn case.
V4 uses frozen registered
treasury/author terms with developer rate `0`; executor fee is 275 bps.
Hook salts/random identities are finalized and saved before execution. The shared
runner uses the combined preparation/admission result without an immediate second
planning pass. Staged cases simulate only staged work, never an unused atomic launch.

USD 5000 is a **target before tick alignment**, not a promise of exactly USD 5000
after alignment or buys. The economic review shows aligned unit price in USD/quote,
minted-supply valuation, expected rounding burn, retained supply and its aligned
opening valuation. It also decodes every ordered output/input from the final admitted
simulation receipt, showing all-in average execution price and the premium against
opening price. That premium includes fees and price impact; it is **not** the
post-buy marginal spot price. Opening buys move the pool, so the actual post-buy
valuation must use observed post-activation pool price and retained total supply.
The old 1:1/fixed-liquidity examples could burn almost the entire intended supply
and produce a radically different retained-supply valuation. They are not a pricing
recipe or a valid precedent for a new launch.

### Optional execution restrictions

There are no default chain/RPC/account gas or calldata caps. The SDK reads current
Nitro protocol compute ceilings and exact-calldata poster budgets itself. Default
headroom is **1500 bps (15%)**. Set explicit decimal restrictions only when you intend
to tighten the complete transaction envelope: `EXAMPLE_CHAIN_GAS_CAP`,
`EXAMPLE_RPC_GAS_CAP`, `EXAMPLE_ACCOUNT_GAS_CAP`, `EXAMPLE_MAX_CALLDATA_BYTES`.
`EXAMPLE_HEADROOM_BPS` preserves your explicit 0–10000 policy. These are local
restrictions, not invented provider/account assurances or admission bypasses.
Poster allocation is already inside Nitro gas/affordability and is not charged twice.

Robinhood's separate aggregate simulation gas-used budget defaults to **50M**.
`EXAMPLE_SIMULATION_GAS_CAP` overrides that budget (positive decimal gas) for
providers supporting more or less. It does not change per-transaction compute
capacity. Multi-step examples requiring full activation outputs for buy protection
and economic review need a provider/budget covering activation, or refuse before
signing; do not raise the setting beyond the provider's actual supported budget.

### Evidence and failure recovery

Each dry run or broadcast automatically creates `launch-results/<timestamp-case-random>/`;
`--resume` reuses the original directory rather than creating another launch. Inspect
`result.json`, `events.jsonl`, finalized `plan.json`, `planning.json`,
`economic-review.json` and `receipts.json`. A dry-run result has `runMode: "dry-run"`,
`scope: "planning"` and `execution: "dry-run"`, with no transactions or API writes.
Publication-only artifacts (`publication-progress.json`, `published-token.json` and,
when configured, `published-image.json`) are produced only during broadcast/resume.
Exact admitted wallet envelopes are signed locally only during execution; computed
hashes and unsigned envelopes are durably retained as `broadcast-attempt`
**before the one raw broadcast**. Real receipts are saved before
status/canonical-state assertions. No unlocked-account signing or sending is used.
Public evidence preserves structured field names but redacts sensitive values:
known keys, signatures, signed raw bytes, API capabilities, authorization values
and endpoint credentials. Public `plan.json` may therefore differ from the exact
commitment and is **not recovery authority**. Before the first attribution or chain
signature, `private-recovery.json` durably retains the complete unredacted finalized
`plan`, original `mode`, `confirmations` and `economicReview`. Broadcast additionally
saves `economicAdmission` with the computed review hash and `authorization: "--broadcast"`.
This owner-only file (mode `0600` inside the mode `0700` run directory) also retains
raw signed transactions and one-time API recovery material across session updates.
Original plan and economic review/admission provenance are immutable.
Never share or commit it.
`launch-results/` is ignored.

Every broadcast case requires actual API metadata staging (and verified image completion
when configured), publication using the activation hash, and an indexed DTO
matching token/creator/hash/metadata/image. Genuine pending-indexer HTTP `202`
responses are polled for up to 90 seconds respecting `Retry-After`. Before **each
publication attempt** and before final success, fresh RPC progress must be
confirmation-safe canonical Active with all retained receipts confirmed and the
original activation still in its saved block number/hash. Reorg, moved inclusion,
missing/unconfirmed receipt or changed phase stops, retains `publication-progress.json`
and private recovery evidence, and exits nonzero—even if the API reports success.
Other API failures are not retried or converted to partial success. The runner
never retries a raw send, relaunches, cancels or rolls back the source chain.
**Do not blindly rerun after an ambiguous broadcast**: inspect the durable hash first.
See [chain/API invariants](../docs/launch-lifecycle.md#individual-token-creation-examples).

Continue a begun launch with the same signer source and API endpoint:

```sh
node examples/launch-erc20-v4.ts --resume launch-results/<original-run-directory>
```

All eleven wrappers accept this option; the retained plan/review, not the wrapper's
case descriptor or new identity overrides, determines the resumed launch.
The runner loads owner-only `private-recovery.json`, restores the original mode,
confirmation policy, execution restrictions and typed receipts with observed block
number/hash, and re-admits `parseLaunchPlan(JSON.stringify(recovery.plan))` with
`planLaunch` against current canonical state. It does **not** call
`prepareAndPlanLifecycleLaunch`, remine salts, recalibrate buys, or repeat begin.
Canonical **Preparing/Ready** resumes only remaining `buildNextTransaction` steps
under the saved economic admission and signing gates; canonical **Active** recovers
the original activation receipt and runs chain verification/publication only,
including after the signing deadline. Unstarted/Cancelled state, changed inclusion,
replacement or unresolved signed hashes stop for read-only reconciliation.

Before publication the original API session is refreshed with `getUploadSession`;
the retained one-time capability is carried across every read/renew/complete response
because the API does not echo it. If an image is still awaiting upload, set
`EXAMPLE_IMAGE_PATH` to the original bytes: SHA-256, content type and length must
match the signed descriptor. An expired PUT URL is renewed once on HTTP 403/410/412
with `renewUploadUrl`, then the same bytes are uploaded and completed. A live ready
image is never reuploaded. No new attribution signature or session is created.
All existing chain/image/indexer checks and canonical activation barriers still apply.

After interruption, timeout, replacement or reorg, preserve the original identity,
`private-recovery.json` and every signed hash. Public `plan.json` and diagnostic
`planning.json` are not recovery authority; do not rerun a wrapper without `--resume`.
Supply receipt references including observed block number/hash;
when a replacement is known retain both `transactionHash` (original) and
`replacementHash` (effective). A same-nonce cancellation is not successful activation;
a missing receipt alone does not prove a reorg. No replacement is adopted or retried
automatically by these local-signing cases: a timed-out original hash requires manual
reconciliation. `launch.ts` provides unsigned reload/review for a privately extracted
exact plan: keep that file owner-only and supply the original `--mode`,
`--confirmations` and reconciled `--receipts`. Do not publish the extracted plan or
CLI output, which may contain sensitive committed values. Recovery of API publication
uses the original private session/capability and canonical activation hash, never
another launch.

### Owned-local wallet verification helpers

`launch-example-support.ts` exports
`createLocalLaunchWallet({privateKey,creator,chainId,orchestrator,client,redactor})`
and `submitSignedRecorded({transaction,wallet,client,wait,artifacts,signal})`.
`client.request({method,params})` is an explicit RPC adapter; `transaction` carries
`id`, `kind`, and exact unsigned `wire` chain/from/to/data/value/gas fields plus
optional nonce/fees/type/accessList. `wait(hash)` returns a real receipt.
The signer exposes `address`, `signTypedData(typedData)` and `signTransaction(wire)`
returning `{wire,rawTransaction,transactionHash}`. Retain the result privately.
Use `RunArtifacts(output,caseId,redactor)` with `Redactor` and a fresh directory for
durable evidence; call `initialize()` before work and `finish(status,error)` afterward.
The shared `runLaunchExample(caseObject, argv = process.argv.slice(2))` in
`launch-example.ts` takes the same fixed case objects as the eleven files, loads
environment and either auto-creates output for a new launch or resumes in place.
`RunArtifacts(output,caseId,redactor,{resume:true})` reopens private recovery and
retained transaction evidence without truncating the journal.
Offline diagnostics are in `test/launch-example.test.mjs`,
`test/launch-example-matrix.test.mjs` and `test/launch-example-resume.test.mjs`;
they do not claim real launch/indexer proof.

## Relationship to the application flows

The examples have been reviewed against `abyss-app`'s `scripts/launch-node.mjs`,
`launch-node-deploy.mjs`, `launch-browser-wallet.mjs`, `launch-staged-smoke.mjs`,
`launch-review-smoke.mjs`, and `src/lib/creation` / `src/lib/lifecycle` authoring,
funding, execution and recovery modules. These are behavioral references, not SDK
dependencies. The application consumes the published **`@black-market/sdk` 0.8.1** and
derives current deployment defaults through **`getAddresses`**, as do these examples.
The package pin alone is not live deployment authority. The mined graph
is recorded in the contracts repository at
`contracts/deployments/launch/pool-launch-v1/20261008T000141Z-e174ce6/manifest.json`;
examples resolve its SDK presets and certify live bindings, rather than copying
addresses from an application script.

| Flow | Shared contract / intentional difference |
| --- | --- |
| Eleven launch wrappers | Unified preparation/admission, explicit mode, exact allocations, immutable config6 fees, protected ordered buys, reviewed next envelopes and canonical Active/custody verification. Eight original descriptors remain; three new matrix additions await user live validation. |
| App Node launch/deploy | Both use valuation-driven recipes with actual supply, per-quote orientation/budgets and native ETH-to-quote Kyber funding. Examples retain an indicative validated API WETH USD seed and the reviewed USDG peg; they default to a dry run, while `--broadcast` supplies explicit authorization independently of mandatory RPC execution proof. |
| Browser wallet | Browser account/provider authority and explicit UI review are application-owned. The examples instead derive an EOA locally, hold one source/submission RPC, recheck chain before signing/sending, and preserve computed signed hashes before one raw send. A browser integration must bind the active account/provider/chain again after review and pass that provider's RPC adapter as `submissionClient`; read proof alone does not authorize wallet submission. |
| App creation funding | All fixed examples use integrated native-input `Swap` funding. Current registry target/spender/code hash, native/quote precision and decoded exact receiver/input/minimum/calldata are checked. No separate swap, native-wrap fallback or ERC20 approval is submitted on refusal. Other app payment paths are not this example runner's signing allowlist. |
| App metadata/image | Both sign chain/core/wallet-bound attribution. Optional `EXAMPLE_IMAGE_PATH` signs actual SHA-256/type/length, uses the exact issued `putImage` URL/headers and requires `completeUpload` verification before launch. Publication/indexed association and one bounded public image GET are also required before example success; transformed served bytes are recorded separately. Unset keeps metadata-only behavior. Signer may be a local key or authenticated V3 keystore; app legal/UI consent remains application-owned. |
| App publication/recovery | Pending HTTP 202 is not success. Examples honor `LaunchPublishPending`/`Retry-After` and require indexed provenance plus fresh confirmation-safe RPC Active and the original activation inclusion before every attempt/final pass. The app's polling UI/two-confirmation/replacement policy differs intentionally from these one-confirmation stop-and-reconcile examples. |
| App review/staged smoke | These app scripts exercise read-only browser review and large matrices, not permission to deploy. SDK `quickstart.ts` and `launch.ts` remain read-only on the source chain. SDK `launch-lifecycle-smoke.ts` is a different, explicitly authorized owned-loopback execution proof, including real ERC20 approval prerequisites when supplied by fixture plans. |
| Historical commitment generator | Retains original independent config4 bytes/hashes for codec regression evidence; no addresses or allocations in that vector should be used to construct the current graph. |

### Safe verification without a funded launch

After rebuilding the package, run the ordinary offline suite (including
`test/launch-example.test.mjs`) and typecheck. The example tests retain endpoint,
chain/account, exact-signing, redaction, pre-broadcast durability, pending-publication
and no-retry behavior, plus residual-burn/no-creator-reserve accounting; they do not
claim an actual chain launch or indexer proof.

For CLI proof, run `node examples/launch.ts` without required arguments (usage refusal,
no RPC/signing) and `node examples/generate-lifecycle-commitment-fixture.ts` without
output paths (offline historical vector to stdout). Read-only deployed discovery is
`node examples/quickstart.ts`. With a reviewed exact saved current plan, use
`launch.ts --plan ... --rpc ... --mode ...` and retained receipt-reference JSON;
`--mine` performs only local mining and read-only native simulation on the source.
Do **not** run any of the eight configured wallet/API wrappers to verify this review.
Real metadata-session integration needs an owned disposable HTTP service; full custody,
receipt and fee execution proof needs the separately authorized owned fixture below.


## Actual owned-fixture proof

The manifest must declare `fixtureOnly: true`, exact reviewed graph addresses, and
`executionLimits.provenance.scope: "controlled-local-measurement"`. The plan file
contains Solidity-exported `plans` with encoded-plan/hash/identity/token vectors.
Do not pass a mined mainnet manifest as a writable fixture.

```sh
pnpm build
LAUNCH_LIFECYCLE_RPC_URL=http://127.0.0.1:18555 \
LAUNCH_LIFECYCLE_FORK_RPC_URL=http://127.0.0.1:18556 \
LAUNCH_LIFECYCLE_ALLOW_LOCAL_EXECUTION=1 \
node examples/launch-lifecycle-smoke.ts manifest.json sdk-plans.json
```

This explicitly authorized command executes disposable fixture transactions and
restores snapshots per plan/mode. It exercises ordered buys, canonical Active state,
permanent custody, typed deployment provenance, V3 no-argument `claimAndSplit()`,
reserved owner/developer balances, and authenticated author claims. Cursor completion
and payment success stay separate.

For chain boundary regressions, also set `LAUNCH_LIFECYCLE_MANIFEST` and
`LAUNCH_LIFECYCLE_FIXTURES`, then run `node --test test/lifecycle-chain.test.mjs` with
the same local-execution environment. Ordinary `pnpm test` does not authorize chain writes.
