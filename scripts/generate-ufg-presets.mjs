// Read-only capture: node --experimental-transform-types scripts/generate-ufg-presets.mjs --readback /path/to/black-market
// Offline regeneration: node --experimental-transform-types scripts/generate-ufg-presets.mjs /path/to/black-market
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, concatHex } from 'viem';
import { launchEnvelopeV2Components, adapterRegistrationV1Components, profileRegistrationV1Components, profileTopologyV1Components, hashLifecycleProfile } from '../src/lifecycle/schema.ts';
import { fixedFeePoolHookV1CreationCode } from '../src/lifecycle/deployments/fixed-fee-pool-hook-v1-20261008.ts';
import { dynamicFeePoolHookV1CreationCode } from '../src/lifecycle/deployments/dynamic-fee-pool-hook-v1-20261011.ts';
const capture = process.argv.includes('--readback');
const root = process.argv.slice(2).find((arg) => arg !== '--readback');
if (!root) throw new Error('Pass the read-only protocol checkout path');
const evidenceUrl = new URL('../test/fixtures/ufg-registry-readback.json', import.meta.url);
const blockNumber = 94551140n;
const registry = '0xB2B0f9F36617810D67b8fC175153Aa10024C1358';
const orchestrator = '0x91560876033d568d25CDe98C78c33ff8FC43962c';
const ids = [
  ['fixed', '0x5c6045af480814e469f3dba7c120d264047c9320b869c63a064536041a2dbae6', '0x073a4d46af70a3d4f69641e4f9dcdc9d8c279cd443daff960bbdf65a3b5fc758'],
  ['dynamic', '0x03de8d5e38f2957d80ecb9f2e59d555601ff091dfb17bce84178956a2e8d9b41', '0xc0906e17625b48240a87a3afc6ee921b653bdacd72906a16b359d0776d938518'],
];
const components = { profileEnvelope: launchEnvelopeV2Components, adapter: adapterRegistrationV1Components, profile: profileRegistrationV1Components, profileTopology: profileTopologyV1Components };
const abi = Object.entries(components).map(([name, fields]) => ({ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: fields }] }));
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
let evidence;
if (capture) {
  const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com/') });
  const block = await client.getBlock({ blockNumber });
  const profiles = [];
  for (const [variant, profileId, adapterId] of ids) {
    const raw = {}, decoded = {};
    for (const [name, fields] of Object.entries(components)) {
      const { data } = await client.call({ to: registry, data: encodeFunctionData({ abi, functionName: name, args: [name === 'adapter' ? adapterId : profileId] }), blockNumber });
      raw[name] = data;
      decoded[name] = decodeAbiParameters([{ type: 'tuple', components: fields }], data)[0];
    }
    const envelope = decoded.profileEnvelope;
    const chunks = await Promise.all([envelope.graph.codeChunk0, envelope.graph.codeChunk1].map(async (address) => ({ address, runtime: await client.getCode({ address, blockNumber }) })));
    const creationCode = concatHex(chunks.map(({ runtime }) => `0x${runtime.slice(4)}`));
    profiles.push({ variant, profileId, adapterId, raw, decoded, chunks, creationCode });
  }
  evidence = { chainId: await client.getChainId(), orchestrator, registry, blockNumber: Number(blockNumber), blockHash: block.hash, profiles };
  await writeFile(evidenceUrl, json(evidence));
} else evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
if (evidence.chainId !== 4663 || evidence.blockNumber !== Number(blockNumber) || evidence.registry !== registry) throw new Error('Unexpected readback domain');
const literal = (value, indent = 0) => {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `Object.freeze({\n${Object.entries(value).map(([key, item]) => `${' '.repeat(indent + 2)}${key}: ${literal(item, indent + 2)},`).join('\n')}\n${' '.repeat(indent)}})`;
};
for (const [variant, profileId, adapterId] of ids) {
  const observed = evidence.profiles.find((profile) => profile.variant === variant);
  const decoded = Object.fromEntries(Object.entries(components).map(([name, fields]) => [name, decodeAbiParameters([{ type: 'tuple', components: fields }], observed.raw[name])[0]]));
  const { profileEnvelope: envelope, adapter, profile: registration, profileTopology: topology } = decoded;
  const creationCode = variant === 'fixed' ? fixedFeePoolHookV1CreationCode : dynamicFeePoolHookV1CreationCode;
  if (hashLifecycleProfile(envelope) !== profileId || registration.adapterId !== adapterId || !registration.enabled || !adapter.enabled || envelope.graph.hookDeployer !== topology.hookDeployer || envelope.graph.hookCreationCodeHash !== topology.hookCreationCodeHash || keccak256(creationCode) !== topology.hookCreationCodeHash || creationCode !== observed.creationCode) throw new Error(`${variant} commitments differ`);
  for (const [name, fields] of Object.entries(components)) if (encodeAbiParameters([{ type: 'tuple', components: fields }], [decoded[name]]) !== observed.raw[name]) throw new Error(`${name} readback is not canonical`);
  const prefix = `ufg${variant[0].toUpperCase()}${variant.slice(1)}`;
  await writeFile(new URL(`../src/lifecycle/deployments/ufg-${variant}-pool-20261021.ts`, import.meta.url), `import type { LaunchEnvelopeV2, AdapterRegistrationV1, ProfileRegistrationV1, ProfileTopologyV1 } from "../schema.js";\n\n// Generated by scripts/generate-ufg-presets.mjs from ufg-registry-readback.json.\n// Robinhood block ${blockNumber}, ${evidence.blockHash}. Creation code is byte-identical to the existing ${variant} zero-royalty hook.\nexport const ${prefix}Envelope = ${literal(envelope)} satisfies LaunchEnvelopeV2;\nexport const ${prefix}Adapter = ${literal(adapter)} satisfies AdapterRegistrationV1;\nexport const ${prefix}Registration = ${literal(registration)} satisfies ProfileRegistrationV1;\nexport const ${prefix}Topology = ${literal(topology)} satisfies ProfileTopologyV1;\n`);
}
const artifacts = {
  ufgLaunchProxyV1Abi: 'contracts/out/UFGLaunchProxyV1.sol/UFGLaunchProxyV1.json',
  ufgTreasuryFactoryV1Abi: 'contracts/out/UFGTreasuryFactoryV1.sol/UFGTreasuryFactoryV1.json',
  ufgBlackMarketFactoryAbi: 'contracts/test/artifacts/ufg/UFGBlackMarketFactory.json',
  ufgBlackMarketTreasuryAbi: 'contracts/test/artifacts/ufg/UFGBlackMarketTreasury.json',
};
const declarations = [];
for (const [name, path] of Object.entries(artifacts)) {
  const artifact = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const clean = JSON.parse(JSON.stringify(artifact.abi, (key, value) => key === 'internalType' ? undefined : value));
  declarations.push(`export const ${name} = [\n${clean.map((item) => `  ${JSON.stringify(item)},`).join('\n')}\n] as const;`);
}
await writeFile(new URL('../src/lifecycle/ufg-abi.ts', import.meta.url), '// Complete UFG ABIs; generated by scripts/generate-ufg-presets.mjs from protocol artifacts.\n' + declarations.join('\n\n') + '\n');
console.log(`Generated UFG presets and ABIs from pinned Robinhood block ${blockNumber}`);
