import { toHex, zeroAddress } from "viem";
import { AUCTION_QUOTE_OPTIONS } from "../auction.js";
import { getTickAtSqrtRatio } from "../launch.js";
import { decodeAbyssLifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig } from "./markets.js";
import { computeLifecycleOpeningBuys, hasProfiledOpeningMath } from "./opening-buys.js";
import { getKnownLifecycleProfile, hmmV2ForwardingReserve } from "./presets.js";
import { lifecyclePinnedRpc, lifecycleSessionRead, nitroPosterGasBound, readNitroPrices, registerLifecycleFinalCheck, resolveLifecycleLimits, rpcHex, rpcQuantity } from "./rpc.js";
import { LifecycleFundingKind, LifecycleRewardMode, LifecycleTokenKind, type LaunchPlanV1 } from "./schema.js";
import type { GasSizingHints, NextTransactionEnvelope } from "./simulation.js";
import type { LifecycleBlock, LifecycleOpeningBuyQuote, LifecycleSimulation, LifecycleTransaction, LifecycleTransactionEstimate, SimulateLaunchPlanOptions } from "./types.js";

export const LIFECYCLE_GAS_PROFILE_VERSION = "robinhood-4663-arbos61-v1";

// Coverage, not token admission: unlisted currencies still use exact execution.
// Copy release identities once; mutating the display catalog cannot grant coverage.
const profiledQuotes = new Set<string>();
for (const quote of AUCTION_QUOTE_OPTIONS) if (quote.address !== zeroAddress) profiledQuotes.add(quote.address.toLowerCase());
const ceil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

type MarketGas = { abyss: boolean; hmm: boolean; ufg: boolean; positions: number; spacing: number; openingTick: number; ticks: number[] };

