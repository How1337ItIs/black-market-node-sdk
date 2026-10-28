import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex } from "viem";
import { fixedFeePoolHookV1Abi, launchLifecycleAbi, lifecycleErc20Abi } from "./abi.js";
import { hashLaunchIdentity, hashLaunchPlan, LifecyclePhase, type LaunchPlanV1, type LaunchProgressV1, type LaunchReceiptV1 } from "./schema.js";
import { assertLifecycleReadClientOpen, lifecycleFailureReason, lifecyclePinnedRpc, lifecycleRpc, lifecycleSessionRead, lifecycleSourceClient, lifecycleStage, nitroArbSys, nitroArbSysAbi, nitroGasInfo, nitroGasInfoAbi, readLifecycleBlock, readLifecycleChainId, readLifecycleGasPrice, readNitroPosterGas, registerLifecycleFinalCheck, resolveLifecycleLimits, rpcHex, rpcObject, rpcQuantity, type LifecycleLimitObservation } from "./rpc.js";
import { LifecyclePlanningError, type ControlledLifecycleFork, type LifecycleBlock, type LifecycleLimitContext, type LifecyclePostcondition, type LifecycleRpcClient, type LifecycleSimulation, type LifecycleSimulationStep, type LifecycleTransaction, type PlannedLaunch, type ResolvedLifecycleLimits, type SimulateLaunchPlanOptions } from "./types.js";
import { decodeAbyssLifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig, decodeV4LifecycleMarketConfig, isPoolBoundV4ConfigVersion } from "./markets.js";
import { hmmV2ForwardingReserve } from "./presets.js";
import { transactionGasEstimate } from "./transactions.js";
import { hashUfgLaunchConfig } from "./ufg-config.js";

function committedPositionCount(plan: LaunchPlanV1): number {
  let count = 0;
  for (const market of plan.markets) {
    if (market.configVersion === 1) count += decodeAbyssLifecycleMarketConfig(market.config).positions.length;
    else if (market.configVersion === 4) count += decodeV4LifecycleMarketConfig(market.config).positions.length;
    else if (isPoolBoundV4ConfigVersion(market.configVersion)) count += decodePoolBoundV4LifecycleMarketConfig(market.config, market.configVersion).positions.length;
    else throw new LifecyclePlanningError("UNSUPPORTED_CONFIG_VERSION", "Activation requires a supported committed position schema");
  }
  return count;
}

const executionGuardErrors = [
  ...fixedFeePoolHookV1Abi.filter((item) => item.type === "error"),
  ...parseAbi([
    "error WrongDomain()", "error PlanMismatch()", "error LaunchAlreadyExists()", "error InvalidMode()",
    "error InvalidPhase()", "error InvalidPreparationOrder()", "error DeadlineExpired()", "error InvalidBinding()",
    "error InvalidMarket()", "error InsufficientEscrow()", "error InvalidPositions()", "error InvalidPlan()",
    "error InvalidFunding()", "error InvalidFeePolicy()", "error InvalidBuy()", "error DuplicateMarket()",
    "error IneligibleImplementation()", "error QuoteDebtForbidden()", "error SlippageExceeded()", "error FeeBelowMinimum()",
    "error DeploymentFailed()", "error Error(string reason)", "error Panic(uint256 code)",
  ]),
];

function executionFailure(returnData: Hex | undefined, error: unknown): Pick<LifecycleSimulationStep, "failureCategory" | "decodedError" | "nativeErrorCode" | "nativeErrorKind" | "nativeErrorDataBytes" | "nativeGasCapped" | "error"> {
  const native = error !== null && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
  let nativeData: unknown = native?.data;
  for (let depth = 0; depth < 3 && nativeData !== null && typeof nativeData === "object" && !Array.isArray(nativeData); depth += 1) nativeData = (nativeData as Record<string, unknown>).data;
  const nativeErrorDataBytes = typeof nativeData === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(nativeData) ? (nativeData.length - 2) / 2 : undefined;
  const nativeErrorCode = typeof native?.code === "number" && Number.isSafeInteger(native.code) ? native.code : undefined;
  const message = typeof native?.message === "string" ? native.message : "";
  const nativeGasCapped = message.endsWith(" (gas limit was capped by the RPC server's global gas cap)");
  // Native eth_simulateV1 uses -32015 for VM errors; -32000 is also used by RPC clients.
  // Empty data and an explicit OOG report are required. Malformed data or proximity is not proof.
  const outOfGas = (returnData === undefined || returnData === "0x") && (native?.data === undefined || nativeErrorDataBytes === 0) &&
    (nativeErrorCode === -32015 || nativeErrorCode === -32000) && /^out of gas\b/i.test(message);
  const nativeErrorKind = native === undefined ? "missing" : outOfGas ? "out-of-gas" : nativeErrorCode === 3 ? "execution-reverted" : nativeErrorCode === -32015 ? "vm-error" : "other";
  const diagnostic = { nativeErrorCode, nativeErrorKind, nativeErrorDataBytes, nativeGasCapped } as const;
  const data = returnData === undefined || returnData === "0x" ? nativeData : returnData;
  if (typeof data === "string" && /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) {
    try {
      const { errorName } = decodeErrorResult({ abi: executionGuardErrors, data: data as Hex });
      return { ...diagnostic, failureCategory: errorName === "DeploymentFailed" ? "opaque" : "semantic", decodedError: errorName, error: `Execution reverted (${errorName})` };
    } catch { return { ...diagnostic, failureCategory: "opaque", error: "Execution reverted without a reviewed error" }; }
  }
  if (outOfGas) return { ...diagnostic, failureCategory: nativeGasCapped ? "source" : "capacity", error: nativeGasCapped ? "Native execution ran out of gas under the reported RPC gas cap" : "Native execution ran out of gas" };
  return { ...diagnostic, failureCategory: "opaque", error: nativeErrorKind === "execution-reverted" ? "Native execution reverted without a reviewed error" : "Execution failed without a reviewed error" };
}


function conditionRequest(condition: LifecyclePostcondition, planned: PlannedLaunch): { to: Hex; data: Hex } {
  if (condition.kind === "allowance") return {
    to: condition.asset, data: encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "allowance", args: [planned.account, condition.spender] }),
  };
  return { to: planned.plan.orchestrator, data: encodeFunctionData({ abi: launchLifecycleAbi, functionName: "readLaunchProgress", args: [planned.launchId] }) };
}
function checkCondition(condition: LifecyclePostcondition, data: Hex, planned: PlannedLaunch): void {
  if (condition.kind === "allowance") {
    const allowance = decodeFunctionResult({ abi: lifecycleErc20Abi, functionName: "allowance", data });
    if (allowance < condition.minimum || (condition.exact !== undefined && allowance !== condition.exact)) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Funding allowance was not established");
    return;
  }
  // The frozen ABI decoder produces the precise progress tuple, including all identity fields.
  const progress = decodeFunctionResult({ abi: launchLifecycleAbi, functionName: "readLaunchProgress", data }) as LaunchProgressV1;
  const phase = LifecyclePhase[condition.phase];
  if (progress.phase !== phase || progress.preparedMarkets !== condition.preparedMarkets || progress.planHash.toLowerCase() !== planned.planHash.toLowerCase() || progress.launchId.toLowerCase() !== planned.launchId.toLowerCase() || progress.token.toLowerCase() !== planned.predictedToken.toLowerCase()) {
    throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Simulation did not establish the committed launch identity, phase and ordered progress");
  }
}

