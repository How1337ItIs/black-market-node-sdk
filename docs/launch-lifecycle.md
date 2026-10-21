# Launch lifecycle API

`@black-market/sdk/lifecycle` is the browser-safe launch API; its exports are also available from `@black-market/sdk`. Supply the exact chain, core, creator and registry domain. Planning, salt preparation, reads and unsigned builders never sign, publish metadata or write to the source chain. A successful controlled-local simulation is not production deployment approval.

The canonical authorities are the registry/certification/adapter/config contracts under
`contracts/src/launch/lifecycle/v2`, typed hook deployers, and `contracts/src/launch/fees/v3`
in the protocol repository. Plan identity is `LaunchPlanV1`. Pool-bound V4 uses **config 6**,
canonical Abyss uses **config 1**, and generic current shared-V4 support uses **config 4**.

## 0.12.0 release: opt-in UFG treasuries

UFG is an additive **proxy launch route**, not a new token kind or a replacement
for the core path. Existing launch defaults, calldata, salts and HMM behavior are
unchanged when `ufg` is omitted. The pinned Robinhood deployment (chain **4663**) is:

| Export | Address |
| --- | --- |
| `UFG_LAUNCH_PROXY_ADDRESS` | `0xf6673d859DE03eB74A0b01696Edb97f941dFD0CA` |
| `UFG_TREASURY_FACTORY_ADDRESS` | `0x26Aa5D52134c8E6c4C01E9fb53A7568c0C64901F` |
| `UFG_UPSTREAM_FACTORY_ADDRESS` | `0xA170b5A58C111334A7237F2Ea2c428ec5022f68E` |
| `UFG_ORCHESTRATOR_ADDRESS` | `0x91560876033d568d25CDe98C78c33ff8FC43962c` |

`KnownLifecycleProfile.V4UfgFixedPool` (`v4-ufg-fixed-pool`) selects profile
`0x5c6045af480814e469f3dba7c120d264047c9320b869c63a064536041a2dbae6`;
`V4UfgDynamicPool` (`v4-ufg-dynamic-pool`) selects
`0x03de8d5e38f2957d80ecb9f2e59d555601ff091dfb17bce84178956a2e8d9b41`.
`isUfgProfile` recognizes only these IDs. Frozen envelopes, adapter/registration/
topology and bound-hook metadata come from committed registry readback at block
**94,551,140** (`test/fixtures/ufg-registry-readback.json`). Regenerate with
`node --experimental-transform-types scripts/generate-ufg-presets.mjs /path/to/black-market`;
add `--readback` only to recapture that exact block with read-only RPC.
The fixed and zero-royalty dynamic creation bytes exactly match the existing
`FixedFeePoolV1` / `DynamicFeePoolV1` artifacts, so no duplicate hook enum is needed.
UFG deployers, lockers, collectors and adapters are nevertheless different graphs.
Frozen presets are construction evidence, not live admission.

### Configuration and supported markets

`UfgLaunchConfig` is `{ treasuryShareBps, exitFeeBps, reserveAssets }`. The proxy
requires treasury share **10000**, integer exit fee **0..2000 bps**, and **1..7**
nonzero, unique, strictly ascending reserve addresses, excluding the predicted
launch token. Reserves and market quotes must form exactly the same set.

- ERC20 only, no staking/dividends, zero executor fee and at least one market.
  Neither inventory nor initial-buy recipients may be the proxy.
- Native Abyss uses the canonical adapter with config1 profile **2 (QUOTE)** or
  **3 (QUOTE_ORACLE)** and the matching canonical profile ID. Its canonical
  config has **no tail**.
- V4 uses config6 and one of the two UFG profiles, `feeMode: 1` (QuoteOnly) and
  `lpFeePips: 0`. Preset zero-royalty terms still apply. Supply/position budgets,
  price/ranges, oracle registration and ordinary lifecycle bounds are unchanged.
- Fee policies contain exactly the token plus reserves in ascending order:
  token `{ ownerBps: 0, rewardsBps: 0, burnBps: 10000 }`, reserves
  `{ ownerBps: 10000, rewardsBps: 0, burnBps: 0 }`.
  `buildUfgFeeAssetPolicies(predictedToken, reserveAssets)` builds that exact set;
  reserve ordering is validated, never silently repaired.

`encodeUfgLaunchConfig` encodes **one dynamic tuple**:
`abi.encode((uint16,uint16,address[]))`, including the leading `0x20` offset.
`decodeUfgLaunchConfig` checks canonical re-encoding; trailing bytes, alternate
offsets and dirty padding are rejected. `hashUfgLaunchConfig` is its keccak256.
Config6's typed `ufgLaunchConfig` automatically appends that encoding after the
canonical V6 prefix and decodes/splits it on read. Every UFG V4 tail must equal
the proxy config. The constructor economics hash remains **prefix-only with zero
hook salt**; the full plan hash binds the tail. No UFG tail is added to ordinary
V4, HMM or Abyss configs. Independent `cast abi-encode` fixtures are regenerated
with `node scripts/generate-ufg-fixtures.mjs`.

### Principal funding, planning and recovery

The economic plan's **creator is the proxy**. Its nonce is
`ufgLaunchNonce(principal, nonce96) = (uint160(principal) << 96) | nonce96`.
The `account` and every sender are the **same principal**, never the proxy.
The core still derives launch ID/token from the committed core/proxy/nonce.

```ts
const config = {
  treasuryShareBps: 10000, exitFeeBps: 100,
  reserveAssets: [getAddresses(4663).weth],
};
// economicPlan already contains your full token/funding/market/buy economics;
// every UFG V4 market was encoded with this same ufgLaunchConfig.
const plan = { ...economicPlan, creator: UFG_LAUNCH_PROXY_ADDRESS,
  nonce: ufgLaunchNonce(principal, 1n) };
const token = await client.readContract({ address: plan.orchestrator,
  abi: launchLifecycleAbi, functionName: "predictToken", args: [plan] });
plan.feeAssets = buildUfgFeeAssetPolicies(token, config.reserveAssets);
validateUfgLaunchPlan(plan, config, token); // pure/offline proxy rules
const planned = await prepareAndPlanLifecycleLaunch({
  client, account: principal, plan, mode: "staged", ufg: { config },
});
// No signing here. Obtain fresh admitted proxy envelopes before wallet execution:
const next = await buildNextTransaction({ client, planned });
```

The opt-in works on `planLaunch` too. `PlannedLaunch.ufg` retains config and its
hash; `simulateLaunchPlan`, `readLaunchProgress`, and `buildNextTransaction`
(including `action: "cancel"`) retain the route and reject config mutation,
wrong principal/nonce, wrong receipt target/config, or proxy binding mismatch.
Salt mining and optional buy-minimum calibration use the existing machinery.
Native Nitro metering/execution proofs remain mandatory on production chain4663.

The proxy pulls summed non-native inputs from the principal: ERC20 asset/amount
or swap inputAsset/inputAmount. **Approve the proxy, not the funding escrow**.
`buildUfgApprovals(plan)` builds exact summed approvals; planning observes current
allowances and includes zero-reset commands when needed. Native-wrap and native
swap inputs are `msg.value` on atomic/begin only. Refunds return to the principal.

Pure `buildUfgLaunchTransactions({ plan, config, mode, preparationBatches })`
produces proxy `launchAtomic(plan, config)`, or `beginLaunch(plan, Staged, config)`,
ordered `prepareMarkets` batches, then `activateLaunch`. The explicit batches
must cover all markets. `buildUfgCancelTransaction({ plan, preparedMarkets })`
targets the same proxy. These builders alone do not establish execution admission.
`validateUfgLaunchPlan` checks offline proxy rules; live registry continuity,
reserve/token code and supply bounds, transfers and treasury creation require RPC
simulation. The existing non-UFG core transaction builder is intentionally unchanged.

`readUfgTreasury(client, token)` reads the treasury factory's `treasuryOf(token)`
and returns the upstream address, or `undefined` for zero. Complete
`ufgLaunchProxyV1Abi`, `ufgTreasuryFactoryV1Abi`, `ufgBlackMarketFactoryAbi` and
`ufgBlackMarketTreasuryAbi` expose proxy config hashes and upstream treasury
collect/redeem/assets/backing/position/debt operations without inventing wrappers.
The pure example is `node examples/ufg-launch-config.ts` after building.

### UFG owned-fork check

This explicitly authorized local-only integration uses the unlocked Anvil default
account, no keys, and only public SDK launch APIs. In separate terminals:

```sh
anvil --fork-url https://rpc.mainnet.chain.robinhood.com/ \
  --chain-id 4663 --port 8561 \
  --gas-limit 100000000 --silent
pnpm build
UFG_FORK_RPC_URL=http://127.0.0.1:8561 node test/integration/ufg-launch.fork.mjs
```

It validates the tuple against the deployed factory, mines bound-hook salts,
executes Abyss QUOTE atomic, mixed Abyss QUOTE + UFG fixed staged (ERC20 funding/
proxy approval), and UFG dynamic atomic launches. It calls each exact proxy
command from the principal first, then checks Active, a nonzero `readUfgTreasury`
and `proxy.launchConfigHash == hashUfgLaunchConfig`. Snapshot restoration makes
the check repeatable. Stop Anvil afterward. Generic Anvil proves EVM contract
behavior here, **not ArbOS compute/poster admission**: construction/read/mining/
unsigned APIs plus actual fork `eth_call`/receipts are used, not a fake native
Nitro planner certificate. Ordinary `pnpm test` never runs this funded check.

## 0.11.0 release: gas sizing, packing and prefix proof

New atomic/activation envelopes containing HMM V2 markets add one forwarding target:
`R = 4_250_000 + 500_000 * (hmmMarkets - 1)` gas (zero for non-HMM plans).
For measured gross gas `G` (`maxUsedGas`, falling back to `gasUsed`), compute is
`min(max(G + R, ceil(G * (10000 + headroomBps) / 10000)), computeCap)`.
Begin/preparation/approval/cancel commands do not receive this reserve. Nitro poster
gas is budgeted separately inside the same complete gas envelope. Optional padding
and the reserve are targets, not refusal thresholds; exact validated replay proves
the clamped envelope. There is no bisection or extra ordinary-path request.

Staged planning greedily packs contiguous markets against the unpadded compute cap:
HMM V2 costs 14.5M per market; other profiles cost a conservative 16M. At 32M,
1/2/3/5 HMM markets produce `[1]`/`[2]`/`[2,1]`/`[2,2,1]`.
Only a packed measurement failure consuming at least 95% of its given gas splits
that batch in half, regardless of its error selector. Low-gas semantic failures
remain failures. `preparationBatchSize` is removed; inspect each preparation's
`marketStart`/`marketCount`. The pure unsigned compiler still accepts explicit
`preparationBatches`.

Robinhood chain 4663 defaults `limits.maxSimulationGas` to **50_000_000n** aggregate
gas **used**, not the sum of individual legal transaction envelopes. Override it
for a provider with a different budget. The SDK measures and validates the longest
estimated prefix that fits: begin 9.5M, preparations as above, activation 6M per
market plus `R`, and small approvals/cancellation. A measurement failure after
cumulative use reaches 95% of that cap defers the failed call and suffix.
If even the immediate estimate cannot fit that budget, refusal first identifies
any estimated per-transaction compute overflow (gas displayed in millions to one
decimal), rather than suggesting that a larger RPC budget solves it. Estimates
alone do not reject an envelope that can still be measured and exactly proved.

`simulation.admitted`, `executionProof: "proved"` and `protocolFit: "proved"` cover
only the successful proven prefix. **They do not promise eventual activation.**
`simulation.deferredTransactionIds` explicitly lists unproved remaining steps
(empty for full coverage); these commands carry no `gas`, `gasPrice`, `estimate`
or `admission`. Call `buildNextTransaction` before each signature: canonical
progress advances the proof window and gives the immediate next transaction exact
gas. Reviewed envelopes receive only a direct exact replay of that immediate step,
without new measurement, poster/price recommendations or suffix proof.

`buySlippageBps` requires actual activation outputs. If activation is deferred,
calibration refuses clearly; use a higher-budget native provider or preserve
already committed minima by omitting recalibration. Outputs are never fabricated.

## 0.9.1 release: Abyss 0.01% fee tier

`ABYSS_FEE_TIERS` now includes `{ feePips: 100, tickSpacing: 1, label: "0.01%" }`.
Pass `fee: 100` to `deriveLaunchPoolRecipe` to derive spacing-one geometry without
an explicit spacing override. Use `tickSpacing: 1` when passing that recipe to
`deriveLaunchPositionRanges`; the permanent boundary tail reaches tick `887272`
for launch token0 or `-887272` for launch token1. Abyss config1 lifecycle planning
derives this spacing from the canonical catalog automatically.

The Robinhood chain 4663 factory has enabled fee 100 with spacing 1. Other
deployments must enable the tier before execution; local recipe construction is
not evidence of live profile admission. Existing tiers and defaults are unchanged.

## 0.10.0 release: HMM V2 only

The admitted October17 **HMM Fixed V2** and **HMM Dynamic V2** replace the SDK's
earlier HMM offerings. Generic keys `KnownLifecycleProfile.V4HmmFixedPool`
(`v4-hmm-fixed-pool`) and `V4HmmDynamicPool` (`v4-hmm-dynamic-pool`) now select V2.
Versioned hook keys are `KnownLifecycleHook.HmmFixedPoolV2` / `HmmDynamicPoolV2`.
These are not aliases for the non-HMM fixed/dynamic hooks; those APIs are unchanged.

