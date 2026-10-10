import assert from "node:assert/strict";
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, isAddress, keccak256, parseAbi, zeroAddress } from "viem";
import { assertFutureLaunchDeadline, exampleError, launchApiUrl } from "./launch-example-support.mjs";

// Reviewed third-party deployment/entry point from abyss-app's trading/deployments.ts.
// Current launch registry admission and runtime, not these addresses alone, authorize funding.
export const EXAMPLE_KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
export const EXAMPLE_KYBER_EXECUTOR = "0x8F10B468b06c6FD214B65F87778827F7D113f996";
export const EXAMPLE_KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const EXAMPLE_CONVERSION_SLIPPAGE_BPS = 50;
const EXECUTOR_IMPLEMENTATIONS = ["0x4f1423cce26c09fb31d96eafe702fc5e22421f6a", "0xd7a5c6b52756e795f680b0f7e0c2f21281dde6ef"];
export const exampleKyberRouterAbi = parseAbi([
  "function swap((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);
const escrowRegistryAbi = parseAbi(["function registry() view returns (address)"]);
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const uint = (value, label) => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) {
    throw exampleError("INVALID_KYBER_RESPONSE", `${label} must be a canonical uint256 decimal string`);
  }
  return BigInt(value);
};

function validateQuoteIdentity(response, quoteAsset, amountIn) {
  if (response?.chainId !== 4663 || response.source !== "kyberswap" ||
      !same(response.tokenIn, EXAMPLE_KYBER_NATIVE) || !same(response.tokenOut, quoteAsset) ||
      !same(response.routerAddress, EXAMPLE_KYBER_ROUTER) || uint(response.amountIn, "Kyber input") !== amountIn ||
      uint(response.amountOut, "Kyber output") <= 0n) {
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber response changes the reviewed chain, native input, quote, exact amount or router");
  }
  if (!Array.isArray(response.routePaths) || response.routePaths.length > 64 ||
      response.routePaths.some((path) => !Array.isArray(path) || path.length < 1 || path.length > 16 ||
        path.some((hop) => !hop || !isAddress(hop.tokenIn) || !isAddress(hop.tokenOut) ||
          ![hop.pool, hop.exchange, hop.poolType].every((text) => typeof text === "string" && text.length > 0 && text.length <= 256)))) {
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber response must retain bounded route-path evidence");
  }
  if (response.priceImpactBps !== undefined && !Number.isSafeInteger(response.priceImpactBps)) {
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber price impact must be a signed integer when provided; missing impact stays unknown");
  }
}

/** Exact app launch protection and reviewed swap entry point; never rebuild opaque bytes. */
export function validateExampleKyberBuild({ response, quoteAsset, amountIn, escrow, deadline, nowMs = Date.now() }) {
  assertFutureLaunchDeadline(deadline, nowMs);
  if (amountIn <= 0n || amountIn >= 1n << 255n || deadline > BigInt(Math.floor(nowMs / 1000)) + 1200n) {
    throw exampleError("INVALID_KYBER_INTENT", "Kyber launch input or deadline exceeds the app's supported intent bounds");
  }
  validateQuoteIdentity(response, quoteAsset, amountIn);
  const minimum = uint(response.amountOutMinimum, "Kyber minimum output");
  const expectedMinimum = uint(response.amountOut, "Kyber output") * BigInt(10000 - EXAMPLE_CONVERSION_SLIPPAGE_BPS) / 10000n;
  const transaction = response.transaction;
  if (minimum <= 0n || minimum !== expectedMinimum || response.expiresAt !== Number(deadline) ||
      !same(transaction?.to, EXAMPLE_KYBER_ROUTER) || uint(transaction?.value, "Kyber transaction value") !== amountIn ||
      typeof transaction?.data !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(transaction.data) ||
      (transaction.data.length - 2) / 2 > 16384) {
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber build changes the exact native value, output floor, deadline or lifecycle calldata bounds");
  }
  let decoded;
  try { decoded = decodeFunctionData({ abi: exampleKyberRouterAbi, data: transaction.data }); }
  catch { throw exampleError("INVALID_KYBER_CALLDATA", "Kyber calldata does not call the reviewed swap entry point"); }
  if (decoded.functionName !== "swap") throw exampleError("INVALID_KYBER_CALLDATA", "Kyber calldata does not call the reviewed swap entry point");
  const execution = decoded.args[0];
  const desc = execution.desc;
  if (!same(desc.srcToken, EXAMPLE_KYBER_NATIVE) || !same(desc.dstToken, quoteAsset) || !same(desc.dstReceiver, escrow) ||
      desc.amount !== amountIn || desc.minReturnAmount !== minimum ||
      !same(execution.callTarget, EXAMPLE_KYBER_EXECUTOR) || !same(execution.approveTarget, zeroAddress) ||
      execution.targetData.length < 106 || (execution.targetData.length - 42) % 64 !== 0 ||
      !EXECUTOR_IMPLEMENTATIONS.includes(execution.targetData.slice(0, 42).toLowerCase()) ||
      (desc.flags & 0x42n) !== 0n || desc.srcReceivers.length !== 0 || desc.srcAmounts.length !== 0 ||
      desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0 || desc.permit !== "0x") {
    throw exampleError("INVALID_KYBER_CALLDATA", "Kyber calldata changes a reviewed currency, escrow recipient, exact input, minimum, executor or fee policy");
  }
  return minimum;
}

