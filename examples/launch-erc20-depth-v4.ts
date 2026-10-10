import { runLaunchExample } from "./launch-example.ts";

await runLaunchExample({
  id: "erc20-depth-v4", description: "ERC20 Depth shape: four adjacent Early Scarcity positions with increasing inventory and a permanent final tail",
  tokenKind: 0, rewardMode: 0, mode: "staged",
  markets: [{ venue: "v4", positions: 4, distributionPreset: "early-scarcity" }], buysPerMarket: 1,
});
