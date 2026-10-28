import { encodeFunctionData, type Address } from "viem";
import { launchLifecycleAbi } from "./abi.js";
import { LifecycleFundingKind, LifecycleMode, type LaunchPlanV1 } from "./schema.js";
import { LifecyclePlanningError, type BuildLaunchTransactionsOptions, type LifecycleTransaction } from "./types.js";
import { assertLifecycleTokenAllocation } from "./allocations.js";
import { HMM_V2_PREPARE_GAS } from "./presets.js";
import { isHmmProfile } from "./hmm.js";
import { ufgLaunchProxyV1Abi } from "./ufg-abi.js";
import { UFG_LAUNCH_PROXY_ADDRESS } from "./ufg-config.js";
import type { UfgLaunchConfig } from "./ufg-config.js";

const OTHER_MARKET_PREPARE_GAS = 16_000_000n;

export function preparationGasEstimate(plan: LaunchPlanV1, first: number, count: number): bigint {
  let gas = 0n;
  for (let index = first; index < first + count; index += 1) gas += isHmmProfile(plan.markets[index]!.profileId) ? HMM_V2_PREPARE_GAS : OTHER_MARKET_PREPARE_GAS;
  return gas;
}

/** Contiguous cost packing preserves committed market order and recovery progress. */
export function packPreparationBatches(plan: LaunchPlanV1, prepared: number, computeCap: bigint): number[] {
  const batches = prepared > 0 ? [prepared] : [];
  let count = 0, gas = 0n;
  for (let index = prepared; index < plan.markets.length; index += 1) {
    const estimate = preparationGasEstimate(plan, index, 1);
    if (count > 0 && gas + estimate > computeCap) { batches.push(count); count = 0; gas = 0n; }
    count += 1;
    gas += estimate;
  }
  if (count > 0) batches.push(count);
  return batches;
}

export type LifecycleCommand =
  | { kind: "atomic" | "begin" | "activate" }
  | { kind: "prepare"; first: number; count: number };
type LifecycleUfgRoute = { account: Address; config: UfgLaunchConfig };

/** Internal encoder shared by complete plans and the one-command continuation. */
export function buildLifecycleCommand(plan: LaunchPlanV1, command: LifecycleCommand, ufg?: LifecycleUfgRoute): LifecycleTransaction {
  const abi = ufg === undefined ? launchLifecycleAbi : ufgLaunchProxyV1Abi;
  const base = { chainId: Number(plan.chainId), from: ufg?.account ?? plan.creator, to: ufg === undefined ? plan.orchestrator : UFG_LAUNCH_PROXY_ADDRESS };
  const value = command.kind === "atomic" || command.kind === "begin"
    ? plan.funding.reduce((total, funding) => total + (funding.kind === LifecycleFundingKind.NativeWrap || funding.kind === LifecycleFundingKind.Swap && BigInt(funding.inputAsset) === 0n ? funding.inputAmount : 0n), 0n) : 0n;
  switch (command.kind) {
    case "atomic": return { ...base, id: "atomic", kind: "atomic", data: encodeFunctionData({ abi, functionName: "launchAtomic", args: ufg === undefined ? [plan] : [plan, ufg.config] }), value, dependencies: [], postconditions: [{ kind: "launch", phase: "Active", preparedMarkets: plan.markets.length }] };
    case "begin": return { ...base, id: "begin", kind: "begin", data: encodeFunctionData({ abi, functionName: "beginLaunch", args: ufg === undefined ? [plan, LifecycleMode.Staged] : [plan, LifecycleMode.Staged, ufg.config] }), value, dependencies: [], postconditions: [{ kind: "launch", phase: "Preparing", preparedMarkets: 0 }] };
    case "activate": return { ...base, id: "activate", kind: "activate", data: encodeFunctionData({ abi, functionName: "activateLaunch", args: [plan] }), value, dependencies: [], postconditions: [{ kind: "launch", phase: "Active", preparedMarkets: plan.markets.length }] };
    case "prepare": return { ...base, id: `prepare:${command.first}:${command.count}`, kind: "prepare", data: encodeFunctionData({ abi, functionName: "prepareMarkets", args: [plan, command.first, command.count] }), value, dependencies: [], marketStart: command.first, marketCount: command.count,
      postconditions: [{ kind: "launch", phase: command.first + command.count === plan.markets.length ? "Ready" : "Preparing", preparedMarkets: command.first + command.count }] };
  }
}

/** Pure unsigned launch commands. Every command carries the complete commitment;
 * preparation splits only empty markets, never positions, buys or public opening.
 * Allowance discovery, recovery and execution proof belong to the planner. */
export function buildLifecycleCommands({ plan, mode, preparationBatches }: BuildLaunchTransactionsOptions, ufg?: LifecycleUfgRoute): LifecycleTransaction[] {
  if (mode !== "atomic" && mode !== "staged") throw new LifecyclePlanningError("EXPLICIT_MODE_REQUIRED", "Choose atomic or staged explicitly; staged is never silently substituted");
  if (plan.chainId <= 0n || plan.chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new LifecyclePlanningError("CHAIN_MISMATCH", "Chain ID must be a positive exact JavaScript integer");
  if (plan.markets.length === 0 || plan.markets.length > 16) throw new LifecyclePlanningError("INVALID_MARKET_COUNT", "A launch requires between one and sixteen markets");
  if (mode === "atomic" && preparationBatches !== undefined) throw new LifecyclePlanningError("INVALID_PREPARATION_BATCHES", "Atomic execution has no separate preparation batches");
  assertLifecycleTokenAllocation(plan);
  const transactions: LifecycleTransaction[] = [];
  if (mode === "atomic") {
    transactions.push(buildLifecycleCommand(plan, { kind: "atomic" }, ufg));
  } else {
    const batches = preparationBatches ?? [plan.markets.length];
    if (batches.length === 0 || batches.some((count) => !Number.isSafeInteger(count) || count <= 0) || batches.reduce((total, count) => total + count, 0) !== plan.markets.length) throw new LifecyclePlanningError("INVALID_PREPARATION_BATCHES", "Positive ordered preparation counts must cover every market exactly");
    transactions.push(buildLifecycleCommand(plan, { kind: "begin" }, ufg));
    let first = 0;
    for (const count of batches) {
      transactions.push(buildLifecycleCommand(plan, { kind: "prepare", first, count }, ufg));
      first += count;
    }
    transactions.push(buildLifecycleCommand(plan, { kind: "activate" }, ufg));
  }
  return transactions.map((transaction, index) => ({ ...transaction, calldataBytes: (transaction.data.length - 2) / 2, dependencies: index === 0 ? [] : [transactions[index - 1]!.id] }));
}

/** Pure unsigned core commands, with no account nonce assigned by the SDK. */
export function buildLaunchTransactions(options: BuildLaunchTransactionsOptions): LifecycleTransaction[] {
  return buildLifecycleCommands(options);
}