| Preset | Admitted V2 profile ID |
| --- | --- |
| HMM Fixed V2 (`hooks/hmm-fixed-v2`) | `0x45e957bcc7068350a65f5b4de5453b674d54d0f5eb2a88fc839da13197e80e98` |
| HMM Dynamic V2 (`hooks/hmm-dynamic-v2`) | `0x8e500f203ace505072e209c5f077e11de6d071ac7f298cd75c0e05c6a55c36e6` |

Frozen adapters, envelopes, complete dependency graphs, creation code and admission
fixtures preserve the V2 release and pinned registry readback at block 91,874,655.
Each graph has its own collector/deployer, locker and hook deployer. Presets are
construction data, not a current admission certificate: live
`readLifecycleProfiles` and execution proof remain authoritative.

Both require `lpFeePips: 0` and `developerFeeBps: 0`. Fixed charges `hookFeePips`
as its static fee; Dynamic uses config6 minimum/maximum/sensitivity policy.
Config6 requires a typed `hmmLaunchConfig`:

```ts
const hmmLaunchConfig = defaultHmmLaunchConfig({
  tokenBudget: marketTokenBudget, quoteAsset: "USDG", quoteDecimals: 6,
  // Illustrative caller choices, not SDK risk defaults:
  maxBidQuote: 100n * 10n ** 6n, // maximum 100 USDG of new/refreshed bid principal
  referenceDeviation: 0, // do not ask below or bid above the rounded reference
});
hmmLaunchConfig.strategyShareBps = 2500; // optional 25%; existing default is 50%
hmmLaunchConfig.strategy.premiumDecaySeconds = 259200; // optional 72h; default off
const config = encodePoolBoundV4LifecycleMarketConfig({
  ...reviewedV6Fields, lpFeePips: 0, developerFeeBps: 0, hmmLaunchConfig,
});
```

`HmmStrategyConfig` / `HmmLaunchConfig` are V2-only and mirror Solidity
`HMMStrategyConfigV2` / `HMMLaunchConfigV2`. `encodeHmmLaunchTail` produces exactly
`abi.encode(HMMLaunchConfigV2)`: **16 static words / 512 bytes**. The V6 codec
appends the tail only for current HMM profile IDs. Missing tails, old 448-byte
tails, extra words and noncanonical prefixes are rejected before RPC planning.
Mining and recovery preserve the typed tail. The full launch-plan hash binds
every tail byte, including both new guards.

The hook constructor is still **one 20-word / 640-byte
`PoolBoundHookParametersV2` tuple**. Do not append the HMM tail to creation code.
The collector factory hashes only the canonical config6 prefix with zero hook
salt for the hook's market-economics commitment; the auxiliary strategy settings
are handed to the manager through the collector. Changing those settings changes
the full plan commitment, but not the hook constructor's prefix-only commitment.

`validateHmmLaunchConfig` enforces the factory's exact launch guards and Solidity
field widths. Share is 0..10,000 bps. All 15 strategy fields are listed in wire order:

| Field | Unit and accepted launch values |
| --- | --- |
| `bidWidth` | Tick spacings; positive int24 |
| `askWidth` | Tick spacings; positive int24 |
| `gap` | Tick spacings; nonnegative int24 |
| `staleAfterSeconds` | Positive uint32 seconds |
| `staleDisplacement` | Tick spacings; positive int24 |
| `minQuoteDeploy` | Raw quote units; any uint256, including zero |
| `minQuoteHarvest` | Raw quote units; positive uint256 |
| `minTokenHarvest` | Raw launch-token units; positive, covered by both token caps |
| `resalePremiumBps` | 0..5,000 bps |
| `maxAsks` | 1..8 |
| `maxAskTokenExposure` | Raw launch-token units; at least ask count and minimum token harvest, at most uint128 max |
| `maxAcquiredInventory` | Raw launch-token units; at least minimum token harvest, at most uint128 max |
| `premiumDecaySeconds` | Any uint32 seconds; zero disables decay |
| `maxBidQuote` | Raw quote-principal ceiling for new/refreshed bids; positive and at most uint128 max |
| `referenceDeviation` | Tick spacings; nonnegative int24 |

For reference pool tick `R`, deviation `D` and spacing `S`, ask lower is at least
`R - D*S` and bid upper is at most `R + D*S`, with side-appropriate grid rounding.
The reference comes from the hook's truncated oracle, not an independent spot
price supplied by the caller.

The default helper **requires explicit `maxBidQuote` and `referenceDeviation`**;
neither has a guessed risk default. All other defaults are preserved: 50% share,
widths 5/5, gap 1, stale 86,400 seconds/displacement 5, premium 500 bps, 4 asks,
decay off. Token thresholds are raw market-budget ratios: harvest budget/100,000,
ask exposure budget/10, inventory budget. Too-small budgets producing zero harvest
and budgets above uint128 are rejected. WETH quote deploy/harvest thresholds remain
0.0005/0.005 ETH; USDG is 1/10 six-decimal units. Catalog symbols/addresses work;
explicit decimals must match. Other quotes require explicit `minQuoteDeploy` and
`minQuoteHarvest`; no unsupported asset's USD price or units are inferred.

### V2 fee funding and owner controls

V2 reserves the strategy share **on each swap in both pool currencies, after the
protocol treasury share**, rather than waiting for harvest. The remaining fees
follow the normal fee-hub distribution. HMM itself does not burn fees and never
touches the permanently locked launch positions.

The browser-safe lifecycle and root exports include complete
`hmmLiquidityManagerV2Abi`, `hmmFeeCollectorV2Abi`, `hmmFeeCollectorFactoryV2Abi`,
`hmmFixedHookV2Abi` and `hmmDynamicHookV2Abi`. Use ordinary viem contract calls;
the SDK adds no speculative transaction wrappers:

- Read `strategyOwner()` and `liquidityManager()` on the collector. Authority
  follows the **current** fee owner from the canonical hub/fee-owner registry.
- Call collector `setStrategyShareBps(uint16)` for 0..10,000 bps. It changes future
  swap reservations, not fees already reserved.
- Read manager `strategyConfig()` for the complete 15-field tuple, then call
  `setStrategyConfig(HMMStrategyConfigV2)` to update every setting immediately.
  This queues a book refresh for the next maintenance pass. Lowering intake caps
  does not forcibly liquidate existing inventory; existing lots keep their stored
  floor and age. New premium settings apply to newly acquired lots.
- Read `placementsPaused()` and call `setPlacementsPaused(bool)` on the manager.
  Pausing queues auxiliary-liquidity withdrawal on maintenance and stops new
  placements, not trading or fee collection. It does not withdraw locked launch LP.

These writes require the current fee-owner wallet and explicit transaction
authorization. Read-only planning never invokes them.

### Breaking migration from the earlier HMM SDK

Rebuild unstarted HMM plans with the new preset IDs/adapters/graphs, supply both
new guards, re-encode the 512-byte tail, and re-mine/re-prove the resulting plan.
Do not pad old 448-byte payloads, reuse an old graph/salt, or relabel old bytes.
The former `HmmFixedPoolV1` / `HmmDynamicPoolV1` enum members and old HMM metadata
have no compatibility aliases. Existing onchain HMM V1 profiles/markets were not
deregistered or upgraded by this SDK release; submitted legacy plans must not be
mutated into V2 plans. Use tooling matching their original contract release.

Independent Solidity ABI fixtures are regenerated with
`node scripts/generate-hmm-fixtures.mjs` (Foundry `cast abi-encode` / `calldata`).
To regenerate canonical V2 metadata/ABIs from preserved evidence without RPC or
onchain writes, use `node --experimental-transform-types
scripts/generate-hmm-presets.mjs release.json live.json`; both JSON files must be
the exact V2 release and matching successful admission/pinned-readback records.

## 0.8.1 release

Adds the Robinhood October11 Dynamic Fee Hook preset:
`KnownLifecycleHook.DynamicFeePoolV1` and `KnownLifecycleProfile.V4DynamicFeePool`
(`"v4-dynamic-fee-pool"`), profile
`0x27f219872fe934a5464bc9b900028256122f215b40cbdb69ef5f88cd5f627ccb`. The fixed
preset and example default are unchanged.

## 0.8.0 release

This release adds unstarted-launch topology validation, boundary tails enabled by
default, and the generalized `positionGaps` option replacing `staircaseBoundaries`.
The TypeScript examples default to an unsigned dry run; `--broadcast` explicitly
authorizes execution without an interactive hash prompt. `--resume` retains the
original plan, receipt evidence, and metadata session instead of relaunching.
The opt-in `LifecycleSessionCache` below reuses only the allowlisted static reads
at the same canonical chain/block; execution proof and financial state stay live.

## 0.7.1 transaction-first construction

Known chain/core/profile identities use frozen release construction metadata.
`getKnownLifecycleDeployment`, `getKnownLifecycleProfile` and
`listKnownLifecycleProfiles` are pure, browser-safe selectors. Profile selection
accepts either `KnownLifecycleProfile` keys or exact profile IDs.
`KnownLifecycleHook.FixedFeePoolV1` and `KnownLifecycleHook.DynamicFeePoolV1`
identify the fixed hook and **Dynamic Fee Hook** respectively; both use the V2 constructor.
Select the latter with `KnownLifecycleProfile.V4DynamicFeePool` (`"v4-dynamic-fee-pool"`).
Unknown identities return no preset; explicit `readLifecycleProfiles` and unlisted
profile construction retain live discovery/certification. Presets describe release
availability, never current admission, and contain no `admitted` claim.
The Robinhood presets retain the mined October8 fixed config6 graph and add the
October11 zero-author-royalty Dynamic Fee Hook, each with its own exact artifact,
review, terms, runtime pins, creation-code chunks and 20-word V2 constructor.
Historical config5 codecs and 18-word V1 ABIs remain explicit for
existing deployments, but October5 evidence is not relabeled or selected as the
current preset. Explicit live discovery certifies unlisted deployments from actual
pinned reads.

`prepareAndPlanLifecycleLaunch` compiles the exact requested mode before native
execution calibration. Known construction uses local commitments and hook
creation code, mines salts once and compares every final constructor binding.
Token prediction remains a genuine pinned factory read; advancing the block
during asynchronous mining can require a second prediction. Current progress,
receipts, nonce/confirmation gates, exact native proof and final canonical guards
remain authoritative. Public discovery/constructor boundaries observe the current
chain; policy callbacks are resolved freshly rather than cached as constant values.

Optional `buySlippageBps` (integer 0–9999) protects **every ordered buy** from its
actual diagnostic receipt output using `floor(output * (10000 - bps) / 10000)`.
The diagnostic candidate is never admitted or returned for execution. Only the
complete final protected commitment can pass measurement and validated replay.
Protection is available only for an unstarted launch; omission preserves minima.

`buildLaunchTransactions({ plan, mode, preparationBatches? })` is a pure unsigned
compiler. Staged preparation counts must cover all markets exactly. Every command
carries the full plan; `PlannedLaunch.totalCalldataBytes` sums exact remaining
command bytes, including approvals. Splitting preparation cannot reduce this
per-command calldata or partition mint/lock/all-buys/public-opening activation.

Atomic and staged are explicit choices. Only proven compute/gas-envelope capacity
can partition empty preparations. Semantic, opaque `DeploymentFailed`, source,
provider-clamp and byte-cap refusals do not authorize retries or partitioning.
Native explicit OOG recognizes simulator VM code `-32015` and compatible `-32000`,
not near-cap gas consumption. Both activation receipt and event counts must match
the committed positions. Failure DTOs expose safe classifications/numeric facts,
not raw provider messages. Abort closes continuations, including unsupported adapters.

`deriveLaunchPositionRanges` requires a source-defined Black Market
`distributionPreset`: `"early-scarcity"`, `"staircase"` or `"smooth-ramp"`.
Inventory weights, 64 active spacing steps and intentional gaps follow
`black-market/apps/web/src/lib/launch.ts`. Early Scarcity widens sparse bands;
Staircase inserts three-step gaps only between new inventory shelves; Smooth Ramp
keeps gently narrowing bands contiguous. The SDK defaults to five positions and
supports counts from 2 through 16. Arbitrary equal-tick fractions of the distance
to a protocol boundary are not these presets.
For Staircase and Early Scarcity, `positionGaps: "adjacent"` removes the empty
intervals while retaining the source inventory weights and finite-band widths.
The default `"source-gaps"` preserves their original topology. Smooth Ramp is
always contiguous: omit `positionGaps` or use `"adjacent"`; explicitly supplying
`"source-gaps"` is an error. Adjacent positions share an exact spacing-aligned tick;
overlap is also valid for continuous price coverage.
An empty gap can move the pool price without exchanging tokens in that interval.


**Breaking default:** `extendFinalRangeToBoundary` now defaults to `true`.
It replaces only the final band's far endpoint with the usable spacing-aligned
protocol boundary, preserving every earlier band and the final band's near endpoint.
Explicit `false` retains a finite final band, which does not satisfy default planner
admission unless another funded position supplies the permanent tail.
The complete finite preset must fit before this extension is applied.
`boundaryTick` and `boundarySqrtPriceX96` always describe that finite protocol
boundary; endpoint sqrt ratios are not exclusive swap-price guards.

Pass the raw token budget for **one pool**. Each position exposes `inventoryBps`
and its pre-mint `allocatedTokenAmount` cap: all but the last allocation floor
their basis-point share, and the last receives the exact remaining budget.
All caps and funded liquidities must be positive. `maxTokenAmount` equals the intended
`allocatedTokenAmount`, including any mint-rounding residual; `tokenAmountMaximum`
equals the pool budget. Both venues use the maximum exact budget-safe integer liquidity:
one additional liquidity unit would exceed that position's allocated cap.
`unspentTokenAmount` is the budget minus the canonical rounded-up expected mint
debit, not an extra allocation or creator reserve. Do not add it to `tokenAmountMaximum`.
Current admission requires position maxima to sum exactly to each market budget and
market budgets to sum exactly to minted supply. The SDK planner and pure compiler
enforce these equalities for every supported venue. The orchestrator burns every
actual leftover before any buy. Positive int128 liquidity and V4 signed settlement
limits remain enforced; arbitrary caller plans still need complete live admission.

