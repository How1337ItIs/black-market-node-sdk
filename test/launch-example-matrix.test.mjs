import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertFutureLaunchDeadline, assertUnchangedEconomicQuote, buildExampleBuysAndFunding, economicReviewHash,
  guardEconomicReviewWallet, loadExampleKeystore, readExampleConfiguration, readExampleImage, readExamplePublishedImage,
  readExampleQuoteUsdSeed, Redactor, resolveExampleIdentity, resolveExampleQuotes, RunArtifacts, validateApiWethUsdSeed,
} from "../examples/launch-example-support.ts";
import { apiTransport, assertCanonicalExampleActivation, assertExampleEconomicAuthority, discoverExampleQuoteOracles,
  exampleOracleRegistrationAbi, publishAndVerify, stageMetadata } from "../examples/launch-example.ts";
import { assertExampleConversionAdmission, assertExampleConversionBindings, buildExampleKyberConversions,
  EXAMPLE_KYBER_EXECUTOR, EXAMPLE_KYBER_NATIVE, EXAMPLE_KYBER_ROUTER, exampleKyberRouterAbi, validateExampleKyberBuild } from "../examples/launch-example-kyber.ts";
const sdk = await import(process.env.SDK_SOURCE_TEST === "1" ? "../src/index.ts" : "../dist/index.js");

// Pure/offline diagnostics only. Injected RPC/HTTP observations are NOT launch/indexer proof.
const key = `0x${"42".repeat(32)}`;
const account = privateKeyToAccount(key);
const weth = sdk.getAddresses(4663).weth;
const usdg = sdk.ROBINHOOD_USDG;
const core = `0x${"11".repeat(20)}`;
const registry = `0x${"22".repeat(20)}`;
const factory = `0x${"33".repeat(20)}`;
const escrow = `0x${"44".repeat(20)}`;
const token = "0x2000000000000000000000000000000000000000";
const hash = `0x${"ab".repeat(32)}`;
const block = { number: "0x64", hash, timestamp: "0x3e8" };
const unit = 10n ** 18n;
const fixture = { chainId: "4663", creator: account.address, quoteAsset: weth, quoteDecimals: 18,
  orchestrator: core, implementationRegistry: registry, oracleFactory: factory, apiUrl: "https://api.example.invalid",
  kyberApiUrl: "https://quotes.example.invalid", buyAmountWei: "10000000000000", targetMarketCapUsdX18: 5000n * unit };
const future = () => BigInt(Math.floor(Date.now() / 1000)) + 300n;
const scenario = { tokenKind: 0, rewardMode: 0, mode: "staged", buysPerMarket: 1,
  markets: [{ venue: "v4", quote: "WETH", positions: 1 }, { venue: "v4", quote: "USDG", positions: 1 }, { venue: "abyss", quote: "WETH", positions: 1 }] };
