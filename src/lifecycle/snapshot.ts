import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, multicall3Abi, toHex, zeroAddress, type Abi, type Address } from "viem";
import { robinhoodMainnet } from "../addresses.js";
import { launchLifecycleAbi, lifecycleErc20Abi } from "./abi.js";
import { getKnownLifecycleDeployment, type LifecycleDeploymentPreset } from "./presets.js";
import { lifecycleTokenPredictionAbi } from "./progress.js";
import { launchLensAbi, observeLifecycleLens, type LifecycleLensSnapshot } from "./lens.js";
import { hashLaunchIdentity, LifecycleFundingKind, type LaunchPlanV1 } from "./schema.js";
import { attestLifecycleMulticall, lifecycleRpc, nitroArbSys, nitroArbSysAbi, nitroGasInfo, nitroGasInfoAbi, readLifecycleBlock, readLifecycleChainId, rpcHex, seedLifecycleRead } from "./rpc.js";
import { LifecyclePlanningError, type LifecycleBlock, type LifecycleRpcClient } from "./types.js";
import { UFG_LAUNCH_PROXY_ADDRESS } from "./ufg-config.js";

type SnapshotRead = { to: Address; abi: Abi; functionName: string; args: readonly unknown[]; from?: Address };

/** Nitro's EVM BLOCKNUMBER/BLOCKHASH expose L1 values. One RPC header owns the L2
 * pin; every planning getter is aggregated at that explicit L2 block number. */
export async function readLifecyclePlanningBlock(client: LifecycleRpcClient, plan: LaunchPlanV1, account: Address, ufg = false, mine = false,
  preset: LifecycleDeploymentPreset | undefined = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator })): Promise<LifecycleBlock> {
  const [block, chainId] = await Promise.all([readLifecycleBlock(client), readLifecycleChainId(client)]);
  if (chainId !== plan.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain differs from the committed plan");
  if (chainId !== 4663n) return block;
  const to = robinhoodMainnet.contracts.multicall3.address;
  const reads: SnapshotRead[] = [];
  const add = (target: Address, abi: Abi, functionName: string, args: readonly unknown[], from?: Address) => reads.push({ to: target, abi, functionName, args, from });
  const escrow = ufg ? UFG_LAUNCH_PROXY_ADDRESS : preset?.fundingEscrow;
  const inputs = [...new Set(plan.funding.filter((funding) => funding.kind !== LifecycleFundingKind.NativeWrap && !(funding.kind === LifecycleFundingKind.Swap && funding.inputAsset === zeroAddress)).map((funding) => funding.inputAsset.toLowerCase() as Address))];
  const hasLens = preset?.launchLens !== undefined;
  if (hasLens) {
    add(preset.launchLens!, launchLensAbi, "snapshot", [plan, account, escrow!, inputs, mine ? 150_000n : 0n]);
  } else {
    add(to, multicall3Abi, "getEthBalance", [account]);
    if (preset === undefined) add(plan.orchestrator, launchLifecycleAbi, "predictToken", [plan]);
    else add(preset.tokenFactory, lifecycleTokenPredictionAbi, "predictToken", [hashLaunchIdentity(plan), plan.token]);
    add(plan.orchestrator, launchLifecycleAbi, "readLaunchProgress", [hashLaunchIdentity(plan)], account);
    for (const asset of inputs) {
      add(asset, lifecycleErc20Abi, "balanceOf", [account]);
      if (escrow !== undefined) add(asset, lifecycleErc20Abi, "allowance", [account, escrow]);
    }
  }
  add(nitroArbSys, nitroArbSysAbi, "arbOSVersion", []);
  add(nitroGasInfo, nitroGasInfoAbi, "getMaxTxGasLimit", []);
  add(nitroGasInfo, nitroGasInfoAbi, "getMaxBlockGasLimit", []);
  await attestLifecycleMulticall(client, block);
  const calls = reads.map((read) => ({ target: read.to, allowFailure: true, callData: encodeFunctionData({ abi: read.abi, functionName: read.functionName, args: read.args }) }));
  const data = encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
  const raw = rpcHex(await lifecycleRpc(client, "eth_call", [{ to, data }, toHex(block.number)]), "planning snapshot");
  const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
  if (results.length !== reads.length || !results[0]!.success) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Multicall3 omitted the planning balance snapshot");
  const seed = (target: Address, abi: Abi, functionName: string, args: readonly unknown[], result: unknown, from?: Address) => {
    seedLifecycleRead(client, "eth_call", [{ to: target, from, data: encodeFunctionData({ abi, functionName, args }) }, toHex(block.number)], block, encodeFunctionResult({ abi, functionName, result }));
  };
  if (hasLens) {
    const snapshot = decodeFunctionResult({ abi: launchLensAbi, functionName: "snapshot", data: results[0]!.returnData }) as LifecycleLensSnapshot;
    if (snapshot.chainId !== chainId || snapshot.blockNumber !== block.number) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "LaunchLens returned a different L2 planning domain");
    observeLifecycleLens(client, block, snapshot);
    seedLifecycleRead(client, "eth_getBalance", [account, toHex(block.number)], block, toHex(snapshot.nativeBalance));
    seed(preset!.tokenFactory, lifecycleTokenPredictionAbi, "predictToken", [hashLaunchIdentity(plan), plan.token], snapshot.predictedToken);
    seed(plan.orchestrator, launchLifecycleAbi, "readLaunchProgress", [hashLaunchIdentity(plan)], snapshot.progress, account);
    for (const balance of snapshot.tokenBalances) {
      seed(balance.token, lifecycleErc20Abi, "balanceOf", [account], balance.balance);
      seed(balance.token, lifecycleErc20Abi, "allowance", [account, escrow!], balance.allowance);
    }
  } else {
    const balance = decodeFunctionResult({ abi: multicall3Abi, functionName: "getEthBalance", data: results[0]!.returnData });
    seedLifecycleRead(client, "eth_getBalance", [account, toHex(block.number)], block, toHex(balance));
  }
  for (let index = 1; index < reads.length; index += 1) {
    if (!results[index]!.success) continue;
    const read = reads[index]!;
    seedLifecycleRead(client, "eth_call", [{ to: read.to, from: read.from, data: calls[index]!.callData }, toHex(block.number)], block, results[index]!.returnData);
  }
  return block;
}
