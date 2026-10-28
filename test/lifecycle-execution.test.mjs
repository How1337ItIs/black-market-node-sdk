import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, stringToHex, toHex, zeroAddress, zeroHash } from "viem";
import { MULTICALL3, MULTICALL3_CODE, emulateMulticall3 } from "./fixtures/multicall3.mjs";

const sdkPath = process.env.SDK_SOURCE_TEST === "1" ? "../src/lifecycle/index.ts" : "../dist/lifecycle/index.js";
const { ABYSS_LIFECYCLE_CONFIG_SCHEMA, abyssLifecycleAdapterAbi, buildNextTransaction, createLifecycleSessionCache, decodeAbyssLifecycleMarketConfig, encodeAbyssLifecycleMarketConfig, fixedFeePoolHookV1Abi, getKnownLifecycleDeployment, getKnownLifecycleProfile, hashLaunchIdentity, hashLaunchPlan, KnownLifecycleProfile, launchLifecycleAbi, lifecycleAdapterAbi, lifecycleDirectoryAbi, lifecycleErc20Abi, lifecycleFundingEscrowAbi, lifecycleRegistryAbi, LifecyclePhase, LIFECYCLE_REQUIRED_CAPABILITIES, LIFECYCLE_MULTI_POSITION_CAPABILITY, planLaunch, prepareAndPlanLifecycleLaunch, readLifecycleProfiles, simulateLaunchPlan } = await import(sdkPath);
const { prepareLaunchSimulation, simulateLaunchTransactions } = await import(sdkPath.replace("index.", "simulation."));
const { readLifecycleBlock, withLifecycleReadClient } = await import(sdkPath.replace("index.", "rpc."));
const { ABYSS_FEE_TIERS, deriveLaunchPoolRecipe, deriveLaunchPositionRanges } = await import(sdkPath.replace("lifecycle/index.", "index."));
const { decodePoolBoundV4LifecycleMarketConfig, defaultHmmLaunchConfig, encodePoolBoundV4LifecycleMarketConfig } = await import(sdkPath);
const { buildUfgFeeAssetPolicies, UFG_LAUNCH_PROXY_ADDRESS, UFG_ORCHESTRATOR_ADDRESS, ufgLaunchNonce, ufgLaunchProxyV1Abi, hashUfgLaunchConfig, readLaunchProgress } = await import(sdkPath);
const { hookSaltMinerAbi, minePoolBoundHookSalt } = await import(sdkPath);
const address = (n) => toHex(BigInt(n), { size: 20 });
const ACCOUNT = address(0xa0), CORE = address(0xf0), REGISTRY = address(0xf1), ESCROW = address(0xf2), ADAPTER = address(0xf3), FACTORY = address(0xf4), TOKEN = address(0x10);
const CODE = "0x600160005560016000f3";
const HASH = toHex(42n, { size: 32 }), FOREIGN_HASH = toHex(43n, { size: 32 }), DIGEST = keccak256(CODE);
const diagnosticJson = (value) => JSON.stringify(value, (_key, field) => typeof field === "bigint" ? field.toString() : field);
const ARB_SYS = address(0x64), GAS_INFO = address(0x6c), NODE_INTERFACE = address(0xc8);
const arbSysAbi = parseAbi(["function arbOSVersion() view returns (uint256)"]);
const gasInfoAbi = parseAbi(["function getMaxTxGasLimit() view returns (uint256)", "function getMaxBlockGasLimit() view returns (uint64)"]);
const nodeInterfaceAbi = parseAbi(["function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);

// ABI-complete injected RPC observations exercise public SDK consumers. These are
// offline behavioral fixtures, not live Nitro execution or deployment evidence.
function makePlan({ chainId = 31337n, markets = 1, nativeFunding = false, token0 = true } = {}) {
  const profileId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint8" }], [keccak256(stringToHex("BLACK_MARKET_ABYSS_CANONICAL_PROFILE_V1")), chainId, FACTORY, 3]));
  const quotes = Array.from({ length: markets }, (_, index) => address((token0 ? 0x20 : 0x05) + index));
  return {
    chainId, orchestrator: CORE, creator: ACCOUNT, nonce: 7n,
    token: { kind: 0, rewardMode: 0, name: "Admission", symbol: "ADM", supply: 100n * BigInt(markets), nftUnit: 0n, metadataURI: "", salt: toHex(7n, { size: 32 }), inventoryRecipient: ACCOUNT, burnOnCancel: false },
    funding: quotes.map((asset) => ({ asset, amount: 10n, kind: nativeFunding ? 1 : 0, inputAsset: asset, inputAmount: 10n, target: zeroAddress, data: "0x" })),
    feeAssets: [TOKEN, ...quotes].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1).map((asset) => ({ asset, ownerBps: 10000, rewardsBps: 0, burnBps: 0 })),
    markets: quotes.map((quoteAsset) => ({ adapterId: toHex(1n, { size: 32 }), profileId, quoteAsset, tokenBudget: 100n, configVersion: 1,
      config: encodeAbyssLifecycleMarketConfig({ profile: 3, fee: 3000, oracleConfigId: toHex(9n, { size: 32 }), openingSqrtPriceX96: 1n << 96n,
        positions: [{ tickLower: token0 ? 0 : -887220, tickUpper: token0 ? 887220 : 0, liquidity: 1n, tokenAmountMaximum: 100n }] }) })),
    buys: quotes.map((_, marketIndex) => ({ marketIndex, quoteAmountIn: 10n, minTokenOut: 5n, recipient: ACCOUNT, sqrtPriceLimitX96: (1n << 96n) - 1n })),
    deadline: 1000n, executorFeeBps: 0,
  };
}
function makeHmmPlan(markets = 1, dynamicFirst = false) {
  const plan = makePlan({ chainId: 4663n, markets });
  plan.orchestrator = "0x91560876033d568d25CDe98C78c33ff8FC43962c";
  plan.token.supply = 1_000_000n * BigInt(markets);
  plan.funding = [];
  plan.buys = [];
  plan.markets = plan.markets.map((market, index) => {
    const preset = getKnownLifecycleProfile({ ...plan, key: (index + Number(dynamicFirst)) % 2 === 0 ? KnownLifecycleProfile.V4HmmFixedPool : KnownLifecycleProfile.V4HmmDynamicPool });
    const envelope = preset.profile.envelope;
    return { ...market, adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, tokenBudget: 1_000_000n, configVersion: 6,
      config: encodePoolBoundV4LifecycleMarketConfig({ version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: 1n << 96n,
        hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321, feeMode: 0,
        protocolFeeDenominator: envelope.protocolFeeDenominator, treasury: envelope.protocolTreasury, externalLiquidityDisabled: false,
        oracleConfigId: toHex(9n, { size: 32 }), profileId: preset.profile.id, termsDigest: envelope.termsDigest,
        developerBeneficiary: envelope.beneficiary, developerFeeBps: 0, hookSalt: zeroHash,
        positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1n, salt: zeroHash, maxTokenAmount: 1_000_000n }],
        hmmLaunchConfig: defaultHmmLaunchConfig({ tokenBudget: 1_000_000n, quoteAsset: "USDG", maxBidQuote: 1_000_000n, referenceDeviation: 0 }) }) };
  });
  return plan;
}
function marketConfig(market) {
  return market.configVersion === 1 ? decodeAbyssLifecycleMarketConfig(market.config) : decodePoolBoundV4LifecycleMarketConfig(market.config, market.configVersion);
}
function progress(plan, phase = LifecyclePhase.None, prepared = 0) {
  if (phase === LifecyclePhase.None) return { launchId: zeroHash, planHash: zeroHash, creator: zeroAddress, nonce: 0n, mode: 0, phase, token: zeroAddress, feeHub: zeroAddress, rewards: zeroAddress, preparedMarkets: 0, marketCount: 0, buyCount: 0, positionCount: 0, deadline: 0n };
  return { launchId: hashLaunchIdentity(plan), planHash: hashLaunchPlan(plan), creator: plan.creator, nonce: plan.nonce, mode: 1, phase, token: TOKEN, feeHub: address(0xf6), rewards: zeroAddress, preparedMarkets: prepared, marketCount: plan.markets.length, buyCount: plan.buys.length, positionCount: prepared, deadline: plan.deadline };
}
function identity(plan, index) {
  const [currency0, currency1] = BigInt(TOKEN) < BigInt(plan.markets[index].quoteAsset)
    ? [TOKEN, plan.markets[index].quoteAsset] : [plan.markets[index].quoteAsset, TOKEN];
  const config = marketConfig(plan.markets[index]);
  const fields = { venue: 1, manager: zeroAddress, factory: FACTORY, pool: address(0x100 + index), poolId: zeroHash, profileId: plan.markets[index].profileId, currency0, currency1, fee: config.fee ?? config.lpFeePips, tickSpacing: config.tickSpacing ?? ABYSS_FEE_TIERS.find(({ feePips }) => feePips === config.fee).tickSpacing, hook: zeroAddress, openingSqrtPriceX96: config.openingSqrtPriceX96 ?? config.sqrtPriceX96 };
  const canonicalId = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [plan.chainId, fields.venue, fields.manager, fields.factory, fields.pool, fields.poolId, fields.profileId]));
  return { ...fields, canonicalId };
}
function event(name, args) {
  const inputs = launchLifecycleAbi.find((entry) => entry.type === "event" && entry.name === name).inputs;
  return { address: CORE, topics: encodeEventTopics({ abi: launchLifecycleAbi, eventName: name, args }), data: encodeAbiParameters(inputs.filter((input) => !input.indexed), inputs.filter((input) => !input.indexed).map((input) => args[input.name])) };
}
function clientFor(plan, settings = {}) {
  const known = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator });
  const CORE = plan.orchestrator.toLowerCase(), ESCROW = known?.fundingEscrow.toLowerCase() ?? address(0xf2);
  const log = (name, args) => ({ ...event(name, args), address: CORE });
  const state = { balance: 10n ** 24n, allowance: 10n, phase: LifecyclePhase.None, txCompute: 32_000_000n, blockCompute: 32_000_000n, rawVersion: 105n, poster: 0n, gasPrice: 2n, ...settings };
  const captured = [];
  let reorged = false, chainShifted = false;
  const capabilities = LIFECYCLE_REQUIRED_CAPABILITIES | LIFECYCLE_MULTI_POSITION_CAPABILITY;
  const registration = { adapterId: plan.markets[0].adapterId, configSchema: ABYSS_LIFECYCLE_CONFIG_SCHEMA, dependencyDigest: DIGEST, venue: FACTORY, factory: FACTORY, hook: zeroAddress, capabilities, enabled: true };
  const adapterRegistration = { implementation: ADAPTER, codeHash: DIGEST, capabilities, configVersion: 1, enabled: true };
  const decode = (data, abi) => decodeFunctionData({ abi, data });
  const output = (abi, functionName, result) => encodeFunctionResult({ abi, functionName, result });
  const client = { state, captured, async request({ method, params = [], fixtureSubcall = false }) {
    if (!fixtureSubcall) captured.push({ method, params });
    if (method === "eth_getCode" && params[0].toLowerCase() === MULTICALL3) return state.multicallCode ?? MULTICALL3_CODE;
    if (method === "eth_call" && params[0].to.toLowerCase() === MULTICALL3) return emulateMulticall3(client, params);
    if (["eth_sendTransaction", "eth_sendRawTransaction", "evm_snapshot", "anvil_reset"].includes(method)) assert.fail("Source and submission admission must remain read-only");
    if (method === "eth_chainId") return toHex(chainShifted ? plan.chainId + 1n : plan.chainId);
    if (method === "eth_getBlockByNumber") {
      const number = params[0] === "latest" ? state.latestNumbers?.shift() ?? state.headNumber ?? 42n : BigInt(params[0]);
      if (state.allowedTags !== undefined && params[0] === "latest") state.simulationPin = toHex(number);
      return { number: toHex(number), hash: reorged ? FOREIGN_HASH : number === 42n ? state.blockHash ?? HASH : toHex(number, { size: 32 }),
        timestamp: toHex(100n + number - 42n), gasLimit: toHex(state.headerGas ?? (plan.chainId === 4663n ? 1n << 50n : 30_000_000n)), baseFeePerGas: toHex(state.baseFeePerGas ?? state.gasPrice / 2n) };
    }
    if (method === "eth_getCode") return typeof state.codeFor === "function" ? state.codeFor(params[0]) : params[0].toLowerCase() === ACCOUNT.toLowerCase() ? state.accountCode ?? "0x" : CODE;
    if (method === "eth_getBalance") return toHex(state.balance);
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_gasPrice") return toHex(state.gasPrice);
    if (method === "eth_call") {
      assert.ok((state.allowedTags ?? ["0x2a"]).includes(params[1]), "All authority and fee reads must stay at an exact owned pin");
      const { to, data } = params[0];
      const target = to.toLowerCase();
      if (known && target === known.tokenFactory.toLowerCase()) return encodeAbiParameters([{ type: "address" }], [TOKEN]);
      if (known?.hookSaltMiner !== undefined && target === known.hookSaltMiner.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: hookSaltMinerAbi, data });
        const mined = await Promise.all(args[0].map((search) => minePoolBoundHookSalt(search)));
        return output(hookSaltMinerAbi, "findMany", [mined.map((result) => result.salt), mined.map((result) => result.predictedHook), mined.map(() => true)]);
      }
      if (target === ARB_SYS) {
        if (state.getterFailure) throw new Error("Historical ArbOS state unavailable");
        return state.versionResponse ?? output(arbSysAbi, "arbOSVersion", state.rawVersion);
      }
      if (target === GAS_INFO) {
        const call = decode(data, gasInfoAbi);
        return state.getterResponse ?? output(gasInfoAbi, call.functionName, call.functionName === "getMaxTxGasLimit" ? state.txCompute : state.blockCompute);
      }
      if (target === NODE_INTERFACE) {
        const call = decode(data, nodeInterfaceAbi);
        assert.equal(call.args[1], false);
        if (state.posterError) throw state.posterError;
        state.posterRequests ??= [];
        state.posterRequests.push({ request: params[0], args: call.args });
        return state.posterResponse ?? output(nodeInterfaceAbi, "gasEstimateL1Component", [state.poster, state.gasPrice, state.poster === 0n ? 0n : 3n]);
      }
      const abis = target === UFG_LAUNCH_PROXY_ADDRESS.toLowerCase() ? [ufgLaunchProxyV1Abi] : target === CORE ? [launchLifecycleAbi] : target === REGISTRY ? [lifecycleRegistryAbi] : target === address(0xf7) ? [lifecycleDirectoryAbi] : target === ESCROW ? [lifecycleFundingEscrowAbi] : target === ADAPTER ? [abyssLifecycleAdapterAbi, lifecycleAdapterAbi] : [lifecycleErc20Abi];
      let abi, call;
      for (const candidate of abis) { try { call = decode(data, candidate); abi = candidate; break; } catch {} }
      assert.ok(call, `Unexpected contract calldata ${target} ${data.slice(0, 10)}`);
      switch (call.functionName) {
        case "hashPlan": return output(abi, call.functionName, hashLaunchPlan(plan));
        case "launchIdOf": return output(abi, call.functionName, hashLaunchIdentity(plan));
        case "predictToken": return output(abi, call.functionName, TOKEN);
        case "principalOf": return output(abi, call.functionName, state.ufgPrincipal ?? ACCOUNT);
        case "launchConfigHash": return output(abi, call.functionName, state.ufgConfigHash ?? hashUfgLaunchConfig(ufgConfigFor(plan)));
        case "tokenFactory": return output(abi, call.functionName, ADAPTER);
        case "fundingEscrow": return output(abi, call.functionName, ESCROW);
        case "registry": return output(abi, call.functionName, REGISTRY);
        case "core": return output(abi, call.functionName, state.authorities?.[target] ?? CORE);
        case "readLaunchProgress": return output(abi, call.functionName, progress(plan, state.phase, state.prepared ?? 0));
        case "directory": return output(abi, call.functionName, address(0xf7));
        case "market": return output(abi, call.functionName, [ADAPTER, { identity: identity(plan, call.args[1]), feeSource: address(0xf6),
          custody: address(0xf8), mintExecutor: ADAPTER, buyExecutor: ADAPTER, exclusions: [], positionCount: 1 }]);
        case "readMarket": return output(abi, call.functionName, { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1n, publicTrading: false, oracleReadyAt: 0n });
        case "wrappedNative": return output(abi, call.functionName, plan.markets[0].quoteAsset);
        case "balanceOf": return output(abi, call.functionName, state.tokenBalance ?? 1000n);
        case "allowance": return output(abi, call.functionName, state.allowance);
        case "profile": return output(abi, call.functionName, { ...registration, ...state.profileOverrides });
        case "adapter": return output(abi, call.functionName, { ...adapterRegistration, ...state.adapterOverrides });
        case "profileTopology": return output(abi, call.functionName, { hookTopology: 0, configVersion: 1, hookDeployer: zeroAddress, hookCreationCodeHash: zeroHash });
        case "protocolMaximumDeveloperFeeBps":
          if (state.developerCapUnavailable) throw new Error("V4 developer-fee limits unavailable");
          return output(abi, call.functionName, 1000);
        case "fundingTarget": return output(abi, call.functionName, [address(0xfb), DIGEST, true]);
        case "fundingInputAllowed": return output(abi, call.functionName, true);
        case "requireEligible": {
          // LaunchImplementationRegistryV2.sol:285-296 checks these inside the
          // pinned on-chain call, not through separate client-side RPC probes.
          const approvedAdapter = { ...adapterRegistration, ...state.adapterOverrides };
          const approvedProfile = { ...registration, ...state.profileOverrides };
          const implementationCode = typeof state.codeFor === "function" ? state.codeFor(approvedAdapter.implementation) : CODE;
          if (!approvedAdapter.enabled || !approvedProfile.enabled || approvedProfile.adapterId.toLowerCase() !== call.args[0].toLowerCase() ||
            approvedAdapter.configVersion !== call.args[2] || implementationCode === "0x" || keccak256(implementationCode).toLowerCase() !== approvedAdapter.codeHash.toLowerCase() ||
            (approvedAdapter.capabilities & call.args[3]) !== call.args[3] || (approvedProfile.capabilities & call.args[3]) !== call.args[3] ||
            (state.authorities?.[approvedAdapter.implementation.toLowerCase()] ?? CORE).toLowerCase() !== CORE ||
            (state.graphDigest ?? DIGEST).toLowerCase() !== approvedProfile.dependencyDigest.toLowerCase()) throw new Error("IneligibleImplementation");
          return output(abi, call.functionName, approvedAdapter.implementation);
        }
        case "resolve": return output(abi, call.functionName, identity(plan, plan.markets.findIndex((market) => market.quoteAsset.toLowerCase() === call.args[2].quoteAsset.toLowerCase())));
        case "escrowBalance": return output(abi, call.functionName, 1000n);
        default: assert.fail(`Unexpected read ${call.functionName}`);
      }
    }
    if (method === "eth_simulateV1") {
      assert.equal(params[1], state.simulationPin ?? "0x2a");
      const request = params[0];
      if (request.blockStateCalls[0].calls[0].to === ARB_SYS) {
        assert.equal(request.validation, true);
        assert.equal(request.blockStateCalls.length, 1);
        assert.equal(request.blockStateCalls[0].calls.length, 3);
        assert.equal(BigInt(request.blockStateCalls[0].stateOverrides[ACCOUNT].balance), (1n << 256n) - 1n);
        if (state.probeError) throw state.probeError;
        if (state.probeFailure) throw new Error("Generic EVM lacks ArbOS metering");
        const values = [state.rawVersion, state.txCompute, state.blockCompute];
        return [{ calls: values.map((value, index) => ({ status: state.probeRevert ? "0x0" : "0x1", gasUsed: "0x5208", returnData: state.probeResponse ?? toHex(value + (state.probeMismatch === index ? 1n : 0n), { size: 32 }) })) }];
      }
      assert.ok(request.blockStateCalls.every((block) => block.stateOverrides === undefined), "Capability probe balance must never leak into actual execution proof");
      if (state.simulationUnavailable) throw new Error("Native sequential simulation unsupported");
      if (request.validation && state.replayThrow) throw Object.assign(new Error("execution failed"), { code: -32000 });
      let phase = state.phase, prepared = state.prepared ?? 0, allowance = state.allowance, stopped = false, nativeBalance = state.balance;
      const blocks = request.blockStateCalls.map((block) => {
        if (stopped) return { calls: [{ status: "0x0", gasUsed: "0x0", returnData: "0x", error: { message: "Prior dependent execution failed", data: state.downstreamFailureData } }] };
        assert.equal(block.calls.length, 1, "Actual dependent state is carried between ordered blocks");
        assert.equal(block.blockOverrides.baseFeePerGas, undefined, "Exact execution cannot fabricate fee-bearing block state");
        const tx = block.calls[0];
        if (state.enforceUpfrontBalance && BigInt(tx.value) + BigInt(tx.gas) * BigInt(tx.gasPrice) > nativeBalance) {
          throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: -38014 });
        }
        // Independent fee-bearing refusal: recommendations are advisory, but
        // this natural child fee is an actual native validation requirement.
        if (request.validation && BigInt(tx.gasPrice) < (state.childBaseFee ?? state.baseFeePerGas ?? state.gasPrice / 2n)) {
          stopped = true;
          return { calls: [{ status: "0x0", gasUsed: "0x0", returnData: "0x",
            error: { code: -32000, message: "gas price below natural child base fee", data: "0x" } }] };
        }
        const abi = tx.to.toLowerCase() === UFG_LAUNCH_PROXY_ADDRESS.toLowerCase() ? ufgLaunchProxyV1Abi : tx.to.toLowerCase() === CORE ? launchLifecycleAbi : lifecycleErc20Abi;
        const { functionName, args = [] } = decode(tx.data, abi);
        const used = typeof state.gasFor === "function" ? state.gasFor(functionName, args, request.validation, tx) : state.computeUsed ?? 1_000_000n;
        const fullUsed = used + (request.validation && plan.chainId === 4663n ? state.actualPoster ?? state.poster : 0n);
        const requiredEnvelope = fullUsed + (!request.validation && plan.chainId === 4663n && state.measurementPosterHold ? state.actualPoster ?? state.poster : 0n);
        const gas = BigInt(tx.gas);
        const failure = state.failureFor?.(functionName, args, request.validation, tx);
        if (failure !== undefined) {
          stopped = true;
          return { calls: [{ status: "0x0", gasUsed: toHex(failure.gasUsed ?? fullUsed), returnData: failure.returnData ?? "0x", error: failure.error }] };
        }
        const exhausted = requiredEnvelope > gas || plan.chainId === 4663n && used > (state.txCompute < state.blockCompute ? state.txCompute : state.blockCompute);
        if (state.replayFail && request.validation || state.prepareFailureData && functionName === "prepareMarkets" ||
          state.failActivation && ["launchAtomic", "activateLaunch"].includes(functionName) || exhausted) {
          stopped = true;
          const explicitRefusal = state.replayFail && request.validation || state.prepareFailureData && functionName === "prepareMarkets" ||
            state.failActivation && ["launchAtomic", "activateLaunch"].includes(functionName);
          return { calls: [{ status: "0x0", gasUsed: toHex(requiredEnvelope > gas ? gas : fullUsed),
            returnData: explicitRefusal ? functionName === "prepareMarkets" ? state.prepareFailureData ?? "0xdead" : "0xdead" : "0x",
            error: explicitRefusal ? { message: "Committed execution reverted" } : { code: state.nativeGasCode ?? -32015, message: "out of gas", data: "0x" } }] };
        }
        const executingPlan = args[0] ?? plan;
        if (["beginLaunch", "launchAtomic"].includes(functionName)) {
          const totals = new Map();
          for (const funding of executingPlan.funding) if (funding.kind === 0 || funding.kind === 2 && funding.inputAsset !== zeroAddress) {
            const key = funding.inputAsset.toLowerCase();
            totals.set(key, (totals.get(key) ?? 0n) + funding.inputAmount);
          }
          if ([...totals.values()].some((amount) => amount > (state.tokenBalance ?? 1000n))) {
            stopped = true;
            return { calls: [{ status: "0x0", gasUsed: toHex(fullUsed), returnData: "0x",
              error: { code: 3, message: "Committed funding transfer reverted", data: encodeErrorResult({ abi: parseAbi(["error InvalidFunding()"]), errorName: "InvalidFunding" }) } }] };
          }
        }
        let returnData = "0x", logs = [];
        if (functionName === "approve") { allowance = args[1]; returnData = output(abi, functionName, true); }
        else if (functionName === "beginLaunch") { assert.equal(phase, LifecyclePhase.None); assert.ok(executingPlan.funding.length === 0 || allowance >= 10n || plan.funding[0].kind === 1); phase = LifecyclePhase.Preparing; returnData = output(launchLifecycleAbi, functionName, progress(executingPlan, phase)); }
        else if (functionName === "prepareMarkets") {
          assert.equal(phase, LifecyclePhase.Preparing); assert.equal(args[1], prepared);
          for (let index = args[1]; index < args[1] + args[2]; index++) logs.push(log("MarketPrepared", { launchId: hashLaunchIdentity(executingPlan), marketIndex: index, canonicalId: identity(executingPlan, index).canonicalId, adapter: ADAPTER, feeSource: address(0xf6), positionCount: marketConfig(executingPlan.markets[index]).positions.length }));
          prepared += args[2]; if (prepared === plan.markets.length) phase = LifecyclePhase.Ready;
        } else if (["launchAtomic", "activateLaunch"].includes(functionName)) {
          if (functionName === "activateLaunch") { assert.equal(phase, LifecyclePhase.Ready); assert.equal(prepared, plan.markets.length); }
          else { assert.equal(phase, LifecyclePhase.None); assert.ok(executingPlan.funding.length === 0 || allowance >= 10n || plan.funding[0].kind === 1); }
          phase = LifecyclePhase.Active;
          const positionCount = executingPlan.markets.reduce((total, market) => total + marketConfig(market).positions.length, 0);
          const receiptPositions = state.receiptPositionCount ?? positionCount;
          const tokenOut = typeof state.tokenOut === "function" ? state.tokenOut(executingPlan, request.validation) : executingPlan.buys.map(() => state.badOutput ? 4n : 7n);
          const quoteSpent = state.quoteSpent ?? executingPlan.buys.map(() => 8n);
          returnData = output(launchLifecycleAbi, functionName, { launchId: hashLaunchIdentity(executingPlan), planHash: hashLaunchPlan(executingPlan), token: TOKEN, feeHub: address(0xf6), rewards: zeroAddress, marketCount: executingPlan.markets.length, positionCount: receiptPositions, quoteSpent, tokenOut });
          logs = [log("LaunchActivated", { launchId: hashLaunchIdentity(executingPlan), planHash: hashLaunchPlan(executingPlan), token: TOKEN, marketCount: state.eventMarketCount ?? executingPlan.markets.length, positionCount: state.eventPositionCount ?? positionCount })];
        } else if (functionName === "cancelLaunch") { assert.ok([LifecyclePhase.Preparing, LifecyclePhase.Ready].includes(phase)); phase = LifecyclePhase.Cancelled; logs = [log("LaunchCancelled", { launchId: hashLaunchIdentity(plan), creator: plan.creator, inventoryBurned: false })]; }
        else assert.fail(`Unexpected execution ${functionName}`);
        if (state.enforceUpfrontBalance) nativeBalance -= BigInt(tx.value) + fullUsed * BigInt(tx.gasPrice);
        return { calls: [{ status: "0x1", gasUsed: toHex(fullUsed), maxUsedGas: state.maxUsedGas === null ? undefined : toHex(state.maxUsedGas ?? fullUsed), returnData, logs }] };
      });
      if (state.reorg && request.validation) reorged = true;
      if (state.sourceChainDrift && request.validation) chainShifted = true;
      return state.incompleteReplay && request.validation ? blocks.slice(0, -1) : blocks;
    }
    assert.fail(`Unexpected RPC method ${method}`);
  } };
  return client;
}

