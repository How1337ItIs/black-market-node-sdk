---
name: token-launch
description: Design and execute an Abyss TypeScript lifecycle launch across venues, quotes, positions and admitted hooks. Use for token/reward selection, funding, atomic or staged execution, metadata publication and recovery; read launch-pricing before choosing prices or buys.
---

# Design, launch and recover a token

Read `../sdk-usage/SKILL.md`, `../launch-pricing/SKILL.md`,
`examples/README.md` and `docs/launch-lifecycle.md`. The examples are starting
points, not a restriction to the fixed examples' token/topology combinations.

## Resolve the design before producing calldata

Ask only for unresolved financial/product choices. Reuse supplied intent and
current SDK/config evidence instead of asking for repository-provided information:

- Token name/symbol, supply, ERC20/ERC404 behavior, NFT unit where applicable,
  reward mode and fee assets. Token behavior, fee distribution and pool hook are
  distinct choices; one does not silently imply the others.
- Venue(s), quote asset(s), intended allocation per pool and distribution shape.
  Use plain descriptions: standard fees accrue in both pool currencies;
  quote-only pools direct trading fees into the selected quote currency.
- Desired opening valuation, ordered opening-buy amounts/recipients and payment
  currency. Use the project's $5,000 reference target when none was supplied;
  respect explicit targets/buy amounts. Look up quote prices yourself as part of
  preparation; do not offer pricing as an extra service or ask for a price provider.
- Hook behavior and fee settings from the exact admitted profile, not its name.
  Review royalties, pool fees, oracle and external-liquidity policy separately.
- Explicit atomic or staged execution and the intended metadata/API workflow.

User-facing review should emphasize token, valuation, quotes, inventory allocation,
fees, initial purchases and total funding. Keep implementation digests/raw calldata
in diagnostic evidence rather than making the user manually solve SDK internals.

## Pool topology is not hook topology

| Dimension | Meaning / construction rule |
| --- | --- |
| Position | One tick range and liquidity amount inside a pool; no separate hook per position. |
| Market/pool | One launched-token/quote/venue identity with pool-wide fees/oracle/hook settings. |
| Multi-quote | Distinct pools, each priced from the same whole-token valuation and its quote/USD price. |
| Multi-venue | Abyss and V4 may share a quote but use separate markets and inventory budgets. |
| Bound V4 | One mined, constructor-bound hook instance per pool; current shipped config6/V2 graph. |
| Shared V4 | One admitted multipool root with isolated PoolId state; current codec config4, not a shipped default offering. |

Abyss has four canonical variants: STANDARD, STANDARD_ORACLE, QUOTE and
QUOTE_ORACLE. Choose the exact discovered/preset profile and enabled fee/spacing
combination. Oracle-enabled pools do not automatically qualify for lending.

At most **one V4 market per launched-token/quote**, across hooks, fee tiers and
topologies. Put that quote's V4 positions in one market. An Abyss market may use the
same quote. Example: quotes A/B/C with V4+Abyss each yield six pools, not six hooks;
each V4 pool has one hook and any number of admitted positions.

Bounds are 16 markets, 32 total positions, 8 fee assets, 8 funding outputs and
64 ordered buys. They are structural maxima, not a promise the plan fits gas.
Do not shrink a requested topology to work around a refused atomic plan.

Use `deriveLaunchPositionRanges` for Early Scarcity, Staircase or Smooth Ramp.
Staircase and Early Scarcity preserve source gaps by default; choose
`positionGaps: "adjacent"` explicitly for continuous admission. The final band
extends to the finite protocol-boundary tail by default (`extendFinalRangeToBoundary: true`).
Unstarted planning requires a funded tail and continuous buy-side coverage in every
market. Started/in-flight and terminal recovery skips this creation-policy gate.
Overlap is permitted, not required for continuity.
Anchor/Ladder/Orbit/Rocket/Cruise/Spread/Depth/Bundle are a separate historical
contract allocation catalogue, not accepted `distributionPreset` strings.
Resolve custom bands and their exact inventory weights; do not rename equal-width
tick partitions as a source preset. See `references/audit-history.md`.