The existing ordering convention is `launchedTokenIsQuote: true` for launched
token0. Gross liquidity must fit `maxLiquidityPerTick` at **each endpoint**;
adjacent bands share their endpoint's gross capacity, while the sum of disjoint
positions is not capped as if all began at launch. `openingActiveLiquidity`
reflects the actual `[tickLower, tickUpper)` opening state. Token0 starts in the
first band; token1 has zero opening-active liquidity until a downward quote buy
crosses the opening upper endpoint. `buySideLiquidity` is only the first
reachable band's liquidity, never the sum of all disjoint bands. Each position
also exposes exact endpoint sqrt ratios for display valuation.

### Launch position-topology safety

Every launch-created market must retain a **nonzero permanent tail** and continuous
buy-side coverage from its opening price to that tail. A tail in another pool,
including an optional Abyss allocation, cannot substitute for this market's tail.
The tail ends at the furthest usable spacing-aligned protocol tick: the maximum
tick when `launchedTokenIsQuote` is `true` (launch token0), otherwise the minimum.
V4 uses the config's `tickSpacing`; Abyss config1 uses its canonical fee-tier spacing
from `ABYSS_FEE_TIERS`, without changing the encoded config.

`assertLaunchTopologyCoverage` is a pure validator exported by both
`@black-market/sdk` and `@black-market/sdk/lifecycle`. It accepts
`{ positions, openingTick, tickSpacing, launchedTokenIsQuote, allowInteriorGaps? }`.
Positions carry `tickLower`, `tickUpper` and `maxTokenAmount` (or the Abyss config's
`tokenAmountMaximum`). Derive the opening tick with exported
`getTickAtSqrtRatio(marketSqrtPriceX96)`, not by rounding it to the spacing grid.
The validator never changes the positions:

- `TOPOLOGY_OPENING_GAP`: no band contains the opening tick on the buy side.
  Token0 containment is `[lower, upper)`; token1 is `(lower, upper]`, including
  the opening upper endpoint crossed by the first downward buy.
- `TOPOLOGY_INTERIOR_GAP`: the sorted interval union leaves an uncovered interval
  between opening and the permanent tail. Exact adjacency and overlapping
  Orbit-style horizons both pass.
- `MISSING_PERMANENT_TAIL`: no boundary-reaching band has a positive token cap.
  A finite final band or zero-allocation tail is not permanent liquidity.
- `TOPOLOGY_OFF_GRID_TICK`: a band endpoint is not aligned to this market's spacing.

The pure validator's `allowInteriorGaps: true` waives **only** interior gaps.
`planLaunch` and `prepareAndPlanLifecycleLaunch` enforce the same checks for every
market of an **unstarted launch**, using the pinned predicted token's ordering
against that market's quote. Progress is read first: waiting/in-flight account or
receipt state returns waiting without applying this creation policy. Started
`Preparing`/`Ready` and terminal `Active`/`Cancelled` plans skip the topology gate.
Their onchain commitments are immutable, so recovery must not retroactively
refuse them for historical topology. Budget/supply, identity, confirmation,
receipt and stateful execution checks still apply.

| Local planning option | Effect |
| --- | --- |
| `allowTopologyGaps: true` | Allows interior gaps only; the funded permanent tail stays mandatory. |
| `allowMissingPermanentTail: true` | Waives only the boundary-reaching, positive-allocation tail requirement. |

Both options default to `false`. Even together they **never** waive opening
containment or tick alignment. Staircase and Early Scarcity source gaps therefore
require an explicit gap opt-out; choose `positionGaps: "adjacent"` for continuous
admitted launches instead. These are validation choices, not an execution-proof
bypass. They are retained on `PlannedLaunch` for fresh `simulateLaunchPlan` and
`buildNextTransaction` admission while the launch remains unstarted. Started and
terminal recovery does not require either opt-out. Persist explicit choices
separately when restoring an unstarted saved plan. Budget/supply equalities, ABI
encoding, hashes, calldata and stateful proof requirements are unchanged.

No cross-review execution cache, caller certificate or execution-proof skip exists.
Recovery and `buildNextTransaction` acquire fresh authority and retain separate
immediate-submission-provider preflight. Construction/proof is not submission.

## Reviewed next envelopes

`BuildNextTransactionOptions.reviewedTransaction` optionally supplies an untrusted
previously reviewed immediate transaction. Omit it to construct a new envelope
with the existing greater-of-recommendation-and-twice-pinned-base fee strategy.
Supply it after review to validate that exact envelope, not to import cached
admission or waive current-state proof.

The SDK reconstructs the current unfinished commands from fresh canonical
progress, funding/allowances and deployment/profile authority. It matches
`id/kind/chainId/from/to/data/value` before using the reviewed gas or price.
Preparation batching remains SDK-derived, not caller-selected. Malformed,
wrong-step or changed envelopes refuse without returning executable calldata.

The SDK directly validates only the immediate transaction at its exact held
gas/price. It does not repeat measurement, quote a new gas price/poster budget or
simulate future steps. Current protocol/transaction limits, native metering,
postconditions and immediate actual-balance affordability still apply. Existing
padding may be consumed; neither a new padding target nor a higher advisory quote
alone invalidates a held envelope. Natural child base fees and payer balances are
never overridden, and failed replay never raises held gas or switches backend.

Approvals/resets, atomic launches, every staged next step and cancellation use
this same contract. Cancellation retains its adapter-independent recovery policy.
Fresh receipt/nonce/confirmation and final canonical checks remain mandatory.
When supplied, `submissionClient` must estimate the exact held gas/price at
`latest`; it still proves only immediate transport acceptance, not wallet identity.
Returned estimates/admission are fresh and do not trust fields supplied with the
reviewed transaction. Generic EVM external data-fee callbacks now receive the
exact simulated `gas` and `gasPrice`.



## Opt-in static session fast path

`createLifecycleSessionCache()` creates a caller-owned `LifecycleSessionCache`.
Pass it as `LifecycleRpcClient.sessionCache` to retain the SDK's **explicit static
read class** across `prepareAndPlanLifecycleLaunch`, `planLaunch`,
`simulateLaunchPlan` and `buildNextTransaction`. Omit the option to preserve the
default: only existing invocation-local fixed-state reuse, with no session events
or cross-invocation observations. The SDK neither creates a global cache nor
changes transport batching, selected mode or execution admission.

```ts
import { createLifecycleSessionCache, planLaunch } from "@black-market/sdk/lifecycle";

const sessionCache = createLifecycleSessionCache();
const client = {
  ...publicClient,
  sessionCache,
  supportsReadBatching: true, // Only when this transport actually batches.
  onDiagnostic: (event) => { console.debug("[launch-sdk]", event); },
};

const first = await planLaunch({ client, plan, account, mode: "staged" });
const second = await planLaunch({ client, plan, account, mode: "staged" });
// At the same canonical head, the second call reuses matching static reads only.
// Execution simulation, funding and canonical checks still run independently.

sessionCache.block; // readonly { number: bigint, hash } or undefined
sessionCache.invalidate(); // Wallet/chain switch, or each confirmed transaction.
```

The retained class is deliberately narrow:

| Static observations eligible for session reuse | Scope |
| --- | --- |
| Nitro capability getters and compute ceilings | Pinned `ArbSys.arbOSVersion`, `ArbGasInfo.getMaxTxGasLimit` / `getMaxBlockGasLimit` |
| Nitro poster quotes | Pinned NodeInterface `gasEstimateL1Component`, including the exact payer, destination, calldata and value |
| Frozen-profile registry certification | Profile/adapter registration (including dependency digest), topology, reviewed envelope, developer terms/cap and exact `requireEligible` request |
| Reviewed immutable certification graph | Adapter metadata/dependency getters, graph runtime-code checks, locker/collector authorities and shared-hook constructor/runtime provenance |
| Oracle configuration and factory presence | Pinned `oracleConfigs(configId)`, certified oracle-factory code and token-factory code-presence checks |
| Hook deployer creation/constructor/runtime evidence | Creation-code hash, both chunk addresses/bytes, exact constructor metadata, initcode/CREATE2 comparisons and deployer-recorded runtime digests |

Known construction presets continue to avoid discovery/getter mirrors they already
omit; enabling a cache does not introduce extra certification reads. Unlisted
profiles still use their normal frozen-envelope certification. Session hits retain
private wire hex, not mutable public profile/deployment DTOs. Each consumer still
decodes and checks its exact registration, graph, constructor and market bindings.

**Never retained across invocations:** native/ERC20 balances, allowances,
progress/market and core domain/prediction/binding reads, receipts/transactions,
chain identity, head/latest/pending observations, account code/nonces,
`eth_estimateGas`, `eth_simulateV1`, gas-price recommendations, funding-target
admission, non-view calls, submission preflight and all write-adjacent calls.
In particular the **native Nitro metering simulation probe is not cached**:
its `eth_simulateV1` request remains separate from the static ArbSys/ArbGasInfo
getters, and permissive measurement plus exact validated replay stay live.
Existing invocation-local reuse for eligible fixed reads is unchanged.

Each entry group owns one pinned block **number and hash**. Before session
observations can be consumed, the invocation must read a fresh canonical head and
chain identity. A changed head hash (including a same-height reorg), number or
chain identity clears the old group before use. Exact
wire parameters also participate in identity; changed caller, target, calldata,
value, gas or constructor economics cannot hit another request's entry.
Externally supplied pins without a fresh invocation-owned head bypass the session.
Only successfully settled wire reads are shared; rejected requests, in-flight
promises and obsolete completions after closure/invalidation are not retained.
Final canonical/reorg and chain checks remain live and clear the session on
identity failure.

The caller-owned session is the cross-invocation identity boundary, not the
reader object or `request` function. Recreated per-operation readers may share
it while keeping their own transport cancellation signal. They still acquire
fresh head/chain observations and run their own live requests; in-flight work
and cancellation state are never shared. Do not route concurrent operation
signals through one mutable global reader.

The caller **must call `invalidate()` on wallet/chain switches and after every
confirmed transaction**. It discards the pin and all memoized values immediately,
including preventing older pending reads from repopulating the discarded group.
It does not cancel an operation, freeze the chain or grant permission to submit
a saved transaction. A new block causes fresh static reads; the cache is a
same-snapshot acceleration, not a TTL or an assumption that facts never change.

With `onDiagnostic`, each opted-in invocation emits a `session-cache` start and
success/failure summary. `hits` counts static reads resolved from the session,
`misses` counts new static reads, and `reuses` counts existing invocation-local
static reuse. Summaries contain counts only: no cache keys, pins, RPC URLs,
parameters, addresses, calldata, results or errors. Nested continuations share one
summary, and listener failures remain isolated from financial behavior.

Correctness follows from deterministic static observations at the **same exact
canonical snapshot**, complete request identity and preserved live proof. The
session never stores an admission certificate or replaces balances, receipt/nonce
continuity, native capability simulation, execution replay or submission checks.
Offline RPC-count regressions compare two sequential complete `planLaunch`
operations with and without the option; they prove fewer repeated static reads,
not a live end-to-end latency guarantee.

Deterministic offline measurements (RPC messages, not HTTP batches):

| Fixture, two sequential `planLaunch` calls at the same pin | Cache off: first / second | Cache on: first / second |
| --- | --- | --- |
| Admitted Nitro/Abyss staged plan, serial or batching transport | 33 / 33 | 33 / 22 |
| Two-bound-market, two-creation-chunk V4 certification/constructor fixture | 64 / 64 | 64 / 19 |

The first fixture performs the native Nitro probe, measurement and validated
replay on **both** calls (three `eth_simulateV1` requests per call). The bound
fixture deliberately refuses a smart account after completing read-only metadata;
its savings prove static-read reuse, not economic execution. Both compare the
complete returned plans for equality. Reproduce after `pnpm build` with
`node --test test/lifecycle-read-pipeline.test.mjs test/lifecycle-execution.test.mjs`;
the tests print the per-call counts and assert unchanged counts with the cache off.

## 0.6.3 certification and dependency-round reductions

The public API, deployment authority and protocol admission rules are unchanged. With an
actually batching source, selected-profile certification no longer waits for registry
authority before reading the selected registrations, or for adapter registration before
reading topology and applicable V4 envelope/terms. Eligibility overlaps graph certification.
Private profile certification uses the registry's pinned `requireEligible` result and
requires its returned implementation to match the registration. This covers discovery
and standalone bound-hook metadata. Three duplicate implementation RPCs (`eth_getCode`,
`core`, `dependencyDigest`) were removed: the registry already checks enabled records,
exact profile/version/capability agreement, live runtime hash, core and live digest.
The existing local V4 graph-digest comparison uses `registration.dependencyDigest`,
whose equality to the live implementation digest is established by that same call.

Abyss certification no longer re-reads `factory`, `CONFIG_SCHEMA`, `CONFIG_VERSION` or
factory code. The registry certifies those fixed bindings before storing a profile;
current eligibility pins the approved runtime and rechecks its live graph digest.
SDK-side schema/version/topology and canonical chain/factory/variant checks still use
the returned registration, including factory/venue agreement and no hook. A changed
runtime or factory graph must fail authoritative eligibility, not an optional duplicate
getter. Market resolution and both exact planning/simulation passes remain required.

Source reasons in the reviewed protocol repository:

- `contracts/src/launch/lifecycle/v2/LaunchImplementationRegistryV2.sol:285-296`
  implements current eligibility; `:88-97` certifies Abyss before storing it and
  `:153-174` prevents profile rebinding.
- `contracts/src/launch/lifecycle/v2/LaunchCertificationV2.sol:79-102` certifies
  Abyss schema/version/capabilities, factory/code/canonical identity and graph digest.
- `contracts/src/launch/lifecycle/v1/AbyssMarketAdapterV1.sol:75-76,150-167`
  makes the core/factory immutable and binds the live graph code/initcode hashes.

V4 metadata, reviewed dependency code/getters, creation chunks and shared-root
provenance remain independent pinned reads. Chunk addresses come from the frozen
envelope only for scheduling; live deployer getters must still match them, including
STOP prefixes, size/hash bounds, constructor creation hash, graph digest, runtime
provenance and callback permissions.

Planning reads swap-input admission and existing escrow balances alongside profile
certification. A market's resolution uses its certified implementation while exact
capability eligibility, selected-oracle validation and any bound-hook evidence settle.
Their results must all agree before the resolved identity can authorize simulation.

For batching-capable Nitro sources, the isolated ArbOS probe, NodeInterface poster
quote and permissive exact-calldata measurement overlap. Probe isolation and its balance
override do not enter the real execution sequence. Exact-gas validated replay waits for
matching native metering, the poster budget and successful measurement. The redundant
probe-only chain/hash recheck was removed: successful admission and simulation refusal
still perform the enclosing live chain/canonical-block assertion. Natural child-block
fees, uint64 gas bounds, real payer affordability, EIP-150 envelope discovery and
postconditions are unchanged. Non-batching sources retain sequential measurement.

No process-wide or cross-review cache, new read authority, public scope API, admission
skip or write was introduced. Both opening-buy planning passes still choose fresh heads,
retain live chain/pending/receipt observations and execute their own native proofs and
validated replay. Only identical, complete pinned wire reads inside one invocation reuse
observations.

Offline regressions cover concurrent retained dependency responses, changed runtime,
authority, graph digest and capability refusal through contract-modeled eligibility,
canonical registry identity mismatch, build-next refusal after graph drift, V4
expected-address evidence with mismatched live getters, overlapped measurement without
premature replay, failed native evidence, serial/batched plan and fee equality, and
retained final canonical checks. Obsolete duplicate-getter tests were removed.
The released 0.6.3 SDK passed 133 offline tests with one opt-in real-AMM skip.
Actual consumer-route timings are recorded by the integrating app, not a
universal network-latency guarantee.

## 0.6.2 opt-in internal timing

Initialize a lifecycle read client with optional `onDiagnostic(event)` to observe internal
planning, profile certification, simulation context, Nitro probe, poster estimate, measurement,
exact replay and envelope-discovery stages. Each stage reports start and completion/failure.
RPC events distinguish queue admission, actual request start, settlement and invocation-local
read reuse; `queueMs` is separate from request `durationMs`. `requestId` is a local numeric
sequence, not a network or wallet identifier. Associate each client with your own local operation
label when several reviews run concurrently.

```ts
const client = {
  supportsReadBatching: true, // Only with an actually batching transport.
  request: (args) => publicClient.request(args),
  onDiagnostic: (event) => { console.debug("[launch-sdk]", event); },
};
```

The SDK never enables console output or telemetry itself. Without a listener there are no
diagnostic clocks or event allocations. Events omit RPC URLs, parameters/results, accounts,
addresses, signatures, calldata and raw errors; RPC method names are allowlisted. Synchronous
listener throws and asynchronous listener rejections are isolated from financial behavior.
Successful timing settlement means the function returned, not that the returned plan/profile
was admitted: inspect its normal typed admission result.

Independent domain/progress reads now overlap after token prediction. Simulation context
reads, Nitro/poster work and final chain/canonical observations also overlap where their inputs
are independent, still within the existing transport-opted-in read bound. Serial transports,
exact state/identity guards and both measurement and validated execution are retained.
No total-launch latency claim is made from these scheduling changes.

Verification: typecheck and the built offline suite passed **126 tests: 125 passing and one
opt-in real-AMM skip**. Diagnostics regressions cover timing events, payload omission and
throwing/rejecting observers without changing valid profile admission.

## 0.6.1 read-pipeline changes

Existing standalone calls, deployment targets, economic commitments and admission
requirements remain compatible. Invalid plan shapes are still refused before RPC work.
The optional `LifecycleRpcClient.supportsReadBatching` transport hint enables independent
getter dependency rounds with at most eight SDK-issued requests outstanding per invocation.
Set it to `true` only when the supplied transport batches concurrent requests; the SDK
does not select or configure a transport. Other clients retain serial requests, avoiding
the measured concurrent-unbatched RPC regression. With batching enabled, initial head
and chain reads overlap. Failed reads release their slots without rejecting unrelated
queued callers or automatically retrying.

A vanilla one-pool, one-quote, one-range plan selects only its committed profile IDs.
Abyss-only profile selection no longer requests the V4-only
`protocolMaximumDeveloperFeeBps` getter. A required V4 fee-limit read still fails the
operation if unavailable. V4 oracle/deployer/terms work, extra token/position capabilities
and swap-funding checks remain conditional on the actual committed plan. There is no
weakened single-pool mode: adapter eligibility, live code hashes, authority/dependency
bindings, schema/topology and applicable frozen terms remain mandatory.

Without the optional static session fast path above, identical fixed-state reads share observations only within one planning invocation.
Identity includes the original source client, pinned block number/hash and complete
request parameters, including caller, target, calldata, value and gas context. Rejected
reads are not retained. State changes, another caller/source/block or a subsequent public
planning invocation cannot reuse those observations; mutated plans and obsolete
completions are refused. There is no global cache or new public read-scope option.

Chain checks, latest/head/pending observations, receipt reads and canonical block rechecks
remain live. Wallet/provider preflight, non-view execution calls and stateful/fork RPC
are not cached. Nitro metering probes, discovery and exact validated replay remain
separate proofs. A protected opening-buy minimum changes the committed calldata and
still requires a second full plan and stateful simulation against a fresh latest snapshot.

Raw `request({method,params})` clients remain valid. JSON-RPC HTTP batching is optional
and transport-owned; concurrent reads allow a configured batch scheduler to combine
independent messages without changing `msg.sender` or the pinned state. No API planner
service, transport fallback, signature or broadcast is introduced. The existing Node 20
minimum and ES2022 target are unchanged; shipped scheduling does not require
`Promise.withResolvers`.

Verification on 2026-10-06: `pnpm typecheck` and `pnpm test` passed, including the build,
with **123 tests: 122 passing, one opt-in real-AMM test skipped and zero failures**.
Offline regressions exercise the vanilla
Abyss path without V4 fee metadata, mandatory V4 read failures, bounded overlap and
duplicate reads, exact combined funding, changed code/authority/terms, partial failures,
chain drift/reorgs, source/caller/call-context separation, failed-slot release and
obsolete results. These offline checks are not real-wallet or on-chain execution evidence.

A live read-only comparison against installed 0.6.0 measured **one selected canonical
Abyss profile certification only**, not whole planning, simulation or launch execution.
Both versions used Node 24.11.1, viem 2.56.3 and identical pinned chain 4663 state at
block 81455627, hash
`0x66f20d4c04b1c2357e9cd711c984a83fc8913ab208449ff1a0c8289bf2854036`.
Five runs per version and transport alternated version order; returned profiles were
deep-equal, and the chain and canonical block were independently rechecked.

| Transport | Version | Median / p95 (ms) | RPC messages | HTTP envelopes | Peak outstanding |
| --- | --- | --- | --- | --- | --- |
| Unbatched, default serial | 0.6.0 | 1496.10 / 1677.93 | 15 | 15 | 1 |
| Unbatched, default serial | 0.6.1 | 1402.10 / 1414.52 | 14 | 14 | 1 |
| Batched, explicit opt-in | 0.6.0 | 1503.38 / 1541.41 | 15 | 15 | 1 |
| Batched, explicit opt-in | 0.6.1 | 1005.11 / 1219.87 | 14 | 10 | 3 |

These scoped measurements do not establish end-to-end launch latency or a general
provider guarantee. An earlier unbatched concurrency trial regressed from a 1150.64 ms
baseline median to 3870.97 ms; explicit transport opt-in and default serial scheduling
remove that scheduling choice for existing clients. For reproduction, keep the selected
profile, pinned state, source, retry/batching settings and runtime equal; count RPC
messages separately from HTTP envelopes and retain failures as failures. Do not log RPC
URLs, accounts, calldata or provider messages, or substitute full-registry/complex-only
timing for the selected-profile path.

## 0.6.0 admission changes

Optional caller policy no longer substitutes for, or gates, actual sequential execution proof.
Results distinguish `executionProof`, `protocolFit`, and `transportPreflight`. Robinhood
admission reads pinned Nitro compute limits and poster budgets, then requires native exact
validated replay. `buildNextTransaction` optionally preflights the immediate next envelope
through `submissionClient`. Deployment addresses, lifecycle plan/schema domains, profile
capabilities and explicit atomic/staged behavior are unchanged.


## Deployed infrastructure

Robinhood mainnet (`4663`) selects the mined `pool-launch-v1` deployment captured at block
`82880546` in `contracts/deployments/launch/pool-launch-v1/20261008T000141Z-e174ce6/manifest.json`.
The October8 manifest records 22 successful receipts and canonical runtime evidence,
with two adapters and five profiles at that deployment. The subsequent October11
Dynamic Fee Hook admission adds a third adapter and sixth profile to the same
core/registry: four canonical Abyss variants and fixed/dynamic pool-bound config6/V2.
Neither offering deploys a shared V4 root. The fixed preset and example selection
remain `0xf18140c2fb66a4202a0f22d62d6288bf7976db108de5381e5497aaed332a06f8`,
with creation hash `0x11c4c7b1f265ed708b7d53ab828c89d237ca821333daa808f1913986c6f8f1ab`.
The Dynamic Fee Hook profile is
`0x27f219872fe934a5464bc9b900028256122f215b40cbdb69ef5f88cd5f627ccb`,
with creation hash `0xd448a4117b78714cc4f96824356c6a90ec666449fde5c57e2b7bbe072f5e4a7a`.
Its exact graph and terms are prepared in
`contracts/deployments/launch/pool-hook-template-v1/20261011T033141Z-dynamic-fee-zero-royalty/admission.json`;
that file is **unsigned preparation, not a mined receipt**. Registration is evidenced
by the successful `forge-broadcast/AdmitPoolHookTemplateV1.s.sol/4663/admit-latest.json`
receipt for `0x1928b13d1a6bf8826d08493a18c483fc7d244a3ec4100a7f8118f510a5db640c`.
Creation bytes concatenate the preserved storage-child runtimes after stripping each
first STOP byte, exactly as `PoolHookDeployerV1._initCode` does; constructor arguments
are appended separately. An unpatched artifact runtime is not a deployed hook-instance runtime.
October5 config5/V1 evidence remains historical, never a substitute for this graph.

| SDK field | Mainnet address |
| --- | --- |
| `launchOrchestrator` | `0x91560876033d568d25CDe98C78c33ff8FC43962c` |
| `launchImplementationRegistry` | `0xB2B0f9F36617810D67b8fC175153Aa10024C1358` |
| `launchFeeOwnerRegistry` | `0x64b5ca1f21B8E84305b0e4D847924dca39Eb1fcb` |

`getAddresses(4663)` exposes this graph; `robinhoodLaunchApplication` exposes the mined
launch constants. Launch addresses on `31337` and `46631` remain zero unless configured.
Address overrides are evaluated once on import: bare names win, then `VITE_`, then
`NEXT_PUBLIC_`. Configure `LAUNCH_ORCHESTRATOR`, `LAUNCH_IMPLEMENTATION_REGISTRY`, and
`LAUNCH_FEE_OWNER_REGISTRY` from the same deployment evidence.

Canonical Abyss defaults are retained. DEX overrides apply on `31337` and `46631`, not
mainnet. Lending mainnet defaults use `contracts/deployments/robinhood/replacement-infrastructure.json`;
the workbench's existing lending endpoints follow that replacement. Lending overrides apply
on `31337` (all three prefixes) and `46631` (`VITE_`/`NEXT_PUBLIC_`); liquidation-executor
overrides use all three prefixes on every chain. Workbench chain RPC configuration reads
`VITE_RPC_URL`, then `NEXT_PUBLIC_RPC_URL`, then `RPC_URL`; client factories prefer their explicit
`rpcUrl`, then `RPC_URL`, then the chain endpoint. Select the chain explicitly in applications.

Registry V2 has one `LaunchCertificationV2` child. V4 uses `profileEnvelope`, `profileId`, and
signed six-argument `registerProfile`. Admin-only `registerAbyssProfile(uint8,registration)`
independently certifies config-1 variants without an author envelope or royalty allocation.
The admission EIP-712 domain is `Black Market Launch Registry`, version `2`.

`LaunchBoundsV2` has five members: minimum/maximum tick spacing, maximum positions,
maximum oracle cardinality, and fee-mode flags. LP and SharedV4 hook fees remain below
1,000,000 pips. Pool-bound minimum/maximum hook fees satisfy
`0 <= minimumHookFeePips <= hookFeePips <= 1,000,000`; sensitivity is an explicit uint32.
Creators also select a registered oracle configuration and per-pool external-liquidity policy.
Author royalty ceilings are separate. Robinhood P1 `(1,4096)`, P2 `(6,4096)`, and P3 `(17,4096)`
can use the same admitted profile; the selected oracle is checked at the pinned block.
With `externalLiquidityDisabled=false`, third-party LP add/remove is allowed after opening.
Permanent launch custody and pre-opening protection still apply.