test("lagging RPC fee recommendations cannot authorize an underpriced launch envelope", async () => {
  const plan = makePlan();
  const client = clientFor(plan, { gasPrice: 2n, baseFeePerGas: 5n });
  const planned = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(planned.simulation.admitted, true);
  for (const transaction of planned.transactions.slice(0, 1)) {
    assert.equal(transaction.gasPrice, 10n);
    assert.equal(transaction.estimate.executionFee, transaction.gas * 10n);
  }
  const replayed = client.captured.filter((call) => call.method === "eth_simulateV1")
    .flatMap((call) => call.params[0].blockStateCalls)
    .flatMap((block) => block.calls);
  assert.ok(replayed.every((call) => BigInt(call.gasPrice) === 10n));
});
const review = (client, plan, extra = {}) => planLaunch({ client, plan, account: ACCOUNT, mode: "atomic", ...extra });
const economicRequests = (client) => client.captured.filter((row) => row.method === "eth_simulateV1" && row.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS);
const capabilityRequests = (client) => client.captured.filter((row) => row.method === "eth_simulateV1" && row.params[0].blockStateCalls[0].calls[0].to === ARB_SYS);

test("a vanilla Abyss launch does not depend on V4 fee metadata or weaken native protocol proof", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  const planned = await review(clientFor(plan, { developerCapUnavailable: true }), plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.equal(planned.simulation.executionProof, "proved");
  assert.equal(planned.simulation.limits.protocol, "nitro");
  assert.equal(planned.profiles[0].venueKind, "abyss");
  assert.deepEqual(planned.transactions.map((transaction) => transaction.kind), ["atomic"]);
  await assert.rejects(review(clientFor(plan, {
    developerCapUnavailable: true,
    authorities: { [ADAPTER.toLowerCase()]: address(0xbad) },
  }), plan), { code: "TOKEN_FACTORY_BINDING" });
});

test("missing optional policy admits the exact approval/launch sequence without certifying unknown caps", async () => {
  const plan = makePlan(), client = clientFor(plan, { allowance: 0n });
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.equal(planned.simulation.executionProof, "proved"); assert.equal(planned.simulation.protocolFit, "proved"); assert.equal(planned.simulation.transportPreflight, "not-requested");
  assert.deepEqual(planned.transactions.map((tx) => tx.kind), ["approve", "atomic"]);
  assert.equal(planned.transactions[0].estimate.gasLimit, 1_150_000n);
  assert.equal(planned.transactions[0].estimate.dataFeeIncludedInGas, false);
  assert.equal(planned.transactions[0].estimate.totalFee, undefined);
  assert.equal(planned.transactions[1].estimate, undefined);
  assert.equal(planned.simulation.steps[1].provisional, true);
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.kind, "approve"); assert.equal(next.admission.blockHash, HASH); assert.equal(next.admission.transportPreflight, "not-requested");
});

test("continuing build-next owns one fresh progress snapshot and never reuses completed review authority", async () => {
  const plan = makePlan({ chainId: 4663n }), source = clientFor(plan, { allowance: 0n });
  const planned = await review(source, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  const client = { supportsReadBatching: true, request: (args) => source.request(args) };
  for (const { allowance, gasPrice, kind } of [
    { allowance: 0n, gasPrice: 3n, kind: "approve" },
    { allowance: 10n, gasPrice: 7n, kind: "atomic" },
  ]) {
    source.state.allowance = allowance;
    source.state.gasPrice = gasPrice;
    source.captured.length = 0;
    const next = await buildNextTransaction({ client, planned });
    assert.equal(next.kind, kind);
    assert.equal(next.gasPrice, gasPrice, "Each build obtains fresh fees, not the completed review's envelope");
    assert.equal(source.captured.filter((row) => row.method === "eth_call" && row.params[0].to.toLowerCase() === MULTICALL3).length, 1, "Progress and prediction share the snapshot pin");
    assert.equal(source.captured.filter((row) => row.method === "eth_getBlockByNumber").length, 1);
    assert.equal(source.captured.filter((row) => row.method === "eth_getTransactionCount").length, 2, "Confirmed and pending nonce remain real fresh observations");
    assert.equal(capabilityRequests(source).length, kind === "approve" ? 1 : 0);
    assert.deepEqual(economicRequests(source).map((row) => row.params[0].validation), [true], "Each build simulates only its immediate command");
  }
});

test("build-next ignores caller progress and keeps nonce and receipt gates before economic planning", async () => {
  const plan = makePlan(), planned = await review(clientFor(plan), plan);
  const callerProgress = { ...planned.progress, confirmationSafe: true, receipts: [], pendingAccountNonce: 0n };
  for (const gate of ["nonce", "receipt"]) {
    const source = clientFor(plan);
    const client = { supportsReadBatching: true, request(args) {
      if (gate === "nonce" && args.method === "eth_getTransactionCount" && args.params[1] === "pending") return Promise.resolve("0x1");
      if (["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(args.method)) return Promise.resolve(null);
      return source.request(args);
    } };
    const receipts = gate === "receipt" ? [{ transactionHash: FOREIGN_HASH }] : [];
    await assert.rejects(buildNextTransaction({ client, planned: { ...planned, progress: callerProgress }, receipts }),
      { code: gate === "nonce" ? "UNCONFIRMED_STATE" : "RECEIPT_PENDING" });
    assert.equal(economicRequests(source).length, 0);
    assert.equal(source.captured.some((row) => row.method === "eth_call" && row.params[0].to === REGISTRY), false, "An unsafe canonical snapshot cannot start profile admission");
  }
});

test("private continuing build-next preserves stored commitment and deployment bindings", async () => {
  const plan = makePlan(), planned = await review(clientFor(plan), plan);
  for (const { change, code } of [
    { change: { planHash: FOREIGN_HASH }, code: "PLAN_MUTATED" },
    { change: { launchId: FOREIGN_HASH }, code: "PLAN_MUTATED" },
    { change: { predictedToken: address(1) }, code: "TOKEN_IDENTITY" },
    { change: { account: address(1) }, code: "ACCOUNT_MISMATCH" },
  ]) {
    const source = clientFor(plan), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned: { ...planned, ...change }, submissionClient }), { code });
    assert.equal(submissionClient.captured.length, 0, "Changed stored authority cannot even reach submission preflight");
  }
});

test("supplied caps only tighten and missing provenance is not a mandatory backend dependency", async () => {
  const plan = makePlan();
  const tightened = await review(clientFor(plan), plan, { limits: { rpcGasLimit: 1_100_000n } });
  assert.equal(tightened.simulation.admitted, true); assert.equal(tightened.transactions[0].gas, 1_100_000n, "Optional padding clamps to the supplied ceiling");
  const calldata = await review(clientFor(plan), plan, { limits: { maxCalldataBytes: 4 } });
  assert.equal(calldata.simulation.admitted, false); assert.match(calldata.simulation.reason, /calldata/);
  const known = await review(clientFor(plan), plan, { limits: { chainGasLimit: 2_000_000n, accountGasLimit: 2_000_000n, headroomBps: 0 } });
  assert.equal(known.simulation.admitted, true); assert.equal(known.transactions[0].gas, 1_000_000n);
});

test("malformed supplied policy and supplied context failures never become unknown optional policy", async () => {
  const plan = makePlan();
  for (const limits of [null, [], () => null, () => undefined, { rpcGasLimit: 16000000 }, { chainGasLimit: -1n }, { accountGasLimit: 1n << 64n }, { maxSimulationGas: "1" }, { maxCalldataBytes: 1.5 }, { headroomBps: true }, { headroomBps: null }, { headroomBps: 10001 }]) {
    await assert.rejects(review(clientFor(plan), plan, { limits }), { code: "INVALID_LIMITS" });
  }
  await assert.rejects(review(clientFor(plan), plan, { limits: async () => { throw new Error("Policy backend unavailable"); } }), { code: "LIMIT_SOURCE_FAILED" });
  for (const limits of [{ chainId: 1n }, { account: address(1) }, { orchestrator: address(1) }, { observedBlockNumber: 41n }, { observedBlockHash: FOREIGN_HASH }, { observedBlockHash: "0x" }]) {
    await assert.rejects(review(clientFor(plan), plan, { limits }), { code: "LIMIT_CONTEXT_MISMATCH" });
  }
  const current = ({ chainId, account, orchestrator, block }) => ({ chainId, account, orchestrator, observedBlockNumber: block.number, observedBlockHash: block.hash });
  assert.equal((await review(clientFor(plan), plan, { limits: current })).simulation.admitted, true);
});



test("prepared simulation refuses refreshed policy provenance and preserves the original source context", async () => {
  const plan = makePlan();
  for (const changed of [{ chainId: 1n }, { account: address(1) }, { orchestrator: address(1) }, { observedBlockNumber: 41n }, { observedBlockHash: FOREIGN_HASH }]) {
    const source = clientFor(plan);
    const client = { supportsReadBatching: true, request(args) {
      if (args.method === "eth_simulateV1") assert.fail("Mismatched policy cannot authorize native or economic execution");
      return source.request(args);
    } };
    let domainPolicy = true;
    const limits = async (context) => {
      assert.equal(context.client, client);
      assert.equal(context.account, ACCOUNT);
      assert.equal(context.orchestrator, CORE);
      assert.equal(context.chainId, plan.chainId);
      assert.equal(context.block.number, 42n);
      assert.equal(context.block.hash, HASH);
      const policy = domainPolicy ? {} : changed;
      domainPolicy = false;
      return policy;
    };
    await assert.rejects(review(client, plan, { limits }), { code: "LIMIT_CONTEXT_MISMATCH" });
  }
});

test("batch-prepared context retains smart-account refusal", async () => {
  for (const chainId of [31337n, 4663n]) {
    const plan = makePlan({ chainId });
    const client = clientFor(plan, { accountCode: CODE });
    client.supportsReadBatching = true;
    const planned = await review(client, plan);
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.confidence, "provisional");
    assert.equal(planned.simulation.executionProof, "unavailable");
    assert.match(planned.simulation.reason, /smart-account/);
  }
});

test("prepared native continuation reuses only positive capability while proving every whole candidate", async () => {
  for (const supportsReadBatching of [false, true]) {
    const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
    source.supportsReadBatching = supportsReadBatching;
    const planned = await review(source, plan);
    source.sessionCache = createLifecycleSessionCache();
    source.captured.length = 0;
    await withLifecycleReadClient(source, async (client) => {
      const block = await readLifecycleBlock(client), prepared = prepareLaunchSimulation({ client, planned }, block);
      try {
        source.state.probeFailure = true;
        const unavailable = await prepared(planned.transactions);
        assert.equal(unavailable.executionProof, "unavailable");
        assert.equal(capabilityRequests(source).length, 1);
        assert.equal(economicRequests(source).length, 0);
        source.state.probeFailure = false;
        assert.equal((await prepared(planned.transactions)).admitted, true);
        assert.equal((await prepared(planned.transactions)).admitted, true);
        assert.equal(capabilityRequests(source).length, 2, "A failed probe is not cached; the one positive proof is then reused");
        assert.deepEqual(economicRequests(source).map((row) => row.params[0].validation), [false, true, false, true], "Each unhinted candidate sizes once and validates exactly once");
        assert.equal(source.captured.filter((row) => row.method === "eth_gasPrice").length, 1);
        assert.equal(source.captured.filter((row) => row.method === "eth_getCode" && row.params[0] === ACCOUNT).length, 1);
        assert.equal(source.captured.filter((row) => row.method === "eth_getBlockByNumber" && row.params[0] === "0x2a").length, 0,
          "Private candidates defer their canonical guards to the external owner");
      } finally { prepared.close(); }
    });
    assert.equal(source.captured.filter((row) => row.method === "eth_getBlockByNumber" && row.params[0] === "0x2a").length, 0);
  }
});

test("prepared continuation refuses every source, account, plan, pin, header, policy and fork mutation", async () => {
  const changes = [
    ["client", ({ options, plan }) => { options.client = clientFor(plan); }],
    ["source request", ({ source }) => { const request = source.request; source.request = (args) => request(args); }],
    ["source batching", ({ source }) => { source.supportsReadBatching = !source.supportsReadBatching; }],
    ["planned object", ({ options }) => { options.planned = { ...options.planned }; }],
    ["plan object", ({ planned }) => { planned.plan = { ...planned.plan }; }],
    ["account", ({ planned }) => { planned.account = address(1); }],
    ["core", ({ plan }) => { plan.orchestrator = address(1); }],
    ["chain", ({ planned }) => { planned.chainId += 1n; }],
    ["plan hash", ({ planned }) => { planned.planHash = FOREIGN_HASH; }],
    ["launch identity", ({ planned }) => { planned.launchId = FOREIGN_HASH; }],
    ["predicted token", ({ planned }) => { planned.predictedToken = address(1); }],
    ["economics", ({ plan }) => { plan.buys[0].minTokenOut += 1n; }, "PLAN_MUTATED"],
    ["block number", ({ block }) => { block.number += 1n; }],
    ["block hash", ({ block }) => { block.hash = FOREIGN_HASH; }],
    ["child timestamp", ({ block }) => { block.timestamp += 1n; }],
    ["header gas", ({ block }) => { block.gasLimit += 1n; }],
    ["fee assumptions", ({ block }) => { block.baseFeePerGas += 1n; }],
    ["policy source", ({ options }) => { options.limits = {}; }],
    ["stored policy", ({ planned }) => { planned.limits = {}; }],
    ["returned policy", ({ policy }) => { policy.headroomBps = 1000; }],
    ["fork identity", ({ options }) => { options.fork = { ...options.fork }; }],
    ["fork context", ({ fork }) => { fork.expectedChainId = 1n; }],
    ["fork client request", ({ fork }) => { fork.client.request = () => assert.fail("Changed fork cannot execute"); }],
  ];
  for (const [name, mutate, code = "LIMIT_CONTEXT_MISMATCH"] of changes) {
    const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
    source.supportsReadBatching = true;
    const planned = await review(source, plan);
    source.captured.length = 0;
    const invocation = withLifecycleReadClient(source, async (client) => {
      const block = await readLifecycleBlock(client), policy = {};
      const fork = { client: { request() { assert.fail("Native proof cannot use a generic fork"); } } };
      const options = { client, planned, fork, limits: async (context) => {
        assert.equal(context.client, source);
        return policy;
      } };
      const prepared = prepareLaunchSimulation(options, block);
      try {
        assert.equal((await prepared(planned.transactions)).admitted, true, name);
        const observed = source.captured.length;
        mutate({ options, source, plan, planned, block, policy, fork });
        await assert.rejects(prepared(planned.transactions), { code }, name);
        assert.equal(source.captured.length, observed, `${name} mutation cannot dispatch another proof`);
        await assert.rejects(prepared(planned.transactions), { code: "INVALID_SIMULATION" }, "Mutation permanently invalidates this continuation");
      } finally { prepared.close(); }
    });
    if (name === "returned policy") await assert.rejects(invocation, { code: "LIMIT_CONTEXT_MISMATCH" }, "The owner cannot publish earlier admission under mutated live policy");
    else await invocation;
  }
});

test("prepared continuation closes with its invocation owner and rejects explicit close or concurrent consumption", async () => {
  const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
  const planned = await review(source, plan);
  const escaped = await withLifecycleReadClient(source, async (client) => {
    const prepared = prepareLaunchSimulation({ client, planned }, await readLifecycleBlock(client));
    assert.equal((await prepared(planned.transactions)).admitted, true);
    return prepared;
  });
  const observed = source.captured.length;
  await assert.rejects(escaped(planned.transactions), { code: "READ_SCOPE_CLOSED" });
  assert.equal(source.captured.length, observed);
  escaped.close();
  await withLifecycleReadClient(source, async (client) => {
    const prepared = prepareLaunchSimulation({ client, planned }, await readLifecycleBlock(client));
    prepared.close();
    await assert.rejects(prepared(planned.transactions), { code: "INVALID_SIMULATION" });
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = { supportsReadBatching: true, request(args) { return args.method === "eth_gasPrice" ? gate : source.request(args); } };
  await withLifecycleReadClient(client, async (scoped) => {
    const prepared = prepareLaunchSimulation({ client: scoped, planned }, await readLifecycleBlock(scoped));
    const first = prepared(planned.transactions);
    await assert.rejects(prepared(planned.transactions), { code: "INVALID_SIMULATION" });
    release("0x2");
    await assert.rejects(first, { code: "INVALID_SIMULATION" });
    prepared.close();
  });
});

test("candidate mutation during native measurement refuses without replaying a changed sequence", async () => {
  const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
  const planned = await review(source, plan);
  source.captured.length = 0;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), measured = new Promise((resolve) => { entered = resolve; });
  const client = { supportsReadBatching: true, async request(args) {
    const result = await source.request(args);
    if (args.method === "eth_simulateV1" && args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS) { entered(); await gate; }
    return result;
  } };
  await withLifecycleReadClient(client, async (scoped) => {
    const prepared = prepareLaunchSimulation({ client: scoped, planned }, await readLifecycleBlock(scoped));
    try {
      const pending = prepared(planned.transactions);
      await measured;
      planned.transactions[0].value += 1n;
      release();
      await assert.rejects(pending, { code: "INVALID_SIMULATION" });
      assert.equal(economicRequests(source).length, 1, "A changed economic candidate cannot reach validated replay");
    } finally { release(); prepared.close(); }
  });
});



test("standalone native calls refresh fees while session capabilities and account code remain reusable", async () => {
  const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
  const planned = await review(source, plan);
  source.captured.length = 0;
  const first = await simulateLaunchTransactions({ client: source, planned }, planned.transactions);
  source.state.gasPrice = 7n;
  const second = await simulateLaunchTransactions({ client: source, planned }, planned.transactions);
  assert.equal(first.steps[0].estimate.gasPrice, 2n);
  assert.equal(second.steps[0].estimate.gasPrice, 7n);
  assert.equal(capabilityRequests(source).length, 0);
  assert.deepEqual(economicRequests(source).map((row) => row.params[0].validation), [false, true, false, true]);
  source.state.accountCode = CODE;
  const smart = await simulateLaunchTransactions({ client: { request: (args) => source.request(args) }, planned }, planned.transactions);
  assert.equal(smart.executionProof, "unavailable");
  assert.match(smart.reason, /smart-account/);
  assert.equal(capabilityRequests(source).length, 0, "A fresh smart-account refusal does not request native execution");
  assert.equal(source.captured.filter((row) => row.method === "eth_getCode" && row.params[0] === ACCOUNT).length, 1);
});

test("policy and pinned getter aborts preserve identity and cannot start native proof", async () => {
  for (const stage of ["policy", "getter"]) {
    const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
    const planned = await review(source, plan);
    source.captured.length = 0;
    const aborted = Object.assign(new Error("Pinned context cancelled"), { name: "AbortError" });
    const transport = { supportsReadBatching: true, request(args) {
      if (stage === "getter" && args.method === "eth_call" && args.params[0].to.toLowerCase() === MULTICALL3) return Promise.reject(aborted);
      return source.request(args);
    } };
    await withLifecycleReadClient(transport, async (client) => {
      const limits = stage === "policy" ? async () => { throw aborted; } : undefined;
      const prepared = prepareLaunchSimulation({ client, planned, limits }, await readLifecycleBlock(client));
      try { await assert.rejects(prepared(planned.transactions), (failure) => failure === aborted); }
      finally { prepared.close(); }
    });
    await nextTurn();
    assert.equal(capabilityRequests(source).length, 0);
    assert.equal(economicRequests(source).length, 0);
  }
});

test("policy mutation before pending context settles cannot dispatch native capability or economic work", async () => {
  const plan = makePlan({ chainId: 4663n }), source = clientFor(plan);
  const planned = await review(source, plan);
  source.captured.length = 0;
  const limits = { headroomBps: 1500 };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const transport = { supportsReadBatching: true, request(args) {
    return args.method === "eth_gasPrice" ? gate : source.request(args);
  } };
  await withLifecycleReadClient(transport, async (client) => {
    const prepared = prepareLaunchSimulation({ client, planned, limits }, await readLifecycleBlock(client));
    const pending = prepared(planned.transactions);
    await nextTurn();
    limits.headroomBps = 1000;
    release("0x2");
    try { await assert.rejects(pending, { code: "LIMIT_CONTEXT_MISMATCH" }); }
    finally { prepared.close(); }
  });
  assert.equal(capabilityRequests(source).length, 0);
  assert.equal(economicRequests(source).length, 0);
});

test("combined no-bound preparation performs exactly one fresh genuine planning pass", async () => {
  for (const mode of ["atomic", "staged"]) {
    const plan = makePlan({ chainId: 4663n }), reference = clientFor(plan), combined = clientFor(plan);
    reference.supportsReadBatching = combined.supportsReadBatching = true;
    const expected = await planLaunch({ client: reference, plan, account: ACCOUNT, mode });
    let progressUpdates = 0;
    const actual = await prepareAndPlanLifecycleLaunch({ client: combined, plan, account: ACCOUNT, mode, onProgress() { progressUpdates += 1; } });
    assert.equal(actual.simulation.admitted, true, actual.simulation.reason);
    assert.deepEqual(actual, expected, "No-bound delegation preserves canonical economics, requested mode, progress and exact admission");
    assert.deepEqual(combined.captured, reference.captured, "No mining snapshots, metadata repetitions or additional proofs may precede plain planning");
    assert.equal(progressUpdates, 0, "A plan without bound-hook mining has no mining progress");
    assert.equal(capabilityRequests(combined).length, 1);
    assert.deepEqual(economicRequests(combined).map((row) => row.params[0].validation), [false, true]);
  }
});

test("Nitro huge header never replaces changing pinned compute getters or ArbOS50 detection", async () => {
  const plan = makePlan({ chainId: 4663n });
  const client = clientFor(plan, { computeUsed: 10_000_001n });
  const first = await review(client, plan);
  assert.equal(first.simulation.admitted, true); assert.equal(first.simulation.limits.blockGasLimit, 1n << 50n);
  assert.equal(first.simulation.limits.arbOSVersion, 50n); assert.equal(first.simulation.limits.executionGasCeiling, 32_000_000n);
  assert.equal(first.transactions[0].gas, 11_500_002n);
  client.state.txCompute = 11_000_000n;
  const changed = await simulateLaunchPlan({ client, planned: first });
  assert.equal(changed.admitted, true); assert.equal(changed.steps[0].estimate.gasLimit, 11_500_002n); assert.equal(changed.limits.executionGasCeiling, 11_000_000n);
  for (const settings of [{ rawVersion: 104n }, { getterFailure: true }, { getterResponse: "0x" }, { versionResponse: toHex(105n, { size: 64 }) }, { txCompute: 0n }, { txCompute: 1n << 64n }]) {
    await assert.rejects(review(clientFor(plan, settings), plan), { code: "NITRO_LIMITS_UNAVAILABLE" });
  }
  const blockBound = await review(clientFor(plan, { blockCompute: 900_000n }), plan);
  assert.equal(blockBound.simulation.admitted, false); assert.equal(blockBound.simulation.limits.executionGasCeiling, 900_000n);
});

test("native Nitro probe must match all pinned values and cannot fund real execution", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const settings of [{ probeMismatch: 0 }, { probeMismatch: 1 }, { probeMismatch: 2 }, { probeResponse: "0x" }, { probeFailure: true }, { simulationUnavailable: true }]) {
    const client = clientFor(plan, settings);
    const planned = await review(client, plan, { fork: { client: { request() { assert.fail("Generic Nitro fork must not receive writes"); } } } });
    assert.equal(planned.simulation.admitted, false); assert.equal(planned.simulation.executionProof, "unavailable"); assert.equal(planned.simulation.protocolFit, "unknown");
    assert.match(planned.simulation.reason, /Nitro|ArbOS/);
  }
  const poor = await review(clientFor(plan, { balance: 1n }), plan);
  assert.equal(poor.simulation.admitted, false); assert.match(poor.simulation.reason, /balance/);
});