/** Native Nitro eth_simulateV1 executes commit-mode ArbOS charging, including its
 * compute hold after the actual poster charge. A generic EVM/fork is not this proof. */
async function proveNitroBackend(client: LifecycleRpcClient, planned: PlannedLaunch, block: LifecycleBlock, limits: ResolvedLifecycleLimits, gasPrice: bigint): Promise<void> {
  if (limits.arbOSVersion === undefined || limits.maxTxComputeGas === undefined || limits.maxBlockComputeGas === undefined) throw new LifecyclePlanningError("NITRO_METERING_UNAVAILABLE", "Pinned Nitro metering context is incomplete");
  const probes = [
    { to: nitroArbSys, data: encodeFunctionData({ abi: nitroArbSysAbi, functionName: "arbOSVersion" }), expected: limits.arbOSVersion + 55n },
    { to: nitroGasInfo, data: encodeFunctionData({ abi: nitroGasInfoAbi, functionName: "getMaxTxGasLimit" }), expected: limits.maxTxComputeGas },
    { to: nitroGasInfo, data: encodeFunctionData({ abi: nitroGasInfoAbi, functionName: "getMaxBlockGasLimit" }), expected: limits.maxBlockComputeGas },
  ];
  const gas = limits.executionGasCeiling < 100_000n ? limits.executionGasCeiling : 100_000n;
  if (limits.maxSimulationGas !== undefined && gas * BigInt(probes.length) > limits.maxSimulationGas) throw new LifecyclePlanningError("SIMULATION_RPC_CAP", "Nitro metering probe exceeds the supplied RPC aggregate simulation cap");
  // This isolated read-only request does not add synthetic verification transactions to the launch sequence.
  const result = await lifecycleRpc(client, "eth_simulateV1", [{
    validation: true, traceTransfers: false, returnFullTransactions: false,
    blockStateCalls: [{
      // Capability reads are isolated from payer affordability. Real launch replay never overrides balances.
      stateOverrides: { [planned.account]: { balance: toHex((1n << 256n) - 1n) } },
      blockOverrides: { number: toHex(block.number + 1n), time: toHex(block.timestamp + 1n), gasLimit: toHex(block.gasLimit) },
      calls: probes.map(({ to, data }) => ({ from: planned.account, to, data, value: "0x0", gas: toHex(gas), gasPrice: toHex(gasPrice) })),
    }],
  }, toHex(block.number)]);
  if (!Array.isArray(result) || result.length !== 1) throw new LifecyclePlanningError("NITRO_METERING_UNAVAILABLE", "Native simulation omitted the pinned ArbOS metering probe");
  const simulated = rpcObject(result[0], "Nitro metering probe block");
  if (!Array.isArray(simulated.calls) || simulated.calls.length !== probes.length) throw new LifecyclePlanningError("NITRO_METERING_UNAVAILABLE", "Native simulation omitted ArbOS version or compute getters");
  for (let index = 0; index < probes.length; index += 1) {
    const call = rpcObject(simulated.calls[index], "Nitro metering probe");
    const data = rpcHex(call.returnData, "simulated Nitro metering result");
    if (rpcQuantity(call.status, "Nitro metering probe status") !== 1n || rpcQuantity(call.gasUsed, "Nitro metering probe gas") > gas || data.length !== 66 || BigInt(data) !== probes[index]?.expected) {
      throw new LifecyclePlanningError("NITRO_METERING_UNAVAILABLE", "Simulated ArbOS version/compute getters differ from the exact pinned chain context");
    }
  }
}