export async function assertExampleConversionAdmission({ client, fixture, escrow, sdk, block, artifacts }) {
  const read = async (to, abi, functionName, args = []) => decodeFunctionResult({ abi, functionName,
    data: await client.request({ method: "eth_call", params: [{ to, data: encodeFunctionData({ abi, functionName, args }) }, block.number] }) });
  const [core, escrowRegistry, registryCore, wrappedNative, registration, code, executorCode] = await Promise.all([
    read(escrow, sdk.lifecycleFundingEscrowAbi, "core"), read(escrow, escrowRegistryAbi, "registry"),
    read(fixture.implementationRegistry, sdk.lifecycleRegistryAbi, "core"), read(escrow, sdk.lifecycleFundingEscrowAbi, "wrappedNative"),
    read(fixture.implementationRegistry, sdk.lifecycleRegistryAbi, "fundingTarget", [EXAMPLE_KYBER_ROUTER]),
    client.request({ method: "eth_getCode", params: [EXAMPLE_KYBER_ROUTER, block.number] }),
    client.request({ method: "eth_getCode", params: [EXAMPLE_KYBER_EXECUTOR, block.number] }),
  ]);
  assert.ok(same(core, fixture.orchestrator) && same(escrowRegistry, fixture.implementationRegistry) &&
    same(registryCore, fixture.orchestrator) && same(wrappedNative, fixture.quoteAsset), "Current funding escrow/registry/core/native bindings");
  const [spender, codeHash, enabled] = registration;
  const admitted = enabled && same(spender, EXAMPLE_KYBER_ROUTER) && code !== "0x" && same(keccak256(code), codeHash);
  artifacts.event("kyber-conversion-admission", { target: EXAMPLE_KYBER_ROUTER, spender, codeHash, enabled, admitted,
    nativeInput: true, blockNumber: block.number, blockHash: block.hash });
  if (!admitted) throw exampleError("KYBER_CONVERSION_NOT_ADMITTED",
    "Kyber conversion is not admitted by this launch deployment. No separate swap will be submitted.",
    { target: EXAMPLE_KYBER_ROUTER, spender, codeHash, enabled, blockNumber: block.number, blockHash: block.hash });
  assert.notEqual(executorCode, "0x", "Reviewed Kyber executor must be deployed");
  const canonical = await client.request({ method: "eth_getBlockByNumber", params: [block.number, false] });
  assert.ok(same(canonical?.hash, block.hash), "Funding authority block remains canonical");
}

async function requestKyber({ fixture, path, body, signal, fetchImpl }) {
  const url = new URL(path, launchApiUrl(fixture.kyberApiUrl));
  const response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw exampleError(errorBody.code ?? "KYBER_API_UNAVAILABLE", errorBody.error ?? `Kyber API failed: HTTP ${response.status}`, { status: response.status });
  }
  if (response.redirected || response.url && new URL(response.url).href !== url.href || !response.body) {
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber API response changed its endpoint or omitted the body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw exampleError("INVALID_KYBER_RESPONSE", "Kyber API response exceeds 1 MiB");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.name === "LaunchExampleError") throw error;
    throw exampleError("INVALID_KYBER_RESPONSE", "Kyber API response is not bounded valid UTF-8 JSON");
  } finally { reader.releaseLock(); }
}

