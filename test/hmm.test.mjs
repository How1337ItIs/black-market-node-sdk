import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { concatHex, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeDeployData, encodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroHash } from 'viem';
const sdkPath = process.env.SDK_SOURCE_TEST === '1' ? '../src/lifecycle/index.ts' : '../dist/lifecycle/index.js';
const sdk = await import(sdkPath);
const { deriveKnownPoolBoundHookDeployment } = await import(sdkPath.replace('index.', 'calibration.'));
const vectors = JSON.parse(await readFile(new URL('./fixtures/hmm-launch-tail.json', import.meta.url), 'utf8'));
const admission = JSON.parse(await readFile(new URL('./fixtures/hmm-v2-admission.json', import.meta.url), 'utf8'));
const original = sdk.parseLaunchPlan(await readFile(new URL('./fixtures/launch-lifecycle-v1.json', import.meta.url), 'utf8').then((s) => JSON.stringify(JSON.parse(s).plan)));
const identity = { chainId: 4663n, orchestrator: '0x91560876033d568d25CDe98C78c33ff8FC43962c' };
const fields = ['bidWidth', 'askWidth', 'gap', 'staleAfterSeconds', 'staleDisplacement', 'minQuoteDeploy', 'minQuoteHarvest', 'minTokenHarvest', 'resalePremiumBps', 'maxAsks', 'maxAskTokenExposure', 'maxAcquiredInventory', 'premiumDecaySeconds', 'maxBidQuote', 'referenceDeviation'];
const amounts = new Set(['minQuoteDeploy', 'minQuoteHarvest', 'minTokenHarvest', 'maxAskTokenExposure', 'maxAcquiredInventory', 'maxBidQuote']);
for (const fixture of vectors.cases) test(`HMM tail matches cast abi-encode: ${fixture.name}`, () => {
  const config = { strategyShareBps: fixture.values[0], strategy: Object.fromEntries(fields.map((field, index) => [field, amounts.has(field) ? BigInt(fixture.values[1][index]) : fixture.values[1][index]])) };
  assert.equal(sdk.encodeHmmLaunchTail(config), fixture.encoded);
  assert.equal((fixture.encoded.length - 2) / 2, 512);
  assert.deepEqual(sdk.decodeHmmLaunchTail(fixture.encoded), config);
  assert.equal(sdk.hmmStrategyComponents.length, 15);
  assert.equal(encodeFunctionData({ abi: sdk.hmmLiquidityManagerV2Abi, functionName: 'setStrategyConfig', args: [config.strategy] }), fixture.setStrategyConfigCalldata);
  assert.deepEqual(decodeFunctionData({ abi: sdk.hmmLiquidityManagerV2Abi, data: fixture.setStrategyConfigCalldata }).args[0], config.strategy);
});
const guards = { maxBidQuote: 100000000000000000n, referenceDeviation: 0 };
const defaults = () => sdk.defaultHmmLaunchConfig({ tokenBudget: 1000000n * 10n ** 18n, quoteAsset: 'WETH', ...guards });
const invalidCases = [
  ['strategyShareBps', -1], ['strategyShareBps', 10001], ['strategyShareBps', 0.5],
  ['bidWidth', 0], ['bidWidth', 8388608], ['askWidth', -1], ['askWidth', 8388608], ['gap', -1], ['gap', 8388608],
  ['staleAfterSeconds', 0], ['staleAfterSeconds', 4294967296], ['staleDisplacement', 0], ['staleDisplacement', 8388608],
  ['minQuoteDeploy', -1n], ['minQuoteDeploy', 1n << 256n], ['minQuoteHarvest', 0n], ['minQuoteHarvest', 1n << 256n],
  ['minTokenHarvest', 0n], ['resalePremiumBps', 5001], ['maxAsks', 0], ['maxAsks', 9],
  ['maxAskTokenExposure', 3n], ['maxAskTokenExposure', 10n ** 18n], ['maxAskTokenExposure', 1n << 128n],
  ['maxAcquiredInventory', 1n], ['maxAcquiredInventory', 1n << 128n], ['premiumDecaySeconds', -1], ['premiumDecaySeconds', 4294967296],
  ['maxBidQuote', 0n], ['maxBidQuote', -1n], ['maxBidQuote', 1n << 128n], ['maxBidQuote', 1],
  ['referenceDeviation', -1], ['referenceDeviation', 8388608], ['referenceDeviation', 0.5], ['referenceDeviation', 0n],
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
  assert.equal(config.strategy.maxBidQuote, guards.maxBidQuote);
  assert.equal(config.strategy.referenceDeviation, 0);
  const stable = sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', quoteDecimals: 6, maxBidQuote: 100000000n, referenceDeviation: 2 });
  assert.equal(stable.strategy.minQuoteDeploy, 1000000n);
  assert.equal(stable.strategy.minQuoteHarvest, 10000000n);
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 99999n, quoteAsset: 'WETH', ...guards }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'ABYSS', ...guards }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'USDG', quoteDecimals: 18, ...guards }), { code: 'INVALID_HMM_CONFIG' });
  const custom = sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'UNKNOWN', minQuoteDeploy: 0n, minQuoteHarvest: 1n, ...guards });
  assert.equal(custom.strategy.minQuoteDeploy, 0n);
  assert.equal(stable.strategy.maxBidQuote, 100000000n);
  assert.equal(stable.strategy.referenceDeviation, 2);
  for (const missing of [{}, { maxBidQuote: 1n }, { referenceDeviation: 0 }]) assert.throws(() => sdk.defaultHmmLaunchConfig({ tokenBudget: 100000n, quoteAsset: 'WETH', ...missing }), { code: 'INVALID_HMM_CONFIG' });
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
    hmmLaunchConfig: sdk.defaultHmmLaunchConfig({ tokenBudget, quoteAsset: 'WETH', ...guards }) };
  const encoded = sdk.encodePoolBoundV4LifecycleMarketConfig(config);
  const prefix = encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [config]);
  assert.equal(encoded, concatHex([prefix, sdk.encodeHmmLaunchTail(config.hmmLaunchConfig)]));
  assert.deepEqual(sdk.decodePoolBoundV4LifecycleMarketConfig(encoded).hmmLaunchConfig, config.hmmLaunchConfig);
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, hmmLaunchConfig: undefined }), { code: 'INVALID_HMM_CONFIG' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, lpFeePips: 3000 }), { code: 'INVALID_HOOK_FEES' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, developerFeeBps: 1 }), { code: 'DEVELOPER_FEE_CEILING' });
  for (const bytes of [prefix, `${encoded.slice(0, -2)}`, concatHex([encoded, zeroHash]), concatHex([prefix, sdk.encodeHmmLaunchTail(config.hmmLaunchConfig).slice(0, 2 + 448 * 2)])]) assert.throws(() => sdk.decodePoolBoundV4LifecycleMarketConfig(bytes), { code: 'INVALID_HMM_CONFIG' });
  const market = { ...original.markets[0], adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, tokenBudget, configVersion: 6, config: encoded };
  const plan = { ...original, ...identity, token: { ...original.token, supply: tokenBudget }, markets: [market], buys: [] };
  const token = '0x0000000000000000000000000000000000000010';
  const known = deriveKnownPoolBoundHookDeployment({ plan, marketIndex: 0, token });
  const constructorAbi = admission.profiles.find((profile) => profile.profileId === preset.profile.id).constructor;
  const constructorBytes = encodeAbiParameters(constructorAbi.inputs, [known.parameters]);
  assert.equal((constructorBytes.length - 2) / 2, 640);
  assert.equal(sdk.encodePoolBoundHookParameters(known.parameters, 6), constructorBytes);
  assert.equal(known.deployment.initCodeHash, keccak256(encodeDeployData({ abi: [constructorAbi], bytecode: preset.boundHook.creationCode, args: [known.parameters] })));
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
  const changedGuards = { ...market, config: sdk.encodePoolBoundV4LifecycleMarketConfig({ ...config, hmmLaunchConfig: { ...config.hmmLaunchConfig, strategy: { ...config.hmmLaunchConfig.strategy, maxBidQuote: 1n, referenceDeviation: 5 } } }) };
  const context = { ...identity, core: identity.orchestrator, registrar: preset.boundHook.registrar, token };
  assert.equal(sdk.hashPoolBoundV4MarketCommitment({ ...context, market: changed }), sdk.hashPoolBoundV4MarketCommitment({ ...context, market }));
  assert.notEqual(sdk.hashLaunchPlan({ ...plan, markets: [changed] }), sdk.hashLaunchPlan(plan));
  assert.equal(deriveKnownPoolBoundHookDeployment({ plan: { ...plan, markets: [changedGuards] }, marketIndex: 0, token }).deployment.initCodeHash, known.deployment.initCodeHash);
  assert.notEqual(sdk.hashLaunchPlan({ ...plan, markets: [changedGuards] }), sdk.hashLaunchPlan(plan));
  await assert.rejects(sdk.planLaunch({ client: { request: async () => { throw new Error('must reject before RPC'); } }, account: plan.creator, plan: { ...plan, markets: [{ ...market, config: prefix }] }, mode: 'atomic' }), { code: 'INVALID_HMM_CONFIG' });
});

