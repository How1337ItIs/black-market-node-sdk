![Abyss](https://raw.githubusercontent.com/abysshopper/black-market-node-sdk/main/assets/abyss-social.webp)

# Abyss TypeScript SDK

Token launches, swaps, and lending with [viem](https://viem.sh).

## Install

```sh
pnpm add @black-market/sdk viem
```

## Examples

Clone this repository to run the examples. Requires Node 24+.

```sh
pnpm install && pnpm build
node examples/quickstart.mjs
```

The quickstart reads available launch profiles without a wallet.

For token launches, set `LAUNCH_API_URL` and exactly one signer source in your
working folder's `.env`: `PRIVATE_KEY` or `EXAMPLE_KEYSTORE_PATH` (local V3 scrypt
keystore; `EXAMPLE_KEYSTORE_PASSWORD` defaults to empty). Optional `RPC_URL`
overrides the default endpoint. Choose one example for the intended launch:

```sh
node examples/launch-erc20-v4.mjs
node examples/launch-erc20-abyss.mjs
node examples/launch-erc404-v4.mjs
node examples/launch-erc404-abyss.mjs
node examples/launch-erc20-staking-v4.mjs
node examples/launch-erc20-dividends-abyss.mjs
node examples/launch-erc20-burn-mixed.mjs
node examples/launch-erc404-dividends-mixed.mjs
node examples/launch-erc20-multi-quote.mjs
node examples/launch-erc20-depth-v4.mjs
node examples/launch-erc20-dividends-multiquote-mixed.mjs
```

The eight original cases remain alongside three additions awaiting user live-run
validation. Every case funds opening buys in native ETH via admitted Kyber Swap
calldata, defaulting to **0.00001 ETH per buy** (`EXAMPLE_BUY_AMOUNT_WEI`).
`EXAMPLE_KYBER_API_URL` defaults to `LAUNCH_API_URL`; refused conversion admission
stops unsigned, never falls back to native-wrap or direct ERC20 funding.
Optional `EXAMPLE_TOKEN_NAME`, `EXAMPLE_TOKEN_SYMBOL`, `EXAMPLE_TOKEN_DESCRIPTION`
and `EXAMPLE_IMAGE_PATH` customize identity and artwork. Image-enabled success
requires staged/published/indexed image bindings and a bounded public-image fetch,
not merely metadata staging. See the [example guide](examples/README.md).

Launch examples spend real funds and publish to your configured API.
Plans, transaction hashes, receipts, and errors are saved in `launch-results/`.
Keep `.env`, keystores and private recovery files out of Git.

The published `0.7.1` package includes the breaking lifecycle cutover.
The topology, example and recovery changes in this working tree have not been republished.
`prepareAndPlanLifecycleLaunch` combines bound-hook preparation and complete admission;
`preparePoolBoundLifecyclePlan` and `PlannedLaunch.atomicAttempt` are removed.
Only the explicitly requested execution mode is simulated. Independent `planLaunch`,
recovery and build-next operations acquire fresh authority.

Known deployments/profiles/hooks ship as frozen construction presets selected by
typed keys without remote discovery. Explicit live discovery and unlisted profiles
remain supported. The current October8 mined graph supports pool-bound config6/V2
construction; historical config5 evidence is never reused or relabeled as that graph.
Creator minimum/maximum hook fees and upward-price sensitivity are independent
per-pool values frozen at launch. Optional `buySlippageBps` protects all ordered buys in one SDK
operation, returning only the final proved commitment. Pure transaction compilation
reports exact calldata sizes. Position recipes use Black Market's Early Scarcity,
Staircase and Smooth Ramp weights, widths and gaps with exact allocation maxima.
Position maxima sum to each market budget; market budgets sum to minted supply.
Actual mint-rounding residuals burn before buys, with no creator reserve.
Staircase and Early Scarcity can explicitly use `positionGaps: "adjacent"` instead
of source gaps, retaining their weights and widths without zero-liquidity price jumps.
The final band now extends to the finite usable protocol boundary by default.
Unstarted planning requires opening coverage, aligned ticks, no interior gaps and
a funded permanent tail in every market. Started, in-flight and terminal recovery
is not retroactively blocked by this creation policy. Explicit topology opt-outs
do not bypass stateful execution proof. See the API guide for the rule and option scopes.

Lifecycle planning admits execution only after exact stateful proof. Robinhood
admission reads native Nitro compute/poster evidence; optional caller caps only
tighten it. Build-next can freshly prove an optional untrusted `reviewedTransaction`
without changing its exact gas/price, and separately preflight that immediate
envelope with an active `submissionClient`. Execution proof is not wallet submission.

[Example setup](https://github.com/abysshopper/black-market-node-sdk/tree/main/examples)
· [API guide](https://github.com/abysshopper/black-market-node-sdk/blob/main/docs/launch-lifecycle.md)
· [MIT license](https://github.com/abysshopper/black-market-node-sdk/blob/main/LICENSE)

[Agent guide](https://github.com/abysshopper/black-market-node-sdk/blob/main/AGENTS.md)
· [Skills](https://github.com/abysshopper/black-market-node-sdk/tree/main/.agents/skills)
