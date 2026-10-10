import { runLaunchExample } from "./launch-example.mjs";

await runLaunchExample({
  id: "erc20-dividends-multiquote-mixed", description: "ERC20 holder dividends, two quotes, both venues, seven permanent positions and three opening buys",
  tokenKind: 0, rewardMode: 2, mode: "staged",
  markets: [{ venue: "v4", quote: "WETH", positions: 2 }, { venue: "v4", quote: "USDG", positions: 2 },
    { venue: "abyss", quote: "WETH", positions: 3 }], buysPerMarket: 1,
});