function artifactsFor(t) {
  const directory = mkdtempSync(join(tmpdir(), "launch-matrix-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = new RunArtifacts(join(directory, "run"), "offline-boundary");
  artifacts.initialize();
  return artifacts;
}
function priceSnapshot() {
  return { chainId: 4663, indexedBlock: "100", blockNumber: "100", items: [{ chainId: 4663, address: weth,
    decimals: 18, metadataStatus: "ready", priced: true, source: "anchor", priceUsdX18: (2400n * unit).toString(),
    provenance: { anchorToken: weth, anchor: { kind: "chainlink", aggregator: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" },
      hopCount: 0, path: [], graphBlockNumber: "100", sourceTimestamp: "1000" } }] };
}
function buildResponse({ quoteAsset = weth, amountIn = 10000000000000n, amountOut = 10002n, deadline = future(), desc = {}, execution = {} } = {}) {
  const minimum = amountOut * 9950n / 10000n;
  const data = encodeFunctionData({ abi: exampleKyberRouterAbi, functionName: "swap", args: [{
    callTarget: EXAMPLE_KYBER_EXECUTOR, approveTarget: zeroAddress,
    targetData: `0x4f1423cce26c09fb31d96eafe702fc5e22421f6a${"00".repeat(32)}`,
    desc: { srcToken: EXAMPLE_KYBER_NATIVE, dstToken: quoteAsset, srcReceivers: [], srcAmounts: [],
      feeReceivers: [], feeAmounts: [], dstReceiver: escrow, amount: amountIn, minReturnAmount: minimum, flags: 0n, permit: "0x", ...desc },
    clientData: "0x", ...execution,
  }] });
  return { chainId: 4663, source: "kyberswap", tokenIn: EXAMPLE_KYBER_NATIVE, tokenOut: quoteAsset,
    amountIn: amountIn.toString(), amountOut: amountOut.toString(), amountOutMinimum: minimum.toString(),
    expiresAt: Number(deadline), routerAddress: EXAMPLE_KYBER_ROUTER,
    routePaths: [[{ pool: EXAMPLE_KYBER_ROUTER, tokenIn: weth, tokenOut: quoteAsset, exchange: "offline-fixture", poolType: "fixture" }]],
    transaction: { to: EXAMPLE_KYBER_ROUTER, data, value: amountIn.toString() } };
}
const fundingReadAbi = [...sdk.lifecycleFundingEscrowAbi, ...sdk.lifecycleRegistryAbi, ...parseAbi(["function registry() view returns (address)"])];
function fundingClient({ enabled = true, spender = EXAMPLE_KYBER_ROUTER, codeHash = keccak256("0x6000"), balance = 10n ** 18n } = {}) {
  const calls = [];
  return { calls, async request({ method, params = [] }) {
    calls.push({ method, params });
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBalance") return `0x${balance.toString(16)}`;
    if (method === "eth_getCode") return "0x6000";
    assert.equal(method, "eth_call", "No RPC writes or unrelated observations");
    assert.equal(params[1], block.number);
    const decoded = decodeFunctionData({ abi: fundingReadAbi, data: params[0].data });
    const results = { core, registry, wrappedNative: weth, fundingTarget: [spender, codeHash, enabled] };
    assert.ok(Object.hasOwn(results, decoded.functionName));
    return encodeFunctionResult({ abi: fundingReadAbi, functionName: decoded.functionName, result: results[decoded.functionName] });
  } };
}
function resolvedWithConversions(deadline = future()) {
  const quotes = resolveExampleQuotes({ sdk, fixture, scenario });
  for (const quote of quotes) {
    const buyCount = quote.symbol === "WETH" ? 2 : 1;
    // WETH buys use payable native-wrap escrow funding (Kyber has no ETH->WETH
    // swap route); USDG and any other non-native quote use reviewed Kyber builds.
    quote.conversion = quote.symbol === "WETH"
      ? { nativeWrap: true, nativeInputPerBuy: BigInt(fixture.buyAmountWei), buyCount }
      : { escrow, response: buildResponse({ quoteAsset: quote.tokenAddress,
          amountIn: BigInt(fixture.buyAmountWei) * BigInt(buyCount), deadline }), nativeInputPerBuy: BigInt(fixture.buyAmountWei), buyCount, deadline };
    quote.usdSeed = quote.symbol === "WETH" ? validateApiWethUsdSeed({ snapshot: priceSnapshot(), apiUrl: fixture.apiUrl })
      : { source: "usd-peg", priceSource: "usd-peg", chainId: 4663, tokenAddress: usdg, tokenDecimals: 6, priceUsdX18: unit };
  }
  return quotes;
}

test("quote selection keeps SDK WETH/USDG precision and the exact USDG peg without an API call", async () => {
  const quotes = resolveExampleQuotes({ sdk, fixture, scenario });
  assert.deepEqual(quotes.map((quote) => quote.symbol), ["WETH", "USDG"]);
  const usdgQuote = quotes[1];
  const seed = await readExampleQuoteUsdSeed({ sdk, fixture, quote: usdgQuote, fetchImpl: () => assert.fail("USDG peg must not read WETH API prices") });
  assert.equal(seed.priceUsdX18, unit); assert.equal(seed.tokenDecimals, 6); assert.equal(seed.source, "usd-peg");
  assert.doesNotThrow(() => assertUnchangedEconomicQuote(seed, { ...seed, retrievedAt: seed.retrievedAt + 1n }));
  assert.throws(() => assertUnchangedEconomicQuote(seed, { ...seed, priceUsdX18: unit + 1n }), { code: "ECONOMIC_REVIEW_CHANGED" });
  await assert.rejects(readExampleQuoteUsdSeed({ sdk, fixture, quote: { ...usdgQuote, tokenDecimals: 18 } }), { code: "PRICE_SOURCE_CHANGED" });
});

test("native Swap funding aggregates quotes and exactly apportions protected output to every ordered buy", () => {
  const quotes = resolvedWithConversions();
  const markets = scenario.markets.map((spec) => ({ quoteAsset: spec.quote === "USDG" ? usdg : weth }));
  const result = buildExampleBuysAndFunding({ sdk, fixture, scenario, markets, quotes, predictedToken: token });
  assert.deepEqual(result.buys.map((buy) => buy.marketIndex), [0, 1, 2]);
  // Market order is V4-WETH, V4-USDG, Abyss-WETH. WETH (native-wrap) buys are
  // exact 1e13 each; the USDG buy consumes the full protected min-out (9951).
  assert.deepEqual(result.buys.map((buy) => buy.quoteAmountIn), [10000000000000n, 9951n, 10000000000000n]);
  assert.ok(result.buys[0].sqrtPriceLimitX96 < result.buys[1].sqrtPriceLimitX96, "A token between quotes has independent buy direction");
  assert.deepEqual(result.funding.map((row) => row.inputAmount), [20000000000000n, 10000000000000n]);
  const wethRow = result.funding.find((row) => row.asset.toLowerCase() === weth.toLowerCase());
  const usdgRow = result.funding.find((row) => row.asset.toLowerCase() === usdg.toLowerCase());
  assert.ok(wethRow && wethRow.kind === sdk.LifecycleFundingKind.NativeWrap && wethRow.inputAsset === weth && wethRow.amount === wethRow.inputAmount);
  assert.ok(usdgRow && usdgRow.kind === sdk.LifecycleFundingKind.Swap && usdgRow.inputAsset === zeroAddress);
  // Plan execution deadline exceeds the conversion's own swap expiry (as in the
  // runner: 3600s plan vs 300s conversion), satisfying deadline >= conversion.
  const plan = { creator: fixture.creator, deadline: quotes[1].conversion.deadline + 3300n, markets, ...result };
  assertExampleConversionBindings({ plan, quotes });
  // WETH funding must stay NativeWrap/exact; each of these mutations must throw.
  for (const change of [{ kind: sdk.LifecycleFundingKind.Swap }, { inputAsset: zeroAddress }, { amount: 1n }, { data: "0x1234" }]) {
    assert.throws(() => assertExampleConversionBindings({ plan: { ...plan, funding: [{ ...plan.funding[0], ...change }, plan.funding[1]] }, quotes }),
      undefined, `WETH funding mutation ${JSON.stringify(Object.keys(change))} must be rejected`);
  }
  assert.throws(() => buildExampleBuysAndFunding({ sdk, fixture, scenario, markets,
    quotes: quotes.map((quote) => ({ ...quote, conversion: undefined })), predictedToken: token }), { code: "MISSING_CONVERSION" });
  // Zeroing the WETH native-wrap input produces a zero allocation, which must throw.
  const zeroWrap = quotes.map((quote) => quote.symbol === "WETH"
    ? { ...quote, conversion: { ...quote.conversion, nativeInputPerBuy: 0n } }
    : quote);
  assert.throws(() => buildExampleBuysAndFunding({ sdk, fixture, scenario, markets, quotes: zeroWrap, predictedToken: token }), { code: "INVALID_ALLOCATION" });
});

test("Kyber calldata binds native intent, exact quote/escrow/input/minimum and reviewed executor policy", () => {
  const deadline = future();
  const validate = (response) => validateExampleKyberBuild({ response, quoteAsset: usdg, amountIn: 10000000000000n, escrow, deadline });
  assert.equal(validate(buildResponse({ quoteAsset: usdg, deadline })), 9951n);
  for (const desc of [{ srcToken: zeroAddress }, { dstToken: weth }, { dstReceiver: fixture.creator },
    { amount: 1n }, { minReturnAmount: 1n }, { flags: 0x42n }, { feeReceivers: [fixture.creator], feeAmounts: [1n] },
    { srcReceivers: [fixture.creator], srcAmounts: [1n] }, { permit: "0x01" }]) {
    assert.throws(() => validate(buildResponse({ quoteAsset: usdg, deadline, desc })), { code: "INVALID_KYBER_CALLDATA" });
  }
  for (const execution of [{ callTarget: core }, { approveTarget: core }, { targetData: "0x" }]) {
    assert.throws(() => validate(buildResponse({ quoteAsset: usdg, deadline, execution })), { code: "INVALID_KYBER_CALLDATA" });
  }
  const original = buildResponse({ quoteAsset: usdg, deadline });
  for (const change of [{ chainId: 1 }, { tokenIn: zeroAddress }, { tokenOut: weth }, { routerAddress: core },
    { amountIn: "1" }, { amountOutMinimum: "0" }, { expiresAt: Number(deadline) + 1 },
    { transaction: { ...original.transaction, value: "0" } }, { transaction: { ...original.transaction, data: "0x12345678" } }]) {
    assert.throws(() => validate({ ...original, ...change }));
  }
});

test("Kyber builds only for non-native quotes; WETH uses payable native-wrap funding", async (t) => {
  const artifacts = artifactsFor(t); const quotes = resolveExampleQuotes({ sdk, fixture, scenario });
  const markets = scenario.markets.map((spec) => ({ quoteAsset: spec.quote === "USDG" ? usdg : weth }));
  const deadline = future(); const requests = []; const client = fundingClient();
  await buildExampleKyberConversions({ client, fixture, scenario, markets, quotes, escrow, deadline, sdk, block, artifacts,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); requests.push({ url: String(url), init, body });
      return new Response(JSON.stringify(buildResponse({ quoteAsset: body.tokenOut, amountIn: BigInt(body.amountIn), deadline })));
    } });
  // Exactly one Kyber build: the USDG leg (1 buy). WETH (2 buys) wraps natively.
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, `${fixture.kyberApiUrl}/api/v1/quote/kyber/build?chainId=4663`);
  assert.equal(request.init.method, "POST"); assert.equal(request.init.redirect, "error");
  assert.equal(request.body.tokenIn, zeroAddress); assert.equal(request.body.tokenOut, usdg);
  assert.equal(request.body.amountIn, "10000000000000"); // 1 USDG buy x 1e13 wei
  assert.equal(request.body.sender, escrow); assert.equal(request.body.recipient, escrow);
  assert.equal(request.body.slippageBps, 50); assert.equal(request.body.deadline, deadline.toString());
  const wethQuote = quotes.find((quote) => quote.symbol === "WETH");
  const usdgQuote = quotes.find((quote) => quote.symbol === "USDG");
  assert.ok(wethQuote.conversion.nativeWrap === true && wethQuote.conversion.response === undefined,
    "WETH conversion is native-wrap only, no Kyber response retained");
  assert.ok(usdgQuote.conversion.nativeWrap !== true && usdgQuote.conversion.response !== undefined,
    "USDG conversion retains its reviewed Kyber build");
  assert.ok(!client.calls.some((row) => row.method.startsWith("eth_send")));
});