Config5 exports `fixedFeePoolHookV1Abi`, `poolHookDeployerV1Abi` and
`poolFeeCollectorFactoryV1Abi` for the actual V1 wire contracts. Config6 exports
`fixedFeePoolHookConfigV6Abi`, `poolHookDeployerConfigV6Abi` and
`poolFeeCollectorFactoryConfigV6Abi`, including its 20-word constructor and
`minimumHookFeePips()` / `feeSensitivityPipsSecondsPerTick()` getters. Existing
config5 hooks are not queried for nonexistent V2 fee getters. Constructor encoding
and initcode hashing require explicit `configVersion`; schema constants are
`V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V5` and `_V6`, never an ambiguous alias.
Generic shared contracts are `FixedFeeSharedHookV1`, `SharedHookDeployerV1`, and
`SharedMarketAdapterV1`; they require their own admitted deployment graph.
Other current ABI exports include `sharedMarketAdapterV1Abi`, `sharedHookDeployerV1Abi`,
`poolMarketAdapterV1Abi`, `poolHookDeployerV1Abi`, and `poolFeeCollectorFactoryV1Abi`.
Validation uses `validateV4LifecycleMarket`; the collector factory getter is
`dependencyDigest(address)`. Identity domains are `black-market.launch-profile.v2`,
`black-market.v4-dependencies.v2`, and `black-market.pool-bound-market-economics.v1`.

## Public operations

| Operation | Contract |
| --- | --- |
| `readLifecycleProfiles({client, orchestrator, profileIds?, offset?, limit?})` | Bounded registry discovery, schema/topology dispatch, reviewed graph/terms certification and current registry admission. Default offset/limit is 0/100; explicit IDs can select a reviewed deployment's identities. |
| `predictLifecycleToken({client, plan})` | Exact prediction from the explicit core. |
| `prepareAndPlanLifecycleLaunch({client, account, plan, mode, buySlippageBps?, allowTopologyGaps?, allowMissingPermanentTail?, limits?, fork?, receipts?, confirmations?, signal?, onProgress?})` | Mines config6/V2 salts offchain, verifies per-market topology and exact final deployment bindings, and proves the selected-mode prefix under one fresh post-mining snapshot. Reports deferred steps; buy calibration requires activation coverage. No source-chain deployment or broadcast. |
| `readPoolBoundHookDeployment({client, plan, marketIndex})` | Verifies typed factory, code chunks, constructor, normalized economics, initcode, salt, CREATE2 prediction and recorded provenance of existing code. Works with draft salts; permission bits are additionally required for executable predeployment. |
| `buildPoolBoundHookDeploymentTransaction({client, plan, marketIndex})` | Optional permissionless typed `deploy(parameters,salt)` calldata. Does not create a token, register/initialize a pool, bind a collector or activate a launch. |
| `planLaunch({client, account, plan, mode, allowTopologyGaps?, allowMissingPermanentTail?, limits?, fork?, receipts?, confirmations?, signal?})` | Independently fresh per-market topology/domain/funding/profile/progress/execution admission of the already-finalized commitment, simulating only the explicitly selected mode. |
| `simulateLaunchPlan({client, planned, limits?, fork?, receipts?, confirmations?})` | Rereads canonical state and proves remaining work. Preserves receipt evidence, economics and selected mode. |
| `readLaunchProgress({client, planned, receipts?, confirmations?})` | Confirmation-bound canonical state, latest head, receipt/replacement/reorg status, account-nonce safety and actual prepared market/live state. |
| `buildNextTransaction({client, planned, reviewedTransaction?, submissionClient?, limits?, fork?, receipts?, confirmations?, action?})` | Rereads canonical progress and constraints, proves the immediate next transaction plus the fitting prefix, and returns one admitted envelope. With `reviewedTransaction`, directly replays only that matching immediate step at its exact held gas/price. Optional `submissionClient` adds read-only exact-envelope preflight. `action: "cancel"` retains adapter-independent recovery. Terminal launches return `undefined`. |

Clients may be viem public clients or raw `request({method,params})` RPC clients. Transport, wallet, signing and durable storage are application-owned. `PlannedLaunch` contains bigint values and live limit callbacks: persist `serializeLaunchPlan(plan)`, explicit execution mode, confirmation policy and receipt references, not the entire object.

## Commitment and integer representation

The economic tuple contains chain/core/creator/nonce; ERC20/ERC404 token and token-global reward configuration; sorted funding outputs and fee assets; ordered markets; ordered initial buys; deadline; and initial executor fee. Each market commits exact adapter/profile/quote/budget/version/config bytes. Each buy commits market index, quote input, minimum token output, recipient and Q64.96 price limit; repeated indices keep their order.

`hashLaunchPlan` is `keccak256(abi.encode(keccak256(bytes("BLACK_MARKET_LAUNCH_PLAN_V1")),plan))`. `hashLaunchIdentity` is `keccak256(abi.encode(chainId,orchestrator,creator,nonce))`. Token prediction depends on that identity and token configuration, not the economic plan hash, so the predicted token can appear in sorted fee assets without circularity. Economics cannot change after begin. Mode/batching are execution metadata outside the tuple.

Use bigint for uint256/uint160/uint128 values and decimal strings in portable JSON. `parseLaunchPlan` rejects lossy JSON numbers and out-of-width values. Amounts are base units, liquidity is uint128, and `1n << 96n` is raw-unit price ratio 1, not a display-unit price. The pure helpers `deriveLaunchPoolRecipe`, `estimateLaunchInitialBuy` and `deriveLaunchBuySqrtPriceLimitX96` do not prove fees, market admission or execution; derive actual minimum outputs from stateful simulation and review the resulting final commitment again.

Bounds: 1–16 markets, 1–8 fee assets, at most 8 funding outputs, 64 ordered buys and 32 total positions. None guarantees gas feasibility. Reward-free ERC20 allows the positive uint256 supply domain; reward-enabled ERC20 is capped at `10^77`; ERC404 supply fits uint96. Current exported supply bounds preserve these exact numerical domains.

```ts
import { parseLaunchPlan, serializeLaunchPlan, encodeLaunchPlan, hashLaunchPlan, hashLaunchIdentity } from "@black-market/sdk/lifecycle";
const plan = parseLaunchPlan(savedPlanJson);
const bytes = encodeLaunchPlan(plan);
const commitment = hashLaunchPlan(plan);
const identity = hashLaunchIdentity(plan);
const portable = serializeLaunchPlan(plan);
```

## Registry-driven profile selection and frozen consent

The exact canonical registry getters are `profileCount`, `profileIds(offset,limit)`, `adapterCount`, `adapterIds(offset,limit)`, `profile`, `adapter`, `profileTopology` and `requireEligible`. There is no SDK template-ID allowlist and no invented `profiles()`/`isProfileEligible()` ABI. Schema plus certified topology dispatches supported implementations; an unsupported schema is reported separately from invalid/unsupported positions.

`LifecycleProfile` contains `registration`, `adapter`, unchanged `topology`, `venueKind`, `admitted` and optional refusal `reason`. Reviewed V4 adds:

- `envelope?: LaunchEnvelopeV2`: artifact/review/bounds/terms digests; topology, config/economic versions, capabilities, flags/callbacks, treasury policy, stable beneficiary/maximum rate, numerical bounds and the exact dependency graph.
- `developerTerms?: {adapter, beneficiary, maximumDeveloperFeeBps, termsDigest, enabled}`.
- `protocolMaximumDeveloperFeeBps?: number`.

The profile identity uses domain `black-market.launch-profile.v2` and commits the four review/economic digests, topology/config/economic versions, stable beneficiary, maximum author rate and capabilities. It deliberately excludes instance addresses. `hashLifecycleProfile`, `encode/decodeLaunchEnvelope`, `encode/decode/hashLaunchBounds` and `hashLaunchDependencies` expose exact canonical encodings/domains. Graph dependency hashing includes chain/core/registry/registrar, live runtime commitments and exact code-chunk provenance; only the shared deployment salt is outside that economic dependency digest.

Profile certification checks reviewed capabilities/bounds, adapter/core/graph runtime hashes, manager/oracle/locker/collector dependencies, typed hook deployer and STOP-prefixed creation-code chunks. Shared roots additionally require exact constructor/salt prediction and the deployer's recorded runtime. Bound roots require exact immutable constructor/key/economic commitment and recorded runtime when deployed. Address bits `0x1afc` under mask `0x3fff` are necessary but never sufficient. Runtime/initcode portability bounds remain 24,576/49,152 bytes; no compiler/code-size relaxation is assumed.

Registry `authorizationDigest`, `beneficiaryNonces` and `registerProfile` ABIs expose canonical reviewed admission/author consent. Admission does not make a template name an SDK allowlist or bypass current `requireEligible`. Profile retirement prevents new/pending source binding; it does not rewrite frozen active source terms or disable stable-author fee claims.

## Current venue codecs

### Shared V4, version 4

`encodeV4LifecycleMarketConfig` / `decodeV4LifecycleMarketConfig` accept only inner version 4. Market `configVersion` is 4. Exact schema:

```text
(uint16,uint24,int24,uint160,uint24,uint8,uint8,address,bool,bytes32,bytes32,bytes32,address,uint16,(int24,int24,uint128,bytes32,uint256)[])
```

### Pool-bound V4, version 6

`encodePoolBoundV4LifecycleMarketConfig` / `decodePoolBoundV4LifecycleMarketConfig` support explicit inner versions 5 and 6. The current October8 graph requires version 6 and matching market `configVersion`; historical version 5 requires its own graph and V1 constructor. Version 6 schema:

```text
(uint16,uint24,int24,uint160,uint24,uint24,uint32,uint8,uint8,address,bool,bytes32,bytes32,bytes32,bytes32,address,uint16,(int24,int24,uint128,bytes32,uint256)[])
```

Both preserve LP/hook fees, tick spacing, opening price, fee mode/denominator/treasury, external-liquidity policy, and canonical oracle identity. Pool-bound version6 inserts `uint24 minimumHookFeePips` and `uint32 feeSensitivityPipsSecondsPerTick` **immediately after `uint24 hookFeePips`**; `hookFeePips` remains the maximum. All other fields retain their order, including `hookSalt` immediately before `profileId`. Then come `profileId`, `termsDigest`, `developerBeneficiary`, explicit `developerFeeBps`, and positions. Every developer rate, including zero, is creator-selected. Copy terms from the selected profile's envelope. Inner/outer profile IDs must match; author identity is not the live payout. The creator rate cannot exceed either reviewed maximum or protocol ceiling.

All three hook fee settings are independently chosen per pool and frozen at launch.
One million pips is 100%, and 10,000 pips is 1%. `validatePoolBoundHookFees` validates
integer `0 <= minimum <= maximum <= 1,000,000` and sensitivity `0..4,294,967,295`.
The current reviewed `FixedFeePoolHookV1` uses a **fixed maximum-pips schedule**:
each applicable hook fee is `floor(amount * hookFeePips / 1,000,000)`.
Its base stores and exposes `minimumHookFeePips` and
`feeSensitivityPipsSecondsPerTick`, but this concrete hook does not use them in fee
calculation. Sensitivity's encoded units are fee-pips × seconds/tick; they do not
imply an active oracle-driven fee formula. Registered oracle configuration still
governs the pool's oracle behavior, not this hook's fixed fee rate.

The registered **Dynamic Fee Hook** instead uses the oracle's upward quote-per-base
tick velocity: `minimum + floor(positiveTickChange * sensitivity / elapsedSeconds)`,
capped at `hookFeePips` (the maximum). Quiet/falling prices, zero elapsed time or zero
sensitivity use the minimum. Select its own preset/terms, set **`lpFeePips: 0`** and
explicitly encode all three config6 fee settings. Its reviewed author allocation is
**0 bps**, so `developerFeeBps` must be zero. Generic config6 codecs do not identify
fee behavior or certify constructor compatibility; live constructor/simulation
authority remains required. Fixed launch examples continue selecting the fixed preset.

```ts
const profile = profiles.find((row) => row.id === selectedProfileId);
if (!profile?.admitted || !profile.envelope || !profile.developerTerms) throw new Error("Selected profile is not reviewed/admitted");
const config = encodePoolBoundV4LifecycleMarketConfig({
  version: 6, hookSalt: zeroHash, lpFeePips, tickSpacing, sqrtPriceX96,
  hookFeePips: creatorMaximumFeePips, minimumHookFeePips: creatorMinimumFeePips,
  feeSensitivityPipsSecondsPerTick: creatorSensitivityPipsSecondsPerTick, feeMode,
  protocolFeeDenominator: profile.envelope.protocolFeeDenominator,
  treasury: profile.envelope.protocolTreasury,
  externalLiquidityDisabled: creatorSelectedExternalLiquidityDisabled,
  oracleConfigId: creatorSelectedOracleConfigId,
  profileId: profile.id, termsDigest: profile.developerTerms.termsDigest,
  developerBeneficiary: profile.developerTerms.beneficiary,
  developerFeeBps: creatorSelectedRate, positions,
});
```

`validateV4LifecycleMarket` checks profile/terms/topology/version, explicit author-rate ceilings and exact envelope bounds. Registry/adapter validation remains the execution authority. Positions must require **zero quote deposit** at the committed opening price in actual token orientation. Quotes fund ordered buys, not two-sided initial LP. At most one V4 market per quote is allowed across all templates/topologies/fees/salts; put that quote's positions into one market. Abyss may use the same quote.

`validateV4LifecycleOracle({client,envelope,oracleConfigId,block})` checks the selected registered
oracle against the certified factory and `maximumOracleCardinality`. Profile discovery does
not choose an oracle or query a profile-pinned oracle ID.

