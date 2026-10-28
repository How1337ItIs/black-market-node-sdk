import { decodeFunctionResult, encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { lifecycleErc20Abi } from "./abi.js";
import { ufgLaunchProxyV1Abi, ufgTreasuryFactoryV1Abi } from "./ufg-abi.js";
import { buildLifecycleCommands } from "./transactions.js";
import { decodeAbyssLifecycleMarketConfig, encodeAbyssLifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig } from "./markets.js";
import { getKnownLifecycleProfile, KnownLifecycleProfile } from "./presets.js";
import { LifecycleFundingKind, LifecycleTokenKind, LifecycleRewardMode, type LaunchPlanV1 } from "./schema.js";
import { LifecyclePlanningError, type BuildLaunchTransactionsOptions, type LifecycleRpcClient, type LifecycleTransaction } from "./types.js";
import { buildUfgFeeAssetPolicies, encodeUfgLaunchConfig, hashUfgLaunchConfig, isUfgProfile, UFG_DYNAMIC_ADAPTER_ID, UFG_FIXED_ADAPTER_ID, UFG_FIXED_PROFILE_ID, UFG_LAUNCH_PROXY_ADDRESS, UFG_TREASURY_FACTORY_ADDRESS, ufgPlanPrincipal, type UfgLaunchConfig } from "./ufg-config.js";

export { UFG_LAUNCH_PROXY_ADDRESS, UFG_TREASURY_FACTORY_ADDRESS, UFG_UPSTREAM_FACTORY_ADDRESS, UFG_ORCHESTRATOR_ADDRESS, UFG_FIXED_PROFILE_ID, UFG_DYNAMIC_PROFILE_ID, UFG_FIXED_ADAPTER_ID, UFG_DYNAMIC_ADAPTER_ID, isUfgProfile, ufgLaunchConfigComponents, encodeUfgLaunchConfig, decodeUfgLaunchConfig, hashUfgLaunchConfig, validateUfgLaunchConfig, ufgLaunchNonce, buildUfgFeeAssetPolicies, type UfgLaunchConfig } from "./ufg-config.js";

/** Offline proxy-specific admission. Live token/reserve code, registry and transfer checks still require simulation. */
export function validateUfgLaunchPlan(plan: LaunchPlanV1, config: UfgLaunchConfig, predictedToken: Address): void {
  try {
    ufgPlanPrincipal(plan);
    encodeUfgLaunchConfig(config);
    if (plan.token.kind !== LifecycleTokenKind.ERC20 || plan.token.rewardMode !== LifecycleRewardMode.None || plan.executorFeeBps !== 0 || plan.markets.length === 0 || plan.token.inventoryRecipient.toLowerCase() === UFG_LAUNCH_PROXY_ADDRESS.toLowerCase() || plan.buys.some((buy) => buy.recipient.toLowerCase() === UFG_LAUNCH_PROXY_ADDRESS.toLowerCase())) throw new Error("UFG requires ERC20/no rewards, zero executor fee, markets and external inventory/buy recipients");
    const expected = buildUfgFeeAssetPolicies(predictedToken, config.reserveAssets);
    if (plan.feeAssets.length !== expected.length || plan.feeAssets.some((policy, index) => {
      const required = expected[index]!;
      return policy.asset.toLowerCase() !== required.asset.toLowerCase() || policy.ownerBps !== required.ownerBps || policy.rewardsBps !== 0 || policy.burnBps !== required.burnBps;
    })) throw new Error("UFG fee policies must burn all token fees and send all reserve fees to the owner, in ascending asset order");
    const reserves = new Set(config.reserveAssets.map((asset) => asset.toLowerCase()));
    const quotes = new Set(plan.markets.map((market) => market.quoteAsset.toLowerCase()));
    if (reserves.size !== quotes.size || [...quotes].some((quote) => !reserves.has(quote))) throw new Error("Every reserve must be a market quote and every market quote a reserve");
    const configHash = hashUfgLaunchConfig(config);
    for (const market of plan.markets) {
      if (market.configVersion === 1) {
        const inner = decodeAbyssLifecycleMarketConfig(market.config);
        const profile = getKnownLifecycleProfile({ chainId: plan.chainId, orchestrator: plan.orchestrator, key: inner.profile === 2 ? KnownLifecycleProfile.Abyss2 : KnownLifecycleProfile.Abyss3 });
        if (market.adapterId.toLowerCase() !== keccak256(stringToHex("black-market.adapter.abyss-lifecycle.v1")) || (inner.profile !== 2 && inner.profile !== 3) || market.profileId.toLowerCase() !== profile?.profile.id || encodeAbyssLifecycleMarketConfig(inner).toLowerCase() !== market.config.toLowerCase()) throw new Error("UFG Abyss markets require canonical QUOTE or QUOTE_ORACLE config1 without a tail");
      } else if (market.configVersion === 6) {
        if (!isUfgProfile(market.profileId)) throw new Error("UFG config6 markets require an admitted UFG fixed or dynamic profile");
        const inner = decodePoolBoundV4LifecycleMarketConfig(market.config, 6);
        const adapterId = market.profileId.toLowerCase() === UFG_FIXED_PROFILE_ID ? UFG_FIXED_ADAPTER_ID : UFG_DYNAMIC_ADAPTER_ID;
        if (market.adapterId.toLowerCase() !== adapterId || inner.profileId.toLowerCase() !== market.profileId.toLowerCase() || inner.version !== 6 || inner.feeMode !== 1 || inner.lpFeePips !== 0 || inner.ufgLaunchConfig === undefined || hashUfgLaunchConfig(inner.ufgLaunchConfig) !== configHash) throw new Error("Every UFG config6 market requires QuoteOnly, zero LP fee and the identical canonical proxy config tail");
      } else throw new Error("UFG supports only canonical Abyss config1 and UFG pool-bound config6");
    }
  } catch (error) {
    if (error instanceof LifecyclePlanningError && error.code === "INVALID_UFG_PLAN") throw error;
    throw new LifecyclePlanningError("INVALID_UFG_PLAN", error instanceof Error ? error.message : "Invalid UFG launch plan");
  }
}

export type BuildUfgLaunchTransactionsOptions = BuildLaunchTransactionsOptions & { config: UfgLaunchConfig };
/** Pure unsigned proxy commands; account is the principal encoded in plan.nonce. */
export function buildUfgLaunchTransactions(options: BuildUfgLaunchTransactionsOptions): LifecycleTransaction[] {
  const { plan, config } = options;
  const principal = ufgPlanPrincipal(plan);
  encodeUfgLaunchConfig(config);
  return buildLifecycleCommands(options, { account: principal, config });
}
export function buildUfgCancelTransaction({ plan, preparedMarkets = 0 }: { plan: LaunchPlanV1; preparedMarkets?: number }): LifecycleTransaction {
  const data = encodeFunctionData({ abi: ufgLaunchProxyV1Abi, functionName: "cancelLaunch", args: [plan] });
  return { id: "cancel", kind: "cancel", chainId: Number(plan.chainId), from: ufgPlanPrincipal(plan), to: UFG_LAUNCH_PROXY_ADDRESS, data, calldataBytes: (data.length - 2) / 2, value: 0n, dependencies: [], postconditions: [{ kind: "launch", phase: "Cancelled", preparedMarkets }] };
}
/** Exact summed proxy pulls, not escrow allowances. Current allowance/reset discovery belongs to planning. */
export function buildUfgApprovals(plan: LaunchPlanV1): LifecycleTransaction[] {
  const principal = ufgPlanPrincipal(plan);
  const totals = new Map<string, { asset: Address; amount: bigint }>();
  for (const funding of plan.funding) {
    if (funding.kind === LifecycleFundingKind.NativeWrap || BigInt(funding.inputAsset) === 0n) continue;
    const asset = funding.kind === LifecycleFundingKind.ERC20 ? funding.asset : funding.inputAsset;
    const amount = funding.kind === LifecycleFundingKind.ERC20 ? funding.amount : funding.inputAmount;
    const key = asset.toLowerCase();
    const entry = totals.get(key);
    if (entry === undefined) totals.set(key, { asset, amount }); else entry.amount += amount;
  }
  const transactions = [...totals.values()].map(({ asset, amount }): LifecycleTransaction => {
    const data = encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "approve", args: [UFG_LAUNCH_PROXY_ADDRESS, amount] });
    return { id: `approve:${asset}`, kind: "approve", chainId: Number(plan.chainId), from: principal, to: asset, data, calldataBytes: (data.length - 2) / 2, value: 0n, dependencies: [], postconditions: [{ kind: "allowance", asset, spender: UFG_LAUNCH_PROXY_ADDRESS, minimum: amount }] };
  });
  return transactions.map((transaction, index) => ({ ...transaction, dependencies: index === 0 ? [] : [transactions[index - 1]!.id] }));
}
/** Read-only upstream treasury lookup. No treasury is represented by undefined, not the zero address. */
export async function readUfgTreasury(client: LifecycleRpcClient, token: Address): Promise<Address | undefined> {
  const data = encodeFunctionData({ abi: ufgTreasuryFactoryV1Abi, functionName: "treasuryOf", args: [token] });
  const result = await client.request({ method: "eth_call", params: [{ to: UFG_TREASURY_FACTORY_ADDRESS, data }, "latest"] });
  const treasury = decodeFunctionResult({ abi: ufgTreasuryFactoryV1Abi, functionName: "treasuryOf", data: result as `0x${string}` });
  return treasury === zeroAddress ? undefined : treasury;
}
