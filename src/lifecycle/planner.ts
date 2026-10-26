import { encodeFunctionData, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { ABYSS_FEE_TIERS } from "../abyss.js";
import { assertLaunchTopologyCoverage, getTickAtSqrtRatio } from "../launch.js";
import { launchLifecycleAbi, lifecycleAdapterAbi, lifecycleErc20Abi } from "./abi.js";
import { hashLaunchIdentity, hashLaunchPlan, LifecycleFundingKind, LifecyclePhase, LifecycleRewardMode, LifecycleTokenKind, LIFECYCLE_MAX_REWARD_ERC20_SUPPLY, LIFECYCLE_MAX_ERC404_SUPPLY, parseLaunchPlan, serializeLaunchPlan, type LaunchPlanV1 } from "./schema.js";
import { readLaunchProgress, readLifecycleHeadProgress, readLifecycleProfiles, readLifecycleTokenAtBlock, readPoolBoundHookDeployment } from "./progress.js";
import { decodeAbyssLifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig, decodeV4LifecycleMarketConfig, encodePoolBoundV4LifecycleMarketConfig, isPoolBoundV4ConfigVersion, minePoolBoundHookSalt, type AbyssLifecycleMarketConfig, type V4LifecycleMarketConfig, type V4PoolBoundLifecycleMarketConfig } from "./markets.js";
import { assertLifecycleBlock, assertLifecycleReadClientOpen, lifecycleFailureReason, lifecyclePinnedRpc, lifecycleStaticRpc, lifecycleRpc, lifecycleStage, readLifecycleBlock, readLifecycleChainId, readLifecycleContract, readLifecycleGasPrice, resolveLifecycleLimits, rpcHex, rpcQuantity, withLifecycleReadClient } from "./rpc.js";
import { prepareLaunchSimulation, simulateLaunchTransactions, type NextTransactionEnvelope } from "./simulation.js";
import { LifecyclePlanningError, type BuildNextTransactionOptions, type CanonicalLaunchProgress, type LifecycleBlock, type LifecycleConstructionProfile, type LifecycleFundingPrerequisite, type LifecyclePoolBoundHookDeployment, type LifecycleProfile, type LifecycleRpcClient, type LifecycleSimulation, type LifecycleTransaction, type PlannedLaunch, type PlanLaunchOptions, type PrepareAndPlanLifecycleLaunchOptions, type SimulateLaunchPlanOptions } from "./types.js";
import { deriveKnownPoolBoundHookDeployment, protectOrderedBuyMinimums, validateBuySlippageBps } from "./calibration.js";
import { getKnownLifecycleDeployment, getKnownLifecycleProfile } from "./presets.js";
import { buildLaunchTransactions, packPreparationBatches } from "./transactions.js";
import { assertLifecycleMarketAllocation, assertLifecycleSupplyAllocation } from "./allocations.js";
import { assertUfgLaunchAccount, hashUfgLaunchConfig, UFG_LAUNCH_PROXY_ADDRESS } from "./ufg-config.js";
import { buildUfgLaunchTransactions, buildUfgCancelTransaction, validateUfgLaunchPlan } from "./ufg.js";

type ValidatedPlanShape = {
  commitment: Hex;
  ufgConfigHash?: Hex;
  marketConfigs: (AbyssLifecycleMarketConfig | V4LifecycleMarketConfig | V4PoolBoundLifecycleMarketConfig)[];
};

function validatePlanShape(plan: LaunchPlanV1): ValidatedPlanShape {
  // Encoding checks all exact integer widths, addresses, byte strings and tuple fields.
  const commitment = hashLaunchPlan(plan);
  if (plan.markets.length === 0 || plan.markets.length > 16 || plan.buys.length > 64 || plan.funding.length > 8 || plan.feeAssets.length === 0 || plan.feeAssets.length > 8 || plan.token.supply <= 0n || plan.token.inventoryRecipient === zeroAddress || plan.token.inventoryRecipient.toLowerCase() === plan.orchestrator.toLowerCase() || plan.executorFeeBps > 1000) throw new LifecyclePlanningError("INVALID_PLAN", "Plan exceeds lifecycle bounds or lacks positive token economics");
  if ((plan.token.kind === LifecycleTokenKind.ERC404 && plan.token.supply > LIFECYCLE_MAX_ERC404_SUPPLY) || (plan.token.kind === LifecycleTokenKind.ERC20 && plan.token.rewardMode !== LifecycleRewardMode.None && plan.token.supply > LIFECYCLE_MAX_REWARD_ERC20_SUPPLY)) throw new LifecyclePlanningError("INVALID_TOKEN_SUPPLY", "Reward-enabled ERC20 supply must not exceed 10^77; ERC404 supply must fit uint96; reward-free ERC20 retains uint256");
  const encoder = new TextEncoder();
  if (encoder.encode(plan.token.name).length === 0 || encoder.encode(plan.token.name).length > 128 || encoder.encode(plan.token.symbol).length === 0 || encoder.encode(plan.token.symbol).length > 32 || encoder.encode(plan.token.metadataURI).length > 2048) throw new LifecyclePlanningError("INVALID_PLAN", "Token metadata exceeds the committed byte bounds");
  let previous = 0n;
  for (const policy of plan.feeAssets) {
    if (BigInt(policy.asset) <= previous || policy.ownerBps + policy.rewardsBps + policy.burnBps !== 10000) throw new LifecyclePlanningError("INVALID_FEE_POLICY", "Fee assets must be unique ascending addresses with fractions summing to 10000");
    previous = BigInt(policy.asset);
  }
  if (plan.feeAssets.some((policy) => policy.rewardsBps !== 0) !== (plan.token.rewardMode !== LifecycleRewardMode.None)) throw new LifecyclePlanningError("INVALID_FEE_POLICY", "Reward-enabled tokens require a rewards share; reward-free tokens cannot commit rewards shares");
  previous = 0n;
  for (const funding of plan.funding) {
    if (BigInt(funding.asset) <= previous || funding.amount <= 0n || funding.inputAmount <= 0n) throw new LifecyclePlanningError("INVALID_FUNDING", "Funding output assets must be positive, unique and ascending");
    if (funding.kind !== LifecycleFundingKind.Swap && (funding.inputAsset.toLowerCase() !== funding.asset.toLowerCase() || funding.inputAmount !== funding.amount || funding.target !== zeroAddress || funding.data !== "0x")) throw new LifecyclePlanningError("INVALID_FUNDING", "ERC20 and native-wrap funding must use the exact output asset/amount and no target call");
    if (funding.kind === LifecycleFundingKind.Swap && (funding.inputAsset.toLowerCase() === funding.asset.toLowerCase() || funding.data === "0x" || (funding.data.length - 2) / 2 > 16384)) throw new LifecyclePlanningError("INVALID_FUNDING", "Conversion funding must change assets and commit bounded nonempty calldata");
    previous = BigInt(funding.asset);
  }
  for (const buy of plan.buys) {
    if (buy.marketIndex >= plan.markets.length || buy.quoteAmountIn <= 0n || buy.minTokenOut <= 0n || buy.recipient === zeroAddress || buy.recipient.toLowerCase() === plan.orchestrator.toLowerCase()) throw new LifecyclePlanningError("INVALID_BUY", "Every ordered buy requires a committed market, positive budget/minimum, and external recipient");
  }
  const v4Quotes = new Set<string>();
  let positionCount = 0;
  const marketConfigs: ValidatedPlanShape["marketConfigs"] = [];
  for (const market of plan.markets) {
    if (market.tokenBudget <= 0n || market.config === "0x" || (market.config.length - 2) / 2 > 16384) throw new LifecyclePlanningError("INVALID_MARKET", "Each market needs a positive token budget and bounded versioned config");
    let config: V4LifecycleMarketConfig | V4PoolBoundLifecycleMarketConfig | undefined;
    if (market.configVersion !== 1 && market.configVersion !== 4 && !isPoolBoundV4ConfigVersion(market.configVersion)) throw new LifecyclePlanningError("UNSUPPORTED_CONFIG_VERSION", "Encode reviewed SharedV4 version 4 or pool-bound version 5/6 only on its exact matching deployment");
    if (market.configVersion === 4) config = decodeV4LifecycleMarketConfig(market.config);
    else if (isPoolBoundV4ConfigVersion(market.configVersion)) config = decodePoolBoundV4LifecycleMarketConfig(market.config, market.configVersion);
    if (config !== undefined) {
      if (config.profileId.toLowerCase() !== market.profileId.toLowerCase()) throw new LifecyclePlanningError("PROFILE_TERMS_MISMATCH", "Inner config profile differs from the committed market profile");
      const quote = market.quoteAsset.toLowerCase();
      if (v4Quotes.has(quote)) throw new LifecyclePlanningError("DUPLICATE_V4_QUOTE", "Only one V4 market per quote asset is allowed across shared and pool-bound offerings; put multiple positions in that market");
      v4Quotes.add(quote);
      if (config.lpFeePips >= 1000000 || (config.version === 6 ? config.hookFeePips > 1000000 : config.hookFeePips >= 1000000) || config.feeMode > 1 || config.tickSpacing < 1 || config.tickSpacing > 32767 || config.sqrtPriceX96 < 4295128739n || config.sqrtPriceX96 >= 1461446703485210103287273052203988822378723970342n || (config.protocolFeeDenominator !== 0 && (config.protocolFeeDenominator < 4 || config.protocolFeeDenominator > 10 || config.treasury === zeroAddress))) throw new LifecyclePlanningError("INVALID_MARKET", "V4 market violates lifecycle fee, price, treasury or position bounds");
      positionCount += assertLifecycleMarketAllocation(market, config.positions);
      marketConfigs.push(config);
    }
    else {
      const abyss = decodeAbyssLifecycleMarketConfig(market.config);
      positionCount += assertLifecycleMarketAllocation(market, abyss.positions);
      marketConfigs.push(abyss);
    }
    if (positionCount > 32) throw new LifecyclePlanningError("INVALID_POSITION_COUNT", "A launch commits at most 32 total positions across every venue");
  }
  assertLifecycleSupplyAllocation(plan);
  for (const market of plan.markets) {
    const required = plan.buys.filter((buy) => plan.markets[buy.marketIndex]?.quoteAsset.toLowerCase() === market.quoteAsset.toLowerCase()).reduce((sum, buy) => sum + buy.quoteAmountIn, 0n);
    const funding = plan.funding.find((item) => item.asset.toLowerCase() === market.quoteAsset.toLowerCase());
    if (required > (funding?.amount ?? 0n)) throw new LifecyclePlanningError("INVALID_FUNDING", "Quote funding does not cover all ordered buys for its asset");
  }
  return { commitment, marketConfigs };
}

async function readFunding(client: LifecycleRpcClient, plan: LaunchPlanV1, block: LifecycleBlock, account = plan.creator, ufg = false): Promise<{ prerequisites: LifecycleFundingPrerequisite[]; approvals: LifecycleTransaction[] }> {
  if (plan.funding.length === 0) return { prerequisites: [], approvals: [] };
  const preset = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator });
  const escrow = ufg ? UFG_LAUNCH_PROXY_ADDRESS : preset?.fundingEscrow ?? await readLifecycleContract<Address>(client, plan.orchestrator, launchLifecycleAbi, "fundingEscrow", [], block);
  // Only allowance observations construct approval commands. Core execution
  // enforces input/output asset, funding target, balance and conversion predicates.
  const prerequisites = await Promise.all(plan.funding.map(async (funding): Promise<LifecycleFundingPrerequisite> => {
    const native = funding.kind === LifecycleFundingKind.NativeWrap || funding.kind === LifecycleFundingKind.Swap && funding.inputAsset === zeroAddress;
    const [inputBalance, allowance] = native
      ? [rpcQuantity(await lifecyclePinnedRpc(client, "eth_getBalance", [account, toHex(block.number)], block), "creator native balance"), undefined] as const
      : await Promise.all([
        readLifecycleContract<bigint>(client, funding.inputAsset, lifecycleErc20Abi, "balanceOf", [account], block),
        readLifecycleContract<bigint>(client, funding.inputAsset, lifecycleErc20Abi, "allowance", [account, escrow], block),
      ]);
    return { funding, inputBalance, requiredInput: funding.inputAmount, allowance, spender: escrow, nativeValue: native ? funding.inputAmount : 0n, conversion: funding.kind === LifecycleFundingKind.NativeWrap ? "native-wrap" : funding.kind === LifecycleFundingKind.Swap ? "allowlisted-swap" : "none" };
  }));
  const totals = new Map<string, { asset: Address; amount: bigint; allowance: bigint }>();
  for (const prerequisite of prerequisites) {
    if (prerequisite.allowance === undefined) continue;
    const { funding } = prerequisite;
    const key = funding.inputAsset.toLowerCase();
    const total = totals.get(key) ?? { asset: funding.inputAsset, amount: 0n, allowance: prerequisite.allowance };
    total.amount += funding.inputAmount;
    totals.set(key, total);
  }
  const approvals: LifecycleTransaction[] = [];
  for (const total of totals.values()) {
    if (total.allowance >= total.amount) continue;
    if (total.allowance > 0n) approvals.push({ id: `approve-reset:${total.asset}`, kind: "approve-reset", chainId: Number(plan.chainId), from: account, to: total.asset, data: encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "approve", args: [escrow, 0n] }), value: 0n, dependencies: [], postconditions: [{ kind: "allowance", asset: total.asset, spender: escrow, minimum: 0n, exact: 0n }] });
    approvals.push({ id: `approve:${total.asset}`, kind: "approve", chainId: Number(plan.chainId), from: account, to: total.asset, data: encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "approve", args: [escrow, total.amount] }), value: 0n, dependencies: [], postconditions: [{ kind: "allowance", asset: total.asset, spender: escrow, minimum: total.amount }] });
  }
  return { prerequisites, approvals };
}