async function simulateRpcPass(client: LifecycleRpcClient, planned: PlannedLaunch, block: LifecycleBlock, transactions: readonly LifecycleTransaction[], gasLimits: readonly bigint[], limits: ResolvedLifecycleLimits, gasPrice: bigint, validation: boolean): Promise<LifecycleSimulationStep[]> {
  // Natural child-block fees must govern fee-bearing admission; overriding
  // baseFeePerGas with the parent's would fabricate a lower envelope and admit
  // calls that the actual chain would reject. eth_simulateV1 derives the child
  // base fee itself; only structural child fields (number/time) and the
  // parent gasLimit are set.
  const blockStateCalls = transactions.map((transaction, index) => ({
    blockOverrides: { number: toHex(block.number + BigInt(index + 1)), time: toHex(block.timestamp + BigInt(index + 1)), gasLimit: toHex(block.gasLimit) },
    calls: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: toHex(transaction.value), gas: toHex(gasLimits[index] ?? limits.executionGasCeiling), gasPrice: toHex(gasPrice), ...(transaction.nonce === undefined ? {} : { nonce: toHex(transaction.nonce) }) }],
  }));
  const result = await lifecycleRpc(client, "eth_simulateV1", [{ blockStateCalls, validation, traceTransfers: false, returnFullTransactions: false }, toHex(block.number)]);
  if (!Array.isArray(result) || result.length !== transactions.length) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Sequential simulation omitted blocks");
  const steps: LifecycleSimulationStep[] = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    if (transaction === undefined) throw new LifecyclePlanningError("INVALID_SIMULATION", "Missing simulation transaction");
    const simulatedBlock = rpcObject(result[index], "simulated block");
    if (!Array.isArray(simulatedBlock.calls) || simulatedBlock.calls.length !== 1) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Sequential simulation omitted transaction results");
    const call = rpcObject(simulatedBlock.calls[0], "simulated transaction");
    const gasUsed = rpcQuantity(call.gasUsed, "simulated gas used");
    const gasRequired = call.maxUsedGas === undefined ? gasUsed : rpcQuantity(call.maxUsedGas, "simulated gross gas");
    if (gasRequired < gasUsed || gasRequired > (gasLimits[index] ?? 0n)) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Simulated gas use is outside the exact requested envelope");
    const returnData = rpcHex(call.returnData, "simulated return data");
    const success = rpcQuantity(call.status, "simulated status") === 1n;
    const failureDiagnostic = success ? undefined : executionFailure(returnData, call.error);
    let error = failureDiagnostic?.error;
    if (success) {
      try {
        // Verification reads must not become synthetic transactions that consume creator nonce/fees.
        // Core return tuples/events and subsequent dependent commands prove persisted transitions.
        const events = (Array.isArray(call.logs) ? call.logs : []).flatMap((raw) => {
          const log = rpcObject(raw, "simulation event");
          if (rpcHex(log.address, "simulation event address").toLowerCase() !== planned.plan.orchestrator.toLowerCase() || !Array.isArray(log.topics)) return [];
          const topics = log.topics.map((topic) => rpcHex(topic, "event topic"));
          if (topics.length === 0) return [];
          const event = decodeEventLog({ abi: launchLifecycleAbi, topics: topics as [Hex, ...Hex[]], data: rpcHex(log.data, "simulation event data") });
          return [event];
        });
        if (transaction.kind === "begin") checkCondition({ kind: "launch", phase: "Preparing", preparedMarkets: 0 }, returnData, planned);
        else if (transaction.kind === "prepare") {
          const prepared = events.filter((event) => event.eventName === "MarketPrepared");
          if (prepared.length !== transaction.marketCount || prepared.some((event, ordinal) => event.eventName !== "MarketPrepared" || event.args.launchId.toLowerCase() !== planned.launchId.toLowerCase() || event.args.marketIndex !== (transaction.marketStart ?? 0) + ordinal)) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Simulation did not prepare each exact ordered market");
        } else if (transaction.kind === "atomic" || transaction.kind === "activate") {
          const functionName = transaction.kind === "atomic" ? "launchAtomic" : "activateLaunch";
          const receipt = decodeFunctionResult({ abi: launchLifecycleAbi, functionName, data: returnData }) as LaunchReceiptV1;
          const positionCount = committedPositionCount(planned.plan);
          if (receipt.planHash.toLowerCase() !== planned.planHash.toLowerCase() || receipt.launchId.toLowerCase() !== planned.launchId.toLowerCase() || receipt.token.toLowerCase() !== planned.predictedToken.toLowerCase() || receipt.marketCount !== planned.plan.markets.length || receipt.positionCount !== positionCount || receipt.quoteSpent.length !== planned.plan.buys.length || receipt.tokenOut.length !== planned.plan.buys.length || !events.some((event) => event.eventName === "LaunchActivated" && event.args.launchId.toLowerCase() === planned.launchId.toLowerCase() && event.args.planHash.toLowerCase() === planned.planHash.toLowerCase() && event.args.token.toLowerCase() === planned.predictedToken.toLowerCase() && event.args.marketCount === planned.plan.markets.length && event.args.positionCount === positionCount)) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Simulation did not atomically complete every committed market, position and ordered buy");
          for (let buyIndex = 0; buyIndex < planned.plan.buys.length; buyIndex += 1) {
            const buy = planned.plan.buys[buyIndex];
            if (buy === undefined || (receipt.quoteSpent[buyIndex] ?? buy.quoteAmountIn + 1n) > buy.quoteAmountIn || (receipt.tokenOut[buyIndex] ?? 0n) < buy.minTokenOut) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Simulation did not satisfy every ordered buy's budget and output minimum");
          }
        } else if (transaction.kind === "cancel" && !events.some((event) => event.eventName === "LaunchCancelled" && event.args.launchId.toLowerCase() === planned.launchId.toLowerCase() && event.args.creator.toLowerCase() === planned.plan.creator.toLowerCase())) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Simulation did not cancel the exact committed launch");
        else if ((transaction.kind === "approve" || transaction.kind === "approve-reset") && returnData !== "0x" && decodeFunctionResult({ abi: lifecycleErc20Abi, functionName: "approve", data: returnData }) !== true) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Funding approval returned failure");
      } catch (failure) { error = failure instanceof LifecyclePlanningError ? failure.message : "Simulation returned an invalid committed postcondition"; }
    }
    steps.push({ transactionId: transaction.id, success: success && error === undefined, gasUsed, gasRequired, gasLimit: gasLimits[index], returnData, error, ...failureDiagnostic, ...(success && error !== undefined ? { failureCategory: "postcondition" as const } : {}) });
    if (!success || error !== undefined) break;
  }
  return steps;
}

function simulationFailureKind(failure: unknown): "abort" | "out-of-gas" | "execution" | "source" {
  for (let depth = 0; depth < 8 && failure !== null && typeof failure === "object"; depth += 1) {
    const error = failure as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    if (error.name === "AbortError") return "abort";
    const status = error.status ?? error.statusCode;
    if (typeof status === "number" && status >= 400 && status <= 599) return "source";
    const message = typeof error.details === "string" ? error.details : typeof error.message === "string" ? error.message : "";
    const execution = executionFailure(undefined, { ...error, message });
    if (execution.nativeErrorKind === "out-of-gas" && execution.nativeGasCapped) return "source";
    if (execution.failureCategory === "capacity") return "out-of-gas";
    if (error.code === 3 || error.code === -32000 && /^execution (?:failed|reverted)\b/i.test(message)) return "execution";
    failure = error.cause;
  }
  return "source";
}

function upfrontFundsFailure(failure: unknown): boolean {
  for (let depth = 0; depth < 8 && failure !== null && typeof failure === "object"; depth += 1) {
    const error = failure as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    const status = error.status ?? error.statusCode;
    if (error.name === "AbortError" || typeof status === "number" && status >= 400 && status <= 599 || error.code === 3) return false;
    const message = typeof error.details === "string" ? error.details : typeof error.message === "string" ? error.message : "";
    if (error.code === -38014 || (error.code === undefined || error.code === -32000) && /^insufficient funds\b/i.test(message)) return true;
    failure = error.cause;
  }
  return false;
}

