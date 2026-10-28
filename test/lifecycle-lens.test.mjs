import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, multicall3Abi as aggregateAbi, parseAbi, toHex, zeroAddress, zeroHash } from "viem";
const sdkPath = process.env.SDK_SOURCE_TEST === "1" ? "../src/lifecycle/index.ts" : "../dist/lifecycle/index.js";
const { getKnownLifecycleDeployment, hashLaunchIdentity, hashLaunchPlan, launchLensAbi, LifecyclePhase, parseLaunchPlan, readLaunchProgress } = await import(sdkPath);
const { readLifecyclePlanningBlock } = await import(sdkPath.replace("index.", "snapshot."));
const { withLifecycleReadClient, readLifecycleContract } = await import(sdkPath.replace("index.", "rpc."));
import { MULTICALL3, MULTICALL3_CODE } from "./fixtures/multicall3.mjs";
const multicall3Abi = [...aggregateAbi, ...parseAbi(["function getBlockNumber() view returns (uint256)", "function getLastBlockHash() view returns (bytes32)", "function getCurrentBlockGasLimit() view returns (uint256)", "function getBasefee() view returns (uint256)"])];
const lens = getKnownLifecycleDeployment({ chainId: 4663n, orchestrator: "0x91560876033d568d25CDe98C78c33ff8FC43962c" }).launchLens;
const token = "0x0000000000000000000000000000000000000010";
const factory = "0x00000000000000000000000000000000000000bb";
const adapter = "0x00000000000000000000000000000000000000cc";
const parentHash = toHex(41n, { size: 32 });

async function fixture(liveStateSuccess = true, lensFailure = false) {
  const json = JSON.parse(await readFile(new URL("./fixtures/launch-lifecycle-v1.json", import.meta.url)));
  const plan = { ...parseLaunchPlan(JSON.stringify(json.plan)), chainId: 4663n, orchestrator: "0x91560876033d568d25CDe98C78c33ff8FC43962c" };
  const preset = getKnownLifecycleDeployment(plan);
  const launchId = hashLaunchIdentity(plan), planHash = hashLaunchPlan(plan);
  const progress = { launchId, planHash, creator: plan.creator, nonce: plan.nonce, mode: 1, phase: LifecyclePhase.Preparing, token, feeHub: factory, rewards: zeroAddress, preparedMarkets: 1, marketCount: plan.markets.length, buyCount: plan.buys.length, positionCount: 1, deadline: plan.deadline };
  const identity = { venue: 1, manager: zeroAddress, factory, pool: lens, poolId: zeroHash, profileId: plan.markets[0].profileId, currency0: token, currency1: plan.markets[0].quoteAsset, fee: 3000, tickSpacing: 60, hook: zeroAddress, openingSqrtPriceX96: 1n << 96n };
  identity.canonicalId = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [plan.chainId, identity.venue, identity.manager, identity.factory, identity.pool, identity.poolId, identity.profileId]));
  const snapshot = { chainId: plan.chainId, blockNumber: 42n, parentBlockHash: parentHash, timestamp: 100n, nativeBalance: 123456n,
    tokenBalances: [{ token: plan.funding[0].inputAsset, balance: 99n, allowance: 88n }], predictedToken: token, launchId, progress,
    preparedMarkets: [{ index: 0, adapter, prepared: { identity, feeSource: factory, custody: factory, mintExecutor: adapter, buyExecutor: adapter, exclusions: [], positionCount: 1 }, liveStateSuccess,
      live: { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 123n, publicTrading: false, oracleReadyAt: 0n }, liveStateError: liveStateSuccess ? "0x" : "0xdead" }], hookDeployments: [] };
  const calls = [];
  const client = { async request(request) {
    calls.push(request);
    if (request.method === "eth_chainId") return "0x1237";
    if (request.method === "eth_getCode") return MULTICALL3_CODE;
    if (request.method === "eth_getTransactionCount") return "0x7";
    if (request.method === "eth_getBlockByNumber") return { number: "0x2a", hash: toHex(42n, { size: 32 }), parentHash, timestamp: "0x64", gasLimit: toHex(1n << 50n), baseFeePerGas: "0x2" };
    assert.equal(request.method, "eth_call");
    assert.equal(request.params[0].to.toLowerCase(), MULTICALL3, "Dependent reads must not escape the snapshot");
    assert.equal(request.params[1], "0x2a", "Every aggregate uses the explicit RPC L2 pin");
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: request.params[0].data });
    const results = args[0].map((call) => {
      if (call.target.toLowerCase() === lens) return { success: !lensFailure, returnData: lensFailure ? "0x" : encodeFunctionResult({ abi: launchLensAbi, functionName: "snapshot", result: snapshot }) };
      if (call.target.toLowerCase() === MULTICALL3) {
        const { functionName } = decodeFunctionData({ abi: multicall3Abi, data: call.callData });
        const result = { getBlockNumber: 900n, getLastBlockHash: toHex(899n, { size: 32 }), getCurrentBlockTimestamp: 100n, getCurrentBlockGasLimit: 1n << 50n, getBasefee: 2n, getEthBalance: snapshot.nativeBalance }[functionName];
        return { success: true, returnData: encodeFunctionResult({ abi: multicall3Abi, functionName, result }) };
      }
      return { success: true, returnData: toHex(105n, { size: 32 }) };
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
  } };
  return { plan, preset, snapshot, calls, client, planned: { plan, planHash, launchId, predictedToken: token, account: plan.creator, mode: "staged", confirmations: 1 } };
}

