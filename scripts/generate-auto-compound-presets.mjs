// Read-only capture: node --experimental-transform-types scripts/generate-auto-compound-presets.mjs --readback /path/to/black-market
// Offline regeneration: node --experimental-transform-types scripts/generate-auto-compound-presets.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { concatHex, createPublicClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi } from 'viem';
import { adapterRegistrationV1Components, encodeLaunchEnvelope, hashLaunchBounds, hashLaunchDependencies, hashLifecycleProfile, launchEnvelopeV2Components, profileRegistrationV1Components, profileTopologyV1Components } from '../src/lifecycle/schema.ts';
const poolMarketAdapterV1Abi = parseAbi([
  'function PROFILE_ID() view returns (bytes32)', 'function CONFIG_SCHEMA() view returns (bytes32)',
  'function CONFIG_VERSION() view returns (uint32)', 'function dependencyDigest() view returns (bytes32)',
  ...['core', 'implementationRegistry', 'poolManager', 'oracleFactory', 'locker', 'collectorFactory', 'hookDeployer'].map((name) => `function ${name}() view returns (address)`),
]);

const capture = process.argv.includes('--readback');
const root = process.argv.slice(2).find((arg) => arg !== '--readback');
if (capture && !root) throw new Error('Pass the read-only protocol checkout path');
const evidenceUrl = new URL('../test/fixtures/auto-compound-registry-readback.json', import.meta.url);
let blockNumber;
const registry = '0xB2B0f9F36617810D67b8fC175153Aa10024C1358';
const orchestrator = '0x91560876033d568d25CDe98C78c33ff8FC43962c';
const moduleCodeHash = '0x32cc7319b115951f5b0c2819ddd6d92e1f1501db3d42d35f3a1fb7ab1c4de291';
const specs = [
  { variant: 'static', directory: '20261028T233808Z-auto-compounding-static', profileId: '0xdd53c2c686f822b2d17536ccf4f9db954b4976d1be80404bc74571253179fae0', adapterId: '0x47f9efabc7c0427db5166ecf11702e0e0d2ca307a475d015d400a1584e572bc5', adapter: '0xae70e5acb118eade1ddf97a86a8ef681d5b71686', hookDeployer: '0x78811b0b1bb0f0f896e65c539c5bc62c4d33fbe2', locker: '0x0eb419d291abc5f643acb5b6035236df231e479d', collectorDeployer: '0x1b256029541ee5bef2db363211a7a05f9c36c18c', collectorFactory: '0x1d93705968dd03a27d86cb1590889882153ac0af', module: '0x84858337ae7b98d265be7d4d02712da6e9633827', creationCodeHash: '0x2c7bd199217fedf96a5b83d3ae3d630589eee86756c3a33bcc9a8d5e35efdc52', transactionHash: '0x4f5c6614a186c05645d94e1a660390e9536b3c1a5624fa1f0a97762e2e451601' },
  { variant: 'dynamic', directory: '20261028T234409Z-auto-compounding-dynamic', profileId: '0x46b81bfe9316fbaa90e930c6f1d5ad5e6ecfced2c886fd5520ca2bae11b92744', adapterId: '0x68a0b17d78c8c1a99762de862182940d795bbdc9617627ef6733e53378267201', adapter: '0x37b81fce117973f4e69bfbf58a20385cc24492e0', hookDeployer: '0x6911572b94e5da5a23073b49d857fe7a3f925b7c', locker: '0xd6869122933143f72cf30e3a0dfd8ac67246e139', collectorDeployer: '0x2010944ebeda7571b67cd30f2e596037fb18f8c7', collectorFactory: '0xb04735e49a5cfccfe8572afef0ad0f0addcdc698', module: '0x81ccf0ad6aebfcffb0fb8a5eaee70f398ba47022', creationCodeHash: '0x6b3cdd53a654f08b0c2d42d7906ec7f70b22b40f463b1508fab3a535e9b412c9', transactionHash: '0xa81bc8253ba48805ddecde8517f8d4291fbab0e007f0c2660fe43c6d156b6fb2' },
];
const retiredIds = ['0x1e41841a30f6cbac7cc41f57753bd9bd2eb155b9f4dfc869b19a75afcbf51d68', '0x53ddf479f6db40aebb02afe8c46031f69cb22e9712428621beb1652e0adae0d7'];
const components = { profileEnvelope: launchEnvelopeV2Components, adapter: adapterRegistrationV1Components, profile: profileRegistrationV1Components, profileTopology: profileTopologyV1Components };
const abi = Object.entries(components).map(([name, fields]) => ({ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: fields }] }));
const moduleAbi = parseAbi(['function compoundModule() view returns (address)', 'function compoundModuleCodeHash() view returns (bytes32)', 'function collectorDeployer() view returns (address)']);
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const equalHex = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());
const decode = (raw) => Object.fromEntries(Object.entries(components).map(([name, fields]) => [name, decodeAbiParameters([{ type: 'tuple', components: fields }], raw[name])[0]]));
let evidence;
if (capture) {
  const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com/') });
  const block = await client.getBlock();
  blockNumber = block.number;
  const profiles = [];
  for (const spec of specs) {
    const raw = Object.fromEntries(await Promise.all(Object.keys(components).map(async (name) => {
      const { data } = await client.call({ to: registry, data: encodeFunctionData({ abi, functionName: name, args: [name === 'adapter' ? spec.adapterId : spec.profileId] }), blockNumber });
      return [name, data];
    })));
    const { profileEnvelope: envelope } = decode(raw);
    const chunks = await Promise.all([envelope.graph.codeChunk0, envelope.graph.codeChunk1].map(async (address) => ({ address, runtime: await client.getCode({ address, blockNumber }) })));
    const adapterMetadata = Object.fromEntries(await Promise.all(['PROFILE_ID', 'CONFIG_SCHEMA', 'CONFIG_VERSION', 'core', 'implementationRegistry', 'poolManager', 'oracleFactory', 'locker', 'collectorFactory', 'hookDeployer', 'dependencyDigest'].map(async (name) => [name, await client.readContract({ address: spec.adapter, abi: poolMarketAdapterV1Abi, functionName: name, blockNumber })])));
    const moduleMetadata = Object.fromEntries(await Promise.all(['compoundModule', 'compoundModuleCodeHash', 'collectorDeployer'].map(async (name) => [name, await client.readContract({ address: spec.collectorFactory, abi: moduleAbi, functionName: name, blockNumber })])));
    const codeHashes = Object.fromEntries(await Promise.all(Object.entries({ adapter: spec.adapter, module: spec.module, core: orchestrator, manager: envelope.graph.manager, oracleFactory: envelope.graph.oracleFactory, locker: spec.locker, collectorFactory: spec.collectorFactory, collectorDeployer: spec.collectorDeployer, hookDeployer: spec.hookDeployer }).map(async ([name, address]) => [name, keccak256(await client.getCode({ address, blockNumber }))])));
    const path = `contracts/deployments/launch/auto-compounding/${spec.directory}`;
    const admission = JSON.parse(await readFile(resolve(root, path, 'admission.json'), 'utf8'));
    const result = JSON.parse(await readFile(resolve(root, path, 'admission-result.json'), 'utf8'));
    const { receipt: preservedReceipt } = JSON.parse(await readFile(resolve(root, path, `chain/admission-${spec.transactionHash}.json`), 'utf8'));
    const receipt = await client.getTransactionReceipt({ hash: spec.transactionHash });
    assert.equal(receipt.status, 'success');
    equalHex(receipt.blockHash, preservedReceipt.blockHash);
    assert.equal(receipt.blockNumber, BigInt(preservedReceipt.blockNumber));
    equalHex(result.admissionBytes, admission.admissionBytes);
    profiles.push({ variant: spec.variant, profileId: spec.profileId, adapterId: spec.adapterId, raw, chunks, adapterMetadata, moduleMetadata, codeHashes, admission: { path, envelopeBytes: admission.envelopeBytes, registrationBytes: admission.registrationBytes, envelopeHash: admission.envelopeHash, admissionBytes: result.admissionBytes, nonce: admission.nonce, deadline: admission.deadline, authorizationDigest: admission.authorizationDigest, payloadHash: result.payloadHash, transactionHash: spec.transactionHash, blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash } });
  }
  const retired = [];
  for (const profileId of retiredIds) retired.push({ profileId, registration: await client.readContract({ address: registry, abi, functionName: 'profile', args: [profileId], blockNumber }) });
  evidence = { chainId: await client.getChainId(), orchestrator, registry, sourceCommit: 'ccc7d69', blockNumber: Number(blockNumber), blockHash: block.hash, profiles, retired };
} else evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
blockNumber = BigInt(evidence.blockNumber);

