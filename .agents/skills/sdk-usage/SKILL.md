---
name: sdk-usage
description: Integrate the Abyss TypeScript SDK using the correct deployment graph, construction presets, public APIs and live execution authority. Covers protocol reads, unsigned lifecycle planning, swaps and lending.
---

# Use the TypeScript SDK

## Read the right contract

- Read `README.md`, `docs/launch-lifecycle.md` and the installed package's exports.
  Use Node 24+, pnpm, TypeScript ESM and integer base units (`bigint`).
- Consumer imports use `@black-market/sdk`. `@black-market/sdk/lifecycle` is the
  browser-safe lifecycle subpath; general pricing/AMM helpers use the root package.
- Use `createProtocolPublicClient({ chainId: 4663 })`, then verify the RPC chain.
  Resolve infrastructure through `getAddresses(chainId)`, not copied addresses.
  Explicitly configure local chains; never reuse mainnet defaults on a fork/local chain.
- Compare the plan's core, registry, funding escrow and selected profiles with the
  intended release. An old SDK, vendored tarball, environment override or saved plan
  can target an older immutable stack even when the application itself is current.
  A package version or a profile name alone does not prove deployment identity.

## Construct locally; prove against current state

1. Use `getKnownLifecycleDeployment`, `getKnownLifecycleProfile` and
   `listKnownLifecycleProfiles` for shipped profiles and deployment wiring. Profiles
   registered after the SDK release need not appear until the next SDK update.
2. Use `readLifecycleProfiles({ client, orchestrator })` only for explicit live
   registry inspection. Normal planning uses presets and exact native simulation;
   it does not require a registry crawl or redundant admission getter mirrors.
3. Build the complete `LaunchPlanV1`: explicit creator/core/nonce, token behavior,
   fee policies, funding, all markets/positions and ordered buys. Read the sibling
   `token-launch/SKILL.md` and `launch-pricing/SKILL.md` before choosing economics.
4. `buildLaunchTransactions({ plan, mode })` compiles unsigned calldata only.
   It does not prove balances, fees, gas capacity, quote freshness or execution.
5. `prepareAndPlanLifecycleLaunch({ client, account, plan, mode, ... })` combines
   bound-hook salt preparation and selected-mode proof. `planLaunch` proves an
   already-finalized plan. Only review the returned final plan/commitment.
6. `readLaunchProgress`, `simulateLaunchPlan` and `buildNextTransaction` support
   canonical recovery and fresh proof of remaining work. Persist the original plan,
   execution mode, confirmation policy and actual included/replacement hashes.

Do not add a second application-owned mining/admission loop around these operations.
Known presets supply construction wiring; the onchain contracts, wallet and final
exact-calldata simulation enforce execution. Planning has one pin and no final
chain/canonical guard re-reads. Receipt and nonce recovery checks remain.
Do not resurrect `preparePoolBoundLifecyclePlan` or `PlannedLaunch.atomicAttempt`.

Atomic/staged mode is explicit; refusal does not authorize fallback, smaller budgets,
fewer positions, dropped buys or a different hook. Staging partitions preparation,
not final activation. Native Nitro compute/poster-gas evidence is distinct from a
generic local EVM gas measurement. Optional limits tighten policy; never invent a
chain-wide 16M/32M cap from a historical fixture.

## Representation and integration boundaries

- Preserve `bigint` internally and decimal-string wide values in portable plans.
  Use `serializeLaunchPlan` / `parseLaunchPlan`, not lossy JSON numbers.
- A profile selects an implementation and configuration contract, not arbitrary
  executable hook calldata. Config version and topology are not fee-behavior names.
- Quotes, fee assets and direct ERC20/native-wrap funding are not a curated-token
  allowlist. Swap-conversion inputs and target/spender roles have separate registry
  admission; inspect the pricing skill before integrating Kyber.
- Keep pure price/buy estimates, execution proof, RPC submission preflight, wallet
  submission, canonical activation and API publication as separate outcomes.
- Use existing AMM/lending exports and ABIs before writing wrappers. An indexed
  routing candidate is not executable calldata. A successful launch/oracle setup
  is not lending admission: history, liquidity, risk policy and governance remain
  separate. Do not transplant lending-feed cutoffs into launch USD valuation policy.
- Address identity is case-insensitive; use library checksum/normalization helpers,
  not case-sensitive string matching for tokens, pools or deployment bindings.

## Verification and safety

`node examples/quickstart.ts` is a read-only discovery smoke after building.
Repository code changes use `pnpm test` and `pnpm typecheck`; HTTP/chain suites need
their documented disposable services and explicit authorization. For documentation,
execute the documented pure/read-only consumer path, not a funded launch example.

Reads, pricing, mining, simulation and unsigned compilation do not authorize signing,
broadcasting, uploads or metadata publication. A controlled fork must be explicitly
owned/disposable and distinct from the source RPC. Preserve unrelated worktree changes.

The audit's historical decisions and known regressions are in
`../token-launch/references/audit-history.md`; current exports and deployed evidence
override superseded conversations.