test("Nitro economic dispatch waits for successful capability and every poster prerequisite", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  const source = clientFor(plan, { poster: 200_000n });
  let releaseProbe, releasePoster;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const posterGate = new Promise((resolve) => { releasePoster = resolve; });
  const started = new Set();
  const client = { supportsReadBatching: true, async request(args) {
    const response = await source.request(args);
    if (args.method === "eth_simulateV1") {
      const request = args.params[0];
      if (request.blockStateCalls[0].calls[0].to === ARB_SYS) {
        started.add("probe");
        await probeGate;
      } else started.add(request.validation ? "replay" : "measurement");
    } else if (args.method === "eth_call" && args.params[0].to === NODE_INTERFACE) {
      started.add("poster");
      await posterGate;
    }
    return response;
  } };
  const pending = review(client, plan);
  await nextTurn();
  const beforeProbe = new Set(started);
  releaseProbe();
  await nextTurn();
  const measurementBeforePoster = started.has("measurement");
  const replayBeforePoster = started.has("replay");
  releasePoster();
  const planned = await pending;
  assert.deepEqual([...beforeProbe].sort(), ["poster", "probe"]);
  assert.equal(replayBeforePoster, false, "Exact replay needs verified metering and the complete poster budget");
  assert.equal(measurementBeforePoster, false, "Measurement also needs the complete poster envelope before dispatch");
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.equal(started.has("replay"), true);
  const reference = await review(clientFor(plan, { poster: 200_000n }), plan);
  assert.deepEqual(planned, reference, "Scheduling cannot change exact committed calldata, proof outcomes, gas or fee envelopes");
  assert.equal(source.captured.filter((row) => row.method === "eth_simulateV1").length, 3);
  assert.equal(source.captured.filter((row) => row.method === "eth_getBlockByNumber").length, 1);
});

test("failed Nitro HTTP, capability, and poster prerequisites never enqueue economic execution", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const supportsReadBatching of [false, true]) {
    for (const settings of [{ probeFailure: true }, { probeMismatch: 1 }, { probeRevert: true },
      { probeError: Object.assign(new Error("RPC HTTP request failed"), { status: 429 }) },
      { posterResponse: "0x" }, { posterError: Object.assign(new Error("execution reverted"), { code: 3 }) },
      { posterError: Object.assign(new Error("RPC HTTP request failed"), { status: 503 }) }]) {
      const client = clientFor(plan, settings);
      client.supportsReadBatching = supportsReadBatching;
      const planned = await review(client, plan);
      assert.equal(planned.simulation.admitted, false);
      assert.equal(planned.simulation.executionProof, "unavailable");
      assert.match(planned.simulation.reason, /Native Nitro compute\/poster proof unavailable/);
      await nextTurn();
      assert.equal(client.captured.some((row) => row.method === "eth_simulateV1" &&
        row.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS), false, "A failed prerequisite cannot queue even permissive economic work");
      assert.equal(client.captured.filter((row) => row.method === "eth_getBlockByNumber").length, 1);
    }
  }
});

test("complete Nitro measurement envelope separates poster budget from the unchanged compute ceiling", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  const client = clientFor(plan, { computeUsed: 27_000_000n, poster: 6_000_000n, measurementPosterHold: true });
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.equal(planned.simulation.limits.executionGasCeiling, 32_000_000n);
  assert.equal(planned.transactions[0].gas, 37_950_000n);
  const [sizing, measurement] = economicRequests(client).map((row) => row.params[0]);
  assert.equal(sizing.validation, false);
  assert.equal(measurement.validation, true);
  assert.equal(BigInt(measurement.blockStateCalls[0].calls[0].gas), planned.transactions[0].gas, "The sole authoritative pass uses the exact returned complete envelope");
  assert.equal(economicRequests(client).length, 2);
  assert.equal(capabilityRequests(client).length, 1);
  for (const request of [sizing, measurement]) {
    assert.equal(request.blockStateCalls[0].stateOverrides, undefined);
    assert.equal(request.blockStateCalls[0].blockOverrides.baseFeePerGas, undefined);
    assert.equal(request.blockStateCalls[0].calls[0].from, ACCOUNT);
    assert.equal(request.blockStateCalls[0].calls[0].value, "0xa");
    assert.equal(request.blockStateCalls[0].calls[0].gasPrice, "0x2");
  }
  const headroom = await review(clientFor(plan, { computeUsed: 28_000_000n, poster: 6_000_000n, measurementPosterHold: true }), plan);
  assert.equal(headroom.simulation.admitted, true);
  assert.equal(headroom.transactions[0].gas, 39_100_000n, "Headroom is sized from the measured compute-plus-poster total");
  const bounded = clientFor(plan, { computeUsed: 27_000_000n, poster: 6_000_000n, measurementPosterHold: true });
  const capped = await review(bounded, plan, { limits: { accountGasLimit: 32_000_000n } });
  assert.equal(capped.simulation.admitted, false);
  assert.equal(BigInt(economicRequests(bounded)[0].params[0].blockStateCalls[0].calls[0].gas), 32_000_000n, "Known total caps tighten the complete envelope");
  assert.equal(economicRequests(bounded).length, 1, "Failed measurement cannot be bypassed by exact replay");
});

test("aggregate gas-used budgets prove the longest estimated prefix rather than summing legal envelopes", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2 });
  for (const [cap, deferred] of [[100_000_000n, []], [50_000_000n, ["activate"]], [9_500_000n, ["prepare:0:2", "activate"]]]) {
    const client = clientFor(plan, { poster: 2_000_000n });
    const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: cap } });
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.equal(planned.simulation.executionProof, "proved");
    assert.equal(planned.simulation.protocolFit, "proved");
    assert.deepEqual(planned.simulation.deferredTransactionIds, deferred);
    const proven = planned.transactions.length - deferred.length;
    assert.deepEqual(economicRequests(client).map((row) => row.params[0].blockStateCalls.length), [proven, proven]);
    for (const tx of planned.transactions.slice(proven)) {
      assert.equal(tx.gas, undefined); assert.equal(tx.gasPrice, undefined);
      assert.equal(tx.estimate, undefined); assert.equal(tx.admission, undefined);
    }
  }
  const defaulted = await review(clientFor(plan), plan, { mode: "staged" });
  assert.equal(defaulted.simulation.limits.maxSimulationGas, 50_000_000n);
  assert.deepEqual(defaulted.simulation.deferredTransactionIds, ["activate"]);
  const capped = clientFor(plan);
  const unavailable = await review(capped, plan, { mode: "staged", limits: { maxSimulationGas: 9_499_999n } });
  assert.equal(unavailable.simulation.admitted, false);
  assert.equal(unavailable.simulation.executionProof, "unavailable");
  assert.equal(capabilityRequests(capped).length, 0);
  assert.equal(economicRequests(capped).length, 0);
});

test("no-prefix refusal reports immediate compute overflow before the RPC aggregate budget", async () => {
  const two = makeHmmPlan(2), impossible = clientFor(two);
  const refused = await review(impossible, two);
  assert.equal(refused.simulation.admitted, false);
  assert.equal(refused.simulation.failureCategory, "capacity");
  assert.equal(refused.simulation.capacityConstraint, "compute");
  assert.equal(refused.simulation.reason, "Atomic launch needs about 55.3M gas, above the 32.0M per-transaction limit; use staged");
  assert.equal(economicRequests(impossible).length, 0);
  const one = makePlan({ chainId: 4663n });
  const budget = await review(clientFor(one), one, { limits: { maxSimulationGas: 30_000_000n } });
  assert.equal(budget.simulation.admitted, false);
  assert.equal(budget.simulation.capacityConstraint, "simulation-gas");
  assert.match(budget.simulation.reason, /RPC aggregate simulation gas cap/);
  const fitting = makeHmmPlan();
  assert.equal((await review(clientFor(fitting, { computeUsed: 27_360_000n }), fitting)).simulation.admitted, true,
    "Conservative estimates alone must not reject a provable single-HMM atomic envelope");
});

test("measurement transport exhaustion truncates only at the observed aggregate ceiling", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const exhausted of [true, false]) {
    const client = clientFor(plan, {
      gasFor: (name) => name === "beginLaunch" ? 9_000_000n : 29_000_000n,
      failureFor(name, _args, validation) {
        return name === "activateLaunch" ? { gasUsed: exhausted ? 10_000_000n : 1_000_000n,
          error: { code: 3, message: "execution reverted", data: "0x" } } : undefined;
      },
    });
    const planned = await review(client, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, exhausted, planned.simulation.reason);
    assert.deepEqual(planned.simulation.deferredTransactionIds, exhausted ? ["activate"] : []);
    if (exhausted) {
      assert.deepEqual(economicRequests(client).map((row) => row.params[0].blockStateCalls.length), [3, 2]);
      assert.equal(planned.simulation.executionProof, "proved");
    } else {
      assert.equal(planned.simulation.failedTransactionId, "activate");
      assert.equal(planned.simulation.executionProof, "failed");
      assert.equal(economicRequests(client).length, 1, "An in-prefix semantic/opaque refusal is not transport exhaustion");
    }
  }
});



test("source and malformed exact-replay failures cannot retry into admission", async () => {
  for (const chainId of [31337n, 4663n]) {
    for (const failure of [Object.assign(new Error("RPC HTTP request failed"), { status: 429 }),
      Object.assign(new Error("RPC HTTP request failed"), { statusCode: 503, code: 3, details: "execution failed" }),
      Object.assign(new Error("out of gas: private HTTP failure"), { status: 503, code: -32015, data: "0x" }),
      Object.assign(new Error("execution failed upstream connection"), { code: -32002 }),
      new Error("Connection reset while reading native proof")]) {
      const plan = makePlan({ chainId }), source = clientFor(plan);
      let failed = false;
      const client = { supportsReadBatching: true, async request(args) {
        if (args.method === "eth_simulateV1" && args.params[0].validation &&
          args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS && !failed) {
          failed = true;
          source.captured.push(args);
          throw failure;
        }
        return source.request(args);
      } };
      const planned = await review(client, plan);
      assert.equal(planned.simulation.admitted, false);
      assert.equal(planned.simulation.confidence, "provisional");
      assert.equal(planned.simulation.executionProof, "unavailable");
      assert.equal(diagnosticJson(planned.simulation).includes(failure.message), false);
      assert.deepEqual(economicRequests(source).map((row) => row.params[0].validation), [false, true], "The one failed exact pass is never retried");
    }
    const plan = makePlan({ chainId }), incomplete = clientFor(plan, { incompleteReplay: true });
    const malformed = await review(incomplete, plan);
    assert.equal(malformed.simulation.executionProof, "unavailable");
    assert.equal(economicRequests(incomplete).length, 2);
  }
});

test("native cancellation propagates through capability, poster, measurement, replay and discovery without later economic dispatch", async () => {
  for (const stage of ["capability", "poster", "measurement"]) {
    const plan = makePlan({ chainId: 4663n });
    const source = clientFor(plan, { gasFor: (_name, _args, validation) => validation ? 1_500_000n : 1_000_000n });
    const aborted = Object.assign(new Error("Source read cancelled"), { name: "AbortError" });
    let economic = 0;
    const client = { supportsReadBatching: true, async request(args) {
      let current;
      if (args.method === "eth_call" && args.params[0].to === NODE_INTERFACE) current = "poster";
      if (args.method === "eth_simulateV1") current = args.params[0].blockStateCalls[0].calls[0].to === ARB_SYS ? "capability" :
        ++economic === 1 ? "measurement" : economic === 2 ? "replay" : "envelope";
      if (current === stage) {
        source.captured.push(args);
        throw aborted;
      }
      return source.request(args);
    } };
    await assert.rejects(review(client, plan), (failure) => failure === aborted);
    await nextTurn();
    assert.equal(economic, stage === "capability" || stage === "poster" ? 0 : 1);
  }
});

test("thrown native execution refusal retains unknown failure location and never repeats an identical ceiling", async () => {
  const plan = makePlan({ chainId: 4663n });
  const source = clientFor(plan, { replayThrow: true });
  const unavailableLocation = await review(source, plan);
  assert.equal(unavailableLocation.simulation.admitted, false);
  assert.equal(unavailableLocation.simulation.executionProof, "unavailable");
  assert.equal(unavailableLocation.simulation.confidence, "provisional");
  assert.equal(economicRequests(source).length, 2, "Sizing plus the failed exact pass, without an envelope retry");
  assert.equal(unavailableLocation.simulation.failedTransactionId, undefined, "A thrown native error contains no first failed call evidence");
  const ceiling = clientFor(plan, { computeUsed: 32_000_000n, replayThrow: true });
  const refused = await review(ceiling, plan, { limits: { headroomBps: 0 } });
  assert.equal(refused.simulation.admitted, false);
  assert.equal(refused.simulation.failedTransactionId, undefined);
  assert.equal(economicRequests(ceiling).length, 2, "A failed exact pass cannot benefit from another identical request");
});





test("nonzero Nitro poster envelope may exceed compute cutoff and affordability never double-charges", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  // Final validated metering includes the actual poster, not the advisory quote.
  const gas = 33_235_000n, balance = gas * 2n + 10n;
  const client = clientFor(plan, { computeUsed: 27_000_000n, poster: 2_000_000n, actualPoster: 1_900_000n, balance });
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  const tx = planned.transactions[0];
  assert.equal(tx.gas, gas); assert.ok(tx.gas > planned.simulation.limits.executionGasCeiling);
  assert.equal(tx.estimate.posterGas, 2_300_000n); assert.equal(tx.estimate.posterFee, 4_600_000n);
  assert.equal(tx.estimate.dataFeeIncludedInGas, true); assert.equal(tx.estimate.dataFee, 0n); assert.equal(tx.estimate.totalFee, gas * 2n);
  assert.ok(client.state.posterRequests.every(({ request, args }) => request.from === ACCOUNT && args[0].toLowerCase() === CORE && args[2] === tx.data && request.value === "0xa"));
  const next = await buildNextTransaction({ client, planned }); assert.equal(next.gas, gas);
  const poor = await review(clientFor(plan, { computeUsed: 27_000_000n, poster: 2_000_000n, balance: balance - 1n }), plan);
  assert.equal(poor.simulation.admitted, true); assert.equal(poor.transactions[0].gas, gas - 1n, "Affordable padding is clamped before the exact pass");
  const capped = await review(clientFor(plan, { computeUsed: 27_000_000n, poster: 2_000_000n }), plan, { limits: { accountGasLimit: 33_000_000n } });
  assert.equal(capped.simulation.admitted, true); assert.equal(capped.transactions[0].gas, 33_000_000n);
  await assert.rejects(review(clientFor(plan), plan, { limits: { estimateDataFee: async () => 1n } }), { code: "INVALID_LIMITS" });
});

test("poster quote is not exact compute proof and malformed poster observations fail closed", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const settings of [{ posterResponse: "0x" }, { posterResponse: toHex(0n, { size: 96 }) }]) {
    const planned = await review(clientFor(plan, settings), plan);
    assert.equal(planned.simulation.admitted, false); assert.equal(planned.simulation.protocolFit, "unknown");
  }
  const failed = await review(clientFor(plan, { poster: 100_000_000n, replayThrow: true }), plan);
  assert.equal(failed.simulation.admitted, false); assert.equal(failed.simulation.executionProof, "unavailable");
  assert.equal(failed.simulation.failureCategory, undefined, "A thrown source error has no observed failed step");
});

test("validated simulation, postconditions and account protections remain mandatory", async () => {
  const plan = makePlan();
  for (const settings of [{ replayThrow: true }, { replayFail: true }, { incompleteReplay: true }, { badOutput: true }]) {
    const planned = await review(clientFor(plan, settings), plan);
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.executionProof, settings.incompleteReplay || settings.replayThrow ? "unavailable" : "failed");
    await assert.rejects(buildNextTransaction({ client: clientFor(plan, settings), planned }), { code: "PLAN_NOT_ADMITTED" });
  }
  const smart = await review(clientFor(plan, { accountCode: CODE }), plan);
  assert.equal(smart.simulation.admitted, false); assert.equal(smart.simulation.executionProof, "unavailable"); assert.match(smart.simulation.reason, /smart-account/);
  const dataFee = async () => 5n;
  const gasFee = 1_150_000n * 2n;
  assert.equal((await review(clientFor(plan, { balance: gasFee + 5n }), plan, { limits: { estimateDataFee: dataFee } })).simulation.admitted, true);
  assert.equal((await review(clientFor(plan, { balance: gasFee + 4n }), plan, { limits: { estimateDataFee: dataFee } })).simulation.admitted, false);
  await assert.rejects(review(clientFor(plan), plan, { limits: { estimateDataFee: async () => "5" } }), { code: "INVALID_DATA_FEE" });
});

function submissionFor(plan, { chain = plan.chainId, estimate = 1_000_000n, failure, drift = false } = {}) {
  const captured = [];
  return { captured, async request({ method, params = [] }) {
    captured.push({ method, params });
    if (method === "eth_chainId") return toHex(drift && captured.length > 1 ? 1n : chain);
    assert.equal(method, "eth_estimateGas", "Submission transport only receives read-only exact immediate estimation");
    if (failure) throw new Error("Wallet RPC rejects exact gas envelope");
    return typeof estimate === "bigint" ? toHex(estimate) : estimate;
  } };
}
test("reviewed native envelope survives the observed upward advisory drift at exact affordable gas and price", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  plan.funding[0].amount = plan.funding[0].inputAmount = 100_000_000_000_000n;
  plan.buys[0].quoteAmountIn = 100_000_000_000_000n;
  const client = clientFor(plan, { computeUsed: 20_846_324n, gasPrice: 40_040_000n, baseFeePerGas: 20_020_000n });
  const planned = await review(client, plan);
  const reviewedTransaction = await buildNextTransaction({ client, planned });
  assert.equal(reviewedTransaction.gas, 23_973_273n);
  assert.equal(reviewedTransaction.gasPrice, 40_040_000n);
  assert.equal(reviewedTransaction.value, 100_000_000_000_000n);
  client.state.gasPrice = 40_180_000n;
  client.state.baseFeePerGas = 20_090_000n;
  client.state.childBaseFee = 20_091_000n;
  client.state.balance = reviewedTransaction.value + 23_973_273n * 40_040_000n;
  client.captured.length = 0;
  const submissionClient = submissionFor(plan, { estimate: 20_846_324n });
  const next = await buildNextTransaction({ client, planned, reviewedTransaction, submissionClient });
  assert.equal(next.gas, 23_973_273n);
  assert.equal(next.gasPrice, 40_040_000n, "Neither a fresh recommendation nor twice the fresh base fee replaces the reviewed price");
  assert.equal(next.estimate.executionFee, 23_973_273n * 40_040_000n);
  assert.equal(next.admission.admitted, true);
  assert.equal(next.admission.executionProof, "proved");
  assert.equal(next.admission.protocolFit, "proved");
  assert.equal(next.admission.transportPreflight, "passed");
  assert.equal(next.admission.blockHash, HASH);
  const economic = economicRequests(client).map((row) => row.params[0]);
  assert.deepEqual(economic.map((request) => request.validation), [true]);
  assert.equal(BigInt(economic[0].blockStateCalls[0].calls[0].gas), 23_973_273n);
  for (const request of economic) for (const block of request.blockStateCalls) {
    assert.equal(BigInt(block.calls[0].gasPrice), 40_040_000n);
    assert.equal(block.blockOverrides.baseFeePerGas, undefined);
    assert.equal(block.stateOverrides, undefined);
  }
  assert.equal(capabilityRequests(client).length, 0);
  assert.equal(client.captured.filter((row) => row.method === "eth_gasPrice").length, 0);
  assert.equal(client.captured.filter((row) => row.method === "eth_getBalance").length, 0);
  assert.deepEqual(submissionClient.captured[1].params, [{ from: ACCOUNT, to: CORE, data: reviewedTransaction.data,
    value: toHex(100_000_000_000_000n), gas: toHex(23_973_273n), gasPrice: toHex(40_040_000n), nonce: toHex(reviewedTransaction.nonce) }, "latest"]);
  const refreshed = await buildNextTransaction({ client, planned, submissionClient: submissionFor(plan) });
  assert.equal(refreshed.gasPrice, 40_180_000n);
  assert.ok(refreshed.gas < reviewedTransaction.gas, "New fee recommendations shrink optional padding to an affordable exact envelope");
});

test("reviewed atomic, approval, staged preparation, activation and cancellation replay only the immediate exact envelope", async () => {
  const vectors = [
    { mode: "atomic", settings: {}, kind: "atomic", sequence: ["launchAtomic"] },
    { mode: "atomic", settings: { allowance: 0n }, kind: "approve", sequence: ["approve", "launchAtomic"] },
    { mode: "staged", settings: { allowance: 1n }, kind: "approve-reset", sequence: ["approve", "approve", "beginLaunch", "prepareMarkets", "activateLaunch"] },
    { mode: "staged", settings: {}, kind: "begin", sequence: ["beginLaunch", "prepareMarkets", "activateLaunch"] },
    { mode: "staged", settings: { phase: LifecyclePhase.Preparing }, kind: "prepare", sequence: ["prepareMarkets", "activateLaunch"] },
    { mode: "staged", settings: { phase: LifecyclePhase.Preparing, prepared: 1 }, markets: 2, kind: "prepare", sequence: ["prepareMarkets", "activateLaunch"] },
    { mode: "staged", settings: { phase: LifecyclePhase.Ready, prepared: 2 }, markets: 2, kind: "activate", sequence: ["activateLaunch"] },
    { mode: "staged", settings: { phase: LifecyclePhase.Preparing }, action: "cancel", kind: "cancel", sequence: ["cancelLaunch"] },
    { mode: "staged", settings: { phase: LifecyclePhase.Ready, prepared: 2 }, markets: 2, action: "cancel", kind: "cancel", sequence: ["cancelLaunch"] },
  ];
  for (const chainId of [31337n, 4663n]) for (const vector of vectors) {
    const plan = makePlan({ chainId, markets: vector.markets ?? 1 });
    const client = clientFor(plan, { poster: chainId === 4663n ? 200_000n : 0n, ...vector.settings });
    const planned = await review(client, plan, { mode: vector.mode });
    const reviewedTransaction = await buildNextTransaction({ client, planned, action: vector.action });
    client.state.gasPrice = 3n;
    client.captured.length = 0;
    const submissionClient = submissionFor(plan);
    const next = await buildNextTransaction({ client, planned, reviewedTransaction, action: vector.action, submissionClient });
    assert.equal(next.kind, vector.kind);
    assert.equal(next.gas, reviewedTransaction.gas);
    assert.equal(next.gasPrice, 2n);
    assert.equal(next.data, reviewedTransaction.data);
    assert.equal(next.value, reviewedTransaction.value);
    assert.equal(next.estimate.gasLimit, reviewedTransaction.gas);
    assert.equal(next.estimate.gasPrice, 2n);
    assert.equal(next.admission.transportPreflight, "passed");
    const replay = economicRequests(client).find((row) => row.params[0].validation).params[0];
    assert.deepEqual(replay.blockStateCalls.map((block) => decodeFunctionData({
      abi: block.calls[0].to === CORE ? launchLifecycleAbi : lifecycleErc20Abi, data: block.calls[0].data,
    }).functionName), [vector.sequence[0]]);
    assert.equal(BigInt(replay.blockStateCalls[0].calls[0].gas), reviewedTransaction.gas);
    assert.ok(replay.blockStateCalls.every((block) => BigInt(block.calls[0].gasPrice) === 2n &&
      block.stateOverrides === undefined && block.blockOverrides.baseFeePerGas === undefined));
    assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [true]);
    assert.equal(client.captured.filter((row) => row.method === "eth_gasPrice").length, 0);
    assert.equal(client.captured.filter((row) => row.method === "eth_call" && row.params[0].to === NODE_INTERFACE).length, 0);
    if (vector.action === "cancel") assert.equal(client.captured.some((row) => row.method === "eth_call" && row.params[0].to === REGISTRY), false);
  }
});

test("reviewed semantic mutation and stale approval or staged step cannot select executable calldata", async () => {
  const plan = makePlan({ chainId: 4663n }), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = planned.transactions[0];
  const changedData = encodeFunctionData({ abi: launchLifecycleAbi, functionName: "launchAtomic",
    args: [{ ...plan, buys: [{ ...plan.buys[0], minTokenOut: 6n }] }] });
  assert.equal(decodeFunctionData({ abi: launchLifecycleAbi, data: changedData }).args[0].buys[0].minTokenOut, 6n);
  assert.notEqual(changedData, reviewedTransaction.data, "A changed minimum output must change the actual committed calldata");
  for (const mutation of [
    { id: "begin" }, { kind: "begin" }, { chainId: 1 }, { from: address(1) }, { to: address(1) },
    { data: changedData }, { value: 1n },
  ]) {
    const source = clientFor(plan), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned, reviewedTransaction: { ...reviewedTransaction, ...mutation }, submissionClient }),
      { code: "REVIEWED_TRANSACTION_MISMATCH" }, `Changed reviewed ${Object.keys(mutation)[0]} must refuse before economic proof`);
    assert.equal(economicRequests(source).length, 0, "Mismatched semantics cannot be consumed by native economic proof");
    assert.equal(submissionClient.captured.length, 0);
  }
  const approvalSource = clientFor(plan, { allowance: 0n });
  const approving = await review(approvalSource, plan);
  approvalSource.state.allowance = 10n;
  await assert.rejects(buildNextTransaction({ client: approvalSource, planned: approving, reviewedTransaction: approving.transactions[0] }),
    { code: "REVIEWED_TRANSACTION_MISMATCH" });
  const staged = await review(clientFor(plan), plan, { mode: "staged" });
  await assert.rejects(buildNextTransaction({ client: clientFor(plan, { phase: LifecyclePhase.Preparing }), planned: staged,
    reviewedTransaction: staged.transactions[0] }), { code: "REVIEWED_TRANSACTION_MISMATCH" });
});

