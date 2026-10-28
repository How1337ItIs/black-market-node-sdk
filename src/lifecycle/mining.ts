import { parseAbi, type Address, type Hex } from "viem";
import { hasLifecycleV4HookPermissions, minePoolBoundHookSalt, predictPoolBoundHookAddress } from "./markets.js";
import { readLifecycleContract } from "./rpc.js";
import { LifecyclePlanningError, type LifecycleBlock, type LifecyclePoolBoundHookDeployment, type LifecycleRpcClient, type PoolBoundLifecyclePreparationProgress } from "./types.js";
import { lifecycleLensSnapshot } from "./lens.js";

export const hookSaltMinerAbi = parseAbi(["function findMany((address deployer, bytes32 initCodeHash, uint256 startSalt, uint160 flags)[] searches, uint256 maxAttempts) pure returns (bytes32[] salts, address[] hooks, bool[] found)"]);

/** Read-only bounded EVM mining; every returned winner is checked with local CREATE2. */
export async function mineLifecycleHooks(options: {
  client: LifecycleRpcClient; block: LifecycleBlock; miner?: Address;
  deployments: readonly LifecyclePoolBoundHookDeployment[]; signal?: AbortSignal;
  onProgress?: (progress: PoolBoundLifecyclePreparationProgress) => void;
}): Promise<LifecyclePoolBoundHookDeployment[]> {
  const { deployments, signal, onProgress, miner, client, block } = options;
  const checkActive = () => { if (signal?.aborted) throw Object.assign(new Error("Lifecycle hook mining cancelled"), { name: "AbortError" }); };
  checkActive();
  if (miner === undefined) return Promise.all(deployments.map(async (deployment) => ({ ...deployment,
    ...await minePoolBoundHookSalt({ ...deployment, startSalt: BigInt(deployment.salt), signal,
      onProgress: onProgress === undefined ? undefined : (progress) => onProgress({ marketIndex: deployment.marketIndex, ...progress }) }),
  })));
  const results = deployments.map((deployment) => ({ ...deployment }));
  const lens = lifecycleLensSnapshot(client, block);
  let pending: number[] = [];
  for (const [index, deployment] of deployments.entries()) {
    const observed = lens?.hookDeployments.find((hook) => hook.marketIndex === deployment.marketIndex);
    if (observed === undefined) { pending.push(index); continue; }
    const predictedHook = predictPoolBoundHookAddress({ ...deployment, salt: observed.salt });
    if (observed.deployer.toLowerCase() !== deployment.deployer.toLowerCase() || observed.initCodeHash.toLowerCase() !== deployment.initCodeHash.toLowerCase() ||
      BigInt(observed.salt) < BigInt(deployment.salt) || observed.found && (observed.hook.toLowerCase() !== predictedHook.toLowerCase() || !hasLifecycleV4HookPermissions(predictedHook))) {
      throw new LifecyclePlanningError("INVALID_MINER_RESULT", "LaunchLens hook result differs from the locally derived constructor or CREATE2 address");
    }
    results[index] = { ...deployment, salt: observed.salt, predictedHook };
    if (!observed.found) pending.push(index);
    else onProgress?.({ marketIndex: deployment.marketIndex, salt: observed.salt, predictedHook, attempts: BigInt(observed.salt) - BigInt(deployment.salt) + 1n });
  }
  while (pending.length > 0) {
    checkActive();
    let maxAttempts = BigInt(Math.floor(150_000 / pending.length));
    for (const index of pending) {
      const available = (1n << 256n) - 1n - BigInt(results[index]!.salt);
      if (available < maxAttempts) maxAttempts = available;
    }
    if (maxAttempts === 0n) {
      pending = pending.filter((index) => {
        const deployment = results[index]!;
        if (BigInt(deployment.salt) !== (1n << 256n) - 1n) return true;
        const predictedHook = predictPoolBoundHookAddress(deployment);
        if (!hasLifecycleV4HookPermissions(predictedHook)) throw new LifecyclePlanningError("HOOK_SALT_EXHAUSTED", "No valid hook address remains in the uint256 salt range");
        results[index] = { ...deployment, predictedHook };
        onProgress?.({ marketIndex: deployment.marketIndex, salt: deployment.salt, predictedHook, attempts: BigInt(deployment.salt) - BigInt(deployments[index]!.salt) + 1n });
        return false;
      });
      continue;
    }
    const searches = pending.map((index) => ({ deployer: results[index]!.deployer, initCodeHash: results[index]!.initCodeHash, startSalt: BigInt(results[index]!.salt), flags: 0x1afcn }));
    const [salts, hooks, found] = await readLifecycleContract<readonly [readonly Hex[], readonly Address[], readonly boolean[]]>(client, miner, hookSaltMinerAbi, "findMany", [searches, maxAttempts], block);
    checkActive();
    if (salts.length !== pending.length || hooks.length !== pending.length || found.length !== pending.length) throw new LifecyclePlanningError("INVALID_MINER_RESULT", "Hook miner omitted a search result");
    const unfinished: number[] = [];
    for (const [ordinal, index] of pending.entries()) {
      const deployment = results[index]!;
      const salt = salts[ordinal]!;
      const end = searches[ordinal]!.startSalt + maxAttempts;
      const predictedHook = predictPoolBoundHookAddress({ ...deployment, salt });
      if (found[ordinal]) {
        if (BigInt(salt) < searches[ordinal]!.startSalt || BigInt(salt) >= end || hooks[ordinal]!.toLowerCase() !== predictedHook.toLowerCase() || !hasLifecycleV4HookPermissions(predictedHook)) throw new LifecyclePlanningError("INVALID_MINER_RESULT", "Hook miner returned an invalid CREATE2 salt or permission mask");
      } else {
        if (BigInt(salt) !== end) throw new LifecyclePlanningError("INVALID_MINER_RESULT", "Hook miner did not advance to the next unsearched salt");
        unfinished.push(index);
      }
      results[index] = { ...deployment, salt, predictedHook };
      onProgress?.({ marketIndex: deployment.marketIndex, salt, predictedHook, attempts: BigInt(salt) - BigInt(deployments[index]!.salt) + (found[ordinal] ? 1n : 0n) });
      checkActive();
    }
    pending = unfinished;
  }
  checkActive();
  return results;
}
