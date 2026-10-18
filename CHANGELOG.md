# Changelog

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
