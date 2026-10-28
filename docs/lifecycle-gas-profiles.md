# Lifecycle gas, execution evidence and RPC budgets

Version 0.15.0 distinguishes a measured execution proof from a conservative template gas profile. Neither a submitted hash nor a local curve quote is an execution receipt.

## Which path runs

| Command | Covered, directly funded plan | Plan containing a swap conversion |
| --- | --- | --- |
| Approval/reset | Profile | Profile when isolated as the immediate command |
| Begin | Profile | Exact native execution of the conversion |
| Prepare markets/hooks | Profile | Profile when built after begin |
| Activate and opening buys | Profile and exact local curve math | Exact native execution, including consumption of conversion funding |
| Atomic launch | Profile and exact local curve math | Exact native execution of the complete transaction |
| Cancel | Profile | Profile when isolated as the immediate command |

A conversion review proves the complete staged sequence through activation in one validated `eth_simulateV1` call. It does not admit begin from a successful prefix. A refused full review cannot authorize an unstarted `buildNextTransaction`; already-started recovery and cancellation remain available.

Unknown template/currency coverage, another chain or ArbOS epoch, or an empirical bound that exceeds the available envelope falls back to native execution. An over-conservative profile is not evidence of onchain impossibility. `simulateLaunchPlan` explicitly requests real execution even for a covered plan. Generic EVM fork results are not Nitro protocol proof.

### Honest result fields

- Profile: `backend: "profiled"`, `confidence: "profiled"`, `executionProof: "not-run"`, `protocolFit: "profiled"`, with `gasProfile` evidence and optional `initialBuys` quotes. No execution receipts or fabricated `gasUsed` are created.
- Exact native execution: `backend: "eth_simulateV1"`, `executionProof: "proved"`, `protocolFit: "proved"` after successful validated execution and required postconditions.
- `LifecycleTransactionEstimate.gasUsed` is optional. Profile fees use `feeConfidence: "profiled-execution-and-data"`.
- Only the immediate command receives final gas/price/estimate/admission. Suffix steps are provisional feasibility budgets, not executable envelopes. Each next-step build sizes only the canonical immediate command at its fresh pin.

`admitted` with profiled evidence means conditional template admission, not that external state was executed. Consumers must retain the distinction in economic review and must not require a simulated receipt to display an independently exact local quote.

## Profile coverage and evidence

`robinhood-4663-arbos61-v1` covers the shipped Abyss configuration-v1 and current pool-bound V4 configuration-v6 templates, including fixed/dynamic fees, HMM and UFG, on ArbOS 61 with an EOA payer and the release's known quote implementations. The frozen currency set is gas coverage, not a token-admission allowlist; other currencies remain supported through exact execution. Smart-account execution is not claimed by the EOA profile.

The component model reserves creation and reward-mode costs, separately rounded UTF-8 metadata storage, calldata, fee policies, funding, each market/position, traversed bitmap words and initialized ticks, and ERC404 token-to-NFT mint work. The default 15% headroom is applied to the compute basis. HMM reserves both full isolated 3M hook budgets and the EIP-150 forwarding target rather than treating receipt `gasUsed` as the minimum envelope. Native getters still provide the compute/complete ceilings; there is no hard-coded chain-wide replacement for them.

Research retained 176 lifecycle receipts, including 75 successful current-template atomic/activation observations with opening buys. Isolated-fork cases extend position depth, ordered buys and template combinations; failed CREATE2 configurations were not counted as successful coverage. Native-versus-fork calibration for one Abyss and one fixed-V4 historical atomic launch matched compute exactly (19,272,603 and 18,130,251 gas), while their observed minimum successful envelopes were higher (20,527,230 and 19,356,279). These two calibrations do not establish general Anvil/Nitro equivalence. Compute and L1 poster components remain separate.

Profiles are versioned empirical bounds with generous component margins, not a proof about arbitrary token upgrades or future chain execution rules. A new ArbOS epoch requires fresh coverage or uses native execution. A deeply positioned launch that exceeds a conservative bound is simulated rather than automatically partitioned or refused.

## Exact ordered opening-buy math

`computeLifecycleOpeningBuys({ plan, predictedToken })` models the supported fresh launch curves with integer arithmetic. It follows all supplied liquidity bands in order, prior buys, initialized zero-net ticks, bitmap-word boundaries, both currency directions, LP and opening hook fees, partial fills and exact-output floors. HMM opening work occurs after the initial buys. V4's zero price-limit sentinel is resolved locally to its contract-defined directional limit; encoded calldata is unchanged. Abyss still rejects zero.

Preparation uses this model for covered `buySlippageBps` protection: `floor(tokenOut * (10000 - bps) / 10000)`. A zero floor is rejected, never replaced with 1. Unknown curve behavior retains native diagnostic calibration. Any external conversion and the activation consuming it still receive exact execution of the final commitment.

Independent parity checks matched token output, quote spent and final square-root price on 97 native/fork cases, including both directions, overlapping bands and gaps. Portable historical vectors and focused rounding/sentinel cases are committed under `test/fixtures/lifecycle-opening-buys.json` and `test/lifecycle-opening-buys.test.mjs`. These quotes are conditional curve results, not evidence that funding, conversion or a wallet submission succeeded.

