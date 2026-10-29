import { toHex, zeroAddress, type Address } from "viem";
import { AUCTION_QUOTE_OPTIONS } from "../auction.js";
import { getTickAtSqrtRatio } from "../launch.js";
import { decodeAbyssLifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig } from "./markets.js";
import { computeLifecycleOpeningBuys, hasProfiledOpeningMath } from "./opening-buys.js";
import { getKnownLifecycleProfile, hmmV2ForwardingReserve } from "./presets.js";
import { lifecyclePinnedRpc, lifecycleSessionRead, nitroPosterGasBound, readNitroPrices, registerLifecycleFinalCheck, resolveLifecycleLimits, rpcHex, rpcQuantity } from "./rpc.js";
import { LifecycleFundingKind, LifecycleRewardMode, LifecycleTokenKind, type LaunchPlanV1 } from "./schema.js";
import { buildLifecycleCommand } from "./transactions.js";
import { UFG_LAUNCH_PROXY_ADDRESS, ufgPlanPrincipal, type UfgLaunchConfig } from "./ufg-config.js";
import { isAutoCompoundProfile } from "./auto-compound.js";
import type { NextTransactionEnvelope } from "./simulation.js";
import { LifecyclePlanningError, type LifecycleBlock, type LifecycleLaunchGasBounds, type LifecycleOpeningBuyQuote, type LifecycleSimulation, type LifecycleTransaction, type SimulateLaunchPlanOptions } from "./types.js";

export const LIFECYCLE_GAS_PROFILE_VERSION = "robinhood-4663-arbos61-v1";

// Coverage, not token admission: unlisted currencies still use exact execution.
const profiledQuotes = new Set<string>();
for (const quote of AUCTION_QUOTE_OPTIONS) if (quote.address !== zeroAddress) profiledQuotes.add(quote.address.toLowerCase());
const ceil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
const approval = (transaction: LifecycleTransaction) => transaction.kind === "approve" || transaction.kind === "approve-reset";
type MarketGas = { abyss: boolean; hmm: boolean; ufgHook: boolean; positions: number; spacing: number; openingTick: number; ticks: number[] };

function covered(plan: LaunchPlanV1): boolean {
  return plan.chainId === 4663n && hasProfiledOpeningMath(plan) &&
    // New compounding templates require exact execution until capacity is calibrated.
    !plan.markets.some((market) => isAutoCompoundProfile(market.profileId)) &&
    plan.markets.every((market) => profiledQuotes.has(market.quoteAsset.toLowerCase())) &&
    plan.funding.every((funding) => funding.kind !== LifecycleFundingKind.ERC20 || profiledQuotes.has(funding.inputAsset.toLowerCase()));
}