test('V2 tail decoding rejects old 448-byte payloads, extra words and noncanonical narrow integers', () => {
  const encoded = sdk.encodeHmmLaunchTail(defaults());
  for (const invalid of [encoded.slice(0, 2 + 448 * 2), encoded.slice(0, -2), concatHex([encoded, zeroHash])]) {
    assert.throws(() => sdk.decodeHmmLaunchTail(invalid), { code: 'INVALID_HMM_CONFIG' });
  }
  for (const [word, value] of [[0, 10001n], [14, 0n], [14, 1n << 128n], [15, (1n << 256n) - 1n]]) {
    const malformed = `${encoded.slice(0, 2 + word * 64)}${toHex(value, { size: 32 }).slice(2)}${encoded.slice(2 + (word + 1) * 64)}`;
    assert.throws(() => sdk.decodeHmmLaunchTail(malformed), { code: 'INVALID_HMM_CONFIG' });
  }
  // Nonzero padding above uint16 is not an alternative canonical share encoding.
  assert.throws(() => sdk.decodeHmmLaunchTail(`0x01${encoded.slice(4)}`));
  assert.deepEqual(sdk.decodeHmmLaunchTail(`0x${encoded.slice(2).toUpperCase()}`), defaults());
});

test('HMM selectors and typed tails cannot resurrect the unsupported legacy profiles', () => {
  const source = sdk.decodeV4LifecycleMarketConfig(original.markets[0].config);
  for (const profileId of [
    '0x7e51d9aa979940e7867c75a82e05e924aa067e9d436f7731c3e3299f9e55d53d',
    '0x109598e017b8f12648aff0f0dc04dbf8d4c0493f41a63068682d8f9d0a07a83d',
  ]) {
    assert.equal(sdk.isHmmProfile(profileId), false);
    assert.equal(sdk.getKnownLifecycleProfile({ ...identity, profileId }), undefined);
    assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...source, profileId, version: 6,
      minimumHookFeePips: 0, feeSensitivityPipsSecondsPerTick: 0, hookSalt: zeroHash, hmmLaunchConfig: defaults() }), { code: 'INVALID_HMM_CONFIG' });
  }
});