test("unadmitted Kyber conversion preserves the app refusal verbatim before API builds or signatures", async (t) => {
  const artifacts = artifactsFor(t);
  for (const refusal of [{ enabled: false }, { spender: core }, { codeHash: hash }]) {
    await assert.rejects(assertExampleConversionAdmission({ client: fundingClient(refusal), fixture, escrow, sdk, block, artifacts }),
      { code: "KYBER_CONVERSION_NOT_ADMITTED", message: "Kyber conversion is not admitted by this launch deployment. No separate swap will be submitted." });
  }
  await assert.rejects(buildExampleKyberConversions({ client: fundingClient({ enabled: false }), fixture, scenario,
    markets: scenario.markets.map((spec) => ({ quoteAsset: spec.quote === "USDG" ? usdg : weth })),
    quotes: resolveExampleQuotes({ sdk, fixture, scenario }), escrow, deadline: future(), sdk, block, artifacts,
    fetchImpl: () => assert.fail("No unadmitted conversion API build") }), { code: "KYBER_CONVERSION_NOT_ADMITTED" });
  assert.equal(artifacts.transactions.length, 0);
});

function oracleId(move, cardinality) { return keccak256(encodeAbiParameters([{ type: "uint24" }, { type: "uint16" }], [move, cardinality])); }
function oracleClient(registrations) {
  const calls = [];
  return { calls, async request({ method, params }) {
    calls.push({ method, params });
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getLogs") return registrations.map(([move, cardinality]) => ({ address: factory, blockNumber: "0x63", removed: false,
      topics: encodeEventTopics({ abi: exampleOracleRegistrationAbi, eventName: "OracleConfigRegistered", args: { oracleConfigId: oracleId(move, cardinality) } }),
      data: encodeAbiParameters([{ type: "uint24" }, { type: "uint16" }], [move, cardinality]) }));
    assert.equal(method, "eth_call"); assert.equal(params[1], block.number);
    const decoded = decodeFunctionData({ abi: sdk.abyssFactoryAbi, data: params[0].data });
    const registration = registrations.find(([move, cardinality]) => oracleId(move, cardinality) === decoded.args[0]);
    return encodeFunctionResult({ abi: sdk.abyssFactoryAbi, functionName: "oracleConfigs", result: registration ?? [0, 0] });
  } };
}

