import { decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import type { LaunchPlanV1, LifecycleFeeAssetPolicyV2 } from "./schema.js";
import { LifecyclePlanningError } from "./types.js";

export const UFG_LAUNCH_PROXY_ADDRESS: Address = "0xf6673d859DE03eB74A0b01696Edb97f941dFD0CA";
export const UFG_TREASURY_FACTORY_ADDRESS: Address = "0x26Aa5D52134c8E6c4C01E9fb53A7568c0C64901F";
export const UFG_UPSTREAM_FACTORY_ADDRESS: Address = "0xA170b5A58C111334A7237F2Ea2c428ec5022f68E";
export const UFG_ORCHESTRATOR_ADDRESS: Address = "0x91560876033d568d25CDe98C78c33ff8FC43962c";
export const UFG_FIXED_PROFILE_ID: Hex = "0x5c6045af480814e469f3dba7c120d264047c9320b869c63a064536041a2dbae6";
export const UFG_DYNAMIC_PROFILE_ID: Hex = "0x03de8d5e38f2957d80ecb9f2e59d555601ff091dfb17bce84178956a2e8d9b41";
export const UFG_FIXED_ADAPTER_ID: Hex = "0x073a4d46af70a3d4f69641e4f9dcdc9d8c279cd443daff960bbdf65a3b5fc758";
export const UFG_DYNAMIC_ADAPTER_ID: Hex = "0xc0906e17625b48240a87a3afc6ee921b653bdacd72906a16b359d0776d938518";

export function isUfgProfile(profileId: Hex): boolean {
  const id = profileId.toLowerCase();
  return id === UFG_FIXED_PROFILE_ID || id === UFG_DYNAMIC_PROFILE_ID;
}

export type UfgLaunchConfig = { treasuryShareBps: number; exitFeeBps: number; reserveAssets: readonly Address[] };
export const ufgLaunchConfigComponents = [
  { name: "treasuryShareBps", type: "uint16" }, { name: "exitFeeBps", type: "uint16" },
  { name: "reserveAssets", type: "address[]" },
] as const;

/** The proxy has seven reserve slots; its eighth fee asset is the launched token. */
export function validateUfgLaunchConfig(config: UfgLaunchConfig): void {
  if (config.treasuryShareBps !== 10000 || !Number.isInteger(config.exitFeeBps) || config.exitFeeBps < 0 || config.exitFeeBps > 2000 || config.reserveAssets.length < 1 || config.reserveAssets.length > 7) {
    throw new LifecyclePlanningError("INVALID_UFG_CONFIG", "UFG requires 10000 treasury bps, exit fee 0..2000 bps and one to seven reserves");
  }
  let previous = 0n;
  for (const asset of config.reserveAssets) {
    getAddress(asset);
    if (BigInt(asset) <= previous) throw new LifecyclePlanningError("INVALID_UFG_CONFIG", "UFG reserves must be nonzero, unique and strictly ascending");
    previous = BigInt(asset);
  }
}

/** abi.encode(UFGLaunchConfigV1): one dynamic tuple, including its leading 0x20 offset. */
export function encodeUfgLaunchConfig(config: UfgLaunchConfig): Hex {
  validateUfgLaunchConfig(config);
  return encodeAbiParameters([{ type: "tuple", components: ufgLaunchConfigComponents }], [config]);
}
export function decodeUfgLaunchConfig(encoded: Hex): UfgLaunchConfig {
  const config = decodeAbiParameters([{ type: "tuple", components: ufgLaunchConfigComponents }], encoded)[0];
  if (encodeUfgLaunchConfig(config).toLowerCase() !== encoded.toLowerCase()) throw new LifecyclePlanningError("INVALID_UFG_CONFIG", "UFG launch config must use canonical tuple encoding with no extra bytes");
  return config;
}
export function hashUfgLaunchConfig(config: UfgLaunchConfig): Hex {
  return keccak256(encodeUfgLaunchConfig(config));
}
export function ufgLaunchNonce(principal: Address, nonce: bigint): bigint {
  getAddress(principal);
  if (BigInt(principal) === 0n || nonce < 0n || nonce >= 1n << 96n) throw new LifecyclePlanningError("INVALID_UFG_NONCE", "UFG requires a nonzero principal and a uint96 nonce");
  return BigInt(principal) << 96n | nonce;
}

/** Internal routing guard, also used by canonical progress and receipt verification. */
export function assertUfgLaunchAccount(plan: LaunchPlanV1, account: Address): void {
  if (plan.chainId !== 4663n || plan.orchestrator.toLowerCase() !== UFG_ORCHESTRATOR_ADDRESS.toLowerCase() || plan.creator.toLowerCase() !== UFG_LAUNCH_PROXY_ADDRESS.toLowerCase() || plan.nonce < 0n || plan.nonce >= 1n << 256n || plan.nonce >> 96n !== BigInt(account) || BigInt(account) === 0n) {
    throw new LifecyclePlanningError("INVALID_UFG_PLAN", "UFG plans require the pinned Robinhood core/proxy and the sender's principal-namespaced nonce");
  }
}
export function ufgPlanPrincipal(plan: LaunchPlanV1): Address {
  if (plan.nonce < 0n || plan.nonce >= 1n << 256n) throw new LifecyclePlanningError("INVALID_UFG_PLAN", "UFG nonce must fit uint256");
  const principal = getAddress(`0x${(plan.nonce >> 96n).toString(16).padStart(40, "0")}`);
  assertUfgLaunchAccount(plan, principal);
  return principal;
}
export function buildUfgFeeAssetPolicies(token: Address, reserveAssets: readonly Address[]): LifecycleFeeAssetPolicyV2[] {
  validateUfgLaunchConfig({ treasuryShareBps: 10000, exitFeeBps: 0, reserveAssets });
  getAddress(token);
  if (BigInt(token) === 0n || reserveAssets.some((asset) => asset.toLowerCase() === token.toLowerCase())) throw new LifecyclePlanningError("INVALID_UFG_CONFIG", "The launched token must be nonzero and distinct from every reserve");
  return [
    { asset: token, ownerBps: 0, rewardsBps: 0, burnBps: 10000 },
    ...reserveAssets.map((asset) => ({ asset, ownerBps: 10000, rewardsBps: 0, burnBps: 0 })),
  ].sort((a, b) => BigInt(a.asset) < BigInt(b.asset) ? -1 : 1);
}