## Hook and fee contract

- Select a registered execution profile per market, not an arbitrary hook address.
  V4 has one `hooks` address per pool; combining behaviors requires one compatible
  admitted implementation, not an array of hook addresses.
- Match config schema/version, exact runtime/deployment graph, constructor,
  capabilities, oracle, source custody and author terms. Callback address bits
  alone do not establish compatibility.
- The shipped `FixedFeePoolHookV1` charges its fixed maximum-pips fee. Config6's
  minimum/sensitivity fields do **not** make this concrete hook dynamic.
  The separate registered zero-author-royalty **Dynamic Fee Hook** is selected by
  `KnownLifecycleProfile.V4DynamicFeePool` / `KnownLifecycleHook.DynamicFeePoolV1`;
  it requires zero LP fee and explicit config6 minimum, maximum and sensitivity.
  The catalogue's 500-bps author-share DynamicFeeHook remains a different artifact,
  not this admitted zero-author-royalty offering.
- Different compatible hooks can require different configuration and swap-time
  data. Do not assume all config6 hooks accept the fixed-hook form or empty hookData.
- Keep LP fees, hook trading fees, protocol share, executor bounty, author
  allocation and owner/reward/burn splits distinct. Author allocation is from
  attributable owner fees after bounty, not an added trader tax.
- Copy terms/treasury/denominator from the selected profile. Preserve the requested
  supported author rate and external-LP policy; do not invent fee ceilings or
  disable external liquidity to simplify a launch.

## Prove and execute the final commitment

1. Confirm the intended release graph. The October8 graph includes enforced
   allocation/burn and custody-read fixes; October5 addresses do not inherit them.
2. Derive pricing, budget-funded liquidity and protected buys with the pricing
   skill. Market budgets sum to supply; position maxima sum to each market budget.
   Actual mint debits may be smaller: review all burned leftovers and retained
   supply, not just maxima.
3. Complete funding and fee policies (ascending unique asset arrays; each fee
   allocation totals 10,000 bps). Kyber conversion belongs inside launch funding;
   do not silently submit a separate wallet swap.
4. Freeze economics and ordered buys, then use `prepareAndPlanLifecycleLaunch`
   with atomic preference or explicit staged and optional unstarted `buySlippageBps`.
   Review final plan/hash, returned `planned.mode`, honest evidence and immediate envelope; persist the selected mode.
5. Require explicit authorization for chain/API writes. Keep secrets in the
   existing environment; never overwrite `.env` or supply a development key.
6. Sign/submit only the exact reviewed immediate command. Persist its signed hash
   before sending, then its actual included/replacement hash and confirmation
   evidence. Fresh build-next proof must not change committed economics.
7. Verify canonical Active state, activation receipt, minted custody/positions,
   burn/supply and ordered buy outputs before claiming chain success. Verify API
   publication separately; a pending-indexing response is not completed publication.

The existing `launch-erc20-*` / `launch-erc404-*` cases use `launch-example.ts`
and `launch-example-support.ts`. Inspect their actual installed/local version:
uncommitted recovery/pricing corrections are not automatically in a published
package. A read-only audit must not run a funded example.

## Recover the original launch, never create a replacement token

Read retained `result.json`, events and receipts, plus the mode-0600 exact private
recovery plan. A redacted public plan is diagnostic, not recovery authority.
Query a saved signed hash after timeout before deciding whether anything remains.
Use canonical SDK progress/receipt/replacement/reorg handling; inclusion is not
finality. Resume only uncompleted committed work with deliberate authorization.
Rehydrate with `parseLaunchPlan`, prove with `planLaunch` using the original mode,
receipts and confirmations, then obtain only the immediate `buildNextTransaction`.
Its `undefined` result can mean Active **or Cancelled**; inspect canonical phase.
Explicit cancellation uses `action: "cancel"` on the original planned launch.
Never automatically resend, regenerate salts/minima, relaunch or mutate a submitted
plan. API/upload/publish failure is not a reason to repeat an on-chain launch.
Retain private signatures/capabilities without logging or committing them.
