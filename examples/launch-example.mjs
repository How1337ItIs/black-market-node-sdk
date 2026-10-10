// A launch case signs, broadcasts and publishes only after exact economic review admission.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256,
  recoverTypedDataAddress, toHex, zeroAddress, zeroHash,
} from "viem";
import {
  createLocalLaunchWallet, errorEvidence, findRevertData, launchApiUrl,
  loadExampleEnvironment, readExampleConfiguration, pause, publishUntilIndexed,
  Redactor, rpcRequestSignal, RunArtifacts, exampleError, registerEndpointSecrets,
  submitSignedRecorded, transactionEnvelope, readExampleQuoteUsdSeed, assertUnchangedEconomicQuote,
  resolveExampleQuotes, buildExampleBuysAndFunding, assertFutureLaunchDeadline, resolveExampleIdentity, readExampleImage,
  exampleImageUrl, readExamplePublishedImage,
  allocateMarketBudgets, deriveExampleMarketEconomics, economicReviewHash, admitEconomicReview, guardEconomicReviewWallet,
} from "./launch-example-support.mjs";
import { buildExampleKyberConversions, assertExampleConversionAdmission, assertExampleConversionBindings } from "./launch-example-kyber.mjs";
const UNIT = 10n ** 18n;
const BUY_SLIPPAGE_BPS = 50;
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const addressEqual = (actual, expected, label) => assert.ok(same(actual, expected), `${label}: expected ${expected}, got ${actual}`);
// Canonical AbyssFactory event; the SDK exposes its mapping getter, not enumeration.
export const exampleOracleRegistrationAbi = [{
  type: "event", name: "OracleConfigRegistered", anonymous: false,
  inputs: [{ name: "oracleConfigId", type: "bytes32", indexed: true },
    { name: "maxAbsTickMove", type: "uint24", indexed: false }, { name: "cardinality", type: "uint16", indexed: false }],
}];

// Receipt accounting, not a creator reserve or an unchanged-total-supply assumption.
export function verifyLaunchInventory({ supply, totalSupply, orchestrator, creator, transfers, buys, orchestratorBalance, creatorBalance }) {
  const minted = transfers.filter((transfer) => same(transfer.from, zeroAddress));
  assert.equal(minted.reduce((sum, transfer) => sum + transfer.value, 0n), supply, "Exact minted supply");
  assert.ok(minted.every((transfer) => same(transfer.to, orchestrator)), "Initial inventory belongs only to the launch core");
  const burns = transfers.filter((transfer) => same(transfer.to, zeroAddress));
  assert.ok(burns.every((transfer) => same(transfer.from, orchestrator)), "Launch residual burns belong only to the launch core");
  const burned = burns.reduce((sum, transfer) => sum + transfer.value, 0n);
  assert.ok(burned <= supply, "Residual inventory cannot exceed minted supply");
  assert.equal(totalSupply, supply - burned, "Actual remaining supply accounts for residual burns");
  assert.equal(orchestratorBalance, 0n, "No launch inventory remains in the core");
  const bought = buys.filter((buy) => same(buy.recipient, creator)).reduce((sum, buy) => sum + buy.tokenOut, 0n);
  assert.equal(creatorBalance, bought, "Creator receives only paid opening buys, never residual inventory");
  return { minted: supply, burned, remainingSupply: totalSupply, creatorBought: bought };
}


export function validateCase(scenario) {
  if (![0, 1].includes(scenario.tokenKind) || ![0, 1, 2].includes(scenario.rewardMode) || !["atomic", "staged"].includes(scenario.mode)) throw exampleError("UNSUPPORTED_CASE", "Case token kind, reward mode and execution mode must be explicit supported values");
  const allowed = new Set(["id", "description", "tokenKind", "rewardMode", "mode", "markets", "buysPerMarket", "burnBps"]);
  for (const key of Object.keys(scenario)) if (!allowed.has(key)) throw exampleError("UNSUPPORTED_CASE", `Unsupported case economic field ${key}; it cannot be silently ignored`);
  if (!Array.isArray(scenario.markets) || scenario.markets.length < 1 || scenario.markets.length > 16 || !Number.isSafeInteger(scenario.buysPerMarket) || scenario.buysPerMarket < 1 || scenario.buysPerMarket * scenario.markets.length > 64) throw exampleError("UNSUPPORTED_CASE", "Case market/buy counts exceed lifecycle bounds");
  if (scenario.burnBps !== undefined && (!Number.isSafeInteger(scenario.burnBps) || scenario.burnBps < 0 || scenario.burnBps > 10000 || scenario.rewardMode !== 0)) throw exampleError("UNSUPPORTED_CASE", "Token-only burn policy requires an explicit reward-free 0..10000 share");
  let positions = 0;
  for (const market of scenario.markets) {
    if (!["v4", "abyss"].includes(market.venue) || !Number.isSafeInteger(market.positions) || market.positions < 1 || market.positions > 16) throw exampleError("UNSUPPORTED_CASE", "Case requires a supported venue and 1..16 exact recipe positions per market");
    for (const key of Object.keys(market)) if (!["venue", "positions", "feeMode", "quote", "distributionPreset"].includes(key)) throw exampleError("UNSUPPORTED_CASE", `Unsupported market economic field ${key}`);
    if (market.feeMode !== undefined && (market.venue !== "v4" || ![0, 1].includes(market.feeMode))) throw exampleError("UNSUPPORTED_CASE", "Only V4 markets support explicit feeMode 0/1");
    if (market.quote !== undefined && !["WETH", "USDG"].includes(market.quote)) throw exampleError("UNSUPPORTED_CASE", "Market quote must be WETH or USDG");
    if (market.distributionPreset !== undefined && (market.positions < 2 || !["staircase", "early-scarcity", "smooth-ramp"].includes(market.distributionPreset))) throw exampleError("UNSUPPORTED_CASE", "Distribution preset requires supported multi-position source economics");
    positions += market.positions;
  }
  if (positions > 32) throw exampleError("UNSUPPORTED_CASE", "Case exceeds 32 permanent positions");
}

function rpcClient(url, artifacts, signal, label) {
  let id = 0;
  const endpoint = new URL(url);
  const headers = { "Content-Type": "application/json" };
  if (endpoint.username || endpoint.password) {
    const authorization = `Basic ${Buffer.from(`${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`).toString("base64")}`;
    artifacts.redactor.addSecret(authorization);
    headers.Authorization = authorization;
    endpoint.username = ""; endpoint.password = "";
  }
  // The official chain-4663 endpoint filters bare non-browser requests at the
  // transport (403 without an Origin). Mirror the launch app's public origin so
  // the example RPC client is admitted identically to the UI it validates.
  if (endpoint.hostname === "rpc.mainnet.chain.robinhood.com") headers.Origin = "https://abyss.trading";
  return { async request({ method, params = [] }) {
    const requestSignal = rpcRequestSignal(signal, label, method);
    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: requestSignal,
      });
      if (!response.ok) throw exampleError("RPC_HTTP_ERROR", `${label} ${method}: HTTP ${response.status}`, { status: response.status });
      const body = await response.json();
      if (body.error) throw exampleError(body.error.code ?? "RPC_ERROR", `${label} ${method}: ${body.error.message}`, { data: body.error.data, cause: body.error });
      if (!("result" in body)) throw exampleError("INVALID_RPC_RESPONSE", `${label} ${method}: result was omitted`, { data: body });
      if (method === "eth_simulateV1") artifacts.event("rpc-observation", { backend: label, method, params, result: body.result, elapsedMs: Date.now() - started });
      return body.result;
    } catch (error) {
      artifacts.event("rpc-error", { backend: label, method, params, elapsedMs: Date.now() - started, error: errorEvidence(error) });
      throw error;
    }
  } };
}

function contractReader(client) {
  return async (to, abi, functionName, args = [], tag = "latest") => decodeFunctionResult({
    abi, functionName,
    data: await client.request({ method: "eth_call", params: [{ to, data: encodeFunctionData({ abi, functionName, args }) }, tag] }),
  });
}

function receiptEvents(receipt, address, abi, eventName) {
  return receipt.logs.filter((log) => same(log.address, address)).flatMap((log) => {
    let decoded;
    try { decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); }
    catch { return []; } // A different event at the same contract is not the expected event.
    return decoded.eventName === eventName ? [decoded.args] : [];
  });
}