test("reviewed malformed values and fees refuse before source or submission RPC work", async () => {
  const plan = makePlan(), planned = await review(clientFor(plan), plan);
  const valid = planned.transactions[0];
  for (const reviewedTransaction of [
    null, [], { ...valid, id: 1 }, { ...valid, kind: "unknown" }, { ...valid, chainId: 1.5 },
    { ...valid, from: "0x" }, { ...valid, to: zeroHash }, { ...valid, data: "0x0" },
    { ...valid, value: "0" }, { ...valid, value: -1n }, { ...valid, value: 1n << 256n },
    { ...valid, gas: undefined }, { ...valid, gas: 1_150_000 }, { ...valid, gas: 0n }, { ...valid, gas: -1n }, { ...valid, gas: 1n << 64n },
    { ...valid, gasPrice: undefined }, { ...valid, gasPrice: "2" }, { ...valid, gasPrice: -1n }, { ...valid, gasPrice: 1n << 256n },
  ]) {
    const source = clientFor(plan), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned, reviewedTransaction, submissionClient }), { code: "INVALID_REVIEWED_TRANSACTION" });
    assert.equal(source.captured.length, 0);
    assert.equal(submissionClient.captured.length, 0);
  }
});

test("fresh execution may consume reviewed padding without increasing gas or price", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  for (const mode of ["atomic", "staged"]) {
    const planned = await review(clientFor(plan, { poster: 200_000n }), plan, { mode });
    const reviewedTransaction = planned.transactions[0];
    for (const vector of [
      { settings: { computeUsed: 1_000_153n } },
      { settings: { poster: 200_001n } },
      { settings: { actualPoster: 210_000n } },
      { settings: {}, limits: { headroomBps: 2000 } },
    ]) {
      const source = clientFor(plan, { poster: 200_000n, ...vector.settings });
      const next = await buildNextTransaction({ client: source, planned, reviewedTransaction,
        limits: vector.limits, submissionClient: submissionFor(plan) });
      assert.equal(next.admission.executionProof, "proved");
      assert.equal(next.admission.protocolFit, "proved");
      assert.equal(next.admission.transportPreflight, "passed");
      assert.equal(next.gas, reviewedTransaction.gas);
      assert.equal(next.gasPrice, reviewedTransaction.gasPrice);
      assert.equal(next.data, reviewedTransaction.data);
      assert.equal(next.value, reviewedTransaction.value);
      assert.ok(next.estimate.gasUsed <= next.gas);
      const replay = economicRequests(source).find((row) => row.params[0].validation);
      assert.equal(BigInt(replay.params[0].blockStateCalls[0].calls[0].gas), reviewedTransaction.gas);
    }
  }
});

test("held envelopes still enforce actual compute, poster, transaction ceilings and real balance", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true });
  const planned = await review(clientFor(plan, { poster: 200_000n }), plan);
  const reviewedTransaction = planned.transactions[0];
  for (const vector of [
    { settings: {}, limits: { accountGasLimit: reviewedTransaction.gas - 1n }, constraint: "gas-envelope" },
    { settings: { txCompute: 999_999n }, constraint: "compute" },
    { settings: { balance: 2_760_009n }, category: "affordability" },
    { settings: { actualPoster: 380_001n }, category: "capacity", replay: true },
  ]) {
    const source = clientFor(plan, { poster: 200_000n, ...vector.settings }), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned, reviewedTransaction, limits: vector.limits, submissionClient }), (failure) => {
      assert.equal(failure.code, "PLAN_NOT_ADMITTED");
      assert.equal(failure.simulation.admitted, false);
      if (vector.constraint) assert.equal(failure.simulation.capacityConstraint, vector.constraint);
      if (vector.category) assert.equal(failure.simulation.failureCategory, vector.category);
      return true;
    });
    if (vector.replay) {
      const requests = economicRequests(source);
      assert.deepEqual(requests.map((row) => row.params[0].validation), [true]);
      assert.equal(BigInt(requests[0].params[0].blockStateCalls[0].calls[0].gas), reviewedTransaction.gas,
        "An exhausted held envelope is never enlarged or retried");
    }
    assert.equal(submissionClient.captured.length, 0);
  }
});

test("below-natural-base held fees and exact native gas exhaustion cannot silently increase a reviewed envelope", async () => {
  const plan = makePlan({ chainId: 4663n }), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = planned.transactions[0];
  for (const settings of [
    { gasPrice: 4n, baseFeePerGas: 3n, childBaseFee: 3n },
    { gasFor: (_name, _args, validation) => validation ? 1_500_000n : 1_000_000n },
  ]) {
    const source = clientFor(plan, settings), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned, reviewedTransaction, submissionClient }), { code: "PLAN_NOT_ADMITTED" });
    const economic = economicRequests(source);
    assert.deepEqual(economic.map((row) => row.params[0].validation), [true], "No measurement or retry can increase the failed immediate held gas");
    assert.equal(BigInt(economic[0].params[0].blockStateCalls[0].calls[0].gas), reviewedTransaction.gas);
    assert.equal(BigInt(economic[0].params[0].blockStateCalls[0].calls[0].gasPrice), 2n);
    assert.equal(submissionClient.captured.length, 0);
  }
});

test("held immediate proof does not rediscover or execute future envelopes", async () => {
  const plan = makePlan({ chainId: 4663n });
  const planned = await review(clientFor(plan), plan, { mode: "staged" });
  const reviewedTransaction = planned.transactions[0];
  const source = clientFor(plan, { gasPrice: 3n, gasFor: (name, _args, validation) =>
    validation && name === "prepareMarkets" ? 1_500_000n : 1_000_000n });
  const next = await buildNextTransaction({ client: source, planned, reviewedTransaction, submissionClient: submissionFor(plan) });
  assert.equal(next.gas, 1_150_000n);
  assert.equal(next.gasPrice, 2n);
  const replays = economicRequests(source).filter((row) => row.params[0].validation);
  assert.equal(replays.length, 1);
  for (const replay of replays) {
    const blocks = replay.params[0].blockStateCalls;
    assert.equal(blocks.length, 1);
    assert.equal(BigInt(blocks[0].calls[0].gas), 1_150_000n);
    assert.ok(blocks.every((block) => BigInt(block.calls[0].gasPrice) === 2n));
  }
  assert.deepEqual(economicRequests(source).map((row) => row.params[0].validation), [true]);
});

test("reviewed input never imports cached proofs or skips source, nonce, receipt, account or reorg guards", async () => {
  const plan = makePlan({ chainId: 4663n }), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = { ...planned.transactions[0], dependencies: ["fake"], postconditions: [],
    admission: { ...planned.transactions[0].admission, admitted: true }, estimate: { gasLimit: 1n, gasPrice: 99n } };
  const clean = await buildNextTransaction({ client: clientFor(plan), planned, reviewedTransaction });
  assert.deepEqual(clean.postconditions, planned.transactions[0].postconditions);
  assert.equal(clean.estimate.gasPrice, 2n);
  for (const vector of [
    { settings: { failActivation: true }, code: "PLAN_NOT_ADMITTED" },
    { settings: { simulationUnavailable: true }, code: "PLAN_NOT_ADMITTED" },
    { settings: { probeFailure: true }, code: "PLAN_NOT_ADMITTED" },
    { settings: { accountCode: CODE }, code: "PLAN_NOT_ADMITTED" },
  ]) {
    const source = clientFor(plan, vector.settings), submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: source, planned, reviewedTransaction, submissionClient }), { code: vector.code });
    assert.equal(submissionClient.captured.length, 0);
  }
  for (const gate of ["nonce", "receipt"]) {
    const source = clientFor(plan), submissionClient = submissionFor(plan);
    const client = { request(args) {
      if (gate === "nonce" && args.method === "eth_getTransactionCount" && args.params[1] === "pending") return Promise.resolve("0x1");
      if (["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(args.method)) return Promise.resolve(null);
      return source.request(args);
    } };
    await assert.rejects(buildNextTransaction({ client, planned, reviewedTransaction, submissionClient,
      receipts: gate === "receipt" ? [{ transactionHash: FOREIGN_HASH }] : [] }), { code: gate === "nonce" ? "UNCONFIRMED_STATE" : "RECEIPT_PENDING" });
    assert.equal(economicRequests(source).length, 0);
    assert.equal(submissionClient.captured.length, 0);
  }
});

test("reviewed exact submission refusal and asynchronous reviewed mutation cannot return a signed-ready transaction", async () => {
  const plan = makePlan({ chainId: 4663n }), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = planned.transactions[0];
  for (const settings of [{ chain: 1n }, { estimate: reviewedTransaction.gas + 1n }, { estimate: 0n }, { estimate: "0x" }, { failure: true }]) {
    await assert.rejects(buildNextTransaction({ client: clientFor(plan), planned, reviewedTransaction, submissionClient: submissionFor(plan, settings) }),
      { code: "SUBMISSION_PREFLIGHT_FAILED" });
  }
  for (const stage of ["source", "submission"]) {
    const held = { ...reviewedTransaction }, source = clientFor(plan);
    const submission = submissionFor(plan);
    const client = { async request(args) {
      const result = await source.request(args);
      if (stage === "source" && args.method === "eth_simulateV1" && args.params[0].validation &&
        args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS) held.gasPrice = 3n;
      return result;
    } };
    const submissionClient = { async request(args) {
      const result = await submission.request(args);
      if (stage === "submission" && args.method === "eth_estimateGas") held.value = 1n;
      return result;
    } };
    await assert.rejects(buildNextTransaction({ client, planned, reviewedTransaction: held, submissionClient }), { code: "REVIEWED_TRANSACTION_CHANGED" });
    if (stage === "source") assert.equal(submission.captured.length, 0);
  }
});


test("reviewed preparation preserves its canonical exact span without rediscovering the suffix", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 4 });
  const source = clientFor(plan, { phase: LifecyclePhase.Preparing,
    gasFor: (name, args) => name === "prepareMarkets" ? BigInt(args[2]) * 18_000_000n : 400_000n });
  const planned = await review(source, plan, { mode: "staged" });
  const reviewedTransaction = await buildNextTransaction({ client: source, planned });
  assert.equal(reviewedTransaction.id, "prepare:0:1");
  source.state.gasPrice = 3n;
  source.captured.length = 0;
  const next = await buildNextTransaction({ client: source, planned,
    reviewedTransaction, submissionClient: submissionFor(plan, { estimate: 18_000_000n }) });
  assert.equal(next.data, reviewedTransaction.data);
  assert.equal(next.gas, 20_700_000n);
  assert.equal(next.gasPrice, 2n);
  const requests = economicRequests(source).map((row) => row.params[0]);
  assert.deepEqual(requests.map((request) => request.validation), [true]);
  assert.deepEqual(requests.map((request) => request.blockStateCalls.length), [1]);
  source.state.gasFor = () => 400_000n;
  const unchanged = await buildNextTransaction({ client: source, planned, reviewedTransaction });
  assert.equal(unchanged.id, reviewedTransaction.id, "A lower current cost does not invalidate the canonical held span");
  assert.equal(unchanged.gas, reviewedTransaction.gas);
});

test("held native snapshot and execution failures remain refusals", async () => {
  const plan = makePlan({ chainId: 4663n }), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = planned.transactions[0];
  for (const [stage, code] of [["snapshot", "INVALID_RPC_RESPONSE"], ["replay", "PLAN_NOT_ADMITTED"]]) {
    const source = clientFor(plan), submissionClient = submissionFor(plan);
    const client = { request(args) {
      if (stage === "snapshot" && args.method === "eth_call" && args.params[0].to.toLowerCase() === MULTICALL3) return Promise.resolve("0x");
      if (args.method === "eth_simulateV1" && args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS && stage === "replay") {
        return Promise.reject(Object.assign(new Error("Source unavailable"), { status: 429 }));
      }
      return source.request(args);
    } };
    await assert.rejects(buildNextTransaction({ client, planned, reviewedTransaction, submissionClient }), stage === "snapshot" ? { name: "AbiDecodingZeroDataError" } : { code });
    assert.equal(submissionClient.captured.length, 0);
  }
  for (const [change, code] of [[{ account: address(1) }, "ACCOUNT_MISMATCH"]]) {
    const submissionClient = submissionFor(plan);
    await assert.rejects(buildNextTransaction({ client: clientFor(plan), planned: { ...planned, ...change }, reviewedTransaction, submissionClient }), { code });
    assert.equal(submissionClient.captured.length, 0);
  }
});

test("held generic fees use the exact immediate envelope and its affordability", async () => {
  const plan = makePlan(), planned = await review(clientFor(plan), plan, { mode: "staged" });
  const reviewedTransaction = planned.transactions[0];
  for (const balance of [2_300_005n, 2_300_004n]) {
    const source = clientFor(plan, { gasPrice: 3n, balance });
    const observed = [];
    const limits = { estimateDataFee: async (transaction, context) => {
      assert.equal(context.client, source);
      assert.equal(context.block.hash, HASH);
      assert.equal(transaction.gasPrice, 2n);
      assert.equal(transaction.gas, 1_150_000n);
      observed.push(transaction.id);
      return 5n;
    } };
    const pending = buildNextTransaction({ client: source, planned, reviewedTransaction, limits });
    if (balance === 2_300_005n) {
      const next = await pending;
      assert.equal(next.estimate.totalFee, 2_300_005n);
      assert.equal(next.gasPrice, 2n);
    } else await assert.rejects(pending, (failure) => {
      assert.equal(failure.code, "PLAN_NOT_ADMITTED");
      assert.equal(failure.simulation.executionProof, "proved");
      assert.equal(failure.simulation.failureCategory, "affordability");
      return true;
    });
    assert.deepEqual(observed, ["begin"], "Only the immediate held envelope is proved and charged");
  }
});

test("current caller account and chain cannot change during held execution or submission proof", async () => {
  const plan = makePlan({ chainId: 4663n }), original = await review(clientFor(plan), plan);
  const reviewedTransaction = original.transactions[0];
  for (const stage of ["source", "submission"]) for (const [field, value, code] of [
    ["account", address(1), "ACCOUNT_MISMATCH"], ["chainId", 1n, "CHAIN_MISMATCH"],
  ]) {
    const planned = { ...original }, source = clientFor(plan), submission = submissionFor(plan);
    const client = { async request(args) {
      const result = await source.request(args);
      if (stage === "source" && args.method === "eth_simulateV1" && args.params[0].validation &&
        args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS) planned[field] = value;
      return result;
    } };
    const submissionClient = { async request(args) {
      const result = await submission.request(args);
      if (stage === "submission" && args.method === "eth_estimateGas") planned[field] = value;
      return result;
    } };
    await assert.rejects(buildNextTransaction({ client, planned, reviewedTransaction, submissionClient }), { code: stage === "source" ? "LIMIT_CONTEXT_MISMATCH" : code });
    if (stage === "source") assert.equal(submission.captured.length, 0);
  }
});

test("submission preflight estimates only exact immediate-next calldata and preserves separate scopes", async () => {
  const plan = makePlan(), client = clientFor(plan, { allowance: 0n });
  const planned = await review(client, plan);
  const submissionClient = submissionFor(plan);
  const next = await buildNextTransaction({ client, planned, submissionClient });
  assert.equal(next.kind, "approve"); assert.equal(next.admission.transportPreflight, "passed");
  assert.equal(planned.simulation.transportPreflight, "not-requested");
  assert.deepEqual(submissionClient.captured.map((row) => row.method), ["eth_chainId", "eth_estimateGas"]);
  assert.deepEqual(submissionClient.captured[1].params, [{ from: next.from, to: next.to, data: next.data, value: toHex(next.value), gas: toHex(next.gas), gasPrice: toHex(next.gasPrice), nonce: toHex(next.nonce) }, "latest"]);
  for (const settings of [{ chain: 1n }, { estimate: next.gas + 1n }, { estimate: 0n }, { estimate: "0x" }, { failure: true }]) {
    await assert.rejects(buildNextTransaction({ client, planned, submissionClient: submissionFor(plan, settings) }), (failure) => {
      assert.equal(failure.code, "SUBMISSION_PREFLIGHT_FAILED");
      assert.equal(failure.simulation.executionProof, "proved"); assert.equal(failure.simulation.protocolFit, "proved"); assert.equal(failure.simulation.admitted, true); assert.equal(failure.simulation.transportPreflight, "failed");
      return true;
    });
  }
});





test("cancellation retains canonical recovery and optional exact submission preflight", async () => {
  const plan = makePlan(), client = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, balance: 92_000n });
  const committed = { plan, planHash: hashLaunchPlan(plan), launchId: hashLaunchIdentity(plan), predictedToken: TOKEN, account: ACCOUNT, chainId: plan.chainId, mode: "staged", confirmations: 1 };
  const submissionClient = submissionFor(plan, { estimate: 40_000n });
  const next = await buildNextTransaction({ client, planned: committed, action: "cancel", submissionClient });
  assert.equal(next.kind, "cancel"); assert.equal(next.gas, 46_000n); assert.equal(next.admission.transportPreflight, "passed");
  assert.equal(client.captured.some((row) => row.method === "eth_call" && row.params[0].to === REGISTRY), false, "Cancellation never requires current profile admission");
  const nitroPlan = makePlan({ chainId: 4663n });
  const nitroCommitted = { ...committed, plan: nitroPlan, planHash: hashLaunchPlan(nitroPlan), launchId: hashLaunchIdentity(nitroPlan), chainId: nitroPlan.chainId };
  const nitro = clientFor(nitroPlan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, balance: 92_000n });
  assert.equal((await buildNextTransaction({ client: nitro, planned: nitroCommitted, action: "cancel" })).gas, 46_000n, "Probe-only funding cannot reject an exactly-funded real cancellation");
});

test("definitive resumed failure retains its immediate fee and provisional suffix evidence", async () => {
  for (const chainId of [31337n, 4663n]) {
    const plan = makePlan({ chainId, markets: 2 });
    const error = { code: 3, message: "Primary resumed activation refusal", data: "0x" };
    const source = clientFor(plan, { phase: LifecyclePhase.Preparing,
      failureFor(name, _args, validation) { return validation && name === "activateLaunch" ? { error } : undefined; },
    });
    let dataFeeCalls = 0;
    const limits = chainId === 4663n ? undefined : { estimateDataFee: async (transaction, context) => {
      dataFeeCalls += 1;
      assert.equal(context.client, source, "External callbacks keep the original source, not the private read owner");
      assert.equal(context.block.hash, HASH);
      assert.equal(transaction.gas, 1_150_000n);
      return 5n;
    } };
    const planned = await review(source, plan, { mode: "staged", limits });
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.executionProof, "failed");
    assert.equal(planned.simulation.protocolFit, "unknown");
    assert.equal(planned.simulation.failedTransactionId, "activate");
    assert.deepEqual(planned.simulation.steps.map((step) => step.success), chainId === 4663n ? [true, false] : [true, true, false]);
    assert.equal(planned.simulation.steps.at(-1).nativeErrorCode, 3);
    assert.equal(planned.simulation.steps.at(-1).nativeErrorKind, "execution-reverted");
    assert.equal(diagnosticJson(planned.simulation).includes(error.message), false);
    for (const step of planned.simulation.steps.slice(0, 1)) {
      assert.equal(step.estimate.gasUsed, 1_000_000n);
      assert.equal(step.estimate.gasLimit, 1_150_000n);
      assert.equal(step.estimate.gasPrice, 2n);
      assert.equal(step.estimate.executionFee, 2_300_000n);
      assert.equal(step.estimate.dataFee, chainId === 4663n ? 0n : 5n);
      assert.equal(step.estimate.totalFee, chainId === 4663n ? 2_300_000n : 2_300_005n);
      assert.equal(step.estimate.dataFeeIncludedInGas, chainId === 4663n);
      assert.equal(step.estimate.feeConfidence, "execution-and-data");
    }
    assert.ok(planned.simulation.steps.slice(1).every((step) => step.provisional && step.estimate === undefined));
    assert.equal(dataFeeCalls, chainId === 4663n ? 0 : 1);
    assert.equal(source.captured.filter((row) => row.method === "eth_getBalance").length, chainId === 4663n ? 0 : 1);
    assert.equal(economicRequests(source).length, 2);
    assert.equal(planned.simulation.blockHash, HASH);
  }
});

test("failed cancellation keeps fee estimates while healthy cancellation still requires exact real affordability", async () => {
  for (const chainId of [31337n, 4663n]) {
    const plan = makePlan({ chainId });
    const committed = { plan, planHash: hashLaunchPlan(plan), launchId: hashLaunchIdentity(plan), predictedToken: TOKEN, account: ACCOUNT, chainId, mode: "staged", confirmations: 1 };
    let dataFeeCalls = 0;
    const limits = chainId === 4663n ? undefined : { estimateDataFee: async () => { dataFeeCalls += 1; return 5n; } };
    const failed = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, replayFail: true });
    await assert.rejects(buildNextTransaction({ client: failed, planned: committed, action: "cancel", limits }), (failure) => {
      assert.equal(failure.code, "CANCEL_NOT_ADMITTED");
      const simulation = failure.simulation, step = simulation.steps[0];
      assert.equal(simulation.admitted, false);
      assert.equal(simulation.executionProof, "failed");
      assert.equal(simulation.protocolFit, "unknown");
      assert.equal(simulation.failedTransactionId, "cancel");
      assert.equal(simulation.reason, step.error);
      assert.equal(simulation.blockHash, HASH);
      assert.equal(step.success, false);
      assert.equal(step.estimate.gasUsed, 40_000n);
      assert.equal(step.estimate.gasLimit, 46_000n);
      assert.equal(step.estimate.gasPrice, 2n);
      assert.equal(step.estimate.executionFee, 92_000n);
      assert.equal(step.estimate.dataFee, chainId === 4663n ? 0n : 5n);
      assert.equal(step.estimate.totalFee, chainId === 4663n ? 92_000n : 92_005n);
      assert.equal(step.estimate.posterGas, chainId === 4663n ? 0n : undefined);
      assert.equal(step.estimate.posterFee, chainId === 4663n ? 0n : undefined);
      assert.equal(step.estimate.dataFeeIncludedInGas, chainId === 4663n);
      assert.equal(step.estimate.feeConfidence, "execution-and-data");
      return true;
    });
    assert.equal(dataFeeCalls, chainId === 4663n ? 0 : 1);
    assert.equal(failed.captured.filter((row) => row.method === "eth_getBalance").length, chainId === 4663n ? 0 : 1);
    assert.equal(economicRequests(failed).length, 2);
    const required = chainId === 4663n ? 92_000n : 92_005n;
    const healthy = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, balance: required });
    const next = await buildNextTransaction({ client: healthy, planned: committed, action: "cancel", limits });
    assert.equal(next.kind, "cancel");
    assert.equal(next.gas, 46_000n);
    assert.equal(next.estimate.totalFee, required);
    assert.equal(healthy.captured.filter((row) => row.method === "eth_getBalance").length, chainId === 4663n ? 0 : 1);
    const poor = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, balance: 80_000n - 1n });
    await assert.rejects(buildNextTransaction({ client: poor, planned: committed, action: "cancel", limits }), { code: "CANCEL_NOT_ADMITTED" });
    assert.equal(poor.captured.filter((row) => row.method === "eth_getBalance").length, chainId === 4663n ? 0 : 1, "Success observations cannot bypass the real fee reserve");
  }
});

test("failed replay keeps missing-data-fee uncertainty and validates callbacks and uint256 fee envelopes", async () => {
  const plan = makePlan();
  const committed = { plan, planHash: hashLaunchPlan(plan), launchId: hashLaunchIdentity(plan), predictedToken: TOKEN, account: ACCOUNT, chainId: plan.chainId, mode: "staged", confirmations: 1 };
  const missing = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, replayFail: true });
  await assert.rejects(buildNextTransaction({ client: missing, planned: committed, action: "cancel" }), (failure) => {
    assert.equal(failure.code, "CANCEL_NOT_ADMITTED");
    const estimate = failure.simulation.steps[0].estimate;
    assert.equal(estimate.executionFee, 92_000n);
    assert.equal(estimate.dataFee, undefined);
    assert.equal(estimate.totalFee, undefined);
    assert.equal(estimate.feeConfidence, "execution-only");
    return true;
  });
  assert.equal(missing.captured.filter((row) => row.method === "eth_getBalance").length, 1);
  for (const dataFee of ["5", -1n, 1n << 256n, (1n << 256n) - 1n]) {
    const client = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, replayFail: true });
    let calls = 0;
    await assert.rejects(buildNextTransaction({ client, planned: committed, action: "cancel",
      limits: { estimateDataFee: async () => { calls += 1; return dataFee; } },
    }), { code: dataFee === (1n << 256n) - 1n ? "INVALID_GAS_ENVELOPE" : "INVALID_DATA_FEE" });
    assert.equal(calls, 1, "Returned failure must not discard external data-fee observation and validation");
    assert.equal(client.captured.filter((row) => row.method === "eth_getBalance").length, 1);
  }
  const overflow = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n, gasPrice: (1n << 256n) - 1n, replayFail: true });
  await assert.rejects(buildNextTransaction({ client: overflow, planned: committed, action: "cancel" }), { code: "INVALID_GAS_ENVELOPE" });
  assert.equal(overflow.captured.filter((row) => row.method === "eth_getBalance").length, 0);
});



test("standalone cancellation simulation re-observes fees and account code for every invocation", async () => {
  for (const supportsReadBatching of [false, true]) {
    const plan = makePlan(), client = clientFor(plan, { phase: LifecyclePhase.Preparing, computeUsed: 40_000n });
    client.supportsReadBatching = supportsReadBatching;
    const committed = { plan, planHash: hashLaunchPlan(plan), launchId: hashLaunchIdentity(plan), predictedToken: TOKEN, account: ACCOUNT, chainId: plan.chainId, mode: "staged", confirmations: 1 };
    const first = await buildNextTransaction({ client, planned: committed, action: "cancel" });
    assert.equal(first.gasPrice, 2n);
    client.state.gasPrice = 7n;
    const refreshed = await buildNextTransaction({ client, planned: committed, action: "cancel" });
    assert.equal(refreshed.gasPrice, 7n);
    assert.equal(refreshed.estimate.executionFee, refreshed.gas * 7n);
    client.state.accountCode = CODE;
    await assert.rejects(buildNextTransaction({ client: { request: (args) => client.request(args) }, planned: committed, action: "cancel" }), (failure) => {
      assert.equal(failure.code, "CANCEL_NOT_ADMITTED");
      assert.equal(failure.simulation.confidence, "provisional");
      assert.match(failure.simulation.reason, /smart-account/);
      return true;
    });
  }
});