async function readPlanMetadata(client: LifecycleRpcClient, plan: LaunchPlanV1, token: Address, block: LifecycleBlock): Promise<{ profiles: (LifecycleProfile | LifecycleConstructionProfile)[]; hookDeployments: LifecyclePoolBoundHookDeployment[]; reasons: string[] }> {
  const ids = [...new Set(plan.markets.map((market) => market.profileId.toLowerCase() as Hex))];
  const known = ids.map((profileId) => getKnownLifecycleProfile({ chainId: plan.chainId, orchestrator: plan.orchestrator, profileId }));
  const unknownIds = ids.filter((_id, index) => known[index] === undefined);
  const live = unknownIds.length === 0 ? [] : await readLifecycleProfiles({ client, orchestrator: plan.orchestrator, profileIds: unknownIds }, block);
  const profiles = ids.map((id, index): LifecycleProfile | LifecycleConstructionProfile => {
    const preset = known[index];
    if (preset !== undefined) {
      if (!preset.supported) throw new LifecyclePlanningError("UNSUPPORTED_CONFIG_VERSION", preset.unavailableReason ?? "Historical preset does not support the current launch ABI");
      return { ...preset.profile, metadataSource: "preset" };
    }
    const profile = live.find((candidate) => candidate.id.toLowerCase() === id);
    if (profile === undefined) throw new LifecyclePlanningError("PROFILE_NOT_FOUND", "Unlisted profile discovery omitted the committed profile");
    return profile;
  });
  const hookDeployments = (await Promise.all(plan.markets.map(async (market, marketIndex): Promise<LifecyclePoolBoundHookDeployment | undefined> => {
    if (!isPoolBoundV4ConfigVersion(market.configVersion)) return undefined;
    const known = deriveKnownPoolBoundHookDeployment({ plan, token, marketIndex });
    return { marketIndex, ...(known?.deployment ?? await readPoolBoundHookDeployment({ client, plan, marketIndex }, block)) };
  }))).filter((deployment): deployment is LifecyclePoolBoundHookDeployment => deployment !== undefined);
  return { profiles, hookDeployments, reasons: live.filter((profile) => !profile.admitted).map((profile) => profile.reason ?? "Unlisted lifecycle profile is unavailable") };
}