export async function discoverExampleQuoteOracles({ client, fixture, scenario, quotes, selected, sdk, block, artifacts }) {
  const read = (name, args) => contractReader(client)(fixture.oracleFactory, sdk.abyssFactoryAbi, name, args, block.number);
  let discovered;
  if (quotes.some((quote) => quote.symbol === "USDG")) {
    const topic = keccak256(toHex("OracleConfigRegistered(bytes32,uint24,uint16)"));
    const logs = await client.request({ method: "eth_getLogs", params: [{
      address: fixture.oracleFactory, topics: [topic], fromBlock: "0x0", toBlock: block.number,
    }] });
    if (!Array.isArray(logs)) throw exampleError("INVALID_RPC_RESPONSE", "Oracle factory registration logs must be an array");
    const registrations = new Map();
    for (const log of logs) {
      if (log.removed || !same(log.address, fixture.oracleFactory) || BigInt(log.blockNumber) > BigInt(block.number)) {
        throw exampleError("INVALID_ORACLE_CONFIG", "Oracle registration must belong to the pinned canonical factory history");
      }
      const { args } = decodeEventLog({ abi: exampleOracleRegistrationAbi, topics: log.topics, data: log.data, strict: true });
      const id = keccak256(encodeAbiParameters([{ type: "uint24" }, { type: "uint16" }], [args.maxAbsTickMove, args.cardinality]));
      addressEqual(id, args.oracleConfigId, "Registered oracle config digest");
      registrations.set(id.toLowerCase(), { oracleConfigId: id, maxAbsTickMove: Number(args.maxAbsTickMove), cardinality: Number(args.cardinality) });
    }
    discovered = [];
    for (const registration of registrations.values()) {
      const actual = await read("oracleConfigs", [registration.oracleConfigId]);
      assert.equal(Number(actual[0]), registration.maxAbsTickMove, "Pinned registered oracle move");
      assert.equal(Number(actual[1]), registration.cardinality, "Pinned registered oracle cardinality");
      discovered.push(registration);
    }
    discovered.sort((left, right) => left.maxAbsTickMove - right.maxAbsTickMove || right.cardinality - left.cardinality ||
      left.oracleConfigId.localeCompare(right.oracleConfigId));
  }
  for (const quote of quotes) {
    let oracle;
    if (quote.symbol === "WETH") {
      const oracleConfigId = keccak256(encodeAbiParameters([{ type: "uint24" }, { type: "uint16" }], [1, 4096]));
      const actual = await read("oracleConfigs", [oracleConfigId]);
      assert.equal(Number(actual[0]), 1, "Canonical WETH P1 oracle must be registered");
      assert.equal(Number(actual[1]), 4096, "Canonical WETH P1 oracle cardinality");
      oracle = { oracleConfigId, maxAbsTickMove: 1, cardinality: 4096 };
    } else {
      const needsV4 = scenario.markets.some((market) => market.venue === "v4" && (market.quote ?? "WETH") === quote.symbol);
      const maximumCardinality = needsV4 ? Math.min(4096, selected.v4.envelope.bounds.maximumOracleCardinality) : 4096;
      oracle = discovered.find((row) => row.maxAbsTickMove > 0 && row.maxAbsTickMove <= 887272 && row.cardinality >= 2 && row.cardinality <= maximumCardinality);
      if (!oracle) throw exampleError("QUOTE_ORACLE_NOT_REGISTERED", `No registered compatible oracle configuration for ${quote.symbol} at the pinned block`,
        { quoteAsset: quote.tokenAddress, oracleFactory: fixture.oracleFactory, blockNumber: block.number, blockHash: block.hash });
    }
    quote.oracle = { ...oracle, factory: fixture.oracleFactory, observedBlockNumber: BigInt(block.number), observedBlockHash: block.hash };
    artifacts.event("quote-oracle-discovered", { quote });
  }
  const canonical = await client.request({ method: "eth_getBlockByNumber", params: [block.number, false] });
  addressEqual(canonical?.hash, block.hash, "Pinned quote/oracle block remains canonical");
}