test("USDG oracle discovery uses pinned registered history and mapping, never an invented config ID", async (t) => {
  const artifacts = artifactsFor(t); const quotes = resolveExampleQuotes({ sdk, fixture, scenario });
  const client = oracleClient([[20, 2048], [1, 4096], [1, 2048]]);
  await discoverExampleQuoteOracles({ client, fixture, scenario, quotes, selected: { v4: { envelope: { bounds: { maximumOracleCardinality: 2048 } } } }, sdk, block, artifacts });
  assert.equal(quotes[0].oracle.oracleConfigId, oracleId(1, 4096));
  assert.equal(quotes[1].oracle.oracleConfigId, oracleId(1, 2048));
  const logs = client.calls.find((row) => row.method === "eth_getLogs");
  assert.equal(logs.params[0].address, factory); assert.equal(logs.params[0].toBlock, block.number);
  assert.equal(quotes[1].oracle.observedBlockHash, hash);
  await assert.rejects(discoverExampleQuoteOracles({ client: oracleClient([[1, 4096]]), fixture, scenario,
    quotes: resolveExampleQuotes({ sdk, fixture, scenario }), selected: { v4: { envelope: { bounds: { maximumOracleCardinality: 2048 } } } }, sdk, block, artifacts }), { code: "QUOTE_ORACLE_NOT_REGISTERED" });
});

function canonicalContext(t) {
  const artifacts = artifactsFor(t); const references = [{ transactionHash: hash, observedBlockNumber: 100n, observedBlockHash: hash, confirmations: 1 }];
  const activation = { transactionHash: hash, receipt: { blockNumber: "0x64", blockHash: hash } };
  const planned = { confirmations: 1, chainId: 4663n, predictedToken: token, plan: { creator: fixture.creator, token: { name: "Example", symbol: "EXAMPLE" } } };
  const progress = { confirmationSafe: true, canonical: { phase: sdk.LifecyclePhase.Active, token }, receipts: [
    { transactionHash: hash, effectiveHash: hash, status: "confirmed", blockNumber: 100n, blockHash: hash } ] };
  const client = { offline: true };
  const readSdk = { ...sdk, async readLaunchProgress(options) {
    assert.equal(options.client, client); assert.equal(options.receipts, references); assert.equal(options.confirmations, 1);
    return progress;
  } };
  return { artifacts, references, activation, planned, progress, client, sdk: readSdk };
}