function orderedTransactions(plan: LaunchPlanV1, mode: "atomic" | "staged", progress: CanonicalLaunchProgress, approvals: readonly LifecycleTransaction[], batches: readonly number[], ufg?: PlanLaunchOptions["ufg"]): LifecycleTransaction[] {
  if (progress.canonical.phase === LifecyclePhase.Active || progress.canonical.phase === LifecyclePhase.Cancelled) return [];
  const prepared = progress.canonical.preparedMarkets;
  const compiled = ufg === undefined ? buildLaunchTransactions({ plan, mode, preparationBatches: mode === "staged" ? batches : undefined })
    : buildUfgLaunchTransactions({ plan, config: ufg.config, mode, preparationBatches: mode === "staged" ? batches : undefined });
  const commands = compiled.filter((transaction) =>
    (transaction.kind !== "begin" && transaction.kind !== "atomic" || progress.canonical.phase === LifecyclePhase.None) &&
    (transaction.kind !== "prepare" || (transaction.marketStart ?? 0) >= prepared));
  const transactions = progress.canonical.phase === LifecyclePhase.None ? [...approvals, ...commands] : commands;
  return transactions.map((transaction, index) => ({ ...transaction, nonce: progress.pendingAccountNonce + BigInt(index), calldataBytes: (transaction.data.length - 2) / 2, dependencies: index === 0 ? [] : [transactions[index - 1]!.id] }));
}

function attachEstimates(transactions: readonly LifecycleTransaction[], simulation: LifecycleSimulation): LifecycleTransaction[] {
  return transactions.map((transaction) => {
    const estimate = simulation.steps.find((step) => step.transactionId === transaction.id)?.estimate;
    return { ...transaction, calldataBytes: (transaction.data.length - 2) / 2, gas: estimate?.gasLimit, gasPrice: estimate?.gasPrice, estimate,
      admission: estimate === undefined ? undefined : { admitted: simulation.admitted, confidence: simulation.confidence, executionProof: simulation.executionProof, protocolFit: simulation.protocolFit, transportPreflight: simulation.transportPreflight, blockNumber: simulation.blockNumber, blockHash: simulation.blockHash, account: simulation.account, chainId: simulation.chainId, reason: simulation.reason, limits: simulation.limits } };
  });
}
type ReviewedNextTransaction = Pick<LifecycleTransaction, "id" | "kind" | "chainId" | "from" | "to" | "data" | "value" | "nonce"> & NextTransactionEnvelope;
const reviewedTransactionKinds = ["approve-reset", "approve", "atomic", "begin", "prepare", "activate", "cancel"] as const;

function readReviewedNextTransaction(transaction: LifecycleTransaction | undefined): ReviewedNextTransaction | undefined {
  if (transaction === undefined) return undefined;
  if (transaction === null || typeof transaction !== "object" || typeof transaction.id !== "string" ||
    !reviewedTransactionKinds.includes(transaction.kind) ||
    !Number.isSafeInteger(transaction.chainId) || transaction.chainId <= 0 ||
    typeof transaction.from !== "string" || !/^0x[\da-fA-F]{40}$/.test(transaction.from) ||
    typeof transaction.to !== "string" || !/^0x[\da-fA-F]{40}$/.test(transaction.to) ||
    typeof transaction.data !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(transaction.data) ||
    typeof transaction.value !== "bigint" || transaction.value < 0n || transaction.value >= 1n << 256n ||
    typeof transaction.gas !== "bigint" || transaction.gas <= 0n || transaction.gas >= 1n << 64n ||
    typeof transaction.gasPrice !== "bigint" || transaction.gasPrice < 0n || transaction.gasPrice >= 1n << 256n ||
    transaction.nonce !== undefined && (typeof transaction.nonce !== "bigint" || transaction.nonce < 0n || transaction.nonce >= 1n << 64n)) {
    throw new LifecyclePlanningError("INVALID_REVIEWED_TRANSACTION", "Reviewed transaction must contain a well-formed exact chain/account/target/calldata/value and uint64 gas/uint256 price envelope");
  }
  return transaction as ReviewedNextTransaction;
}

function matchesReviewedNextTransaction(next: LifecycleTransaction | ReviewedNextTransaction | undefined, reviewed: ReviewedNextTransaction): boolean {
  return next !== undefined && next.id === reviewed.id && next.kind === reviewed.kind && next.chainId === reviewed.chainId &&
    next.from.toLowerCase() === reviewed.from.toLowerCase() && next.to.toLowerCase() === reviewed.to.toLowerCase() &&
    next.data.toLowerCase() === reviewed.data.toLowerCase() && next.value === reviewed.value &&
    (reviewed.nonce === undefined || next.nonce === reviewed.nonce);
}