async function constructPlan({ client, fixture, scenario, sdk, artifacts, signal, limits, metadata, image }) {
  const read = contractReader(client);
  artifacts.stage("profile-discovery");
  const profiles = await sdk.readLifecycleProfiles({ client, orchestrator: fixture.orchestrator });
  artifacts.save("profiles.json", profiles);
  artifacts.event("registry-profiles", { profiles });
  const selected = {};
  if (scenario.markets.some((row) => row.venue === "v4")) {
    const bound = profiles.filter((row) => row.venueKind === "uniswap-v4" && row.topology.hookTopology === 2 &&
      row.topology.configVersion === 6 && same(row.registration.configSchema, sdk.V4_POOL_BOUND_LIFECYCLE_CONFIG_SCHEMA_V6) &&
      row.adapter.configVersion === 6 && row.envelope?.configVersion === 6);
    if (bound.length !== 1 || !bound[0].admitted || !bound[0].envelope || !bound[0].developerTerms) throw exampleError("PROFILE_NOT_ADMITTED", "An unambiguous admitted pool-bound V4 config6/V2 profile with its exact schema and frozen terms is required", { data: bound });
    selected.v4 = bound[0];
  }
  if (scenario.markets.some((row) => row.venue === "abyss")) {
    const canonical = [];
    const adapters = new Set(profiles.filter((row) => row.venueKind === "abyss").map((row) => row.adapter.implementation.toLowerCase()));
    for (const adapter of adapters) {
      const canonicalId = await read(adapter, sdk.abyssLifecycleAdapterAbi, "profileId", [3]);
      const profile = profiles.find((row) => same(row.id, canonicalId) && same(row.adapter.implementation, adapter));
      if (profile) canonical.push(profile);
    }
    if (canonical.length !== 1 || !canonical[0].admitted || canonical[0].topology.configVersion !== 1 || !same(canonical[0].registration.configSchema, sdk.ABYSS_LIFECYCLE_CONFIG_SCHEMA)) throw exampleError("PROFILE_NOT_ADMITTED", "The registry-discovered canonical Abyss profile3 QUOTE_ORACLE/schema1 is required", { data: canonical });
    selected.abyss = canonical[0];
  }
  const block = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  const pinnedRead = (to, abi, name, args = []) => read(to, abi, name, args, block.number);
  const escrow = await pinnedRead(fixture.orchestrator, sdk.launchLifecycleAbi, "fundingEscrow");
  addressEqual(await pinnedRead(escrow, sdk.lifecycleFundingEscrowAbi, "core"), fixture.orchestrator, "Funding escrow core");
  addressEqual(await pinnedRead(escrow, sdk.lifecycleFundingEscrowAbi, "wrappedNative"), fixture.quoteAsset, "Actual native-wrap funding binding");
  const quotes = resolveExampleQuotes({ sdk, fixture, scenario });
  for (const quote of quotes) assert.equal(await pinnedRead(quote.tokenAddress, sdk.erc20Abi, "decimals"), quote.tokenDecimals, `Actual ${quote.symbol} quote decimals`);
  if (selected.v4) addressEqual(await pinnedRead(selected.v4.adapter.implementation, sdk.poolMarketAdapterV1Abi, "oracleFactory"), fixture.oracleFactory, "V4 registered oracle factory");
  if (selected.abyss) addressEqual(await pinnedRead(selected.abyss.adapter.implementation, sdk.abyssLifecycleAdapterAbi, "factory"), fixture.oracleFactory, "Abyss registered factory");
  await discoverExampleQuoteOracles({ client, fixture, scenario, quotes, selected, sdk, block, artifacts });
  const identity = { nonce: BigInt(`0x${randomBytes(32).toString("hex")}`), tokenSalt: `0x${randomBytes(32).toString("hex")}` };
  artifacts.save("identity.json", { ...identity, caseId: scenario.id, creator: fixture.creator });
  const token = {
    kind: scenario.tokenKind, rewardMode: scenario.rewardMode, name: metadata.name, symbol: metadata.symbol,
    supply: (scenario.tokenKind === 1 ? 10_000n : 1_000_000n) * UNIT,
    nftUnit: scenario.tokenKind === 1 ? 100n * UNIT : 0n,
    metadataURI: scenario.tokenKind === 1 ? fixture.nftBaseUri : "", salt: identity.tokenSalt,
    inventoryRecipient: fixture.creator, burnOnCancel: false,
  };
  const draft = {
    chainId: BigInt(fixture.chainId), orchestrator: fixture.orchestrator, creator: fixture.creator, nonce: identity.nonce,
    token, funding: [], feeAssets: [], markets: [], buys: [], deadline: BigInt(Math.floor(Date.now() / 1000)) + 300n, executorFeeBps: 275,
  };
  // CREATE2 token identity is independent of finalized market config/hook salts.
  const predictedToken = await sdk.predictLifecycleToken({ client, plan: draft });
  for (const quote of quotes) {
    quote.usdSeed = await readExampleQuoteUsdSeed({ sdk, fixture, quote, signal });
    artifacts.event("quote-usd-seed", { quote });
  }
  const budgets = allocateMarketBudgets(token.supply, scenario.markets.length);
  const marketEconomics = [];
  const markets = scenario.markets.map((spec, marketIndex) => {
    const profile = selected[spec.venue];
    const tokenBudget = budgets[marketIndex];
    const quote = quotes.find((row) => row.symbol === (spec.quote ?? "WETH"));
    const token0 = BigInt(predictedToken) < BigInt(quote.tokenAddress);
    const economics = deriveExampleMarketEconomics({ sdk, supply: token.supply, tokenBudget, tokenIsCurrency0: token0,
      positions: spec.positions, venue: spec.venue, quoteUsdX18: quote.usdSeed.priceUsdX18,
      targetUsdX18: fixture.targetMarketCapUsdX18, quoteDecimals: quote.tokenDecimals, distributionPreset: spec.distributionPreset });
    marketEconomics.push({ marketIndex, quoteSymbol: quote.symbol, quoteAsset: quote.tokenAddress,
      quoteDecimals: quote.tokenDecimals, quoteUsdX18: quote.usdSeed.priceUsdX18, oracleConfigId: quote.oracle.oracleConfigId, ...economics });
    const positions = economics.positions.map(({ tickLower, tickUpper, liquidity }) => ({ tickLower, tickUpper, liquidity }));
    let config;
    if (spec.venue === "v4") {
      const envelope = profile.envelope;
      const feeMode = spec.feeMode ?? 0;
      if (spec.positions > envelope.bounds.maximumPositions || 60 < envelope.bounds.minimumTickSpacing || 60 > envelope.bounds.maximumTickSpacing || !(envelope.bounds.feeModeFlags & 1 << feeMode)) throw exampleError("UNSUPPORTED_CASE", "Exact V4 positions, spacing or fee mode exceed the actual certified envelope", { data: { spec, bounds: envelope.bounds } });
      config = sdk.encodePoolBoundV4LifecycleMarketConfig({
        version: 6, lpFeePips: 3000, hookFeePips: 10000,
        minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321,
        tickSpacing: economics.tickSpacing, sqrtPriceX96: economics.sqrtPriceX96,
        feeMode, protocolFeeDenominator: envelope.protocolFeeDenominator, treasury: envelope.protocolTreasury,
        externalLiquidityDisabled: true, oracleConfigId: quote.oracle.oracleConfigId, profileId: profile.id,
        termsDigest: envelope.termsDigest, developerBeneficiary: envelope.beneficiary, developerFeeBps: 0, hookSalt: zeroHash,
        positions: positions.map((position, index) => ({ ...position, salt: toHex(BigInt(marketIndex * 32 + index + 1), { size: 32 }), maxTokenAmount: economics.positions[index].maxTokenAmount })),
      });
    } else config = sdk.encodeAbyssLifecycleMarketConfig({
      profile: 3, fee: 3000, oracleConfigId: quote.oracle.oracleConfigId, openingSqrtPriceX96: economics.sqrtPriceX96,
      positions: positions.map((position, index) => ({ ...position, tokenAmountMaximum: economics.positions[index].maxTokenAmount })),
    });
    return { adapterId: profile.registration.adapterId, profileId: profile.id, quoteAsset: quote.tokenAddress, tokenBudget, configVersion: spec.venue === "v4" ? profile.topology.configVersion : 1, config };
  });
  await buildExampleKyberConversions({ client, fixture, scenario, markets, quotes, escrow, deadline: draft.deadline, sdk, block, artifacts, signal });
  const { buys, funding } = buildExampleBuysAndFunding({ sdk, fixture, scenario, markets, quotes, predictedToken });
  const feeAssets = [predictedToken, ...quotes.map((quote) => quote.tokenAddress)].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1).map((asset) => {
    const rewardsBps = scenario.rewardMode === 0 ? 0 : 4000;
    const burnBps = same(asset, predictedToken) ? scenario.burnBps ?? 0 : 0;
    return { asset, ownerBps: 10000 - rewardsBps - burnBps, rewardsBps, burnBps };
  });
  const plan = { ...draft, markets, buys, feeAssets, funding };
  assertExampleConversionBindings({ plan, quotes });
  artifacts.save("draft-plan.json", plan);
  artifacts.result.chain.predictedToken = predictedToken;
  artifacts.stage("preparation-and-planning", { predictedToken, selectedProfiles: Object.fromEntries(Object.entries(selected).map(([key, profile]) => [key, profile.id])) });
  const confirmations = artifacts.result.chain.confirmations;
  const planned = await sdk.prepareAndPlanLifecycleLaunch({ client, account: fixture.creator, plan, mode: scenario.mode, limits, confirmations, buySlippageBps: BUY_SLIPPAGE_BPS, signal,
    onProgress: (progress) => artifacts.event("salt-mining", progress),
  });
  const finalizedPlan = JSON.parse(sdk.serializeLaunchPlan(planned.plan));
  const roundingBurn = marketEconomics.reduce((sum, market) => sum + market.roundingBurn, 0n);
  const retainedSupply = token.supply - roundingBurn;
  for (const market of marketEconomics) {
    const ratio = market.rawQuotePerRawToken;
    market.retainedSupplyOpeningValuationUsdX18 = ratio.numerator * retainedSupply * market.quoteUsdX18 /
      (ratio.denominator * 10n ** BigInt(market.quoteDecimals));
  }
  const activationTransaction = planned.transactions.find((transaction) => ["atomic", "activate"].includes(transaction.kind));
  const activationStep = planned.simulation.steps.find((step) => step.transactionId === activationTransaction?.id);
  if (!activationStep?.success || !activationStep.returnData) throw exampleError("MISSING_ECONOMIC_OUTPUTS", "Economic review requires the admitted activation receipt and every ordered buy output");
  const simulatedReceipt = decodeFunctionResult({ abi: sdk.launchLifecycleAbi,
    functionName: activationTransaction.kind === "atomic" ? "launchAtomic" : "activateLaunch", data: activationStep.returnData });
  assert.equal(simulatedReceipt.planHash.toLowerCase(), planned.planHash.toLowerCase(), "Economic receipt exact plan");
  assert.equal(simulatedReceipt.tokenOut.length, planned.plan.buys.length, "Economic receipt ordered outputs");
  const simulatedBuys = planned.plan.buys.map((buy, index) => {
    const tokenOut = simulatedReceipt.tokenOut[index];
    const quoteSpent = simulatedReceipt.quoteSpent[index];
    assert.ok(tokenOut >= buy.minTokenOut && tokenOut > 0n && quoteSpent <= buy.quoteAmountIn, "Exact protected simulated buy");
    const market = marketEconomics[buy.marketIndex];
    const ratio = market.rawQuotePerRawToken;
    return { buyIndex: index, marketIndex: buy.marketIndex, quoteAsset: market.quoteAsset, quoteSymbol: market.quoteSymbol, quoteSpent, tokenOut,
      allInUnitPriceUsdX18: quoteSpent * UNIT * market.quoteUsdX18 / (tokenOut * 10n ** BigInt(market.quoteDecimals)),
      feeAndPriceImpactPremiumBps: (quoteSpent * ratio.denominator - tokenOut * ratio.numerator) * 10000n /
        (tokenOut * ratio.numerator),
      // Effective execution price includes fees and path impact, not post-buy marginal spot.
      priceBasis: "admitted-simulation-all-in-average-including-fees-and-price-impact" };
  });
  const economicReview = {
    schema: "black-market.launch-economic-review.v1", caseId: scenario.id, chainId: fixture.chainId,
    targetMarketCapUsdX18: fixture.targetMarketCapUsdX18, quotes, metadata, image: image?.descriptor ?? null,
    actualMintedSupply: token.supply, nftUnit: token.nftUnit, tokenDecimals: 18,
    predictedToken, markets: marketEconomics,
    expectedUnusedBurn: roundingBurn, expectedSupplyAfterMintRounding: token.supply - roundingBurn,
    fees: { lpFeePips: 3000, v4HookMaximumPips: 10000, v4HookMinimumPips: 1000, v4HookSensitivityPipsSecondsPerTick: 7654321,
      executorFeeBps: plan.executorFeeBps, feeAssets, v4Markets: scenario.markets.flatMap((spec, marketIndex) => spec.venue === "v4" ?
        [{ marketIndex, feeMode: spec.feeMode ?? 0, protocolFeeDenominator: selected.v4.envelope.protocolFeeDenominator,
          treasury: selected.v4.envelope.protocolTreasury, developerBeneficiary: selected.v4.envelope.beneficiary, developerFeeBps: 0 }] : []) },
    initialBuy: { slippageBps: BUY_SLIPPAGE_BPS, funding: planned.plan.funding, orderedBuys: planned.plan.buys, simulatedBuys,
      observedBlockNumber: planned.simulation.blockNumber, observedBlockHash: planned.simulation.blockHash },
    planHash: planned.planHash, finalizedPlan: finalizedPlan,
  };
  const reviewHash = economicReviewHash(economicReview);
  artifacts.save("economic-review.json", { ...economicReview, reviewHash });
  // Complete exact intent is owner-only and durable before attribution or chain signing.
  artifacts.privateRecovery({
    schema: "black-market.launch-example-recovery.v1", sdk: "node", caseId: artifacts.result.caseId,
    plan: finalizedPlan, mode: scenario.mode, confirmations, economicReview: { ...economicReview, reviewHash },
  });
  artifacts.save("plan.json", finalizedPlan);
  artifacts.save("hook-deployments.json", planned.hookDeployments);
  addressEqual(planned.predictedToken, predictedToken, "Finalized token prediction");
  artifacts.result.chain.planHash = planned.planHash;
  artifacts.result.chain.launchId = planned.launchId;
  artifacts.event("plan-finalized", { predictedToken, planHash: planned.planHash, launchId: planned.launchId, mode: planned.mode, markets: markets.length, positions: scenario.markets.reduce((sum, market) => sum + market.positions, 0), buys: buys.length, deployments: planned.hookDeployments });
  return { planned, predictedToken, economicReview, reviewHash };
}