function marketGas(plan: LaunchPlanV1): MarketGas[] {
  return plan.markets.map((market) => {
    const preset = getKnownLifecycleProfile({ chainId: plan.chainId, orchestrator: plan.orchestrator, profileId: market.profileId })!;
    const abyss = market.configVersion === 1;
    const config = abyss ? decodeAbyssLifecycleMarketConfig(market.config) : decodePoolBoundV4LifecycleMarketConfig(market.config, 6);
    const price = "openingSqrtPriceX96" in config ? config.openingSqrtPriceX96 : config.sqrtPriceX96;
    const spacing = "tickSpacing" in config ? config.tickSpacing : config.fee === 100 ? 1 : config.fee === 500 ? 10 : config.fee === 3000 ? 60 : 200;
    const ticks = new Set<number>();
    for (const position of config.positions) { ticks.add(position.tickLower); ticks.add(position.tickUpper); }
    return { abyss, hmm: preset.key.includes("hmm"), ufgHook: preset.key.includes("ufg"), positions: config.positions.length,
      spacing, openingTick: getTickAtSqrtRatio(price), ticks: [...ticks] };
  });
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

function tokenCreationGas(token: LaunchPlanV1["token"]): bigint {
  return (token.kind === LifecycleTokenKind.ERC404 ? 2_500_000n : 0n) +
    (token.rewardMode === LifecycleRewardMode.Staking ? 2_500_000n : token.rewardMode === LifecycleRewardMode.Dividends ? 500_000n : 0n) +
    22_000n * BigInt(Math.ceil(utf8Bytes(token.name) / 32) + Math.ceil(utf8Bytes(token.symbol) / 32) + Math.ceil(utf8Bytes(token.metadataURI) / 32));
}

/** Capacity classification only. No value returned here ever sets a transaction gas limit. */
function capacityBasis(plan: LaunchPlanV1, transaction: LifecycleTransaction, markets: readonly MarketGas[], quotes: readonly LifecycleOpeningBuyQuote[], ufgRoute: boolean): bigint {
  const atomic = transaction.kind === "atomic";
  let gas = atomic ? 19_500_000n + tokenCreationGas(plan.token) + (ufgRoute ? 6_500_000n : 0n) : 1_000_000n;
  for (const [index, market] of markets.entries()) {
    if (!atomic) gas += market.abyss ? 2_500_000n + 1_600_000n * BigInt(market.positions) : 2_000_000n + 600_000n * BigInt(market.positions);
    else gas += (index === 0 ? market.hmm ? 7_000_000n : market.ufgHook ? 1_000_000n : market.abyss ? 500_000n : 0n
      : market.hmm ? 15_000_000n : market.ufgHook ? 9_000_000n : 8_000_000n) +
      (market.abyss ? 1_500_000n : 600_000n) * BigInt(market.positions - 1);
    if (!atomic && market.hmm) gas += 6_000_000n;
  }
  const ticks = markets.map((market) => market.openingTick);
  for (const quote of quotes) {
    const market = markets[quote.marketIndex]!, before = ticks[quote.marketIndex]!, after = getTickAtSqrtRatio(quote.sqrtPriceAfterX96);
    const low = Math.min(before, after), high = Math.max(before, after);
    const words = Math.abs(Math.floor(after / (market.spacing * 256)) - Math.floor(before / (market.spacing * 256))) + 2;
    let crossings = 0;
    for (const tick of market.ticks) if (tick >= low && tick <= high) crossings += 1;
    gas += 300_000n + 8_000n * BigInt(words) + 80_000n * BigInt(crossings);
    if (plan.token.kind === LifecycleTokenKind.ERC404) gas += 70_000n * ceil(quote.tokenOut, plan.token.nftUnit);
    ticks[quote.marketIndex] = after;
  }
  return gas + 24n * BigInt((transaction.data.length - 2) / 2) + 100_000n * BigInt(plan.feeAssets.length);
}

type CapacityOptions = { plan: LaunchPlanV1; predictedToken: Address; ufg?: { config: UfgLaunchConfig }; headroomBps?: number };
export type ProfiledLaunchCapacity = {
  bounds: LifecycleLaunchGasBounds; initialBuys: readonly LifecycleOpeningBuyQuote[]; headroomBps: number;
  atomic: LifecycleTransaction; activation: LifecycleTransaction;
};

/** Internal shared computation; callers reuse both compiled commands and ordered math. */
export function deriveLifecycleLaunchCapacity(options: CapacityOptions, openingBuys?: readonly LifecycleOpeningBuyQuote[]): ProfiledLaunchCapacity | undefined {
  const { plan, ufg } = options;
  if (!covered(plan) || plan.funding.some((funding) => funding.kind === LifecycleFundingKind.Swap) ||
    (plan.creator.toLowerCase() === UFG_LAUNCH_PROXY_ADDRESS.toLowerCase()) !== (ufg !== undefined)) return undefined;
  const headroomBps = options.headroomBps ?? 1500;
  if (!Number.isSafeInteger(headroomBps) || headroomBps < 0 || headroomBps > 10000) throw new LifecyclePlanningError("INVALID_LIMITS", "Headroom must be between zero and10000 basis points");
  const initialBuys = openingBuys ?? computeLifecycleOpeningBuys(options);
  const route = ufg === undefined ? undefined : { account: ufgPlanPrincipal(plan), config: ufg.config };
  const atomic = buildLifecycleCommand(plan, { kind: "atomic" }, route), activation = buildLifecycleCommand(plan, { kind: "activate" }, route);
  const markets = marketGas(plan), reserve = hmmV2ForwardingReserve(plan);
  const bound = (transaction: LifecycleTransaction) => {
    const basis = capacityBasis(plan, transaction, markets, initialBuys, ufg !== undefined);
    const buffered = ceil(basis * BigInt(10000 + headroomBps), 10000n);
    return buffered > basis + reserve ? buffered : basis + reserve;
  };
  return { bounds: { atomicComputeGasUpperBound: bound(atomic), activationComputeGasUpperBound: bound(activation) }, initialBuys, headroomBps, atomic, activation };
}

/** Pure, versioned conservative compute bounds for mode/builder capacity, excluding poster gas.
 * Undefined means unprofiled, not unavailable functionality. A large upper bound is uncertain. */
export function computeLifecycleLaunchGasBounds(options: CapacityOptions): LifecycleLaunchGasBounds | undefined {
  return deriveLifecycleLaunchCapacity(options)?.bounds;
}

export type ProfiledLifecycleTransactions = { simulation: LifecycleSimulation; profileOnly: boolean };

/** Native ceilings determine every launch envelope. Profiles decide capacity only;
 * conversions and uncertain activation shapes still require exact execution. */
export async function profileLifecycleTransactions(options: SimulateLaunchPlanOptions, transactions: readonly LifecycleTransaction[], block: LifecycleBlock,
  reviewed?: NextTransactionEnvelope, openingBuys?: readonly LifecycleOpeningBuyQuote[], capacity?: ProfiledLaunchCapacity): Promise<ProfiledLifecycleTransactions | undefined> {
  const { client, planned } = options, plan = planned.plan;
  const onlyApprovals = transactions.every(approval);
  if (planned.chainId !== 4663n || !onlyApprovals && !covered(plan)) return undefined;
  const context = { client, account: planned.account, orchestrator: plan.orchestrator, block, chainId: planned.chainId };
  const observed = await resolveLifecycleLimits(context, options.limits === undefined ? planned.limits : options.limits);
  if (!onlyApprovals && observed.limits.arbOSVersion !== 61n) return undefined;
  const [prices, balanceValue, accountCode] = await Promise.all([
    readNitroPrices(client, block),
    lifecyclePinnedRpc(client, "eth_getBalance", [planned.account, toHex(block.number)], block),
    lifecycleSessionRead(client, `${planned.chainId}:account-code:${planned.account.toLowerCase()}`, () => lifecyclePinnedRpc(client, "eth_getCode", [planned.account, toHex(block.number)], block)),
  ]);
  if (rpcHex(accountCode, "account code") !== "0x") return undefined;
  options.signal?.throwIfAborted(); observed.assertCurrent(); registerLifecycleFinalCheck(client, observed.assertCurrent);
  const { limits } = observed, baseFee = block.baseFeePerGas ?? 0n;
  const requiredGasPrice = prices[5] > baseFee ? prices[5] : baseFee;
  const gasPrice = reviewed?.gasPrice ?? (prices[5] > baseFee * 2n ? prices[5] : baseFee * 2n);
  if (reviewed !== undefined && !onlyApprovals && reviewed.gas !== limits.executionGasCeiling) throw new LifecyclePlanningError("STALE_REVIEWED_GAS", "Reviewed gas differs from the native transaction ceiling; review the launch again");
  const needsBuys = transactions.some((transaction) => transaction.kind === "atomic" || transaction.kind === "activate");
  const currentCapacity = needsBuys ? capacity?.headroomBps === limits.headroomBps ? capacity : deriveLifecycleLaunchCapacity({ plan, predictedToken: planned.predictedToken, ufg: planned.ufg, headroomBps: limits.headroomBps }, openingBuys) : undefined;
  if (needsBuys && currentCapacity === undefined) return undefined;
  const quotes = currentCapacity?.initialBuys ?? [], bounds = currentCapacity?.bounds;
  let profileOnly = !plan.funding.some((funding) => funding.kind === LifecycleFundingKind.Swap) ||
    !transactions.some((transaction) => transaction.kind === "begin" || transaction.kind === "atomic" || transaction.kind === "activate");
  for (const transaction of transactions) {
    if (transaction.kind !== "atomic" && transaction.kind !== "activate") continue;
    const compute = transaction.kind === "atomic" ? bounds!.atomicComputeGasUpperBound : bounds!.activationComputeGasUpperBound;
    if (compute + nitroPosterGasBound(transaction, prices).posterGas > limits.executionGasCeiling) profileOnly = false;
  }
  const launch = transactions.find((transaction) => !approval(transaction));
  const immediate = transactions[0], gasLimit = limits.executionGasCeiling;
  const envelopeFailure = launch !== undefined && limits.transactionGasCeiling !== undefined && gasLimit > limits.transactionGasCeiling;
  const calldataFailure = transactions.find((transaction) => limits.maxCalldataBytes !== undefined && (transaction.data.length - 2) / 2 > limits.maxCalldataBytes);
  const feeFailure = reviewed !== undefined && gasPrice < requiredGasPrice;
  const affordabilityFailure = launch !== undefined && launch.value + gasLimit * gasPrice > rpcQuantity(balanceValue, "creator native balance");
  const semanticFailure = quotes.find((quote) => quote.tokenOut < plan.buys[quote.buyIndex]!.minTokenOut);
  const expired = block.timestamp > plan.deadline && transactions.some((transaction) => transaction.kind !== "cancel");
  const refused = envelopeFailure || calldataFailure !== undefined || feeFailure || affordabilityFailure || semanticFailure !== undefined || expired;
  const poster = immediate === undefined || approval(immediate) ? undefined : nitroPosterGasBound(immediate, prices).posterGas;
  const simulation: LifecycleSimulation = {
    backend: "profiled", confidence: "profiled", executionProof: "not-run", protocolFit: "profiled", admitted: profileOnly && !refused,
    blockNumber: block.number, blockHash: block.hash, account: planned.account, chainId: planned.chainId, limits, steps: [], deferredTransactionIds: [],
    ...(bounds === undefined ? {} : { gasProfile: { version: LIFECYCLE_GAS_PROFILE_VERSION, bounds, initialBuys: quotes } }),
    ...(immediate === undefined || approval(immediate) ? {} : { estimate: { gasLimit, gasPrice, executionFee: gasLimit * gasPrice, dataFee: 0n, totalFee: gasLimit * gasPrice,
      posterGas: poster, posterFee: poster! * gasPrice, dataFeeIncludedInGas: true, feeConfidence: "native-ceiling-and-data" as const } }),
    ...(envelopeFailure ? { failureCategory: "capacity" as const, capacityConstraint: "gas-envelope" as const, failedTransactionId: launch!.id, reason: "Native transaction ceiling exceeds the supplied complete gas policy" } : {}),
    ...(calldataFailure === undefined ? {} : { failureCategory: "capacity" as const, capacityConstraint: "calldata" as const, failedTransactionId: calldataFailure.id, reason: "Encoded command exceeds the caller's calldata byte policy" }),
    ...(affordabilityFailure ? { failureCategory: "affordability" as const, failedTransactionId: launch!.id, reason: "Creator native balance cannot reserve transaction value and the native gas ceiling" } : {}),
    ...(semanticFailure === undefined ? {} : { failureCategory: "semantic" as const, failedTransactionId: transactions.find((transaction) => transaction.kind === "atomic" || transaction.kind === "activate")?.id, reason: "Opening curve output is below the committed minimum" }),
    ...(expired ? { failureCategory: "semantic" as const, failedTransactionId: transactions.find((transaction) => transaction.kind !== "cancel")?.id, reason: "Launch deadline has expired at the pinned block" } : {}),
    ...(feeFailure ? { failedTransactionId: immediate?.id, reason: "Reviewed gas price is below the pinned required fee" } : {}),
  };
  return { simulation, profileOnly: profileOnly || refused };
}
