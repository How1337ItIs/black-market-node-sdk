# Changelog

## 0.9.0

- Add frozen Robinhood mainnet HMM Fixed and HMM Dynamic pool presets with their exact admitted profile, adapter, envelope, dependency graph and hash-verified constructor creation code.
- Add typed `HmmStrategyConfig` / `HmmLaunchConfig`, `encodeHmmLaunchTail`, `decodeHmmLaunchTail`, `validateHmmLaunchConfig` and calibrated `defaultHmmLaunchConfig` helpers.
- Append the required 448-byte HMM launch tail automatically in the config6 codec; reject missing/invalid tails and preserve them through planning, salt mining and recovery. Match the collector factory's prefix-only hook economics commitment while binding the full tail in the launch-plan hash.
- Add independent Foundry ABI fixtures, validation and fixed/dynamic plan tests, a pure configuration example and consumer documentation. Existing preset selections and fixed launch examples remain unchanged.
