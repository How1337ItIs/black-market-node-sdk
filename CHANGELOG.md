# Changelog

## 0.14.0

- Pin one RPC L2 header and batch same-block planning reads/native balances into one explicitly pinned chain4663 Multicall3 stage, even for fewer than three getters. Never derive L2 pins from EVM `BLOCKNUMBER`/`BLOCKHASH`, which expose L1 values on Nitro.
- Retain successful Multicall3 code attestation, Nitro backend capability and per-account code observations for the caller's session. Financial state, receipts, nonces and exact execution remain fresh.
- Keep one planning pin through hook mining and buy calibration. Remove final source-chain/canonical re-reads and the redundant exact-gas replay after final validated measurement.
- Estimate Nitro poster allocation only for the immediate final transaction, once. Build-next recompiles the next determined command from receipt/progress, original batch spans, allowance and nonce, then simulates only that command.
- Use the deployed HookSaltMiner `findMany` for pool-bound preparation and verify returned CREATE2 salts locally. Preserve the public local miner for deployments without a miner preset.
- Add optional `LifecycleDeploymentPreset.launchLens` and `launchLensAbi` integration for dependent reads and mining in the initial aggregate. The preset remains unset until deployment; setting its address enables the path.
- Preserve launch economics, deployed contract ABIs and committed transaction calldata.
- Diagnostic migration: remove `simulation.replay` and `simulation.envelope` from `LifecycleDiagnosticStage` listeners/exhaustive switches. Both stages are replaced by `simulation.measure`, which now includes the authoritative validated execution at the exact returned gas envelope. Buy calibration or an unvalidated sizing pass can also emit `simulation.measure`; neither is execution admission.
- Staged admission still checks the full simulated sequence for feasibility, using conservative suffix gas budgets bounded by the pinned balance. Only the immediate command receives a final exact gas/price estimate and admission. Later `simulation.steps` have `provisional: true` and no estimate; their transaction gas/price/estimate/admission stay unset until `buildNextTransaction` re-sizes and proves that command with a fresh poster quote. Never reuse a provisional `gasLimit` as a transaction estimate.

## 0.13.0

- Finalize each lifecycle invocation with one fresh source-chain guard and one canonical check per used proof pin, including after optional submission estimation. Reuse the initial chain observation for nested hook metadata/discovery, one fee recommendation per operation, and known immutable factory predictions across construction/execution pins.
- Aggregate only caller-independent Nitro getters, known token prediction and known-core head progress on chain4663. Attest the pinned Multicall3 runtime before using it; poster quotes, funding, account state and execution simulations remain direct and pinned.
- Coalesce receipt observed/inclusion headers across references after all asynchronous receipt-identity reads. Preserve replacement attribution, confirmation depth and reorg refusal.
- Add `LifecycleFinalEnvelope` and `prepareAndPlanLifecycleLaunch({ fixedFinalEnvelope: { gas, gasPrice? } })` for one immediate atomic command without approvals. Freeze one operation fee if omitted and validate exact final protected calldata without gas rediscovery, fee increases or envelope rescue.
- Return explicit nonces with proved commands and bind supplied reviewed nonces during replay/submission estimation. Document `planned.transactions[0]` as the exact reviewed envelope, not reusable admission. Preserve fresh pending nonce/balance and final source-chain guards in the example signer even when a held nonce is supplied.
- Add per-entrypoint counting-transport budgets and exact-envelope/aggregation/canonical regressions. No signing, broadcast or publication behavior is added.
- Rewrite launch guidance around pricing, execution, publication, and recovery; split detailed SDK reference from the launch tutorial. Correct WETH wrapping, conversion deadlines, and runner resume instructions.

## 0.12.0

- Add opt-in UFG treasury launches through the pinned Robinhood proxy, including principal-namespaced nonces, exact proxy funding approvals, atomic/staged/cancel builders and proxy-aware planning, simulation and canonical recovery. Existing core launch paths and defaults are unchanged.
- Add frozen `V4UfgFixedPool` / `V4UfgDynamicPool` presets generated from registry readback at block 94,551,140. Verify and reuse the existing byte-identical fixed and zero-royalty dynamic hook creation code.
- Add `UfgLaunchConfig`, canonical dynamic-tuple codecs/hash, typed config6 `ufgLaunchConfig` tails, exact fee-asset policies and offline proxy-rule validation. Support native Abyss QUOTE/QUOTE_ORACLE and UFG quote-only V4 with zero LP fee.
- Export complete proxy, treasury-factory and upstream factory/treasury ABIs plus `readUfgTreasury`. Include independent Foundry ABI vectors, registry evidence, public-API fork integration and an unsigned configuration example.

## 0.11.0

- Size HMM V2 atomic/activation gas with one forwarding reserve (`4,250,000 + 500,000 × (HMM markets − 1)`) in addition to measured gross gas. Clamp reserve/headroom targets to legal compute and total-envelope caps instead of refusing optional padding; exact signed-envelope replay remains mandatory.
- Greedily pack staged preparations using 14.5M per HMM V2 market and 16M per other market. Split only a packed batch whose measurement fails after using at least 95% of its envelope, including CREATE-wrapped `DeploymentFailed`. Remove the misleading `PlannedLaunch.preparationBatchSize`; inspect exact transaction spans instead.
- Default Robinhood's aggregate simulation gas-used budget to 50M (`limits.maxSimulationGas`). Prove the longest estimated prefix and expose `simulation.deferredTransactionIds`; deferred commands have no gas, price, estimate or admission. Proved/admitted flags describe the prefix, not eventual activation. Build-next refreshes proof as canonical progress advances.
- Replay a reviewed immediate envelope directly at its held gas/price, without a new measurement, gas-price/poster recommendation or suffix replay. Preserve identity, deployment, nonce/receipt/confirmation, native Nitro, balance and canonical-state checks; allow at most one legal-envelope rescue for genuine OOG on newly sized envelopes.
- Refuse buy-slippage calibration when activation outputs lie beyond proof coverage; update lifecycle documentation, unsigned examples and focused offline regressions. No new signing or broadcast behavior.
- When no simulation prefix fits, report an immediate estimated per-transaction compute overflow before the RPC aggregate-budget diagnostic, with concise one-decimal-million gas estimates. Conservative estimates alone do not reject otherwise provable envelopes.