test("publication canonical gate rejects changed phase, reorg, moved inclusion, replacement and unconfirmed receipts", async (t) => {
  for (const change of ["phase", "safe", "reorg", "number", "hash", "replacement", "unconfirmed", "missing"]) {
    const context = canonicalContext(t);
    if (change === "phase") context.progress.canonical.phase = sdk.LifecyclePhase.Ready;
    if (change === "safe") context.progress.confirmationSafe = false;
    if (change === "reorg") context.progress.receipts[0].status = "reorged";
    if (change === "number") context.progress.receipts[0].blockNumber = 101n;
    if (change === "hash") context.progress.receipts[0].blockHash = `0x${"cd".repeat(32)}`;
    if (change === "replacement") context.progress.receipts[0].effectiveHash = `0x${"cd".repeat(32)}`;
    if (change === "unconfirmed") context.progress.receipts[0].status = "unconfirmed";
    if (change === "missing") context.progress.receipts = [];
    await assert.rejects(assertCanonicalExampleActivation(context), { code: "ACTIVATION_CANONICALITY_CHANGED" });
    assert.equal(context.artifacts.result.chain.status, "canonicality-failed");
    const evidence = JSON.parse(readFileSync(join(context.artifacts.directory, "publication-progress.json"), "utf8"));
    assert.equal(evidence.originalActivation.blockNumber, "100"); assert.equal(evidence.originalActivation.blockHash, hash);
    assert.equal(context.references[0].observedBlockNumber, 100n);
  }
});

test("pending publication revalidates RPC before its next attempt and stops on a reorg without retrying", async (t) => {
  const context = canonicalContext(t); let calls = 0;
  const metadata = { name: "Example", symbol: "EXAMPLE", description: "Diagnostic" };
  const session = { sessionId: "offline-session", capability: "lus_disposable", metadata, api: { async publishUploadSession() {
    calls++; context.progress.receipts[0].status = "reorged";
    throw new sdk.LaunchPublishPending({ chainId: 4663, wallet: fixture.creator, status: "awaiting_indexer" }, 0);
  } } };
  await assert.rejects(publishAndVerify({ ...context, fixture, session, signal: new AbortController().signal, timeoutSeconds: 2,
    transport: { setTimeoutMs() {}, fetch: () => assert.fail("No token HTTP verification after canonicality refusal") } }), { code: "ACTIVATION_CANONICALITY_CHANGED" });
  assert.equal(calls, 1); assert.notEqual(context.artifacts.result.api.status, "passed");
});

test("API success cannot pass a final RPC reorg barrier after asynchronous token verification", async (t) => {
  const context = canonicalContext(t); const metadata = { name: "Example", symbol: "EXAMPLE", description: "Diagnostic" };
  const session = { sessionId: "offline-session", capability: "lus_disposable", metadata, api: { async publishUploadSession() {
    return { chainId: 4663, wallet: fixture.creator, token, transactionHash: hash, status: "optimistic", canonicalStatus: "optimistic", metadataStatus: "ready", metadata };
  } } };
  await assert.rejects(publishAndVerify({ ...context, fixture, session, signal: new AbortController().signal, timeoutSeconds: 2,
    transport: { setTimeoutMs() {}, async fetch() {
      context.progress.receipts[0].blockNumber = 101n;
      return new Response(JSON.stringify({ chainId: 4663, item: { chainId: 4663, token, creator: fixture.creator, transactionHash: hash,
        canonicalStatus: "optimistic", metadata: { document: metadata }, launchedToken: { name: metadata.name, symbol: metadata.symbol } } }));
    } } }), { code: "ACTIVATION_CANONICALITY_CHANGED" });
  assert.notEqual(context.artifacts.result.api.status, "passed"); assert.equal(context.artifacts.result.execution, "reconciliation-required");
});

test("signature authority checks the immutable launch deadline after asynchronous quote rereads", async (t) => {
  const artifacts = artifactsFor(t); const start = Date.now(); let clock = start;
  t.mock.method(Date, "now", () => clock);
  const deadline = future(); const quotes = resolvedWithConversions(deadline);
  const markets = scenario.markets.map((spec) => ({ quoteAsset: spec.quote === "USDG" ? usdg : weth }));
  const plan = { chainId: 4663n, orchestrator: core, creator: fixture.creator, deadline, token: { supply: 1000000n * unit }, markets,
    ...buildExampleBuysAndFunding({ sdk, fixture, scenario, markets, quotes, predictedToken: token }) };
  const planned = { plan, planHash: hash };
  const review = { targetMarketCapUsdX18: fixture.targetMarketCapUsdX18, actualMintedSupply: plan.token.supply,
    finalizedPlan: JSON.parse(sdk.serializeLaunchPlan(plan)), planHash: hash, predictedToken: token, quotes };
  const reviewHash = economicReviewHash(review); let signatures = 0;
  const authority = () => assertExampleEconomicAuthority({ client: fundingClient(), fixture, planned, economicReview: review, reviewHash,
    sdk: { ...sdk, predictLifecycleToken: async () => token }, artifacts, signal: new AbortController().signal,
    fetchImpl: async () => { clock = Number(deadline * 1000n); return new Response(JSON.stringify(priceSnapshot())); } });
  const wallet = guardEconomicReviewWallet({ address: fixture.creator, signTypedData() { signatures++; }, signTransaction() { signatures++; } }, authority);
  await assert.rejects(wallet.signTypedData({}), { code: "LAUNCH_DEADLINE_EXPIRED" });
  clock = start;
  await assert.rejects(wallet.signTransaction({}), { code: "LAUNCH_DEADLINE_EXPIRED" });
  assert.equal(signatures, 0); assert.equal(plan.deadline, deadline); assert.equal(economicReviewHash(review), reviewHash);
  assert.throws(() => assertFutureLaunchDeadline(deadline, Number(deadline * 1000n)), { code: "LAUNCH_DEADLINE_EXPIRED" });
});

