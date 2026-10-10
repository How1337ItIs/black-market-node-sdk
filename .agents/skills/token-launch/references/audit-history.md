# Launch skill audit: decisions and evidence

Audit date: 2026-10-10. Scope: SDK guidance only, not a new release, contract audit
or authorization to transact. Existing pricing/recovery worktree changes were
preserved. Historical assistant verification claims below are archived evidence,
not checks rerun by this audit. Current source and exact deployed graph take
precedence over a superseded conversation.

## History coverage

Searched every JSONL transcript present under the local OMP agent session store at
the audit snapshot: **2,838 files / 887,183 parseable records**, including child-agent
transcripts and every file referenced by the **252 archive-indexed sessions**.
Search covered user and assistant text for launch, quote, topology, hook, liquidity,
pricing/FDV, slippage, first-purchase and Kyber topics; relevant decisions were then
read in context. This is not a claim that all unrelated transcripts were semantically
reviewed or that unavailable/other-workstation sessions were searched.

No transcript files were unreadable. One truncated JSON record was encountered:
child `FrontendHardeningCoordinator`, record 117, under session
`01a0ac8e-fad4-73a7-b5d4-13574025474f`; it was not repaired or treated as evidence.
Raw prompts, secrets, signatures and unrelated personal conversations are not
copied into the SDK. IDs below allow local archive lookup.

## Durable decisions and regressions

| Session / date | User intent or resolved issue | Guidance consequence |
| --- | --- | --- |
| `01a0727e-722e-71fd-8d2b-d3fab5526c36`, Sep 5 | An AI-guided launch design flow: explain standard vs quote fees and token behavior; derive the deployment details for the user. | Ask for genuine product choices, not ticks/digests the SDK can derive. Examples are starting points, not a cap on designs. |
| `01a0fbdf-b177-7232-b7fa-396c71e12545`, Oct 2 onward | Multiple positions, multiple quotes/venues and optional shared/bound hook scopes are separate dimensions. One V4 pool has one hook. Per-pool isolation was desired, not an instruction to remove multipool support. | Do not confuse a position with a pool/hook, promise multiple independent hooks in one PoolKey, or silently constrain everything to one market. |
| Same session | Eight allocation structures and real one-opening-swap comparisons; synthetic many-buy stress failures were initially described as user topology limits. Bound deployment cost was higher in those historical local measurements. | Preserve the requested workload; no invented gas cap, synthetic extra buys or claim that bound is a gas optimization. Local historic gas is not live Nitro admission. |
| `01a108e3-e381-7510-8797-667346ffb5e6`, Oct 4 | Unrequested 1% hook/LP ceilings were removed; 15% fee configurations were exercised locally. Custom hooks use their own admitted terms. | Do not invent profile fee ceilings or assume all hooks share fixed-hook behavior. LP/hook fee rates are not developer allocations. |
| `01a10e93-8b3f-75c8-88a9-1b7fdece7fad`, Oct 6 | Known profiles must construct locally without repeated remote enumeration; complete proof is SDK-owned. Requested multi-venue, five-position pools, one continuous forward tail and short review flow. | Prefer frozen construction presets; retain current execution proof, avoid application-owned duplicate admission/mining loops, and keep the user review concise. |
| `01a1155f-83bf-752e-9a75-7b83b8706a59`, Oct 7 | Allocation caps could seed almost nothing and refund supply to creator. Fix made budgets equal supply, maxima equal budgets and burned all unused inventory before buys. | Intended caps still do not prove actual consumption; review actual LP debt, material burn and retained supply. No creator reserve or dead-sink substitute. |
| `01a1186f-b7b4-70fe-af6e-50fbde84fba7`, Oct 7 | Explorer warnings came from unsupported cross-venue custody probes. Fix replaced them with `custodyRecipients()` and required hub/source redeployment together. | A successful receipt does not prove the latest stack was selected. Historical warnings cannot be removed and immutable old hubs do not acquire the fix. |
| `01a118ae-fabb-71e6-9db0-61a1bf4d6484`, Oct 7 onward | Hook naming/display and fee behavior must follow the concrete selected implementation, not topology/config version. | Config6 minimum/sensitivity storage is not evidence the fixed hook has dynamic fees; future hooks need their actual integration contract. |
| `01a119fc-948b-70f1-bbf9-9347fc1b6c3c`, Oct 8 onward | Two examples used raw parity and produced grossly wrong valuation (user reported approximately $2.4m). Correctness review had omitted implied FDV. A Chainlink lending cutoff was then wrongly made the only valuation path. | Explicit whole supply, decimals/order, provenance, aligned FDV and retained-supply review precede any signature; validated API valuation is a construction input, not an execution quote. |
| `01a10a6b-e8ac-7180-bc3f-4e83f7f95396` and `01a10e93-8b3f-75c8-88a9-1b7fdece7fad`, Oct 5–6 | Kyber calldata was meant to execute through launch funding, not as a separate wallet conversion. Old registry admission was confused with current admission. | Build for escrow sender/recipient; bind router/input/output floor/bytes in Swap funding; direct opening buy remains committed in activation. |
| `01a118d3-9898-7275-877f-058a03a2bd92`, Oct 10 review | JOSH launch selected the October5 core/factory/adapter and retained old probe warnings, despite the October8 release. | Verify the actual caller graph, installed/vendored package and retained plan rather than assuming latest published defaults were used. |

