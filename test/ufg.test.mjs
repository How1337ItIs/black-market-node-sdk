import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
const sdk = await import('../dist/lifecycle/index.js');
const vectors = JSON.parse(await readFile(new URL('./fixtures/ufg-launch-config.json', import.meta.url), 'utf8'));
const evidence = JSON.parse(await readFile(new URL('./fixtures/ufg-registry-readback.json', import.meta.url), 'utf8'));
const address = (n) => toHex(BigInt(n), { size: 20 });
const principal = address(160), token = address(16), quote = address(32);
const identity = { chainId: 4663n, orchestrator: sdk.UFG_ORCHESTRATOR_ADDRESS };
const config = () => ({ treasuryShareBps: 10000, exitFeeBps: 100, reserveAssets: [quote] });
const select = (key) => sdk.getKnownLifecycleProfile({ ...identity, key });
function makePlan(v4 = false, dynamic = false) {
  const preset = select(v4 ? dynamic ? sdk.KnownLifecycleProfile.V4UfgDynamicPool : sdk.KnownLifecycleProfile.V4UfgFixedPool : sdk.KnownLifecycleProfile.Abyss2);
  const inner = v4 ? { ...vectors.cases[0].market, sqrtPriceX96: 1n << 96n, profileId: preset.profile.id,
    termsDigest: preset.profile.envelope.termsDigest, developerBeneficiary: preset.profile.envelope.beneficiary,
    treasury: preset.profile.envelope.protocolTreasury, positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1234n, salt: zeroHash, maxTokenAmount: 1000000n }], ufgLaunchConfig: config() }
    : { profile: 2, fee: 3000, oracleConfigId: zeroHash, openingSqrtPriceX96: 1n << 96n, positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1234n, tokenAmountMaximum: 1000000n }] };
  return { ...identity, creator: sdk.UFG_LAUNCH_PROXY_ADDRESS, nonce: sdk.ufgLaunchNonce(principal, 7n),
    token: { kind: 0, rewardMode: 0, name: 'Treasury', symbol: 'UFG', supply: 1000000n, nftUnit: 0n, metadataURI: '', salt: zeroHash, inventoryRecipient: principal, burnOnCancel: true },
    funding: [], feeAssets: sdk.buildUfgFeeAssetPolicies(token, [quote]),
    markets: [{ adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, quoteAsset: quote, tokenBudget: 1000000n, configVersion: v4 ? 6 : 1, config: v4 ? sdk.encodePoolBoundV4LifecycleMarketConfig(inner) : sdk.encodeAbyssLifecycleMarketConfig(inner) }],
    buys: [], deadline: 2000000000n, executorFeeBps: 0 };
}
function mutateV4(plan, mutate) {
  const inner = sdk.decodePoolBoundV4LifecycleMarketConfig(plan.markets[0].config, 6);
  mutate(inner);
  // Deliberately bypass the safe encoder to construct rejected boundary bytes.
  plan.markets[0].config = concatHex([encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [inner]), sdk.encodeUfgLaunchConfig(inner.ufgLaunchConfig)]);
}
for (const vector of vectors.cases) test(`UFG config and V6 tail equal cast abi-encode: ${vector.name}`, () => {
  const market = { ...vector.market, sqrtPriceX96: BigInt(vector.market.sqrtPriceX96), positions: vector.market.positions.map((p) => ({ ...p, liquidity: BigInt(p.liquidity), maxTokenAmount: BigInt(p.maxTokenAmount) })), ufgLaunchConfig: vector.config };
  assert.equal(sdk.encodeUfgLaunchConfig(vector.config), vector.encoded);
  assert.equal(sdk.hashUfgLaunchConfig(vector.config), vector.configHash);
  assert.deepEqual(sdk.decodeUfgLaunchConfig(vector.encoded), vector.config);
  assert.equal(sdk.encodePoolBoundV4LifecycleMarketConfig(market), vector.marketEncoded);
  assert.deepEqual(sdk.decodePoolBoundV4LifecycleMarketConfig(vector.marketEncoded, 6), market);
  assert.equal((vector.encoded.length - 2) / 2, (5 + vector.config.reserveAssets.length) * 32);
  const normal = { ...market, profileId: select(sdk.KnownLifecycleProfile.V4FixedFeePool).profile.id };
  delete normal.ufgLaunchConfig;
  assert.equal(sdk.encodePoolBoundV4LifecycleMarketConfig(normal), encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [normal]));
});
test('UFG canonical decoding rejects trailing bytes, alternate offsets and dirty uint16 padding', () => {
  const encoded = sdk.encodeUfgLaunchConfig(config());
  for (const invalid of [concatHex([encoded, zeroHash]), encoded.slice(0, -2), `0x${toHex(64n, { size: 32 }).slice(2)}${zeroHash.slice(2)}${encoded.slice(66)}`, `${encoded.slice(0, 66)}01${encoded.slice(68)}`]) assert.throws(() => sdk.decodeUfgLaunchConfig(invalid));
  const market = makePlan(true).markets[0];
  const inner = sdk.decodePoolBoundV4LifecycleMarketConfig(market.config);
  const prefix = encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [inner]);
  for (const invalid of [prefix, market.config.slice(0, -2), concatHex([market.config, zeroHash])]) assert.throws(() => sdk.decodePoolBoundV4LifecycleMarketConfig(invalid, 6));
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...inner, ufgLaunchConfig: undefined }), { code: 'INVALID_UFG_CONFIG' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...inner, profileId: zeroHash }), { code: 'INVALID_UFG_CONFIG' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...inner, feeMode: 0 }), { code: 'INVALID_UFG_CONFIG' });
  assert.throws(() => sdk.encodePoolBoundV4LifecycleMarketConfig({ ...inner, lpFeePips: 1 }), { code: 'INVALID_UFG_CONFIG' });
  assert.equal(sdk.isUfgProfile(sdk.UFG_DYNAMIC_PROFILE_ID.toUpperCase().replace('0X', '0x')), true);
  assert.equal(sdk.isUfgProfile(zeroHash), false);
});
test('UFG principal nonce matches the Solidity namespace and enforces uint96', () => {
  assert.equal(sdk.ufgLaunchNonce(principal, (1n << 96n) - 1n), BigInt(principal) << 96n | (1n << 96n) - 1n);
  for (const nonce of [-1n, 1n << 96n]) assert.throws(() => sdk.ufgLaunchNonce(principal, nonce), { code: 'INVALID_UFG_NONCE' });
  assert.throws(() => sdk.ufgLaunchNonce(zeroAddress, 0n), { code: 'INVALID_UFG_NONCE' });
});
for (const [name, v4, mutate] of [
  ['ERC20 only', false, (p) => { p.token.kind = 1; }],
  ['no token rewards', false, (p) => { p.token.rewardMode = 1; }],
  ['proxy creator', false, (p) => { p.creator = principal; }],
  ['zero executor fee', false, (p) => { p.executorFeeBps = 1; }],
  ['pinned core', false, (p) => { p.orchestrator = principal; }],
  ['matching chain', false, (p) => { p.chainId = 1n; }],
  ['namespaced nonce', false, (p) => { p.nonce = 7n; }],
  ['uint256 nonce', false, (p) => { p.nonce = 1n << 256n; }],
  ['at least one market', false, (p) => { p.markets = []; }],
  ['external inventory recipient', false, (p) => { p.token.inventoryRecipient = sdk.UFG_LAUNCH_PROXY_ADDRESS; }],
  ['external buy recipient', false, (p) => { p.buys = [{ recipient: sdk.UFG_LAUNCH_PROXY_ADDRESS }]; }],
  ['full treasury share', false, (_p, c) => { c.treasuryShareBps = 9999; }],
  ['exit fee maximum', false, (_p, c) => { c.exitFeeBps = 2001; }],
  ['nonnegative exit fee', false, (_p, c) => { c.exitFeeBps = -1; }],
  ['integer exit fee', false, (_p, c) => { c.exitFeeBps = 0.5; }],
  ['at least one reserve', false, (_p, c) => { c.reserveAssets = []; }],
  ['at most seven reserves', false, (_p, c) => { c.reserveAssets = Array.from({ length: 8 }, (_, i) => address(32 + i)); }],
  ['ascending reserves', false, (_p, c) => { c.reserveAssets = [address(33), quote]; }],
  ['unique reserves', false, (_p, c) => { c.reserveAssets = [quote, quote]; }],
  ['nonzero reserves', false, (_p, c) => { c.reserveAssets = [zeroAddress]; }],
  ['reserve excludes token', false, (_p, c) => { c.reserveAssets = [token]; }],
  ['every reserve quoted', false, (p, c) => { c.reserveAssets.push(address(33)); p.feeAssets = sdk.buildUfgFeeAssetPolicies(token, c.reserveAssets); }],
  ['every quote reserved', false, (p) => { p.markets.push({ ...p.markets[0], quoteAsset: address(33) }); }],
  ['fee asset count', false, (p) => { p.feeAssets.pop(); }],
  ['ascending fee assets', false, (p) => { p.feeAssets.reverse(); }],
  ['no rewards share', false, (p) => { p.feeAssets[0].rewardsBps = 1; }],
  ['token owner zero', false, (p) => { p.feeAssets[0].ownerBps = 1; }],
  ['token all burn', false, (p) => { p.feeAssets[0].burnBps = 9999; }],
  ['reserve all owner', false, (p) => { p.feeAssets[1].ownerBps = 9999; }],
  ['reserve no burn', false, (p) => { p.feeAssets[1].burnBps = 1; }],
  ['fee asset membership', false, (p) => { p.feeAssets[1].asset = address(33); }],
  ['Abyss canonical adapter', false, (p) => { p.markets[0].adapterId = zeroHash; }],
  ['Abyss quote profile', false, (p) => { const c = sdk.decodeAbyssLifecycleMarketConfig(p.markets[0].config); c.profile = 0; p.markets[0].config = sdk.encodeAbyssLifecycleMarketConfig(c); }],
  ['Abyss profile ID', false, (p) => { p.markets[0].profileId = select(sdk.KnownLifecycleProfile.Abyss3).profile.id; }],
  ['Abyss canonical bytes no tail', false, (p, c) => { p.markets[0].config = concatHex([p.markets[0].config, sdk.encodeUfgLaunchConfig(c)]); }],
  ['no other config version', false, (p) => { p.markets[0].configVersion = 4; }],
  ['only UFG V4 profiles', true, (p) => { p.markets[0].profileId = zeroHash; }],
  ['matching UFG adapter', true, (p) => { p.markets[0].adapterId = sdk.UFG_DYNAMIC_ADAPTER_ID; }],
  ['matching inner profile', true, (p) => { mutateV4(p, (c) => { c.profileId = sdk.UFG_DYNAMIC_PROFILE_ID; }); }],
  ['QuoteOnly V4', true, (p) => { mutateV4(p, (c) => { c.feeMode = 0; }); }],
  ['zero V4 LP fee', true, (p) => { mutateV4(p, (c) => { c.lpFeePips = 1; }); }],
  ['identical proxy and V4 tail', true, (p) => { mutateV4(p, (c) => { c.ufgLaunchConfig.exitFeeBps = 101; }); }],
  ['mandatory V4 tail', true, (p) => { const c = sdk.decodePoolBoundV4LifecycleMarketConfig(p.markets[0].config); p.markets[0].config = encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [c]); }],
  ['canonical V4 tail', true, (p) => { p.markets[0].config = concatHex([p.markets[0].config, zeroHash]); }],
]) test(`offline UFG validator rejects ${name}`, () => {
  const plan = makePlan(v4), launch = config();
  mutate(plan, launch);
  assert.throws(() => sdk.validateUfgLaunchPlan(plan, launch, token), { code: 'INVALID_UFG_PLAN' });
});
test('offline UFG validator accepts native QUOTE/QUOTE_ORACLE, fixed/dynamic V4 and mixed same-quote markets', () => {
  for (const plan of [makePlan(), makePlan(true), makePlan(true, true)]) assert.doesNotThrow(() => sdk.validateUfgLaunchPlan(plan, config(), token));
  const plan = makePlan();
  plan.markets.push(makePlan(true).markets[0]);
  assert.doesNotThrow(() => sdk.validateUfgLaunchPlan(plan, config(), token));
  const c = sdk.decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
  c.profile = 3;
  plan.markets[0].profileId = select(sdk.KnownLifecycleProfile.Abyss3).profile.id;
  plan.markets[0].config = sdk.encodeAbyssLifecycleMarketConfig(c);
  assert.doesNotThrow(() => sdk.validateUfgLaunchPlan(plan, config(), token));
});
for (const [index, key] of [sdk.KnownLifecycleProfile.V4UfgFixedPool, sdk.KnownLifecycleProfile.V4UfgDynamicPool].entries()) test(`${key} matches pinned block 94551140 registry evidence`, () => {
  const observed = evidence.profiles[index], preset = select(key), profile = preset.profile;
  assert.equal(evidence.blockNumber, 94551140);
  for (const [name, value, fields] of [
    ['profileEnvelope', profile.envelope, sdk.launchEnvelopeV2Components], ['adapter', profile.adapter, sdk.adapterRegistrationV1Components],
    ['profile', profile.registration, sdk.profileRegistrationV1Components], ['profileTopology', profile.topology, sdk.profileTopologyV1Components],
  ]) assert.equal(encodeAbiParameters([{ type: 'tuple', components: fields }], [value]), observed.raw[name]);
  assert.equal(profile.id, observed.profileId);
  assert.equal(sdk.hashLifecycleProfile(profile.envelope), profile.id);
  assert.equal(preset.boundHook.creationCode, observed.creationCode);
  for (const [i, chunk] of observed.chunks.entries()) assert.equal(keccak256(chunk.runtime), profile.envelope.graph[`codeChunk${i}Hash`]);
  assert.equal(keccak256(preset.boundHook.creationCode), profile.topology.hookCreationCodeHash);
  assert.equal(sdk.hashLaunchDependencies({ ...identity, core: identity.orchestrator, registry: evidence.registry, registrar: preset.boundHook.registrar, graph: profile.envelope.graph }), profile.registration.dependencyDigest);
  for (const item of [preset, profile, profile.envelope, profile.envelope.graph, profile.registration, profile.adapter, profile.topology, preset.boundHook]) assert.equal(Object.isFrozen(item), true);
});
test('UFG unsigned proxy commands preserve mode, batches, value, dependencies and namespace sender', () => {
  const plan = makePlan(true);
  plan.funding = [{ asset: quote, amount: 9n, kind: 1, inputAsset: quote, inputAmount: 9n, target: zeroAddress, data: '0x' }, { asset: address(33), amount: 3n, kind: 2, inputAsset: zeroAddress, inputAmount: 4n, target: principal, data: '0xab' }];
  for (const mode of ['atomic', 'staged']) {
    const txs = sdk.buildUfgLaunchTransactions({ plan, config: config(), mode });
    assert.equal(txs[0].value, 13n);
    assert.equal(txs.length, mode === 'atomic' ? 1 : 3);
    for (const [index, tx] of txs.entries()) {
      assert.equal(tx.from.toLowerCase(), principal.toLowerCase());
      assert.equal(tx.to, sdk.UFG_LAUNCH_PROXY_ADDRESS);
      assert.deepEqual(tx.dependencies, index === 0 ? [] : [txs[index - 1].id]);
      const call = decodeFunctionData({ abi: sdk.ufgLaunchProxyV1Abi, data: tx.data });
      assert.equal(sdk.hashLaunchPlan(call.args[0]), sdk.hashLaunchPlan(plan));
      if (tx.kind === 'begin' || tx.kind === 'atomic') assert.deepEqual(call.args[tx.kind === 'atomic' ? 1 : 2], config());
      else assert.equal(tx.value, 0n);
    }
  }
  const cancel = sdk.buildUfgCancelTransaction({ plan, preparedMarkets: 1 });
  assert.equal(decodeFunctionData({ abi: sdk.ufgLaunchProxyV1Abi, data: cancel.data }).functionName, 'cancelLaunch');
  assert.equal(cancel.from.toLowerCase(), principal.toLowerCase());
  assert.equal(cancel.to, sdk.UFG_LAUNCH_PROXY_ADDRESS);
  assert.equal(cancel.value, 0n);
  assert.throws(() => sdk.buildUfgLaunchTransactions({ plan, config: config(), mode: 'atomic', preparationBatches: [1] }), { code: 'INVALID_PREPARATION_BATCHES' });
});
test('UFG approval builder sums ERC20 and swap pulls, skips native inputs, and targets proxy', () => {
  const plan = makePlan();
  plan.funding = [
    { asset: quote, amount: 7n, kind: 0, inputAsset: quote, inputAmount: 7n, target: zeroAddress, data: '0x' },
    { asset: address(33), amount: 8n, kind: 2, inputAsset: quote, inputAmount: 9n, target: principal, data: '0xab' },
    { asset: address(34), amount: 1n, kind: 1, inputAsset: address(34), inputAmount: 1n, target: zeroAddress, data: '0x' },
    { asset: address(35), amount: 1n, kind: 2, inputAsset: zeroAddress, inputAmount: 1n, target: principal, data: '0xab' },
  ];
  const approvals = sdk.buildUfgApprovals(plan);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].to, quote);
  assert.equal(approvals[0].from.toLowerCase(), principal.toLowerCase());
  assert.deepEqual(decodeFunctionData({ abi: sdk.lifecycleErc20Abi, data: approvals[0].data }).args, [sdk.UFG_LAUNCH_PROXY_ADDRESS, 16n]);
});
test('treasury read returns absence or the actual upstream treasury', async () => {
  for (const treasury of [zeroAddress, address(42)]) {
    const client = { request: async ({ method, params }) => {
      assert.equal(method, 'eth_call');
      assert.equal(params[0].to, sdk.UFG_TREASURY_FACTORY_ADDRESS);
      assert.deepEqual(decodeFunctionData({ abi: sdk.ufgTreasuryFactoryV1Abi, data: params[0].data }).args, [token]);
      return encodeFunctionResult({ abi: sdk.ufgTreasuryFactoryV1Abi, functionName: 'treasuryOf', result: treasury });
    } };
    assert.equal((await sdk.readUfgTreasury(client, token))?.toLowerCase(), treasury === zeroAddress ? undefined : treasury.toLowerCase());
  }
});