function marketGas(plan: LaunchPlanV1): MarketGas[] {
  return plan.markets.map((market) => {
    const preset = getKnownLifecycleProfile({ chainId: plan.chainId, orchestrator: plan.orchestrator, profileId: market.profileId })!;
    const abyss = market.configVersion === 1;
    const config = abyss ? decodeAbyssLifecycleMarketConfig(market.config) : decodePoolBoundV4LifecycleMarketConfig(market.config, 6);
    const price = "openingSqrtPriceX96" in config ? config.openingSqrtPriceX96 : config.sqrtPriceX96;
    const spacing = "tickSpacing" in config ? config.tickSpacing : config.fee === 100 ? 1 : config.fee === 500 ? 10 : config.fee === 3000 ? 60 : 200;
    const ticks = new Set<number>();
    for (const position of config.positions) { ticks.add(position.tickLower); ticks.add(position.tickUpper); }
    return { abyss, hmm: preset.key.includes("hmm"), ufg: preset.key.includes("ufg"), positions: config.positions.length,
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

/** Measured-envelope bases, not receipt gasUsed: retained native receipts and
 * isolated-fork minimum envelopes include creation/mint/refund/EIP150 costs.
 * HMM calls reserve their full isolated 3M budgets plus the forwarding target.
 * See docs/lifecycle-gas-profiles.md for coverage, provenance and limitations. */
function computeGasBasis(plan: LaunchPlanV1, transaction: LifecycleTransaction, markets: readonly MarketGas[], quotes: readonly LifecycleOpeningBuyQuote[]): bigint {
  const bytes = BigInt((transaction.data.length - 2) / 2), encoded = 24n * bytes;
  const policies = 100_000n * BigInt(plan.feeAssets.length);
  const token = plan.token;
  switch (transaction.kind) {
    case "approve-reset": case "approve": return 150_000n + encoded;
    case "cancel": return 350_000n + encoded + policies + 30_000n * BigInt(markets.length);
    case "begin": return 8_750_000n + tokenCreationGas(token) + encoded + policies + 150_000n * BigInt(plan.funding.length) + (markets.some((market) => market.ufg) ? 6_500_000n : 0n);
    case "prepare": {
      let gas = 500_000n + encoded + policies;
      for (let index = transaction.marketStart!; index < transaction.marketStart! + transaction.marketCount!; index += 1) {
        const market = markets[index]!;
        gas += (market.hmm ? 16_000_000n : market.ufg ? 10_000_000n : market.abyss ? 9_500_000n : 9_000_000n) + 75_000n * BigInt(market.positions);
      }
      return gas;
    }
    case "activate": case "atomic": {
      let gas = transaction.kind === "atomic" ? 19_500_000n + tokenCreationGas(token) : 1_000_000n;
      for (const [index, market] of markets.entries()) {
        if (transaction.kind === "activate") gas += market.abyss ? 2_500_000n + 1_600_000n * BigInt(market.positions) : 2_000_000n + 600_000n * BigInt(market.positions);
        else gas += (index === 0 ? market.hmm ? 7_000_000n : market.ufg ? 6_000_000n : market.abyss ? 500_000n : 0n
          : market.hmm ? 15_000_000n : market.ufg ? 9_000_000n : 8_000_000n) +
          (market.abyss ? 1_500_000n : 600_000n) * BigInt(market.positions - 1);
        if (transaction.kind === "activate" && market.hmm) gas += 6_000_000n;
      }
      const ticks = markets.map((market) => market.openingTick);
      for (const quote of quotes) {
        const market = markets[quote.marketIndex]!, before = ticks[quote.marketIndex]!, after = getTickAtSqrtRatio(quote.sqrtPriceAfterX96);
        const low = Math.min(before, after), high = Math.max(before, after);
        const words = Math.abs(Math.floor(after / (market.spacing * 256)) - Math.floor(before / (market.spacing * 256))) + 2;
        let crossings = 0;
        for (const tick of market.ticks) if (tick >= low && tick <= high) crossings += 1;
        gas += 300_000n + 8_000n * BigInt(words) + 80_000n * BigInt(crossings);
        if (token.kind === LifecycleTokenKind.ERC404) gas += 70_000n * ceil(quote.tokenOut, token.nftUnit);
        ticks[quote.marketIndex] = after;
      }
      return gas + encoded + policies;
    }
  }
}


export type ProfiledLifecycleTransactions = { simulation: LifecycleSimulation; sizing: GasSizingHints; profileOnly: boolean };

/** A fresh profile observation never installs or trusts a caller's cached proof.
 * Insufficient profile coverage/margin requests exact execution instead of
 * declaring an empirically conservative bound to be an onchain impossibility. */
export async function profileLifecycleTransactions(options: SimulateLaunchPlanOptions, transactions: readonly LifecycleTransaction[], block: LifecycleBlock,
  reviewed?: NextTransactionEnvelope, openingBuys?: readonly LifecycleOpeningBuyQuote[]): Promise<ProfiledLifecycleTransactions | undefined> {
  const { client, planned } = options, plan = planned.plan;
  if (planned.chainId !== 4663n || !hasProfiledOpeningMath(plan) || plan.markets.some((market) => !profiledQuotes.has(market.quoteAsset.toLowerCase())) ||
    plan.funding.some((funding) => funding.kind === LifecycleFundingKind.ERC20 && !profiledQuotes.has(funding.inputAsset.toLowerCase()))) return undefined;
  const context = { client, account: planned.account, orchestrator: plan.orchestrator, block, chainId: planned.chainId };
  const observed = await resolveLifecycleLimits(context, options.limits === undefined ? planned.limits : options.limits);
  if (observed.limits.arbOSVersion !== 61n) return undefined;
  const [prices, balanceValue, accountCode] = await Promise.all([
    readNitroPrices(client, block),
    lifecyclePinnedRpc(client, "eth_getBalance", [planned.account, toHex(block.number)], block),
    lifecycleSessionRead(client, `${planned.chainId}:account-code:${planned.account.toLowerCase()}`, () => lifecyclePinnedRpc(client, "eth_getCode", [planned.account, toHex(block.number)], block)),
  ]);
  if (rpcHex(accountCode, "account code") !== "0x") return undefined;
  options.signal?.throwIfAborted(); observed.assertCurrent(); registerLifecycleFinalCheck(client, observed.assertCurrent);
  const { limits } = observed, markets = marketGas(plan);
  const needsBuys = transactions.some((transaction) => transaction.kind === "atomic" || transaction.kind === "activate");
  const quotes = needsBuys ? openingBuys ?? computeLifecycleOpeningBuys({ plan, predictedToken: planned.predictedToken }) : [];
  const gasPrice = reviewed?.gasPrice ?? (prices[5] > (block.baseFeePerGas ?? 0n) * 2n ? prices[5] : (block.baseFeePerGas ?? 0n) * 2n);
  const estimates: Record<string, LifecycleTransactionEstimate> = {}, values = new Map<string, bigint>();
  const conversion = plan.funding.some((funding) => funding.kind === LifecycleFundingKind.Swap);
  let profileOnly = !conversion || !transactions.some((transaction) => transaction.kind === "begin" || transaction.kind === "atomic" || transaction.kind === "activate");
  let available = rpcQuantity(balanceValue, "creator native balance");
  let policyFailure: string | undefined;
  for (const [index, transaction] of transactions.entries()) {
    // Opaque router execution has no template gas bound. Give its one exact
    // proof the native ceiling, never a guessed conversion allowance.
    let compute = limits.executionGasCeiling;
    if (!conversion || transaction.kind !== "begin" && transaction.kind !== "atomic") {
      const basis = computeGasBasis(plan, transaction, markets, quotes);
      const reserve = transaction.kind === "atomic" || transaction.kind === "activate" ? hmmV2ForwardingReserve(plan) : 0n;
      const buffered = ceil(basis * BigInt(10000 + limits.headroomBps), 10000n);
      compute = buffered > basis + reserve ? buffered : basis + reserve;
    }
    const posterGas = nitroPosterGasBound(transaction, prices).posterGas;
    const gasLimit = index === 0 && reviewed !== undefined ? reviewed.gas : compute + posterGas;
    values.set(transaction.id, compute);
    const executionFee = gasLimit * gasPrice;
    estimates[transaction.id] = { gasLimit, gasPrice, executionFee, dataFee: 0n, totalFee: executionFee, posterGas,
      posterFee: posterGas * gasPrice, dataFeeIncludedInGas: true, feeConfidence: "profiled-execution-and-data" };
    if (compute > limits.executionGasCeiling || limits.transactionGasCeiling !== undefined && compute + posterGas > limits.transactionGasCeiling ||
      index === 0 && reviewed !== undefined && reviewed.gas < compute + posterGas ||
      gasLimit <= 0n || gasLimit >= 1n << 64n || gasPrice >= 1n << 256n || executionFee + transaction.value >= 1n << 256n) profileOnly = false;
    available -= transaction.value + executionFee;
    if (available < 0n) profileOnly = false;
    if (limits.maxCalldataBytes !== undefined && (transaction.data.length - 2) / 2 > limits.maxCalldataBytes) policyFailure = transaction.id;
  }
  const semanticFailure = quotes.find((quote) => quote.tokenOut < plan.buys[quote.buyIndex]!.minTokenOut);
  const expired = block.timestamp > plan.deadline && transactions.some((transaction) => transaction.kind !== "cancel");
  const simulation: LifecycleSimulation = {
    backend: "profiled", confidence: "profiled", executionProof: "not-run", protocolFit: "profiled", admitted: profileOnly && policyFailure === undefined && semanticFailure === undefined && !expired,
    blockNumber: block.number, blockHash: block.hash, account: planned.account, chainId: planned.chainId, limits, steps: [], deferredTransactionIds: [],
    gasProfile: { version: LIFECYCLE_GAS_PROFILE_VERSION, estimates, initialBuys: quotes },
    ...(policyFailure === undefined ? {} : { failureCategory: "capacity", capacityConstraint: "calldata", failedTransactionId: policyFailure, reason: "Encoded command exceeds the caller's calldata byte policy" }),
    ...(semanticFailure === undefined ? {} : { failureCategory: "semantic", failedTransactionId: transactions.find((transaction) => transaction.kind === "atomic" || transaction.kind === "activate")?.id, reason: "Opening curve output is below the committed minimum" }),
    ...(expired ? { failureCategory: "semantic" as const, failedTransactionId: transactions.find((transaction) => transaction.kind !== "cancel")?.id, reason: "Launch deadline has expired at the pinned block" } : {}),
  };
  return { simulation, sizing: { kind: "profiled", values }, profileOnly: profileOnly || policyFailure !== undefined || semanticFailure !== undefined || expired };
}