## 0.10.0

- **Breaking HMM-only cutover:** generic HMM types, helpers and profile keys now select the admitted HMM V2 release. Remove HMM V1 preset identities, creation metadata and versioned hook keys; use `KnownLifecycleHook.HmmFixedPoolV2` / `HmmDynamicPoolV2`. Non-HMM V1 APIs are unchanged.
- Encode/decode the exact 512-byte V2 launch tail. Require explicit `maxBidQuote` (positive, at most uint128 max) and `referenceDeviation` (nonnegative int24) in `defaultHmmLaunchConfig`; preserve all other existing calibration defaults. Old 448-byte HMM tails are rejected.
- Replace both HMM admission envelopes, adapters, full dependency graphs and creation code with preserved V2 evidence. Keep the 640-byte constructor and canonical zero-salt config6-prefix economics hash; the full plan hash binds the auxiliary tail.
- Export full `hmmLiquidityManagerV2Abi`, `hmmFeeCollectorV2Abi`, `hmmFeeCollectorFactoryV2Abi`, `hmmFixedHookV2Abi` and `hmmDynamicHookV2Abi`, including all strategy configuration, pause and fee-owner/share controls. V2 funds the strategy per swap in both currencies after treasury, without an HMM burn.
- Migrate documentation/examples and independent contract vectors; add old-tail/guard rejection, exact admission, two-chunk graph certification and constructor/mining coverage. SDK support removal does not deregister existing onchain HMM V1 markets.
- Keep the full offline example-test and CLI-child coverage runnable on Node 20/22/24 with a test-only loader backed by the existing TypeScript dev dependency; no production dependency or example-runtime change.

## 0.9.1

- Add the canonical Abyss 0.01% fee tier (`feePips: 100`, `tickSpacing: 1`) to recipes and lifecycle topology planning.
- Cover both token orderings, spacing-one boundary tails and lifecycle admission without changing existing tiers or launch defaults.

## 0.9.0

- Add frozen Robinhood mainnet HMM Fixed and HMM Dynamic pool presets with their exact admitted profile, adapter, envelope, dependency graph and hash-verified constructor creation code.
- Add typed `HmmStrategyConfig` / `HmmLaunchConfig`, `encodeHmmLaunchTail`, `decodeHmmLaunchTail`, `validateHmmLaunchConfig` and calibrated `defaultHmmLaunchConfig` helpers.
- Append the required 448-byte HMM launch tail automatically in the config6 codec; reject missing/invalid tails and preserve them through planning, salt mining and recovery. Match the collector factory's prefix-only hook economics commitment while binding the full tail in the launch-plan hash.
- Add independent Foundry ABI fixtures, validation and fixed/dynamic plan tests, a pure configuration example and consumer documentation. Existing preset selections and fixed launch examples remain unchanged.

## 0.8.1

- Add the zero-author-royalty Dynamic Fee Hook preset (`V4DynamicFeePool`) with explicit config6 minimum, maximum, and sensitivity; require zero LP fee.

## 0.8.0

- Require continuous opening-to-boundary position coverage for unstarted plans; enable permanent tails by default. Replace `staircaseBoundaries` with `positionGaps`.
- Default launch wrappers to unsigned dry-run; require `--broadcast` for writes and use `--resume` to retain the original plan, receipts, and metadata session.
- Add opt-in `createLifecycleSessionCache` for static reads at one canonical block; financial state and execution proof stay live.

## 0.7.1

- Add frozen deployment/profile selectors and transaction-first construction. `prepareAndPlanLifecycleLaunch` prepares salts and proves the selected mode; `buildLaunchTransactions` compiles unsigned commands.
- Add ordered-buy output calibration with `buySlippageBps`, budget-funded range presets, exact position/market allocation checks, and pre-buy burning of unused launch inventory.
- Add immediate reviewed-envelope replay through `buildNextTransaction({ reviewedTransaction })`, retaining exact gas and gas price.

## 0.6.3

- Reduce profile-certification dependency rounds and duplicate RPC reads; overlap independent work on batching-capable clients while retaining registry and graph checks.

## 0.6.2

- Add opt-in `LifecycleRpcClient.onDiagnostic` timing events for planning, RPC queueing, certification, and simulation. Events omit request payloads and secrets.

## 0.6.1

- Add opt-in `supportsReadBatching`, bounded to eight concurrent SDK reads per invocation, and invocation-local reuse of identical pinned reads. Default clients remain serial.
- Skip V4-only metadata reads for Abyss-only plans; preserve required reads for selected V4 profiles.

## 0.6.0

- Separate `executionProof`, `protocolFit`, and `transportPreflight`. Robinhood admission requires native Nitro compute/poster evidence and exact sequential replay.
- Add read-only immediate transaction preflight through `buildNextTransaction({ submissionClient })`; optional caller limits tighten admission.