export function apiTransport({ artifacts, signal, apiUrl, fetchImpl = fetch }) {
  let requestTimeoutMs = 30_000;
  let imageUpload;
  return {
    setTimeoutMs(ms) { requestTimeoutMs = Math.max(1, Math.min(30_000, ms)); },
    authorizeImageUpload(upload, descriptor) {
      assert.equal(upload.method, "PUT", "Only the exact issued image PUT is authorized");
      registerEndpointSecrets(artifacts.redactor, upload.url);
      imageUpload = { url: exampleImageUrl(upload.url), headers: { ...upload.headers }, descriptor };
    },
    fetchPublishedImage(url, descriptor) {
      return readExamplePublishedImage({ url, descriptor, artifacts, signal, timeoutMs: requestTimeoutMs, fetchImpl });
    },
    async fetch(url, init = {}) {
      const endpoint = new URL(url);
      const isImageUpload = imageUpload && init.method === "PUT" && endpoint.href === imageUpload.url;
      if (isImageUpload) {
        assert.deepEqual(init.headers, imageUpload.headers, "Exact API-issued image-upload headers");
        assert.ok(init.body instanceof Blob && init.body.type === imageUpload.descriptor.contentType &&
          init.body.size === imageUpload.descriptor.contentLength, "Exact frozen image-upload body");
        assert.equal(`0x${createHash("sha256").update(Buffer.from(await init.body.arrayBuffer())).digest("hex")}`,
          imageUpload.descriptor.sha256, "Exact signed image-upload digest");
      } else if (endpoint.origin !== new URL(apiUrl).origin) throw exampleError("UNSAFE_ENDPOINT", "API request changed the configured origin");
      launchApiUrl(endpoint.origin);
      const started = Date.now();
      artifacts.event("api-request", { method: init.method ?? "GET", url: String(url), headers: init.headers,
        body: isImageUpload ? { image: imageUpload.descriptor } : init.body ? JSON.parse(init.body) : undefined });
      try {
        const response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)].filter(Boolean)) });
        const text = await response.clone().text();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        if (body?.capability) {
          artifacts.redactor.addSecret(body.capability);
          artifacts.privateRecovery({ ...artifacts.recovery, session: body, capability: body.capability });
        }
        artifacts.event("api-response", { method: init.method ?? "GET", url: String(url), status: response.status, retryAfter: response.headers.get("Retry-After"), body, elapsedMs: Date.now() - started });
        return response;
      } catch (error) {
        artifacts.event("api-error", { url: String(url), elapsedMs: Date.now() - started, error: errorEvidence(error) });
        throw error;
      }
    },
  };
}

export async function stageMetadata({ fixture, plan, sdk, artifacts, transport, wallet, metadata, image }) {
  artifacts.stage("api-metadata");
  artifacts.result.api.status = "staging";
  delete artifacts.result.api.reason;
  assertFutureLaunchDeadline(plan.deadline);
  assert.equal(metadata.name, plan.token.name); assert.equal(metadata.symbol, plan.token.symbol);
  const idempotencyKey = `node-example-${randomUUID()}`;
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 600n;
  const typedData = {
    domain: { name: "Abyss Launch Attribution", version: "1", chainId: Number(plan.chainId), verifyingContract: plan.orchestrator },
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...sdk.launchAttributionTypes },
    primaryType: "LaunchAttribution",
    message: { chainId: plan.chainId.toString(), wallet: plan.creator, metadataHash: sdk.canonicalLaunchMetadataHash(metadata),
      imageSha256: image?.descriptor.sha256 ?? zeroHash, imageContentType: image?.descriptor.contentType ?? "",
      imageContentLength: String(image?.descriptor.contentLength ?? 0), idempotencyKey, nonce, deadline: deadline.toString() },
  };
  const signature = await wallet.signTypedData(typedData);
  artifacts.redactor.addSecret(signature);
  const request = { chainId: Number(plan.chainId), wallet: plan.creator, metadata,
    ...(image ? { image: image.descriptor } : {}), authorization: { nonce, deadline: deadline.toString(), signature } };
  const recovery = { ...artifacts.recovery, schema: "black-market.launch-example-recovery.v1", sdk: "node", caseId: artifacts.result.caseId, apiUrl: fixture.apiUrl, idempotencyKey, typedData, request };
  artifacts.privateRecovery(recovery);
  const signer = await recoverTypedDataAddress({ ...typedData, signature });
  addressEqual(signer, plan.creator, "Attribution signer");
  assertFutureLaunchDeadline(plan.deadline);
  const api = new sdk.LaunchApiClient({ baseUrl: fixture.apiUrl, retries: 1, fetch: transport.fetch.bind(transport) });
  let session = await api.createUploadSession(request, idempotencyKey);
  if (session.capability) artifacts.redactor.addSecret(session.capability);
  // Persist the one-time capability before even validating the response.
  artifacts.privateRecovery({ ...recovery, session, capability: session.capability });
  artifacts.result.api.session = session;
  artifacts.result.api.sessionId = session.sessionId;
  artifacts.event("metadata-session-created", { session });
  assert.ok(typeof session.capability === "string" && session.capability.length > 0, "Actual API must issue the one-time session capability");
  assert.equal(session.chainId, Number(plan.chainId)); addressEqual(session.wallet, plan.creator, "Session wallet");
  assert.equal(session.metadata.name, plan.token.name); assert.equal(session.metadata.symbol, plan.token.symbol);
  assert.equal(session.metadata.description, metadata.description || null); assert.ok(session.transactionHash == null, "New metadata session cannot already bind a transaction");
  const sessionId = session.sessionId;
  const capability = session.capability;
  if (image) {
    assert.equal(session.status, "awaiting_upload");
    for (const field of ["sha256", "contentType", "contentLength"]) assert.equal(session.image?.[field], image.descriptor[field], `Signed image ${field}`);
    assert.ok(session.upload, "The image session must issue a direct upload URL");
    assertFutureLaunchDeadline(plan.deadline);
    transport.authorizeImageUpload(session.upload, image.descriptor);
    await api.putImage(session.upload, new Blob([image.bytes], { type: image.descriptor.contentType }));
    assertFutureLaunchDeadline(plan.deadline);
    session = await api.completeUpload(Number(plan.chainId), sessionId, capability);
    artifacts.privateRecovery({ session, capability });
    artifacts.result.api.session = session;
    artifacts.event("image-upload-completed", { session });
    assert.equal(session.sessionId, sessionId); assert.equal(session.chainId, Number(plan.chainId));
    addressEqual(session.wallet, plan.creator, "Completed image session wallet");
    assert.equal(session.metadata.name, metadata.name); assert.equal(session.metadata.symbol, metadata.symbol);
    assert.equal(session.metadata.description, metadata.description || null);
    assert.ok(session.transactionHash == null, "Image completion cannot bind an activation");
    for (const field of ["sha256", "contentType", "contentLength"]) assert.equal(session.image?.[field], image.descriptor[field], `Verified image ${field}`);
    assert.equal(session.imageStatus, "ready");
    for (const field of ["width", "height"]) assert.ok(Number.isSafeInteger(session.image[field]) && session.image[field] > 0 && session.image[field] <= 4096, `Verified image ${field}`);
  } else assert.equal(session.image, null, "Metadata-only session retains no image");
  assert.equal(session.status, "ready_to_launch");
  assertFutureLaunchDeadline(plan.deadline);
  artifacts.result.api.status = "session-ready";
  return { api, sessionId, capability, metadata, image: image?.descriptor };
}

function limitSource(fixture, artifacts) {
  const policy = fixture.executionLimits;
  return async ({ block, chainId, account, orchestrator }) => {
    const limits = {
      chainId, account, orchestrator, observedBlockNumber: block.number, observedBlockHash: block.hash,
      chainGasLimit: policy.chainTransactionGasLimit === undefined ? undefined : BigInt(policy.chainTransactionGasLimit),
      rpcGasLimit: policy.rpcTransactionGasLimit === undefined ? undefined : BigInt(policy.rpcTransactionGasLimit),
      accountGasLimit: policy.accountTransactionGasLimit === undefined ? undefined : BigInt(policy.accountTransactionGasLimit),
      maxCalldataBytes: policy.maxCalldataBytes, headroomBps: policy.headroomBps,
    };
    artifacts.event("execution-limits", { limits, provenance: policy.provenance });
    return limits;
  };
}