async function waitForkReceipt(client: LifecycleRpcClient, transactionHash: Hex, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const receipt = await lifecycleRpc(client, "eth_getTransactionReceipt", [transactionHash]);
    if (receipt !== null) return rpcObject(receipt, "fork receipt");
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new LifecyclePlanningError("FORK_RECEIPT_TIMEOUT", "The disposable fork did not mine its simulation transaction");
}
async function simulateForkPass(fork: ControlledLifecycleFork, planned: PlannedLaunch, block: LifecycleBlock, transactions: readonly LifecycleTransaction[], gasLimits: readonly bigint[], gasPrice: bigint, measure: boolean, headroomBps: number): Promise<LifecycleSimulationStep[]> {
  if (fork.isolation !== "disposable" || fork.allowTransactions !== true || !fork.sourceRpcUrl || !fork.forkRpcUrl) throw new LifecyclePlanningError("UNSAFE_FORK", "Actual simulation transactions require an explicitly distinct disposable controlled fork");
  const sourceUrl = new URL(fork.sourceRpcUrl);
  const forkUrl = new URL(fork.forkRpcUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"];
  const sourcePort = sourceUrl.port || (sourceUrl.protocol === "https:" ? "443" : "80");
  const forkPort = forkUrl.port || (forkUrl.protocol === "https:" ? "443" : "80");
  if (!loopback.includes(forkUrl.hostname) || sourceUrl.href === forkUrl.href || (loopback.includes(sourceUrl.hostname) && sourcePort === forkPort)) throw new LifecyclePlanningError("UNSAFE_FORK", "Disposable fork must not alias or share the loopback source endpoint");
  let forkBlock = await readLifecycleBlock(fork.client);
  if (fork.sourceRpcUrl !== undefined && forkBlock.hash.toLowerCase() !== block.hash.toLowerCase()) {
    if (block.number > BigInt(Number.MAX_SAFE_INTEGER)) throw new LifecyclePlanningError("FORK_STATE_MISMATCH", "Pinned block is not exactly representable by the fork reset API");
    await lifecycleRpc(fork.client, fork.resetMethod ?? "anvil_reset", [{ forking: { jsonRpcUrl: fork.sourceRpcUrl, blockNumber: Number(block.number) } }]);
    forkBlock = await readLifecycleBlock(fork.client);
  }
  const forkChain = rpcQuantity(await lifecycleRpc(fork.client, "eth_chainId"), "fork chain ID");
  if (forkChain !== planned.chainId || forkChain !== (fork.expectedChainId ?? planned.chainId) || forkBlock.hash.toLowerCase() !== block.hash.toLowerCase() || forkBlock.hash.toLowerCase() !== (fork.expectedBlockHash ?? block.hash).toLowerCase()) throw new LifecyclePlanningError("FORK_STATE_MISMATCH", "Controlled fork must match the exact source chain and pinned latest block before simulation");
  const snapshot = rpcHex(await lifecycleRpc(fork.client, "evm_snapshot"), "fork snapshot");
  const steps: LifecycleSimulationStep[] = [];
  let impersonated = false;
  try {
    if (fork.impersonation !== undefined && fork.impersonation !== "none") {
      await lifecycleRpc(fork.client, `${fork.impersonation}_impersonateAccount`, [planned.account]);
      impersonated = true;
    }
    for (let index = 0; index < transactions.length; index += 1) {
      const transaction = transactions[index];
      let gas = gasLimits[index];
      let gasRequired: bigint | undefined;
      if (transaction === undefined || gas === undefined) throw new LifecyclePlanningError("INVALID_SIMULATION", "Missing fork transaction/gas context");
      try {
        if (measure) {
          const estimated = rpcQuantity(await lifecycleRpc(fork.client, "eth_estimateGas", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: toHex(transaction.value), gasPrice: toHex(gasPrice), ...(transaction.nonce === undefined ? {} : { nonce: toHex(transaction.nonce) }) }]), "fork sequential gas estimate");
          gasRequired = estimated;
          const buffered = (estimated * BigInt(10000 + headroomBps) + 9999n) / 10000n;
          if (buffered < gas) gas = buffered;
        }
        const hash = rpcHex(await lifecycleRpc(fork.client, "eth_sendTransaction", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: toHex(transaction.value), gas: toHex(gas), gasPrice: toHex(gasPrice), ...(transaction.nonce === undefined ? {} : { nonce: toHex(transaction.nonce) }) }]), "fork transaction hash");
        const receipt = await waitForkReceipt(fork.client, hash, fork.receiptTimeoutMs ?? 10_000);
        const gasUsed = rpcQuantity(receipt.gasUsed, "fork gas used");
        if (rpcQuantity(receipt.status, "fork transaction status") !== 1n) {
          steps.push({ transactionId: transaction.id, success: false, gasUsed, gasLimit: gas, error: "Actual fork transaction reverted" });
          break;
        }
        const currentBlock = await readLifecycleBlock(fork.client);
        let returnData: Hex | undefined;
        if (transaction.kind === "atomic" || transaction.kind === "activate") {
          const progressData = rpcHex(await lifecycleRpc(fork.client, "eth_call", [{ to: planned.plan.orchestrator, data: encodeFunctionData({ abi: launchLifecycleAbi, functionName: "readLaunchProgress", args: [planned.launchId] }) }, toHex(currentBlock.number)]), "fork activation progress");
          const progress = decodeFunctionResult({ abi: launchLifecycleAbi, functionName: "readLaunchProgress", data: progressData });
          if (!Array.isArray(receipt.logs)) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Actual fork receipt does not contain canonical launch logs");
          const events = receipt.logs.flatMap((raw) => {
            const log = rpcObject(raw, "fork activation log");
            if (rpcHex(log.address, "fork log emitter").toLowerCase() !== planned.plan.orchestrator.toLowerCase()) return [];
            if (!Array.isArray(log.topics)) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Actual fork log topics are malformed");
            try { return [decodeEventLog({ abi: launchLifecycleAbi, data: rpcHex(log.data, "fork log data"), topics: log.topics.map((topic) => rpcHex(topic, "fork log topic")) as [Hex, ...Hex[]] })]; }
            catch { return []; }
          });
          const activated = events.filter((event) => event.eventName === "LaunchActivated");
          const buys = events.filter((event) => event.eventName === "InitialBuyExecuted");
          if (activated.length !== 1 || !activated.some((event) => event.eventName === "LaunchActivated" && event.args.launchId.toLowerCase() === planned.launchId.toLowerCase() && event.args.planHash.toLowerCase() === planned.planHash.toLowerCase() && event.args.token.toLowerCase() === planned.predictedToken.toLowerCase()) ||
            progress.phase !== LifecyclePhase.Active || progress.planHash.toLowerCase() !== planned.planHash.toLowerCase() || progress.token.toLowerCase() !== planned.predictedToken.toLowerCase() || progress.marketCount !== planned.plan.markets.length || progress.positionCount !== committedPositionCount(planned.plan) ||
            buys.length !== planned.plan.buys.length) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Actual fork activation differs from the exact committed launch");
          const quoteSpent: bigint[] = []; const tokenOut: bigint[] = [];
          for (let buyIndex = 0; buyIndex < buys.length; buyIndex += 1) {
            const event = buys[buyIndex]; const buy = planned.plan.buys[buyIndex];
            if (event?.eventName !== "InitialBuyExecuted" || buy === undefined || event.args.launchId.toLowerCase() !== planned.launchId.toLowerCase() ||
              event.args.buyIndex !== buyIndex || event.args.marketIndex !== buy.marketIndex || event.args.recipient.toLowerCase() !== buy.recipient.toLowerCase() ||
              event.args.quoteAsset.toLowerCase() !== planned.plan.markets[buy.marketIndex]?.quoteAsset.toLowerCase() ||
              event.args.quoteSpent > buy.quoteAmountIn || event.args.tokenOut < buy.minTokenOut) throw new LifecyclePlanningError("POSTCONDITION_FAILED", "Actual fork initial buy differs from its committed index, budget, destination or minimum");
            quoteSpent.push(event.args.quoteSpent); tokenOut.push(event.args.tokenOut);
          }
          returnData = encodeFunctionResult({ abi: launchLifecycleAbi, functionName: transaction.kind === "atomic" ? "launchAtomic" : "activateLaunch", result: {
            launchId: planned.launchId, planHash: progress.planHash, token: progress.token, feeHub: progress.feeHub, rewards: progress.rewards,
            marketCount: progress.marketCount, positionCount: progress.positionCount, quoteSpent, tokenOut,
          } });
        }
        for (const condition of transaction.postconditions) {
          const request = conditionRequest(condition, planned);
          const data = rpcHex(await lifecycleRpc(fork.client, "eth_call", [{ ...request, from: planned.account }, toHex(currentBlock.number)]), "fork postcondition");
          checkCondition(condition, data, planned);
        }
        steps.push({ transactionId: transaction.id, success: true, gasUsed, gasLimit: gas, gasRequired, returnData });
      } catch (failure) {
        steps.push({ transactionId: transaction.id, success: false, gasLimit: gas, error: lifecycleFailureReason(failure) });
        break;
      }
    }
    return steps;
  } finally {
    try {
      if (impersonated && fork.impersonation !== undefined) await lifecycleRpc(fork.client, `${fork.impersonation}_stopImpersonatingAccount`, [planned.account]);
    } finally {
      if (await lifecycleRpc(fork.client, "evm_revert", [snapshot]) !== true) throw new LifecyclePlanningError("FORK_CLEANUP_FAILED", "Disposable fork snapshot could not be reverted; do not reuse this RPC");
    }
  }
}