## One same-review Nitro price observation

The initial explicitly L2-pinned Multicall3 stage includes `ArbGasInfo.getPricesInWei` alongside the lens/current-state reads. There are no per-transaction `NodeInterface.gasEstimateL1Component` calls and no separate `eth_gasPrice` on 4663. Price tuple element 1 is the per-L1-calldata-byte price; element 5 supplies the L2 gas-price recommendation. A held fee remains exact; a new recommendation is at least twice the pinned base fee.

For an empty-access-list EOA legacy envelope with calldata length `D` bytes:

```text
N = D + 384
B = N + 8 * floor(N / 1024) + 64
posterFeeBound = B * l1PricePerByte
posterGas = 2 * ceil(posterFeeBound / l2GasPrice)
```

The serialization reserve and Brotli expansion allowance bound the local payload, and the 2x allocation supplies price/compression margin. This is not an observation of the eventual signed compressed transaction and does not guarantee future L1 prices. `posterGas` is inside `gasLimit`; `posterFee` must not be added again. `dataFeeIncludedInGas` is true, `dataFee` is zero and `totalFee = gasLimit * gasPrice`.

Conversion-carrying begin/atomic commands use the pinned native compute ceiling, not an invented router allowance. The single validated pass executes the exact returned immediate envelope. Held gas and price are never increased to rescue a refusal. If no measured/profile sizing exists, native discovery retains one unvalidated sizing pass and at most one funds-only equal-budget retry before final validation. Tight balances may still receive `failureCategory: "affordability"` although smaller exact envelopes could fit; a top-level refusal exposes no successful-prefix observations to invent. There is no SDK-invented 50M aggregate window or successful-prefix admission. An explicit caller `maxSimulationGas` remains a policy ceiling; incomplete sequence proof refuses admission.

## 0.15.0 caller migration

- `LifecycleTransaction` no longer has a wallet nonce. The plan's `LaunchPlanV1.nonce` is still its unchanged domain identity salt. Send the returned `from/to/data/value/gas/gasPrice` and let the wallet assign its transaction nonce.
- Learn the actual nonce from the submitted transaction or wallet response, retain it locally, and advance the wallet-owned next nonce from that observation. `LifecycleReceiptReference.nonce` and receipt status `nonce` optionally hold this exact `bigint`; a supplied mismatch refuses attribution. Portable journals use unsigned decimal strings, not JSON numbers.
- Progress no longer exposes confirmed/head/pending account nonce fields. `confirmationSafe` concerns canonical progress and the retained receipt policy, not whether the account has unrelated pending transactions. The wallet queues after those transactions. Planning and build-next issue no `eth_getTransactionCount`; unknown reload state may require one host-owned recovery read, not a per-review gate.
- `BuildNextTransactionOptions.submissionClient` and proof `transportPreflight` are removed. Sending-RPC preparation is the wallet's responsibility. Keep wallet account/provider-chain checks and never automatically replay an ambiguous write.
- Chain identity is observed at most once per bound client object. Retain the client across calls; construct a new client on a wallet/chain switch. `sessionCache.invalidate()` does not turn a client into a different chain. SDK correctness must not depend on another fresh `eth_chainId` guard.
- Economic review schema v2 labels `simulated-execution` and `local-exact-curve` separately. Use `initialBuy.reviewedBuys`, not assumed native receipt fields. Never describe a local quote as actual execution.
- The old `transactionGasEstimate` heuristic is removed. Consume the immediate planned estimate or explicit gas-profile evidence instead. `preparationGasEstimate`, `packPreparationBatches` and unsigned command compilation remain public.

## Observed recording-transport budgets

The same historical plans and explicit 200M aggregate policy were replayed against an outbound-recording transport. It supplies deterministic block/state/execution responses and is not live admission. Both prepared plan commitments stayed unchanged. Counts exclude wallet preparation/send, receipt polling, and supplied-reference receipt/transaction/canonicality reads; those vary with retained references and confirmation policy.

| Case | Version | Prepare/review | Each build-next | Prepare + first build | Prepare + all builds |
| --- | --- | ---: | ---: | ---: | ---: |
| Conversion-funded historical plan (`0xf05…fe98fe98`, four builds) | 0.14.1 | 12 | 8 | 20 | 44 |
| Same conversion plan | 0.15.0 | 8 | 3 | 11 | 20 |
| Direct NativeWrap historical plan (`0x4cbc…85231`, three builds) | 0.14.1 | 12 | 8 | 20 | 36 |
| Same direct plan | 0.15.0 | 5 | 2 | 7 | 11 |

The conversion case intentionally retains seven native simulation RPCs across review and all fresh builds because its historical currencies are outside current profile coverage. The covered direct case drops six simulation RPCs to zero. Both cases issue one chain read total and zero account-nonce, separate gas-price or per-transaction poster-oracle reads. Cold preparation includes session code/capability costs; warm counts must not be presented as cold totals. These SDK-only figures are not whole-application launch telemetry.
