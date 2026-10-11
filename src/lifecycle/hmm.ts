import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from "viem";
import { AUCTION_QUOTE_OPTIONS, ROBINHOOD_WETH } from "../auction.js";
import { LifecyclePlanningError } from "./types.js";

export const HMM_FIXED_PROFILE_ID: Hex = "0x7e51d9aa979940e7867c75a82e05e924aa067e9d436f7731c3e3299f9e55d53d";
export const HMM_DYNAMIC_PROFILE_ID: Hex = "0x109598e017b8f12648aff0f0dc04dbf8d4c0493f41a63068682d8f9d0a07a83d";
export function isHmmProfile(profileId: Hex): boolean {
  const id = profileId.toLowerCase();
  return id === HMM_FIXED_PROFILE_ID || id === HMM_DYNAMIC_PROFILE_ID;
}

/** Widths and displacement are tick spacings; amounts are raw token/quote units. */
export type HmmStrategyConfig = {
  bidWidth: number; askWidth: number; gap: number; staleAfterSeconds: number; staleDisplacement: number;
  minQuoteDeploy: bigint; minQuoteHarvest: bigint; minTokenHarvest: bigint;
  resalePremiumBps: number; maxAsks: number; maxAskTokenExposure: bigint; maxAcquiredInventory: bigint;
  premiumDecaySeconds: number;
};
export type HmmLaunchConfig = { strategyShareBps: number; strategy: HmmStrategyConfig };
export const hmmStrategyComponents = [
  { name: "bidWidth", type: "int24" }, { name: "askWidth", type: "int24" }, { name: "gap", type: "int24" },
  { name: "staleAfterSeconds", type: "uint32" }, { name: "staleDisplacement", type: "int24" },
  { name: "minQuoteDeploy", type: "uint256" }, { name: "minQuoteHarvest", type: "uint256" },
  { name: "minTokenHarvest", type: "uint256" }, { name: "resalePremiumBps", type: "uint16" },
  { name: "maxAsks", type: "uint8" }, { name: "maxAskTokenExposure", type: "uint256" },
  { name: "maxAcquiredInventory", type: "uint256" }, { name: "premiumDecaySeconds", type: "uint32" },
] as const;
export const hmmLaunchComponents = [
  { name: "strategyShareBps", type: "uint16" }, { name: "strategy", type: "tuple", components: hmmStrategyComponents },
] as const;

function integer(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer between ${min} and ${max}`);
}
function amount(name: string, value: bigint, min: bigint, max = (1n << 256n) - 1n): void {
  if (typeof value !== "bigint" || value < min || value > max) invalid(`${name} must be a bigint between ${min} and ${max}`);
}
function invalid(message: string): never { throw new LifecyclePlanningError("INVALID_HMM_CONFIG", message); }

/** Mirrors HMMFeeCollectorFactoryV1._decodeHMM, including Solidity field widths. */
export function validateHmmLaunchConfig(config: HmmLaunchConfig): void {
  integer("strategyShareBps", config.strategyShareBps, 0, 10000);
  const s = config.strategy;
  integer("bidWidth", s.bidWidth, 1, 8388607);
  integer("askWidth", s.askWidth, 1, 8388607);
  integer("gap", s.gap, 0, 8388607);
  integer("staleAfterSeconds", s.staleAfterSeconds, 1, 0xffffffff);
  integer("staleDisplacement", s.staleDisplacement, 1, 8388607);
  integer("resalePremiumBps", s.resalePremiumBps, 0, 5000);
  integer("maxAsks", s.maxAsks, 1, 8);
  integer("premiumDecaySeconds", s.premiumDecaySeconds, 0, 0xffffffff);
  amount("minQuoteDeploy", s.minQuoteDeploy, 0n);
  amount("minQuoteHarvest", s.minQuoteHarvest, 1n);
  amount("minTokenHarvest", s.minTokenHarvest, 1n);
  const cap = (1n << 128n) - 1n;
  amount("maxAskTokenExposure", s.maxAskTokenExposure, 0n, cap);
  amount("maxAcquiredInventory", s.maxAcquiredInventory, s.minTokenHarvest, cap);
  if (s.maxAskTokenExposure < BigInt(s.maxAsks) || s.maxAskTokenExposure < s.minTokenHarvest) invalid("maxAskTokenExposure must cover maxAsks and minTokenHarvest");
}

/** Exactly abi.encode(HMMLaunchConfigV1): fourteen static words (448 bytes). */
export function encodeHmmLaunchTail(config: HmmLaunchConfig): Hex {
  validateHmmLaunchConfig(config);
  return encodeAbiParameters([{ type: "tuple", components: hmmLaunchComponents }], [config]);
}
export function decodeHmmLaunchTail(encoded: Hex): HmmLaunchConfig {
  if (encoded.length !== 2 + 448 * 2) invalid("HMM launch tail must be exactly 448 bytes");
  const config = decodeAbiParameters([{ type: "tuple", components: hmmLaunchComponents }], encoded)[0];
  if (encodeHmmLaunchTail(config).toLowerCase() !== encoded.toLowerCase()) invalid("HMM launch tail is not canonical");
  return config;
}

/** Model calibration defaults, not an investment recommendation. Unknown quotes need explicit thresholds. */
export function defaultHmmLaunchConfig(options: {
  tokenBudget: bigint; quoteAsset: Address | string; quoteDecimals?: number;
  minQuoteDeploy?: bigint; minQuoteHarvest?: bigint;
}): HmmLaunchConfig {
  amount("tokenBudget", options.tokenBudget, 1n, (1n << 128n) - 1n);
  const quote = AUCTION_QUOTE_OPTIONS.find((q) => q.id === options.quoteAsset || q.address.toLowerCase() === options.quoteAsset.toLowerCase());
  const decimals = options.quoteDecimals ?? quote?.decimals;
  if (decimals !== undefined) integer("quoteDecimals", decimals, 0, 255);
  if (quote !== undefined && decimals !== quote.decimals) invalid("quoteDecimals must match the supported quote asset");
  const weth = quote?.address.toLowerCase() === ROBINHOOD_WETH.toLowerCase();
  const unit = decimals === undefined ? undefined : 10n ** BigInt(decimals);
  const minQuoteDeploy = options.minQuoteDeploy ?? (weth ? 500000000000000n : quote?.usdPeg && unit !== undefined ? unit : undefined);
  const minQuoteHarvest = options.minQuoteHarvest ?? (weth ? 5000000000000000n : quote?.usdPeg && unit !== undefined ? 10n * unit : undefined);
  if (minQuoteDeploy === undefined || minQuoteHarvest === undefined) invalid("Unsupported quote asset requires explicit minQuoteDeploy and minQuoteHarvest");
  const config: HmmLaunchConfig = {
    strategyShareBps: 5000,
    strategy: {
      bidWidth: 5, askWidth: 5, gap: 1, staleAfterSeconds: 86400, staleDisplacement: 5,
      minQuoteDeploy, minQuoteHarvest, minTokenHarvest: options.tokenBudget / 100000n,
      resalePremiumBps: 500, maxAsks: 4, maxAskTokenExposure: options.tokenBudget / 10n,
      maxAcquiredInventory: options.tokenBudget, premiumDecaySeconds: 0,
    },
  };
  validateHmmLaunchConfig(config);
  return config;
}