/** One fresh build per quote; the API owns route preview, native inputs belong to the escrow. */
export async function buildExampleKyberConversions({ client, fixture, scenario, markets, quotes, escrow, deadline, sdk, block, artifacts, signal, fetchImpl = fetch }) {
  await assertExampleConversionAdmission({ client, fixture, escrow, sdk, block, artifacts });
  const requiredNative = BigInt(fixture.buyAmountWei) * BigInt(markets.length * scenario.buysPerMarket);
  const balance = BigInt(await client.request({ method: "eth_getBalance", params: [fixture.creator, block.number] }));
  artifacts.event("native-funding-balance", { balance, requiredNative, blockNumber: block.number, blockHash: block.hash });
  if (balance < requiredNative) throw exampleError("INSUFFICIENT_NATIVE_BALANCE", `Creator needs ${requiredNative} wei for all opening-buy conversions, plus gas; stopped unsigned`, { balance, requiredNative });
  for (const quote of quotes) {
    const buyCount = markets.filter((market) => same(market.quoteAsset, quote.tokenAddress)).length * scenario.buysPerMarket;
    const amountIn = BigInt(fixture.buyAmountWei) * BigInt(buyCount);
    assertFutureLaunchDeadline(deadline);
    const response = await requestKyber({ fixture, path: `/api/v1/quote/kyber/build?chainId=${fixture.chainId}`, signal, fetchImpl,
      body: { tokenIn: zeroAddress, tokenOut: quote.tokenAddress, amountIn: amountIn.toString(), sender: escrow, recipient: escrow,
        slippageBps: EXAMPLE_CONVERSION_SLIPPAGE_BPS, deadline: deadline.toString() } });
    validateExampleKyberBuild({ response, quoteAsset: quote.tokenAddress, amountIn, escrow, deadline });
    quote.conversion = { apiOrigin: new URL(fixture.kyberApiUrl).origin, escrow, response, nativeInputPerBuy: BigInt(fixture.buyAmountWei), buyCount,
      slippageBps: EXAMPLE_CONVERSION_SLIPPAGE_BPS };
    artifacts.event("kyber-funding-built", { quoteAsset: quote.tokenAddress, conversion: quote.conversion });
  }
  const canonical = await client.request({ method: "eth_getBlockByNumber", params: [block.number, false] });
  assert.ok(same(canonical?.hash, block.hash), "Conversion context remains canonical after API reads");
  assertFutureLaunchDeadline(deadline);
}

export function assertExampleConversionBindings({ plan, quotes }) {
  assert.equal(plan.funding.length, quotes.length, "Every native conversion output is reviewed once");
  for (const quote of quotes) {
    const funding = plan.funding.find((row) => same(row.asset, quote.tokenAddress));
    const conversion = quote.conversion;
    assert.ok(funding && conversion, "Every quote requires the original admitted conversion");
    const minimum = validateExampleKyberBuild({ response: conversion.response, quoteAsset: quote.tokenAddress,
      amountIn: uint(conversion.response.amountIn, "Reviewed native conversion input"), escrow: conversion.escrow, deadline: plan.deadline });
    assert.equal(funding.kind, 2, "Funding remains Swap, never native-wrap or direct ERC20");
    assert.ok(same(funding.inputAsset, zeroAddress) && same(funding.target, conversion.response.transaction.to), "Exact native input and reviewed router");
    assert.equal(funding.inputAmount, BigInt(conversion.response.amountIn));
    assert.equal(funding.amount, minimum); assert.equal(funding.data, conversion.response.transaction.data);
    const buys = plan.buys.filter((buy) => same(plan.markets[buy.marketIndex].quoteAsset, quote.tokenAddress));
    assert.equal(buys.length, conversion.buyCount);
    assert.ok(buys.every((buy) => same(buy.recipient, plan.creator) && buy.quoteAmountIn > 0n), "Every reviewed buy remains creator-bound and funded");
    assert.equal(buys.reduce((sum, buy) => sum + buy.quoteAmountIn, 0n), minimum, "Ordered quote inputs exactly consume the API minimum-output budget");
    assert.equal(funding.inputAmount, conversion.nativeInputPerBuy * BigInt(buys.length), "Exact native ETH input per ordered buy");
  }
}
