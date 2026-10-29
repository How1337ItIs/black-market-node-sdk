import { decodeAbiParameters, encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { LifecyclePlanningError } from "./types.js";

export const AUTO_COMPOUND_STATIC_V1_PROFILE_ID: Hex = "0xdd53c2c686f822b2d17536ccf4f9db954b4976d1be80404bc74571253179fae0";
export const AUTO_COMPOUND_DYNAMIC_V1_PROFILE_ID: Hex = "0x46b81bfe9316fbaa90e930c6f1d5ad5e6ecfced2c886fd5520ca2bae11b92744";
export const AUTO_COMPOUND_CONFIG_VERSION = keccak256(stringToHex("black-market.auto-compound.config.v1"));

export function isAutoCompoundProfile(profileId: Hex): boolean {
  const id = profileId.toLowerCase();
  return id === AUTO_COMPOUND_STATIC_V1_PROFILE_ID || id === AUTO_COMPOUND_DYNAMIC_V1_PROFILE_ID;
}

/** Share of net hook fees allocated to automatic, permanently locked liquidity. */
export type AutoCompoundConfigV1 = { compoundShareBps: number };
export const autoCompoundConfigV1Components = [
  { name: "version", type: "bytes32" }, { name: "compoundShareBps", type: "uint16" },
] as const;

export function validateAutoCompoundConfig(config: AutoCompoundConfigV1): void {
  if (!Number.isInteger(config.compoundShareBps) || config.compoundShareBps < 0 || config.compoundShareBps > 10000) {
    throw new LifecyclePlanningError("INVALID_AUTO_COMPOUND_CONFIG", "compoundShareBps must be an integer between 0 and 10000");
  }
}

/** Exactly abi.encode(AutoCompoundConfigV1): two static words (64 bytes). */
export function encodeAutoCompoundTail(config: AutoCompoundConfigV1): Hex {
  validateAutoCompoundConfig(config);
  return encodeAbiParameters([{ type: "tuple", components: autoCompoundConfigV1Components }], [{ version: AUTO_COMPOUND_CONFIG_VERSION, compoundShareBps: config.compoundShareBps }]);
}

export function decodeAutoCompoundTail(encoded: Hex): AutoCompoundConfigV1 {
  if (encoded.length !== 2 + 64 * 2) throw new LifecyclePlanningError("INVALID_AUTO_COMPOUND_CONFIG", "Auto-compounding tail must be exactly 64 bytes");
  const { version, compoundShareBps } = decodeAbiParameters([{ type: "tuple", components: autoCompoundConfigV1Components }], encoded)[0];
  if (version !== AUTO_COMPOUND_CONFIG_VERSION) throw new LifecyclePlanningError("INVALID_AUTO_COMPOUND_CONFIG", "Unknown auto-compounding config version");
  const config = { compoundShareBps };
  if (encodeAutoCompoundTail(config).toLowerCase() !== encoded.toLowerCase()) throw new LifecyclePlanningError("INVALID_AUTO_COMPOUND_CONFIG", "Auto-compounding tail is not canonical");
  return config;
}