test("atomic remains explicit and staged partitions only empty preparations, never complete activation", async () => {
  const plan = makePlan({ markets: 2 });
  const gasFor = (name, args) => name === "launchAtomic" ? 4_000_000n : name === "prepareMarkets" ? BigInt(args[2]) * 1_100_000n : 400_000n;
  const client = clientFor(plan, { gasFor });
  const atomic = await review(client, plan, { limits: { chainGasLimit: 2_000_000n } });
  assert.equal(atomic.simulation.admitted, false); assert.equal(atomic.mode, "atomic"); assert.deepEqual(atomic.transactions.map((tx) => tx.kind), ["atomic"]);
  const staged = await review(client, plan, { mode: "staged", limits: { chainGasLimit: 2_000_000n } });
  assert.equal(staged.simulation.admitted, true, staged.simulation.reason);
  assert.deepEqual(staged.transactions.map((tx) => tx.kind), ["begin", "prepare", "prepare", "activate"]);
  assert.deepEqual(staged.transactions.filter((tx) => tx.kind === "prepare").map((tx) => [tx.marketStart, tx.marketCount]), [[0, 1], [1, 1]]);
  assert.equal(staged.transactions.filter((tx) => tx.kind === "activate").length, 1);
  const refused = await review(clientFor(plan, { gasFor, failActivation: true }), plan, { mode: "staged", limits: { chainGasLimit: 2_000_000n } });
  assert.equal(refused.simulation.admitted, false); assert.equal(refused.simulation.failedTransactionId, "activate"); assert.match(refused.simulation.reason, /indivisible/);
  await assert.rejects(planLaunch({ client, plan, account: ACCOUNT }), { code: "EXPLICIT_MODE_REQUIRED" });
});

test("requested staged partitions share one capability but never splice prefix state or simulate atomic", async () => {
  for (const supportsReadBatching of [false, true]) {
    const plan = makePlan({ chainId: 4663n, markets: 4 }), client = clientFor(plan, {
      nativeGasCode: supportsReadBatching ? -32015 : -32000,
      gasFor: (name, args) => name === "prepareMarkets" ? BigInt(args[2]) * 18_000_000n : 400_000n,
    });
    client.supportsReadBatching = supportsReadBatching;
    const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 200_000_000n } });
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.deepEqual(planned.transactions.filter((tx) => tx.kind === "prepare").map((tx) => tx.marketCount), [1, 1, 1, 1]);
    assert.equal(Object.hasOwn(planned, "atomicAttempt"), false);
    assert.equal(capabilityRequests(client).length, 1);
    const sequences = economicRequests(client).map((row) => row.params[0]);
    assert.equal(sequences.length, 4, "Packed candidates size before the one final validated pass");
    assert.deepEqual(sequences.map((request) => request.blockStateCalls.length), [4, 5, 6, 6]);
    const capabilityChild = capabilityRequests(client)[0].params[0].blockStateCalls[0].blockOverrides;
    for (const request of sequences) {
      const calls = request.blockStateCalls.map((block, index) => {
        assert.equal(block.stateOverrides, undefined);
        assert.equal(block.blockOverrides.baseFeePerGas, undefined);
        assert.equal(BigInt(block.blockOverrides.number), BigInt(capabilityChild.number) + BigInt(index));
        assert.equal(BigInt(block.blockOverrides.time), BigInt(capabilityChild.time) + BigInt(index));
        assert.equal(block.blockOverrides.gasLimit, capabilityChild.gasLimit);
        assert.equal(block.calls.length, 1);
        return decodeFunctionData({ abi: launchLifecycleAbi, data: block.calls[0].data }).functionName;
      });
      assert.equal(calls[0], "beginLaunch");
      assert.equal(calls.at(-1), "activateLaunch");
      assert.equal(calls.filter((name) => name === "activateLaunch").length, 1);
      assert.equal(calls.includes("launchAtomic"), false);
    }
    assert.equal(sequences.at(-1).validation, true);
    assert.equal(client.captured.filter((row) => row.method === "eth_getBlockByNumber").length, 1);
    client.captured.length = 0;
    const later = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 200_000_000n } });
    assert.equal(later.simulation.admitted, true);
    assert.equal(capabilityRequests(client).length, 0, "A new review reuses only the session's backend capability");
  }
});

test("low-gas semantic preparation errors stop planning; near-ceiling failures split only packed batches", async () => {
  const known = ["0x78ca98e3", "0x9a36fd9c", encodeErrorResult({ abi: fixedFeePoolHookV1Abi, errorName: "InvalidConfiguration" }),
    encodeErrorResult({ abi: parseAbi(["error FeeBelowMinimum()"]), errorName: "FeeBelowMinimum" })];
  for (const prepareFailureData of known) {
    const plan = makePlan({ chainId: 4663n, markets: 4 }), client = clientFor(plan, { prepareFailureData });
    const planned = await review(client, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.steps.at(-1).returnData, prepareFailureData);
    assert.equal(economicRequests(client).length, 1, "Changing partition sizes cannot fix a diagnosed business/configuration refusal");
    assert.equal(planned.simulation.failureCategory, "semantic");
  }
  const plan = makePlan({ chainId: 4663n, markets: 4 }), client = clientFor(plan, {
    prepareFailureData: "0x", gasFor: (name) => name === "prepareMarkets" ? 31_900_000n : 400_000n,
  });
  const refused = await review(client, plan, { mode: "staged" });
  assert.equal(refused.simulation.admitted, false);
  assert.equal(refused.simulation.protocolFit, "unknown");
  assert.equal(refused.simulation.executionProof, "failed");
  assert.equal(refused.simulation.steps.at(-1).returnData, "0x");
  assert.equal(refused.simulation.failureCategory, "opaque");
  assert.equal(economicRequests(client).length, 2, "The packed batch splits once; a failed singleton still refuses");
  assert.equal(capabilityRequests(client).length, 1);
  assert.doesNotMatch(refused.simulation.reason, /out.of.gas|OOG|capacity/i, "Near-cap gas does not diagnose the preparation root");
});

test("actual native error.data-only first preparation invariants stop search without rewriting empty return bytes", async () => {
  const selectors = ["0x78ca98e3", "0x9a36fd9c", encodeErrorResult({ abi: fixedFeePoolHookV1Abi, errorName: "InvalidConfiguration" })];
  for (const selector of selectors) {
    for (const data of [selector, { data: selector }, { data: { data: selector } }]) {
      const plan = makePlan({ chainId: 4663n, markets: 4 });
      const error = { code: 3, message: "execution reverted", data };
      const source = clientFor(plan, { downstreamFailureData: "0x78ca98e3",
        failureFor(name) { return name === "prepareMarkets" ? { returnData: "0x", error } : undefined; },
      });
      const planned = await review(source, plan, { mode: "staged" });
      assert.equal(planned.simulation.admitted, false);
      assert.equal(planned.simulation.steps.length, 2);
      assert.equal(planned.simulation.failedTransactionId, planned.transactions.find((transaction) => transaction.kind === "prepare").id);
      assert.equal(planned.simulation.steps[0].success, true);
      const failed = planned.simulation.steps[1];
      assert.equal(failed.success, false);
      assert.equal(failed.returnData, "0x");
      assert.equal(failed.nativeErrorCode, 3);
      assert.equal(failed.nativeErrorKind, "execution-reverted");
      assert.equal(failed.nativeErrorDataBytes, 4);
      assert.ok(["InvalidPhase", "InvalidPreparationOrder", "InvalidConfiguration"].includes(failed.decodedError));
      assert.equal(diagnosticJson(planned.simulation).includes(error.message), false);
      assert.equal(economicRequests(source).length, 1, "Known primary preparation invariants cannot be repaired by smaller empty ranges");
      assert.equal(capabilityRequests(source).length, 1);
      assert.equal(planned.simulation.failureCategory, "semantic");
    }
  }
});

test("a primary begin failure cannot be reclassified by a known downstream preparation selector", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 4 });
  const error = { code: 3, message: "Primary begin execution reverted", data: "0x78ca98e3" };
  const source = clientFor(plan, { downstreamFailureData: "0x9a36fd9c",
    failureFor(name) { return name === "beginLaunch" ? { error } : undefined; },
  });
  const planned = await review(source, plan, { mode: "staged" });
  assert.equal(planned.simulation.failedTransactionId, "begin");
  assert.equal(planned.simulation.steps.length, 1);
  assert.equal(planned.simulation.steps[0].returnData, "0x");
  assert.equal(planned.simulation.steps[0].nativeErrorCode, 3);
  assert.equal(planned.simulation.steps[0].failureCategory, "semantic");
  assert.equal(diagnosticJson(planned.simulation).includes(error.message), false);
  assert.equal(economicRequests(source).length, 1);
});

test("unknown, malformed and generic native preparation roots ignore downstream order/phase selectors", async () => {
  const genericErrors = parseAbi(["error Error(string reason)", "error Panic(uint256 code)"]);
  const roots = [
    { code: 3, message: "Primary unknown preparation revert", data: "0x" },
    { code: 3, message: "Primary unknown preparation revert", data: "0xdeadbeef" },
    { code: 3, message: "Primary unknown preparation revert", data: "0x78ca98e" },
    { code: 3, message: "Primary unknown preparation revert", data: "0x78ca98zz" },
    { code: 3, message: "Primary unknown preparation revert", data: { message: "0x78ca98e3" } },
    { code: 3, message: "0x78ca98e3", originalError: { data: "0x78ca98e3" } },
    { code: 3, message: "Primary unknown preparation revert", data: encodeErrorResult({ abi: genericErrors, errorName: "Error", args: ["0x78ca98e3"] }) },
    { code: 3, message: "Primary unknown preparation revert", data: encodeErrorResult({ abi: genericErrors, errorName: "Panic", args: [0x11n] }) },
    { code: -32015, message: "out of gas: private native context", data: "0xdeadbeef" },
    { code: -32015, message: "out of gas: private native context", data: "0x78ca98zz" },
    { code: -32016, message: "out of gas: private native context", data: "0x" },
    { code: -32015, message: "out of gas: private native context (gas limit was capped by the RPC server's global gas cap)", data: "0x" },
    "0x78ca98e3",
  ];
  for (const error of roots) {
    const plan = makePlan({ chainId: 4663n, markets: 4 });
    const source = clientFor(plan, { downstreamFailureData: "0x9a36fd9c",
      failureFor(name) { return name === "prepareMarkets" ? { error } : undefined; },
    });
    const planned = await review(source, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.executionProof, "failed");
    assert.equal(planned.simulation.protocolFit, "unknown");
    assert.equal(planned.simulation.steps.length, 2, "Only the actual successful begin and first failed preparation belong to the returned prefix");
    assert.equal(planned.simulation.steps[1].returnData, "0x");
    assert.equal(planned.simulation.steps[1].nativeErrorCode, typeof error === "object" ? error.code : undefined);
    assert.notEqual(planned.simulation.failureCategory, "capacity");
    if (typeof error === "object") assert.equal(diagnosticJson(planned.simulation).includes(error.message), false);
    assert.equal(planned.simulation.failedTransactionId, planned.transactions.find((transaction) => transaction.kind === "prepare").id);
    assert.equal(economicRequests(source).length, 1, "An unknown primary root cannot authorize another partition");
    assert.equal(capabilityRequests(source).length, 1);
    assert.notEqual(planned.simulation.steps[1].decodedError, "InvalidPreparationOrder", "A downstream selector is never the primary diagnosis");
    const capped = typeof error === "object" && error.message.endsWith(" (gas limit was capped by the RPC server's global gas cap)");
    assert.equal(planned.simulation.steps[1].nativeGasCapped, capped);
    if (capped) {
      assert.equal(planned.simulation.failureCategory, "source");
      assert.equal(planned.simulation.steps[1].nativeErrorKind, "out-of-gas");
    }
  }
});

test("non-invariant native returnData takes precedence over known error.data without authorizing partitioning", async () => {
  for (const [returnData, expectedCategory] of [
    ["0x", "semantic"],
    ["0xdeadbeef", "opaque"],
  ]) {
    const plan = makePlan({ chainId: 4663n, markets: 4 });
    const error = { code: 3, message: "Primary preparation revert", data: encodeErrorResult({ abi: fixedFeePoolHookV1Abi, errorName: "InvalidConfiguration" }) };
    const source = clientFor(plan, { downstreamFailureData: "0x9a36fd9c",
      failureFor(name) { return name === "prepareMarkets" ? { returnData, error } : undefined; },
    });
    const planned = await review(source, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.backend, "eth_simulateV1");
    assert.equal(planned.simulation.confidence, "stateful");
    assert.equal(planned.simulation.executionProof, "failed");
    assert.equal(planned.simulation.protocolFit, "unknown");
    assert.equal(planned.simulation.transportPreflight, "not-requested");
    assert.equal(planned.simulation.failureCategory, expectedCategory);
    assert.deepEqual(planned.transactions.filter((transaction) => transaction.kind === "prepare").map((transaction) => [transaction.marketStart, transaction.marketCount]), [[0, 2], [2, 2]]);
    const firstPreparation = planned.transactions.find((transaction) => transaction.kind === "prepare");
    assert.equal(planned.simulation.failedTransactionId, firstPreparation.id);
    assert.deepEqual(planned.simulation.steps.map((step) => [step.transactionId, step.success]), [["begin", true], [firstPreparation.id, false]]);
    assert.equal(planned.simulation.steps.at(-1).returnData, returnData);
    assert.equal(planned.simulation.steps.at(-1).nativeErrorCode, 3);
    assert.equal(planned.simulation.steps.at(-1).nativeErrorDataBytes, 4);
    assert.equal(diagnosticJson(planned.simulation).includes(error.message), false);
    const requests = economicRequests(source).map((row) => row.params[0]);
    assert.deepEqual(requests.map((request) => request.blockStateCalls.length), [2]);
    assert.ok(requests.every((request) => request.validation === false), "A failed sizing diagnostic never becomes execution admission");
    assert.equal(capabilityRequests(source).length, 1);
  }
});



test("Nitro submission preflight accepts the reviewed total envelope rather than reapplying compute as total gas", async () => {
  const plan = makePlan({ chainId: 4663n });
  const client = clientFor(plan, { computeUsed: 27_000_000n, poster: 2_000_000n });
  const planned = await review(client, plan);
  const submissionClient = submissionFor(plan, { estimate: 33_000_000n });
  const next = await buildNextTransaction({ client, planned, submissionClient });
  assert.equal(next.gas, 33_350_000n);
  assert.equal(next.admission.transportPreflight, "passed");
  assert.equal(BigInt(submissionClient.captured[1].params[0].gas), 33_350_000n);
});

test("generic EVM zero-price gas envelopes remain valid when exact validated replay accepts them", async () => {
  const plan = makePlan(), client = clientFor(plan, { gasPrice: 0n, balance: 0n });
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true);
  assert.equal((await buildNextTransaction({ client, planned, submissionClient: submissionFor(plan) })).gasPrice, 0n);
});

test("zero metering cannot admit a nonpositive reviewed gas envelope", async () => {
  for (const chainId of [31337n, 4663n]) {
    const plan = makePlan({ chainId }), client = clientFor(plan, { computeUsed: 0n });
    const planned = await review(client, plan);
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.executionProof, "unavailable");
    assert.equal(planned.simulation.protocolFit, "failed");
    assert.match(planned.simulation.reason, /compute\/complete transaction envelope/);
    await assert.rejects(buildNextTransaction({ client, planned }), { code: "PLAN_NOT_ADMITTED" });
  }
});

test("one plan shares exact pinned observations but retains every stateful replay and live canonical check", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2 }), client = clientFor(plan, { allowance: 0n });
  const planned = await review(client, plan, { mode: "staged" });
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  const getterCount = (abi, name) => client.captured.filter((row) => {
    if (row.method !== "eth_call") return false;
    try { return decodeFunctionData({ abi, data: row.params[0].data }).functionName === name; } catch { return false; }
  }).length;
  assert.equal(getterCount(launchLifecycleAbi, "predictToken"), 0);
  assert.equal(getterCount(launchLifecycleAbi, "registry"), 1);
  assert.equal(getterCount(lifecycleRegistryAbi, "requireEligible"), 1);
  for (const name of ["getMaxTxGasLimit", "getMaxBlockGasLimit"]) assert.equal(getterCount(gasInfoAbi, name), 0);
  assert.equal(getterCount(arbSysAbi, "arbOSVersion"), 0);
  assert.equal(client.captured.filter((row) => row.method === "eth_call" && row.params[0].to.toLowerCase() === MULTICALL3).length, 1);
  assert.equal(client.captured.filter((row) => row.method === "eth_getCode" && row.params[0].toLowerCase() === ADAPTER).length, 1);
  assert.equal(client.captured.filter((row) => row.method === "eth_getBalance" && row.params[0].toLowerCase() === ACCOUNT).length, 0);
  const simulations = client.captured.filter((row) => row.method === "eth_simulateV1");
  assert.equal(simulations.length, 3, "One session capability, unhinted sizing and exact validated execution");
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [false, true]);
  assert.equal(client.captured.filter((row) => row.method === "eth_getBlockByNumber").length, 1);
});

test("domain, profile certification and funding getter rounds overlap with a bounded batching-capable client", async () => {
  const plan = makePlan({ markets: 7 }), source = clientFor(plan);
  let active = 0, peak = 0;
  const rounds = [];
  const client = { supportsReadBatching: true, async request(args) {
    active += 1; peak = Math.max(peak, active);
    rounds.push({ method: args.method, active });
    await nextTurn();
    try { return await source.request(args); } finally { active -= 1; }
  } };
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.ok(peak > 1, "Independent getters must start before earlier responses settle");
  assert.ok(peak <= 8, `Invocation issued ${peak} concurrent requests`);
  assert.ok(rounds.some((row) => row.method === "eth_call" && row.active > 1));

  for (const names of [["balanceOf", "allowance"]]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = [];
    const gated = { supportsReadBatching: true, async request(args) {
      if (args.method === "eth_call") {
        for (const abi of [launchLifecycleAbi, lifecycleErc20Abi, abyssLifecycleAdapterAbi]) {
          let call;
          try { call = decodeFunctionData({ abi, data: args.params[0].data }); } catch { continue; }
          if (names.includes(call.functionName)) { started.push(call.functionName); await gate; }
          break;
        }
      }
      return source.request(args);
    } };
    const pending = review(gated, plan);
    await nextTurn();
    const observed = [...started];
    release();
    assert.equal((await pending).simulation.admitted, true);
    for (const name of names) assert.ok(observed.includes(name), `${name} starts in the same independent dependency round`);
  }
});

test("selected Abyss profile keeps independent registry reads concurrent", async () => {
  const plan = makePlan({ chainId: 4663n });
  const abi = [...launchLifecycleAbi, ...lifecycleRegistryAbi, ...abyssLifecycleAdapterAbi, ...lifecycleAdapterAbi];
  const cases = [
    { blocked: `${REGISTRY}:core`, expected: [`${REGISTRY}:profile`] },
    { blocked: `${REGISTRY}:adapter`, expected: [`${REGISTRY}:profileTopology`, `${REGISTRY}:requireEligible`] },
    { blocked: `${REGISTRY}:profileTopology`, expected: [`${REGISTRY}:adapter`, `${REGISTRY}:requireEligible`] },
  ];
  for (const { blocked, expected } of cases) {
    const source = clientFor(plan);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Set();
    const client = { supportsReadBatching: true, async request(args) {
      if (args.method === "eth_call" || args.method === "eth_getCode") {
        const target = args.method === "eth_call" ? args.params[0].to : args.params[0];
        const name = args.method === "eth_call" ? decodeFunctionData({ abi, data: args.params[0].data }).functionName : args.method;
        const key = `${target.toLowerCase()}:${name}`;
        started.add(key);
        if (key === blocked) await gate;
      }
      return source.request(args);
    } };
    const pending = readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
    await nextTurn();
    const observed = new Set(started);
    release();
    const [profile] = await pending;
    assert.equal(profile.admitted, true, profile.reason);
    for (const key of expected) assert.equal(observed.has(key), true, `${key} has no dependency on ${blocked}`);
    assert.equal(source.captured.some((row) => row.method === "eth_call" && row.params[0].to === REGISTRY &&
      decodeFunctionData({ abi: lifecycleRegistryAbi, data: row.params[0].data }).functionName === "protocolMaximumDeveloperFeeBps"), false);
  }
});

test("trusted registry eligibility proves live adapter state without duplicate implementation probes", async () => {
  const plan = makePlan({ chainId: 4663n });
  const cases = [
    { settings: {}, admitted: true },
    { settings: { codeFor: (target) => target.toLowerCase() === ADAPTER ? "0x" : CODE }, admitted: false },
    { settings: { codeFor: (target) => target.toLowerCase() === ADAPTER ? "0x600260005560026000f3" : CODE }, admitted: false },
    { settings: { authorities: { [ADAPTER]: address(0xff) } }, admitted: false },
    { settings: { graphDigest: FOREIGN_HASH }, admitted: false },
    { settings: { adapterOverrides: { enabled: false } }, admitted: false },
    { settings: { profileOverrides: { enabled: false } }, admitted: false },
    { settings: { adapterOverrides: { capabilities: 0n } }, admitted: false },
    { settings: { profileOverrides: { capabilities: 0n } }, admitted: false },
  ];
  for (const { settings, admitted } of cases) {
    const source = clientFor(plan, settings);
    const client = { supportsReadBatching: true, request(args) {
      if (args.method === "eth_getCode" && [ADAPTER, FACTORY].includes(args.params[0].toLowerCase())) throw new Error("Already-certified runtime probe is unavailable");
      if (args.method === "eth_call" && args.params[0].to.toLowerCase() === ADAPTER) {
        const name = decodeFunctionData({ abi: abyssLifecycleAdapterAbi, data: args.params[0].data }).functionName;
        if (["core", "dependencyDigest", "factory", "CONFIG_SCHEMA", "CONFIG_VERSION"].includes(name)) throw new Error("Already-certified adapter metadata probe is unavailable");
      }
      return source.request(args);
    } };
    const [profile] = await readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
    assert.equal(profile.admitted, admitted, profile.reason);
    if (!admitted) assert.ok(profile.reason);
  }
});

test("certified Abyss discovery still rejects mismatched canonical registry identities", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const profileOverrides of [{ factory: address(0xff) }, { venue: address(0xff) }, { hook: address(0xff) }]) {
    const client = clientFor(plan, { profileOverrides });
    const [profile] = await readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
    assert.equal(profile.admitted, false);
    assert.ok(profile.reason);
  }
});

test("overlapped Abyss eligibility rejects changed canonical identity or topology without retrying", async () => {
  const plan = makePlan({ chainId: 4663n });
  for (const supportsReadBatching of [false, true]) {
    for (const { settings = {}, topology, mismatch = false, malformed = false, eligibilityCalls = 1 } of [
      { settings: { profileOverrides: { configSchema: FOREIGN_HASH } }, eligibilityCalls: 0 },
      { settings: { adapterOverrides: { configVersion: 2 } } },
      { settings: { profileOverrides: { factory: address(1) } } },
      { topology: { hookTopology: 1 } },
      { topology: { configVersion: 2 } },
      { topology: { hookDeployer: ADAPTER } },
      { topology: { hookCreationCodeHash: HASH } },
      { mismatch: true },
      { malformed: true },
      {},
    ]) {
      const source = clientFor(plan, settings);
      let observedEligibility = 0;
      const client = { supportsReadBatching, async request(args) {
        if (args.method === "eth_call" && args.params[0].to === REGISTRY) {
          const call = decodeFunctionData({ abi: lifecycleRegistryAbi, data: args.params[0].data });
          if (call.functionName === "profileTopology" && topology) return encodeFunctionResult({
            abi: lifecycleRegistryAbi, functionName: call.functionName,
            result: { hookTopology: 0, configVersion: 1, hookDeployer: zeroAddress, hookCreationCodeHash: zeroHash, ...topology },
          });
          if (call.functionName === "requireEligible") {
            observedEligibility += 1;
            assert.deepEqual(call.args, [plan.markets[0].adapterId, plan.markets[0].profileId, 1, LIFECYCLE_REQUIRED_CAPABILITIES]);
            assert.equal(args.params[1], "0x2a");
            if (mismatch) return encodeFunctionResult({ abi: lifecycleRegistryAbi, functionName: call.functionName, result: address(1) });
            if (malformed) return "0x";
            throw new Error("Pinned eligibility read failed");
          }
        }
        return source.request(args);
      } };
      const [profile] = await readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
      assert.equal(profile.admitted, false);
      assert.equal(observedEligibility, eligibilityCalls, "Early refusal is consumed once, never warmed and retried");
      assert.ok(profile.reason);
      assert.equal(profile.reason.includes("Pinned eligibility read failed"), false);
      assert.equal(economicRequests(source).length, 0);
    }
  }
});

