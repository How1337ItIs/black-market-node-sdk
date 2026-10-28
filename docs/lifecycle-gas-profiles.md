# Lifecycle gas, capacity, execution evidence and RPC budgets

Version 0.15.0 separates the native transaction ceiling, conservative capacity bounds, exact curve quotes and actual execution proof. A local quote or submitted hash is not an execution receipt.

## One native ceiling, not component-sized gas

Every launch command (begin, prepare, activate, atomic and cancel) uses the chain's native total transaction ceiling. On Robinhood4663 this is `ROBINHOOD_NATIVE_TRANSACTION_GAS_LIMIT = 32_000_000n`, also exposed as `getKnownLifecycleDeployment({ chainId, orchestrator }).nativeTransactionGasLimit`. The32M includes poster gas. Other chains retain their resolved generic ceiling.

Unused gas is refunded. The payer must still reserve `value + gasLimit * gasPrice` upfront. The SDK never shrinks the ceiling to accommodate a tight balance, adds poster gas to32M, or retries with a smaller envelope. Approvals/reset approvals are not launch steps: their returned `gas`, `gasPrice` and estimates are omitted for wallet preparation.

A reviewed launch gas differing from the ceiling is stale and refuses with `STALE_REVIEWED_GAS`; re-review rather than silently rewriting it. A caller complete-envelope cap below the ceiling refuses too. `fixedFinalEnvelope`, `LifecycleFinalEnvelope`, stored compute-sizing hints and unvalidated gas-sizing retries are removed.

## Capacity selects the mode, not the gas limit

`computeLifecycleLaunchGasBounds({ plan, predictedToken, ufg?, headroomBps? })` returns conservative `atomicComputeGasUpperBound` and `activationComputeGasUpperBound`, excluding poster gas, or undefined for unknown coverage. The versioned model accounts for token/reward creation, actual UFG proxy/treasury route, market/position work, ordered buys, NFT minting and HMM forwarding overhead. UFG route overhead is independent of market profile names.

An atomic request is a preference. A conservative atomic bound plus poster allocation above the ceiling selects staged; explicit staged remains staged. An actual atomic capacity failure can also select staged with fresh full-sequence admission. Review and persist returned `planned.mode`, not the requested mode. No positions, markets or buys are dropped.

A large conservative activation upper bound is uncertainty, not proof of overflow. Uncertain activation receives exact full-sequence execution before begin. An actual activation capacity failure returns `capacityConstraint: "activation"` and asks the user to reduce positions/pools; staging cannot split activation. For example, an independently observed24-position activation fit32M despite a larger conservative upper bound, while a32-position deep Abyss activation needed a47.48M minimum successful envelope. Neither observation licenses a universal count-only hard cap.

## Which admission path runs

| Command | Covered direct plan with proven-fit activation | Plan containing an aggregator conversion |
| --- | --- | --- |
| Approval/reset | Wallet prepares gas/fees | Wallet prepares gas/fees |
| Begin | Conditional template admission | Exact native execution of the conversion |
| Prepare markets/hooks | Conditional template admission | Conditional admission when isolated after begin |
| Activate and opening buys | Conditional admission and exact local curve math | Exact native execution consuming conversion funding |
| Atomic launch | Conditional admission and exact local curve math | Exact native execution of the complete transaction |
| Cancel | Conditional admission | Conditional admission when isolated |

A conversion review proves the complete staged sequence through activation in one validated `eth_simulateV1` call, with every launch call at32M. Unknown template/currency coverage, another chain/ArbOS epoch or uncertain activation also uses real execution. A refused full review cannot authorize a new begin from a successful prefix; already-started recovery and cancellation remain available. Explicit `simulateLaunchPlan` always requests execution. A generic EVM fork is not Nitro protocol proof.

Unknown curve behavior retains a separate provisional, unvalidated buy-output diagnostic at the same ceiling before protecting minima. It is not gas sizing, final admission or a retry. The final protected commitment still requires its exact execution. There is no SDK-invented50M aggregate window; explicit `maxSimulationGas` policies remain enforced against complete observed work without prefix admission.

### Honest result fields

- Conditional admission: `backend/confidence: "profiled"`, `executionProof: "not-run"`, `protocolFit: "profiled"`. `gasProfile` carries `version`, capacity `bounds` and local `initialBuys`, not per-step estimates or fabricated receipts.
- The immediate fixed-ceiling budget is `simulation.estimate`, with `feeConfidence: "native-ceiling-and-data"` and no invented `gasUsed`. Approval budgets are absent.
- Successful exact native execution reports `backend: "eth_simulateV1"`, `executionProof: "proved"`, `protocolFit: "proved"` after required postconditions.
- Only an immediate launch command receives final gas/price/estimate/admission. Exact suffix steps remain `provisional: true` with no executable estimate. Build-next constructs only the canonical next command at a fresh pin; it never treats a suffix observation as an estimate.

## Retained empirical evidence

`robinhood-4663-arbos61-v1` covers shipped Abyss configuration-v1 and current pool-bound V4 configuration-v6 templates, including HMM/UFG, on ArbOS61 with an EOA payer and known release quote implementations. This is capacity coverage, not a currency admission allowlist. Unknown currencies remain supported through exact execution; smart-account proof is not claimed.

