import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hash, type Hex } from "viem";
import { launchLifecycleAbi, lifecycleAdapterAbi, lifecycleDirectoryAbi, lifecycleErc20Abi, lifecycleOracleFactoryAbi, lifecycleRegistryAbi, poolFeeCollectorFactoryV1Abi, poolFeeCollectorFactoryConfigV6Abi, lifecycleV4HookAbi, lifecycleV4LockerAbi, poolHookDeployerV1Abi, poolHookDeployerConfigV6Abi, sharedHookDeployerV1Abi, fixedFeePoolHookV1Abi, fixedFeePoolHookConfigV6Abi, poolMarketAdapterV1Abi, sharedMarketAdapterV1Abi } from "./abi.js";
import { buildPoolBoundHookParameters, decodePoolBoundV4LifecycleMarketConfig, encodePoolBoundHookParameters, hasLifecycleV4HookPermissions, isPoolBoundV4ConfigVersion, poolBoundHookInitCodeHash, predictPoolBoundHookAddress, validateV4LifecycleMarket, V4_LIFECYCLE_CONFIG_SCHEMA, V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V5, V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V6, type PoolBoundHookParameters, type PoolBoundLifecycleConfigVersion } from "./markets.js";
import { hashLaunchIdentity, hashLaunchPlan, hashLaunchBounds, hashLaunchDependencies, hashLifecycleProfile, lifecycleTokenComponents, launchProgressV1Components, LifecycleMode, LifecyclePhase, LifecycleVenue, LIFECYCLE_REQUIRED_CAPABILITIES, LIFECYCLE_ERC404_CAPABILITY, LIFECYCLE_MULTI_POSITION_CAPABILITY, type AdapterRegistrationV1, type LaunchPlanV1, type LaunchProgressV1, type MarketIdentityV1, type MarketLiveStateV1, type PreparedMarketV1, type ProfileRegistrationV1, type ProfileTopologyV1, type LaunchEnvelopeV2, type LifecycleDeveloperTerms } from "./schema.js";
import { assertLifecycleReadClientOpen, lifecycleFailureReason, lifecyclePinnedRpc, lifecycleStaticRpc, lifecycleRpc, lifecycleStage, readLifecycleBlock, readLifecycleChainId, readLifecycleContract, readLifecycleImmutable, readLifecycleStaticContract, readLifecycleProfileTopology, rpcHex, rpcObject, rpcQuantity, withLifecycleReadClient } from "./rpc.js";
import { LifecyclePlanningError, type CanonicalLaunchProgress, type LifecycleBlock, type LifecycleMarketProgress, type LifecycleProfile, type LifecycleReceiptReference, type LifecycleReceiptStatus, type LifecycleRpcClient, type PoolBoundHookDeployment, type ReadLaunchProgressOptions } from "./types.js";
import { deriveKnownPoolBoundHookDeployment } from "./calibration.js";
import { getKnownLifecycleDeployment, getKnownLifecycleProfile } from "./presets.js";
import { ufgLaunchProxyV1Abi } from "./ufg-abi.js";
import { assertUfgLaunchAccount, hashUfgLaunchConfig, UFG_LAUNCH_PROXY_ADDRESS, type UfgLaunchConfig } from "./ufg-config.js";
import { lifecycleLensSnapshot } from "./lens.js";

export const ABYSS_LIFECYCLE_CONFIG_SCHEMA = keccak256(stringToHex("(uint8,uint24,bytes32,uint160,(int24,int24,uint128,uint256)[])"));

export const lifecycleTokenPredictionAbi = [{
  type: "function", name: "predictToken", stateMutability: "view",
  inputs: [{ name: "launchId", type: "bytes32" }, { name: "config", type: "tuple", components: lifecycleTokenComponents }],
  outputs: [{ type: "address" }],
}] as const;

/** The known immutable factory accepts only launch identity and token config,
 * avoiding full-plan prediction reads after salts or buy minima change. */
export async function readLifecycleTokenAtBlock(client: LifecycleRpcClient, plan: LaunchPlanV1, block: LifecycleBlock): Promise<Address> {
  const deployment = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator });
  if (deployment === undefined) return readLifecycleContract<Address>(client, plan.orchestrator, launchLifecycleAbi, "predictToken", [plan], block);
  const launchId = hashLaunchIdentity(plan);
  const data = encodeFunctionData({ abi: lifecycleTokenPredictionAbi, functionName: "predictToken", args: [launchId, plan.token] });
  const key = `${plan.chainId}:${plan.orchestrator.toLowerCase()}:${deployment.tokenFactory.toLowerCase()}:${deployment.tokenFactoryCodeHash}:${data}`;
  return readLifecycleImmutable(client, key, () =>
    readLifecycleContract<Address>(client, deployment.tokenFactory, lifecycleTokenPredictionAbi, "predictToken", [launchId, plan.token], block, undefined, false, true));
}

/** Internal pinned head observation. Known cores do not inspect msg.sender. */
export function readLifecycleHeadProgress(client: LifecycleRpcClient, plan: LaunchPlanV1, account: Address, block: LifecycleBlock): Promise<LaunchProgressV1> {
  const known = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator }) !== undefined;
  return readLifecycleContract<LaunchProgressV1>(client, plan.orchestrator, launchLifecycleAbi, "readLaunchProgress", [hashLaunchIdentity(plan)], block, account, false, known);
}

export async function predictLifecycleToken(options: { client: LifecycleRpcClient; plan: LaunchPlanV1 }): Promise<Address> {
  return withLifecycleReadClient(options.client, async (client) => {
    const block = await readLifecycleBlock(client);
    const token = await readLifecycleTokenAtBlock(client, options.plan, block);
    return token;
  });
}

type BoundProfileGraph = { manager: Address; oracleFactory: Address; locker: Address; collectorFactory: Address; deployer: Address; creationCode: Hex };
type LifecycleProfileCertificate = { readonly topology: Readonly<ProfileTopologyV1>; readonly boundGraph?: Readonly<BoundProfileGraph> };
type LifecycleEligibilityObservation = { eligible: Address } | { failure: unknown };
type BoundHookDeploymentDetails = { readonly deployment: Readonly<PoolBoundHookDeployment>; readonly parameters: Readonly<PoolBoundHookParameters>; readonly configVersion: PoolBoundLifecycleConfigVersion };
const certifiedProfilesByInvocation = new WeakMap<LifecycleRpcClient, Map<string, Promise<LifecycleProfileCertificate>>>();
const boundDeploymentsByInvocation = new WeakMap<LifecycleRpcClient, Map<string, Promise<BoundHookDeploymentDetails>>>();

function assertDerivedReadClientOpen(client: LifecycleRpcClient): boolean {
  try { return assertLifecycleReadClientOpen(client); }
  catch (failure) {
    certifiedProfilesByInvocation.delete(client);
    boundDeploymentsByInvocation.delete(client);
    throw failure;
  }
}

function lifecycleProfileCertificateKey(orchestrator: Address, registry: Address, id: Hex, registration: ProfileRegistrationV1, adapter: AdapterRegistrationV1, topology: ProfileTopologyV1, envelope: LaunchEnvelopeV2 | undefined, block: LifecycleBlock, chainId: bigint): string {
  const g = envelope?.graph;
  const b = envelope?.bounds;
  // Fixed ABI field order preserves every scalar, including flags delegated to
  // registry eligibility. Keys never rehash runtime, chunk or creation bytes.
  return JSON.stringify([
    block.number.toString(), block.hash.toLowerCase(), chainId.toString(), orchestrator.toLowerCase(), registry.toLowerCase(), id.toLowerCase(),
    [registration.adapterId.toLowerCase(), registration.configSchema.toLowerCase(), registration.dependencyDigest.toLowerCase(),
      registration.venue.toLowerCase(), registration.factory.toLowerCase(), registration.hook.toLowerCase(), registration.capabilities.toString(), registration.enabled],
    [adapter.implementation.toLowerCase(), adapter.codeHash.toLowerCase(), adapter.capabilities.toString(), adapter.configVersion, adapter.enabled],
    [topology.hookTopology, topology.configVersion, topology.hookDeployer.toLowerCase(), topology.hookCreationCodeHash.toLowerCase()],
    envelope === undefined ? null : [
      envelope.artifactDigest.toLowerCase(), envelope.reviewManifestDigest.toLowerCase(), envelope.configBoundsDigest.toLowerCase(), envelope.termsDigest.toLowerCase(),
      envelope.topology, envelope.configVersion, envelope.economicVersion, envelope.capabilities.toString(), envelope.flags.toString(),
      envelope.callbackFlags, envelope.callbackMask, envelope.protocolTreasury.toLowerCase(), envelope.protocolFeeDenominator,
      envelope.beneficiary.toLowerCase(), envelope.maximumDeveloperFeeBps,
      [b!.minimumTickSpacing, b!.maximumTickSpacing, b!.maximumPositions, b!.maximumOracleCardinality, b!.feeModeFlags],
      [g!.manager.toLowerCase(), g!.hookRoot.toLowerCase(), g!.oracleFactory.toLowerCase(), g!.locker.toLowerCase(), g!.collectorFactory.toLowerCase(),
        g!.collectorDeployer.toLowerCase(), g!.hookDeployer.toLowerCase(), g!.coreCodeHash.toLowerCase(), g!.managerCodeHash.toLowerCase(),
        g!.hookRuntimeCodeHash.toLowerCase(), g!.oracleFactoryCodeHash.toLowerCase(), g!.lockerCodeHash.toLowerCase(), g!.collectorFactoryCodeHash.toLowerCase(),
        g!.collectorDeployerCodeHash.toLowerCase(), g!.hookDeployerCodeHash.toLowerCase(), g!.hookCreationCodeHash.toLowerCase(),
        g!.codeChunk0.toLowerCase(), g!.codeChunk0Hash.toLowerCase(), g!.codeChunk1.toLowerCase(), g!.codeChunk1Hash.toLowerCase(), g!.sharedHookSalt.toLowerCase()],
    ],
  ]);
}