The usual $5,000 target evolved from earlier $3,000 experiments; neither is a
universal protocol requirement. Quote assets are not restricted to a hand-curated
list. User-facing copy should explain behavior/value rather than burying the design
in defensive boilerplate; execution authority and private diagnostic evidence still
remain mandatory.

## Supported shape versus historical catalogue

The SDK's exported range presets are **Early Scarcity, Staircase, Smooth Ramp**.
Only their exact source weights/widths/gaps are those presets. The protocol design
catalogue is separate:

| Catalogue shape | Core positions | Tail share/start at the $5k reference | Objective |
| --- | ---: | --- | --- |
| Anchor | 11 | 10% from $5k | Acceleration with a substantial base. |
| Ladder | 9 | 10% from $5k | Similar buying effort per doubling. |
| Orbit | 9 | 5% from $80k | Overlapping liquidity horizons. |
| Rocket | 11 | 2% from $5k | Acceleration with a smaller base. |
| Cruise | 10 | 6% from $320k | Discovery followed by deeper trading. |
| Spread | 9 | 10% from $5k | Inventory spread across valuations. |
| Depth | 8 | 28% from $640k | More inventory retained for later stages. |
| Bundle | 8 | 3% from $320k | More opening inventory access. |

These are historical design/allocation facts, **not SDK enum values or a promise
that a production plan with those names is admitted**. Exact bands/weights come
from protocol `docs/launch-lp-structure-designs.md` and the `LaunchBandCatalog`
used in its controlled-local topology evidence. The optional Abyss bonus is a
separate pool; its allocation comes from the same supply budget. Every forward
path uses a nonzero finite protocol-boundary tail with no unintended gap before
it. Historical dollar curves assume fixed reference supply/quote price and omit
fees/burns/tick rounding: recompute and statefully prove actual economics.

## Current source map

- `src/launch.ts`: decimal/order-aware pool recipe, source-defined ranges,
  single-band indicative buy and exclusive price guard. Recipe default supply is
  one billion tokens; lifecycle callers must pass actual supply explicitly.
- `src/lifecycle/{schema,allocations,markets,presets,planner,calibration}.ts`:
  funding/buy wire separation, exact allocations, versions, construction metadata,
  final protected proof and fresh immediate-next recovery. Public exports are the
  API authority; a hypothetical wrapper is not an existing API.
- `docs/launch-lifecycle.md`, `examples/README.md`: current operator flow; inspect
  local/installed versions because pending worktree examples are not automatically
  in a published artifact.
- Protocol `contracts/src/launch/lifecycle/v1/LaunchFundingEscrowV1.sol`: exact
  measured output credit, creator input pull, target/spender admission, allowance
  reset and launch-local refunds. Conversion data is opaque to the SDK, capped at
  16,384 bytes; `InitialBuyV1` has no external-target/calldata slot.
- Protocol `docs/launch-lifecycle-v1-operations.md`, "Admit Kyber on the current
  Robinhood deployment": new-registry admission, escrow-bound build and fork-proof
  prerequisites. Router enablement/input admission must be read live, not inferred.
- API `src/api/routes/quoteKyber.ts`: preview GET versus fresh build POST, camelCase
  intent, native normalization, 1..2000-bps HTTP slippage, deadline, output floor
  and unsigned transaction DTO. Neither SDK exports a Kyber HTTP quote/build client.
- Protocol `contracts/deployments/launch/pool-launch-v1/20261008T000141Z-e174ce6/`:
  mined graph evidence. October5 graphs/ABIs remain historical, not relabeled.

## Audit limits

Guidance changes do not fix existing pools, enable Kyber, admit a new hook or
publish a package. Pure/read-only smoke observations belong in the completion
report; historical test counts above are not current verification. Complete real
conversion/first-buy execution requires a usable stateful backend and actual
admitted dependencies. No "first try" guarantee survives unreviewed state changes.