Research retained176 lifecycle receipts, including75 successful current-template atomic/activation observations with opening buys. Isolated forks extend depth, buys and combinations; failed CREATE2 cases were not counted as successful coverage. One Abyss and one fixed-V4 historical native/fork calibration matched compute exactly (19,272,603 and18,130,251 gas), while minimum successful envelopes were higher (20,527,230 and19,356,279). These two calibrations do not establish general Anvil/Nitro equivalence. Compute and poster components remain separate. Profiles are empirical capacity bounds, never transaction gas sizing or proof about arbitrary upgrades/future ArbOS rules.

## Exact ordered opening-buy math

`computeLifecycleOpeningBuys({ plan, predictedToken })` follows all liquidity bands, prior buys, initialized zero-net ticks, bitmap boundaries, both currency directions, LP/opening-hook fees, partial fills and integer output floors. HMM opening work occurs after initial buys. V4's zero price-limit sentinel resolves locally to the contract-defined directional limit without changing calldata; Abyss still rejects zero.

Covered `buySlippageBps` protection uses `floor(tokenOut * (10000 - bps) / 10000)`. A zero floor rejects, never becomes1. Independent parity matched token output, quote spent and final square-root price across97 native/fork cases, including both directions, overlapping bands and gaps. Portable historical vectors and focused rounding/sentinel cases live under `test/fixtures/lifecycle-opening-buys.json` and `test/lifecycle-opening-buys.test.mjs`. These conditional curve quotes do not prove conversion, funding or wallet submission.

## One same-review Nitro price observation

The initial L2-pinned aggregate includes `ArbGasInfo.getPricesInWei`. There are no per-transaction `NodeInterface.gasEstimateL1Component` calls or separate4663 `eth_gasPrice` calls. Tuple element1 supplies L1 per-byte price; element5 supplies L2 price. Fresh gas price is max(L2 price, twice header base fee). A held price must meet max(L2 price, header base fee), but is not bumped to the fresh recommendation.

For empty-access-list EOA legacy calldata of `D` bytes:

```text
N = D + 384
B = N + 8 * floor(N / 1024) + 64
posterFeeBound = B * l1PricePerByte
posterGas = 2 * ceil(posterFeeBound / l2GasPrice)
```

The local serialization/Brotli bound and2x allocation are conservative, not an observation of the eventual compressed signature or a promise about future L1 prices. Poster stays inside32M. `dataFeeIncludedInGas` is true, `dataFee` is zero and `totalFee = gasLimit * gasPrice`; never add poster fee again.

## 0.15.0 caller migration

- Wallet nonce is absent from unsigned `LifecycleTransaction`; `LaunchPlanV1.nonce` remains its domain identity. Let the wallet assign send nonce. Learn actual nonce from wallet/transaction, retain optional exact `LifecycleReceiptReference.nonce`, and advance the wallet-owned queue locally. A supplied nonce mismatch refuses receipt attribution. Portable journals use decimal strings, not JSON numbers.
- Progress has no confirmed/head/pending account nonce gates. Unrelated pending transactions are queued by the wallet, not an SDK confirmation-safety refusal. Planning/build-next make no `eth_getTransactionCount`; unknown reload recovery may need one host-owned read.
- `BuildNextTransactionOptions.submissionClient` and proof `transportPreflight` are removed. Keep wallet account/provider-chain checks and never automatically replay an ambiguous write.
- Retain each bound client; chain identity is read at most once per client object. Recreate the client after wallet/chain changes. Cache invalidation does not repoint an existing client to another chain.
- Persist selected `planned.mode`. Handle approval envelopes without gas/fees, `STALE_REVIEWED_GAS`, actionable activation capacity refusal, optional `simulation.estimate` and capacity-only `gasProfile.bounds`. Remove `gasProfile.estimates` and `computeGasRequired` usage.
- Economic review schema v2 separates `local-exact-curve` from `simulated-execution`; consume `initialBuy.reviewedBuys`, not assumed receipt fields. `transactionGasEstimate` is removed; unsigned compilation and preparation packing remain available.

## Observed recording-transport budgets

The same historical, already-protected plans and explicit 200M aggregate policy use deterministic recording-transport block/state/execution responses, without requesting buy recalibration. This is RPC counting, not live admission. Both commitments remain unchanged. Counts exclude wallet preparation/send, polling and supplied receipt/transaction/canonicality reads, which vary with confirmation policy.

| Case | Version | Prepare/review | Each build-next | Prepare + first build | Prepare + all builds |
| --- | --- | ---: | ---: | ---: | ---: |
| Conversion historical plan (`0xf05…fe98fe98`, four builds) | 0.14.1 | 12 | 8 | 20 | 44 |
| Same conversion plan | 0.15.0 | 7 | 3 | 10 | 19 |
| Direct NativeWrap historical plan (`0x4cbc…85231`, three builds) | 0.14.1 | 12 | 8 | 20 | 36 |
| Same direct plan | 0.15.0 | 5 | 2 | 7 | 11 |

The conversion case retains six native simulation RPCs across review/builds because its historical currencies are outside capacity coverage: one session capability, one full review and four next-step proofs. The covered direct case drops six simulation RPCs to zero. Both cases have one total chain read and zero account-nonce, separate gas-price or per-transaction poster-oracle reads. Cold costs include session attestations/capability; warm counts are not cold totals. These are SDK-only figures, not whole-application telemetry.