// Published Geth very-light-scrypt.json V3 vector: known empty password, independent ciphertext.
const keystoreVector = { version: 3, address: "45dea0fb0bba44f4fcf290bba71fd57d7117cbb8", id: "ce541d8d-c79b-40f8-9f8c-20f59616faba",
  crypto: { cipher: "aes-128-ctr", cipherparams: { iv: "dc4926b48a105133d2f16b96833abf1e" },
    ciphertext: "b87781948a1befd247bff51ef4063f716cf6c2d3481163e9a8f42e1f9bb74145", kdf: "scrypt",
    kdfparams: { dklen: 32, n: 2, r: 8, p: 1, salt: "004244bbdc51cadda545b1cfa43cff9ed2ae88e08c61f1479dbb45410722f8f0" },
    mac: "39990c1684557447940d4c69e06b1b82b2aceacb43f284df65c956daf3046b85" } };

test("V3 empty-password keystore decrypts/authenticates known identity and config chooses exactly one signer", async (t) => {
  const artifacts = artifactsFor(t); const path = join(artifacts.directory, "keystore.json");
  writeFileSync(path, JSON.stringify(keystoreVector), { mode: 0o600 });
  const privateKey = await loadExampleKeystore({ path, redactor: artifacts.redactor });
  assert.equal(privateKeyToAccount(privateKey).address.toLowerCase(), `0x${keystoreVector.address}`);
  const configuration = await readExampleConfiguration(sdk, artifacts.redactor, { EXAMPLE_KEYSTORE_PATH: path, LAUNCH_API_URL: fixture.apiUrl });
  assert.equal(configuration.privateKey, privateKey); assert.equal(configuration.fixture.creator.toLowerCase(), `0x${keystoreVector.address}`);
  assert.equal(configuration.fixture.signerSource, "v3-keystore"); assert.equal(configuration.fixture.buyAmountWei, "10000000000000");
  assert.equal(configuration.fixture.kyberApiUrl, configuration.fixture.apiUrl);
  await assert.rejects(readExampleConfiguration(sdk, artifacts.redactor, { PRIVATE_KEY: key, EXAMPLE_KEYSTORE_PATH: path, LAUNCH_API_URL: fixture.apiUrl }), { code: "SIGNER_SOURCE_CONFLICT" });
  await assert.rejects(readExampleConfiguration(sdk, artifacts.redactor, { LAUNCH_API_URL: fixture.apiUrl }), { code: "MISSING_CONFIGURATION" });
  await assert.rejects(loadExampleKeystore({ path, password: "wrong" }), { code: "KEYSTORE_AUTH_FAILED" });
  assert.ok(!JSON.stringify(artifacts.redactor.value({ key: privateKey })).includes(privateKey));
});