async function executePlan({ client, fixture, planned, sdk, artifacts, signal, limits, wallet }) {
  const references = [];
  let activation;
  for (let step = 0; step < 64; step += 1) {
    artifacts.stage("build-next", { step });
    const reviewedTransaction = planned.transactions[step];
    const next = await sdk.buildNextTransaction({ client, planned, receipts: references, limits, submissionClient: client, reviewedTransaction, signal });
    if (!next) return { references, activation };
    assert.ok(reviewedTransaction, "No transaction outside the saved review may be submitted");
    for (const field of ["id", "kind", "chainId", "from", "to", "data", "value", "gas", "gasPrice"]) assert.equal(next[field], reviewedTransaction[field], `Fresh ${field} must match the saved review`);
    artifacts.event("next-admitted", { transaction: next });
    assert.equal(next.chainId, Number(planned.chainId));
    assert.equal(BigInt(await client.request({ method: "eth_chainId" })), planned.chainId, "Recheck execution chain before every send");
    addressEqual(next.from, planned.plan.creator, "Exact transaction creator");
    addressEqual(next.to, planned.plan.orchestrator, "Native-input conversion launch transaction destination");
    const functions = { atomic: "launchAtomic", begin: "beginLaunch", prepare: "prepareMarkets", activate: "activateLaunch" };
    const functionName = functions[next.kind];
    assert.ok(functionName, "Native-input conversion cases do not permit unrelated approval/cancellation writes");
    const args = next.kind === "begin" ? [planned.plan, sdk.LifecycleMode.Staged] : next.kind === "prepare" ? [planned.plan, next.marketStart, next.marketCount] : [planned.plan];
    assert.equal(next.data.toLowerCase(), encodeFunctionData({ abi: sdk.launchLifecycleAbi, functionName, args }).toLowerCase(), "Exact finalized-plan calldata");
    assert.ok(next.gas !== undefined && (next.gasPrice !== undefined || next.maxFeePerGas !== undefined && next.maxPriorityFeePerGas !== undefined) && next.admission?.admitted === true, "Actual next transaction needs stateful gas/envelope admission");
    assert.equal(next.admission.executionProof, "proved"); assert.equal(next.admission.protocolFit, "proved");
    assert.equal(next.admission.transportPreflight, "passed", "Exact immediate-next submission RPC preflight is required before signing");
    const ceiling = next.admission.limits.transactionGasCeiling;
    assert.ok(next.gas > 0n && (ceiling === undefined || next.gas <= ceiling), "Complete gas envelope must fit supplied restrictions; Nitro compute is separately proved");
    const calldataCap = next.admission.limits.maxCalldataBytes;
    assert.ok(calldataCap === undefined || (next.data.length - 2) / 2 <= calldataCap, "Exact calldata must fit any supplied cap");
    const envelope = transactionEnvelope(next);
    const wire = { ...envelope };
    for (const key of ["chainId", "value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"]) if (wire[key] !== undefined) wire[key] = toHex(BigInt(wire[key]));
    artifacts.stage(`submit-${next.kind}`, { id: next.id });
    artifacts.result.execution = "running"; artifacts.result.chain.status = "executing";
    const submitted = await submitSignedRecorded({
      transaction: { ...next, wire }, artifacts, signal, wallet, client,
      wait: async (hash) => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const receipt = await client.request({ method: "eth_getTransactionReceipt", params: [hash] });
          if (receipt) return receipt;
          await pause(100, signal);
        }
        throw exampleError("RECEIPT_TIMEOUT", `Submitted transaction was not included within 30 seconds: ${hash}`, { transactionHash: hash });
      },
    });
    const { row, receipt } = submitted;
    addressEqual(receipt.transactionHash, row.transactionHash, "Receipt transaction hash");
    addressEqual(receipt.from, next.from, "Receipt sender");
    addressEqual(receipt.to, next.to, "Receipt destination");
    if (BigInt(receipt.status) !== 1n) {
      let trace;
      try { trace = await client.request({ method: "debug_traceTransaction", params: [row.transactionHash, { tracer: "callTracer" }] }); }
      catch (error) { artifacts.event("revert-trace-unavailable", { transactionHash: row.transactionHash, error: errorEvidence(error) }); }
      if (trace) artifacts.event("transaction-revert-trace", { transactionHash: row.transactionHash, trace });
      row.status = "reverted"; artifacts.saveReceipts();
      throw exampleError("TRANSACTION_REVERTED", `Actual source-chain transaction reverted: ${row.transactionHash}`, { transactionHash: row.transactionHash, revertData: findRevertData(trace), receipt });
    }
    const includedBlock = await client.request({ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] });
    addressEqual(includedBlock?.hash, receipt.blockHash, "Canonical included block");
    const latest = BigInt(await client.request({ method: "eth_blockNumber" }));
    assert.ok(latest >= BigInt(receipt.blockNumber), "Required one confirmation must be included canonically");
    const reference = { transactionHash: row.transactionHash, observedBlockNumber: BigInt(receipt.blockNumber), observedBlockHash: receipt.blockHash, confirmations: 1 };
    row.status = "confirmed"; row.reference = reference; artifacts.saveReceipts();
    references.push(reference);
    if (["atomic", "activate"].includes(next.kind)) {
      assert.equal(activation, undefined, "Exactly one activation transaction is allowed");
      activation = { transactionHash: row.transactionHash, receipt };
      artifacts.result.chain.activationTransactionHash = row.transactionHash;
    }
    artifacts.privateRecovery({ receipts: references, activation });
    artifacts.event("transaction-confirmed", { reference, gasUsed: receipt.gasUsed, transactionKind: next.kind });
  }
  throw exampleError("EXECUTION_STEP_LIMIT", "Lifecycle did not terminate within 64 exact SDK transactions; state/hashes are retained");
}

