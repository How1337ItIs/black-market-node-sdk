import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, toHex, zeroAddress, zeroHash } from "viem";
const sdkPath = process.env.SDK_SOURCE_TEST === "1" ? "../src/lifecycle/index.ts" : "../dist/lifecycle/index.js";
const { hookSaltMinerAbi, minePoolBoundHookSalt } = await import(sdkPath);
const { mineLifecycleHooks } = await import(sdkPath.replace("index.", "mining."));
const { withLifecycleReadClient } = await import(sdkPath.replace("index.", "rpc."));
const miner = "0x2f06176ba739b609b6a7334e2e6647558ba78ad5";
const block = { number: 42n, hash: toHex(42n, { size: 32 }), timestamp: 100n, gasLimit: 1n << 50n };
const deployments = [1n, 2n].map((id, marketIndex) => ({ marketIndex, deployer: toHex(id, { size: 20 }), initCodeHash: toHex(id, { size: 32 }), salt: zeroHash, predictedHook: zeroAddress }));

test("one deployed findMany mines all pool-bound hooks and locally verifies each winner", async () => {
  const winners = await Promise.all(deployments.map((deployment) => minePoolBoundHookSalt(deployment)));
  let calls = 0;
  const client = { async request({ method, params }) {
    calls++;
    assert.equal(method, "eth_call"); assert.equal(params[0].to, miner); assert.equal(params[1], "0x2a");
    const { args } = decodeFunctionData({ abi: hookSaltMinerAbi, data: params[0].data });
    assert.equal(args[0].length, 2); assert.equal(args[1], 75000n);
    assert.ok(args[0].every((search) => search.flags === 0x1afcn));
    return encodeFunctionResult({ abi: hookSaltMinerAbi, functionName: "findMany", result: [winners.map((winner) => winner.salt), winners.map((winner) => winner.predictedHook), [true, true]] });
  } };
  const mined = await withLifecycleReadClient(client, (client) => mineLifecycleHooks({ client, block, miner, deployments }));
  assert.equal(calls, 1);
  assert.deepEqual(mined.map(({ salt, predictedHook }) => ({ salt, predictedHook })), winners);
});

test("unfound searches resume at exactly the returned next salt without a local mining loop", async () => {
  const deployment = deployments[0];
  const winner = await minePoolBoundHookSalt({ ...deployment, startSalt: 150000n });
  let calls = 0;
  const client = { async request({ params }) {
    const { args } = decodeFunctionData({ abi: hookSaltMinerAbi, data: params[0].data });
    const first = calls++ === 0;
    assert.equal(args[0][0].startSalt, first ? 0n : 150000n);
    return encodeFunctionResult({ abi: hookSaltMinerAbi, functionName: "findMany", result: first ? [[toHex(150000n, { size: 32 })], [zeroAddress], [false]] : [[winner.salt], [winner.predictedHook], [true]] });
  } };
  const [mined] = await withLifecycleReadClient(client, (client) => mineLifecycleHooks({ client, block, miner, deployments: [deployment] }));
  assert.equal(calls, 2); assert.equal(mined.salt, winner.salt);
});

for (const corrupt of ["hook", "salt", "resume"]) test(`invalid deployed miner ${corrupt} cannot become a prepared hook`, async () => {
  const winner = await minePoolBoundHookSalt(deployments[0]);
  const client = { async request() {
    return encodeFunctionResult({ abi: hookSaltMinerAbi, functionName: "findMany", result: [[corrupt === "salt" || corrupt === "resume" ? zeroHash : winner.salt], [corrupt === "hook" ? zeroAddress : winner.predictedHook], [corrupt !== "resume"]] });
  } };
  await assert.rejects(withLifecycleReadClient(client, (client) => mineLifecycleHooks({ client, block, miner, deployments: [deployments[0]] })), { code: "INVALID_MINER_RESULT" });
});

test("cancelling a lens-mined winner cannot expose a completed deployment", async () => {
  const { observeLifecycleLens } = await import(sdkPath.replace("index.", "lens."));
  const winner = await minePoolBoundHookSalt(deployments[0]);
  const controller = new AbortController();
  const source = { request() { assert.fail("The lens already supplied the mined winner"); } };
  await assert.rejects(withLifecycleReadClient(source, async (client) => {
    observeLifecycleLens(client, block, { blockNumber: block.number, parentBlockHash: block.hash,
      hookDeployments: [{ ...deployments[0], ...winner, hook: winner.predictedHook, found: true }] });
    return mineLifecycleHooks({ client, block, miner, deployments: [deployments[0]], signal: controller.signal,
      onProgress: () => controller.abort() });
  }), { name: "AbortError" });
});
