# Issue #21: conservative activation admission correction

This change does **not** enable a canonical sixteen-market launch. It restores conservative per-market accounting so the public failing case is refused before funding/begin. Actual contract activation still needs an independently verified fix or a proven fitting recipe.

## Evidence and rationale

- Upstream baseline: `cedf9587767f2da2b63041fd5bf5e29eeebeed86` (fetched `origin/main`). The different historical token `cedf9587767f2da2b63041fd5bf5e29ebeed86` is not the verified source hash.
- Public case: https://github.com/abysshopper/black-market-node-sdk/issues/21
- Public unsigned fixture: https://gist.github.com/How1337ItIs/daf1bec51f78b821297ce60a00bb578c
- Exact unchanged fixture SHA256: `547b928cf2eac4b30493018486805bba0b7d72b32b4f1233c5357dd9bc10878f`.
- Fixture: seven V4 and nine Abyss markets, one position each, eight fee assets, no opening buys, NFT, reward, HMM or compound features.
- Public reproduction reports all nine prefix commands succeeding, then activation reverting after consuming 31,991,297 gas under the native 32M envelope; active remains false. Synthetic balance diagnoses mechanics only. This is retained public evidence, **not a new live execution performed for this patch**, and failed gas consumed is **not** a measured minimum successful envelope.

`0b29ca26bb73c2cece0af47f239ce34a8c7266cf` changed capacity-v2 to v3. It halved the per-market allowances from 1M to 0.5M for Abyss and 0.5M to 0.25M for V4 while citing primarily position-depth observations. The actual public breadth case produces a 29,571,520 budget, so that reduction demonstrably loses the intended conservative admission property.

Restore only those earlier per-market allowances, keep the current per-position rates, and version the model as capacity-v4. This is a conservative rollback of a falsified breadth extrapolation, **not** a new fit to successful measurements. No market-count blacklist, quote-token allowlist, cap inflation, simulation fallback, gas-envelope change or economics mutation is introduced. All market shapes receive the same per-market correction. Other unmeasured combinations can still exceed this empirical model; this is not a universal upper-bound proof.

## Path tracing

- `gas-profile.ts`: `capacityBasis` sums per-call, per-market, per-position, hook, buy, NFT, calldata and fee-asset budgets; `deriveLifecycleLaunchCapacity` applies at least 25% padding and HMM reserve.
- `planner.ts`: `selectLaunchMode` always stages multiple markets; `orderedTransactions` compiles begin/preparation/activation. Staging cannot split activation.
- `transactions.ts`: preparation has separately calibrated full-market costs and deterministic padded packing. Those costs and returned native envelopes are unchanged.
- `assessLifecycleTransactions` compares the activation compute bound plus poster allocation against the native total ceiling and returns `ACTIVATION_GAS_LIMIT` before admitting begin. Existing build-next tests verify that refusal also blocks continued execution.

The corrected canonical16 compute budget is **37,384,020** before poster allocation, versus the prior **29,571,520**. Both are model outputs, not execution measurements.

## Test-first receipts

Environment: Windows, Node `v24.22.1`, installed pnpm `9.15.9` (repository declares `10.11.0`); frozen-lockfile install succeeded.

1. Clean baseline `pnpm test`: exit 1, 479 tests, 436 pass, 42 fail, 1 skipped. Log: local `baseline-suite.log`.
2. `pnpm typecheck` on baseline: exit 0. Baseline suite's `pnpm build`: exit 0.
3. Added exact public fixture plus `test/lifecycle-canonical16.test.mjs` before production edits.
4. RED: `node --import ./test/register-typescript.mjs --test test/lifecycle-canonical16.test.mjs`: exit 1, 1 failed, expected assertion explicitly prints the deficient 29,571,520 bound. Log: local `red.log`.
5. After rollback: `pnpm build` and `pnpm typecheck`: both exit 0.
6. GREEN focused: `node --import ./test/register-typescript.mjs --test test/lifecycle-canonical16.test.mjs test/lifecycle-execution.test.mjs`: exit 0, 40/40 pass. Log: local `green-focused.log`.
7. `pnpm test` after patch: exit 1, 480 tests, 437 pass, **same 42 failures**, 1 skipped. Failure-name sets programmatically compared: no added or resolved failures. Log: local `green-suite.log`.

Existing baseline failures include Windows permissions (`EPERM`), recovery-file security checks and platform path quoting in example tests. They are not made green by this narrow patch. Offline fixtures in existing tests are not public chain execution evidence. No API integration or live signing/broadcast test was run; no private keys accessed.

## Limits

This patch corrects a demonstrated unsafe admission regression, not the contract's gas root cause. Restored earlier allowances have not been calibrated against a new successful sixteen-market native activation. Additional false positives/false negatives remain possible. No funding, signing, broadcast, API publication, push or PR creation is authorized or performed by this work. The parent owns publication decisions and the complementary contract investigation.