Abyss retains `encodeAbyssLifecycleMarketConfig` / `decodeAbyssLifecycleMarketConfig`: canonical pool profile, fee, oracle ID, opening price and ordered tick/liquidity/token-max positions. Quote/fee assets and direct ERC20/native-wrap funding are permissionless subject to actual code, transfers/balances/budgets and canonical bindings. Quote catalog metadata is not admission. Only swap-conversion inputs/targets use registry funding admission.

## Freeze and finalize bound economics

Freeze chain/core/creator/nonce, token identity, sorted fee policies, all funding/budgets/positions/terms and ordered buys before mining. Create config6 with all three creator fee settings, the chosen bound profile's exact terms and a draft salt; never implicitly reinterpret a shared or historical config5 config.

```ts
const stop = new AbortController();
const finalized = await prepareAndPlanLifecycleLaunch({
  client, account: draft.creator, plan: draft, mode: "staged", signal: stop.signal,
  onProgress: ({marketIndex, attempts, predictedHook}) => console.log(marketIndex, attempts.toString(), predictedHook),
});
const saved = serializeLaunchPlan(finalized.plan);
if (!finalized.simulation.admitted) throw new Error(finalized.simulation.reason);
// Use finalized.progress and finalized.hookDeployments; do not immediately plan again.
const boundIndex = finalized.plan.markets.findIndex((market) => market.configVersion === 6);
const optionalPredeploy = await buildPoolBoundHookDeploymentTransaction({client, plan: finalized.plan, marketIndex: boundIndex});
// Inspect only; separately admit/authenticate/sign any optional predeployment.
```

The collector supplies canonical normalized economic commitment and constructor metadata. `hashPoolBoundV4MarketCommitment` uses domain `black-market.pool-bound-market-economics.v1`: chain, core, registrar, predicted token, adapter/profile/quote/budget/version and encoded config hash with **only hookSalt zeroed**. Minimum, maximum and sensitivity, plus developer identity/digest/rate, remain committed. `PoolBoundHookParametersV2` and `poolBoundHookParametersV2Components` are the current constructor API; there is no V1 alias. The constructor freezes manager, registrar, oracle factory, core, locker, token/quote, fees/spacing/price/policy, economic commitment and position count. Salt is used verbatim by CREATE2, not as a constructor argument. Local/remote constructor equality and deployed immutable getters bind both new values.

Mining is cancellable/nonblocking; `abort()` raises `AbortError` and does not cancel an onchain launch. The miner reuses the exact CREATE2 preimage's immutable prefix/suffix and checks all 14 permission bits before materializing rejected-address progress at bounded macrotask boundaries. Persist the returned finalized plan, not the draft. A salt-only change preserves normalized economics but changes final plan hash. Other changes invalidate initcode/mining; concurrent mutation is refused. Normal next-step review rechecks token factory and the captured `hookDeployments` baseline. Predeployment is permissionless, but code presence or self-reported getters alone cannot be adopted as provenance. It does not register/initialize/seal/open a market and does not eliminate real code-deposit/setup gas.

## Explicit execution mode and indivisible activation

Every planning call requires `mode: "atomic" | "staged"`. Only that requested mode receives economic simulation; staged does not compute or expose an unused atomic attempt.

- Atomic: after funding prerequisites, token creation, empty infrastructure, all mint/lock/buys/public activation are one transaction.
- Staged: prerequisites, `beginLaunch(Staged)`, greedily packed contiguous empty `prepareMarkets` batches, then one `activateLaunch`. A packed measurement failure using at least 95% of its given gas splits only that batch; low-gas semantic errors, byte caps and unlocated provider failures do not justify a split. Proof may cover only a prefix, with the unproved suffix explicitly deferred.
- Activation cannot split. If mint/lock/all buys/opening cannot fit, staged is also refused. No position/buy/minimum is omitted to manufacture success.

No automatic atomic-to-staged fallback exists. Obtain separate consent to review the same commitment as staged. Both venues use token transfer restrictions plus activation-time canonical opening-state checks, not a pool gate. Manipulated opening price or preactivation liquidity fails verification; the token stays inactive and the launch remains Ready/cancellable. Failed activation rolls back every mint, seal, buy and opening together.

## Execution constraints and stateful simulation

Optional `chainGasLimit`, `rpcGasLimit`, `accountGasLimit` and `maxCalldataBytes`
tighten admission. `maxSimulationGas` sets the aggregate used-gas proof-window
budget (default 50M on 4663, unknown on other chains). Missing policy stays explicit
in `limits.unknownExecutionConstraints`/`unknownConstraints`; no policy service is required.
A `LifecycleLimitSource` callback receives the canonical chain/account/core/block context.
Any supplied provenance must match it; stale/mismatched/malformed facts or a failed supplied
resolver reject rather than disappearing into optional uncertainty. Gas caps are positive
exact uint64 `bigint`; calldata is a positive safe integer byte count.
Reviewed gas envelopes are positive uint64 too; zero-metering observations cannot admit
a zero-gas transaction. Headroom calculations retain wide exact bigint intermediates.

Headroom defaults to 1,500 bps, bounded 0–10,000; it clamps to current legal ceilings
instead of rejecting a fitting measured requirement. HMM V2 adds the forwarding
target documented above once on atomic/activation. Generic EVM admission uses the pinned
bounded header and supplied total-envelope restrictions plus actual validated RPC proof.
It reports an absent independent per-transaction cutoff honestly, without importing a
universal Ethereum cutoff. `executionGasCeiling` and `transactionGasCeiling` are equal on
generic EVM. The permissive measurement pass never admits a launch: replay must execute
the exact returned gas/fee envelope, every postcondition and all ordered buy bounds.
Fork discovery uses gross sequential estimates, not refund-reduced receipt gas as an
executable minimum. Explicit ceiling recovery preserves gasleft/EIP-150 validation and
carries that successfully replayed ceiling, never a smaller unproved envelope.

Replay source, HTTP and malformed-response failures remain provisional with
`executionProof: "unavailable"` and do not retry economic execution. `AbortError`
propagates unchanged, including cancellation during supplied policy and Nitro getter
reads. Only explicit genuine native out-of-gas evidence may discover at most one
larger validated envelope within the same legal compute/total limits. Without returned
failing-call evidence, `failedTransactionId` stays absent; an opaque RPC error does
not invent a failing transaction or authorize preparation partitioning.
Returned failures retain the actual exact-replay prefix and its first failing
transaction, never a transaction ID borrowed from permissive measurement. For the
first failed preparation only, reviewed invariant errors may decode native
`error.data` when raw `returnData` is empty; nonempty raw bytes take precedence.
Unknown errors, `Panic`, generic `Error` and deployment wrappers do not establish
a deterministic preparation invariant or an out-of-gas cause.

Sequential backends:

1. `eth_simulateV1`: ordered transactions with state carried between synthetic blocks, followed by exact validated replay.
2. Generic EVM only: explicitly separate disposable loopback fork, with snapshot-isolated real transactions, pinned chain/header identity, canonical poststate/allowances and mandatory cleanup. Source RPC stays read-only.
3. Neither: unavailable/provisional/unadmitted; disconnected dependent `eth_call` estimates cannot create an executable next transaction.

Every proof completion rechecks the planned source chain ID and pinned block hash. A
changed source transport cannot retain admission merely by returning the same fork hash.

### Nitro compute and poster accounting

For Robinhood `4663`, each pinned context reads ArbSys (`0x64`).`arbOSVersion` and ArbGasInfo
(`0x6c`).`getMaxTxGasLimit`/`getMaxBlockGasLimit`. ArbSys returns **55 + logical ArbOS version**;
the raw value must be at least 105, and `limits.arbOSVersion` reports logical version 50+.
The positive validated getter values establish `maxTxComputeGas`, `maxBlockComputeGas`
and their minimum `executionGasCeiling`. Failed reads never fall back to the huge Nitro
header or a hard-coded 32M. `limits.protocol` identifies `"nitro"` or `"evm"`.

Nitro `transactionGasCeiling`, when present, is the minimum of supplied **complete**
chain/RPC/account gas-envelope restrictions. It is independent of the compute ceiling:
an admitted transaction's `gas` may exceed `executionGasCeiling` because poster gas is
not compute. NodeInterface (`0xc8`).`gasEstimateL1Component` is read at the same pinned
block with the exact sender, destination, calldata and value, including future dependent
steps whose execution cannot yet be independently estimated. It budgets poster gas only.
The buffered compute-discovery envelope plus buffered poster budget is carried into
exact validated replay; an approximate poster quote is never subtracted from total
gas use to certify exact compute fit.
Measurement waits for successful capability and candidate-specific poster evidence,
then uses the legal complete compute-plus-poster envelope. A packed preparation
failure consuming at least 95% may invalidate its cost estimate without claiming
its selector diagnoses OOG. Unsupported/transport evidence remains unavailable,
except an observed aggregate-budget exhaustion can preserve a successful prefix.

A separate pinned validated simulation probes all three ArbOS/version/getter values
against the canonical observations. Only that isolated capability probe temporarily
overrides the probe account's balance, so probe-only fees cannot reject an exactly-funded
launch. Probe funding/nonce changes, steps and fees never enter real plan measurement,
replay, postconditions or affordability, which use actual payer state. The native Nitro
`eth_simulateV1` commit-mode ArbOS charging hook removes the **actual** poster charge and
holds excess compute gas before execution. Successful exact replay and postconditions,
not the quote or permissive pass, prove fit. Missing native metering or a mismatched
probe fails closed. Generic Anvil/Hardhat forks cannot certify Nitro execution.

Transactions expose `estimate.executionFee`, optional external `dataFee`/`totalFee` and
`feeConfidence: "execution-and-data" | "execution-only"`. On Nitro, `posterGas`/`posterFee`
are the estimated buffered allocation **inside** `gasLimit`, `dataFeeIncludedInGas` is
true, `dataFee` is zero and `totalFee` equals `gasLimit * gasPrice`. Affordability counts
this complete envelope once; adding `posterFee` again would double-charge. A caller
`estimateDataFee` is therefore rejected on Nitro. On generic EVM it retains its original
semantics as a validated external fee added outside execution gas. Missing external fee
does not manufacture an all-in estimate. All observations and limits refresh for build-next.
For initial construction, the exact legacy gas-price envelope is the greater of
the fresh RPC recommendation and twice the pinned base fee. This avoids
underpriced submission when `eth_gasPrice` lags the block base fee. Reviewed
envelopes retain exact gas/price through direct immediate native validated replay
and immediate affordability, without repeating measurement or applying new padding.
The held price need not equal a new recommendation or twice the current base fee;
natural child fees and the actual submission estimate must accept it. Replay,
affordability and submission use that same price, without a base-fee override.
An aggregate budget selects the longest fitting estimated prefix; only when even
the immediate estimate does not fit is no proof possible. A definitive returned
failure from the final exact replay skips a later payer-balance lookup, while
retaining fee/estimate validation and final canonical checks. Successful replay
still requires current actual-balance affordability.