type SimulationObservations = [LifecycleLimitObservation, unknown, unknown, unknown];
/** Internal, operation-local fee envelope for the already matched immediate step. */
export type NextTransactionEnvelope = Readonly<{ gas: bigint; gasPrice: bigint }>;
/** Compute-only sizing observations; native poster charges are never included. */
export type GasSizingHints = ReadonlyMap<string, bigint>;
export type PreparedLaunchSimulation = ((transactions: readonly LifecycleTransaction[], nextEnvelope?: NextTransactionEnvelope) => Promise<LifecycleSimulation>) & {
  /** Unadmitted diagnostic results only; final measurement validates exact calldata. */
  measure(transactions: readonly LifecycleTransaction[]): Promise<LifecycleSimulation>;
  close(): void;
};

function observedFields<T extends object>(value: T): () => boolean {
  const keys = Object.keys(value) as (keyof T)[];
  const values = keys.map((key) => value[key]);
  return () => keys.length === Object.keys(value).length && keys.every((key, index) => value[key] === values[index]);
}

/** Internal continuation owned by one SDK read invocation. Only its positive
 * capability proof is reused; every candidate executes its entire economic sequence. */
export function prepareLaunchSimulation(options: SimulateLaunchPlanOptions, block: LifecycleBlock, hasTransactions = true, reviewedEnvelope?: NextTransactionEnvelope, selectedGasPrice?: bigint, sizing?: GasSizingHints): PreparedLaunchSimulation {
  const { client, planned, fork } = options;
  const signal = options.signal;
  if (signal?.aborted) throw Object.assign(new Error("Lifecycle simulation cancelled"), { name: "AbortError" });
  const sourceClient = lifecycleSourceClient(client), sourceRequest = sourceClient.request;
  const sourceBatching = sourceClient.supportsReadBatching;
  const reusable = assertLifecycleReadClientOpen(client);
  const plan = planned.plan, planHash = planned.planHash, launchId = planned.launchId;
  const optionsLimits = options.limits, plannedLimits = planned.limits;
  const policy = optionsLimits === undefined ? plannedLimits : optionsLimits;
  const blockMatches = observedFields(block);
  const forkMatches = fork === undefined ? undefined : observedFields(fork);
  const forkRequest = fork?.client.request;
  const plannedMatches = observedFields(planned);
  const context: LifecycleLimitContext = Object.freeze({ client, account: planned.account, orchestrator: plan.orchestrator, block: Object.freeze({ ...block }), chainId: planned.chainId });
  let closed = false, active = false, consumed = false, capabilityProved = false;
  let capabilityPending: Promise<void> | undefined;
  const assertContext = () => {
    if (closed) throw new LifecyclePlanningError("INVALID_SIMULATION", "Prepared simulation continuation has closed");
    if (signal?.aborted) throw Object.assign(new Error("Lifecycle simulation cancelled"), { name: "AbortError" });
    assertLifecycleReadClientOpen(client);
    if (options.client !== client || options.planned !== planned || options.limits !== optionsLimits || options.fork !== fork || options.signal !== signal ||
      lifecycleSourceClient(client) !== sourceClient || sourceClient.request !== sourceRequest || !plannedMatches() || !blockMatches() ||
      sourceClient.supportsReadBatching !== sourceBatching ||
      planned.plan !== plan || planned.account !== context.account || plan.orchestrator !== context.orchestrator || planned.chainId !== context.chainId ||
      planned.limits !== plannedLimits || forkMatches !== undefined && !forkMatches() || fork?.client.request !== forkRequest) {
      throw new LifecyclePlanningError("LIMIT_CONTEXT_MISMATCH", "Prepared simulation differs from its source/account/core/plan/header/policy context");
    }
    if (hashLaunchPlan(plan).toLowerCase() !== planHash.toLowerCase() || hashLaunchIdentity(plan).toLowerCase() !== launchId.toLowerCase()) {
      throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed after its simulation context was bound");
    }
    if (planned.ufg !== undefined && hashUfgLaunchConfig(planned.ufg.config) !== planned.ufg.configHash) throw new LifecyclePlanningError("PLAN_MUTATED", "UFG treasury config changed after its simulation context was bound");
  };
  const pending = (async () => {
    if (fork !== undefined && lifecycleSourceClient(fork.client) === sourceClient) throw new LifecyclePlanningError("UNSAFE_FORK", "Source RPC must never receive controlled simulation transactions/snapshots/resets");
    return lifecycleStage(client, "simulation.context", () => Promise.all([
      resolveLifecycleLimits(context, policy),
      readLifecycleChainId(client),
      lifecycleSessionRead(client, `${planned.chainId}:account-code:${context.account.toLowerCase()}`, () => lifecyclePinnedRpc(client, "eth_getCode", [context.account, toHex(context.block.number)], context.block)),
      hasTransactions && reviewedEnvelope === undefined ? selectedGasPrice ?? readLifecycleGasPrice(client) : undefined,
    ]));
  })().then((observations) => ({ observations }), (failure: unknown) => ({ failure }));
  // Refused inputs may discard this read-only preparation before it settles.
  // Its rejection is handled immediately; no capability or economic work starts.
  const run = async (transactions: readonly LifecycleTransaction[], diagnostic: boolean, nextEnvelope?: NextTransactionEnvelope): Promise<LifecycleSimulation> => {
    if (active || consumed && !reusable || !hasTransactions && transactions.length !== 0) {
      closed = true;
      throw new LifecyclePlanningError("INVALID_SIMULATION", "Prepared candidates require sequential consumption by their SDK invocation owner");
    }
    active = true;
    consumed = true;
    try {
      assertContext();
      const envelopeMatches = nextEnvelope === undefined ? undefined : observedFields(nextEnvelope);
      const candidates = transactions.map((transaction) => ({
        transaction, matches: observedFields(transaction),
        dependencies: [...transaction.dependencies],
        conditions: transaction.postconditions.map((condition) => ({ condition, matches: observedFields(condition) })),
      }));
      const result = await pending;
      if ("failure" in result) throw result.failure;
      const assertCurrent = () => {
        assertContext();
        result.observations[0].assertCurrent();
        if (envelopeMatches !== undefined && !envelopeMatches()) throw new LifecyclePlanningError("INVALID_SIMULATION", "Reviewed gas envelope changed during its complete economic proof");
        if (transactions.length !== candidates.length || candidates.some(({ transaction, matches, dependencies, conditions }, index) =>
          transactions[index] !== transaction || !matches() || transaction.dependencies.length !== dependencies.length ||
          dependencies.some((dependency, ordinal) => transaction.dependencies[ordinal] !== dependency) ||
          transaction.postconditions.length !== conditions.length || conditions.some(({ condition, matches: conditionMatches }, ordinal) =>
            transaction.postconditions[ordinal] !== condition || !conditionMatches()))) {
          throw new LifecyclePlanningError("INVALID_SIMULATION", "Candidate transactions changed during their complete economic proof");
        }
      };
      assertCurrent();
      const proveBackend = async (limits: ResolvedLifecycleLimits, gasPrice: bigint) => {
        assertCurrent();
        if (capabilityProved) return;
        if (capabilityPending === undefined) {
          const key = `${context.chainId}:nitro-backend`;
          const nativeProof = lifecycleSessionRead(client, key, () =>
            lifecycleStage(client, "simulation.nitro", () => proveNitroBackend(client, planned, context.block, limits, gasPrice)));
          const proof = nativeProof.then(() => {
            assertContext();
            result.observations[0].assertCurrent();
            capabilityProved = true;
          });
          capabilityPending = proof;
          void proof.then(
            () => { if (capabilityPending === proof) capabilityPending = undefined; },
            () => { if (capabilityPending === proof) capabilityPending = undefined; },
          );
        }
        await capabilityPending;
        assertCurrent();
      };
      const simulation = await simulateLaunchTransactionsWithContext(options, transactions, context, result.observations, proveBackend, assertCurrent, diagnostic, nextEnvelope, selectedGasPrice, sizing);
      assertCurrent();
      registerLifecycleFinalCheck(client, result.observations[0].assertCurrent);
      return simulation;
    } catch (failure) {
      closed = true;
      capabilityProved = false;
      capabilityPending = undefined;
      throw failure;
    } finally { active = false; }
  };
  const simulate: PreparedLaunchSimulation = Object.assign(
    (transactions: readonly LifecycleTransaction[], nextEnvelope?: NextTransactionEnvelope) => run(transactions, false, nextEnvelope),
    { measure: (transactions: readonly LifecycleTransaction[]) => run(transactions, true),
      close() { closed = true; capabilityProved = false; capabilityPending = undefined; } },
  );
  return simulate;
}