function assertReviewedTransactionUnchanged(options: BuildNextTransactionOptions, reviewed: ReviewedNextTransaction | undefined, next: LifecycleTransaction): void {
  if (options.planned.ufg !== undefined) assertUfgLaunchAccount(options.planned.plan, options.planned.account);
  if (options.planned.account.toLowerCase() !== next.from.toLowerCase() || options.planned.ufg === undefined && options.planned.plan.creator.toLowerCase() !== next.from.toLowerCase()) {
    throw new LifecyclePlanningError("ACCOUNT_MISMATCH", "Execution account changed during fresh execution or submission proof");
  }
  if (options.planned.chainId !== BigInt(next.chainId) || options.planned.plan.chainId !== BigInt(next.chainId)) {
    throw new LifecyclePlanningError("CHAIN_MISMATCH", "Execution chain changed during fresh execution or submission proof");
  }
  const current = readReviewedNextTransaction(options.reviewedTransaction);
  if (reviewed === undefined ? current !== undefined : current === undefined || !matchesReviewedNextTransaction(current, reviewed) ||
    current.gas !== reviewed.gas || current.gasPrice !== reviewed.gasPrice || !matchesReviewedNextTransaction(next, reviewed) ||
    next.gas !== reviewed.gas || next.gasPrice !== reviewed.gasPrice) {
    throw new LifecyclePlanningError("REVIEWED_TRANSACTION_CHANGED", "Reviewed transaction changed during fresh execution or submission proof");
  }
}

async function readTokenFactoryBinding(client: LifecycleRpcClient, orchestrator: Address, block: LifecycleBlock): Promise<Pick<PlannedLaunch, "tokenFactory" | "tokenFactoryCodeHash">> {
  const tokenFactory = await readLifecycleContract<Address>(client, orchestrator, launchLifecycleAbi, "tokenFactory", [], block);
  const [codeValue, authority] = await Promise.all([
    lifecycleStaticRpc(client, "eth_getCode", [tokenFactory, toHex(block.number)], block),
    readLifecycleContract<Address>(client, tokenFactory, lifecycleAdapterAbi, "core", [], block),
  ]);
  const code = rpcHex(codeValue, "token factory code");
  if (tokenFactory === zeroAddress || code === "0x" || authority.toLowerCase() !== orchestrator.toLowerCase()) throw new LifecyclePlanningError("TOKEN_FACTORY_BINDING", "Token factory is not live and bound to the exact lifecycle core");
  return { tokenFactory, tokenFactoryCodeHash: keccak256(code) };
}

function assertPlannedDeploymentBindings(stored: PlannedLaunch, current: PlannedLaunch): void {
  if (hashLaunchPlan(stored.plan).toLowerCase() !== stored.planHash.toLowerCase() || current.planHash.toLowerCase() !== stored.planHash.toLowerCase() || current.launchId.toLowerCase() !== stored.launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Stored economic plan no longer matches its finalized commitment");
  if (stored.ufg === undefined ? current.ufg !== undefined : current.ufg === undefined || hashUfgLaunchConfig(stored.ufg.config) !== stored.ufg.configHash || current.ufg.configHash !== stored.ufg.configHash) throw new LifecyclePlanningError("PLAN_MUTATED", "Stored UFG route or treasury config no longer matches its finalized commitment");
  if (current.predictedToken.toLowerCase() !== stored.predictedToken.toLowerCase() || current.tokenFactory.toLowerCase() !== stored.tokenFactory.toLowerCase() || current.tokenFactoryCodeHash.toLowerCase() !== stored.tokenFactoryCodeHash.toLowerCase()) throw new LifecyclePlanningError("TOKEN_FACTORY_BINDING", "Final token prediction or its immutable factory code binding changed before execution");
  if (!current.simulation.admitted || current.progress.canonical.phase === LifecyclePhase.Active || current.progress.canonical.phase === LifecyclePhase.Cancelled) return;
  if (stored.hookDeployments.length !== current.hookDeployments.length || stored.hookDeployments.some((deployment, index) => {
    const fresh = current.hookDeployments[index];
    return fresh === undefined || fresh.marketIndex !== deployment.marketIndex || fresh.deployer.toLowerCase() !== deployment.deployer.toLowerCase() || fresh.initCodeHash.toLowerCase() !== deployment.initCodeHash.toLowerCase() || fresh.salt.toLowerCase() !== deployment.salt.toLowerCase() || fresh.predictedHook.toLowerCase() !== deployment.predictedHook.toLowerCase();
  })) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Final bound-hook deployer, initcode, salt or prediction changed before wallet execution");
}

function assertPlanningActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Lifecycle launch planning cancelled"), { name: "AbortError" });
}

function validatePlanningIntent(options: PlanLaunchOptions): ValidatedPlanShape {
  const { plan, account, mode } = options;
  assertPlanningActive(options.signal);
  if (mode !== "atomic" && mode !== "staged") throw new LifecyclePlanningError("EXPLICIT_MODE_REQUIRED", "Choose atomic or staged explicitly; staged is never silently substituted");
  if (options.ufg !== undefined) assertUfgLaunchAccount(plan, account);
  else if (account.toLowerCase() !== plan.creator.toLowerCase()) throw new LifecyclePlanningError("ACCOUNT_MISMATCH", "Execution account must be the committed creator/payer/refund account");
  if (plan.chainId > BigInt(Number.MAX_SAFE_INTEGER) || plan.chainId <= 0n) throw new LifecyclePlanningError("CHAIN_MISMATCH", "Chain ID must be a positive exact JavaScript integer");
  const shape = validatePlanShape(plan);
  return options.ufg === undefined ? shape : { ...shape, ufgConfigHash: hashUfgLaunchConfig(options.ufg.config) };
}

function validatePlanTopology(options: PlanLaunchOptions, marketConfigs: ValidatedPlanShape["marketConfigs"], token: Address): void {
  for (const [marketIndex, config] of marketConfigs.entries()) {
    try {
      let tickSpacing: number;
      let openingSqrtPriceX96: bigint;
      if ("version" in config) {
        tickSpacing = config.tickSpacing;
        openingSqrtPriceX96 = config.sqrtPriceX96;
      } else {
        const tier = ABYSS_FEE_TIERS.find(({ feePips }) => feePips === config.fee);
        if (tier === undefined) throw new LifecyclePlanningError("INVALID_MARKET", "Abyss market fee must select a canonical tick-spacing tier");
        tickSpacing = tier.tickSpacing;
        openingSqrtPriceX96 = config.openingSqrtPriceX96;
      }
      assertLaunchTopologyCoverage({ positions: config.positions, openingTick: getTickAtSqrtRatio(openingSqrtPriceX96), tickSpacing,
        launchedTokenIsQuote: BigInt(token) < BigInt(options.plan.markets[marketIndex]!.quoteAsset),
        allowInteriorGaps: options.allowTopologyGaps === true });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = error.message.slice(0, error.message.indexOf(":"));
      if (code === "MISSING_PERMANENT_TAIL" && options.allowMissingPermanentTail === true) continue;
      if (code === "TOPOLOGY_OPENING_GAP" || code === "TOPOLOGY_INTERIOR_GAP" ||
        code === "MISSING_PERMANENT_TAIL" || code === "TOPOLOGY_OFF_GRID_TICK") {
        throw new LifecyclePlanningError(code, `Market ${marketIndex}: ${error.message}`);
      }
      throw error;
    }
  }
}

