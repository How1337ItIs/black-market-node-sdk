// Pure configuration example; no RPC, wallet, key, signing or broadcast.
// This is not a priced/admitted plan. Use core.predictToken(plan) for real fee policies,
// derive funded one-sided positions, then prepareAndPlanLifecycleLaunch({ ..., ufg: { config } }).
import { encodeAbiParameters, keccak256, zeroHash } from "viem";
import {
  getAddresses, KnownLifecycleProfile, getKnownLifecycleProfile,
  UFG_ORCHESTRATOR_ADDRESS, UFG_LAUNCH_PROXY_ADDRESS, encodeUfgLaunchConfig,
  hashUfgLaunchConfig, encodePoolBoundV4LifecycleMarketConfig,
} from "@black-market/sdk";

const identity = { chainId: 4663n, orchestrator: UFG_ORCHESTRATOR_ADDRESS };
const config = { treasuryShareBps: 10000, exitFeeBps: 100, reserveAssets: [getAddresses(4663).weth] };
for (const key of [KnownLifecycleProfile.V4UfgFixedPool, KnownLifecycleProfile.V4UfgDynamicPool]) {
  const preset = getKnownLifecycleProfile({ ...identity, key })!;
  const envelope = preset.profile.envelope!;
  const encoded = encodePoolBoundV4LifecycleMarketConfig({
    version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: 1n << 96n,
    hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321,
    feeMode: 1, protocolFeeDenominator: envelope.protocolFeeDenominator,
    treasury: envelope.protocolTreasury, externalLiquidityDisabled: false,
    oracleConfigId: keccak256(encodeAbiParameters([{ type: "uint24" }, { type: "uint16" }], [1, 4096])),
    hookSalt: zeroHash, profileId: preset.profile.id, termsDigest: envelope.termsDigest,
    developerBeneficiary: envelope.beneficiary, developerFeeBps: 0,
    // Geometry/price are illustrative. Real launch uses predicted token ordering and budget-funded ranges.
    positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1000n, salt: zeroHash, maxTokenAmount: 1000000n }],
    ufgLaunchConfig: config,
  });
  console.log(key, { proxy: UFG_LAUNCH_PROXY_ADDRESS, profileId: preset.profile.id,
    configBytes: (encoded.length - 2) / 2, tailBytes: (encodeUfgLaunchConfig(config).length - 2) / 2,
    launchConfigHash: hashUfgLaunchConfig(config) });
}