test("an early Abyss eligibility rejection stays handled while adapter metadata is pending", async () => {
  const plan = makePlan(), source = clientFor(plan);
  const failure = new Error("Pinned eligibility temporarily unavailable");
  let release, fail = true, attempts = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const unhandled = [];
  const observeUnhandled = (error) => unhandled.push(error);
  const client = { supportsReadBatching: true, async request(args) {
    if (args.method === "eth_call" && args.params[0].to === REGISTRY) {
      const call = decodeFunctionData({ abi: lifecycleRegistryAbi, data: args.params[0].data });
      if (call.functionName === "adapter") await gate;
      if (call.functionName === "requireEligible") {
        attempts += 1;
        if (fail) throw failure;
      }
    }
    return source.request(args);
  } };
  process.on("unhandledRejection", observeUnhandled);
  try {
    const pending = readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
    const result = pending.then((profiles) => ({ profiles }), (error) => ({ error }));
    await nextTurn();
    const attemptsBeforeMetadata = attempts;
    await nextTurn();
    release();
    const settled = await result;
    assert.equal(settled.error, undefined);
    assert.equal(attemptsBeforeMetadata, 1, "The exact eligibility observation does not await adapter metadata");
    assert.equal(attempts, 1, "Certification must consume the recorded refusal, not retry it");
    assert.equal(settled.profiles[0].admitted, false);
    assert.ok(settled.profiles[0].reason);
    assert.equal(settled.profiles[0].reason.includes(failure.message), false);
    assert.deepEqual(unhandled, []);
    fail = false;
    assert.equal((await readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] }))[0].admitted, true);
    assert.equal(attempts, 2, "A separate public invocation starts its own fresh eligibility proof");
  } finally {
    release();
    process.off("unhandledRejection", observeUnhandled);
  }
});

test("late Abyss eligibility failure cannot replace metadata errors or escape its settled owner", async () => {
  const plan = makePlan();
  for (const failedMetadata of ["adapter", "profileTopology"]) {
    const source = clientFor(plan), metadataFailure = new Error(`Pinned ${failedMetadata} unavailable`);
    const eligibilityFailure = Object.assign(new Error("Eligibility read cancelled after metadata refusal"), { name: "AbortError" });
    let releaseMetadata, releaseEligibility, eligibilityStarted = false;
    const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
    const eligibilityGate = new Promise((resolve) => { releaseEligibility = resolve; });
    const unhandled = [];
    const observeUnhandled = (error) => unhandled.push(error);
    const client = { supportsReadBatching: true, async request(args) {
      if (args.method === "eth_call" && args.params[0].to === REGISTRY) {
        const call = decodeFunctionData({ abi: lifecycleRegistryAbi, data: args.params[0].data });
        if (call.functionName === failedMetadata) {
          await metadataGate;
          throw metadataFailure;
        }
        if (call.functionName === "requireEligible") {
          eligibilityStarted = true;
          await eligibilityGate;
          throw eligibilityFailure;
        }
      }
      return source.request(args);
    } };
    process.on("unhandledRejection", observeUnhandled);
    try {
      const pending = readLifecycleProfiles({ client, orchestrator: CORE, profileIds: [plan.markets[0].profileId] });
      const result = pending.then((profiles) => ({ profiles }), (error) => ({ error }));
      await nextTurn();
      const startedBeforeRefusal = eligibilityStarted;
      releaseMetadata();
      const settled = await result;
      releaseEligibility();
      await nextTurn();
      await nextTurn();
      assert.equal(startedBeforeRefusal, true);
      if (failedMetadata === "adapter") assert.equal(settled.error, metadataFailure, "Adapter source failure remains an invocation error");
      else {
        assert.equal(settled.error, undefined);
        assert.equal(settled.profiles[0].admitted, false);
        assert.ok(settled.profiles[0].reason, "Topology refusal remains attached to the profile");
        assert.equal(settled.profiles[0].reason.includes(metadataFailure.message), false);
      }
      assert.deepEqual(unhandled, [], "Late abort stays observed even after the private read owner closes");
    } finally {
      releaseMetadata();
      releaseEligibility();
      process.off("unhandledRejection", observeUnhandled);
    }
  }
});




test("funding totals remain exact when parallel conversions share an input and need zero-first approval", async () => {
  const plan = makePlan({ markets: 2 });
  const inputAsset = address(0x30), target = address(0xfc);
  plan.funding = plan.funding.map((funding) => ({ ...funding, kind: 2, inputAsset, inputAmount: 20n, target, data: "0x1234" }));
  const client = clientFor(plan, { allowance: 1n });
  const planned = await review(client, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.deepEqual(planned.transactions.map((tx) => tx.kind), ["approve-reset", "approve", "atomic"]);
  const [spender, amount] = decodeFunctionData({ abi: lifecycleErc20Abi, data: planned.transactions[1].data }).args;
  assert.equal(spender.toLowerCase(), ESCROW.toLowerCase());
  assert.equal(amount, 40n);
  assert.deepEqual(planned.prerequisites.map((row) => [row.requiredInput, row.inputBalance, row.allowance]), [[20n, 1000n, 1n], [20n, 1000n, 1n]]);
  for (const name of ["balanceOf", "allowance"]) {
    const rows = client.captured.filter((row) => row.method === "eth_call" && row.params[0].to === inputAsset && decodeFunctionData({ abi: lifecycleErc20Abi, data: row.params[0].data }).functionName === name);
    assert.equal(rows.length, 1);
  }
  client.state.tokenBalance = 39n;
  const insufficient = await review(client, plan);
  assert.equal(insufficient.simulation.admitted, false);
  assert.equal(insufficient.simulation.executionProof, "failed");
  assert.equal(insufficient.simulation.failureCategory, "semantic");
  assert.equal(insufficient.simulation.steps.at(-1).success, false, "The committed core transfer, not a balance getter, refuses insufficient combined funding");
});

test("fresh invocations cannot reuse superseded code or registry and token-factory authority", async () => {
  const plan = makePlan(), client = clientFor(plan);
  const baseline = await review(client, plan);
  assert.equal(baseline.simulation.admitted, true);
  client.state.codeFor = (target) => target.toLowerCase() === ADAPTER ? "0x600260005560026000f3" : target.toLowerCase() === ACCOUNT ? "0x" : CODE;
  const changed = await review(client, plan);
  assert.equal(changed.simulation.admitted, false);
  assert.equal(changed.simulation.failureCategory, "semantic");
  delete client.state.codeFor;
  client.state.authorities = { [REGISTRY]: address(0xff) };
  await assert.rejects(review(client, plan), { code: "REGISTRY_BINDING" });
  client.state.authorities = { [ADAPTER]: address(0xff) };
  await assert.rejects(review(client, plan), { code: "TOKEN_FACTORY_BINDING" });
});

test("a failed parallel funding observation is visible unchanged and a fresh invocation can recover", async () => {
  const plan = makePlan(), source = clientFor(plan), failure = new Error("Pinned funding allowance is unavailable");
  let fail = true;
  const client = { request(args) {
    if (args.method === "eth_call" && args.params[0].to === plan.funding[0].inputAsset && decodeFunctionData({ abi: lifecycleErc20Abi, data: args.params[0].data }).functionName === "allowance" && fail) return Promise.reject(failure);
    return source.request(args);
  } };
  await assert.rejects(review(client, plan), (error) => error === failure);
  fail = false;
  assert.equal((await review(client, plan)).simulation.admitted, true);
});

test("partial profile failure stays attached to its row without certifying it or hiding healthy profiles", async () => {
  const plan = makePlan(), source = clientFor(plan);
  const profileIds = [0, 1, 2, 3].map((variant) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint8" }], [keccak256(stringToHex("BLACK_MARKET_ABYSS_CANONICAL_PROFILE_V1")), plan.chainId, FACTORY, variant])));
  const client = { request(args) {
    if (args.method === "eth_call" && args.params[0].to === REGISTRY) {
      const call = decodeFunctionData({ abi: lifecycleRegistryAbi, data: args.params[0].data });
      if (call.functionName === "profileTopology" && call.args[0] === profileIds[1]) return Promise.reject(new Error("This pinned topology is unavailable"));
    }
    return source.request(args);
  } };
  const rows = await readLifecycleProfiles({ client, orchestrator: CORE, profileIds });
  assert.deepEqual(rows.map((row) => row.id), profileIds);
  assert.deepEqual(rows.map((row) => row.admitted), [true, false, true, true]);
  assert.ok(rows[1].reason);
  assert.equal(rows[1].reason.includes("This pinned topology is unavailable"), false);
});

test("input mutation while getters are outstanding makes the result obsolete instead of executable", async () => {
  const plan = makePlan(), source = clientFor(plan);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = { async request(args) {
    if (args.method === "eth_call" && args.params[0].to === plan.funding[0].inputAsset && decodeFunctionData({ abi: lifecycleErc20Abi, data: args.params[0].data }).functionName === "allowance") await gate;
    return source.request(args);
  } };
  const pending = review(client, plan);
  await nextTurn();
  plan.buys[0].minTokenOut = 6n;
  release();
  await assert.rejects(pending, { code: "PLAN_MUTATED" });
  assert.equal((await review(client, plan)).simulation.admitted, true);
});

test("an invocation-local read wrapper cannot disguise a source RPC as a disposable fork", async () => {
  const plan = makePlan(), client = clientFor(plan);
  await assert.rejects(review(client, plan, { fork: { client, isolation: "disposable", allowTransactions: true } }), { code: "UNSAFE_FORK" });
  assert.equal(client.captured.some((row) => row.method === "eth_simulateV1"), false);
});

function knownAbyssPlan() {
  const plan = makePlan({ chainId: 4663n });
  plan.orchestrator = "0x91560876033d568d25CDe98C78c33ff8FC43962c";
  const preset = getKnownLifecycleProfile({ chainId: plan.chainId, orchestrator: plan.orchestrator, key: KnownLifecycleProfile.Abyss3 });
  plan.markets = plan.markets.map((market) => ({ ...market, adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id }));
  return plan;
}

test("known-preset ordered buys use exact receipt floors and prove only the final protected commitment", async () => {
  for (const mode of ["atomic", "staged"]) {
    const plan = knownAbyssPlan();
    plan.token.supply = 10n ** 27n;
    plan.markets[0].tokenBudget = plan.token.supply;
    const config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config,
      positions: config.positions.map((position) => ({ ...position, tokenAmountMaximum: plan.token.supply })) });
    plan.buys = [3n, 7n].map((quoteAmountIn) => ({ ...plan.buys[0], quoteAmountIn }));
    const original = hashLaunchPlan(plan);
    const outputs = [10001n, 900719925474099300001n];
    const client = clientFor(plan, { quoteSpent: [3n, 7n], tokenOut: () => outputs });
    const planned = await prepareAndPlanLifecycleLaunch({ client, account: ACCOUNT, plan, mode, buySlippageBps: 50 });
    assert.equal(hashLaunchPlan(plan), original, "Calibration never mutates the consumer draft");
    assert.deepEqual(planned.plan.buys.map((buy) => buy.minTokenOut), [9950n, 896216325846728803500n]);
    assert.deepEqual(planned.plan.buys.map(({ minTokenOut, ...buy }) => buy), plan.buys.map(({ minTokenOut, ...buy }) => buy));
    assert.notEqual(planned.planHash, original);
    assert.equal(planned.planHash, hashLaunchPlan(planned.plan));
    assert.equal(planned.simulation.admitted, true);
    assert.equal(planned.simulation.executionProof, "proved");
    assert.equal(planned.simulation.protocolFit, "proved");
    assert.ok(planned.profiles.every((profile) => profile.metadataSource === "preset" && !Object.hasOwn(profile, "admitted")),
      "Construction metadata is not a current-state admission certificate");
    const requests = economicRequests(client).map((row) => row.params[0]);
    assert.deepEqual(requests.map((request) => request.validation), [false, true]);
    const committed = requests.map((request) => {
      const last = request.blockStateCalls.at(-1).calls[0];
      return decodeFunctionData({ abi: launchLifecycleAbi, data: last.data }).args[0];
    });
    assert.deepEqual(committed[0].buys.map((buy) => buy.minTokenOut), [1n, 1n]);
    assert.equal(hashLaunchPlan(committed[1]), planned.planHash);
    assert.equal(capabilityRequests(client).length, 1);
    const registry = getKnownLifecycleDeployment({ chainId: plan.chainId, orchestrator: plan.orchestrator }).registry;
    assert.equal(client.captured.some((row) => row.method === "eth_call" && row.params[0].to.toLowerCase() === registry.toLowerCase()), false);
  }
});

test("calibration refuses dust, failed diagnostics and protected replay failures without returning an executable diagnostic", async () => {
  for (const { settings, bps = 50, code } of [
    { settings: { tokenOut: () => [1n] }, code: "INVALID_BUY_OUTPUT" },
    { settings: { failActivation: true }, code: "LAUNCH_DIAGNOSTIC_FAILED" },
    { settings: { replayFail: true }, code: "PROTECTED_PLAN_NOT_ADMITTED" },
    { settings: { tokenOut: (_plan, validation) => validation ? [5n] : [10001n] }, code: "PROTECTED_PLAN_NOT_ADMITTED" },
  ]) {
    const plan = knownAbyssPlan(), client = clientFor(plan, settings);
    await assert.rejects(prepareAndPlanLifecycleLaunch({ client, account: ACCOUNT, plan, mode: "atomic", buySlippageBps: bps }), { code });
    assert.ok(economicRequests(client).length <= 3, "Refused calibration cannot retry or change execution mode");
    assert.ok(economicRequests(client).every((row) => row.params[0].blockStateCalls.length === 1));
  }
  for (const [bps, minimum] of [[0, 10001n], [9999, 1n]]) {
    const plan = knownAbyssPlan(), client = clientFor(plan, { tokenOut: () => [10001n] });
    const planned = await prepareAndPlanLifecycleLaunch({ client, account: ACCOUNT, plan, mode: "atomic", buySlippageBps: bps });
    assert.equal(planned.plan.buys[0].minTokenOut, minimum);
    assert.equal(planned.simulation.executionProof, "proved");
  }
});

test("activation receipts must report exactly the committed total positions, not the market count", async () => {
  for (const mode of ["atomic", "staged"]) {
    const plan = makePlan();
    const config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
    plan.markets[0].tokenBudget = 200n;
    plan.token.supply = plan.markets[0].tokenBudget;
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, positions: [
      ...config.positions, { ...config.positions[0], tickLower: 120, tickUpper: 180 },
    ] });
    assert.equal((await review(clientFor(plan), plan, { mode })).simulation.admitted, true);
    for (const receiptPositionCount of [0, 1, 3]) {
      const planned = await review(clientFor(plan, { receiptPositionCount }), plan, { mode });
      assert.equal(planned.simulation.admitted, false);
      assert.equal(planned.simulation.failureCategory, "postcondition");
      assert.equal(planned.simulation.executionProof, "failed");
    }
  }
});

test("activation events independently bind exact committed position and market counts", async () => {
  for (const mode of ["atomic", "staged"]) {
    const plan = makePlan();
    for (const settings of [{ eventPositionCount: 0 }, { eventPositionCount: 2 }, { eventMarketCount: 0 }, { eventMarketCount: 2 }]) {
      const planned = await review(clientFor(plan, settings), plan, { mode });
      assert.equal(planned.simulation.admitted, false);
      assert.equal(planned.simulation.failureCategory, "postcondition");
      assert.equal(planned.simulation.executionProof, "failed", "A correct return tuple cannot replace the actual activation event");
    }
  }
});

test("aborted prepared continuations close permanently and never resume a later economic phase", async () => {
  for (const stage of ["capability", "measurement"]) {
    const plan = makePlan({ chainId: 4663n }), seed = clientFor(plan);
    const planned = await review(seed, plan), source = clientFor(plan), stop = new AbortController();
    const client = { supportsReadBatching: true, async request(args) {
      const result = await source.request(args);
      if (args.method === "eth_simulateV1") {
        const current = args.params[0].blockStateCalls[0].calls[0].to === ARB_SYS ? "capability" :
          "measurement";
        if (current === stage) stop.abort();
      }
      return result;
    } };
    await withLifecycleReadClient(client, async (scoped) => {
      const prepared = prepareLaunchSimulation({ client: scoped, planned, signal: stop.signal }, await readLifecycleBlock(scoped));
      try {
        await assert.rejects(prepared(planned.transactions), { name: "AbortError" });
        const observed = source.captured.length;
        await assert.rejects(prepared(planned.transactions), { code: "INVALID_SIMULATION" });
        assert.equal(source.captured.length, observed, "Closed work cannot restart after cancellation");
      } finally { prepared.close(); }
    });
    assert.equal(economicRequests(source).length, stage === "capability" ? 0 : 1);
  }
});

test("native prerequisite and proof catch branches expose refusal without private provider messages", async () => {
  for (const stage of ["capability", "poster", "measurement"]) {
    const plan = makePlan({ chainId: 4663n });
    const source = clientFor(plan, { gasFor: (_name, _args, validation) => validation ? 1_500_000n : 1_000_000n });
    const sentinel = `private-provider-context-${stage}`;
    const failure = Object.assign(new Error(sentinel), { status: 503, code: -32015, data: "0x" });
    let economic = 0;
    const client = { supportsReadBatching: true, async request(args) {
      let current;
      if (args.method === "eth_call" && args.params[0].to === NODE_INTERFACE) current = "poster";
      if (args.method === "eth_simulateV1") current = args.params[0].blockStateCalls[0].calls[0].to === ARB_SYS ? "capability" :
        ++economic === 1 ? "measurement" : economic === 2 ? "replay" : "envelope";
      if (current === stage) {
        source.captured.push(args);
        throw failure;
      }
      return source.request(args);
    } };
    const planned = await review(client, plan);
    assert.equal(planned.simulation.admitted, false);
    assert.equal(planned.simulation.executionProof, "unavailable");
    assert.equal(planned.simulation.confidence, "provisional");
    assert.equal(diagnosticJson(planned.simulation).includes(sentinel), false, `${stage} cannot echo private provider messages`);
    assert.equal(economic, stage === "capability" || stage === "poster" ? 0 : 1,
      "A provider failure cannot authorize another economic pass");
  }
});

for (const token0 of [true, false]) {
  test(`0.01% token${token0 ? 0 : 1} recipes produce spacing-one ranges admitted by lifecycle planning`, async () => {
    const plan = makePlan({ chainId: 4663n, token0 });
    const budget = 100n * 10n ** 18n;
    plan.token.supply = budget;
    plan.markets[0].tokenBudget = budget;
    const recipe = deriveLaunchPoolRecipe({
      pairedTokenDecimals: 18, pairedTokenUsdPriceX18: 10n ** 18n,
      targetMarketCapUsdX18: 5n * 10n ** 18n, supply: budget, tokenBudget: budget,
      launchedTokenIsQuote: token0, fee: 100,
    });
    const ranges = deriveLaunchPositionRanges({
      launchSqrtPriceX96: recipe.launchSqrtPriceX96, launchedTokenIsQuote: token0,
      tokenBudget: budget, tickSpacing: 1, venue: "abyss",
      distributionPreset: "staircase", positionCount: 3, positionGaps: "adjacent",
    });
    assert.equal(ranges.boundaryTick, token0 ? 887272 : -887272);
    assert.equal(ranges.tokenAmountMaximum, budget);
    assert.equal(ranges.positions.length, 3);
    const config = { ...decodeAbyssLifecycleMarketConfig(plan.markets[0].config), fee: 100,
      openingSqrtPriceX96: recipe.launchSqrtPriceX96,
      positions: ranges.positions.map((position) => ({ tickLower: position.tickLower, tickUpper: position.tickUpper,
        liquidity: position.liquidity, tokenAmountMaximum: position.maxTokenAmount })) };
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig(config);
    for (const mode of ["atomic", "staged"]) {
      const planned = await review(clientFor(plan), plan, { mode });
      assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
      assert.equal(planned.planHash, hashLaunchPlan(plan));
      for (const transaction of planned.transactions.filter((transaction) => transaction.to.toLowerCase() === CORE)) {
        const committed = decodeFunctionData({ abi: launchLifecycleAbi, data: transaction.data }).args[0];
        assert.equal(hashLaunchPlan(committed), hashLaunchPlan(plan));
      }
    }
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, fee: 101 });
    await assert.rejects(review(clientFor(plan), plan), { code: "INVALID_MARKET" });
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config,
      positions: config.positions.map((position, index) => index === config.positions.length - 1
        ? { ...position, ...(token0 ? { tickUpper: 887271 } : { tickLower: -887271 }) } : position) });
    await assert.rejects(review(clientFor(plan), plan), { code: "MISSING_PERMANENT_TAIL" });
  });
}

for (const token0 of [true, false]) {
  for (const mode of ["atomic", "staged"]) {
    test(`token${token0 ? 0 : 1} ${mode} planning requires a permanent tail and preserves explicit tail opt-out through recovery`, async () => {
      const plan = makePlan({ token0 });
      const config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
      plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, positions: config.positions.map((position) => ({
        ...position, tickLower: token0 ? 0 : -120, tickUpper: token0 ? 120 : 0,
      })) });
      const commitment = hashLaunchPlan(plan);
      for (const operation of [planLaunch, prepareAndPlanLifecycleLaunch]) {
        for (const allowTopologyGaps of [false, true]) {
          const client = clientFor(plan);
          await assert.rejects(operation({ client, plan, account: ACCOUNT, mode, allowTopologyGaps }), { code: "MISSING_PERMANENT_TAIL" });
          assert.equal(economicRequests(client).length, 0, "Unsafe topology cannot reach economic execution");
        }
        const client = clientFor(plan);
        const planned = await operation({ client, plan, account: ACCOUNT, mode, allowMissingPermanentTail: true });
        assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
        assert.equal(planned.allowMissingPermanentTail, true);
        assert.equal(planned.allowTopologyGaps, false);
        assert.equal(planned.planHash, commitment);
        assert.equal(hashLaunchPlan(plan), commitment, "Validation options never rewrite committed economics");
        const compiled = planned.transactions.filter((transaction) => transaction.to.toLowerCase() === CORE);
        for (const transaction of compiled) {
          const committed = decodeFunctionData({ abi: launchLifecycleAbi, data: transaction.data }).args[0];
          assert.equal(hashLaunchPlan(committed), commitment);
        }
        assert.equal((await simulateLaunchPlan({ client, planned })).admitted, true);
        assert.ok(await buildNextTransaction({ client, planned }), "Tail opt-out remains available to fresh unfinished-work admission");
      }
    });
  }

  test(`token${token0 ? 0 : 1} planner gap and permanent-tail opt-outs are independent`, async () => {
    const plan = makePlan({ token0 });
    const config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
    const positions = token0
      ? [{ tickLower: 0, tickUpper: 60, liquidity: 1n, tokenAmountMaximum: 50n },
        { tickLower: 120, tickUpper: 887220, liquidity: 1n, tokenAmountMaximum: 50n }]
      : [{ tickLower: -60, tickUpper: 0, liquidity: 1n, tokenAmountMaximum: 50n },
        { tickLower: -887220, tickUpper: -120, liquidity: 1n, tokenAmountMaximum: 50n }];
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, positions });
    for (const operation of [planLaunch, prepareAndPlanLifecycleLaunch]) {
      await assert.rejects(operation({ client: clientFor(plan), plan, account: ACCOUNT, mode: "atomic" }), { code: "TOPOLOGY_INTERIOR_GAP" });
      await assert.rejects(operation({ client: clientFor(plan), plan, account: ACCOUNT, mode: "atomic", allowMissingPermanentTail: true }), { code: "TOPOLOGY_INTERIOR_GAP" });
      const planned = await operation({ client: clientFor(plan), plan, account: ACCOUNT, mode: "atomic", allowTopologyGaps: true });
      assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
      assert.equal(planned.allowTopologyGaps, true);
      assert.equal(planned.allowMissingPermanentTail, false);
      const client = clientFor(plan);
      assert.equal((await simulateLaunchPlan({ client, planned })).admitted, true);
      assert.ok(await buildNextTransaction({ client, planned }));
    }
    const finite = positions.map((position, index) => index === 1 ? { ...position,
      tickLower: token0 ? 120 : -180, tickUpper: token0 ? 180 : -120 } : position);
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, positions: finite });
    await assert.rejects(review(clientFor(plan), plan, { allowTopologyGaps: true }), { code: "MISSING_PERMANENT_TAIL" });
    await assert.rejects(review(clientFor(plan), plan, { allowMissingPermanentTail: true }), { code: "TOPOLOGY_INTERIOR_GAP" });
    assert.equal((await review(clientFor(plan), plan, { allowTopologyGaps: true, allowMissingPermanentTail: true })).simulation.admitted, true);
  });

  test(`token${token0 ? 0 : 1} neither planner opt-out bypasses opening containment or tick alignment`, async () => {
    for (const [code, ticks] of [
      ["TOPOLOGY_OPENING_GAP", token0 ? { tickLower: 60, tickUpper: 887220 } : { tickLower: -887220, tickUpper: -60 }],
      ["TOPOLOGY_OFF_GRID_TICK", token0 ? { tickLower: 0, tickUpper: 887219 } : { tickLower: -887219, tickUpper: 0 }],
    ]) {
      const plan = makePlan({ token0 }), config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
      plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config,
        positions: config.positions.map((position) => ({ ...position, ...ticks })) });
      for (const operation of [planLaunch, prepareAndPlanLifecycleLaunch]) {
        const client = clientFor(plan);
        await assert.rejects(operation({ client, plan, account: ACCOUNT, mode: "atomic",
          allowTopologyGaps: true, allowMissingPermanentTail: true }), { code });
        assert.equal(economicRequests(client).length, 0);
      }
    }
  });
}

test("a funded tail in one market cannot substitute for another market's missing tail", async () => {
  const plan = makePlan({ markets: 2 }), market = plan.markets[1];
  const config = decodeAbyssLifecycleMarketConfig(market.config);
  market.config = encodeAbyssLifecycleMarketConfig({ ...config, positions: config.positions.map((position) => ({ ...position, tickUpper: 120 })) });
  await assert.rejects(review(clientFor(plan), plan), (error) => error.code === "MISSING_PERMANENT_TAIL" && /Market 1:/.test(error.message));
});

