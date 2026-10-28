import { type Address, type Hex } from "viem";
import { launchPlanV1Components, launchProgressV1Components, preparedMarketV1Components, marketLiveStateV1Components, type LaunchProgressV1, type PreparedMarketV1, type MarketLiveStateV1 } from "./schema.js";
import type { LifecycleBlock, LifecycleRpcClient } from "./types.js";

/** ILaunchLens.sol, versioned planning snapshot. Its address is owned by the deployment preset. */
export const launchLensAbi = [{ type: "function", name: "snapshot", stateMutability: "view",
  inputs: [{ name: "plan", type: "tuple", components: launchPlanV1Components }, { name: "owner", type: "address" },
    { name: "fundingEscrow", type: "address" }, { name: "tokens", type: "address[]" }, { name: "maxAttempts", type: "uint256" }],
  outputs: [{ name: "result", type: "tuple", components: [
    { name: "chainId", type: "uint256" }, { name: "blockNumber", type: "uint256" },
    { name: "parentBlockHash", type: "bytes32" }, { name: "timestamp", type: "uint256" }, { name: "nativeBalance", type: "uint256" },
    { name: "tokenBalances", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "balance", type: "uint256" }, { name: "allowance", type: "uint256" }] },
    { name: "predictedToken", type: "address" }, { name: "launchId", type: "bytes32" },
    { name: "progress", type: "tuple", components: launchProgressV1Components },
    { name: "preparedMarkets", type: "tuple[]", components: [
      { name: "index", type: "uint32" }, { name: "adapter", type: "address" }, { name: "prepared", type: "tuple", components: preparedMarketV1Components },
      { name: "liveStateSuccess", type: "bool" }, { name: "live", type: "tuple", components: marketLiveStateV1Components }, { name: "liveStateError", type: "bytes" },
    ] },
    { name: "hookDeployments", type: "tuple[]", components: [
      { name: "marketIndex", type: "uint32" }, { name: "adapter", type: "address" }, { name: "deployer", type: "address" },
      { name: "constructorParameters", type: "bytes" }, { name: "initCodeHash", type: "bytes32" }, { name: "salt", type: "bytes32" }, { name: "hook", type: "address" }, { name: "found", type: "bool" },
    ] },
  ] }],
}] as const;

export type LifecycleLensSnapshot = {
  chainId: bigint; blockNumber: bigint; parentBlockHash: Hex; timestamp: bigint; nativeBalance: bigint;
  tokenBalances: readonly { token: Address; balance: bigint; allowance: bigint }[];
  predictedToken: Address; launchId: Hex; progress: LaunchProgressV1;
  preparedMarkets: readonly { index: number; adapter: Address; prepared: PreparedMarketV1; liveStateSuccess: boolean; live: MarketLiveStateV1; liveStateError: Hex }[];
  hookDeployments: readonly { marketIndex: number; adapter: Address; deployer: Address; constructorParameters: Hex; initCodeHash: Hex; salt: Hex; hook: Address; found: boolean }[];
};
const snapshots = new WeakMap<LifecycleRpcClient, { blockHash: Hex; snapshot: LifecycleLensSnapshot }>();

export function observeLifecycleLens(client: LifecycleRpcClient, block: LifecycleBlock, snapshot: LifecycleLensSnapshot): void {
  snapshots.set(client, { blockHash: block.hash.toLowerCase() as Hex, snapshot });
}

export function lifecycleLensSnapshot(client: LifecycleRpcClient, block: LifecycleBlock): LifecycleLensSnapshot | undefined {
  const observation = snapshots.get(client);
  return observation?.snapshot.blockNumber === block.number && observation.blockHash === block.hash.toLowerCase() ? observation.snapshot : undefined;
}