Source references: [ArbSys version encoding](https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbSys.sol),
[ArbGasInfo compute getters](https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbGasInfo.sol),
[native simulate commit mode](https://github.com/OffchainLabs/go-ethereum/blob/51d716ccf8293072077feb9764d63d73f5e4ff20/internal/ethapi/simulate.go),
[ArbOS actual poster/compute charging](https://github.com/OffchainLabs/nitro/blob/ccc5c828d9ea22f161efc784bac4d4a6559b7e59/arbos/tx_processor.go),
and [NodeInterface poster estimate](https://github.com/OffchainLabs/nitro-contracts/blob/main/src/node-interface/NodeInterface.sol).
These describe backend semantics, not evidence of a live launch executed by this SDK release.

Atomic/activation simulation `steps[].returnData` encodes the actual `LaunchReceiptV1` tuple. Controlled-fork output is reconstructed from matching real activation/buy receipt logs and canonical state, never geometric estimates or echoed request minima. `tokenOut` and `quoteSpent` are parallel arrays indexed by ordered buys.

```ts
const fork = createControlledLifecycleFork({
  sourceRpcUrl: "http://127.0.0.1:18555", forkRpcUrl: "http://127.0.0.1:18556",
  allowTransactions: true, impersonation: "anvil",
});
const planned = await planLaunch({client, account: plan.creator, plan, mode: "staged", limits, fork});
```

The fork endpoint must be distinct/loopback, including localhost/IP aliases and effective port. Anvil reset/impersonation is default; disposable Hardhat may explicitly use its reset method/impersonation. Never pass the source client as a fork or use a live unlocked wallet as a disposable backend. Operators own exclusive fork access during generic EVM proof. Controlled-local execution does not prove wallet submission acceptance and cannot certify Nitro metering or imply bound topology is a gas optimization.

## Wallet submission and canonical recovery

The SDK never signs. Before **every** approval/reset/core/predeploy/cancel signature, compare the wallet's configured chain (if any) and fresh connected `getChainId()` with the returned `next.chainId`. Failure/invalid identity is a refusal. Supply a matching explicit viem Chain descriptor; do not pass `chain: null` or disable wallet chain checks. Send exact `from/to/data/value/gas/gasPrice`, not a cached estimate or wallet batch.

Simulation and `next.admission` carry flat, independent proof outcomes:

| Field | Values | Scope |
| --- | --- | --- |
| `executionProof` | `"proved"`, `"failed"`, `"unavailable"` | Stateful exact-envelope execution/postconditions for the proven prefix (or the immediate reviewed step), never measurement alone or an unproved suffix. |
| `protocolFit` | `"proved"`, `"failed"`, `"unknown"` | Applicable proven protocol and known tightening restrictions. Missing optional policy remains separately disclosed. |
| `transportPreflight` | `"not-requested"`, `"passed"`, `"failed"` | Immediate exact next-transaction acceptance estimate on the supplied submission RPC. |

`admitted` means the proven prefix fits and is affordable, not that deferred
transactions have executed or that eventual activation is guaranteed. Always
inspect `simulation.deferredTransactionIds`. Admission reuses `blockNumber`,
`blockHash`, `account`, `chainId` and `limits`; signing uses only fresh build-next
admission. Plans never preflight future steps independently against nonexistent state.

```ts
const planned = await planLaunch({ client, account: plan.creator, plan, mode: "atomic" });
const submissionClient = {
  request: ({ method, params }) => activeProvider.request({ method, params }),
};
const reviewedTransaction = await buildNextTransaction({ client, planned, receipts, submissionClient });
// Present this exact envelope for user review. After explicit confirmation:
if (reviewedTransaction !== undefined) {
  const next = await buildNextTransaction({ client, planned, receipts, submissionClient, reviewedTransaction });
  // Recheck active account/connector/chain and strict exact-envelope equality before signing next.
}
```

When supplied, `submissionClient` receives only read-only `eth_chainId` and
`eth_estimateGas` for the immediate next `from/to/data/value/gas/gasPrice` at `latest`.
Its positive estimate must fit the reviewed gas exactly; gas is never silently enlarged.
Chain identity is checked before and after estimation, and the source pinned hash/chain
is rechecked before returning. Success sets `next.admission.transportPreflight` to
`"passed"`. Refusal, unsupported RPC, malformed estimate, over-envelope estimate or
chain drift raises `SUBMISSION_PREFLIGHT_FAILED` without returning a transaction.
The error's `simulation` retains execution admission and its canonical context, changing
only transport outcome/reason to `"failed"`. Cancellation uses the same preflight.
Without a submission client, `"not-requested"` remains honest and no wallet RPC is implied.
Applications still own fresh active account/provider guards around asynchronous work;
a read-only preflight does not authenticate an active wallet or authorize a signature.


Persist transaction hashes immediately. After receipt, retain `observedBlockNumber`, `observedBlockHash`, confirmation policy and, for replacements, original `transactionHash` plus effective `replacementHash`. A same-nonce self-transfer is replacement-cancelled, not launch completion. Removed observed blocks are reorged; status zero is reverted; a missing receipt at the unchanged observed block remains pending. Unknown hashes do not invent reorgs.

`confirmations` is positive and defaults to 1. Progress anchors confirmed canonical and latest head hashes, compares confirmed/head/pending account nonces, and prevents ref-free reloads from advancing unconfirmed work. Pending receipts/state return no executable envelope (`RECEIPT_PENDING`/`UNCONFIRMED_STATE`). Reload the exact plan/mode/policy/receipt references; never trust a cached step counter. Market read failures are surfaced without removing adapter-independent cancellation.

## Funding and cancellation

Creator/payer/refund recipient are the same address. ERC20 prerequisites approve immutable `fundingEscrow`, not core/adapters; amounts aggregate by input asset and insufficient nonzero allowances reset before exact approval. NativeWrap requires canonical wrapped-native binding and exact summed native value; there is no invented launch fee. Swap funding commits approved target/spender/code hash and exact input/output/calldata. Unrelated donations/other launches are not swept as refunds.

Preparing/Ready cancellation uses the stored commitment after expiry/retirement without calling adapters or requiring new profile/funding admission. It refunds unspent external funding only. Wrapped-native refunds are wrapped ERC20, not original native gas funds. Cancelled token inventory remains inactive or burns according to the plan. Cancellation still needs current execution admission and nonce/receipt safety; Active/Cancelled are terminal and there is no postactivation creator pause.

```ts
const cancel = await buildNextTransaction({client, planned, receipts, limits, fork, action: "cancel"});
// Apply identical wallet-domain/exact-envelope/receipt handling before submission.
```

## Stable author APIs and V3 fees

`developerBeneficiary`/envelope `beneficiary` is stable `authorId`. Registry `authorPayout(authorId)` is mutable live routing/controller; zero means unknown. Registry admin or current payout/controller may change a known nonzero route with `setAuthorPayout`. Retirement never changes stable identity or blocks existing active developer credits.

| Helper | Inputs / semantics |
| --- | --- |
| `readLifecycleAuthor` | `{client,registry,authorId}` → canonical core/factory, known/live payout, hub count, pinned chain/block. |
| `readAuthorHubs` | Same + `offset?:bigint,limit?:bigint` (defaults 0/100), bounded **1..100**, offset ≤ total, actual hubs/nextOffset/total/cursorComplete. |
| `readDeveloperFees` | Same + `hub,assets?` → authenticated V3 hub, actual assets, claimable/reserved balances, frozen source terms/assets. Explicit unsupported assets are flagged, not relabeled supported. |
| `buildSetAuthorPayoutTransaction` | Same + `payout,account,chainId:bigint`; requires current controller/admin and known identity. |
| `buildClaimDeveloperFeesTransaction` | Same + `hub,asset,account,chainId:bigint`; permissionless fixed-live-payout direct claim. |
| `buildClaimDeveloperFeesPageTransaction` | Same + `offset:bigint,limit:bigint,assets?,account,chainId:bigint`; factory page **1..10**. |
| `decodeDeveloperClaimReceipt` | `{receipt,transaction}` using exact unsigned claim context; validates emitter/account/target/context/cursor/status/rows. |

Unsigned objects carry exact `chainId/from/to/data/value`, with no execution default. Canonical membership is anchored to **registry.core → core.feeFactory → factory.isHub** before any hub self-report; selected registry/core/factory bindings are also checked. Page assets are sorted unique nonzero addresses, at most eight; `[]` means each hub's actual assets. Page cursor completion is independent of payment success: statuses **0 paid, 1 zero, 2 unsupported, 3 failed** remain distinct; preserve retryable failed rows even when the cursor reaches total. A successful direct receipt without `DeveloperFeesClaimed` is `unobserved`, not an invented zero payment.

Choose an explicit page gas budget under the current account/RPC/chain limits, including every bounded hub/asset call plus factory overhead and EIP-150 headroom. `eth_estimateGas` success alone does not prove every row was attempted: the factory can complete the cursor while reporting failed rows under insufficient caller gas. Always decode and retry failed rows; never equate transaction success or cursor completion with payment success.

Current ordinary fee preview/building uses public `lifecycleFeeHubAbi` with **no-argument `claimAndSplit()`**. Preview via viem `simulateContract`/`eth_call`, and build unsigned calldata with `encodeFunctionData`; neither guarantees execution. V3 freezes each source's adapter/profile/terms/stable author/maximum/selected rate. For each actual collected asset: executor bounty is deducted, owner/rewards/burn policy is split with canonical dust allocation, then developer fees are floor-rounded from each source's proportional contribution to the owner share. Developer fees do not reduce rewards/burn, do not reward donations and do not spend prior reserved credits. Owner and developer allocations are reserved before external payouts. `Distributed` includes `developerAmount`; hub reserved inventory is `reservedOwnerFees + reservedDeveloperFees`, not owner reserves alone.

Current registered fee owners may update executor bounty up to 1,000 bps. Each no-arg harvest snapshots one rate for all sources, including already accrued source fees. Owner/reward/burn policy and frozen developer terms do not change; old owner credits remain with the credited owner. Owner `claimOwnerFees(asset,recipient)` withdraws reserved credits without harvesting/bounty. Developer `claimDeveloperFees(authorId,asset)` has no recipient argument and resolves live registry payout at execution.

Lifecycle dividend tokens retain independent current-owner dividend bounty up to 1,000 bps, gross previews and net beneficiary payments with separate caller bounty; self-claims get full gross. Staking claims have no dividend payout bounty. Oracle genesis/cardinality/opening state is not lending-feed maturity, depth or recency approval; unrelated lending checks remain unchanged.

## Independent vectors and local proof

`test/fixtures/launch-lifecycle-v1.json` is a portable **offline wire vector**, not a deployed launch. Its independent generator owns the literal canonical ABI tuple:

```sh
node examples/generate-lifecycle-commitment-fixture.ts test/fixtures/launch-lifecycle-v1.json
```

Build and run the offline unit suite with `pnpm test`, and deployed read-only discovery with
`pnpm examples`. Unit regressions cover commitment/identity/numerical domains,
reviewed terms/rate/bounds, salt normalization/mining, receipt recovery, and author
authentication/routing/page outcomes. Wire vectors remain
offline schema references; they are not a mainnet launch or an admitted deployment graph.

`examples/launch.ts` reviews a saved plan without signatures or source-chain writes:

```sh
pnpm build
node examples/launch.ts --plan plan.json --rpc https://rpc.mainnet.chain.robinhood.com/ --mode staged --mine
```

The saved plan must use that RPC's chain and current deployment. `--mine` finalizes bound
salts offchain; `--limits current-limits.json`, `--receipts receipts.json`, and `--confirmations N`
supply explicit execution/recovery evidence. The command never invents provider/account limits.
Without a sequential simulation backend and matching execution-limit provenance, its review
can be provisional and cannot produce an admitted next transaction.

`examples/launch-lifecycle-smoke.ts manifest.json sdk-plans.json` executes Solidity-exported
plans only on explicitly authorized owned loopback fixtures. It exercises atomic/staged
modes, typed predeployment, ordered buys, permanent custody, canonical recovery, no-argument
V3 harvest, and authenticated author claims. `test/lifecycle-chain.test.mjs` exercises
real-graph refusals/reorg/cancellation with the same fixture environment. See
[example instructions](../examples/README.md#actual-owned-fixture-proof) for the explicit
local-execution opt-in and required files.

## Individual token creation examples

Eleven independent `examples/launch-erc20-*.ts` / `launch-erc404-*.ts` files invoke
the shared `runLaunchExample(caseObject)` using valuation-driven economics with no
required CLI parameters or fixture files. **No mode flag means a dry run**:
the first output is `DRY RUN — no transactions signed or broadcast.`, followed by
the full economic review and retained planning artifacts. Successful planning exits
`0` without constructing a wallet signer, signing, broadcasting, uploading or publishing.
The final output line is the same case command with `--broadcast` appended:

```sh
node examples/launch-erc20-v4.ts
node examples/launch-erc20-v4.ts --broadcast
```

**`--broadcast` authorizes full execution and intentionally skips manual
economic-review admission.** It prints/saves the same review and computed hash,
plans afresh against current state, then performs guarded signing, broadcast,
chain verification, image upload and publication. It does not execute the dry run's
saved plan. Unknown, duplicate or mixed flags fail fast with usage text.
Optional `--resume <recovery-dir>` continues the original committed launch unchanged,
without needing `--broadcast`. CLI dry-run/broadcast selection is independent of
the case's atomic/staged execution mode. The eight original cases remain; the three additions
(`launch-erc20-multi-quote.ts`, `launch-erc20-depth-v4.ts`, and
`launch-erc20-dividends-multiquote-mixed.ts`) await user live-run validation before
any replacement decision. See the [example guide](../examples/README.md#individual-token-creation)
for all one-line commands and setup-once working-directory `.env`.
Node 24+ loads `.env` once, with existing process environment taking precedence.
`LAUNCH_API_URL` and **exactly one** signer source are required before RPC/signing/API
work: `PRIVATE_KEY`, or `EXAMPLE_KEYSTORE_PATH` for an owner-only local V3
scrypt/AES-128-CTR JSON keystore. `EXAMPLE_KEYSTORE_PASSWORD` defaults to the empty
string; both/neither sources reject. The bounded keystore loader authenticates the
MAC and declared address before deriving the creator. There is no default key,
guessed metadata API or API-omission mode. Dry runs derive only the public creator
address (keystore decryption is allowed for this); local signing methods are constructed
only for broadcast or nonterminal resume execution. Broadcast mainnet writes are
irreversible. The official chain-4663 RPC is the default.

The implementation imports public `@black-market/sdk`, resolves `getAddresses(4663)`,
derives the creator from the selected signer and discovers actual admitted profiles.
V4 requires bound topology/config `6` on a V2-constructor graph; Abyss requires exact
adapter `profileId(3)` QUOTE_ORACLE/config `1`. WETH verifies wrapped-native
binding/18 decimals and registered P1 oracle `(1,4096)`. USDG uses 6 decimals,
the reviewed `usdPeg` USD-X18 seed `1e18`, and a compatible registered oracle
discovered from pinned factory history/mapping, not an invented WETH oracle ID.
The eight original cases retain their token/reward/market/position/mode choices:
ERC20 `1_000_000e18` supply; ERC404 `10_000e18` supply / `100e18` NFT unit; selected
staking/dividends and token-only burn; one through five positions and ordered buys.
All cases now fund those buys through native-ETH Kyber conversion. Identity,
finalized salts and exact plans are saved before execution; refusal never changes
mode, drops positions/buys or overrides failed admission.
Pricing uses a USD 5000 target (optional exact `EXAMPLE_TARGET_MARKET_CAP_USD`),
actual total minted supply, predicted token order and each market's integer budget.
`deriveLaunchPoolRecipe` owns one-position pricing/liquidity; multi-position markets
use `deriveLaunchPositionRanges` with exact counts, `positionGaps: "adjacent"` and a
boundary final tail. Staircase remains the original multi-position default; the
four-position progressive Depth case uses Early Scarcity with adjacent bands and
increasing inventory allocations, not the separate historical eight-position
catalogue. Both venues use spacing 60/LP fee 3000. There is no 1:1 price,
fixed-liquidity reserve or arbitrary absolute range. All intended supply funds LP
except explicitly computed rounded-up mint-debit dust, which burns.

Every opening buy defaults to **0.00001 native ETH** (`10000000000000` wei).
`EXAMPLE_BUY_AMOUNT_WEI` overrides the ETH input per buy, not the eventual quote
amount. The runner aggregates inputs by quote and obtains one fresh
`POST /api/v1/quote/kyber/build?chainId=4663` build per quote, using native
zero-address `tokenIn`, exact input, actual escrow sender/recipient, **50 bps**
conversion slippage and the same fixed **300-second launch-purpose deadline**
as the plan. `EXAMPLE_KYBER_API_URL` defaults to `LAUNCH_API_URL`; the app's public
trade default is `https://api.abyss.trading`, so a different service must be chosen
explicitly. The API owns route preview; preview GET bytes are not executable funding.

Each row is `LifecycleFundingKind.Swap`, with native zero-address `inputAsset`,
the reviewed router target and original built calldata. The runner decodes the
reviewed `swap` entry point and binds currencies, escrow recipient, exact input,
minimum output, executor payload and flags. The API floor
`amountOutMinimum = floor(amountOut * 9950 / 10000)` becomes the quote budget;
ordered buys sharing a quote divide that budget, assigning the integer remainder
to the last buy. The creator needs native ETH for conversion **plus gas**, not
WETH/USDG wallet balances or ERC20 approvals. Registry target/spender/code-hash
admission is checked and rechecked before signatures. Any refusal stops unsigned
with retained evidence, never a native-wrap/direct-ERC20/separate-wallet-swap
fallback, route retry or rewritten deadline.

Optional `EXAMPLE_TOKEN_NAME`, `EXAMPLE_TOKEN_SYMBOL` and
`EXAMPLE_TOKEN_DESCRIPTION` override each case's defaults while retaining the
existing normalized text and API/lifecycle length limits. Optional
`EXAMPLE_IMAGE_PATH` supplies actual PNG/JPEG/WebP artwork, bounded to 1 byte
through 5 MiB. Its exact SHA-256/content-type/length is part of the reviewed,
signed attribution; the runner follows the API-issued upload and completion flow.
Without that option, metadata-only sessions still require `image: null`.

The indicative WETH USD seed comes only from the configured `LAUNCH_API_URL` token-prices
API: one uncached GET `/api/v1/token-prices?chainId=4663&limit=100`, with a 30-second
timeout, 1 MiB streamed body limit and no pagination, redirects or retries. The
reviewed WETH row must have chain 4663, ready metadata, 18 decimals, `priced: true`,
anchor source and direct WETH/Chainlink provenance with aggregator
`0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`. Price parsing requires an exact positive
uint256 decimal `priceUsdX18`. Missing, unpriced, mismatched or unavailable data
rejects without a manual or alternate-source fallback. API publication supplies
an indicative launch valuation, not executable swap, receipt or chain authority.
API origin, index/graph blocks, upstream timestamp/age and local retrieval time are
preserved and displayed; retrieval does not refresh the upstream observation.
There is no 15-minute contract-round gate or API-block canonicality requirement.
Public `economic-review.json` and exact private recovery precede the first signature.
Review includes quote/source/time, target, actual minted supply, exact price
orientation, all allocations/liquidity/fees,
expected retained supply and aligned opening valuations. The final admitted
activation simulation supplies each ordered buy's quote spent/token output,
all-in average USD/token and fee-plus-price-impact premium. This is not a claim
of simulated final marginal spot. Alignment and buys mean the eventual valuation
need not equal USD 5000; use actual retained supply and observed post-buy price.

The computed review hash is provenance evidence, never an authorization input:
there is no interactive prompt or environment hash gate. `--broadcast` alone is
the explicit mode authorization, recorded in `economic-admission.json` as
`authorization: "--broadcast"` with the computed hash; this artifact is not another gate.
Before each attribution/transaction signature, the immutable review hash, saved
plan/supply/order/target and fresh RPC token prediction are rechecked, then the same
API source is reread. A changed exact price, API origin, chain, WETH/decimals or
direct-anchor identity/kind/source rejects without rewriting intent. Failed or
unpriced reads reject. Index/graph and observation/retrieval times may advance for
an unchanged exact price and source, without replacing the original review.
RPC still owns provider chain, balances, nonce, deadlines and native execution
proof. The saved deadline is checked again after asynchronous quote/authority
reads and before signatures/staging; expiry stops without extending it.
Partial execution never grants permission to replay or silently adopt different economics.
The current 0.7.1 V4 examples require the config6/V2 profile, freezing max `10000`,
min `1000` pips and sensitivity `7654321` fee-pips × seconds/tick. Its reviewed
`FixedFeePoolHookV1` charges the fixed maximum `10000` pips (1%) on applicable amounts;
minimum and sensitivity are stored constructor evidence, not a dynamic fee schedule.
Optional `NFT_BASE_URI` provides an ERC404 base URI you actually host; its default is
empty, with real NFT units/mirror behavior but no claim of hosted NFT metadata.

The chain-4663 examples require native sequential Nitro `eth_simulateV1`; generic
Anvil/Hardhat simulation is not an ArbOS compute/poster proof. Source RPC requests
have a 120-second bound and are not retried. There are no invented default gas or
calldata caps. Explicit environment restrictions only tighten the complete envelope;
headroom defaults to 1,500 bps. SDK native pinned compute/poster reads and exact replay
remain mandatory, and build-next uses the same source RPC as the read-only submission
preflight before each local signature. Environment options are documented in the example guide.

Execution rechecks chain/creator/destination and exact finalized calldata before each
send. Exact admitted envelopes are signed locally; computed hashes and unsigned
envelopes are saved **before** the single raw broadcast, and included receipts are
saved before status/provenance assertions. One canonical confirmation is required.
Actual verification covers Active state, factory/token runtime/name/symbol/kind/rewards,
ERC404 unit/URI/mirror, opened markets, sealed V4 custody/permanent Abyss lock terms,
fee policies and ordered activation buys.

Actual SDK API metadata staging uses locally signed full-domain attribution.
Before **every** publication attempt and before final success, a fresh canonical
RPC barrier binds the original activation hash/receipt to the saved commitment
and Active state; a different later activation observation cannot replace it.
Only that original hash is published. Genuine pending-indexer HTTP `202` is
polled within 90 seconds respecting `Retry-After`; other failures are not retried.
Success requires an optimistic/final session and real indexed
`/api/v1/launches/<token>?chainId=4663` DTO with matching creator/token/hash/metadata.
Missing/incompatible indexing fails without manufacturing projections, skipping
API or launching another token.

When `EXAMPLE_IMAGE_PATH` is set, metadata staging alone is insufficient:

1. The completed session must show the exact signed SHA-256/content-type/length
   and a ready image.
2. Publication must retain that descriptor and reference a ready public image.
3. The indexed token must carry a non-null matching `imageUrl`, with matching
   metadata type/length and a token-bound `imageKey`.
4. One bounded, no-redirect GET of that URL must return **HTTP 200**, an image
   content-type family and nonempty bytes. Byte-identical output must match the
   upload's exact SHA-256/type/length. Different served bytes are recorded as an
   inferred API/CDN transformation, proving only the image-family/nonempty-body
   check, not byte identity. The canonical RPC barrier runs again after this GET.

Any failed binding, HTTP/type/size/body check exits nonzero with retained evidence;
there is no image retry or metadata-only fallback. Without an image path, the
metadata-only null-image behavior remains.

Every dry run or broadcast automatically creates fresh `launch-results/<timestamp-case-random>/`;
`--resume` appends recovery evidence in the original directory. Dry runs retain
all planning/review/recovery artifacts, but no admission, signed bytes, API session
or publication artifacts:

| Artifact | Evidence |
| --- | --- |
| `events.jsonl` | Timestamped case/stage events, RPC/API errors, admission/simulation and actual chain observations. |
| `plan.json` | Redacted finalized plan for public inspection, not exact recovery authority. |
| `economic-review.json` | Public exact quotes, native Kyber inputs/calldata/minima/deadline, metadata/image descriptors, target, aligned minted/retained valuation, position budgets/debits/dust, fees, protected buys and simulated all-in execution prices; redacted, not recovery authority. |
| `economic-admission.json` | Broadcast-only mode authorization (`authorization: "--broadcast"`) and computed review hash as provenance, not supplied-hash admission. |
| `receipts.json` | Empty for a dry run; execution retains exact signed-envelope hashes pre-broadcast, followed by real receipts/references. |
| `result.json` | `black-market.launch-example-result.v1`, runMode, scope, status, failure stage and causal evidence. A successful dry run has `scope: "planning"` and `execution: "dry-run"`; it does not claim chain/API completion. |
| `published-token.json` | Actual indexed API representation. |
| `published-image.json` | Optional bounded public-image HTTP/type/length/SHA-256 verification, transformation qualification or failure evidence. |
| `private-recovery.json` | Mode `0600`; complete exact finalized `plan`, original `mode`/`confirmations` and immutable economic review/hash saved during planning. Broadcast adds immutable mode authorization/hash provenance, signed raw bytes, API signature and one-time capability retained across updates. Never share/commit. |

Public artifacts preserve structured field names and redact sensitive values:
known keys/signatures/raw bytes/capabilities/auth values and endpoint secrets,
while retaining public calldata/hashes/revert bytes. `node examples/<case>.ts
--resume <recovery-dir>` reloads the owner-only exact plan, retained economic authorization
provenance, original mode/confirmations/restrictions and typed original inclusion references.
Fresh `planLaunch` (never preparation/mining) re-admits that commitment.
Canonical Preparing/Ready runs only the remaining build-next sequence; canonical
Active recovers the retained activation receipt and performs verification and
publication only. Missing/unconfirmed, moved/reorged or replaced receipt evidence
and unresolved signed hashes stop for read-only reconciliation, never replay.
The API session is refreshed while retaining its one-time capability. A pending
image requires the original `EXAMPLE_IMAGE_PATH` bytes and signed SHA-256/type/length;
only expired PUT responses (403/410/412) permit one upload-URL renewal/retry.
Existing chain verification and every publication canonicality barrier remain required.
Never reload redacted `plan.json` as the commitment. See
[recovery instructions](../examples/README.md#evidence-and-failure-recovery).
Configuration, admission, broadcast, publication and interruption failures exit
nonzero and preserve evidence. No source rollback, cancellation, broadcast retry or
relaunch occurs.
Inspect retained transaction hashes before deciding to run a new case after an
ambiguous send. `test/launch-example.test.mjs`, `test/launch-example-matrix.test.mjs`,
`test/launch-example-mode.test.mjs` and `test/launch-example-resume.test.mjs` cover offline
financial bounds, funding/rounding, quote/admission, signing/retention/config, default
dry-run/no-signing/banner/command, broadcast routing and resume boundaries,
not actual chain/API proof. The older independent whole-graph local
Solidity-exported proof remains separate.

## Real HTTP API integration

The opt-in suites use `LaunchApiClient` and actual HTTP requests—not a mocked transport.
They do not start a service or provision storage. Configure an abyss-api service with:

- `/api/v1/launch-upload-sessions` and its capability-protected read route;
- real application PostgreSQL storage with launch-upload-session migrations applied;
- an enabled request chain matching `LAUNCH_API_TEST_CHAIN_ID`;
- its current launch verifying contract matching `LAUNCH_API_TEST_ORCHESTRATOR`.

For the actual abyss-api service, that verifying contract is the configured deployment
`contracts.launchFactory` field, which must contain the current orchestrator address.
The signed attribution domain is `Abyss Launch Attribution`, version `1`. Session signature
deadlines must be future timestamps at most 15 minutes away. Metadata hashes use canonical
NFC/trimmed text, normalized URLs, fixed field order, and null absent optional values.

| Environment | Meaning |
| --- | --- |
| `LAUNCH_API_TEST_URL` | Required HTTP service root, e.g. `http://127.0.0.1:18763`; no implicit production target. |
| `LAUNCH_API_TEST_CHAIN_ID` | Defaults to `4663`; must be configured on the test service. |
| `LAUNCH_API_TEST_ORCHESTRATOR` | Defaults to `getAddresses(4663).launchOrchestrator` (October8 mined graph); must match the service's signing domain. |
| `LAUNCH_API_TEST_PRIVATE_KEY` | Required only for the explicit signed suite; disposable EOA key, never a production key. |

```sh
# Read-only capability/error boundaries; no key and no storage writes.
LAUNCH_API_TEST_URL=http://127.0.0.1:18763 pnpm test:api

# Signed metadata-session writes, allowed only on an owned disposable loopback service.
LAUNCH_API_TEST_URL=http://127.0.0.1:18763 \
LAUNCH_API_TEST_PRIVATE_KEY="$DISPOSABLE_TEST_PRIVATE_KEY" pnpm test:api:write
```

The write suite creates metadata-only sessions, reads persisted normalized metadata,
replays the byte-identical signed body without reissuing the one-time capability, refuses a
changed authorized payload under the same idempotency key, and checks capability isolation.
It also rejects wrong signers, wrong orchestrator/chain domains, altered metadata, a changed
idempotency key, expired authorization, and invalid signatures. The private key signs EIP-712
metadata only; it need not have a balance. Unique session/key/nonces permit repeat runs.
The disposable service operator owns database cleanup; the API has no session-deletion route.

Neither suite needs an image store, indexed launch, confirmed transaction hash, or chain
write. Metadata sessions do not prove token deployment, image publication, or transaction
indexing. Image/upload/publication operations require those additional real prerequisites
and are not exercised here. Explicitly selected suites fail on missing URL/key, absent
storage/routes, an unreachable service, or incompatible signing configuration instead of
silently skipping. Ordinary `pnpm test` stays offline and does not select HTTP integration.