test("started and terminal launches recover legacy topology without creation-policy opt-outs", async () => {
  for (const phase of [LifecyclePhase.Preparing, LifecyclePhase.Ready, LifecyclePhase.Active, LifecyclePhase.Cancelled]) {
    const plan = makePlan(), config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
    // This immutable historical commitment has all three creation-policy faults:
    // off-grid endpoints, an opening gap, and no permanent tail.
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config, positions: config.positions.map((position) => ({
      ...position, tickLower: 61, tickUpper: 119,
    })) });
    const prepared = phase === LifecyclePhase.Ready || phase === LifecyclePhase.Active ? 1 : 0;
    const client = clientFor(plan, { phase, prepared });
    const planned = await review(client, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.equal(planned.allowTopologyGaps, false);
    assert.equal(planned.allowMissingPermanentTail, false);
    assert.equal((await simulateLaunchPlan({ client, planned })).admitted, true);
    const next = await buildNextTransaction({ client, planned });
    if (phase === LifecyclePhase.Active || phase === LifecyclePhase.Cancelled) assert.equal(next, undefined);
    else assert.equal(next.kind, phase === LifecyclePhase.Preparing ? "prepare" : "activate");
    assert.equal(planned.planHash, hashLaunchPlan(plan), "Recovery preserves the existing commitment");
  }
});

test("in-flight account state returns waiting before applying unstarted topology policy", async () => {
  for (const phase of [LifecyclePhase.None, LifecyclePhase.Preparing]) {
    const plan = makePlan(), config = decodeAbyssLifecycleMarketConfig(plan.markets[0].config);
    plan.markets[0].config = encodeAbyssLifecycleMarketConfig({ ...config,
      positions: config.positions.map((position) => ({ ...position, tickLower: 61, tickUpper: 119 })) });
    const source = clientFor(plan, { phase });
    const client = { async request(args) {
      const result = await source.request(args);
      return args.method === "eth_getTransactionCount" && args.params[1] === "pending" ? "0x1" : result;
    } };
    const planned = await review(client, plan, { mode: "staged" });
    assert.equal(planned.progress.confirmationSafe, false);
    assert.equal(planned.simulation.admitted, false);
    assert.match(planned.simulation.reason, /wait/i);
    assert.deepEqual(planned.transactions, []);
    assert.equal((await simulateLaunchPlan({ client, planned })).admitted, false);
    await assert.rejects(buildNextTransaction({ client, planned }), { code: "UNCONFIRMED_STATE" });
    assert.equal(economicRequests(source).length, 0, "Waiting never authorizes execution or a changed commitment");
  }
});

test("sequential admitted planLaunch RPC counts decrease across recreated per-signal readers only with the static session fast path", async (t) => {
  for (const batching of [false, true]) {
    for (const enabled of [false, true]) {
      const plan = makePlan({ chainId: 4663n });
      const client = clientFor(plan, { poster: 500n });
      client.supportsReadBatching = batching;
      if (enabled) client.sessionCache = createLifecycleSessionCache();
      const reader = (signal) => ({
        supportsReadBatching: batching, sessionCache: client.sessionCache,
        async request(args) {
          signal.throwIfAborted();
          const result = await client.request(args);
          signal.throwIfAborted();
          return result;
        },
      });
      const firstSignal = new AbortController().signal, secondSignal = new AbortController().signal;
      const options = { plan, account: ACCOUNT, mode: "staged" };
      const first = await planLaunch({ ...options, client: reader(firstSignal), signal: firstSignal }), boundary = client.captured.length;
      const second = await planLaunch({ ...options, client: reader(secondSignal), signal: secondSignal }), secondReads = client.captured.length - boundary;
      assert.equal(first.simulation.admitted, true);
      assert.deepEqual(second, first, "Static reuse cannot change commitments, commands, fees or proof outcomes");
      if (enabled) assert.ok(secondReads < boundary);
      else assert.equal(secondReads, boundary);
      for (const method of ["eth_chainId", "eth_getTransactionCount", "eth_gasPrice"]) {
        const firstCount = client.captured.slice(0, boundary).filter((row) => row.method === method).length;
        const secondCount = client.captured.slice(boundary).filter((row) => row.method === method).length;
        assert.ok(firstCount > 0);
        assert.equal(secondCount, firstCount, `${method} must remain live per invocation`);
      }
      assert.equal(client.captured.slice(boundary).filter((row) => row.method === "eth_simulateV1").length, enabled ? 2 : 3,
        "Only a new session requires the native capability proof");
      const aborted = new AbortController();
      aborted.abort();
      const afterSecond = client.captured.length;
      await assert.rejects(planLaunch({ ...options, client: reader(aborted.signal) }), { name: "AbortError" });
      assert.equal(client.captured.length, afterSecond, "A warmed session cannot bypass a new reader's aborted transport");
      t.diagnostic(`admitted Nitro fixture batching=${batching}, session=${enabled}: first=${boundary} RPC reads, second=${secondReads} RPC reads`);
    }
  }
});

test("prepare, simulate and build-next share static observations but retain live funding, account and fee authority", async () => {
  const plan = knownAbyssPlan(), client = clientFor(plan, { poster: 500n }), events = [];
  client.supportsReadBatching = true;
  client.sessionCache = createLifecycleSessionCache();
  client.onDiagnostic = (event) => events.push(event);
  const prepared = await prepareAndPlanLifecycleLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(prepared.simulation.admitted, true);
  for (const operation of [
    () => simulateLaunchPlan({ client, planned: prepared }),
    () => buildNextTransaction({ client, planned: prepared }),
  ]) {
    const boundary = client.captured.length;
    const result = await operation();
    assert.ok(result?.admitted === true || result?.admission?.admitted === true);
    const requests = client.captured.slice(boundary);
    assert.equal(requests.filter((row) => row.method === "eth_call" && row.params[0].to.toLowerCase() === NODE_INTERFACE).length, 0, "The same-block exact poster quote was already observed once");
    assert.equal(requests.filter((row) => row.method === "eth_simulateV1").length, result?.backend ? 2 : 1);
    assert.equal(requests.some((row) => row.method === "eth_getCode" && row.params[0].toLowerCase() === ACCOUNT.toLowerCase()), false, "Account code is session-scoped");
    assert.equal(requests.some((row) => row.method === "eth_getBalance"), false);
    assert.ok(requests.some((row) => row.method === "eth_getTransactionCount" && row.params[1] === "pending"));
    assert.ok(requests.some((row) => row.method === "eth_gasPrice"));
  }
  assert.equal(events.filter((event) => event.stage === "session-cache" && event.phase === "success").length, 3);
  client.state.allowance = 0n;
  client.state.gasPrice = 3n;
  const refreshed = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(refreshed.simulation.admitted, true);
  assert.equal(refreshed.transactions[0].kind, "approve", "Changed live allowance must affect the next command");
  assert.equal(refreshed.transactions[0].gasPrice, 3n);
  assert.ok(refreshed.transactions.slice(1).every((transaction) => transaction.gasPrice === undefined));
  client.state.tokenBalance = 0n;
  const refused = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(refused.prerequisites[0].inputBalance, 0n, "ERC20 balances are never session observations");
  assert.equal(refused.simulation.admitted, false, "Static hits cannot substitute for live funding/execution proof");
});

test("a fresh same-height canonical hash drops Nitro and registry observations before planning", async () => {
  const plan = makePlan({ chainId: 4663n }), client = clientFor(plan), events = [];
  client.sessionCache = createLifecycleSessionCache();
  client.onDiagnostic = (event) => events.push(event);
  const first = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(first.simulation.admitted, true);
  const boundary = client.captured.length;
  client.state.blockHash = FOREIGN_HASH;
  client.state.rawVersion = 106n;
  client.state.txCompute = 31_000_000n;
  client.state.blockCompute = 63_000_000n;
  const second = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(second.simulation.admitted, true);
  assert.equal(second.simulation.blockHash, FOREIGN_HASH);
  assert.equal(second.simulation.limits.arbOSVersion, 51n);
  assert.equal(second.simulation.limits.maxTxComputeGas, 31_000_000n);
  assert.equal(second.simulation.limits.maxBlockComputeGas, 63_000_000n);
  assert.ok(client.captured.length - boundary < boundary, "Backend and account capability observations survive a new pin");
  const summaries = events.filter((event) => event.stage === "session-cache" && event.phase === "success");
  assert.equal(summaries[1].hits, 0);
  assert.ok(summaries[1].misses > 0);
  assert.deepEqual(client.sessionCache.block, { number: 42n, hash: FOREIGN_HASH });
});



test("HMM V2 forwarding reserve is applied once to activation/atomic, never to begin or prepare", async () => {
  for (const [markets, used, reserve] of [[1, 5_850_000n, 4_250_000n], [2, 11_130_000n, 4_750_000n], [3, 16_540_000n, 5_250_000n]]) {
    const plan = makeHmmPlan(markets);
    const client = clientFor(plan, { gasFor(name, args) {
      return name === "activateLaunch" ? used : name === "prepareMarkets" ? BigInt(args[2]) * 14_000_000n : 8_000_000n;
    } });
    const planned = await review(client, plan, { mode: "staged", limits: { headroomBps: 0, maxSimulationGas: 200_000_000n } });
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.equal(planned.transactions[0].gas, 8_000_000n);
    for (const tx of planned.transactions.slice(1)) assert.equal(tx.gas, undefined);
    client.state.phase = LifecyclePhase.Ready; client.state.prepared = markets;
    const activation = await buildNextTransaction({ client, planned });
    assert.equal(activation.gas, used + reserve, "At its turn the activation receives one forwarding reserve, not its provisional budget");
  }
  const plan = makeHmmPlan(), atomic = clientFor(plan, { computeUsed: 27_360_000n,
    failureFor(name, _args, validation, tx) {
      return name === "launchAtomic" && validation && BigInt(tx.gas) < 31_320_000n
        ? { error: { code: 3, data: encodeErrorResult({ abi: fixedFeePoolHookV1Abi, errorName: "InvalidConfiguration" }) } } : undefined;
    } });
  const planned = await review(atomic, plan);
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.equal(planned.transactions[0].gas, 31_610_000n);
  assert.equal(economicRequests(atomic).length, 2);
  const nonHmm = makePlan({ chainId: 4663n });
  const ordinary = await review(clientFor(nonHmm, { computeUsed: 5_850_000n }), nonHmm);
  assert.equal(ordinary.transactions[0].gas, 6_727_500n);
});

test("greedy HMM preparation packs 1/2/3/5 markets before any simulation", async () => {
  for (const [markets, batches] of [[1, [1]], [2, [2]], [3, [2, 1]], [5, [2, 2, 1]]]) {
    const plan = makeHmmPlan(markets), client = clientFor(plan);
    const planned = await review(client, plan, { mode: "staged" });
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.deepEqual(planned.transactions.filter((tx) => tx.kind === "prepare").map((tx) => tx.marketCount), batches);
    const coverage = markets === 1 ? 3 : 2;
    assert.deepEqual(economicRequests(client).map((row) => row.params[0].blockStateCalls.length), [coverage, coverage]);
    assert.deepEqual(planned.simulation.deferredTransactionIds, planned.transactions.slice(coverage).map((tx) => tx.id));
    for (const tx of planned.transactions.slice(coverage)) assert.equal(tx.gas, undefined);
    const next = await buildNextTransaction({ client, planned });
    assert.equal(next.id, "begin"); assert.equal(next.admission.executionProof, "proved");
  }
});

test("near-ceiling packed DeploymentFailed splits at95%, while lower-gas semantic failures do not", async () => {
  const plan = makeHmmPlan(2);
  for (const [used, split] of [[30_400_000n, true], [30_399_999n, false]]) {
    const client = clientFor(plan, { failureFor(name, args, validation) {
      return name === "prepareMarkets" && args[2] > 1
        ? { gasUsed: used, returnData: encodeErrorResult({ abi: parseAbi(["error DeploymentFailed()"]), errorName: "DeploymentFailed" }) } : undefined;
    } });
    const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
    assert.equal(planned.simulation.admitted, split, planned.simulation.reason);
    assert.deepEqual(planned.transactions.filter((tx) => tx.kind === "prepare").map((tx) => tx.marketCount), split ? [1, 1] : [2]);
    assert.equal(economicRequests(client).length, split ? 3 : 1);
    if (!split) assert.equal(planned.simulation.steps.at(-1).decodedError, "DeploymentFailed");
  }
});

test("clamped padding keeps28M preparation and31M atomic work within32M while true overflow refuses", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2 });
  const client = clientFor(plan, { gasFor: (name) => name === "prepareMarkets" ? 28_000_000n : 1_000_000n });
  const staged = await review(client, plan, { mode: "staged" });
  assert.equal(staged.simulation.admitted, true, staged.simulation.reason);
  assert.equal(staged.transactions.find((tx) => tx.kind === "prepare").gas, undefined);
  client.state.phase = LifecyclePhase.Preparing;
  assert.equal((await buildNextTransaction({ client, planned: staged })).gas, 32_200_000n);
  const one = makePlan({ chainId: 4663n });
  const atomic = await review(clientFor(one, { computeUsed: 31_000_000n }), one);
  assert.equal(atomic.simulation.admitted, true);
  assert.equal(atomic.transactions[0].gas, 35_650_000n);
  const over = await review(clientFor(one, { computeUsed: 32_000_001n }), one);
  assert.equal(over.simulation.admitted, false);
  const hmm = makeHmmPlan();
  const reserveClamped = await review(clientFor(hmm, { computeUsed: 31_000_000n }), hmm);
  assert.equal(reserveClamped.simulation.admitted, true, reserveClamped.simulation.reason);
  assert.equal(reserveClamped.transactions[0].gas, 35_650_000n, "Compute fit is native validation, not the declared total envelope");
});

test("deferred activation cannot fabricate buy calibration outputs", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2 });
  await assert.rejects(prepareAndPlanLifecycleLaunch({ client: clientFor(plan), plan, account: ACCOUNT, mode: "staged", buySlippageBps: 100 }),
    (failure) => failure.code === "LAUNCH_DIAGNOSTIC_FAILED" && /activation outputs beyond the proven RPC prefix/.test(failure.message));
});

test("gross maxUsedGas sizes HMM reserve, falling back to gasUsed only when absent", async () => {
  const plan = makeHmmPlan(1, true);
  for (const [gross, expected] of [[2_000_000n, 6_250_000n], [null, 5_250_000n]]) {
    const client = clientFor(plan, { computeUsed: 1_000_000n, maxUsedGas: gross });
    const planned = await review(client, plan);
    assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
    assert.equal(planned.transactions[0].gas, expected);
    assert.equal(economicRequests(client).length, 2);
  }
});

test("mixed-profile packing preserves order and exact contiguous transaction spans", async () => {
  const plan = makeHmmPlan(5);
  const abyss = getKnownLifecycleProfile({ ...plan, key: KnownLifecycleProfile.Abyss3 });
  for (const index of [1, 3]) {
    const market = plan.markets[index];
    plan.markets[index] = { ...market, adapterId: abyss.profile.registration.adapterId, profileId: abyss.profile.id, configVersion: 1,
      config: encodeAbyssLifecycleMarketConfig({ profile: 3, fee: 3000, oracleConfigId: toHex(9n, { size: 32 }), openingSqrtPriceX96: 1n << 96n,
        positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1n, tokenAmountMaximum: 1_000_000n }] }) };
  }
  const planned = await review(clientFor(plan), plan, { mode: "staged" });
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  const preparations = planned.transactions.filter((tx) => tx.kind === "prepare");
  assert.deepEqual(preparations.map((tx) => [tx.marketStart, tx.marketCount]), [[0, 2], [2, 2], [4, 1]]);
  for (const tx of preparations) {
    const { args } = decodeFunctionData({ abi: launchLifecycleAbi, data: tx.data });
    assert.deepEqual(args[0].markets.map((market) => market.profileId), plan.markets.map((market) => market.profileId));
  }
});

test("deferred activation receives exact gas only after canonical progress brings it into the proof window", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2 }), client = clientFor(plan);
  const planned = await review(client, plan, { mode: "staged" });
  assert.deepEqual(planned.simulation.deferredTransactionIds, ["activate"]);
  assert.equal(planned.transactions.at(-1).gas, undefined);
  client.state.phase = LifecyclePhase.Ready;
  client.state.prepared = 2;
  client.captured.length = 0;
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.id, "activate");
  assert.equal(next.gas, 1_150_000n);
  assert.equal(next.gasPrice, 2n);
  assert.equal(next.admission.executionProof, "proved");
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].blockStateCalls.length), [1, 1]);
});

test("reviewed and compute-sized generic-EVM next commands use the explicit owned fork without source replay", async () => {
  const plan = makePlan(), source = clientFor(plan);
  const planned = await review(source, plan, { mode: "staged" });
  const reviewedTransaction = planned.transactions[0];
  source.state.simulationUnavailable = true;
  for (const held of [true, false]) for (const succeeds of [true, false]) {
    source.captured.length = 0;
    const calls = [];
    const fork = { isolation: "disposable", allowTransactions: true, sourceRpcUrl: "https://source.invalid", forkRpcUrl: "http://127.0.0.1:18545",
      client: { async request({ method, params = [] }) {
        calls.push(method);
        if (method === "eth_getBlockByNumber") return { number: "0x2a", hash: HASH, timestamp: "0x64", gasLimit: toHex(30_000_000n) };
        if (method === "eth_chainId") return toHex(plan.chainId);
        if (method === "evm_snapshot") return "0x1";
        if (method === "eth_sendTransaction") {
          assert.equal(BigInt(params[0].gas), reviewedTransaction.gas);
          assert.equal(BigInt(params[0].gasPrice), reviewedTransaction.gasPrice);
          assert.equal(params[0].data, reviewedTransaction.data);
          return HASH;
        }
        if (method === "eth_getTransactionReceipt") return { status: succeeds ? "0x1" : "0x0", gasUsed: toHex(1_000_000n) };
        if (method === "eth_call") return encodeFunctionResult({ abi: launchLifecycleAbi, functionName: "readLaunchProgress", result: progress(plan, LifecyclePhase.Preparing) });
        if (method === "evm_revert") return true;
        assert.fail(`Unexpected reviewed-fork call${method}`);
      } } };
    const pending = buildNextTransaction({ client: source, planned, reviewedTransaction: held ? reviewedTransaction : undefined, fork });
    if (succeeds) assert.equal((await pending).admission.executionProof, "proved");
    else await assert.rejects(pending, { code: "PLAN_NOT_ADMITTED" });
    assert.equal(economicRequests(source).length, 0, "An explicit held-fork replay never switches to native simulation");
    assert.equal(calls.filter((method) => method === "eth_sendTransaction").length, 1);
    assert.equal(calls.includes("eth_estimateGas"), false, "Held-fork replay has no measurement");
    assert.equal(calls.at(-1), "evm_revert");
  }
});

function ufgConfigFor(plan) {
  return { treasuryShareBps: 10000, exitFeeBps: 100, reserveAssets: [...new Set(plan.markets.map((market) => market.quoteAsset))].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1) };
}
function makeUfgPlan() {
  const plan = makePlan({ chainId: 4663n });
  plan.orchestrator = UFG_ORCHESTRATOR_ADDRESS;
  plan.creator = UFG_LAUNCH_PROXY_ADDRESS;
  plan.nonce = ufgLaunchNonce(ACCOUNT, 7n);
  const preset = getKnownLifecycleProfile({ ...plan, key: KnownLifecycleProfile.Abyss3 });
  plan.markets[0].adapterId = preset.profile.registration.adapterId;
  plan.markets[0].profileId = preset.profile.id;
  plan.feeAssets = buildUfgFeeAssetPolicies(TOKEN, ufgConfigFor(plan).reserveAssets);
  return plan;
}
test("UFG planner proves principal-funded proxy calls; simulation and build-next preserve opt-in routing", async () => {
  const plan = makeUfgPlan(), client = clientFor(plan, { allowance: 0n });
  const ufg = { config: ufgConfigFor(plan) };
  const planned = await prepareAndPlanLifecycleLaunch({ client, plan, account: ACCOUNT, mode: "staged", ufg });
  assert.equal(planned.simulation.admitted, true);
  assert.equal(planned.ufg.configHash, hashUfgLaunchConfig(ufg.config));
  assert.deepEqual(planned.transactions.map((tx) => tx.kind), ["approve", "begin", "prepare", "activate"]);
  for (const tx of planned.transactions) {
    assert.equal(tx.from.toLowerCase(), ACCOUNT.toLowerCase());
    if (tx.kind === "approve") assert.equal(decodeFunctionData({ abi: lifecycleErc20Abi, data: tx.data }).args[0], UFG_LAUNCH_PROXY_ADDRESS);
    else assert.equal(tx.to, UFG_LAUNCH_PROXY_ADDRESS);
  }
  assert.equal(planned.prerequisites[0].spender, UFG_LAUNCH_PROXY_ADDRESS);
  assert.equal(planned.prerequisites[0].allowance, 0n);
  assert.equal((await simulateLaunchPlan({ client, planned })).admitted, true);
  client.state.allowance = 10n;
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.to, UFG_LAUNCH_PROXY_ADDRESS);
  assert.equal(next.kind, "begin");
  client.state.phase = LifecyclePhase.Preparing;
  assert.equal((await readLaunchProgress({ client, planned })).canonical.creator, UFG_LAUNCH_PROXY_ADDRESS);
  const cancel = await buildNextTransaction({ client, planned, action: "cancel" });
  assert.equal(cancel.to, UFG_LAUNCH_PROXY_ADDRESS);
  assert.equal(cancel.kind, "cancel");
  assert.equal(cancel.from.toLowerCase(), ACCOUNT.toLowerCase());
  client.state.ufgPrincipal = address(0xa1);
  await assert.rejects(readLaunchProgress({ client, planned }), { code: "PLAN_REPLAY" });
  client.state.ufgPrincipal = ACCOUNT;
  client.state.ufgConfigHash = FOREIGN_HASH;
  await assert.rejects(readLaunchProgress({ client, planned }), { code: "PLAN_REPLAY" });
});
test("UFG planning rejects account/nonce mismatch, opt-in omission and treasury config mutation", async () => {
  const plan = makeUfgPlan(), ufg = { config: ufgConfigFor(plan) };
  const client = clientFor(plan);
  await assert.rejects(planLaunch({ client, plan, account: address(0xa1), mode: "atomic", ufg }), { code: "INVALID_UFG_PLAN" });
  await assert.rejects(planLaunch({ client, plan, account: ACCOUNT, mode: "atomic" }), { code: "ACCOUNT_MISMATCH" });
  const planned = await planLaunch({ client, plan, account: ACCOUNT, mode: "atomic", ufg });
  assert.equal(planned.simulation.admitted, true);
  planned.ufg.config.exitFeeBps += 1;
  await assert.rejects(buildNextTransaction({ client, planned }), { code: "PLAN_MUTATED" });
});

test("UFG treasury config is bound before asynchronous domain reads", async () => {
  const plan = makeUfgPlan(), ufg = { config: ufgConfigFor(plan) }, source = clientFor(plan);
  let changed = false;
  const client = { request(args) {
    if (!changed && args.method === "eth_call") { changed = true; ufg.config.exitFeeBps += 1; }
    return source.request(args);
  } };
  await assert.rejects(planLaunch({ client, plan, account: ACCOUNT, mode: "staged", ufg }), { code: "PLAN_MUTATED" });
});
test("UFG canonical receipt attribution requires proxy target/config and proxy funding spender", async () => {
  const plan = makeUfgPlan(), ufg = { config: ufgConfigFor(plan) }, source = clientFor(plan, { allowance: 0n });
  const planned = await planLaunch({ client: source, plan, account: ACCOUNT, mode: "staged", ufg });
  const begin = planned.transactions.find((tx) => tx.kind === "begin");
  const approval = planned.transactions[0];
  for (const [name, transaction, accepted] of [
    ["proxy begin", begin, true],
    ["proxy approval", approval, true],
    ["core instead of proxy", { ...begin, to: plan.orchestrator }, false],
    ["wrong treasury config", { ...begin, data: encodeFunctionData({ abi: ufgLaunchProxyV1Abi, functionName: "beginLaunch", args: [plan, 1, { ...ufg.config, exitFeeBps: 101 }] }) }, false],
    ["escrow instead of proxy approval", { ...approval, data: encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "approve", args: [getKnownLifecycleDeployment(plan).fundingEscrow, 10n] }) }, false],
  ]) {
    const client = { request(args) {
      if (args.method === "eth_getTransactionReceipt") return Promise.resolve({ blockNumber: "0x2a", blockHash: HASH, status: "0x1" });
      if (args.method === "eth_getTransactionByHash") return Promise.resolve({ from: ACCOUNT, to: transaction.to, input: transaction.data, value: toHex(transaction.value), chainId: toHex(plan.chainId) });
      return source.request(args);
    } };
    const options = { client, planned, receipts: [{ transactionHash: FOREIGN_HASH }] };
    if (accepted) assert.equal((await readLaunchProgress(options)).receipts[0].status, "confirmed", name);
    else await assert.rejects(readLaunchProgress(options), { code: "RECEIPT_IDENTITY" }, name);
  }
});

function rpcBudgetPlan() {
  const plan = makeUfgPlan(), ufg = { config: ufgConfigFor(plan) };
  plan.funding = plan.funding.map((funding) => ({ ...funding, kind: 1 }));
  const preset = getKnownLifecycleProfile({ ...plan, key: KnownLifecycleProfile.V4UfgDynamicPool });
  const envelope = preset.profile.envelope;
  plan.markets[0] = {
    ...plan.markets[0], adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, configVersion: 6,
    config: encodePoolBoundV4LifecycleMarketConfig({
      version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: 1n << 96n,
      hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321, feeMode: 1,
      protocolFeeDenominator: envelope.protocolFeeDenominator, treasury: envelope.protocolTreasury,
      externalLiquidityDisabled: false, oracleConfigId: HASH, hookSalt: zeroHash,
      profileId: preset.profile.id, termsDigest: envelope.termsDigest, developerBeneficiary: envelope.beneficiary, developerFeeBps: 0,
      positions: [{ tickLower: 0, tickUpper: 887220, liquidity: 1n, salt: zeroHash, maxTokenAmount: 100n }],
      ufgLaunchConfig: ufg.config,
    }),
  };
  return { plan, account: ACCOUNT, mode: "atomic", confirmations: 2, ufg };
}
const rpcBudgetClient = (plan, settings = {}) => clientFor(plan, { allowedTags: ["0x29", "0x2a"], ...settings });
const rpcCounts = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.method))].sort().map((method) => [method, rows.filter((row) => row.method === method).length]));

