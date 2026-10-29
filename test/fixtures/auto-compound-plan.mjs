import { getAddresses } from '../../dist/index.js';
import * as sdk from '../../dist/lifecycle/index.js';
import { encodeAbiParameters, keccak256, toHex, zeroHash } from 'viem';

export const identity = { chainId: 4663n, orchestrator: '0x91560876033d568d25CDe98C78c33ff8FC43962c' };
export const keys = [sdk.KnownLifecycleProfile.V4AutoCompoundStaticPool, sdk.KnownLifecycleProfile.V4AutoCompoundDynamicPool];
export const testToken = '0x0000000000000000000000000000000000000010';
export const quote = getAddresses(4663).weth;
export function makeAutoCompoundPlan(key, { feeMode = 0, compoundShareBps = 5000, token = testToken } = {}) {
  const preset = sdk.getKnownLifecycleProfile({ ...identity, key });
  const envelope = preset.profile.envelope;
  const supply = 1000000n * 10n ** 18n;
  const creator = '0x00000000000000000000000000000000000000a0';
  const config = { version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: 1n << 96n,
    hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321,
    feeMode, protocolFeeDenominator: envelope.protocolFeeDenominator, treasury: envelope.protocolTreasury,
    externalLiquidityDisabled: false,
    oracleConfigId: keccak256(encodeAbiParameters([{ type: 'uint24' }, { type: 'uint16' }], [1, 4096])),
    hookSalt: zeroHash, profileId: preset.profile.id, termsDigest: envelope.termsDigest,
    developerBeneficiary: envelope.beneficiary, developerFeeBps: 0,
    positions: [{ tickLower: BigInt(token) < BigInt(quote) ? 0 : -887220, tickUpper: BigInt(token) < BigInt(quote) ? 887220 : 0,
      liquidity: 10n ** 20n, salt: zeroHash, maxTokenAmount: supply }], autoCompoundConfig: { compoundShareBps } };
  const market = { adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id,
    quoteAsset: quote, tokenBudget: supply, configVersion: 6, config: sdk.encodePoolBoundV4LifecycleMarketConfig(config) };
  const plan = { ...identity, creator, nonce: BigInt(2026102800 + keys.indexOf(key) * 10 + feeMode),
    token: { kind: 0, rewardMode: 0, name: 'Auto compound SDK planning', symbol: 'ACSDK', supply, nftUnit: 0n,
      metadataURI: '', salt: toHex(20261028n, { size: 32 }), inventoryRecipient: creator, burnOnCancel: true },
    funding: [], feeAssets: [
      { asset: token, ownerBps: 0, rewardsBps: 0, burnBps: 10000 },
      { asset: quote, ownerBps: 10000, rewardsBps: 0, burnBps: 0 },
    ].sort((a, b) => BigInt(a.asset) < BigInt(b.asset) ? -1 : 1),
    markets: [market], buys: [], deadline: 2000000000n, executorFeeBps: 0 };
  return { plan, config, preset };
}