for (const liveStateSuccess of [true, false]) test(`deployed preset snapshot replaces prediction, progress, funding and dependent markets without caller configuration (live=${liveStateSuccess})`, async () => {
  const source = await fixture(liveStateSuccess);
  await withLifecycleReadClient(source.client, async (client) => {
    const block = await readLifecyclePlanningBlock(client, source.plan, source.plan.creator);
    assert.equal(block.number, 42n); assert.equal(block.hash, toHex(42n, { size: 32 }));
    const progress = await readLaunchProgress({ client, planned: source.planned }, block);
    assert.equal(progress.confirmationSafe, true);
    assert.equal(progress.markets.length, 1);
    assert.equal(progress.markets[0].live?.liquidity, liveStateSuccess ? 123n : undefined);
    assert.equal(Boolean(progress.markets[0].error), !liveStateSuccess);
  });
  assert.equal(source.calls.filter((call) => call.method === "eth_call").length, 1);
  assert.equal(source.calls.filter((call) => call.method === "eth_getBlockByNumber").length, 1);
  assert.equal(source.calls.some((call) => call.method === "eth_getBalance"), false);
  assert.equal(source.calls.some((call) => call.method === "eth_getTransactionCount"), false);
});

test("a lens result from a different chain is rejected at the snapshot boundary", async () => {
  const source = await fixture();
  source.snapshot.chainId = 1n;
  await assert.rejects(withLifecycleReadClient(source.client, (client) =>
    readLifecyclePlanningBlock(client, source.plan, source.plan.creator, false, false, source.preset)), { code: "INVALID_RPC_RESPONSE" });
});

test("an enabled deployed lens refusal surfaces without legacy reads or fallback", async () => {
  const source = await fixture(true, true);
  await assert.rejects(withLifecycleReadClient(source.client, (client) =>
    readLifecyclePlanningBlock(client, source.plan, source.plan.creator)), { code: "INVALID_RPC_RESPONSE" });
  assert.equal(source.calls.filter((call) => call.method === "eth_call").length, 1);
  assert.equal(source.calls.some((call) => call.method === "eth_getBalance"), false);
});

test("one- and two-getter same-block stages each use exactly one aggregate", async () => {
  const source = await fixture();
  const abi = parseAbi(["function echo(uint256 value) view returns (uint256)"]);
  const block = { number: 42n, hash: toHex(42n, { size: 32 }), timestamp: 100n, gasLimit: 1n << 50n };
  await withLifecycleReadClient(source.client, async (client) => {
    assert.equal(await readLifecycleContract(client, token, abi, "echo", [0n], block, undefined, false, true), 105n);
    assert.deepEqual(await Promise.all([1n, 2n].map((value) => readLifecycleContract(client, token, abi, "echo", [value], block, undefined, false, true))), [105n, 105n]);
  });
  assert.equal(source.calls.filter((call) => call.method === "eth_call").length, 2);
  assert.equal(source.calls.filter((call) => call.method === "eth_getCode").length, 1);
});

test("lens funding seeds are reused across equivalent address casing", async () => {
  const source = await fixture();
  const asset = getAddress("0x000000000000000000000000000000000000abcd");
  source.plan.funding[0].inputAsset = asset;
  source.snapshot.tokenBalances[0].token = asset.toLowerCase();
  const abi = parseAbi(["function balanceOf(address owner) view returns (uint256)", "function allowance(address owner,address spender) view returns (uint256)"]);
  await withLifecycleReadClient(source.client, async (client) => {
    const block = await readLifecyclePlanningBlock(client, source.plan, source.plan.creator, false, false, source.preset);
    assert.equal(await readLifecycleContract(client, asset, abi, "balanceOf", [source.plan.creator], block), 99n);
    assert.equal(await readLifecycleContract(client, asset, abi, "allowance", [source.plan.creator, source.preset.fundingEscrow], block), 88n);
  });
  assert.equal(source.calls.filter((call) => call.method === "eth_call").length, 1);
});

test("the RPC L2 header owns the pin instead of Nitro's L1 EVM block metadata", async () => {
  const source = await fixture();
  const preset = { ...source.preset, launchLens: undefined };
  await withLifecycleReadClient(source.client, async (client) => {
    const block = await readLifecyclePlanningBlock(client, source.plan, source.plan.creator, false, false, preset);
    assert.equal(block.number, 42n);
    assert.equal(block.hash, toHex(42n, { size: 32 }));
  });
  const aggregates = source.calls.filter((call) => call.method === "eth_call");
  assert.equal(aggregates.length, 1);
  const { args } = decodeFunctionData({ abi: multicall3Abi, data: aggregates[0].params[0].data });
  const multicallGetters = args[0].filter((call) => call.target.toLowerCase() === MULTICALL3).map((call) => decodeFunctionData({ abi: multicall3Abi, data: call.callData }).functionName);
  assert.deepEqual(multicallGetters, ["getEthBalance"]);
  assert.equal(source.calls.filter((call) => call.method === "eth_getBlockByNumber").length, 1);
});