async function verifyChain({ client, planned, references, activation, fixture, scenario, sdk, artifacts }) {
  artifacts.stage("chain-verification");
  assert.ok(activation, "A real atomic/activate receipt is required");
  const progress = await sdk.readLaunchProgress({ client, planned, receipts: references, confirmations: 1 });
  artifacts.result.chain.progress = progress;
  artifacts.save("progress.json", progress);
  artifacts.event("canonical-progress", { progress });
  const expectedPositions = scenario.markets.reduce((sum, market) => sum + market.positions, 0);
  assert.equal(progress.canonical.phase, sdk.LifecyclePhase.Active);
  addressEqual(progress.canonical.token, planned.predictedToken, "Actual canonical token");
  assert.equal(progress.canonical.marketCount, scenario.markets.length);
  assert.equal(progress.canonical.preparedMarkets, scenario.markets.length);
  assert.equal(progress.canonical.positionCount, expectedPositions);
  assert.equal(progress.canonical.buyCount, planned.plan.buys.length);
  assert.equal(progress.markets.length, scenario.markets.length);
  assert.ok(progress.confirmationSafe); assert.ok(progress.receipts.every((row) => row.status === "confirmed"));
  const tag = toHex(progress.confirmedBlockNumber);
  const read = (to, abi, name, args = []) => contractReader(client)(to, abi, name, args, tag);
  const token = planned.predictedToken;
  const runtime = await client.request({ method: "eth_getCode", params: [token, tag] });
  assert.ok(runtime !== "0x", "Actual deployed token runtime is required");
  const factoryRuntime = await client.request({ method: "eth_getCode", params: [planned.tokenFactory, tag] });
  assert.equal(keccak256(factoryRuntime).toLowerCase(), planned.tokenFactoryCodeHash.toLowerCase(), "Current immutable token-factory runtime binding");
  const deployments = artifacts.transactions.flatMap((row) => receiptEvents(row.receipt, planned.tokenFactory, sdk.lifecycleTokenFactoryAbi, "TokenDeployed"));
  assert.equal(deployments.length, 1, "Actual token-factory deployment event");
  addressEqual(deployments[0].token, token, "Factory deployed token"); addressEqual(deployments[0].launchId, planned.launchId, "Factory launch ID");
  assert.equal(deployments[0].kind, scenario.tokenKind, "Actual factory token kind");
  addressEqual(await read(planned.tokenFactory, sdk.lifecycleTokenFactoryAbi, "tokenOfLaunch", [planned.launchId]), token, "Factory token binding");
  addressEqual(await read(planned.tokenFactory, sdk.lifecycleTokenFactoryAbi, "launchOfToken", [token]), planned.launchId, "Factory reverse launch binding");
  const tokenState = {};
  for (const name of ["authority", "tokenFactory", "launchId", "rewardMode", "initialSupply", "burnOnCancel", "active", "cancelled", "exclusionsFinalized", "feeHub", "rewardModule"]) tokenState[name] = await read(token, sdk.lifecycleTokenContextAbi, name);
  for (const name of ["name", "symbol", "decimals", "totalSupply"]) tokenState[name] = await read(token, sdk.erc20Abi, name);
  tokenState.runtimeCodeHash = keccak256(runtime); tokenState.kind = deployments[0].kind;
  artifacts.result.chain.token = token;
  artifacts.result.chain.tokenState = tokenState;
  artifacts.event("actual-token", { token, tokenState });
  assert.equal(tokenState.name, planned.plan.token.name); assert.equal(tokenState.symbol, planned.plan.token.symbol); assert.equal(tokenState.decimals, 18);
  assert.equal(tokenState.initialSupply, planned.plan.token.supply);
  assert.equal(tokenState.rewardMode, scenario.rewardMode); assert.equal(tokenState.burnOnCancel, false);
  assert.equal(tokenState.active, true); assert.equal(tokenState.cancelled, false); assert.equal(tokenState.exclusionsFinalized, true);
  addressEqual(tokenState.authority, fixture.orchestrator, "Token authority"); addressEqual(tokenState.tokenFactory, planned.tokenFactory, "Token factory"); addressEqual(tokenState.launchId, planned.launchId, "Token launch ID");
  addressEqual(tokenState.feeHub, progress.canonical.feeHub, "Token fee hub"); addressEqual(tokenState.rewardModule, progress.canonical.rewards, "Token rewards binding");
  if (scenario.rewardMode === 0) addressEqual(tokenState.rewardModule, zeroAddress, "Reward-free module");
  else if (scenario.rewardMode === 2) addressEqual(tokenState.rewardModule, token, "Embedded holder dividends");
  else {
    assert.ok(!same(tokenState.rewardModule, token) && !same(tokenState.rewardModule, zeroAddress), "Actual distinct staking module");
    assert.notEqual(await client.request({ method: "eth_getCode", params: [tokenState.rewardModule, tag] }), "0x", "Staking runtime");
  }
  if (scenario.tokenKind === 1) {
    tokenState.nftUnit = await read(token, sdk.lifecycleErc404Abi, "unit");
    tokenState.metadataURI = await read(token, sdk.lifecycleErc404Abi, "baseURI");
    tokenState.mirror = await read(token, sdk.lifecycleErc404Abi, "mirrorERC721");
    artifacts.event("actual-erc404", { nftUnit: tokenState.nftUnit, metadataURI: tokenState.metadataURI, mirror: tokenState.mirror });
    assert.equal(tokenState.nftUnit, planned.plan.token.nftUnit); assert.equal(tokenState.metadataURI, planned.plan.token.metadataURI);
    assert.notEqual(await client.request({ method: "eth_getCode", params: [tokenState.mirror, tag] }), "0x", "Real ERC404 mirror runtime");
    addressEqual(await read(tokenState.mirror, sdk.lifecycleErc404MirrorAbi, "baseERC20"), token, "ERC404 mirror link");
  }
  const hub = tokenState.feeHub;
  addressEqual(await read(hub, sdk.lifecycleFeeHubAbi, "launchToken"), token, "Hub token");
  addressEqual(await read(hub, sdk.lifecycleFeeHubAbi, "rewards"), tokenState.rewardModule, "Hub reward module");
  assert.equal(await read(hub, sdk.lifecycleFeeHubAbi, "executorFeeBps"), 275);
  assert.equal(await read(hub, sdk.lifecycleFeeHubAbi, "finalized"), true);
  const assets = await read(hub, sdk.lifecycleFeeHubAbi, "assets");
  assert.deepEqual(assets.map((value) => value.toLowerCase()), planned.plan.feeAssets.map((policy) => policy.asset.toLowerCase()));
  const expectedRewardAssets = planned.plan.feeAssets.filter((policy) => policy.rewardsBps > 0).map((policy) => policy.asset.toLowerCase());
  const rewardAssets = await read(hub, sdk.lifecycleFeeHubAbi, "rewardAssets");
  assert.deepEqual(rewardAssets.map((value) => value.toLowerCase()), expectedRewardAssets);
  if (scenario.rewardMode !== 0) {
    const moduleAssets = await read(tokenState.rewardModule, sdk.lifecycleRewardsAbi, "rewardAssets");
    assert.deepEqual(moduleAssets.map((value) => value.toLowerCase()), expectedRewardAssets, "Actual reward-module assets");
  }
  artifacts.event("actual-reward-binding", { mode: scenario.rewardMode, module: tokenState.rewardModule, rewardAssets });
  for (const policy of planned.plan.feeAssets) {
    const actual = await read(hub, sdk.lifecycleFeeHubAbi, "policy", [policy.asset]);
    artifacts.event("actual-fee-policy", { policy: actual });
    addressEqual(actual.asset, policy.asset, "Actual fee asset");
    for (const key of ["ownerBps", "rewardsBps", "burnBps"]) assert.equal(actual[key], policy[key], `Actual ${key}`);
  }
  const activated = receiptEvents(activation.receipt, fixture.orchestrator, sdk.launchLifecycleAbi, "LaunchActivated");
  assert.equal(activated.length, 1); addressEqual(activated[0].launchId, planned.launchId, "Activation launch ID"); addressEqual(activated[0].planHash, planned.planHash, "Activation commitment"); addressEqual(activated[0].token, token, "Activation token");
  assert.equal(activated[0].marketCount, scenario.markets.length); assert.equal(activated[0].positionCount, expectedPositions);
  const buys = receiptEvents(activation.receipt, fixture.orchestrator, sdk.launchLifecycleAbi, "InitialBuyExecuted");
  const transfers = artifacts.transactions.flatMap((row) => receiptEvents(row.receipt, token, erc20Abi, "Transfer"));
  tokenState.inventory = verifyLaunchInventory({
    supply: planned.plan.token.supply, totalSupply: tokenState.totalSupply,
    orchestrator: fixture.orchestrator, creator: fixture.creator, transfers, buys,
    orchestratorBalance: await read(token, sdk.lifecycleErc20Abi, "balanceOf", [fixture.orchestrator]),
    creatorBalance: await read(token, sdk.lifecycleErc20Abi, "balanceOf", [fixture.creator]),
  });
  artifacts.event("actual-inventory-accounting", tokenState.inventory);
  artifacts.result.chain.buys = buys;
  artifacts.event("actual-ordered-buys", { buys });
  assert.equal(buys.length, planned.plan.buys.length);
  for (let index = 0; index < buys.length; index += 1) {
    const actual = buys[index]; const expected = planned.plan.buys[index];
    assert.equal(actual.buyIndex, index); assert.equal(actual.marketIndex, expected.marketIndex); addressEqual(actual.launchId, planned.launchId, "Buy launch ID");
    addressEqual(actual.quoteAsset, planned.plan.markets[expected.marketIndex].quoteAsset, "Market-specific buy quote"); addressEqual(actual.recipient, expected.recipient, "Buy recipient");
    assert.ok(actual.tokenOut >= expected.minTokenOut); assert.ok(actual.quoteSpent > 0n && actual.quoteSpent <= expected.quoteAmountIn);
  }
  const directory = await read(fixture.orchestrator, sdk.launchLifecycleAbi, "directory");
  const canonicalMarkets = [];
  artifacts.result.chain.markets = canonicalMarkets;
  for (const market of progress.markets) {
    const spec = scenario.markets[market.index];
    const config = spec.venue === "v4" ? sdk.decodePoolBoundV4LifecycleMarketConfig(planned.plan.markets[market.index].config) : sdk.decodeAbyssLifecycleMarketConfig(planned.plan.markets[market.index].config);
    const identity = market.prepared.identity;
    const quoteAsset = planned.plan.markets[market.index].quoteAsset;
    const currencies = [token, quoteAsset].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    addressEqual(identity.currency0, currencies[0], "Actual market currency0");
    addressEqual(identity.currency1, currencies[1], "Actual market currency1");
    const observation = { ...market, positions: [] };
    canonicalMarkets.push(observation);
    artifacts.event("actual-market", { market });
    assert.equal(market.live?.publicTrading, true, market.error ?? "Actual public trading must be open");
    assert.equal(identity.openingSqrtPriceX96, spec.venue === "v4" ? config.sqrtPriceX96 : config.openingSqrtPriceX96);
    assert.equal(identity.fee, 3000); assert.equal(identity.tickSpacing, 60);
    assert.equal(identity.venue, spec.venue === "v4" ? sdk.LifecycleVenue.UniswapV4 : sdk.LifecycleVenue.Abyss);
    assert.equal(market.prepared.positionCount, spec.positions); assert.ok(!same(market.prepared.custody, zeroAddress));
    if (spec.venue === "v4") {
      const sealed = await read(market.prepared.custody, sdk.lifecycleV4LockerAbi, "isSealed", [identity.poolId]);
      const count = await read(market.prepared.custody, sdk.lifecycleV4LockerAbi, "positionCount", [identity.poolId]);
      observation.permanentCustody = { sealed, count };
      assert.equal(sealed, true); assert.equal(count, BigInt(spec.positions));
    }
    const positions = await read(directory, sdk.lifecycleDirectoryAbi, "positions", [planned.launchId, market.index, 0n, BigInt(spec.positions)]);
    assert.equal(positions.length, spec.positions);
    const profile = planned.profiles.find((row) => same(row.id, identity.profileId));
    assert.ok(profile, "Actual market must use the planned registered profile");
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index]; const expected = config.positions[index];
      const [liquidity, custody] = await read(profile.adapter.implementation, sdk.lifecycleAdapterAbi, "readPosition", [position]);
      const actual = { ...position, actualLiquidity: liquidity, actualCustody: custody };
      observation.positions.push(actual);
      addressEqual(position.marketId, identity.canonicalId, "Position canonical market"); addressEqual(position.custody, market.prepared.custody, "Position committed custody");
      assert.equal(position.tickLower, expected.tickLower); assert.equal(position.tickUpper, expected.tickUpper);
      assert.equal(position.liquidity, expected.liquidity); assert.equal(liquidity, expected.liquidity); addressEqual(custody, market.prepared.custody, "Actual permanent position custody");
      if (spec.venue === "v4") addressEqual(position.salt, expected.salt, "Committed V4 position salt");
      else {
        const lock = await read(custody, sdk.abyssPositionLockerAbi, "locks", [position.tokenId]);
        actual.permanentLock = lock;
        for (let term = 0; term < 3; term += 1) addressEqual(lock[term], market.prepared.feeSource, "Abyss collector-owned permanent lock");
        assert.equal(lock[3], 0n); assert.equal(lock[4], false);
      }
      artifacts.event("actual-position-custody", { marketIndex: market.index, position: actual });
    }
  }
  assert.equal(await sdk.buildNextTransaction({ client, planned, receipts: references }), undefined, "Active is terminal; no implicit launch retry");
  artifacts.result.chain.status = "passed"; artifacts.result.execution = "completed";
  artifacts.event("chain-verified", { token, activationTransactionHash: activation.transactionHash, marketCount: canonicalMarkets.length, positionCount: expectedPositions, buyCount: buys.length });
}