function assertFinalPlan(planned: PlannedLaunch, signal?: AbortSignal): void {
  assertPlanningActive(signal);
  if (hashLaunchPlan(planned.plan).toLowerCase() !== planned.planHash.toLowerCase() || hashLaunchIdentity(planned.plan).toLowerCase() !== planned.launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed during asynchronous planning; previous reads and simulation are invalid");
  if (planned.ufg !== undefined && hashUfgLaunchConfig(planned.ufg.config) !== planned.ufg.configHash) throw new LifecyclePlanningError("PLAN_MUTATED", "UFG treasury config changed during asynchronous planning");
}

/** One owner constructs and mines, optionally measures actual ordered buy outputs,
 * then proves only the final protected commitment. No cached execution certificates. */
export async function prepareAndPlanLifecycleLaunch(options: PrepareAndPlanLifecycleLaunchOptions): Promise<PlannedLaunch> {
  const { commitment, ufgConfigHash } = validatePlanningIntent(options);
  if (options.buySlippageBps !== undefined) validateBuySlippageBps(options.buySlippageBps);
  const fixed = options.fixedFinalEnvelope;
  if (fixed !== undefined && (fixed === null || typeof fixed !== "object" || options.mode !== "atomic" || typeof fixed.gas !== "bigint" || fixed.gas <= 0n || fixed.gas >= 1n << 64n ||
    fixed.gasPrice !== undefined && (typeof fixed.gasPrice !== "bigint" || fixed.gasPrice < 0n || fixed.gasPrice >= 1n << 256n))) {
    throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Fixed final envelope requires atomic mode, exact positive uint64 gas and optional uint256 price");
  }
  const heldEnvelope = fixed === undefined ? undefined : Object.freeze({ ...fixed });
  const needsMining = options.plan.markets.some((market) => isPoolBoundV4ConfigVersion(market.configVersion));
  const needsProtection = options.buySlippageBps !== undefined && options.plan.buys.length !== 0;
  if (!needsMining && !needsProtection && fixed === undefined) return planLaunch(options);
  const draft = parseLaunchPlan(serializeLaunchPlan(options.plan));
  const assertDraft = () => {
    assertPlanningActive(options.signal);
    if (hashLaunchPlan(options.plan).toLowerCase() !== commitment.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed during asynchronous preparation; previous construction is invalid");
    if ((options.ufg === undefined ? undefined : hashUfgLaunchConfig(options.ufg.config)) !== ufgConfigHash) throw new LifecyclePlanningError("PLAN_MUTATED", "UFG config changed during asynchronous preparation");
    if (fixed === undefined ? options.fixedFinalEnvelope !== undefined : options.fixedFinalEnvelope !== fixed ||
      fixed.gas !== heldEnvelope!.gas || fixed.gasPrice !== heldEnvelope!.gasPrice) throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Fixed final envelope changed during preparation");
  };
  const result = await withLifecycleReadClient(options.client, async (client) => {
    const [block, chainId] = await Promise.all([readLifecycleBlock(client), readLifecycleChainId(client)]);
    if (chainId !== draft.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain differs from the economic plan being finalized");
    const metadata = needsMining ? await Promise.all(draft.markets.map((market, marketIndex) => isPoolBoundV4ConfigVersion(market.configVersion)
      ? readPoolBoundHookDeployment({ client, plan: draft, marketIndex }, block) : undefined)) : [];
    assertDraft();
    const markets = [...draft.markets];
    const minedDeployments: LifecyclePoolBoundHookDeployment[] = [];
    for (const [marketIndex, deployment] of metadata.entries()) {
      if (deployment === undefined) continue;
      assertDraft();
      const mined = await minePoolBoundHookSalt({
        deployer: deployment.deployer, initCodeHash: deployment.initCodeHash, startSalt: BigInt(deployment.salt), signal: options.signal,
        onProgress: options.onProgress === undefined ? undefined : (progress) => options.onProgress?.({ marketIndex, ...progress }),
      });
      const market = markets[marketIndex]!;
      if (!isPoolBoundV4ConfigVersion(market.configVersion)) throw new LifecyclePlanningError("INVALID_BOUND_MARKET", "Mined market lost its explicit pool-bound version");
      markets[marketIndex] = { ...market, config: encodePoolBoundV4LifecycleMarketConfig({ ...decodePoolBoundV4LifecycleMarketConfig(market.config, market.configVersion), hookSalt: mined.salt }) };
      minedDeployments.push({ marketIndex, deployer: deployment.deployer, initCodeHash: deployment.initCodeHash, ...mined });
    }
    assertDraft();
    // Mining is local construction, not a state admission. Economic observations
    // start at a fresh post-mining snapshot and share it through final protection.
    const executionBlock = needsMining ? await readLifecycleBlock(client) : block;
    assertDraft();
    const price = heldEnvelope === undefined ? undefined : heldEnvelope.gasPrice ?? rpcQuantity(await readLifecycleGasPrice(client), "gas price");
    const baseFeeEnvelope = (executionBlock.baseFeePerGas ?? 0n) * 2n;
    const finalEnvelope = heldEnvelope === undefined ? undefined : Object.freeze({
      gas: heldEnvelope.gas,
      gasPrice: heldEnvelope.gasPrice ?? (price! > baseFeeEnvelope ? price! : baseFeeEnvelope),
    });
    let plan: LaunchPlanV1 = { ...draft, markets };
    let ownedProgress: CanonicalLaunchProgress | undefined;
    if (needsProtection) {
      // A diagnostic minimum is never returned as an admitted or executable plan.
      // Price guards, funding minima, recipients and all ordered budgets stay exact.
      const diagnosticPlan = { ...plan, buys: plan.buys.map((buy) => ({ ...buy, minTokenOut: 1n })) };
      const diagnostic = await lifecycleStage(client, "plan", () => planLaunchWithReads({ ...options, plan: diagnosticPlan }, client, executionBlock, undefined, true, undefined, finalEnvelope));
      assertDraft();
      if (diagnostic.progress.canonical.phase !== LifecyclePhase.None || diagnostic.progress.head.phase !== LifecyclePhase.None) throw new LifecyclePlanningError("LAUNCH_ALREADY_STARTED", "Buy protection cannot replace an already committed launch plan");
      plan = protectOrderedBuyMinimums(diagnostic, options.buySlippageBps!);
      // This is the real SDK-owned None observation, not an assumed new-launch
      // state. No onchain commitment existed at this exact snapshot to replace.
      ownedProgress = { ...diagnostic.progress, planHash: hashLaunchPlan(plan) };
    }
    const planned = await lifecycleStage(client, "plan", () => planLaunchWithReads({ ...options, plan }, client, executionBlock, ownedProgress, false, undefined, finalEnvelope));
    assertDraft();
    assertFinalPlan(planned, options.signal);
    if (planned.progress.canonical.phase !== LifecyclePhase.Active && planned.progress.canonical.phase !== LifecyclePhase.Cancelled) {
      for (const mined of minedDeployments) {
        const final = planned.hookDeployments.find((deployment) => deployment.marketIndex === mined.marketIndex);
        if (final === undefined || final.deployer.toLowerCase() !== mined.deployer.toLowerCase() || final.initCodeHash.toLowerCase() !== mined.initCodeHash.toLowerCase() || final.salt.toLowerCase() !== mined.salt.toLowerCase() || final.predictedHook.toLowerCase() !== mined.predictedHook.toLowerCase()) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Final exact constructor binding differs from the one locally mined candidate");
      }
    }
    if (needsProtection && !planned.simulation.admitted) throw new LifecyclePlanningError("PROTECTED_PLAN_NOT_ADMITTED", planned.simulation.reason ?? "The final protected launch did not establish exact execution proof", planned.simulation);
    return planned;
  });
  assertDraft();
  assertFinalPlan(result, options.signal);
  return result;
}

/** Independently fresh current-state admission of an already finalized commitment. No broadcasts. */
export async function planLaunch(options: PlanLaunchOptions): Promise<PlannedLaunch> {
  const result = await withLifecycleReadClient(options.client, async (client) => {
    const planned = await lifecycleStage(client, "plan", () => planLaunchWithReads(options, client));
    assertFinalPlan(planned, options.signal);
    return planned;
  });
  assertFinalPlan(result, options.signal);
  return result;
}

async function planLaunchWithReads(options: PlanLaunchOptions, client: LifecycleRpcClient, pinnedBlock?: LifecycleBlock, ownedProgress?: CanonicalLaunchProgress, diagnostic = false, reviewed?: ReviewedNextTransaction, fixedFinalEnvelope?: NextTransactionEnvelope): Promise<PlannedLaunch> {
  const { plan, account, mode, ufg } = options;
  const { commitment: planHash, marketConfigs, ufgConfigHash } = validatePlanningIntent(options);
  const launchId = hashLaunchIdentity(plan);
  const [block, chainId] = await lifecycleStage(client, "plan.context", () => Promise.all([
    pinnedBlock ?? readLifecycleBlock(client), readLifecycleChainId(client),
  ]));
  if (chainId !== plan.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain differs from the committed plan");
  // Only preparation/build-next can supply freshly observed progress from this
  // still-open SDK invocation. Stored/query DTOs never enter this continuation.
  if (ownedProgress !== undefined) {
    if (!assertLifecycleReadClientOpen(client) || pinnedBlock !== block || ownedProgress.blockNumber !== block.number ||
      ownedProgress.blockHash.toLowerCase() !== block.hash.toLowerCase() || ownedProgress.chainId !== plan.chainId ||
      ownedProgress.confirmationDepth !== (options.confirmations ?? 1)) throw new LifecyclePlanningError("INVALID_READ_CONTEXT", "Owned progress differs from its active planning snapshot");
    if (ownedProgress.planHash.toLowerCase() !== planHash.toLowerCase() || ownedProgress.launchId.toLowerCase() !== launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed after its canonical progress was read");
  }
  assertPlanningActive(options.signal);
  const preset = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator });
  const [{ tokenFactory, tokenFactoryCodeHash }, { limits }, { identity, progress }] = await lifecycleStage(client, "plan.domain", () => Promise.all([
    preset ?? readTokenFactoryBinding(client, plan.orchestrator, block),
    resolveLifecycleLimits({ client, account, orchestrator: plan.orchestrator, block, chainId: plan.chainId }, options.limits),
    lifecycleStage(client, "plan.progress", async () => {
      const [predictedToken] = await Promise.all([
        readLifecycleTokenAtBlock(client, plan, block),
        ownedProgress === undefined ? readLifecycleHeadProgress(client, plan, account, block) : undefined,
      ]);
      const identity = { plan, planHash, launchId, predictedToken, account, mode, confirmations: options.confirmations ?? 1,
        ...(ufg === undefined ? {} : { ufg: { config: ufg.config, configHash: ufgConfigHash! } }) };
      if (ufg !== undefined) validateUfgLaunchPlan(plan, ufg.config, predictedToken);
      const progress = ownedProgress ?? await readLaunchProgress({ client, planned: identity, receipts: options.receipts, signal: options.signal }, block);
      if (ownedProgress !== undefined && progress.token.toLowerCase() !== predictedToken.toLowerCase()) throw new LifecyclePlanningError("TOKEN_IDENTITY", "Predicted token changed after its canonical progress was read");
      return { identity, progress };
    }),
  ]));
  assertPlanningActive(options.signal);
  const placeholder: LifecycleSimulation = { backend: "unavailable", confidence: "provisional", admitted: false, executionProof: "unavailable", protocolFit: "unknown", transportPreflight: "not-requested", blockNumber: block.number, blockHash: block.hash, account, chainId: plan.chainId, limits, steps: [], deferredTransactionIds: [] };
  let planned: PlannedLaunch = { ...identity, tokenFactory, tokenFactoryCodeHash, chainId: plan.chainId, transactions: [], totalCalldataBytes: 0, prerequisites: [], profiles: [], hookDeployments: [], progress, simulation: placeholder, limits: options.limits,
    allowTopologyGaps: options.allowTopologyGaps === true, allowMissingPermanentTail: options.allowMissingPermanentTail === true };
  const receiptsPending = progress.receipts.some((receipt) => receipt.status === "pending" || receipt.status === "unconfirmed");
  if (!progress.confirmationSafe || receiptsPending) {
    const hookDeployments: LifecyclePoolBoundHookDeployment[] = [];
    for (let marketIndex = 0; marketIndex < plan.markets.length; marketIndex += 1) {
      const market = plan.markets[marketIndex]!;
      if (!isPoolBoundV4ConfigVersion(market.configVersion)) continue;
      const known = deriveKnownPoolBoundHookDeployment({ plan, token: identity.predictedToken, marketIndex });
      hookDeployments.push({ marketIndex, ...(known?.deployment ?? await readPoolBoundHookDeployment({ client, plan, marketIndex }, block)) });
    }
    const waiting = { ...placeholder, confidence: "stateful" as const, reason: !progress.confirmationSafe ? "Canonical confirmed progress/account nonce has not caught up with head or pending transactions; wait for the selected confirmation depth" : "Wait for canonical receipt confirmations or resolve replacement before requesting another transaction" };
    await assertLifecycleBlock(client, block, plan.chainId);
    return { ...planned, hookDeployments, simulation: waiting };
  }
  if (progress.canonical.phase === LifecyclePhase.Active || progress.canonical.phase === LifecyclePhase.Cancelled) {
    await assertLifecycleBlock(client, block, plan.chainId);
    return { ...planned, simulation: { ...placeholder, confidence: "stateful", executionProof: "proved", protocolFit: "proved", admitted: true, reason: "Canonical launch is terminal; no transaction remains" } };
  }
  // Topology is a creation policy, not a retroactive obstacle to recovery of
  // immutable onchain commitments. Waiting and terminal launches returned above.
  if (progress.canonical.phase === LifecyclePhase.None && progress.head.phase === LifecyclePhase.None) validatePlanTopology(options, marketConfigs, identity.predictedToken);
  const [funding, metadata] = await lifecycleStage(client, "plan.inputs", () => Promise.all([
    progress.canonical.phase === LifecyclePhase.None ? readFunding(client, plan, block, ufg === undefined ? plan.creator : account, ufg !== undefined) : { prerequisites: [], approvals: [] },
    readPlanMetadata(client, plan, identity.predictedToken, block),
  ]));
  assertFinalPlan(planned, options.signal);
  planned = { ...planned, prerequisites: funding.prerequisites, profiles: metadata.profiles, hookDeployments: metadata.hookDeployments };
  const prepared = progress.canonical.preparedMarkets;
  const computeCap = limits.transactionGasCeiling !== undefined && limits.transactionGasCeiling < limits.executionGasCeiling ? limits.transactionGasCeiling : limits.executionGasCeiling;
  let batches: number[] = [];
  if (mode === "staged") batches = reviewed === undefined ? packPreparationBatches(plan, prepared, computeCap)
    : [...(prepared > 0 ? [prepared] : []), ...(prepared < plan.markets.length ? [plan.markets.length - prepared] : [])];
  if (reviewed !== undefined && reviewed.kind === "prepare") {
    // Canonical progress fixes the start; the exact held calldata fixes its span.
    // Never rediscover a batch or enlarge a reviewed transaction.
    const match = /^prepare:(\d+):(\d+)$/.exec(reviewed.id);
    const start = Number(match?.[1]), count = Number(match?.[2]);
    if (start !== prepared || !Number.isSafeInteger(count) || count <= 0 || start + count > plan.markets.length) throw new LifecyclePlanningError("REVIEWED_TRANSACTION_MISMATCH", "Reviewed preparation differs from canonical unfinished progress");
    batches = [...(prepared > 0 ? [prepared] : []), count, ...(start + count < plan.markets.length ? [plan.markets.length - start - count] : [])];
  }
  let transactions = orderedTransactions(plan, mode, progress, funding.approvals, batches, ufg);
  if (fixedFinalEnvelope !== undefined && (transactions.length !== 1 || transactions[0]!.kind !== "atomic")) {
    throw new LifecyclePlanningError("INVALID_GAS_ENVELOPE", "Fixed final envelope requires one immediate atomic launch with no preceding approvals");
  }
  if (reviewed !== undefined) {
    if (!matchesReviewedNextTransaction(transactions[0], reviewed)) throw new LifecyclePlanningError("REVIEWED_TRANSACTION_MISMATCH", "Reviewed transaction differs from the current canonical unfinished next step");
    transactions = transactions.slice(0, 1);
  }
  if (metadata.reasons.length > 0) {
    await assertLifecycleBlock(client, block, plan.chainId);
    return { ...planned, simulation: { ...placeholder, confidence: "stateful", reason: metadata.reasons.join("; "), failureCategory: "semantic" }, transactions, totalCalldataBytes: transactions.reduce((total, transaction) => total + (transaction.data.length - 2) / 2, 0) };
  }
  const envelope = diagnostic ? undefined : reviewed ?? fixedFinalEnvelope;
  const preparedSimulation = prepareLaunchSimulation({ client, planned, limits: options.limits, fork: options.fork, signal: options.signal }, block, true, envelope, fixedFinalEnvelope?.gasPrice);
  try {
    const execute = diagnostic ? preparedSimulation.measure : (candidate: readonly LifecycleTransaction[]) => preparedSimulation(candidate, envelope);
    let simulation = await execute(transactions);
    assertFinalPlan(planned, options.signal);
    if (mode === "staged") {
      // Only a measurement that consumed almost its entire legal envelope
      // invalidates packing estimates, including gas hidden by CREATE wrappers.
      while (reviewed === undefined && !simulation.admitted && simulation.failedTransactionId?.startsWith("prepare:")) {
        const failedIndex = transactions.findIndex((transaction) => transaction.id === simulation.failedTransactionId);
        const failedTransaction = transactions[failedIndex];
        const step = simulation.steps.find((candidate) => candidate.transactionId === simulation.failedTransactionId);
        const count = failedTransaction?.marketCount ?? 0;
        if (count <= 1 || step?.estimate !== undefined || step?.gasUsed === undefined || step.gasLimit === undefined || step.gasUsed * 100n < step.gasLimit * 95n) break;
        let first = 0;
        const batchIndex = batches.findIndex((batch) => { const matches = first === failedTransaction?.marketStart; first += batch; return matches; });
        const left = Math.ceil(count / 2);
        batches.splice(batchIndex, 1, left, count - left);
        transactions = orderedTransactions(plan, mode, progress, funding.approvals, batches, ufg);
        simulation = await execute(transactions);
        assertFinalPlan(planned, options.signal);
      }
      if (!simulation.admitted && simulation.failedTransactionId === "activate") simulation = { ...simulation, reason: `${simulation.reason ?? "Final activation failed"}; final mint/lock/all-buys/public-opening is indivisible and will not be partitioned` };
    } else if (!diagnostic && !simulation.admitted && !(simulation.capacityConstraint === "compute" && simulation.confidence === "provisional")) {
      simulation = { ...simulation, reason: `${simulation.reason ?? "Exact atomic plan is not admitted"}; choose staged explicitly only if empty preparation can be partitioned and complete activation fits` };
    }
    if (reviewed !== undefined && !matchesReviewedNextTransaction(transactions[0], reviewed)) {
      throw new LifecyclePlanningError("REVIEWED_TRANSACTION_MISMATCH", "Reviewed transaction differs from the current canonical unfinished next step");
    }
    return { ...planned, simulation, transactions: attachEstimates(transactions, simulation), totalCalldataBytes: transactions.reduce((total, transaction) => total + (transaction.data.length - 2) / 2, 0) };
  } finally { preparedSimulation.close(); }
}

async function preflightNextTransaction(options: BuildNextTransactionOptions, next: LifecycleTransaction, simulation: LifecycleSimulation, reviewed?: ReviewedNextTransaction): Promise<LifecycleTransaction> {
  if (next.gas === undefined || next.gas <= 0n || next.gas >= 1n << 64n || next.gasPrice === undefined || next.gasPrice < 0n ||
    simulation.executionProof !== "proved" || simulation.protocolFit !== "proved" || !simulation.admitted ||
    next.estimate === undefined || next.estimate.gasLimit !== next.gas || next.estimate.gasPrice !== next.gasPrice ||
    simulation.limits.transactionGasCeiling !== undefined && next.gas > simulation.limits.transactionGasCeiling) {
    throw new LifecyclePlanningError("MISSING_GAS_PROOF", "Next transaction has no current-state exact gas/headroom/fee-envelope proof", simulation);
  }
  assertReviewedTransactionUnchanged(options, reviewed, next);
  const submissionClient = options.submissionClient;
  assertPlanningActive(options.signal);
  if (submissionClient === undefined) return { ...next, dependencies: [] };
  try {
    if (rpcQuantity(await lifecycleRpc(submissionClient, "eth_chainId"), "submission chain ID") !== simulation.chainId) throw new Error("Active submission RPC chain differs from the reviewed transaction");
    const estimated = rpcQuantity(await lifecycleRpc(submissionClient, "eth_estimateGas", [{
      from: next.from, to: next.to, data: next.data, value: toHex(next.value), gas: toHex(next.gas), gasPrice: toHex(next.gasPrice),
      ...(next.nonce === undefined ? {} : { nonce: toHex(next.nonce) }),
    }, "latest"]), "submission gas estimate");
    if (estimated <= 0n || estimated > next.gas) throw new Error("Submission RPC gas estimate exceeds the exact reviewed envelope or is zero");
    if (rpcQuantity(await lifecycleRpc(submissionClient, "eth_chainId"), "submission chain ID") !== simulation.chainId) throw new Error("Active submission RPC chain changed during preflight");
    assertPlanningActive(options.signal);
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;
    const reason = `Exact next-transaction submission preflight failed: ${lifecycleFailureReason(failure)}`;
    throw new LifecyclePlanningError("SUBMISSION_PREFLIGHT_FAILED", reason, { ...simulation, transportPreflight: "failed", reason });
  }
  if (next.admission === undefined) throw new LifecyclePlanningError("MISSING_GAS_PROOF", "Next transaction omitted its exact simulation admission", simulation);
  assertPlanningActive(options.signal);
  assertReviewedTransactionUnchanged(options, reviewed, next);
  return { ...next, dependencies: [], admission: { ...next.admission, transportPreflight: "passed" } };
}

/** Recovery observes real canonical receipts/nonces, then proves only unfinished
 * execution; known construction metadata is not recertified through getter mirrors. */
export async function buildNextTransaction(options: BuildNextTransactionOptions): Promise<LifecycleTransaction | undefined> {
  const supplied = readReviewedNextTransaction(options.reviewedTransaction);
  // Snapshot only the reviewed wire fields; caller proofs and commands are never
  // reused, and final checks compare the mutable input with this one local copy.
  const reviewed = supplied === undefined ? undefined : Object.freeze({ id: supplied.id, kind: supplied.kind, chainId: supplied.chainId,
    from: supplied.from, to: supplied.to, data: supplied.data, value: supplied.value, gas: supplied.gas, gasPrice: supplied.gasPrice, nonce: supplied.nonce });
  const result = await withLifecycleReadClient(options.client, async (client) => {
    const block = await readLifecycleBlock(client);
    const limitSource = options.limits === undefined ? options.planned.limits : options.limits;
    if (getKnownLifecycleDeployment({ chainId: options.planned.chainId, orchestrator: options.planned.plan.orchestrator }) !== undefined && typeof limitSource !== "function") {
      await Promise.all([
        readLifecycleTokenAtBlock(client, options.planned.plan, block),
        readLifecycleHeadProgress(client, options.planned.plan, options.planned.account, block),
        resolveLifecycleLimits({ client, account: options.planned.account, orchestrator: options.planned.plan.orchestrator, block, chainId: options.planned.chainId }, limitSource),
      ]);
    }
    const progress = await readLaunchProgress({ ...options, client }, block);
    if (progress.canonical.phase === LifecyclePhase.Active || progress.canonical.phase === LifecyclePhase.Cancelled) {
      // Only the confirmed canonical terminal phase is terminal; a head-only
      // Active observation is not, and the confirmation/nonce/receipt gates below
      // remain in force for every nonterminal case.
      await assertLifecycleBlock(client, block, options.planned.chainId);
      return undefined;
    }
    if (!progress.confirmationSafe) throw new LifecyclePlanningError("UNCONFIRMED_STATE", "Wait for confirmed canonical progress and account nonce, including untracked approvals/replacements, before constructing the next transaction");
    if (progress.receipts.some((receipt) => receipt.status === "pending" || receipt.status === "unconfirmed")) throw new LifecyclePlanningError("RECEIPT_PENDING", "Wait for canonical receipt confirmations or resolve replacement before requesting another transaction");
    assertPlanningActive(options.signal);
    if (options.action === "cancel") {
      if (progress.canonical.phase === LifecyclePhase.None) throw new LifecyclePlanningError("NOT_STARTED", "An unstarted plan has no launch escrow to cancel");
      const { planned } = options;
      assertFinalPlan(planned, options.signal);
      const transaction: LifecycleTransaction = planned.ufg !== undefined ? buildUfgCancelTransaction({ plan: planned.plan, preparedMarkets: progress.canonical.preparedMarkets })
        : { id: "cancel", kind: "cancel", chainId: Number(planned.chainId), from: planned.account, to: planned.plan.orchestrator, data: encodeFunctionData({ abi: launchLifecycleAbi, functionName: "cancelLaunch", args: [planned.plan] }), value: 0n, dependencies: [], postconditions: [{ kind: "launch", phase: "Cancelled", preparedMarkets: progress.canonical.preparedMarkets }] };
      transaction.nonce = progress.pendingAccountNonce;
      if (reviewed !== undefined && !matchesReviewedNextTransaction(transaction, reviewed)) throw new LifecyclePlanningError("REVIEWED_TRANSACTION_MISMATCH", "Reviewed transaction differs from the current canonical cancellation");
      const simulation = await simulateLaunchTransactions({ client, planned, limits: options.limits === undefined ? planned.limits : options.limits, fork: options.fork, signal: options.signal }, [transaction], block, reviewed);
      if (!simulation.admitted) throw new LifecyclePlanningError("CANCEL_NOT_ADMITTED", simulation.reason ?? "Cancellation could not be proved against current canonical state", simulation);
      const next = attachEstimates([transaction], simulation)[0];
      if (next === undefined) throw new LifecyclePlanningError("MISSING_GAS_PROOF", "Cancellation omitted its exact simulation admission", simulation);
      return preflightNextTransaction(options, next, simulation, reviewed);
    }
    const refreshed = await lifecycleStage(client, "plan", () => planLaunchWithReads({ client, plan: options.planned.plan, account: options.planned.account, mode: options.planned.mode, limits: options.limits === undefined ? options.planned.limits : options.limits, fork: options.fork, receipts: options.receipts, confirmations: options.confirmations ?? options.planned.confirmations, signal: options.signal,
      ufg: options.planned.ufg, allowTopologyGaps: options.planned.allowTopologyGaps, allowMissingPermanentTail: options.planned.allowMissingPermanentTail }, client, block, progress, false, reviewed));
    assertFinalPlan(refreshed, options.signal);
    if (!refreshed.simulation.admitted) throw new LifecyclePlanningError("PLAN_NOT_ADMITTED", refreshed.simulation.reason ?? "Remaining exact launch sequence is not admitted", refreshed.simulation);
    assertPlannedDeploymentBindings(options.planned, refreshed);
    const next = refreshed.transactions[0];
    if (next === undefined) return undefined;
    return preflightNextTransaction(options, next, refreshed.simulation, reviewed);
  });
  assertFinalPlan(options.planned, options.signal);
  if (result !== undefined) assertReviewedTransactionUnchanged(options, reviewed, result);
  return result;
}

/** Re-simulates only canonical unfinished work with the same submitted receipt
 * evidence and confirmation depth as build-next, never silently dropping context. */
export async function simulateLaunchPlan(options: SimulateLaunchPlanOptions): Promise<LifecycleSimulation> {
  const { client, planned } = options;
  if (hashLaunchPlan(planned.plan).toLowerCase() !== planned.planHash.toLowerCase() || hashLaunchIdentity(planned.plan).toLowerCase() !== planned.launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Stored economic plan no longer matches its commitment");
  const current = await planLaunch({
    client, plan: planned.plan, account: planned.account, mode: planned.mode,
    limits: options.limits === undefined ? planned.limits : options.limits, fork: options.fork,
    receipts: options.receipts, confirmations: options.confirmations ?? planned.confirmations, signal: options.signal,
    ufg: planned.ufg, allowTopologyGaps: planned.allowTopologyGaps, allowMissingPermanentTail: planned.allowMissingPermanentTail,
  });
  assertPlannedDeploymentBindings(planned, current);
  return current.simulation;
}
