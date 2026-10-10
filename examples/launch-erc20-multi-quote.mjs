import { runLaunchExample } from "./launch-example.mjs";

await runLaunchExample({
  id: "erc20-multi-quote", description: "ERC20, two quotes, two pool-bound V4 markets and one Abyss market",
  tokenKind: 0, rewardMode: 0, mode: "staged",
  markets: [{ venue: "v4", quote: "WETH", positions: 1 }, { venue: "v4", quote: "USDG", positions: 1 },
    { venue: "abyss", quote: "WETH", positions: 1 }], buysPerMarket: 1,
});