async function readDependencyCode(client: LifecycleRpcClient, address: Address, block: LifecycleBlock): Promise<Hex> {
  const code = rpcHex(await lifecycleStaticRpc(client, "eth_getCode", [address, toHex(block.number)], block), "lifecycle dependency code");
  if (address === zeroAddress || code === "0x") throw new LifecyclePlanningError("PROFILE_DEPENDENCY", `Lifecycle dependency ${address} has no deployed code`);
  return code;
}

async function certifyLifecycleProfile(client: LifecycleRpcClient, orchestrator: Address, registry: Address, id: Hex, registration: ProfileRegistrationV1, adapter: AdapterRegistrationV1, topology: ProfileTopologyV1, envelope: LaunchEnvelopeV2 | undefined, block: LifecycleBlock, chainId: bigint, eligibility?: LifecycleEligibilityObservation): Promise<LifecycleProfileCertificate> {
  if (!assertDerivedReadClientOpen(client)) return certifyLifecycleProfileFresh(client, orchestrator, registry, id, registration, adapter, topology, envelope, block, chainId, eligibility);
  const key = lifecycleProfileCertificateKey(orchestrator, registry, id, registration, adapter, topology, envelope, block, chainId);
  let certificates = certifiedProfilesByInvocation.get(client);
  if (certificates === undefined) {
    certificates = new Map();
    certifiedProfilesByInvocation.set(client, certificates);
  }
  let pending = certificates.get(key);
  if (pending === undefined) {
    pending = certifyLifecycleProfileFresh(client, orchestrator, registry, id, registration, adapter, topology, envelope, block, chainId, eligibility);
    certificates.set(key, pending);
    const owned = pending;
    void pending.catch(() => { if (certificates.get(key) === owned) certificates.delete(key); });
  }
  try { return await pending; }
  finally { assertDerivedReadClientOpen(client); }
}

