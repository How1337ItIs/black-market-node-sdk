import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult, keccak256, zeroAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { runLaunchExample } from "../../examples/launch-example.ts";
const sdk = await import(process.env.SDK_SOURCE_TEST === "1" ? "../../src/index.ts" : "../../dist/index.js");

// Injected RPC/planner/API evidence tests control flow only, not a live launch proof.
// This published disposable key never reaches an actual signer or network transport.
const privateKey = `0x${"42".repeat(32)}`;
const creator = privateKeyToAddress(privateKey);
const addresses = sdk.getAddresses(4663);
const core = addresses.launchOrchestrator;
const registry = addresses.launchImplementationRegistry;
const factory = addresses.abyssFactory;
const weth = addresses.weth;
const adapter = `0x${"11".repeat(20)}`;
const escrow = `0x${"22".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`;
const block = { number: "0x64", hash, timestamp: "0x3e8" };
const profile = { id: hash, admitted: true, venueKind: "abyss", adapter: { implementation: adapter },
  registration: { adapterId: hash, configSchema: sdk.ABYSS_LIFECYCLE_CONFIG_SCHEMA }, topology: { configVersion: 1 } };
const readAbi = [...sdk.launchLifecycleAbi, ...sdk.lifecycleFundingEscrowAbi, ...sdk.abyssLifecycleAdapterAbi,
  ...sdk.abyssFactoryAbi, ...sdk.erc20Abi];
const priceSnapshot = { chainId: 4663, indexedBlock: "100", blockNumber: "100", items: [{ chainId: 4663, address: weth,
  decimals: 18, metadataStatus: "ready", priced: true, source: "anchor", priceUsdX18: "2400000000000000000000",
  provenance: { anchorToken: weth, anchor: { kind: "chainlink", aggregator: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" },
    path: [], hopCount: 0, graphBlockNumber: "100", sourceTimestamp: "1000" } }] };

export async function runOfflineExample(argv, { admitted = true, withImage = false, profiled = false } = {}) {
  const calls = { planning: 0, wallet: 0, signTypedData: 0, signTransaction: 0, send: 0, stage: 0, execute: 0, verify: 0, publish: 0,
    requests: [], prices: 0 };
  const client = { async request({ method, params = [] }) {
    calls.requests.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return params[0].toLowerCase() === creator.toLowerCase() ? "0x" : "0x6000";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_sendRawTransaction") { calls.send++; return keccak256(params[0]); }
    assert.equal(method, "eth_call", "No unexpected RPC or unlocked-wallet calls");
    const { functionName } = decodeFunctionData({ abi: readAbi, data: params[0].data });
    const results = { registry, fundingEscrow: escrow, core, wrappedNative: weth, decimals: 18, factory,
      profileId: hash, oracleConfigs: [1, 4096] };
    assert.ok(Object.hasOwn(results, functionName), functionName);
    return encodeFunctionResult({ abi: readAbi, functionName, result: results[functionName] });
  } };
  const offlineSdk = { ...sdk,
    async readLifecycleProfiles() { return [profile]; },
    async predictLifecycleToken() { return token; },
    async prepareAndPlanLifecycleLaunch(options) {
      calls.planning++;
      assert.equal(options.buySlippageBps, 50);
      await options.limits({ chainId: 4663n, account: creator, orchestrator: core, block: { number: 100n, hash } });
      const plan = { ...options.plan, buys: options.plan.buys.map((buy) => ({ ...buy, minTokenOut: 995n })) };
      const planHash = sdk.hashLaunchPlan(plan);
      const launchId = sdk.hashLaunchIdentity(plan);
      const transactions = sdk.buildLaunchTransactions({ plan, mode: options.mode });
      const activation = transactions.find((transaction) => ["atomic", "activate"].includes(transaction.kind));
      const returnData = profiled ? undefined : encodeFunctionResult({ abi: sdk.launchLifecycleAbi,
        functionName: activation.kind === "atomic" ? "launchAtomic" : "activateLaunch", result: {
          launchId, planHash, token, feeHub: zeroAddress, rewards: zeroAddress, marketCount: plan.markets.length,
          positionCount: 1, quoteSpent: plan.buys.map((buy) => buy.quoteAmountIn), tokenOut: plan.buys.map(() => 1000n),
        } });
      return { plan, planHash, launchId, predictedToken: token, mode: options.mode, transactions, hookDeployments: [], prerequisites: [],
        simulation: { admitted, reason: admitted ? undefined : "Offline planner refusal", blockNumber: 100n, blockHash: hash,
          ...(profiled ? { backend: "profiled", confidence: "profiled", executionProof: "not-run", protocolFit: "profiled",
            gasProfile: { version: "offline-control-flow", estimates: {}, initialBuys: plan.buys.map((buy, buyIndex) => ({
              buyIndex, marketIndex: buy.marketIndex, quoteAmountIn: buy.quoteAmountIn, quoteSpent: buy.quoteAmountIn,
              tokenOut: 1000n, sqrtPriceAfterX96: 1n << 96n,
            })) } } : {}),
          steps: profiled ? [] : [{ transactionId: activation.id, success: true, returnData }] } };
    },
  };
  const env = { PRIVATE_KEY: privateKey, LAUNCH_API_URL: "https://api.example.invalid", RPC_URL: "https://rpc.example.invalid" };
  if (withImage) {
    env.EXAMPLE_IMAGE_PATH = "image.png";
    writeFileSync(env.EXAMPLE_IMAGE_PATH, Buffer.from("89504e470d0a1a0a0000000000000000", "hex"));
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.prices++;
    assert.equal(new URL(url).pathname, "/api/v1/token-prices");
    assert.equal(init.method, "GET", "Dry-run API requests must be read-only");
    return new Response(JSON.stringify(priceSnapshot));
  };
  // Match a fixed-case CLI entrypoint when this helper is invoked from node -e.
  process.argv[1] = new URL("../../examples/launch-erc20-abyss.ts", import.meta.url).pathname;
  process.execArgv = [];
  try {
    const result = await runLaunchExample({ id: "erc20-abyss-basic", description: "Offline branch evidence",
      tokenKind: 0, rewardMode: 0, mode: "atomic", markets: [{ venue: "abyss", positions: 1 }], buysPerMarket: 1 }, argv, {
      sdk: offlineSdk, env, client,
      createWallet() {
        calls.wallet++;
        return { address: creator,
          async signTypedData() { calls.signTypedData++; return `0x${"12".repeat(65)}`; },
          async signTransaction(wire) {
            calls.signTransaction++;
            return { wire, rawTransaction: "0xfeed", transactionHash: keccak256("0xfeed") };
          },
        };
      },
      async stage({ wallet, artifacts, image }) {
        calls.stage++;
        assert.equal(artifacts.recovery.economicAdmission.authorization, "--broadcast");
        assert.equal(Boolean(image), withImage);
        await wallet.signTypedData({});
        return { sessionId: "offline-session" };
      },
      async execute({ wallet }) {
        calls.execute++;
        const signed = await wallet.signTransaction({});
        await client.request({ method: "eth_sendRawTransaction", params: [signed.rawTransaction] });
        return { activation: { transactionHash: signed.transactionHash } };
      },
      async verify({ artifacts }) {
        calls.verify++;
        artifacts.result.chain.status = "passed";
        artifacts.result.chain.token = token;
        artifacts.result.execution = "completed";
      },
      async publish({ artifacts }) { calls.publish++; artifacts.result.api.status = "passed"; },
    });
    writeFileSync("offline-observations.json", JSON.stringify({ calls, result }, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally { globalThis.fetch = previousFetch; }
}