export async function simulateLaunchTransactions(options: SimulateLaunchPlanOptions, transactions: readonly LifecycleTransaction[], pinnedBlock?: LifecycleBlock, nextEnvelope?: NextTransactionEnvelope, sizing?: GasSizingHints): Promise<LifecycleSimulation> {
  // Standalone calls always produce fresh context, including live chain and fees.
  if (options.fork !== undefined && lifecycleSourceClient(options.fork.client) === lifecycleSourceClient(options.client)) throw new LifecyclePlanningError("UNSAFE_FORK", "Source RPC must never receive controlled simulation transactions/snapshots/resets");
  const block = pinnedBlock ?? await readLifecycleBlock(options.client);
  const prepared = prepareLaunchSimulation(options, block, transactions.length !== 0, nextEnvelope, undefined, sizing);
  try { return await prepared(transactions, nextEnvelope); }
  finally { prepared.close(); }
}

async function simulateLaunchTransactionsWithContext(
  options: SimulateLaunchPlanOptions,
  transactions: readonly LifecycleTransaction[],
  context: LifecycleLimitContext,
  observations: SimulationObservations,
  proveBackend: (limits: ResolvedLifecycleLimits, gasPrice: bigint) => Promise<void>,
  assertCurrent: () => void,
  diagnostic: boolean,
  nextEnvelope?: NextTransactionEnvelope,
  selectedGasPrice?: bigint,
  sizing?: GasSizingHints,
): Promise<LifecycleSimulation> {
  const { client, planned } = options;
  const sourceClient = lifecycleSourceClient(client);
  const { block } = context;
  const [{ limits, configuration }, chainId, accountCodeValue, gasPriceValue] = observations;
  const base = { confidence: "stateful" as const, executionProof: "failed" as const, protocolFit: "unknown" as const, transportPreflight: "not-requested" as const, blockNumber: block.number, blockHash: block.hash, account: planned.account, chainId: planned.chainId, limits, deferredTransactionIds: [] as string[] };
  if (chainId !== planned.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain changed before sequential simulation");
  const accountCode = rpcHex(accountCodeValue, "account code");
  if (accountCode !== "0x") {
    
    return { ...base, confidence: "provisional", executionProof: "unavailable", backend: "unavailable", admitted: false, steps: [], reason: "Direct EOA transaction simulation cannot prove smart-account signature/execution behavior" };
  }
  for (const transaction of transactions) {
    if (transaction.from.toLowerCase() !== planned.account.toLowerCase() || BigInt(transaction.chainId) !== planned.chainId) throw new LifecyclePlanningError("ACCOUNT_MISMATCH", "Simulation transaction differs from the committed chain/account");
    if (limits.maxCalldataBytes !== undefined && (transaction.data.length - 2) / 2 > limits.maxCalldataBytes) {
      
      return { ...base, executionProof: "unavailable", protocolFit: "failed", backend: "unavailable", admitted: false, steps: [], failedTransactionId: transaction.id, failureCategory: "capacity", capacityConstraint: "calldata", reason: "Exact calldata exceeds the supplied chain/account/RPC byte cap" };
    }
  }
  if (transactions.length === 0) {  return { ...base, executionProof: "proved", protocolFit: "proved", backend: "unavailable", admitted: true, steps: [] }; }
  if (nextEnvelope !== undefined && (transactions.length !== 1 || typeof nextEnvelope.gas !== "bigint" || nextEnvelope.gas <= 0n || nextEnvelope.gas >= 1n << 64n ||
    typeof nextEnvelope.gasPrice !== "bigint" || nextEnvelope.gasPrice < 0n || nextEnvelope.gasPrice >= 1n << 256n)) {
    throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Reviewed replay requires one immediate transaction with exact uint64 gas and uint256 price");
  }
  const allTransactions = transactions;
  if (limits.maxSimulationGas !== undefined && nextEnvelope === undefined) {
    let estimatedGas = 0n, count = 0;
    for (const transaction of transactions) {
      estimatedGas += transactionGasEstimate(planned.plan, transaction);
      if (estimatedGas > limits.maxSimulationGas) break;
      count += 1;
    }
    transactions = transactions.slice(0, count);
    base.deferredTransactionIds = allTransactions.slice(count).map((transaction) => transaction.id);
    if (count === 0) {
      const computeCap = limits.transactionGasCeiling !== undefined && limits.transactionGasCeiling < limits.executionGasCeiling ? limits.transactionGasCeiling : limits.executionGasCeiling;
      const exceedsCompute = estimatedGas > computeCap;
      const gasInMillions = (gas: bigint) => {
        const tenths = (gas + 50_000n) / 100_000n;
        return `${tenths / 10n}.${tenths % 10n}`;
      };
      const atomic = allTransactions[0]!.kind === "atomic";
      const reason = exceedsCompute
        ? `${atomic ? "Atomic launch" : "Immediate transaction"} needs about ${gasInMillions(estimatedGas)}M gas, above the ${gasInMillions(computeCap)}M per-transaction limit${atomic ? "; use staged" : ""}`
        : "The immediate transaction estimate exceeds the RPC aggregate simulation gas cap; no prefix can be proved";
      
      return { ...base, confidence: "provisional", executionProof: "unavailable", backend: "unavailable", admitted: false, steps: [], failureCategory: "capacity", capacityConstraint: exceedsCompute ? "compute" : "simulation-gas", reason };
    }
  }
  const recommendedGasPrice = nextEnvelope === undefined ? typeof gasPriceValue === "bigint" ? gasPriceValue : rpcQuantity(gasPriceValue, "gas price") : nextEnvelope.gasPrice;
  // New recommendations cover lagging quotes; reviewed fees are replayed unchanged
  // under natural child fees, never refreshed or silently increased.
  const baseFeeEnvelope = (block.baseFeePerGas ?? 0n) * 2n;
  const gasPrice = nextEnvelope?.gasPrice ?? selectedGasPrice ?? (recommendedGasPrice > baseFeeEnvelope ? recommendedGasPrice : baseFeeEnvelope);
  if (gasPrice >= 1n << 256n) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Gas price must be a uint256 quantity");
  const buffer = (gas: bigint) => (gas * BigInt(10000 + limits.headroomBps) + 9999n) / 10000n;
  const posterGas: bigint[] = [];
  if (limits.protocol === "nitro") {
    try {
      const [, estimates] = await Promise.all([
        proveBackend(limits, gasPrice),
        !diagnostic && nextEnvelope === undefined ? lifecycleStage(client, "simulation.poster", async () => [buffer((await readNitroPosterGas(transactions[0]!, context)).posterGas)]) : [],
      ]);
      posterGas.push(...estimates);
    } catch (failure) {
      if (simulationFailureKind(failure) === "abort") throw failure;
      assertCurrent();
      
      return { ...base, confidence: "provisional", executionProof: "unavailable", backend: "unavailable", admitted: false, steps: [], reason: `Native Nitro compute/poster proof unavailable: ${lifecycleFailureReason(failure)}. Generic Anvil/Hardhat forks cannot prove ArbOS metering.` };
    }
  }
  assertCurrent();
  const discoveryGas = transactions.map(() => {
    const total = limits.protocol === "nitro" ? limits.maxSimulationGas ?? block.gasLimit : limits.executionGasCeiling;
    const capped = limits.transactionGasCeiling !== undefined && limits.transactionGasCeiling < total ? limits.transactionGasCeiling : total;
    if (capped <= 0n || capped >= 1n << 64n) throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Compute/poster envelope exceeds uint64 gas");
    return capped;
  });
  if (discoveryGas[0]! * gasPrice + transactions[0]!.value >= 1n << 256n) throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Transaction value and fee envelope exceed uint256");
  const balance = rpcQuantity(await lifecyclePinnedRpc(client, "eth_getBalance", [planned.account, toHex(block.number)], block), "creator native balance");
  let measured: LifecycleSimulationStep[] = [];
  const hasSizing = !diagnostic && transactions.every((transaction) => sizing?.has(transaction.id));
  let backend: "eth_simulateV1" | "controlled-fork" = (nextEnvelope !== undefined || hasSizing) && limits.protocol === "evm" && options.fork !== undefined ? "controlled-fork" : "eth_simulateV1";
  if (nextEnvelope === undefined && !hasSizing) {
    // Nitro checks upfront funds even with validation:false. Bound discovery
    // budgets before dispatch, without overriding the payer's real balance.
    const value = transactions.reduce((total, transaction) => total + transaction.value, 0n);
    let available = balance - value;
    if (gasPrice !== 0n) available /= gasPrice;
    const sizingGas = discoveryGas.map((ceiling, index) => {
      // Upfront reservation is per call; unused gas is refunded before the next.
      const computeAndPoster = limits.executionGasCeiling + (posterGas[index] ?? 0n);
      const capped = computeAndPoster < ceiling ? computeAndPoster : ceiling;
      return gasPrice === 0n || capped < available ? capped : available;
    });
    if (balance < value || sizingGas.some((gas) => gas <= 0n)) return { ...base, executionProof: "unavailable", backend, admitted: false, steps: [], failureCategory: "affordability", reason: "Creator native balance cannot fund transaction value and sizing fee budgets" };
    assertCurrent();
    try {
      try {
        measured = await lifecycleStage(client, "simulation.measure", () => simulateRpcPass(client, planned, block, transactions, sizingGas, limits, gasPrice, false));
      } catch (failure) {
        if (!upfrontFundsFailure(failure)) throw failure;
        assertCurrent();
        let remaining = available;
        const sharedGas = sizingGas.map((ceiling, index) => {
          if (gasPrice === 0n) return ceiling;
          const share = remaining / BigInt(transactions.length - index);
          const gas = ceiling < share ? ceiling : share;
          remaining -= gas;
          return gas;
        });
        measured = await lifecycleStage(client, "simulation.measure", () => simulateRpcPass(client, planned, block, transactions, sharedGas, limits, gasPrice, false));
      }
    } catch (failure) {
      if (upfrontFundsFailure(failure)) return { ...base, confidence: "provisional", executionProof: "unavailable", backend, admitted: false, steps: [], failureCategory: "affordability", reason: "Native balance cannot cover the sequential sizing fee envelopes" };
      const kind = simulationFailureKind(failure);
      if (kind === "abort") throw failure;
      assertCurrent();
      if (options.fork === undefined || limits.protocol === "nitro" || kind !== "source") {
        return { ...base, confidence: "provisional", executionProof: "unavailable", backend: "unavailable", admitted: false, steps: [], reason: `Stateful sequential RPC simulation unavailable: ${lifecycleFailureReason(failure)}. ${limits.protocol === "nitro" ? "Generic Anvil/Hardhat forks cannot prove ArbOS compute/poster metering." : "Dependent eth_call estimates are not proof."}` };
      }
      backend = "controlled-fork";
      measured = await simulateForkPass(options.fork, planned, block, transactions, sizingGas, gasPrice, true, limits.headroomBps);
    }
    assertCurrent();
    const failedIndex = measured.findIndex((step) => !step.success);
    if (failedIndex >= 0 && limits.maxSimulationGas !== undefined &&
      measured.reduce((gas, step) => gas + (step.gasUsed ?? 0n), 0n) * 100n >= limits.maxSimulationGas * 95n) {
      // The provider exhausted its aggregate used-gas budget, not the contract.
      // Preserve only actual successful results; the failed call is deferred too.
      measured = measured.slice(0, failedIndex);
      transactions = transactions.slice(0, failedIndex);
      base.deferredTransactionIds = allTransactions.slice(failedIndex).map((transaction) => transaction.id);
      if (transactions.length === 0) {
        
        return { ...base, confidence: "provisional", executionProof: "unavailable", backend, admitted: false, steps: [], failureCategory: "source", reason: "RPC aggregate simulation gas cap left no successful prefix to prove" };
      }
    }
    const failed = measured.find((step) => !step.success);
    if (diagnostic && failed !== undefined) return { ...base, backend, admitted: false, steps: measured, reason: failed.error, failedTransactionId: failed.transactionId, failureCategory: failed.failureCategory ?? "opaque", capacityConstraint: failed.failureCategory === "capacity" ? "compute" : undefined };
    if (diagnostic) {
      
      return { ...base, backend, admitted: false, executionProof: "unavailable", steps: measured };
    }
  }
  const sizedTransactions = measured.length === 0 ? transactions : transactions.slice(0, measured.length);
  const minimumGas = sizedTransactions.map((transaction, index) => {
    return nextEnvelope !== undefined ? 0n : hasSizing ? sizing!.get(transaction.id)! : measured[index]!.gasRequired ?? measured[index]!.gasUsed!;
  });
  const gasLimits = nextEnvelope === undefined ? sizedTransactions.map((transaction, index) => {
    // Suffix budgets prove feasibility, not a future transaction's fee estimate.
    if (index > 0) return discoveryGas[index]!;
    const gross = minimumGas[index]!;
    const reserve = transaction.kind === "activate" || transaction.kind === "atomic" ? hmmV2ForwardingReserve(planned.plan) : 0n;
    const buffered = gross + reserve > buffer(gross) ? gross + reserve : buffer(gross);
    const desired = buffered + (posterGas[0] ?? 0n);
    return desired < discoveryGas[index]! ? desired : discoveryGas[index]!;
  }) : [nextEnvelope.gas];
  if (gasLimits[0]! * gasPrice + transactions[0]!.value >= 1n << 256n) throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Transaction value and fee envelope exceed uint256");
  const validate = nextEnvelope !== undefined || measured.every((step) => step.success);
  if (nextEnvelope === undefined) {
    const value = transactions.reduce((total, transaction) => total + transaction.value, 0n);
    let available = balance - value;
    let suffixMinimum = minimumGas.slice(1).reduce((total, gas) => total + gas, 0n);
    if (gasPrice !== 0n) available /= gasPrice;
    for (let index = 0; index < gasLimits.length && gasPrice !== 0n; index += 1) {
      const minimum = minimumGas[index]!;
      if (index > 0) suffixMinimum -= minimum;
      const budget = index === 0 ? available - suffixMinimum : minimum + (available - minimum - suffixMinimum) / BigInt(gasLimits.length - index);
      if (gasLimits[index]! > budget) gasLimits[index] = budget;
      available -= gasLimits[index]!;
    }
    if (balance < value || gasLimits.some((gas, index) => gas <= 0n && minimumGas[index]! > 0n)) return { ...base, executionProof: "unavailable", backend, admitted: false, steps: measured, failureCategory: "affordability", reason: "Creator native balance cannot fund transaction value and execution fee envelopes" };
  }
  const exceeds = gasLimits.findIndex((gas, index) =>
    gas <= 0n || gas >= 1n << 64n || limits.transactionGasCeiling !== undefined && gas > limits.transactionGasCeiling ||
    nextEnvelope === undefined && !hasSizing && (measured[index]!.gasRequired ?? measured[index]!.gasUsed!) > gas ||
    limits.protocol === "evm" && gas > limits.executionGasCeiling);
  if (exceeds >= 0) {
    
    return { ...base, executionProof: "unavailable", protocolFit: "failed", backend, admitted: false, steps: measured, failureCategory: "capacity", capacityConstraint: "gas-envelope", reason: "Measured execution or reviewed gas exceeds the current compute/complete transaction envelope", failedTransactionId: transactions[exceeds]?.id };
  }
  // Size first, then prove and return this exact executable envelope. Diagnostic
  // gas budgets and caller-held proposals are never execution admission.
  let verifiedSteps = measured;
  if (validate) {
    try {
      verifiedSteps = await lifecycleStage(client, "simulation.measure", () => backend === "eth_simulateV1"
        ? simulateRpcPass(client, planned, block, transactions, gasLimits, limits, gasPrice, true)
        : simulateForkPass(options.fork!, planned, block, transactions, gasLimits, gasPrice, false, limits.headroomBps));
    } catch (failure) {
      if (simulationFailureKind(failure) === "abort") throw failure;
      assertCurrent();
      return { ...base, backend: "unavailable", confidence: "provisional", executionProof: "unavailable", admitted: false, steps: [], reason: `Exact transaction simulation unavailable: ${lifecycleFailureReason(failure)}` };
    }
  }
  assertCurrent();
  const finalFailure = verifiedSteps.find((step) => !step.success);
  const estimates: LifecycleSimulationStep[] = [];
  let remainingBalance = finalFailure === undefined ? balance : undefined;
  let affordabilityFailure: string | undefined;
  const feeContext = configuration.estimateDataFee === undefined || sourceClient === client ? context : { ...context, client: sourceClient };
  for (let index = 0; index < verifiedSteps.length; index += 1) {
    const step = verifiedSteps[index]; const transaction = transactions[index]; const gasLimit = gasLimits[index];
    if (step === undefined || transaction === undefined || gasLimit === undefined) throw new LifecyclePlanningError("INVALID_SIMULATION", "Missing verified fee context");
    if (index > 0) { estimates.push({ ...step, computeGasRequired: minimumGas[index], provisional: true }); continue; }
    const dataFee = limits.protocol === "nitro" ? 0n : configuration.estimateDataFee === undefined ? undefined : await configuration.estimateDataFee({ ...transaction, gas: gasLimit, gasPrice }, feeContext);
    if (dataFee !== undefined && (typeof dataFee !== "bigint" || dataFee < 0n || dataFee >= 1n << 256n)) throw new LifecyclePlanningError("INVALID_DATA_FEE", "Data-fee oracle must return a nonnegative uint256 bigint amount");
    // Nitro gas includes poster charges. Never add the quoted poster fee again.
    const executionFee = gasLimit * gasPrice;
    const required = transaction.value + executionFee + (dataFee ?? 0n);
    if (required >= 1n << 256n) throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Transaction value and fee envelope exceed uint256");
    if (remainingBalance !== undefined) {
      if (required > remainingBalance && affordabilityFailure === undefined) affordabilityFailure = "Creator native balance cannot fund the remaining transaction value and execution/data fee envelopes";
      remainingBalance -= required;
    }
    const poster = posterGas[index];
    estimates.push({ ...step, computeGasRequired: nextEnvelope === undefined ? minimumGas[index] : undefined, estimate: { gasUsed: step.gasUsed ?? 0n, gasLimit, gasPrice, executionFee, dataFee, posterGas: poster, posterFee: poster === undefined ? undefined : poster * gasPrice, dataFeeIncludedInGas: limits.protocol === "nitro", totalFee: dataFee === undefined ? undefined : executionFee + dataFee, feeConfidence: dataFee === undefined ? "execution-only" : "execution-and-data" } });
  }
  
  return { ...base, backend, executionProof: finalFailure === undefined ? "proved" : "failed", protocolFit: finalFailure === undefined ? "proved" : "unknown", admitted: finalFailure === undefined && affordabilityFailure === undefined, steps: estimates, reason: finalFailure?.error ?? affordabilityFailure, failedTransactionId: finalFailure?.transactionId, failureCategory: finalFailure?.failureCategory ?? (affordabilityFailure === undefined ? undefined : "affordability"), capacityConstraint: finalFailure?.failureCategory === "capacity" ? "compute" : undefined };
}