for (const snapshot of admission.profiles) test(`${snapshot.slug}: exact preserved admission, graph and two creation-code storage children`, () => {
  const preset = sdk.getKnownLifecycleProfile({ ...identity, profileId: snapshot.profileId });
  const envelope = preset.profile.envelope;
  assert.equal(sdk.encodeLaunchEnvelope(envelope), snapshot.envelopeBytes);
  assert.deepEqual(preset.profile.adapter, { ...snapshot.adapter, capabilities: BigInt(snapshot.adapter.capabilities) });
  const registration = encodeAbiParameters([{ type: 'tuple', components: sdk.profileRegistrationV1Components }], [preset.profile.registration]);
  assert.equal(registration, snapshot.registrationBytes);
  assert.equal(keccak256(concatHex([registration, snapshot.envelopeBytes])), snapshot.envelopeHash);
  const [constructor] = snapshot.constructor.inputs;
  assert.deepEqual(constructor.components.map(({ name, type }) => ({ name, type })), sdk.poolBoundHookParametersV2Components);
  const creation = preset.boundHook.creationCode.slice(2);
  assert.equal(keccak256(`0x00${creation.slice(0, 24575 * 2)}`), envelope.graph.codeChunk0Hash);
  assert.equal(keccak256(`0x00${creation.slice(24575 * 2)}`), envelope.graph.codeChunk1Hash);
  assert.equal(sdk.isHmmProfile(`0x${snapshot.profileId.slice(2).toUpperCase()}`), true);
});

test('manager config reads and owner controls preserve the complete V2 strategy', () => {
  const config = defaults();
  const encoded = encodeFunctionResult({ abi: sdk.hmmLiquidityManagerV2Abi, functionName: 'strategyConfig', result: config.strategy });
  assert.deepEqual(decodeFunctionResult({ abi: sdk.hmmLiquidityManagerV2Abi, functionName: 'strategyConfig', data: encoded }), config.strategy);
  for (const paused of [false, true]) {
    const data = encodeFunctionData({ abi: sdk.hmmLiquidityManagerV2Abi, functionName: 'setPlacementsPaused', args: [paused] });
    assert.deepEqual(decodeFunctionData({ abi: sdk.hmmLiquidityManagerV2Abi, data }), { functionName: 'setPlacementsPaused', args: [paused] });
  }
  for (const share of [0, 5000, 10000]) {
    const data = encodeFunctionData({ abi: sdk.hmmFeeCollectorV2Abi, functionName: 'setStrategyShareBps', args: [share] });
    assert.deepEqual(decodeFunctionData({ abi: sdk.hmmFeeCollectorV2Abi, data }), { functionName: 'setStrategyShareBps', args: [share] });
  }
});
