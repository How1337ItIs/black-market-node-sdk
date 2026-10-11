import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { concatHex, decodeFunctionData, encodeAbiParameters, keccak256, zeroHash } from 'viem';
const sdkPath = process.env.SDK_SOURCE_TEST === '1' ? '../src/lifecycle/index.ts' : '../dist/lifecycle/index.js';
const sdk = await import(sdkPath);
const { deriveKnownPoolBoundHookDeployment } = await import(sdkPath.replace('index.', 'calibration.'));
const vectors = JSON.parse(await readFile(new URL('./fixtures/hmm-launch-tail.json', import.meta.url), 'utf8'));
const original = sdk.parseLaunchPlan(await readFile(new URL('./fixtures/launch-lifecycle-v1.json', import.meta.url), 'utf8').then((s) => JSON.stringify(JSON.parse(s).plan)));
const identity = { chainId: 4663n, orchestrator: '0x91560876033d568d25CDe98C78c33ff8FC43962c' };
const fields = ['bidWidth', 'askWidth', 'gap', 'staleAfterSeconds', 'staleDisplacement', 'minQuoteDeploy', 'minQuoteHarvest', 'minTokenHarvest', 'resalePremiumBps', 'maxAsks', 'maxAskTokenExposure', 'maxAcquiredInventory', 'premiumDecaySeconds'];
const amounts = new Set(['minQuoteDeploy', 'minQuoteHarvest', 'minTokenHarvest', 'maxAskTokenExposure', 'maxAcquiredInventory']);
for (const fixture of vectors.cases) test(`HMM tail matches cast abi-encode: ${fixture.name}`, () => {
  const config = { strategyShareBps: fixture.values[0], strategy: Object.fromEntries(fields.map((field, index) => [field, amounts.has(field) ? BigInt(fixture.values[1][index]) : fixture.values[1][index]])) };
  assert.equal(sdk.encodeHmmLaunchTail(config), fixture.encoded);
  assert.equal((fixture.encoded.length - 2) / 2, 448);
  assert.deepEqual(sdk.decodeHmmLaunchTail(fixture.encoded), config);
});
const defaults = () => sdk.defaultHmmLaunchConfig({ tokenBudget: 1000000n * 10n ** 18n, quoteAsset: 'WETH' });
const invalidCases = [
  ['strategyShareBps', -1], ['strategyShareBps', 10001], ['strategyShareBps', 0.5],
  ['bidWidth', 0], ['bidWidth', 8388608], ['askWidth', -1], ['askWidth', 8388608], ['gap', -1], ['gap', 8388608],
  ['staleAfterSeconds', 0], ['staleAfterSeconds', 4294967296], ['staleDisplacement', 0], ['staleDisplacement', 8388608],
  ['minQuoteDeploy', -1n], ['minQuoteDeploy', 1n << 256n], ['minQuoteHarvest', 0n], ['minQuoteHarvest', 1n << 256n],
  ['minTokenHarvest', 0n], ['resalePremiumBps', 5001], ['maxAsks', 0], ['maxAsks', 9],
  ['maxAskTokenExposure', 3n], ['maxAskTokenExposure', 10n ** 18n], ['maxAskTokenExposure', 1n << 128n],
  ['maxAcquiredInventory', 1n], ['maxAcquiredInventory', 1n << 128n], ['premiumDecaySeconds', -1], ['premiumDecaySeconds', 4294967296],
];
for (const [field, value] of invalidCases) test(`HMM factory validation rejects ${field}=${value}`, () => {
  const config = defaults();
  if (field === 'strategyShareBps') config[field] = value; else config.strategy[field] = value;
  assert.throws(() => sdk.encodeHmmLaunchTail(config), { code: 'INVALID_HMM_CONFIG' });
});
test('HMM default calibration resolves only supported quote economics', () => {
  const config = defaults();
  assert.equal(config.strategyShareBps, 5000);
  assert.equal(config.strategy.maxAskTokenExposure, 100000n * 10n ** 18n);
  assert.equal(config.strategy.maxAcquiredInventory, 1000000n * 10n ** 18n);
  assert.equal(config.strategy.minTokenHarvest, 10n * 10n ** 18n);
  assert.equal(config.strategy.premiumDecaySeconds, 0);
  const stable = sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', quoteDecimals: 6 });
  assert.equal(stable.strategy.minQuoteDeploy, 1000000n);
  assert.equal(stable.strategy.minQuoteHarvest, 10000000n);
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 99999n, quoteAsset: 'WETH' }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'ABYSS' }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'USDG', quoteDecimals: 18 }), { code: 'INVALID_HMM_CONFIG' });
  const custom = sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'UNKNOWN', minQuoteDeploy: 0n, minQuoteHarvest: 1n });
  assert.equal(custom.strategy.minQuoteDeploy, 0n);
});
for (const key of [sdk.KnownLifecycleProfile.V4HmmFixedPool, sdk.KnownLifecycleProfile.V4HmmDynamicPool]) test(`${key}: frozen commitments, typed tail, constructor mining and unsigned plans`, async () => {
  const preset = sdk.getKnownLifecycleProfile({ ...identity, key });
  const envelope = preset.profile.envelope;
  const deployment = sdk.getKnownLifecycleDeployment(identity);
  assert.equal(sdk.hashLifecycleProfile(envelope), preset.profile.id);
  assert.equal(sdk.hashLaunchBounds(envelope.bounds), envelope.configBoundsDigest);
  assert.equal(keccak256(preset.boundHook.creationCode), envelope.artifactDigest);
  assert.equal(sdk.hashLaunchDependencies({ ...identity, core: identity.orchestrator, registry: deployment.registry, registrar: preset.boundHook.registrar, graph: envelope.graph }), preset.profile.registration.dependencyDigest);
  assert.equal(envelope.maximumDeveloperFeeBps, 0);
  assert.equal(Object.hasOwn(preset.profile, 'admitted'), false);
  for (const value of [preset, preset.profile, preset.profile.adapter, preset.profile.registration, preset.profile.topology, envelope, envelope.bounds, envelope.graph, preset.boundHook, preset.profile.developerTerms]) assert.equal(Object.isFrozen(value), true);
  const source = sdk.decodeV4LifecycleMarketConfig(original.markets[0].config);
  const tokenBudget = source.positions.reduce((sum, p) => sum + p.maxTokenAmount, 0n);
  const config = { ...source, version: 6, lpFeePips: 0, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321,
    profileId: preset.profile.id, treasury: envelope.protocolTreasury, protocolFeeDenominator: envelope.protocolFeeDenominator,
    termsDigest: envelope.termsDigest, developerBeneficiary: envelope.beneficiary, developerFeeBps: 0, hookSalt: zeroHash,
    hmmLaunchConfig: sdk.defaultHmmLaunchConfig({ tokenBudget, quoteAsset: 'WETH' }) };
  const encoded = sdk.encodePoolBoundV4LifecycleMarketConfig(config);
  const prefix = encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [config]);
  assert.equal(encoded, concatHex([prefix, sdk.encodeHmmLaunchTail(config.hmmLaunchConfig)]));
  assert.deepEqual(sdk.decodePoolBoundV4LifecycleMarketConfig(encoded).hmmLaunchConfig, config.hmmLaunchConfig);
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, hmmLaunchConfig: undefined }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, lpFeePips: 3000 }), { code: 'INVALID_HOOK_FEES' });
  for (const bytes of [prefix, `${encoded.slice(0, -2)}`, concatHex([encoded, zeroHash])]) assert.throws(() => sdk.decodePoolBoundV4LifecycleMarketConfig(bytes), { code: 'INVALID_HMM_CONFIG' });
  const market = { ...original.markets[0], adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, tokenBudget, configVersion: 6, config: encoded };
  const plan = { ...original, ...identity, token: { ...original.token, supply: tokenBudget }, markets: [market], buys: [] };
  const token = '0x0000000000000000000000000000000000000010';
  const known = deriveKnownPoolBoundHookDeployment({ plan, marketIndex: 0, token });
  const mined = await sdk.minePoolBoundHookSalt({ deployer: known.deployment.deployer, initCodeHash: known.deployment.initCodeHash });
  const finalized = { ...plan, markets: [{ ...market, config: sdk.encodePoolBoundV4LifecycleMarketConfig({ ...sdk.decodePoolBoundV4LifecycleMarketConfig(encoded), hookSalt: mined.salt }) }] };
  assert.deepEqual(sdk.decodePoolBoundV4LifecycleMarketConfig(finalized.markets[0].config).hmmLaunchConfig, config.hmmLaunchConfig);
  assert.equal(deriveKnownPoolBoundHookDeployment({ plan: finalized, marketIndex: 0, token }).deployment.initCodeHash, known.deployment.initCodeHash);
  for (const mode of ['atomic', 'staged']) {
    const txs = sdk.buildLaunchTransactions({ plan: finalized, mode });
    assert.equal(txs.length, mode === 'atomic' ? 1 : 3);
    for (const tx of txs) assert.equal(decodeFunctionData({ abi: sdk.launchLifecycleAbi, data: tx.data }).args[0].markets[0].config, finalized.markets[0].config);
  }
  const changed = { ...market, config: sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, hmmLaunchConfig: { ...config.hmmLaunchConfig, strategyShareBps: 2500 } }) };
  const context = { ...identity, core: identity.orchestrator, registrar: preset.boundHook.registrar, token };
  assert.equal(sdk.hashPoolBoundV4MarketCommitment({ ...context, market: changed }), sdk.hashPoolBoundV4MarketCommitment({ ...context, market }));
  assert.notEqual(sdk.hashLaunchPlan({ ...plan, markets: [changed] }), sdk.hashLaunchPlan(plan));
  await assert.rejects(sdk.planLaunch({ client: { request: async () => { throw new Error('must reject before RPC'); } }, account: plan.creator, plan: { ...plan, markets: [{ ...market, config: prefix }] }, mode: 'atomic' }), { code: 'INVALID_HMM_CONFIG' });
});