test("counting transport retains explicit cold entrypoint budgets and complete economic proofs", async (t) => {
  const options = rpcBudgetPlan();
  const seeded = await prepareAndPlanLifecycleLaunch({ ...options, client: rpcBudgetClient(options.plan), buySlippageBps: 50 });
  const finalized = { ...options, plan: seeded.plan };
  const atomicVector = { eth_call: 3, eth_chainId: 1, eth_gasPrice: 1, eth_getBlockByNumber: 2, eth_getCode: 2, eth_getTransactionCount: 3, eth_simulateV1: 3 };
  const reviewedVector = { eth_call: 2, eth_chainId: 1, eth_getBlockByNumber: 2, eth_getCode: 2, eth_getTransactionCount: 3, eth_simulateV1: 2 };
  const staged = await planLaunch({ ...finalized, mode: "staged", client: rpcBudgetClient(seeded.plan) });
  for (const [name, vector, operation] of [
    ["planLaunch", atomicVector, (client) => planLaunch({ ...finalized, client })],
    ["simulateLaunchPlan", atomicVector, (client) => simulateLaunchPlan({ client, planned: seeded })],
    ["buildNextTransaction", { ...atomicVector, eth_simulateV1: 2 }, (client) => buildNextTransaction({ client, planned: seeded })],
    ["reviewed atomic", reviewedVector, (client) => buildNextTransaction({ client, planned: seeded, reviewedTransaction: seeded.transactions[0] })],
    ["reviewed staged", reviewedVector, (client) => buildNextTransaction({ client, planned: staged, reviewedTransaction: staged.transactions[0] })],
    ["staged plan", atomicVector, (client) => planLaunch({ ...finalized, mode: "staged", client })],
    ["progress", { eth_call: 2, eth_chainId: 1, eth_getBlockByNumber: 2, eth_getCode: 1, eth_getTransactionCount: 3 }, (client) => readLaunchProgress({ client, planned: seeded })],
  ]) {
    const client = rpcBudgetClient(seeded.plan), result = await operation(client);
    assert.deepEqual(rpcCounts(client.captured), vector, name);
    if (result.simulation) assert.equal(result.simulation.admitted, true, name);
    else if (result.admission) assert.equal(result.admission.admitted, true, name);
    else if (result.backend) assert.equal(result.admitted, true, name);
    else assert.equal(result.confirmationSafe, true, name);
    t.diagnostic(`${name}: ${client.captured.length} RPC methods`);
  }
  for (const [fixedFinalEnvelope, vector] of [
    [undefined, { ...atomicVector, eth_call: 4, eth_simulateV1: 3 }],
    [{ gas: 31_000_000n }, { ...atomicVector, eth_simulateV1: 3 }],
    [{ gas: 31_000_000n, gasPrice: 2n }, { ...atomicVector, eth_simulateV1: 3, eth_gasPrice: undefined }],
  ]) {
    const client = rpcBudgetClient(options.plan);
    const result = await prepareAndPlanLifecycleLaunch({ ...options, client, buySlippageBps: 50, fixedFinalEnvelope });
    assert.equal(result.simulation.admitted, true);
    assert.deepEqual(rpcCounts(client.captured), Object.fromEntries(Object.entries(vector).filter(([, value]) => value !== undefined)));
    assert.equal(result.transactions[0].nonce, 0n);
    if (fixedFinalEnvelope) assert.equal(result.transactions[0].gas, fixedFinalEnvelope.gas);
    t.diagnostic(`prepare fixed=${fixedFinalEnvelope !== undefined}, heldFee=${fixedFinalEnvelope?.gasPrice !== undefined}: ${client.captured.length} RPC methods`);
  }
  const source = rpcBudgetClient(seeded.plan), submissionClient = submissionFor(seeded.plan);
  const next = await buildNextTransaction({ client: source, planned: seeded, reviewedTransaction: seeded.transactions[0], submissionClient });
  assert.equal(next.admission.transportPreflight, "passed");
  assert.deepEqual(rpcCounts([...source.captured, ...submissionClient.captured]), { ...reviewedVector, eth_chainId: 2, eth_estimateGas: 1 });
  t.diagnostic(`reviewed with submission: ${source.captured.length + submissionClient.captured.length} RPC methods`);
});

test("fixed atomic envelopes never reinterpret a cap, grow held gas, bump held fees, or skip final protected replay", async () => {
  const options = rpcBudgetPlan();
  for (const fixedFinalEnvelope of [null, { gas: 0n }, { gas: 1n << 64n }, { gas: 31_000_000n, gasPrice: -1n }, { gas: 31_000_000n, gasPrice: 1n << 256n }]) {
    const client = rpcBudgetClient(options.plan);
    await assert.rejects(prepareAndPlanLifecycleLaunch({ ...options, client, fixedFinalEnvelope }), { code: "INVALID_GAS_ENVELOPE" });
    assert.equal(client.captured.length, 0);
  }
  await assert.rejects(prepareAndPlanLifecycleLaunch({ ...options, client: rpcBudgetClient(options.plan), mode: "staged", fixedFinalEnvelope: { gas: 31_000_000n } }), { code: "INVALID_GAS_ENVELOPE" });
  const approvalPlan = { ...options.plan, funding: options.plan.funding.map((funding) => ({ ...funding, kind: 0 })) };
  await assert.rejects(prepareAndPlanLifecycleLaunch({ ...options, plan: approvalPlan, client: rpcBudgetClient(approvalPlan, { allowance: 0n }), fixedFinalEnvelope: { gas: 31_000_000n } }), { code: "INVALID_GAS_ENVELOPE" });
  for (const [envelope, settings] of [
    [{ gas: 999_999n }, {}],
    [{ gas: 31_000_000n, gasPrice: 2n }, { childBaseFee: 3n }],
  ]) {
    const client = rpcBudgetClient(options.plan, settings);
    await assert.rejects(prepareAndPlanLifecycleLaunch({ ...options, client, buySlippageBps: 50, fixedFinalEnvelope: envelope }), { code: "PROTECTED_PLAN_NOT_ADMITTED" });
    const calls = economicRequests(client);
    assert.deepEqual(calls.map((row) => row.params[0].validation), [false, true]);
    assert.equal(BigInt(calls[1].params[0].blockStateCalls[0].calls[0].gas), envelope.gas);
    if (envelope.gasPrice !== undefined) assert.equal(BigInt(calls[1].params[0].blockStateCalls[0].calls[0].gasPrice), envelope.gasPrice);
  }
  const fixedFinalEnvelope = { gas: 31_000_000n }, source = rpcBudgetClient(options.plan);
  const client = { request(args) {
    if (args.method === "eth_gasPrice") fixedFinalEnvelope.gas += 1n;
    return source.request(args);
  } };
  await assert.rejects(prepareAndPlanLifecycleLaunch({ ...options, client, fixedFinalEnvelope, buySlippageBps: 50 }), { code: "INVALID_GAS_ENVELOPE" });
});

test("aggregate attestation and independent getter failures refuse before native execution", async () => {
  const options = rpcBudgetPlan();
  for (const multicallCode of ["0x", CODE]) {
    const client = rpcBudgetClient(options.plan, { multicallCode });
    await assert.rejects(planLaunch({ ...options, client }), (error) => ["MULTICALL_CODE_MISMATCH", "NITRO_LIMITS_UNAVAILABLE"].includes(error.code));
    assert.equal(client.captured.some((row) => row.method === "eth_simulateV1"), false);
  }
  const client = rpcBudgetClient(options.plan, { getterFailure: true });
  await assert.rejects(planLaunch({ ...options, client }), { code: "NITRO_LIMITS_UNAVAILABLE" });
  assert.equal(economicRequests(client).length, 0);
});

test("reviewed envelopes reject a changed nonce and cannot mutate during the final owner guard", async () => {
  const plan = knownAbyssPlan(), planned = await review(clientFor(plan), plan);
  const reviewedTransaction = { ...planned.transactions[0] };
  await assert.rejects(buildNextTransaction({ client: clientFor(plan), planned, reviewedTransaction: { ...reviewedTransaction, nonce: 1n } }), { code: "REVIEWED_TRANSACTION_MISMATCH" });
  const source = clientFor(plan);
  const client = { request(args) {
    if (args.method === "eth_simulateV1" && args.params[0].blockStateCalls[0].calls[0].to !== ARB_SYS) reviewedTransaction.nonce = 1n;
    return source.request(args);
  } };
  await assert.rejects(buildNextTransaction({ client, planned, reviewedTransaction }), { code: "REVIEWED_TRANSACTION_CHANGED" });
});

test("equal observed and inclusion blocks across receipts share one fresh canonical read", async (t) => {
  const options = rpcBudgetPlan(), source = rpcBudgetClient(options.plan);
  const planned = await planLaunch({ ...options, client: source, mode: "staged" });
  const begin = planned.transactions[0], wire = [];
  const client = { request(args) {
    wire.push(args);
    if (args.method === "eth_getTransactionReceipt") return Promise.resolve({ blockNumber: "0x28", blockHash: toHex(40n, { size: 32 }), status: "0x1" });
    if (args.method === "eth_getTransactionByHash") return Promise.resolve({ from: ACCOUNT, to: begin.to, input: begin.data, value: toHex(begin.value), chainId: toHex(options.plan.chainId) });
    return source.request(args);
  } };
  const receipts = [1n, 2n, 3n].map((id) => ({ transactionHash: toHex(id, { size: 32 }), observedBlockNumber: 40n, observedBlockHash: toHex(40n, { size: 32 }) }));
  const progress = await readLaunchProgress({ client, planned, receipts });
  assert.ok(progress.receipts.every((receipt) => receipt.status === "confirmed"));
  assert.equal(wire.filter((row) => row.method === "eth_getBlockByNumber" && row.params[0] === "0x28").length, 1);
  assert.equal(wire.length, 16);
  t.diagnostic("three equal observed/inclusion receipts: 16 RPC methods (0.13.0: 19)");
});

test("unknown approval receipts share identity headers but recheck inclusion after async authority reads", async () => {
  const plan = makePlan(), source = clientFor(plan, { allowedTags: ["0x2a", "0x28"] });
  const planned = await review(source, plan), wire = [];
  let authorityRead = false;
  const client = { async request(args) {
    wire.push(args);
    if (args.method === "eth_getTransactionReceipt") return { blockNumber: "0x28", blockHash: toHex(40n, { size: 32 }), status: "0x1" };
    if (args.method === "eth_getTransactionByHash") return { from: ACCOUNT, to: plan.funding[0].inputAsset,
      input: encodeFunctionData({ abi: lifecycleErc20Abi, functionName: "approve", args: [ESCROW, 10n] }), value: "0x0", chainId: toHex(plan.chainId) };
    if (args.method === "eth_call" && args.params[1] === "0x28") authorityRead = true;
    const value = await source.request(args);
    return args.method === "eth_getBlockByNumber" && args.params[0] === "0x28" && authorityRead ? { ...value, hash: FOREIGN_HASH } : value;
  } };
  const receipts = [1n, 2n].map((id) => ({ transactionHash: toHex(id, { size: 32 }) }));
  const progress = await readLaunchProgress({ client, planned, receipts });
  assert.ok(progress.receipts.every((receipt) => receipt.status === "reorged"));
  assert.equal(wire.filter((row) => row.method === "eth_getBlockByNumber" && row.params[0] === "0x28").length, 2,
    "One shared identity pin plus one shared canonical inclusion check after all authority reads");
});

test("receipt coalescing preserves malformed-header refusal and retained observed-block reorg priority", async () => {
  const options = rpcBudgetPlan(), source = rpcBudgetClient(options.plan);
  const planned = await planLaunch({ ...options, client: source });
  for (const [malformed, observedReorg] of [[true, false], [false, false], [false, true]]) {
    const client = { async request(args) {
      if (args.method === "eth_getTransactionReceipt") return { blockNumber: "0x28", blockHash: malformed ? "0x" : toHex(40n, { size: 32 }), status: "0x1" };
      if (args.method === "eth_getTransactionByHash") return malformed
        ? { from: ACCOUNT, to: planned.transactions[0].to, input: planned.transactions[0].data, value: "0xa", chainId: toHex(options.plan.chainId) }
        : null;
      const value = await source.request(args);
      return args.method === "eth_getBlockByNumber" && args.params[0] === "0x28"
        ? { ...value, hash: malformed ? "0x" : observedReorg ? FOREIGN_HASH : toHex(40n, { size: 32 }) } : value;
    } };
    const receipts = [{ transactionHash: FOREIGN_HASH, observedBlockNumber: 40n, observedBlockHash: toHex(40n, { size: 32 }) }];
    if (observedReorg) assert.equal((await readLaunchProgress({ client, planned, receipts })).receipts[0].status, "reorged");
    else await assert.rejects(readLaunchProgress({ client, planned, receipts }), { code: "INVALID_RPC_RESPONSE" });
  }
});



test("planning batches independent state at one L2 pin, then build-next simulates only its determined staged command", async () => {
  const plan = knownAbyssPlan();
  const client = clientFor(plan);
  const planned = await planLaunch({ client, plan, account: ACCOUNT, mode: "staged" });
  assert.equal(planned.simulation.admitted, true);
  assert.equal(client.captured.filter((call) => call.method === "eth_call" && call.params[0].to.toLowerCase() === MULTICALL3).length, 1);
  assert.equal(client.captured.filter((call) => call.method === "eth_getBlockByNumber").length, 1);
  assert.equal(client.captured.filter((call) => call.method === "eth_getBalance").length, 0);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [false, true], "Unhinted sizing precedes the sole exact validated pass");
  assert.equal(client.state.posterRequests.length, 1, "Only the immediate transaction receives a poster quote");
  client.captured.length = 0;
  client.state.phase = LifecyclePhase.Preparing;
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.kind, "prepare");
  const simulations = economicRequests(client);
  assert.equal(simulations.length, 1);
  assert.equal(simulations[0].params[0].blockStateCalls.length, 1);
  assert.equal(client.captured.filter((call) => call.method === "eth_getCode").length, 0, "Account and Multicall attestations survive the next invocation");
  assert.equal(capabilityRequests(client).length, 0, "Nitro backend capability survives the next invocation");
});

test("a validated final execution refusal never selects a configured fallback fork", async () => {
  const plan = makePlan();
  const source = clientFor(plan, { replayThrow: true });
  const planned = await review(source, plan, { fork: {
    client: { request() { assert.fail("An execution refusal is not a missing simulation backend"); } },
    isolation: "disposable", allowTransactions: true,
    sourceRpcUrl: "https://example.invalid", forkRpcUrl: "http://127.0.0.1:18556",
  } });
  assert.equal(planned.simulation.admitted, false);
  assert.equal(planned.simulation.executionProof, "unavailable");
  assert.equal(economicRequests(source).length, 2);
});

test("head-height receipts reuse the invocation's authoritative L2 header", async () => {
  const plan = knownAbyssPlan(), source = clientFor(plan);
  const planned = await planLaunch({ client: source, plan, account: ACCOUNT, mode: "staged" });
  const begin = planned.transactions[0];
  source.state.phase = LifecyclePhase.Preparing;
  const wire = [];
  const client = { request(args) {
    wire.push(args);
    if (args.method === "eth_getTransactionReceipt") return Promise.resolve({ blockNumber: "0x2a", blockHash: HASH, status: "0x1" });
    if (args.method === "eth_getTransactionByHash") return Promise.resolve({ from: ACCOUNT, to: begin.to, input: begin.data, value: toHex(begin.value), chainId: toHex(plan.chainId) });
    return source.request(args);
  } };
  const progress = await readLaunchProgress({ client, planned, receipts: [{ transactionHash: FOREIGN_HASH }] });
  assert.equal(progress.receipts[0].status, "confirmed");
  assert.equal(wire.filter((call) => call.method === "eth_getBlockByNumber").length, 1);
  assert.equal(wire.find((call) => call.method === "eth_getBlockByNumber").params[0], "latest");
});

test("final native validation uses an affordable returned envelope, never its RPC discovery budget", async () => {
  const plan = makePlan({ chainId: 4663n, nativeFunding: true }), price = 10n ** 12n;
  for (const [balance, expected] of [[10n ** 18n, 115_000n], [100_000n * price + 10n, 100_000n], [99_999n * price + 10n, undefined]]) {
    const client = clientFor(plan, { computeUsed: 100_000n, gasPrice: price, balance, enforceUpfrontBalance: true });
    const planned = await review(client, plan);
    assert.equal(planned.simulation.admitted, expected !== undefined, planned.simulation.reason);
    const exact = economicRequests(client).filter((row) => row.params[0].validation);
    assert.ok(economicRequests(client).every((row) => row.params[0].blockStateCalls.every((block) => BigInt(block.calls[0].gas) * BigInt(block.calls[0].gasPrice) + BigInt(block.calls[0].value) <= balance)), "Unvalidated sizing must be affordable too");
    if (expected === undefined) { assert.equal(exact.length, 0); continue; }
    assert.equal(exact.length, 1);
    const sent = exact[0].params[0].blockStateCalls[0].calls[0];
    assert.equal(BigInt(sent.gas), expected);
    assert.equal(planned.transactions[0].gas, expected);
    assert.equal(planned.simulation.steps[0].gasLimit, expected);
    assert.ok(BigInt(sent.gas) * BigInt(sent.gasPrice) + BigInt(sent.value) <= balance);
    client.captured.length = 0;
    const next = await buildNextTransaction({ client, planned });
    assert.equal(next.gas, expected);
    assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [true]);
  }
});

test("staged suffix feasibility budgets are affordable and never reused as next-transaction estimates", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2, nativeFunding: true });
  const client = clientFor(plan, { computeUsed: 100_000n, poster: 75_000n, balance: 2_000_020n, enforceUpfrontBalance: true });
  const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [false, false, true], "Only an upfront-funds refusal allows one shared-budget sizing retry");
  for (const step of planned.simulation.steps.slice(1)) {
    assert.equal(step.provisional, true);
    assert.equal(step.estimate, undefined);
    assert.ok(step.gasLimit >= 175_000n);
  }
  for (const transaction of planned.transactions.slice(1)) {
    assert.equal(transaction.gas, undefined); assert.equal(transaction.estimate, undefined); assert.equal(transaction.admission, undefined);
  }
  const provisional = planned.simulation.steps[1].gasLimit;
  client.state.phase = LifecyclePhase.Preparing;
  client.captured.length = 0;
  const beforeQuotes = client.state.posterRequests.length;
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.kind, "prepare");
  assert.equal(next.gas, 201_250n, "Buffer compute and freshly quoted poster exactly once");
  assert.notEqual(next.gas, provisional);
  assert.equal(client.state.posterRequests.length, beforeQuotes + 1);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [true]);
  assert.equal(planned.simulation.steps[1].computeGasRequired, 100_000n);
  client.state.poster = 200_000n;
  client.captured.length = 0;
  const repriced = await buildNextTransaction({ client, planned });
  assert.equal(repriced.gas, 345_000n, "100k compute plus fresh200k poster both receive15% headroom");
  assert.equal(repriced.estimate.gasUsed, 300_000n);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [true]);
});

test("build-next clips an overlapping unfinished stored batch and preserves a supplied exact replacement span", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 3 }), client = clientFor(plan, { phase: LifecyclePhase.Preparing });
  const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
  assert.deepEqual(planned.transactions.filter((transaction) => transaction.kind === "prepare").map((transaction) => [transaction.marketStart, transaction.marketCount]), [[0, 2], [2, 1]]);
  client.state.prepared = 1;
  client.captured.length = 0;
  const next = await buildNextTransaction({ client, planned });
  assert.equal(next.id, "prepare:1:1");
  assert.ok(economicRequests(client).every((row) => row.params[0].blockStateCalls.length === 1));
  const reviewedTransaction = { ...next, id: "prepare:1:2", marketCount: 2,
    data: encodeFunctionData({ abi: launchLifecycleAbi, functionName: "prepareMarkets", args: [plan, 1, 2] }) };
  client.captured.length = 0;
  const held = await buildNextTransaction({ client, planned, reviewedTransaction, limits: { accountGasLimit: 1_200_000n } });
  assert.equal(held.id, reviewedTransaction.id); assert.equal(held.data, reviewedTransaction.data); assert.equal(held.gas, reviewedTransaction.gas);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [true]);
});

test("a waiting plan with no stored commands reconstructs only the next suffix after its receipt confirms", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 3 }), source = clientFor(plan);
  const data = encodeFunctionData({ abi: launchLifecycleAbi, functionName: "beginLaunch", args: [plan, 1] });
  let included = false;
  const client = { request(args) {
    if (args.method === "eth_getTransactionCount") return Promise.resolve(included || args.params[1] === "pending" ? "0x1" : "0x0");
    if (args.method === "eth_getTransactionReceipt") return Promise.resolve(included ? { blockNumber: "0x2a", blockHash: HASH, status: "0x1" } : null);
    if (args.method === "eth_getTransactionByHash") return Promise.resolve(included ? { from: ACCOUNT, to: CORE, input: data, value: "0x0", nonce: "0x0", chainId: toHex(plan.chainId) } : null);
    return source.request(args);
  } };
  const receipts = [{ transactionHash: FOREIGN_HASH }];
  const planned = await review(client, plan, { mode: "staged", receipts, limits: { maxSimulationGas: 100_000_000n } });
  assert.deepEqual(planned.transactions, []);
  assert.equal(planned.simulation.admitted, false);
  included = true; source.state.phase = LifecyclePhase.Preparing; source.captured.length = 0;
  const next = await buildNextTransaction({ client, planned, receipts });
  assert.equal(next.id, "prepare:0:2");
  assert.equal(next.nonce, 1n);
  assert.ok(economicRequests(source).every((row) => row.params[0].blockStateCalls.length === 1));
  assert.ok(economicRequests(source).every((row) => decodeFunctionData({ abi: launchLifecycleAbi, data: row.params[0].blockStateCalls[0].calls[0].data }).functionName === "prepareMarkets"));
});

test("per-call sizing refunds preserve a legal31M batch instead of adding a wallet write", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2, nativeFunding: true }), price = 10n ** 12n;
  const client = clientFor(plan, { gasPrice: price, balance: 73_000_000n * price + 20n, enforceUpfrontBalance: true,
    gasFor(name) { return name === "beginLaunch" ? 9_000_000n : name === "prepareMarkets" ? 31_000_000n : 6_000_000n; } });
  const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
  assert.equal(planned.simulation.admitted, true, planned.simulation.reason);
  assert.deepEqual(planned.transactions.map((transaction) => transaction.id), ["begin", "prepare:0:2", "activate"]);
  const requests = economicRequests(client);
  assert.deepEqual(requests.map((row) => row.params[0].validation), [false, true]);
  assert.deepEqual(requests[0].params[0].blockStateCalls.map((block) => BigInt(block.calls[0].gas)), [32_000_000n, 32_000_000n, 32_000_000n]);
  const capped = clientFor(plan, { phase: LifecyclePhase.Preparing, gasPrice: price, balance: 24_000_000n * price, enforceUpfrontBalance: true,
    gasFor(name) { return name === "prepareMarkets" ? 31_000_000n : 6_000_000n; } });
  const refused = await review(capped, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
  assert.equal(refused.simulation.admitted, false);
  assert.deepEqual(refused.transactions.map((transaction) => transaction.id), ["prepare:0:2", "activate"]);
  assert.equal(economicRequests(capped).length, 1, "Affordability-limited OOG cannot authorize splitting a batch");
});

test("sizing retries only a genuine upfront-funds refusal and never more than once", async () => {
  for (const chainId of [31337n, 4663n]) for (const scenario of [
    { code: -38014, message: "insufficient funds for gas * price + value", attempts: 2 },
    { code: -32000, message: "insufficient funds for gas * price + value", attempts: 2 },
    { code: 3, message: "insufficient funds", attempts: 1 },
    { code: -32015, message: "out of gas", attempts: 1 },
    { code: -38014, message: "insufficient funds", status: 429, attempts: 1 },
  ]) {
    const plan = makePlan({ chainId, nativeFunding: true }), source = clientFor(plan);
    const client = { request(args) {
      if (args.method === "eth_simulateV1" && !args.params[0].validation) {
        source.captured.push(args);
        throw Object.assign(new Error(scenario.message), { code: scenario.code, status: scenario.status });
      }
      return source.request(args);
    } };
    const fork = scenario.status === undefined ? { client: { request() { assert.fail("Funds and execution refusals cannot choose another backend"); } } } : undefined;
    const planned = await review(client, plan, { fork });
    assert.equal(planned.simulation.admitted, false);
    if (scenario.attempts === 2) assert.equal(planned.simulation.failureCategory, "affordability");
    assert.equal(economicRequests(source).length, scenario.attempts);
    assert.ok(economicRequests(source).every((row) => !row.params[0].validation));
  }
});

test("tight9M/5M/5M sequence reports sizing affordability without inventing prefix observations", async () => {
  const plan = makePlan({ chainId: 4663n, markets: 2, nativeFunding: true });
  const client = clientFor(plan, { gasPrice: 2n, balance: 48_000_000n, enforceUpfrontBalance: true,
    gasFor(name) { return name === "beginLaunch" ? 9_000_000n : 5_000_000n; } });
  const planned = await review(client, plan, { mode: "staged", limits: { maxSimulationGas: 100_000_000n } });
  assert.equal(planned.simulation.admitted, false);
  assert.equal(planned.simulation.failureCategory, "affordability");
  assert.equal(planned.simulation.executionProof, "unavailable");
  assert.deepEqual(planned.transactions.map((transaction) => transaction.id), ["begin", "prepare:0:2", "activate"]);
  assert.deepEqual(economicRequests(client).map((row) => row.params[0].validation), [false, false]);
  assert.match(planned.simulation.reason, /sizing margin/);
});
