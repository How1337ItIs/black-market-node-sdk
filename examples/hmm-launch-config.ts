// Pure configuration example; not a priced/admitted launch and never signs or broadcasts.
import { keccak256, zeroHash } from "viem";
import {
  KnownLifecycleProfile, defaultHmmLaunchConfig, encodeHmmLaunchTail,
  encodePoolBoundV4LifecycleMarketConfig, getKnownLifecycleProfile,
} from "@black-market/sdk";

const identity = { chainId: 4663n, orchestrator: "0x91560876033d568d25CDe98C78c33ff8FC43962c" as const };
const tokenBudget = 1000000n * 10n ** 18n;
for (const key of [KnownLifecycleProfile.V4HmmFixedPool, KnownLifecycleProfile.V4HmmDynamicPool]) {
  const preset = getKnownLifecycleProfile({ ...identity, key })!;
  const envelope = preset.profile.envelope!;
  const hmmLaunchConfig = defaultHmmLaunchConfig({ tokenBudget, quoteAsset: "USDG", quoteDecimals: 6 });
  // Optional explicit choices: share 2500/5000/10000 bps; decay off/259200 (72h).
  const config = encodePoolBoundV4LifecycleMarketConfig({
    version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: 1n << 96n,
    hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321,
    feeMode: 0, protocolFeeDenominator: envelope.protocolFeeDenominator,
    treasury: envelope.protocolTreasury, externalLiquidityDisabled: true,
    oracleConfigId: keccak256("0x01"), hookSalt: zeroHash, profileId: preset.profile.id,
    termsDigest: envelope.termsDigest, developerBeneficiary: envelope.beneficiary, developerFeeBps: 0,
    // Illustrative only: derive actual budget-funded one-sided ranges/price and
    // select a real admitted oracle before prepareAndPlanLifecycleLaunch.
    positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1000n, salt: zeroHash, maxTokenAmount: tokenBudget }],
    hmmLaunchConfig,
  });
  console.log(key, { profileId: preset.profile.id, configBytes: (config.length - 2) / 2,
    tailBytes: (encodeHmmLaunchTail(hmmLaunchConfig).length - 2) / 2 });
}