async function certifyLifecycleProfileFresh(client: LifecycleRpcClient, orchestrator: Address, registry: Address, id: Hex, registration: ProfileRegistrationV1, adapter: AdapterRegistrationV1, topology: ProfileTopologyV1, envelope: LaunchEnvelopeV2 | undefined, block: LifecycleBlock, chainId: bigint, eligibility?: LifecycleEligibilityObservation): Promise<LifecycleProfileCertificate> {
  const shared = registration.configSchema.toLowerCase() === V4_LIFECYCLE_CONFIG_SCHEMA.toLowerCase();
  const boundVersion = registration.configSchema.toLowerCase() === V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V5.toLowerCase() ? 5
    : registration.configSchema.toLowerCase() === V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V6.toLowerCase() ? 6 : undefined;
  const bound = boundVersion !== undefined;
  const abyss = registration.configSchema.toLowerCase() === ABYSS_LIFECYCLE_CONFIG_SCHEMA.toLowerCase();
  if (!shared && !bound && !abyss) throw new LifecyclePlanningError("UNSUPPORTED_SCHEMA", `Unsupported lifecycle config schema ${registration.configSchema}`);
  const version = shared ? 4 : boundVersion ?? 1;
  if (adapter.configVersion !== version || topology.configVersion !== version || topology.hookTopology !== (shared ? 1 : bound ? 2 : 0)) throw new LifecyclePlanningError("UNCERTIFIED_TOPOLOGY", "Registry topology/version differs from the supported config schema");
  if (abyss) {
    if (topology.hookDeployer !== zeroAddress || topology.hookCreationCodeHash !== zeroHash) throw new LifecyclePlanningError("UNCERTIFIED_TOPOLOGY", "Abyss does not admit a V4 hook deployment graph");
    // certifyAbyss fixes schema/version/factory at registration; requireEligible
    // rechecks that approved runtime and the live graph digest at this block.
    const factory = registration.factory;
    const domain = keccak256(stringToHex("BLACK_MARKET_ABYSS_CANONICAL_PROFILE_V1"));
    const known = [0, 1, 2, 3].some((variant) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint8" }], [domain, chainId, factory, variant])).toLowerCase() === id.toLowerCase());
    if (!known || registration.venue.toLowerCase() !== factory.toLowerCase() || registration.hook !== zeroAddress) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Abyss profile is not the exact canonical factory/variant/schema binding");
    if (eligibility !== undefined && "failure" in eligibility) throw eligibility.failure;
    const eligible = eligibility?.eligible ?? await readLifecycleStaticContract<Address>(client, registry, lifecycleRegistryAbi, "requireEligible", [registration.adapterId, id, version, LIFECYCLE_REQUIRED_CAPABILITIES], block);
    if (eligible.toLowerCase() !== adapter.implementation.toLowerCase()) throw new LifecyclePlanningError("INELIGIBLE_PROFILE", "Registry refuses this profile for pending source admission");
    return Object.freeze({ topology: Object.freeze({ ...topology }) });
  }
  if (envelope === undefined || envelope.topology !== topology.hookTopology || envelope.configVersion !== version || envelope.economicVersion !== 3 ||
    envelope.flags !== 0n || envelope.callbackFlags !== 0x1afc || envelope.callbackMask !== 0x3fff ||
    envelope.artifactDigest === zeroHash || envelope.reviewManifestDigest === zeroHash || envelope.termsDigest === zeroHash ||
    hashLifecycleProfile(envelope).toLowerCase() !== id.toLowerCase() ||
    hashLaunchBounds(envelope.bounds).toLowerCase() !== envelope.configBoundsDigest.toLowerCase() ||
    envelope.capabilities !== registration.capabilities || envelope.capabilities !== adapter.capabilities ||
    (envelope.capabilities & ~(LIFECYCLE_REQUIRED_CAPABILITIES | LIFECYCLE_ERC404_CAPABILITY | LIFECYCLE_MULTI_POSITION_CAPABILITY)) !== 0n) {
    throw new LifecyclePlanningError("PROFILE_ENVELOPE", "Frozen reviewed profile identity, bounds, capabilities or economic version differs from registry admission");
  }
  const b = envelope.bounds;
  if (b.minimumTickSpacing < 1 ||
    b.maximumTickSpacing > 32767 || b.minimumTickSpacing > b.maximumTickSpacing || b.maximumPositions < 1 || b.maximumPositions > 32 ||
    b.maximumOracleCardinality < 2 || b.maximumOracleCardinality > 4096 || b.feeModeFlags === 0 || (b.feeModeFlags & ~3) !== 0 ||
    envelope.protocolTreasury === zeroAddress || (envelope.protocolFeeDenominator !== 0 && (envelope.protocolFeeDenominator < 4 || envelope.protocolFeeDenominator > 10))) throw new LifecyclePlanningError("PROFILE_BOUNDS", "Registry envelope has unsupported executable bounds");
  const abi = bound ? poolMarketAdapterV1Abi : sharedMarketAdapterV1Abi;
  const g = envelope.graph;
  if (registration.factory !== zeroAddress || registration.venue.toLowerCase() !== g.manager.toLowerCase() || registration.hook.toLowerCase() !== g.hookRoot.toLowerCase() ||
    topology.hookDeployer.toLowerCase() !== g.hookDeployer.toLowerCase() || topology.hookCreationCodeHash.toLowerCase() !== g.hookCreationCodeHash.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed venue/topology differs from the frozen envelope graph");
  const deployerAbi = shared ? sharedHookDeployerV1Abi : boundVersion === 5 ? poolHookDeployerV1Abi : poolHookDeployerConfigV6Abi;
  const codeBindings = [[orchestrator, g.coreCodeHash], [g.manager, g.managerCodeHash], [g.oracleFactory, g.oracleFactoryCodeHash],
    [g.locker, g.lockerCodeHash], [g.collectorFactory, g.collectorFactoryCodeHash], [g.collectorDeployer, g.collectorDeployerCodeHash],
    [g.hookDeployer, g.hookDeployerCodeHash]] as const;
  // Frozen graph addresses permit independent evidence reads. Getter results
  // still have to match that graph; none of these observations is caller authority.
  const [eligible, metadata, actualVersion, dependencies, dependencyCodes, collectorDeployer, launcher, lockerManager, creationCodeHash, chunk0, chunk1, chunkCodes, sharedRoot] = await Promise.all([
    readLifecycleStaticContract<Address>(client, registry, lifecycleRegistryAbi, "requireEligible", [registration.adapterId, id, version, LIFECYCLE_REQUIRED_CAPABILITIES], block),
    Promise.all((["PROFILE_ID", "CONFIG_SCHEMA", "implementationRegistry"] as const).map((getter) => readLifecycleStaticContract<Hex>(client, adapter.implementation, abi, getter, [], block))),
    readLifecycleStaticContract<number>(client, adapter.implementation, abi, "CONFIG_VERSION", [], block),
    Promise.all((["poolManager", "hookRoot", "oracleFactory", "locker", "collectorFactory", "hookDeployer"] as const).map((getter) => readLifecycleStaticContract<Address>(client, adapter.implementation, abi, getter, [], block))),
    Promise.all(codeBindings.map(([address]) => readDependencyCode(client, address, block))),
    readLifecycleStaticContract<Address>(client, g.collectorFactory, poolFeeCollectorFactoryV1Abi, "collectorDeployer", [], block),
    readLifecycleStaticContract<Address>(client, g.locker, lifecycleV4LockerAbi, "launcher", [], block),
    readLifecycleStaticContract<Address>(client, g.locker, lifecycleV4LockerAbi, "poolManager", [], block),
    readLifecycleStaticContract<Hex>(client, g.hookDeployer, deployerAbi, "creationCodeHash", [], block),
    readLifecycleStaticContract<Address>(client, g.hookDeployer, deployerAbi, "codeChunk0", [], block),
    readLifecycleStaticContract<Address>(client, g.hookDeployer, deployerAbi, "codeChunk1", [], block),
    Promise.all([
      readDependencyCode(client, g.codeChunk0, block),
      g.codeChunk1 === zeroAddress ? Promise.resolve<Hex>("0x") : readDependencyCode(client, g.codeChunk1, block),
    ]),
    shared ? Promise.all([
      readDependencyCode(client, g.hookRoot, block),
      readLifecycleStaticContract<Hex>(client, g.hookDeployer, deployerAbi, "deployedCodeHash", [g.hookRoot], block),
      readLifecycleStaticContract<Address>(client, g.hookDeployer, sharedHookDeployerV1Abi, "predict", [g.manager, adapter.implementation, g.oracleFactory, g.sharedHookSalt], block),
      Promise.all((["registrar", "poolManager", "oracleFactory"] as const).map((getter) => readLifecycleStaticContract<Address>(client, g.hookRoot, lifecycleV4HookAbi, getter, [], block))),
      readLifecycleStaticContract<bigint>(client, g.hookRoot, lifecycleV4HookAbi, "REQUIRED_HOOK_FLAGS", [], block),
      readLifecycleStaticContract<bigint>(client, g.hookRoot, lifecycleV4HookAbi, "ALL_HOOK_MASK", [], block),
    ]) : undefined,
  ]);
  if (eligible.toLowerCase() !== adapter.implementation.toLowerCase()) throw new LifecyclePlanningError("INELIGIBLE_PROFILE", "Registry refuses this profile for pending source admission");
  for (const [index, expected] of [id, registration.configSchema, registry].entries()) {
    if (metadata[index]?.toLowerCase() !== expected.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed adapter metadata differs from registry certification");
  }
  if (actualVersion !== version) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed adapter config version differs from certification");
  for (const [index, expected] of [g.manager, g.hookRoot, g.oracleFactory, g.locker, g.collectorFactory, g.hookDeployer].entries()) {
    if (dependencies[index]?.toLowerCase() !== expected.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Live adapter dependency differs from the frozen reviewed graph");
  }
  for (const [index, [, expectedHash]] of codeBindings.entries()) {
    if (keccak256(dependencyCodes[index]!).toLowerCase() !== expectedHash.toLowerCase()) throw new LifecyclePlanningError("PROFILE_CODE_HASH", "Live runtime differs from the frozen reviewed graph hash");
  }
  if (collectorDeployer.toLowerCase() !== g.collectorDeployer.toLowerCase() || launcher.toLowerCase() !== adapter.implementation.toLowerCase() ||
    lockerManager.toLowerCase() !== g.manager.toLowerCase() || g.locker.toLowerCase() === g.manager.toLowerCase() || g.locker.toLowerCase() === g.hookRoot.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed collector or locker authority differs from the frozen graph");
  const [chunk0Code, chunk1Code] = chunkCodes;
  if (chunk0.toLowerCase() !== g.codeChunk0.toLowerCase() || chunk1.toLowerCase() !== g.codeChunk1.toLowerCase() || chunk0.toLowerCase() === chunk1.toLowerCase() ||
    !chunk0Code.startsWith("0x00") || chunk0Code.length <= 4 || (chunk0Code.length - 2) / 2 > 24576 ||
    (chunk1 !== zeroAddress && (!chunk1Code.startsWith("0x00") || chunk1Code.length <= 4 || (chunk1Code.length - 2) / 2 > 24576 || (chunk0Code.length - 2) / 2 !== 24576)) ||
    keccak256(chunk0Code).toLowerCase() !== g.codeChunk0Hash.toLowerCase() || (chunk1 === zeroAddress ? zeroHash : keccak256(chunk1Code)).toLowerCase() !== g.codeChunk1Hash.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed deployer chunks differ from exact immutable STOP-prefixed bytecode evidence");
  const creationCode = concatHex([`0x${chunk0Code.slice(4)}`, chunk1 === zeroAddress ? "0x" : `0x${chunk1Code.slice(4)}`]);
  if ((creationCode.length - 2) / 2 + (shared ? 96 : boundVersion === 5 ? 576 : 640) > 49152 || creationCodeHash === zeroHash ||
    creationCodeHash.toLowerCase() !== g.hookCreationCodeHash.toLowerCase() || keccak256(creationCode).toLowerCase() !== creationCodeHash.toLowerCase() ||
    hashLaunchDependencies({ chainId, core: orchestrator, registry, registrar: adapter.implementation, graph: g }).toLowerCase() !== registration.dependencyDigest.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Reviewed creation artifact, constructor bound or graph digest differs from admission");
  if (sharedRoot !== undefined) {
    const [rootCode, recordedHash, remotePrediction, dependencies, requiredFlags, allFlags] = sharedRoot;
    const initCodeHash = keccak256(concatHex([creationCode, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [g.manager, adapter.implementation, g.oracleFactory])]));
    const prediction = predictPoolBoundHookAddress({ deployer: g.hookDeployer, initCodeHash, salt: g.sharedHookSalt });
    if (recordedHash === zeroHash || recordedHash.toLowerCase() !== g.hookRuntimeCodeHash.toLowerCase() || keccak256(rootCode).toLowerCase() !== recordedHash.toLowerCase() ||
      !hasLifecycleV4HookPermissions(g.hookRoot) || prediction.toLowerCase() !== g.hookRoot.toLowerCase() || remotePrediction.toLowerCase() !== prediction.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Shared root lacks exact typed-deployer runtime and constructor/salt provenance");
    for (const [index, expected] of [adapter.implementation, g.manager, g.oracleFactory].entries()) {
      if (dependencies[index]?.toLowerCase() !== expected.toLowerCase()) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Shared hook immutable graph differs from admission");
    }
    if (requiredFlags !== 0x1afcn || allFlags !== 0x3fffn) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Shared hook callbacks differ from admission");
  } else if (g.hookRoot !== zeroAddress || g.hookRuntimeCodeHash !== zeroHash || g.sharedHookSalt !== zeroHash) throw new LifecyclePlanningError("PROFILE_DEPENDENCY", "Bound topology cannot reuse a shared root");
  if ([zeroAddress, orchestrator, registry, adapter.implementation, g.manager, g.hookRoot, g.locker, g.collectorFactory, g.collectorDeployer, g.hookDeployer].some((address) => address.toLowerCase() === envelope.beneficiary.toLowerCase())) throw new LifecyclePlanningError("PROFILE_TERMS", "Stable author identity is an excluded reviewed graph destination");
  return Object.freeze({ topology: Object.freeze({ ...topology }), boundGraph: bound ? Object.freeze({ manager: g.manager, oracleFactory: g.oracleFactory, locker: g.locker, collectorFactory: g.collectorFactory, deployer: g.hookDeployer, creationCode }) : undefined });
}

/** Validate the market-selected registered oracle against the certified factory at the pinned block. */
export async function validateV4LifecycleOracle(options: {
  client: LifecycleRpcClient; envelope: LaunchEnvelopeV2; oracleConfigId: Hex; block: LifecycleBlock;
}): Promise<void> {
  const { client, envelope, oracleConfigId, block } = options;
  if (oracleConfigId.toLowerCase() === zeroHash) throw new LifecyclePlanningError("INVALID_ORACLE_CONFIG", "Market oracle configuration must be nonzero");
  const [move, cardinality] = await readLifecycleStaticContract<readonly [number, number]>(client, envelope.graph.oracleFactory, lifecycleOracleFactoryAbi, "oracleConfigs", [oracleConfigId], block);
  if (move <= 0 || move > 887272 || cardinality < 2 || cardinality > envelope.bounds.maximumOracleCardinality) {
    throw new LifecyclePlanningError("INVALID_ORACLE_CONFIG", "Selected market oracle is unregistered or exceeds the admitted cardinality bounds");
  }
}

export async function readLifecycleProfiles(options: { client: LifecycleRpcClient; orchestrator: Address; profileIds?: readonly Hex[]; offset?: bigint; limit?: bigint }, pinnedBlock?: LifecycleBlock): Promise<LifecycleProfile[]> {
  return withLifecycleReadClient(options.client, (client) => lifecycleStage(client, "profile.certification", async () => {
    const chainIdPromise = readLifecycleChainId(client);
    // Block-bound discovery does not depend on chain identity. Join both branches
    // immediately so a failed chain read cannot become detached or a profile refusal.
    const [, { profiles }] = await Promise.all([
      chainIdPromise,
      (async () => {
        const block = pinnedBlock ?? await readLifecycleBlock(client);
        const registry = await readLifecycleContract<Address>(client, options.orchestrator, launchLifecycleAbi, "registry", [], block);
        const offset = options.offset ?? 0n; const limit = options.limit ?? 100n;
        if (offset < 0n || limit < 0n || limit > 100n) throw new LifecyclePlanningError("INVALID_PROFILE_PAGE", "Registry profile pages require unsigned offset and limit at most 100");
        let protocolMaximumDeveloperFeeBpsPromise: Promise<number> | undefined;
        const readProtocolMaximumDeveloperFeeBps = () => protocolMaximumDeveloperFeeBpsPromise ??=
          readLifecycleStaticContract<number>(client, registry, lifecycleRegistryAbi, "protocolMaximumDeveloperFeeBps", [], block);
        const readProfile = async (id: Hex): Promise<LifecycleProfile> => {
          const registration = await readLifecycleStaticContract<ProfileRegistrationV1>(client, registry, lifecycleRegistryAbi, "profile", [id], block);
          const schema = registration.configSchema.toLowerCase();
          const venueKind = schema === V4_LIFECYCLE_CONFIG_SCHEMA.toLowerCase() || schema === V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V5.toLowerCase() || schema === V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V6.toLowerCase() ? "uniswap-v4" : schema === ABYSS_LIFECYCLE_CONFIG_SCHEMA.toLowerCase() ? "abyss" : "unknown";
          const [adapter, certification] = await Promise.all([
            readLifecycleStaticContract<AdapterRegistrationV1>(client, registry, lifecycleRegistryAbi, "adapter", [registration.adapterId], block),
            venueKind === "unknown" ? undefined : Promise.all([
              readLifecycleProfileTopology(client, registry, id, block),
              venueKind === "uniswap-v4" ? Promise.all([
                readLifecycleStaticContract<LaunchEnvelopeV2>(client, registry, lifecycleRegistryAbi, "profileEnvelope", [id], block),
                readLifecycleStaticContract<readonly [Address, Address, number, Hex, boolean]>(client, registry, lifecycleRegistryAbi, "developerTerms", [id], block),
                readProtocolMaximumDeveloperFeeBps(),
              ]) : undefined,
              // The exact Abyss arguments follow from registration, independently
              // of adapter/topology responses. Handle refusal immediately, but
              // keep its original place after canonical/schema/topology checks.
              venueKind === "abyss" ? chainIdPromise.then(() =>
                readLifecycleStaticContract<Address>(client, registry, lifecycleRegistryAbi, "requireEligible", [registration.adapterId, id, 1, LIFECYCLE_REQUIRED_CAPABILITIES], block)
              ).then((eligible) => ({ eligible }), (failure: unknown) => ({ failure })) : undefined,
            ]).then((values) => ({ values }), (failure: unknown) => ({ failure })),
          ]);
          const chainId = await chainIdPromise;
          let topology: ProfileTopologyV1 = { hookTopology: 0, configVersion: adapter.configVersion, hookDeployer: zeroAddress, hookCreationCodeHash: zeroHash };
          let envelope: LaunchEnvelopeV2 | undefined; let developerTerms: LifecycleDeveloperTerms | undefined;
          let protocolMaximumDeveloperFeeBps: number | undefined;
          let admitted = false; let reason: string | undefined;
          try {
            if (certification === undefined) throw new LifecyclePlanningError("UNSUPPORTED_SCHEMA", `Unsupported lifecycle config schema ${registration.configSchema}`);
            if ("failure" in certification) throw certification.failure;
            const [recordedTopology, reviewed, eligibility] = certification.values;
            topology = recordedTopology;
            if (reviewed !== undefined) {
              envelope = reviewed[0];
              protocolMaximumDeveloperFeeBps = reviewed[2];
              const [implementation, beneficiary, maximumDeveloperFeeBps, termsDigest, enabled] = reviewed[1];
              developerTerms = { adapter: implementation, beneficiary, maximumDeveloperFeeBps, termsDigest, enabled };
              if (implementation.toLowerCase() !== adapter.implementation.toLowerCase() || beneficiary.toLowerCase() !== envelope.beneficiary.toLowerCase() ||
                termsDigest.toLowerCase() !== envelope.termsDigest.toLowerCase() || maximumDeveloperFeeBps !== envelope.maximumDeveloperFeeBps ||
                maximumDeveloperFeeBps > reviewed[2]) throw new LifecyclePlanningError("PROFILE_TERMS", "Registry developer terms differ from the frozen reviewed envelope");
            }
            await certifyLifecycleProfile(client, options.orchestrator, registry, id, registration, adapter, topology, envelope, block, chainId, eligibility);
            if (developerTerms !== undefined && !developerTerms.enabled) throw new LifecyclePlanningError("INELIGIBLE_PROFILE", "Registry refuses this profile for pending source admission");
            admitted = true;
          } catch (failure) { reason = lifecycleFailureReason(failure); }
          return { id, registration, adapter, topology, envelope, developerTerms, protocolMaximumDeveloperFeeBps: venueKind === "uniswap-v4" ? protocolMaximumDeveloperFeeBps : undefined, admitted, reason, venueKind };
        };
        const [authority, profiles] = await Promise.all([
          readLifecycleContract<Address>(client, registry, lifecycleRegistryAbi, "core", [], block),
          Promise.resolve(options.profileIds ?? readLifecycleContract<readonly Hex[]>(client, registry, lifecycleRegistryAbi, "profileIds", [offset, limit], block)).then((ids) => Promise.all(ids.map(readProfile))),
        ]);
        if (authority.toLowerCase() !== options.orchestrator.toLowerCase()) throw new LifecyclePlanningError("REGISTRY_BINDING", "Registry is not bound to the selected lifecycle orchestrator");
        // A required V4 cap read still rejects the invocation on failure; Abyss has no developer-fee terms.
        if (protocolMaximumDeveloperFeeBpsPromise !== undefined) await protocolMaximumDeveloperFeeBpsPromise;
        return { block, profiles };
      })(),
    ]);
    return profiles;
  }));
}

async function readPoolBoundHookDeploymentDetails(options: { client: LifecycleRpcClient; plan: LaunchPlanV1; marketIndex: number }, block: LifecycleBlock, commitment: Hex): Promise<BoundHookDeploymentDetails> {
  const { client, plan, marketIndex } = options;
  const market = plan.markets[marketIndex];
  if (market === undefined || !isPoolBoundV4ConfigVersion(market.configVersion)) throw new LifecyclePlanningError("INVALID_BOUND_MARKET", "Market index must select explicit pool-bound config version 5 or 6");
  let chainId: bigint;
  try { chainId = await readLifecycleChainId(client); }
  finally { assertDerivedReadClientOpen(client); }
  if (hashLaunchPlan(plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while observing the hook deployment chain");
  if (chainId !== plan.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain differs from the committed plan");
  if (getKnownLifecycleProfile({ chainId, orchestrator: plan.orchestrator, profileId: market.profileId }) !== undefined) {
    const token = await readLifecycleTokenAtBlock(client, plan, block);
    const details = deriveKnownPoolBoundHookDeployment({ plan, marketIndex, token });
    if (details === undefined) throw new LifecyclePlanningError("INVALID_BOUND_MARKET", "Known profile has no bound-hook construction metadata");
    if (hashLaunchPlan(plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while deriving hook deployment metadata");
    assertDerivedReadClientOpen(client);
    return Object.freeze({ deployment: Object.freeze(details.deployment), parameters: Object.freeze(details.parameters), configVersion: details.configVersion });
  }
  if (!assertDerivedReadClientOpen(client)) {
    const details = await readPoolBoundHookDeploymentDetailsFresh(options, block, chainId);
    if (hashLaunchPlan(plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while reading hook deployment metadata");
    return details;
  }
  const key = JSON.stringify([block.number.toString(), block.hash.toLowerCase(), chainId.toString(), commitment.toLowerCase(), marketIndex]);
  let deployments = boundDeploymentsByInvocation.get(client);
  if (deployments === undefined) {
    deployments = new Map();
    boundDeploymentsByInvocation.set(client, deployments);
  }
  let pending = deployments.get(key);
  if (pending === undefined) {
    pending = readPoolBoundHookDeploymentDetailsFresh(options, block, chainId).then((details) => {
      if (hashLaunchPlan(plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while reading hook deployment metadata");
      assertDerivedReadClientOpen(client);
      return details;
    });
    deployments.set(key, pending);
    const owned = pending;
    void pending.catch(() => { if (deployments.get(key) === owned) deployments.delete(key); });
  }
  try { return await pending; }
  finally { assertDerivedReadClientOpen(client); }
}

async function readPoolBoundHookDeploymentDetailsFresh(options: { client: LifecycleRpcClient; plan: LaunchPlanV1; marketIndex: number }, block: LifecycleBlock, chainId: bigint): Promise<BoundHookDeploymentDetails> {
  const { client, plan, marketIndex } = options;
  const market = plan.markets[marketIndex]!;
  const registry = await readLifecycleContract<Address>(client, plan.orchestrator, launchLifecycleAbi, "registry", [], block);
  const [authority, registration] = await Promise.all([
    readLifecycleContract<Address>(client, registry, lifecycleRegistryAbi, "core", [], block),
    readLifecycleStaticContract<ProfileRegistrationV1>(client, registry, lifecycleRegistryAbi, "profile", [market.profileId], block),
  ]);
  if (authority.toLowerCase() !== plan.orchestrator.toLowerCase()) throw new LifecyclePlanningError("REGISTRY_BINDING", "Registry is not bound to this lifecycle core");
  const adapter = await readLifecycleStaticContract<AdapterRegistrationV1>(client, registry, lifecycleRegistryAbi, "adapter", [registration.adapterId], block);
  if (registration.adapterId.toLowerCase() !== market.adapterId.toLowerCase()) throw new LifecyclePlanningError("INVALID_BOUND_MARKET", "Market adapter differs from the profile's immutable registration");
  const [recorded, envelope, [implementation, beneficiary, maximumDeveloperFeeBps, termsDigest, enabled], protocolMaximumDeveloperFeeBps, token] = await Promise.all([
    readLifecycleProfileTopology(client, registry, market.profileId, block),
    readLifecycleStaticContract<LaunchEnvelopeV2>(client, registry, lifecycleRegistryAbi, "profileEnvelope", [market.profileId], block),
    readLifecycleStaticContract<readonly [Address, Address, number, Hex, boolean]>(client, registry, lifecycleRegistryAbi, "developerTerms", [market.profileId], block),
    readLifecycleStaticContract<number>(client, registry, lifecycleRegistryAbi, "protocolMaximumDeveloperFeeBps", [], block),
    readLifecycleContract<Address>(client, plan.orchestrator, launchLifecycleAbi, "predictToken", [plan], block),
  ]);
  const { boundGraph } = await certifyLifecycleProfile(client, plan.orchestrator, registry, market.profileId, registration, adapter, recorded, envelope, block, chainId);
  if (boundGraph === undefined) throw new LifecyclePlanningError("UNCERTIFIED_TOPOLOGY", "Market does not have a certified pool-bound deployer graph");
  if (!isPoolBoundV4ConfigVersion(market.configVersion)) throw new LifecyclePlanningError("INVALID_BOUND_MARKET", "Market must select an explicit pool-bound version");
  const config = decodePoolBoundV4LifecycleMarketConfig(market.config, market.configVersion);
  validateV4LifecycleMarket({ market, config, token, profile: {
    id: market.profileId, registration, adapter, topology: recorded, envelope,
    developerTerms: { adapter: implementation, beneficiary, maximumDeveloperFeeBps, termsDigest, enabled },
    protocolMaximumDeveloperFeeBps, venueKind: "uniswap-v4", admitted: enabled,
  } });
  await validateV4LifecycleOracle({ client, envelope, oracleConfigId: config.oracleConfigId, block });
  const expected = buildPoolBoundHookParameters({
    chainId, core: plan.orchestrator, poolManager: boundGraph.manager, registrar: adapter.implementation,
    oracleFactory: boundGraph.oracleFactory, liquidityLocker: boundGraph.locker, token, market, config,
  });
  const deployerAbi = config.version === 5 ? poolHookDeployerV1Abi : poolHookDeployerConfigV6Abi;
  const collectorAbi = config.version === 5 ? poolFeeCollectorFactoryV1Abi : poolFeeCollectorFactoryConfigV6Abi;
  const [[parameters, parameterSalt], [deployer, initCodeHash, salt, predictedHook], remoteInitCodeHash, remotePrediction] = await Promise.all([
    readLifecycleStaticContract<readonly [PoolBoundHookParameters, Hex]>(client, boundGraph.collectorFactory, collectorAbi, "poolBoundHookParameters", [adapter.implementation, token, market], block),
    readLifecycleStaticContract<readonly [Address, Hex, Hex, Address]>(client, adapter.implementation, poolMarketAdapterV1Abi, "hookDeploymentMetadata", [token, market], block),
    readLifecycleStaticContract<Hex>(client, boundGraph.deployer, deployerAbi, "initCodeHash", [expected], block),
    readLifecycleStaticContract<Address>(client, boundGraph.deployer, deployerAbi, "predict", [expected, config.hookSalt], block),
  ]);
  const localInitCodeHash = poolBoundHookInitCodeHash(boundGraph.creationCode, expected, config.version);
  const localPrediction = predictPoolBoundHookAddress({ deployer: boundGraph.deployer, initCodeHash: localInitCodeHash, salt: config.hookSalt });
  if (encodePoolBoundHookParameters(parameters, config.version).toLowerCase() !== encodePoolBoundHookParameters(expected, config.version).toLowerCase() || parameterSalt.toLowerCase() !== config.hookSalt.toLowerCase() || salt.toLowerCase() !== config.hookSalt.toLowerCase() || deployer.toLowerCase() !== boundGraph.deployer.toLowerCase() || initCodeHash.toLowerCase() !== localInitCodeHash.toLowerCase() || remoteInitCodeHash.toLowerCase() !== localInitCodeHash.toLowerCase() || predictedHook.toLowerCase() !== localPrediction.toLowerCase() || remotePrediction.toLowerCase() !== localPrediction.toLowerCase()) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Bound hook metadata differs from the exact certified version, constructor economics, factory, initcode, salt or CREATE2 prediction");
  const hookCode = rpcHex(await lifecyclePinnedRpc(client, "eth_getCode", [predictedHook, toHex(block.number)], block), "bound hook code");
  if (hookCode !== "0x") {
    const [deployedCodeHash, dependencies, requiredFlags, allFlags, actualPoolId, deploymentConfigHash, marketCommitment, opening, positions, feePolicy] = await Promise.all([
      readLifecycleStaticContract<Hex>(client, deployer, deployerAbi, "deployedCodeHash", [predictedHook], block),
      Promise.all((["poolManager", "registrar", "oracleFactory", "core", "liquidityLocker", "token"] as const).map((getter) => readLifecycleContract<Address>(client, predictedHook, fixedFeePoolHookV1Abi, getter, [], block))),
      readLifecycleContract<bigint>(client, predictedHook, fixedFeePoolHookV1Abi, "REQUIRED_HOOK_FLAGS", [], block),
      readLifecycleContract<bigint>(client, predictedHook, fixedFeePoolHookV1Abi, "ALL_HOOK_MASK", [], block),
      readLifecycleContract<Hex>(client, predictedHook, fixedFeePoolHookV1Abi, "boundPoolId", [], block),
      readLifecycleContract<Hex>(client, predictedHook, fixedFeePoolHookV1Abi, "deploymentConfigHash", [], block),
      readLifecycleContract<Hex>(client, predictedHook, fixedFeePoolHookV1Abi, "marketCommitment", [], block),
      readLifecycleContract<bigint>(client, predictedHook, fixedFeePoolHookV1Abi, "openingSqrtPriceX96", [], block),
      readLifecycleContract<number>(client, predictedHook, fixedFeePoolHookV1Abi, "expectedPositionCount", [], block),
      config.version === 6 ? Promise.all([
        readLifecycleContract<number>(client, predictedHook, fixedFeePoolHookConfigV6Abi, "minimumHookFeePips", [], block),
        readLifecycleContract<number>(client, predictedHook, fixedFeePoolHookConfigV6Abi, "feeSensitivityPipsSecondsPerTick", [], block),
      ]) : undefined,
    ]);
    if ((hookCode.length - 2) / 2 > 24576 || deployedCodeHash === zeroHash || deployedCodeHash.toLowerCase() !== keccak256(hookCode).toLowerCase()) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Existing hook lacks this exact typed deployer's bounded runtime-code provenance");
    for (const [index, expectedAddress] of [expected.poolManager, expected.registrar, expected.oracleFactory, expected.core, expected.liquidityLocker, expected.token].entries()) {
      if (dependencies[index]?.toLowerCase() !== expectedAddress.toLowerCase()) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Existing hook immutable dependency graph differs from the committed constructor");
    }
    if (requiredFlags !== 0x1afcn || allFlags !== 0x3fffn) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Existing bound hook callback declarations differ from the reviewed envelope");
    const [currency0, currency1] = BigInt(token) < BigInt(market.quoteAsset) ? [token, market.quoteAsset] : [market.quoteAsset, token];
    const expectedPoolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [currency0, currency1, config.lpFeePips, config.tickSpacing, predictedHook]));
    if (actualPoolId.toLowerCase() !== expectedPoolId.toLowerCase() || deploymentConfigHash.toLowerCase() !== keccak256(encodePoolBoundHookParameters(expected, config.version)).toLowerCase() || marketCommitment.toLowerCase() !== expected.marketCommitment.toLowerCase() || opening !== expected.sqrtPriceX96 || positions !== expected.expectedPositionCount ||
      (config.version === 6 && (feePolicy?.[0] !== config.minimumHookFeePips || feePolicy?.[1] !== config.feeSensitivityPipsSecondsPerTick))) throw new LifecyclePlanningError("HOOK_DEPLOYMENT_CHANGED", "Existing hook key, economic commitment, versioned fee policy or immutable opening geometry changed");
  }
  return Object.freeze({ deployment: Object.freeze({ deployer, initCodeHash, salt, predictedHook }), parameters: Object.freeze(expected), configVersion: config.version });
}

/** Known identities use frozen local construction data; unlisted identities use
 * explicit live certification. Exact launch execution, not either DTO, authorizes. */
export async function readPoolBoundHookDeployment(options: { client: LifecycleRpcClient; plan: LaunchPlanV1; marketIndex: number }, pinnedBlock?: LifecycleBlock): Promise<PoolBoundHookDeployment> {
  const commitment = hashLaunchPlan(options.plan);
  const block = pinnedBlock ?? await readLifecycleBlock(options.client);
  const result = await withLifecycleReadClient(options.client, async (client) => {
    const { deployment } = await readPoolBoundHookDeploymentDetails({ ...options, client }, block, commitment);
    if (hashLaunchPlan(options.plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while reading hook deployment metadata");
    return { ...deployment };
  });
  if (hashLaunchPlan(options.plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed during the final hook deployment guard");
  return result;
}

/** Optional permissionless predeployment calldata; no token deployment, pool registration or wallet broadcast. */
export async function buildPoolBoundHookDeploymentTransaction(options: { client: LifecycleRpcClient; plan: LaunchPlanV1; marketIndex: number }): Promise<{ to: Address; data: Hex; value: bigint; deployment: PoolBoundHookDeployment }> {
  const commitment = hashLaunchPlan(options.plan);
  const block = await readLifecycleBlock(options.client);
  const result = await withLifecycleReadClient(options.client, async (client) => {
    const { deployment, parameters, configVersion } = await readPoolBoundHookDeploymentDetails({ ...options, client }, block, commitment);
    if (!hasLifecycleV4HookPermissions(deployment.predictedHook)) throw new LifecyclePlanningError("INVALID_HOOK_BITS", "Finalize a salt with the exact lifecycle hook permissions before predeployment");
    if (hashLaunchPlan(options.plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed while constructing hook deployment calldata");
    const abi = configVersion === 5 ? poolHookDeployerV1Abi : poolHookDeployerConfigV6Abi;
    return { to: deployment.deployer, data: encodeFunctionData({ abi, functionName: "deploy", args: [parameters, deployment.salt] }), value: 0n, deployment: { ...deployment } };
  });
  if (hashLaunchPlan(options.plan) !== commitment) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed during the final hook transaction guard");
  return result;
}

export function validateLifecycleMarketIdentity(identity: MarketIdentityV1, plan: LaunchPlanV1, token: Address, marketIndex: number): void {
  const market = plan.markets[marketIndex];
  if (market === undefined) throw new LifecyclePlanningError("MARKET_IDENTITY", "Market index is outside the economic plan");
  const [currency0, currency1] = BigInt(token) < BigInt(market.quoteAsset) ? [token, market.quoteAsset] : [market.quoteAsset, token];
  const expectedCanonicalId = keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
  ], [plan.chainId, identity.venue, identity.manager, identity.factory, identity.pool, identity.poolId, identity.profileId]));
  if (identity.canonicalId.toLowerCase() !== expectedCanonicalId.toLowerCase() || identity.profileId.toLowerCase() !== market.profileId.toLowerCase() || identity.currency0.toLowerCase() !== currency0?.toLowerCase() || identity.currency1.toLowerCase() !== currency1?.toLowerCase() || identity.openingSqrtPriceX96 === 0n || identity.tickSpacing <= 0) throw new LifecyclePlanningError("MARKET_IDENTITY", "Venue identity does not match canonical chain, plan, currencies and opening price");
  if (identity.venue === LifecycleVenue.UniswapV4) {
    const expectedPoolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [identity.currency0, identity.currency1, identity.fee, identity.tickSpacing, identity.hook]));
    if (identity.manager === zeroAddress || identity.factory !== zeroAddress || identity.pool !== zeroAddress || identity.poolId.toLowerCase() !== expectedPoolId.toLowerCase() || !hasLifecycleV4HookPermissions(identity.hook)) throw new LifecyclePlanningError("MARKET_IDENTITY", "V4 full permissioned PoolKey identity differs from its canonical pool ID");
  } else if (identity.venue !== LifecycleVenue.Abyss || identity.pool === zeroAddress || identity.factory === zeroAddress) throw new LifecyclePlanningError("MARKET_IDENTITY", "Abyss canonical factory/pool identity is missing");
}

async function transactionMatchesLaunch(transaction: Record<string, unknown>, options: ReadLaunchProgressOptions, readBlock: () => Promise<LifecycleBlock>): Promise<boolean> {
  const { planned } = options;
  const from = rpcHex(transaction.from, "receipt transaction account");
  if (from.toLowerCase() !== planned.account.toLowerCase()) throw new LifecyclePlanningError("RECEIPT_ACCOUNT", "Receipt transaction belongs to a different account");
  if (transaction.chainId !== undefined && rpcQuantity(transaction.chainId, "receipt transaction chain") !== planned.plan.chainId) throw new LifecyclePlanningError("RECEIPT_CHAIN", "Receipt transaction belongs to a different chain");
  const to = transaction.to === null ? zeroAddress : rpcHex(transaction.to, "receipt transaction target");
  const input = rpcHex(transaction.input ?? transaction.data, "receipt transaction calldata");
  const target = planned.ufg === undefined ? planned.plan.orchestrator : UFG_LAUNCH_PROXY_ADDRESS;
  if (to.toLowerCase() === target.toLowerCase()) {
    try {
      const decoded = decodeFunctionData({ abi: planned.ufg === undefined ? launchLifecycleAbi : ufgLaunchProxyV1Abi, data: input });
      if (!["launchAtomic", "beginLaunch", "prepareMarkets", "activateLaunch", "cancelLaunch"].includes(decoded.functionName) || !Array.isArray(decoded.args)) return false;
      // Decoded plan layout is validated by the exact ABI, not trusted raw RPC JSON.
      const plan = decoded.args[0] as LaunchPlanV1;
      if (planned.ufg !== undefined && (decoded.functionName === "launchAtomic" || decoded.functionName === "beginLaunch")) {
        const config = decoded.args[decoded.functionName === "launchAtomic" ? 1 : 2] as UfgLaunchConfig;
        if (hashUfgLaunchConfig(config) !== planned.ufg.configHash) return false;
      }
      return hashLaunchPlan(plan).toLowerCase() === planned.planHash.toLowerCase();
    } catch { return false; }
  }
  const fundingAsset = planned.plan.funding.some((funding) => funding.inputAsset.toLowerCase() === to.toLowerCase());
  if (!fundingAsset) return false;
  let spender: Address;
  try {
    const decoded = decodeFunctionData({ abi: lifecycleErc20Abi, data: input });
    if (decoded.functionName !== "approve" || rpcQuantity(transaction.value ?? "0x0", "approval native value") !== 0n) return false;
    spender = decoded.args[0];
  } catch { return false; }
  const known = getKnownLifecycleDeployment({ chainId: planned.plan.chainId, orchestrator: planned.plan.orchestrator });
  const escrow = planned.ufg !== undefined ? UFG_LAUNCH_PROXY_ADDRESS : known?.fundingEscrow ??
    await readLifecycleContract<Address>(options.client, planned.plan.orchestrator, launchLifecycleAbi, "fundingEscrow", [], await readBlock());
  return spender.toLowerCase() === escrow.toLowerCase();
}

type ReceiptObservation = {
  pins: readonly { number: bigint; hash: Hex }[];
  finish(headers: ReadonlyMap<bigint, Hex | undefined>): LifecycleReceiptStatus;
};

async function readReceipt(reference: LifecycleReceiptReference, options: ReadLaunchProgressOptions, block: LifecycleBlock, readIdentityBlock: (number: bigint) => Promise<LifecycleBlock>): Promise<ReceiptObservation> {
  const effectiveHash = reference.replacementHash ?? reference.transactionHash;
  const base = { transactionHash: reference.transactionHash, effectiveHash, replaced: reference.replacementHash !== undefined && reference.replacementHash.toLowerCase() !== reference.transactionHash.toLowerCase() };
  const pins: { number: bigint; hash: Hex }[] = [];
  const observedNumber = reference.observedBlockNumber, observedHash = reference.observedBlockHash;
  if (observedNumber !== undefined && observedHash !== undefined) pins.push({ number: observedNumber, hash: observedHash });
  const finish = (result: LifecycleReceiptStatus, failure?: { error: unknown }): ReceiptObservation => ({
    pins,
    finish(headers) {
      for (const pin of pins) {
        if (failure !== undefined && (pin.number !== observedNumber || pin.hash !== observedHash)) continue;
        if (headers.get(pin.number)?.toLowerCase() !== pin.hash.toLowerCase()) return { ...base, status: "reorged", blockNumber: pin.number, blockHash: pin.hash };
      }
      if (failure !== undefined) throw failure.error;
      return result;
    },
  });
  try {
    const [receiptValue, transactionValue] = await Promise.all([
      lifecycleRpc(options.client, "eth_getTransactionReceipt", [effectiveHash]),
      lifecycleRpc(options.client, "eth_getTransactionByHash", [effectiveHash]),
    ]);
    if (receiptValue === null) return finish({ ...base, status: "pending", blockNumber: observedNumber, blockHash: observedHash });
    if (transactionValue === null) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Receipt exists without its canonical transaction");
    const receipt = rpcObject(receiptValue, "receipt");
    const blockNumber = rpcQuantity(receipt.blockNumber, "receipt block number");
    const blockHash = rpcHex(receipt.blockHash, "receipt block hash");
    pins.push({ number: blockNumber, hash: blockHash });
    const matches = await transactionMatchesLaunch(rpcObject(transactionValue, "receipt transaction"), options,
      () => readIdentityBlock(blockNumber));
    const confirmations = block.number >= blockNumber ? block.number - blockNumber + 1n : 0n;
    const required = reference.confirmations ?? 1;
    if (!Number.isSafeInteger(required) || required < 1) throw new LifecyclePlanningError("INVALID_CONFIRMATIONS", "Receipt confirmations must be a positive integer");
    const observation = finish({
      ...base, blockNumber, blockHash, confirmations,
      status: confirmations < BigInt(required) ? "unconfirmed" : !matches ? "replacement-cancelled" :
        rpcQuantity(receipt.status, "receipt status") !== 1n ? "reverted" : "confirmed",
    });
    return {
      pins,
      finish(headers) {
        const result = observation.finish(headers);
        if (result.status !== "reorged" && !matches && !base.replaced) throw new LifecyclePlanningError("RECEIPT_IDENTITY", "Receipt calldata does not belong to the exact committed launch");
        return result;
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // A changed retained observation is a reorg even if the orphan's transaction
    // or identity read is now unavailable. Otherwise preserve the original error.
    return finish({ ...base, status: "pending" }, { error });
  }
}

async function readReceipts(options: ReadLaunchProgressOptions, block: LifecycleBlock, confirmationDepth: number): Promise<LifecycleReceiptStatus[]> {
  if (options.receipts === undefined || options.receipts.length === 0) return [];
  const identityBlocks = new Map<bigint, Promise<LifecycleBlock>>();
  const readIdentityBlock = (number: bigint) => {
    if (number === block.number) return Promise.resolve(block);
    let pending = identityBlocks.get(number);
    if (pending === undefined) { pending = readLifecycleBlock(options.client, toHex(number)); identityBlocks.set(number, pending); }
    return pending;
  };
  const observations = await Promise.all((options.receipts ?? []).map((reference) =>
    readReceipt({ ...reference, confirmations: Math.max(reference.confirmations ?? 1, confirmationDepth) }, options, block, readIdentityBlock)));
  const headers = new Map<bigint, Hex | undefined>();
  for (const observation of observations) for (const pin of observation.pins) headers.set(pin.number, undefined);
  // Reuse this invocation's authoritative L2 head header. Older receipt blocks
  // share one canonical read after their asynchronous identity observations.
  await Promise.all([...headers.keys()].map(async (number) => {
    if (number === block.number) { headers.set(number, block.hash); return; }
    const value = await lifecycleRpc(options.client, "eth_getBlockByNumber", [toHex(number), false]);
    const hash = value === null ? undefined : rpcHex(rpcObject(value, "receipt canonical block").hash, "receipt canonical hash");
    if (hash !== undefined && hash.length !== 66) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Receipt canonical block hash must have 32 bytes");
    headers.set(number, hash);
  }));
  return observations.map((observation) => observation.finish(headers));
}

/** Reads confirmation-bound canonical state and receipt provenance; local step counters are never used. */
export async function readLaunchProgress(options: ReadLaunchProgressOptions, pinnedBlock?: LifecycleBlock): Promise<CanonicalLaunchProgress> {
  if (options.signal?.aborted) throw Object.assign(new Error("Lifecycle progress read cancelled"), { name: "AbortError" });
  const planHash = options.planned.planHash, launchId = options.planned.launchId;
  const result = await withLifecycleReadClient(options.client, async (client) =>
    readLaunchProgressAtBlock(options, client, pinnedBlock ?? await readLifecycleBlock(client)));
  if (hashLaunchPlan(options.planned.plan) !== planHash || hashLaunchIdentity(options.planned.plan) !== launchId) throw new LifecyclePlanningError("PLAN_MUTATED", "Economic plan changed during the final canonical progress guard");
  if (options.signal?.aborted) throw Object.assign(new Error("Lifecycle progress read cancelled"), { name: "AbortError" });
  return result;
}

/** Build-next needs the state machine, receipts and nonce, not display-only live markets. */
export async function readLifecycleExecutionProgress(options: ReadLaunchProgressOptions, block: LifecycleBlock): Promise<CanonicalLaunchProgress> {
  if (!assertLifecycleReadClientOpen(options.client)) throw new LifecyclePlanningError("INVALID_READ_CONTEXT", "Execution progress requires an invocation owner");
  return readLaunchProgressAtBlock(options, options.client, block, false);
}

async function readLaunchProgressAtBlock(options: ReadLaunchProgressOptions, client: LifecycleRpcClient, block: LifecycleBlock, readMarkets = true): Promise<CanonicalLaunchProgress> {
  const { planned } = options;
  const assertActive = () => {
    if (options.signal?.aborted) throw Object.assign(new Error("Lifecycle progress read cancelled"), { name: "AbortError" });
  };
  assertActive();
  const confirmationDepth = options.confirmations ?? planned.confirmations;
  if (!Number.isSafeInteger(confirmationDepth) || confirmationDepth < 1) throw new LifecyclePlanningError("INVALID_CONFIRMATIONS", "Confirmation depth must be a positive integer");
  const confirmedNumber = block.number >= BigInt(confirmationDepth - 1) ? block.number - BigInt(confirmationDepth - 1) : 0n;
  const [confirmedBlock, chainIdValue] = await Promise.all([
    confirmedNumber === block.number ? block : readLifecycleBlock(client, toHex(confirmedNumber)),
    readLifecycleChainId(client),
  ]);
  assertActive();
  const chainId = chainIdValue;
  if (chainId !== planned.plan.chainId) throw new LifecyclePlanningError("CHAIN_MISMATCH", "RPC chain differs from the committed launch");
  if (planned.ufg !== undefined) {
    assertUfgLaunchAccount(planned.plan, planned.account);
    if (hashUfgLaunchConfig(planned.ufg.config) !== planned.ufg.configHash) throw new LifecyclePlanningError("PLAN_MUTATED", "UFG config differs from its finalized commitment");
  } else if (planned.account.toLowerCase() !== planned.plan.creator.toLowerCase()) throw new LifecyclePlanningError("ACCOUNT_MISMATCH", "Execution account must be the committed creator/payer/refund account");
  if (hashLaunchPlan(planned.plan).toLowerCase() !== planned.planHash.toLowerCase() || hashLaunchIdentity(planned.plan).toLowerCase() !== planned.launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Stored economic plan no longer matches its commitment");
  const [head, confirmedProgress, token, confirmedNonce, headNonce, pendingNonce] = await Promise.all([
    readLifecycleHeadProgress(client, planned.plan, planned.account, block),
    confirmedNumber === block.number ? undefined : readLifecycleContract<LaunchProgressV1>(client, planned.plan.orchestrator, launchLifecycleAbi, "readLaunchProgress", [planned.launchId], confirmedBlock, planned.account),
    readLifecycleTokenAtBlock(client, planned.plan, block),
    lifecycleRpc(client, "eth_getTransactionCount", [planned.account, toHex(confirmedBlock.number)]),
    confirmedNumber === block.number ? undefined : lifecycleRpc(client, "eth_getTransactionCount", [planned.account, toHex(block.number)]),
    lifecycleRpc(client, "eth_getTransactionCount", [planned.account, "pending"]),
  ]);
  assertActive();
  const canonical = confirmedProgress ?? head;
  if (token.toLowerCase() !== planned.predictedToken.toLowerCase()) throw new LifecyclePlanningError("TOKEN_IDENTITY", "Predicted token changed for the committed token configuration");
  for (const progress of [canonical, head]) if (progress.phase !== LifecyclePhase.None) {
    if (progress.planHash.toLowerCase() !== planned.planHash.toLowerCase() || progress.launchId.toLowerCase() !== planned.launchId.toLowerCase() || progress.creator.toLowerCase() !== planned.plan.creator.toLowerCase() || progress.nonce !== planned.plan.nonce || progress.token.toLowerCase() !== token.toLowerCase() || progress.marketCount !== planned.plan.markets.length || progress.buyCount !== planned.plan.buys.length || progress.deadline !== planned.plan.deadline) throw new LifecyclePlanningError("PLAN_REPLAY", "This creator nonce is already bound to a different economic launch");
    if (progress.mode !== (planned.mode === "atomic" ? LifecycleMode.Atomic : LifecycleMode.Staged)) throw new LifecyclePlanningError("MODE_MISMATCH", "Execution mode differs from the already recorded launch");
    if (progress.preparedMarkets > progress.marketCount || progress.phase === LifecyclePhase.Activating || (progress.phase === LifecyclePhase.Ready && progress.preparedMarkets !== progress.marketCount)) throw new LifecyclePlanningError("INVALID_PROGRESS", "Canonical progress violates the committed ordered state machine");
  }
  if (planned.ufg !== undefined && head.phase !== LifecyclePhase.None) {
    const [principal, configHash] = await Promise.all([
      readLifecycleContract<Address>(client, UFG_LAUNCH_PROXY_ADDRESS, ufgLaunchProxyV1Abi, "principalOf", [planned.launchId], block),
      readLifecycleContract<Hash>(client, UFG_LAUNCH_PROXY_ADDRESS, ufgLaunchProxyV1Abi, "launchConfigHash", [planned.launchId], block),
    ]);
    if (principal.toLowerCase() !== planned.account.toLowerCase() || configHash.toLowerCase() !== planned.ufg.configHash.toLowerCase()) throw new LifecyclePlanningError("PLAN_REPLAY", "UFG proxy principal or launch config differs from the stored launch");
  }
  const confirmedAccountNonce = rpcQuantity(confirmedNonce, "confirmed account nonce");
  const headAccountNonce = headNonce === undefined ? confirmedAccountNonce : rpcQuantity(headNonce, "head account nonce");
  const pendingAccountNonce = rpcQuantity(pendingNonce, "pending account nonce");
  const progressParameters = [{ type: "tuple", components: launchProgressV1Components }] as const;
  const confirmationSafe = confirmedAccountNonce === headAccountNonce && pendingAccountNonce === headAccountNonce && keccak256(encodeAbiParameters(progressParameters, [canonical])) === keccak256(encodeAbiParameters(progressParameters, [head]));
  const receipts = await readReceipts({ ...options, client }, block, confirmationDepth);
  assertActive();
  let markets: LifecycleMarketProgress[] = [];
  const lens = lifecycleLensSnapshot(client, confirmedBlock);
  if (readMarkets && lens !== undefined) {
    markets = lens.preparedMarkets.map((market) => {
      validateLifecycleMarketIdentity(market.prepared.identity, planned.plan, token, market.index);
      return { index: market.index, prepared: market.prepared,
        ...(market.liveStateSuccess ? { live: market.live } : { error: "Prepared market live-state read failed" }) };
    });
  } else if (readMarkets && canonical.preparedMarkets > 0) {
    const directory = await readLifecycleContract<Address>(client, planned.plan.orchestrator, launchLifecycleAbi, "directory", [], confirmedBlock);
    markets = await Promise.all(Array.from({ length: canonical.preparedMarkets }, async (_, index): Promise<LifecycleMarketProgress> => {
      const [adapter, prepared] = await readLifecycleContract<readonly [Address, PreparedMarketV1]>(client, directory, lifecycleDirectoryAbi, "market", [planned.launchId, index], confirmedBlock, undefined, false, true);
      validateLifecycleMarketIdentity(prepared.identity, planned.plan, token, index);
      try {
        const live = await readLifecycleContract<MarketLiveStateV1>(client, adapter, lifecycleAdapterAbi, "readMarket", [planned.launchId, index], confirmedBlock, undefined, false, true);
        return { index, prepared, live };
      } catch (failure) {
        if (failure instanceof Error && failure.name === "AbortError") throw failure;
        return { index, prepared, error: lifecycleFailureReason(failure) };
      }
    }));
  }
  if (hashLaunchPlan(planned.plan).toLowerCase() !== planned.planHash.toLowerCase() || hashLaunchIdentity(planned.plan).toLowerCase() !== planned.launchId.toLowerCase()) throw new LifecyclePlanningError("PLAN_MUTATED", "Stored economic plan changed during asynchronous progress reads");
  assertActive();
  return { canonical, head, confirmationDepth, confirmedBlockNumber: confirmedBlock.number, confirmedBlockHash: confirmedBlock.hash, confirmedAccountNonce, headAccountNonce, pendingAccountNonce, confirmationSafe, token, planHash: planned.planHash, launchId: planned.launchId, chainId, blockNumber: block.number, blockHash: block.hash, markets, receipts };
}