export async function assertCanonicalExampleActivation({ client, planned, references, activation, sdk, artifacts, signal }) {
  try {
    assert.ok(activation?.receipt, "Retained original activation receipt is required");
    const original = references.find((reference) => same(reference.transactionHash, activation.transactionHash));
    assert.ok(original && original.observedBlockNumber === BigInt(activation.receipt.blockNumber) &&
      same(original.observedBlockHash, activation.receipt.blockHash), "Original typed receipt inclusion must remain retained");
    const progress = await sdk.readLaunchProgress({ client, planned, receipts: references, confirmations: planned.confirmations, signal });
    const evidence = { progress, references, originalActivation: {
      transactionHash: activation.transactionHash, blockNumber: original.observedBlockNumber, blockHash: original.observedBlockHash,
    } };
    artifacts.result.chain.progress = progress;
    artifacts.save("publication-progress.json", evidence);
    artifacts.event("publication-canonical-progress", evidence);
    artifacts.privateRecovery({ publicationEvidence: evidence });
    const receipt = progress.receipts.find((row) => same(row.transactionHash, activation.transactionHash));
    if (!progress.confirmationSafe || progress.canonical.phase !== sdk.LifecyclePhase.Active ||
        !same(progress.canonical.token, planned.predictedToken) || progress.receipts.length !== references.length ||
        !progress.receipts.every((row) => row.status === "confirmed") || receipt?.status !== "confirmed" ||
        !same(receipt.effectiveHash, activation.transactionHash) || receipt.blockNumber !== original.observedBlockNumber ||
        !same(receipt.blockHash, original.observedBlockHash)) {
      throw exampleError("ACTIVATION_CANONICALITY_CHANGED",
        "Original activation is no longer confirmation-safe canonical Active at its retained block number/hash; stop and reconcile the saved recovery evidence, never republish or relaunch",
        { data: evidence });
    }
    return progress;
  } catch (error) {
    artifacts.result.chain.status = "canonicality-failed";
    artifacts.result.execution = "reconciliation-required";
    artifacts.event("publication-canonicality-failed", { error: errorEvidence(error) });
    throw error;
  }
}

export async function publishAndVerify({ client, fixture, planned, references, activation, session, sdk, artifacts, transport, signal, timeoutSeconds }) {
  artifacts.stage("api-publication", { transactionHash: activation.transactionHash, timeoutSeconds });
  artifacts.result.api.activationTransactionHash = activation.transactionHash;
  const published = await publishUntilIndexed({
    timeoutMs: timeoutSeconds * 1000, artifacts, signal,
    isPending: (error) => error instanceof sdk.LaunchPublishPending,
    publish: async (remainingMs) => {
      const started = Date.now();
      await assertCanonicalExampleActivation({ client, planned, references, activation, sdk, artifacts, signal });
      const availableMs = remainingMs - (Date.now() - started);
      if (availableMs <= 0) throw exampleError("PUBLISH_TIMEOUT", "Canonical publication recheck exhausted the indexing deadline");
      transport.setTimeoutMs(availableMs);
      try { return await session.api.publishUploadSession(Number(planned.chainId), session.sessionId, session.capability, { chainId: Number(planned.chainId), transactionHash: activation.transactionHash }); }
      catch (error) {
        if (error instanceof sdk.LaunchPublishPending) {
          assert.equal(error.session.chainId, Number(planned.chainId));
          addressEqual(error.session.wallet, planned.plan.creator, "Pending API wallet");
          if (error.session.token != null) addressEqual(error.session.token, planned.predictedToken, "Pending API token");
          if (error.session.transactionHash != null) addressEqual(error.session.transactionHash, activation.transactionHash, "Pending API activation");
        }
        throw error;
      }
    },
  });
  artifacts.result.api.session = published;
  artifacts.event("actual-published-session", { session: published });
  addressEqual(published.token, planned.predictedToken, "Published actual token");
  addressEqual(published.transactionHash, activation.transactionHash, "Published activation transaction");
  assert.equal(published.chainId, Number(planned.chainId)); addressEqual(published.wallet, planned.plan.creator, "Published wallet");
  assert.ok(["optimistic", "final"].includes(published.status)); assert.ok(["optimistic", "final"].includes(published.canonicalStatus));
  assert.equal(published.metadataStatus, "ready", "Publication must actually make owner metadata available");
  assert.equal(published.metadata.name, planned.plan.token.name); assert.equal(published.metadata.symbol, planned.plan.token.symbol);
  assert.equal(published.metadata.description, session.metadata.description || null);
  if (session.image) {
    for (const field of ["sha256", "contentType", "contentLength"]) assert.equal(published.image?.[field], session.image[field], `Published image ${field}`);
    assert.equal(published.imageStatus, "ready");
    exampleImageUrl(published.imageUrl);
  }
  artifacts.stage("api-token-verification");
  transport.setTimeoutMs(30_000);
  const url = new URL(`/api/v1/launches/${planned.predictedToken}`, fixture.apiUrl);
  url.searchParams.set("chainId", String(planned.chainId));
  const response = await transport.fetch(url, { method: "GET" });
  const representation = await response.json();
  artifacts.result.api.representation = representation;
  artifacts.save("published-token.json", representation);
  artifacts.event("actual-api-token", { status: response.status, representation });
  if (!response.ok) throw exampleError(representation.code ?? "API_TOKEN_HTTP_ERROR", representation.error ?? `Actual token GET failed: HTTP ${response.status}`, { status: response.status, data: representation });
  assert.equal(representation.chainId, Number(planned.chainId));
  const item = representation.item;
  assert.ok(item && typeof item === "object", "Actual API launch detail must contain item");
  assert.equal(item.chainId, Number(planned.chainId)); addressEqual(item.token, planned.predictedToken, "Indexed actual token");
  addressEqual(item.transactionHash, activation.transactionHash, "Indexed activation provenance"); addressEqual(item.creator, planned.plan.creator, "Indexed creator");
  assert.ok(["optimistic", "final"].includes(item.canonicalStatus), "Indexed canonical status");
  assert.equal(item.metadata?.document?.name, planned.plan.token.name); assert.equal(item.metadata?.document?.symbol, planned.plan.token.symbol);
  assert.equal(item.launchedToken?.name, planned.plan.token.name); assert.equal(item.launchedToken?.symbol, planned.plan.token.symbol);
  assert.equal(item.metadata?.document?.description ?? "", session.metadata.description);
  if (session.image) {
    const imageKey = item.metadata?.document?.imageKey;
    assert.ok(imageKey?.startsWith(`launches/${planned.chainId}/${planned.predictedToken.toLowerCase()}/`), "Published token-bound image association");
    assert.equal(item.metadata.imageContentType, session.image.contentType);
    assert.equal(item.metadata.imageContentLength, session.image.contentLength);
    assert.equal(item.imageUrl, published.imageUrl, "Indexed non-null public image must match the published session");
    assert.ok(new URL(exampleImageUrl(item.imageUrl)).pathname.endsWith(`/${imageKey}`), "Public URL references the actual token-bound upload key");
    artifacts.stage("api-image-verification", { url: item.imageUrl, image: session.image });
    artifacts.result.api.image = await transport.fetchPublishedImage(item.imageUrl, session.image);
  }
  await assertCanonicalExampleActivation({ client, planned, references, activation, sdk, artifacts, signal });
  artifacts.result.api.status = "passed";
}