test("keystore refuses unsafe files, wrong declarations and excessive scrypt before decrypting", async (t) => {
  const artifacts = artifactsFor(t); const path = join(artifacts.directory, "keystore.json");
  const save = (value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(keystoreVector); chmodSync(path, 0o644);
  await assert.rejects(loadExampleKeystore({ path }), { code: "UNSAFE_LOCAL_FILE" });
  chmodSync(path, 0o600); const link = join(artifacts.directory, "link"); symlinkSync(path, link);
  await assert.rejects(loadExampleKeystore({ path: link }), { code: "LOCAL_FILE_UNAVAILABLE" });
  save({ ...keystoreVector, address: zeroAddress.slice(2) });
  await assert.rejects(loadExampleKeystore({ path }), { code: "KEYSTORE_ADDRESS_MISMATCH" });
  save({ ...keystoreVector, crypto: { ...keystoreVector.crypto, kdfparams: { ...keystoreVector.crypto.kdfparams, n: 2 ** 20 } } });
  await assert.rejects(loadExampleKeystore({ path }), { code: "KEYSTORE_KDF_LIMIT" });
});

test("identity overrides retain canonical API/lifecycle Unicode and byte bounds without changing defaults", () => {
  const defaults = resolveExampleIdentity({ id: "erc20-depth-v4" }, {});
  assert.deepEqual(defaults, { name: "Example erc20-depth-v4", symbol: "EXAMPLE", description: "Actual Node SDK launch example: erc20-depth-v4" });
  assert.deepEqual(resolveExampleIdentity({ id: "ignored" }, { EXAMPLE_TOKEN_NAME: "  Cafe\u0301  ", EXAMPLE_TOKEN_SYMBOL: " DEPTH ", EXAMPLE_TOKEN_DESCRIPTION: " Meme " }),
    { name: "Café", symbol: "DEPTH", description: "Meme" });
  for (const overrides of [{ EXAMPLE_TOKEN_NAME: " " }, { EXAMPLE_TOKEN_SYMBOL: "" }, { EXAMPLE_TOKEN_SYMBOL: "x".repeat(33) },
    { EXAMPLE_TOKEN_SYMBOL: "💰".repeat(9) }, { EXAMPLE_TOKEN_NAME: "x".repeat(101) }, { EXAMPLE_TOKEN_NAME: "💰".repeat(33) },
    { EXAMPLE_TOKEN_DESCRIPTION: "x".repeat(2001) }, { EXAMPLE_TOKEN_NAME: "\ud800" }]) {
    assert.throws(() => resolveExampleIdentity({ id: "case" }, overrides), { code: "INVALID_CONFIGURATION" });
  }
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=", "base64");

test("optional image path freezes exact bytes/type/digest and refuses unreadable, unsupported or oversized inputs", (t) => {
  const artifacts = artifactsFor(t); const path = join(artifacts.directory, "meme.png");
  assert.equal(readExampleImage({ sdk }), undefined);
  writeFileSync(path, png); const image = readExampleImage({ sdk, path });
  assert.deepEqual(image.bytes, png); assert.equal(image.descriptor.contentType, "image/png");
  assert.equal(image.descriptor.sha256, `0x${createHash("sha256").update(png).digest("hex")}`);
  writeFileSync(path, Buffer.from("GIF89a")); assert.throws(() => readExampleImage({ sdk, path }), { code: "IMAGE_INVALID" });
  writeFileSync(path, Buffer.alloc(sdk.MAX_LAUNCH_IMAGE_BYTES + 1)); assert.throws(() => readExampleImage({ sdk, path }), { code: "LOCAL_FILE_SIZE" });
  writeFileSync(path, Buffer.alloc(0)); assert.throws(() => readExampleImage({ sdk, path }), { code: "LOCAL_FILE_SIZE" });
  assert.throws(() => readExampleImage({ sdk, path: `${path}.missing` }), { code: "LOCAL_FILE_UNAVAILABLE" });
  assert.throws(() => readExampleImage({ sdk, path: artifacts.directory }), { code: "UNSAFE_LOCAL_FILE" });
});

test("metadata staging signs the actual image then exact-issued PUT and completion before ready", async (t) => {
  const artifacts = artifactsFor(t); const path = join(artifacts.directory, "meme.png"); writeFileSync(path, png);
  const image = readExampleImage({ sdk, path }); const metadata = { name: "Depth Meme", symbol: "DEPTH", description: "Diagnostic" };
  const plan = { chainId: 4663n, orchestrator: core, creator: fixture.creator, token: { name: metadata.name, symbol: metadata.symbol }, deadline: future() };
  const requests = []; const upload = { url: "https://objects.example.invalid/issued?secret=unit-upload-capability", method: "PUT", headers: { "content-type": "image/png", "if-none-match": "*" } };
  const response = { sessionId: "diagnostic-session", chainId: 4663, wallet: fixture.creator, status: "awaiting_upload", capability: "lus_disposable",
    metadata, image: { ...image.descriptor, width: null, height: null }, imageStatus: "upload_pending", upload };
  const transport = apiTransport({ artifacts, apiUrl: fixture.apiUrl, signal: new AbortController().signal, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === "PUT") {
      assert.equal(String(url), upload.url); assert.deepEqual(Buffer.from(await init.body.arrayBuffer()), png);
      return new Response(null, { status: 204 });
    }
    if (String(url).includes("/upload/complete")) return new Response(JSON.stringify({ ...response, status: "ready_to_launch", imageStatus: "ready", image: { ...image.descriptor, width: 1, height: 1 } }));
    const request = JSON.parse(init.body); assert.deepEqual(request.image, image.descriptor); assert.deepEqual(request.metadata, metadata);
    return new Response(JSON.stringify(response));
  } });
  let typedData;
  const session = await stageMetadata({ fixture, plan, sdk, artifacts, transport, metadata, image,
    wallet: { async signTypedData(value) { typedData = value; return account.signTypedData(value); } } });
  assert.equal(typedData.message.imageSha256, image.descriptor.sha256);
  assert.equal(typedData.message.imageContentLength, String(png.length)); assert.equal(session.image.sha256, image.descriptor.sha256);
  assert.deepEqual(requests.map((row) => row.init.method), ["POST", "PUT", "POST"]);
  assert.equal(artifacts.result.api.status, "session-ready");
  assert.ok(!readFileSync(join(artifacts.directory, "events.jsonl"), "utf8").includes("unit-upload-capability"));
  await assert.rejects(transport.fetch("https://other.example.invalid/upload", { method: "PUT" }), { code: "UNSAFE_ENDPOINT" });
  await assert.rejects(transport.fetch(upload.url, { method: "PUT", headers: upload.headers,
    body: new Blob([Buffer.alloc(png.length)], { type: "image/png" }) }));
});
test("published image GET is single, bounded, exact on identical bytes and records allowed transformations", async (t) => {
  const artifacts = artifactsFor(t); const descriptor = { sha256: `0x${createHash("sha256").update(png).digest("hex")}`, contentType: "image/png", contentLength: png.length };
  let gets = 0;
  const read = (response) => readExamplePublishedImage({ url: "https://images.example.invalid/token-image", descriptor, artifacts,
    fetchImpl: async (_url, init) => { gets++; assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); return response; } });
  const exact = await read(new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }));
  assert.equal(exact.status, "passed"); assert.equal(exact.transformed, false); assert.equal(exact.sha256, descriptor.sha256);
  const transformed = await read(new Response(Buffer.from("disposable transformed-image fixture"), { headers: { "content-type": "image/webp" } }));
  assert.equal(transformed.transformed, true); assert.equal(transformed.verification, "nonempty-image-family");
  assert.match(transformed.note, /served bytes differ/);
  for (const [response, code] of [
    [new Response("missing", { status: 404 }), "PUBLISHED_IMAGE_HTTP_ERROR"],
    [new Response(png, { status: 201, headers: { "content-type": "image/png" } }), "PUBLISHED_IMAGE_HTTP_ERROR"],
    [new Response("not an image", { headers: { "content-type": "text/html" } }), "PUBLISHED_IMAGE_TYPE_MISMATCH"],
    [new Response(png, { headers: { "content-type": "image/jpeg" } }), "PUBLISHED_IMAGE_TYPE_MISMATCH"],
    [new Response(null, { headers: { "content-type": "image/png" } }), "PUBLISHED_IMAGE_EMPTY"],
    [new Response(Buffer.alloc(0), { headers: { "content-type": "image/png" } }), "PUBLISHED_IMAGE_EMPTY"],
    [new Response(png, { headers: { "content-type": "image/png", "content-length": String(sdk.MAX_LAUNCH_IMAGE_BYTES + 1) } }), "PUBLISHED_IMAGE_SIZE"],
    [new Response(Buffer.alloc(sdk.MAX_LAUNCH_IMAGE_BYTES + 1), { headers: { "content-type": "image/png" } }), "PUBLISHED_IMAGE_SIZE"],
  ]) {
    await assert.rejects(read(response), { code });
    assert.equal(JSON.parse(readFileSync(join(artifacts.directory, "published-image.json"), "utf8")).status, "failed");
  }
  assert.equal(gets, 10, "Each success/failure sends one GET, with no retry");
});

