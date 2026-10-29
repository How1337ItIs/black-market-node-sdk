// Read-only Robinhood mainnet planning + reference-Python parity. No wallet, key or writes.
// BLACK_MARKET_REFERENCE_ROOT=/path/to/black-market node --test test/integration/auto-compound.live.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatHex, createPublicClient, encodeAbiParameters, http, keccak256 } from 'viem';
import * as sdk from '../../dist/lifecycle/index.js';
import { deriveKnownPoolBoundHookDeployment } from '../../dist/lifecycle/calibration.js';
import { keys, makeAutoCompoundPlan } from '../fixtures/auto-compound-plan.mjs';

const reference = process.env.BLACK_MARKET_REFERENCE_ROOT;
assert.ok(reference, 'Set BLACK_MARKET_REFERENCE_ROOT to the read-only protocol checkout');
const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com/') });
assert.equal(await client.getChainId(), 4663);
for (const key of keys) for (const feeMode of [0, 1]) test(`${key} / feeMode ${feeMode}: live factory agrees with SDK mining and Python bytes`, async () => {
  const block = await client.getBlock();
  const draft = makeAutoCompoundPlan(key, { feeMode });
  const token = await client.readContract({ address: draft.plan.orchestrator, abi: sdk.launchLifecycleAbi,
    functionName: 'predictToken', args: [draft.plan], blockNumber: block.number });
  const { plan, config, preset } = makeAutoCompoundPlan(key, { feeMode, token });
  const known = deriveKnownPoolBoundHookDeployment({ plan, marketIndex: 0, token });
  const mined = await sdk.minePoolBoundHookSalt({ deployer: known.deployment.deployer, initCodeHash: known.deployment.initCodeHash });
  const finalizedConfig = { ...config, hookSalt: mined.salt };
  const market = { ...plan.markets[0], config: sdk.encodePoolBoundV4LifecycleMarketConfig(finalizedConfig) };
  const address = preset.profile.envelope.graph.collectorFactory;
  const args = [preset.boundHook.registrar, token, market];
  const [metadata, decoded, parameters, adapterMetadata] = await Promise.all([
    client.readContract({ address, abi: sdk.poolFeeCollectorFactoryConfigV6Abi, functionName: 'poolBoundDeploymentMetadata', args, blockNumber: block.number }),
    client.readContract({ address, abi: sdk.poolFeeCollectorFactoryConfigV6Abi, functionName: 'decodeAndValidate', args, blockNumber: block.number }),
    client.readContract({ address, abi: sdk.poolFeeCollectorFactoryConfigV6Abi, functionName: 'poolBoundHookParameters', args, blockNumber: block.number }),
    client.readContract({ address: preset.boundHook.registrar, abi: sdk.poolMarketAdapterV1Abi, functionName: 'hookDeploymentMetadata', args: [token, market], blockNumber: block.number }),
  ]);
  assert.deepEqual(metadata, [known.deployment.deployer, known.deployment.initCodeHash, mined.salt, mined.predictedHook]);
  assert.deepEqual(adapterMetadata, metadata);
  assert.equal(sdk.hasLifecycleV4HookPermissions(metadata[3]), true);
  assert.equal(sdk.encodePoolBoundHookParameters(parameters[0], 6), sdk.encodePoolBoundHookParameters(known.parameters, 6));
  assert.equal(parameters[1], mined.salt);
  const { minimumHookFeePips, feeSensitivityPipsSecondsPerTick, hookSalt, autoCompoundConfig, ...shared } = finalizedConfig;
  assert.deepEqual(decoded, shared);
  const changedConfig = { ...finalizedConfig, autoCompoundConfig: { compoundShareBps: 10000 } };
  const changedMarket = { ...market, config: sdk.encodePoolBoundV4LifecycleMarketConfig(changedConfig) };
  const changed = await client.readContract({ address, abi: sdk.poolFeeCollectorFactoryConfigV6Abi, functionName: 'poolBoundDeploymentMetadata',
    args: [preset.boundHook.registrar, token, changedMarket], blockNumber: block.number });
  const changedKnown = deriveKnownPoolBoundHookDeployment({ plan: { ...plan, markets: [changedMarket] }, marketIndex: 0, token });
  assert.equal(changed[1], changedKnown.deployment.initCodeHash);
  assert.notEqual(changed[1], metadata[1], 'Changing the compound share invalidates the old constructor commitment');
  const prefix = encodeAbiParameters([{ type: 'tuple', components: sdk.poolBoundV4LifecycleMarketComponentsV6 }], [finalizedConfig]);
  for (const invalid of [prefix, concatHex([market.config, '0x00']), concatHex([prefix, encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint16' }], [sdk.AUTO_COMPOUND_CONFIG_VERSION, 10001])])]) {
    await assert.rejects(client.readContract({ address, abi: sdk.poolFeeCollectorFactoryConfigV6Abi, functionName: 'decodeAndValidate',
      args: [preset.boundHook.registrar, token, { ...market, config: invalid }], blockNumber: block.number }));
  }
  const directory = await mkdtemp(join(tmpdir(), 'black-market-auto-compound-'));
  try {
    const { autoCompoundConfig: compound, ...referenceMarket } = finalizedConfig;
    const path = join(directory, 'market.json');
    await writeFile(path, JSON.stringify(referenceMarket, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    const encoded = execFileSync('python3', ['scripts/auto_compound_config.py', path, '--compound-share-bps', String(compound.compoundShareBps)], { cwd: reference, encoding: 'utf8' }).trim();
    assert.equal(market.config, encoded);
    assert.equal(`0x${encoded.slice(-128)}`, sdk.encodeAutoCompoundTail(compound));
    console.log(JSON.stringify({ key, feeMode, blockNumber: block.number.toString(), blockHash: block.hash, predictedToken: token,
      hookSalt: mined.salt, predictedHook: mined.predictedHook, initCodeHash: known.deployment.initCodeHash,
      marketConfigHash: keccak256(market.config), referencePythonMatch: true }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