assert.equal(evidence.chainId, 4663);
assert.ok(blockNumber > 0n && Number.isSafeInteger(evidence.blockNumber));
equalHex(evidence.registry, registry);
equalHex(evidence.orchestrator, orchestrator);
assert.equal(evidence.profiles.length, specs.length);
assert.deepEqual(evidence.retired.map(({ profileId }) => profileId), retiredIds);
for (const retired of evidence.retired) assert.equal(retired.registration.enabled, false);
const literal = (value, indent = 0) => {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `Object.freeze({\n${Object.entries(value).map(([key, item]) => `${' '.repeat(indent + 2)}${key}: ${literal(item, indent + 2)},`).join('\n')}\n${' '.repeat(indent)}})`;
};
const outputs = [];
for (const spec of specs) {
  const observed = evidence.profiles.find(({ variant }) => variant === spec.variant);
  const { profileEnvelope: envelope, adapter, profile: registration, profileTopology: topology } = decode(observed.raw);
  equalHex(observed.profileId, spec.profileId);
  equalHex(hashLifecycleProfile(envelope), spec.profileId);
  equalHex(observed.adapterId, spec.adapterId);
  equalHex(registration.adapterId, spec.adapterId);
  equalHex(adapter.implementation, spec.adapter);
  assert.equal(registration.enabled, true);
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.configVersion, 6);
  assert.equal(topology.configVersion, 6);
  assert.equal(envelope.configVersion, 6);
  assert.equal(topology.hookTopology, 2);
  assert.equal(envelope.maximumDeveloperFeeBps, 0);
  assert.equal(envelope.bounds.feeModeFlags, 3);
  equalHex(hashLaunchBounds(envelope.bounds), envelope.configBoundsDigest);
  equalHex(hashLaunchDependencies({ chainId: 4663n, core: orchestrator, registry, registrar: spec.adapter, graph: envelope.graph }), registration.dependencyDigest);
  for (const name of ['hookDeployer', 'locker', 'collectorFactory', 'collectorDeployer']) equalHex(envelope.graph[name], spec[name]);
  equalHex(topology.hookDeployer, spec.hookDeployer);
  equalHex(topology.hookCreationCodeHash, spec.creationCodeHash);
  equalHex(envelope.graph.hookCreationCodeHash, spec.creationCodeHash);
  const creationCode = concatHex(observed.chunks.map(({ runtime }, index) => {
    assert.equal(runtime.slice(0, 4), '0x00');
    equalHex(keccak256(runtime), envelope.graph[`codeChunk${index}Hash`]);
    equalHex(observed.chunks[index].address, envelope.graph[`codeChunk${index}`]);
    return `0x${runtime.slice(4)}`;
  }));
  equalHex(keccak256(creationCode), spec.creationCodeHash);
  equalHex(adapter.codeHash, observed.codeHashes.adapter);
  equalHex(observed.codeHashes.module, moduleCodeHash);
  for (const name of ['core', 'manager', 'oracleFactory', 'locker', 'collectorFactory', 'collectorDeployer', 'hookDeployer']) equalHex(observed.codeHashes[name], envelope.graph[`${name}CodeHash`]);
  const metadata = observed.adapterMetadata;
  for (const [name, expected] of Object.entries({ PROFILE_ID: spec.profileId, CONFIG_SCHEMA: registration.configSchema, core: orchestrator, implementationRegistry: registry, poolManager: envelope.graph.manager, oracleFactory: envelope.graph.oracleFactory, locker: spec.locker, collectorFactory: spec.collectorFactory, hookDeployer: spec.hookDeployer, dependencyDigest: registration.dependencyDigest })) equalHex(metadata[name], expected);
  assert.equal(metadata.CONFIG_VERSION, 6);
  equalHex(observed.moduleMetadata.compoundModule, spec.module);
  equalHex(observed.moduleMetadata.compoundModuleCodeHash, moduleCodeHash);
  equalHex(observed.moduleMetadata.collectorDeployer, spec.collectorDeployer);
  for (const [name, fields] of Object.entries(components)) equalHex(encodeAbiParameters([{ type: 'tuple', components: fields }], [decode(observed.raw)[name]]), observed.raw[name]);
  equalHex(encodeLaunchEnvelope(envelope), observed.admission.envelopeBytes);
  equalHex(observed.raw.profile, observed.admission.registrationBytes);
  equalHex(keccak256(concatHex([observed.raw.profile, observed.admission.envelopeBytes])), observed.admission.envelopeHash);
  equalHex(observed.admission.admissionBytes, concatHex([
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [registry, spec.profileId]),
    observed.raw.profile, observed.admission.envelopeBytes,
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [BigInt(observed.admission.nonce), BigInt(observed.admission.deadline), observed.admission.authorizationDigest]),
  ]));
  equalHex(keccak256(observed.admission.admissionBytes), observed.admission.payloadHash);
  const prefix = `autoCompound${spec.variant[0].toUpperCase()}${spec.variant.slice(1)}`;
  outputs.push([new URL(`../src/lifecycle/deployments/auto-compound-${spec.variant}-pool-v1-20261028.ts`, import.meta.url), `import type { Hex } from "viem";\nimport type { LaunchEnvelopeV2, AdapterRegistrationV1, ProfileRegistrationV1, ProfileTopologyV1 } from "../schema.js";\n\n// Generated by scripts/generate-auto-compound-presets.mjs from admission and registry readback.\n// Robinhood block ${blockNumber}, ${evidence.blockHash}; admission ${spec.transactionHash}.\nexport const ${prefix}Envelope = ${literal(envelope)} satisfies LaunchEnvelopeV2;\nexport const ${prefix}Adapter = ${literal(adapter)} satisfies AdapterRegistrationV1;\nexport const ${prefix}Registration = ${literal(registration)} satisfies ProfileRegistrationV1;\nexport const ${prefix}Topology = ${literal(topology)} satisfies ProfileTopologyV1;\n// ${(creationCode.length - 2) / 2} bytes; keccak256 ${spec.creationCodeHash}.\nexport const ${prefix}CreationCode: Hex = "${creationCode}";\n`]);
}
if (capture) await writeFile(evidenceUrl, json(evidence));
for (const [url, content] of outputs) await writeFile(url, content);
console.log(`Generated auto-compounding static/dynamic presets from pinned Robinhood block ${blockNumber} (${evidence.blockHash})`);