test("image publication requires matching session/DTO association and a successful public image GET before final canonical pass", async (t) => {
  // The publish response carries no imageUrl (LaunchSessionResponse omits it);
  // the public URL is asserted on the indexed DTO. "dto-image" (null DTO URL) and
  // the GET/reorg failures remain the real negative gates.
  for (const failure of [undefined, "session-image", "dto-image", "image-http", "image-reorg"]) {
    const context = canonicalContext(t); const metadata = { name: "Example", symbol: "EXAMPLE", description: "Diagnostic" };
    const image = { sha256: `0x${createHash("sha256").update(png).digest("hex")}`, contentType: "image/png", contentLength: png.length };
    const imageKey = `launches/4663/${token.toLowerCase()}/01234567-89ab-4cde-8f01-23456789abcd`;
    const imageUrl = `https://images.example.invalid/${imageKey}`; let imageGets = 0;
    const published = { chainId: 4663, wallet: fixture.creator, token, transactionHash: hash, status: "optimistic",
      canonicalStatus: "optimistic", metadataStatus: "ready", metadata, image: { ...image }, imageStatus: "ready", imageUrl };
    if (failure === "session-image") published.image.sha256 = hash;
    const session = { sessionId: "image-session", capability: "lus_disposable", metadata, image,
      api: { publishUploadSession: async () => published } };
    const transport = apiTransport({ artifacts: context.artifacts, apiUrl: fixture.apiUrl, signal: new AbortController().signal,
      fetchImpl: async (url, init) => {
        assert.equal(init.method, "GET");
        if (String(url) === imageUrl) {
          imageGets++;
          if (failure === "image-reorg") context.progress.receipts[0].status = "reorged";
          return new Response(png, { status: failure === "image-http" ? 404 : 200, headers: { "content-type": "image/png" } });
        }
        return new Response(JSON.stringify({ chainId: 4663, item: { chainId: 4663, token, creator: fixture.creator,
          transactionHash: hash, canonicalStatus: "optimistic", imageUrl: failure === "dto-image" ? null : imageUrl,
          metadata: { document: { ...metadata, imageKey }, imageContentType: image.contentType, imageContentLength: image.contentLength },
          launchedToken: { name: metadata.name, symbol: metadata.symbol } } }));
      } });
    const verify = publishAndVerify({ ...context, fixture, session, transport, signal: new AbortController().signal, timeoutSeconds: 2 });
    if (failure) {
      await assert.rejects(verify);
      assert.notEqual(context.artifacts.result.api.status, "passed");
    } else {
      await verify; assert.equal(context.artifacts.result.api.status, "passed");
      assert.equal(context.artifacts.result.api.image.sha256, image.sha256);
      assert.equal(context.artifacts.result.api.image.verification, "byte-identical-upload");
    }
    assert.equal(imageGets, [undefined, "image-http", "image-reorg"].includes(failure) ? 1 : 0);
  }
});


test("expired launch refuses metadata staging before signing or requesting an upload session", async (t) => {
  const artifacts = artifactsFor(t); let signed = 0;
  const metadata = { name: "Example", symbol: "EXAMPLE", description: "" };
  await assert.rejects(stageMetadata({ fixture, plan: { chainId: 4663n, orchestrator: core, creator: fixture.creator,
    token: metadata, deadline: BigInt(Math.floor(Date.now() / 1000)) }, sdk, artifacts, metadata,
    wallet: { signTypedData() { signed++; } }, transport: { fetch: () => assert.fail("No expired metadata-session write") } }), { code: "LAUNCH_DEADLINE_EXPIRED" });
  assert.equal(signed, 0); assert.equal(artifacts.transactions.length, 0);
});