export async function assertExampleEconomicAuthority({ client, fixture, planned, economicReview, reviewHash, sdk, artifacts, signal, image, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  assertFutureLaunchDeadline(planned.plan.deadline);
  assert.equal(economicReviewHash(economicReview), reviewHash, "Saved economic review must not change");
  assert.equal(fixture.targetMarketCapUsdX18, economicReview.targetMarketCapUsdX18, "Reviewed target valuation");
  assert.equal(planned.plan.token.supply, economicReview.actualMintedSupply, "Actual reviewed total minted supply");
  assert.deepEqual(JSON.parse(sdk.serializeLaunchPlan(planned.plan)), economicReview.finalizedPlan, "Exact reviewed finalized intent");
  assert.equal(planned.planHash, economicReview.planHash, "Exact reviewed plan hash");
  if (image) assert.equal(`0x${createHash("sha256").update(image.bytes).digest("hex")}`, economicReview.image.sha256, "Frozen signed image remains unchanged");
  assertExampleConversionBindings({ plan: planned.plan, quotes: economicReview.quotes });
  addressEqual(await sdk.predictLifecycleToken({ client, plan: planned.plan }), economicReview.predictedToken, "Fresh reviewed token orientation");
  const block = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  // Only quotes that actually used Kyber need router re-admission; native-wrap
  // quotes are validated by planner admission and carry no router evidence.
  const kyberQuotes = economicReview.quotes.filter((quote) => quote.conversion.nativeWrap !== true);
  if (kyberQuotes.length > 0) {
    await assertExampleConversionAdmission({ client, fixture, escrow: kyberQuotes[0].conversion.escrow, sdk, block, artifacts });
  }
  const currentQuotes = [];
  for (const quote of economicReview.quotes) {
    const current = await readExampleQuoteUsdSeed({ sdk, fixture, quote, signal, fetchImpl });
    assertUnchangedEconomicQuote(quote.usdSeed, current);
    currentQuotes.push(current);
  }
  // An async API/registry/prediction reread cannot carry authority past the saved deadline.
  signal?.throwIfAborted();
  assertFutureLaunchDeadline(planned.plan.deadline);
  assertExampleConversionBindings({ plan: planned.plan, quotes: economicReview.quotes });
  artifacts.event("economic-authority-rechecked", { reviewHash, currentQuotes });
}

async function executeExample({ fixture, privateKey, scenario, sdk, artifacts, signal }) {
  validateCase(scenario);
  const metadata = resolveExampleIdentity(scenario, fixture.identityOverrides);
  const image = readExampleImage({ sdk, path: fixture.imagePath });
  artifacts.result.network = "chain-4663";
  artifacts.result.chain.chainId = fixture.chainId; artifacts.result.chain.rpcUrl = fixture.rpcUrl;
  artifacts.result.chain.orchestrator = fixture.orchestrator; artifacts.result.chain.creator = fixture.creator;
  artifacts.result.api = { status: "not-run", endpoint: fixture.apiUrl };
  artifacts.save("run-config.json", { configuration: fixture, case: scenario });
  const client = rpcClient(fixture.rpcUrl, artifacts, signal, "execution");
  artifacts.stage("deployment-provenance");
  const chainId = BigInt(await client.request({ method: "eth_chainId" }));
  assert.equal(chainId, 4663n, "Examples require Robinhood chain 4663");
  assert.equal(await client.request({ method: "eth_getCode", params: [fixture.creator, "latest"] }), "0x", "Creator must be an EOA");
  assert.notEqual(await client.request({ method: "eth_getCode", params: [fixture.orchestrator, "latest"] }), "0x", "Current orchestrator must be deployed");
  addressEqual(await contractReader(client)(fixture.orchestrator, sdk.launchLifecycleAbi, "registry"), fixture.implementationRegistry, "Configured deployment registry");
  // The local wallet is created only after the exact economic review is admitted.
  artifacts.event("deployment-verified", { chainId, creator: fixture.creator, orchestrator: fixture.orchestrator });
  const limits = limitSource(fixture, artifacts);
  const { planned, predictedToken, economicReview, reviewHash } = await constructPlan({ client, fixture, scenario, sdk, artifacts, signal, limits, metadata, image });
  const { plan } = planned;
  artifacts.save("planning.json", planned);
  artifacts.event("execution-plan", { mode: planned.mode, simulation: planned.simulation, prerequisites: planned.prerequisites, transactions: planned.transactions });
  assert.equal(planned.mode, scenario.mode, "Never silently change requested mode"); addressEqual(planned.predictedToken, predictedToken, "Planner token prediction");
  if (!planned.simulation.admitted) throw exampleError("PLAN_NOT_ADMITTED", planned.simulation.reason ?? "The actual SDK did not admit this exact launch", { simulation: planned.simulation });
  const usd = (value) => `${value / UNIT}.${(value % UNIT).toString().padStart(18, "0")}`;
  console.log(`Economic review ${reviewHash}\n${metadata.name} (${metadata.symbol}); target USD ${usd(economicReview.targetMarketCapUsdX18)}; minted supply ${usd(economicReview.actualMintedSupply)}\n` +
    economicReview.markets.map((market) => `Market ${market.marketIndex} ${market.venue}/${market.quoteSymbol}: retained-supply opening valuation USD ${usd(market.retainedSupplyOpeningValuationUsdX18)} (minted-supply USD ${usd(market.openingValuationUsdX18)}), token USD ${usd(market.unitPriceUsdX18)}, token ${market.quoteSymbol} ${usd(market.unitPriceQuoteX18)}, ${market.positions.length} positions`).join("\n") +
    `\nExpected rounding burn ${economicReview.expectedUnusedBurn} raw token units; ${planned.plan.buys.length} ordered buys, native input ${fixture.buyAmountWei} wei each via Kyber conversion; 50 bps conversion and ordered-buy protection.\nLP fee 3000 pips; V4 hook max 10000/min 1000 pips (fixed maximum schedule); executor 275 bps.\nImage ${image ? `${image.descriptor.contentType}, ${image.descriptor.contentLength} bytes, ${image.descriptor.sha256}` : "none (metadata only)"}.\nReview allocations, fees and exact protected buys: ${artifacts.directory}/economic-review.json`);
  console.log(economicReview.initialBuy.simulatedBuys.map((buy) => `Buy ${buy.buyIndex} market ${buy.marketIndex}/${buy.quoteSymbol}: quote spent ${buy.quoteSpent} raw units; simulated all-in USD/token ${usd(buy.allInUnitPriceUsdX18)}; fees + price-impact premium ${buy.feeAndPriceImpactPremiumBps} bps vs opening`).join("\n"));
  for (const quote of economicReview.quotes) {
    const seed = quote.usdSeed;
    console.log(`${quote.symbol}/USD ${usd(seed.priceUsdX18)}; source ${seed.source}; chain ${seed.chainId}; quote ${seed.tokenAddress} (${seed.tokenDecimals} decimals); retrieved ${seed.retrievedAt}.\n` +
      (seed.source === "abyss-api" ? `API ${seed.apiOrigin}, indexed block ${seed.indexedBlock}; graph block ${seed.blockNumber}; WETH graph block ${seed.graphBlockNumber}; ${seed.anchorKind} anchor ${seed.anchorAggregator}; upstream ${seed.sourceTimestamp} (${seed.upstreamAgeSeconds} seconds old at retrieval). Indicative valuation, not execution proof.\n` : "Reviewed SDK USDG dollar peg; no WETH API-price substitution.\n") +
      (quote.conversion.nativeWrap === true
        ? `Native-wrap payable funding; input ${quote.conversion.nativeInputPerBuy} wei per buy across ${quote.conversion.buyCount} buy(s); oracle ${quote.oracle.oracleConfigId}.`
        : `Kyber ${quote.conversion.apiOrigin}; input ${quote.conversion.response.amountIn} native wei; protected quote output ${quote.conversion.response.amountOutMinimum} raw ${quote.symbol}; conversion price impact ${quote.conversion.response.priceImpactBps ?? "unknown"} bps; expires ${quote.conversion.response.expiresAt}; oracle ${quote.oracle.oracleConfigId}.`));
  }
  const economicAdmission = await admitEconomicReview(reviewHash);
  artifacts.privateRecovery({ economicAdmission });
  artifacts.save("economic-admission.json", economicAdmission);
  const assertEconomicAuthority = () => assertExampleEconomicAuthority({ client, fixture, planned, economicReview, reviewHash, sdk, artifacts, signal, image });
  const localWallet = createLocalLaunchWallet({ privateKey, creator: fixture.creator, chainId, orchestrator: fixture.orchestrator, client, redactor: artifacts.redactor });
  const wallet = guardEconomicReviewWallet(localWallet, assertEconomicAuthority);
  const transport = apiTransport({ artifacts, signal, apiUrl: fixture.apiUrl });
  const session = await stageMetadata({ fixture, plan, sdk, artifacts, transport, wallet, metadata, image });
  const executed = await executePlan({ client, fixture, planned, sdk, artifacts, signal, limits, wallet });
  await verifyChain({ client, planned, ...executed, fixture, scenario, sdk, artifacts });
  await publishAndVerify({ client, fixture, planned, ...executed, session, sdk, artifacts, transport, signal, timeoutSeconds: 90 });
  artifacts.stage("completed");
}

export async function runLaunchExample(caseObject) {
  const redactor = new Redactor();
  let artifacts;
  const controller = new AbortController();
  const interrupted = () => controller.abort(exampleError("INTERRUPTED", "Launch example interrupted; submitted hashes and chain state are retained"));
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  try {
    const caseId = caseObject.id;
    assert.match(caseId, /^[a-z0-9-]+$/, "Example case ID must be a safe directory label");
    mkdirSync("launch-results", { recursive: true, mode: 0o700 });
    artifacts = new RunArtifacts(join("launch-results", `${new Date().toISOString().replaceAll(":", "-")}-${caseId}-${randomUUID()}`), caseId, redactor);
    artifacts.initialize();
    loadExampleEnvironment();
    redactor.addSecret(process.env.PRIVATE_KEY);
    if (typeof process.env.PRIVATE_KEY === "string") redactor.addSecret(process.env.PRIVATE_KEY.slice(2));
    // Import after .env loading: the public SDK resolves address overrides on import.
    const sdk = await import("@black-market/sdk");
    const { fixture, privateKey } = await readExampleConfiguration(sdk, redactor);
    await executeExample({ fixture, privateKey, scenario: caseObject, sdk, artifacts, signal: controller.signal });
    artifacts.finish("passed");
    console.log(`Actual chain launch and API publication/indexing passed\nArtifacts: ${artifacts.directory}\nToken: ${artifacts.result.chain.token}`);
    return artifacts.result;
  } catch (failure) {
    const error = controller.signal.aborted ? controller.signal.reason : failure;
    if (error !== failure && error instanceof Error) error.cause = failure;
    if (artifacts) {
      if (artifacts.result.stage.startsWith("api-")) artifacts.result.api.status = "failed";
      else if (artifacts.result.execution === "running") artifacts.result.chain.status = "failed";
      try { artifacts.finish("failed", error); }
      catch (storageError) { console.error(JSON.stringify(redactor.value({ artifactWriteError: errorEvidence(storageError), originalError: errorEvidence(error) }))); }
    }
    console.error(JSON.stringify(redactor.value({ sdk: "node", caseId: artifacts?.result.caseId, status: "failed", stage: artifacts?.result.stage ?? "configuration", error: errorEvidence(error), artifacts: artifacts?.directory }), null, 2));
    process.exitCode = 1;
    return artifacts?.result;
  } finally {
    process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  }
}
