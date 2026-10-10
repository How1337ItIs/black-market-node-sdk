import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, custom, isAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";
import { createDecipheriv, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const USD_UNIT = 10n ** 18n;
const Q96 = 1n << 96n;
const REVIEWED_API_ANCHOR_AGGREGATOR = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const REVIEWED_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** Exact USD decimal input; never a floating-point price or a manual ETH/USD fallback. */
export function targetMarketCapUsdX18(value = "5000") {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw exampleError("INVALID_CONFIGURATION", "EXAMPLE_TARGET_MARKET_CAP_USD must be an exact positive USD decimal with at most 18 fractional digits");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * USD_UNIT + BigInt(fraction.padEnd(18, "0"));
  if (amount <= 0n || amount >= 1n << 256n) throw exampleError("INVALID_CONFIGURATION", "Target valuation must fit a positive uint256 USD x18 amount");
  return amount;
}

function apiUint256(value, label, positive = false) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) throw exampleError("INVALID_PRICE_QUOTE", `${label} must be a canonical uint256 decimal string`);
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n || positive && parsed === 0n) throw exampleError("INVALID_PRICE_QUOTE", `${label} must fit ${positive ? "a positive" : "an unsigned"} uint256`);
  return parsed;
}

/** API publication supplies indicative seeding economics, not execution authority. */
export function validateApiWethUsdSeed({ snapshot, apiUrl, nowSeconds = BigInt(Math.floor(Date.now() / 1000)) }) {
  const apiOrigin = new URL(launchApiUrl(apiUrl)).origin;
  if (!snapshot || snapshot.chainId !== 4663 || !Array.isArray(snapshot.items) || snapshot.items.length > 100) {
    throw exampleError("INVALID_PRICE_QUOTE", "Token-prices snapshot must contain a bounded chain-4663 items array");
  }
  const matches = snapshot.items.filter((row) => typeof row?.address === "string" && row.address.toLowerCase() === REVIEWED_WETH.toLowerCase());
  if (matches.length !== 1) throw exampleError("INVALID_PRICE_QUOTE", "Token-prices snapshot must contain exactly one reviewed WETH row");
  const row = matches[0];
  if (row.chainId !== 4663 || row.decimals !== 18 || row.metadataStatus !== "ready" || row.priced !== true) {
    throw exampleError("INVALID_PRICE_QUOTE", "WETH USD seed requires chain 4663, ready metadata, 18 decimals and an API-published price");
  }
  const provenance = row.provenance;
  if (row.source !== "anchor" || typeof provenance?.anchorToken !== "string" || provenance.anchorToken.toLowerCase() !== REVIEWED_WETH.toLowerCase() ||
      provenance?.anchor?.kind !== "chainlink" || typeof provenance.anchor.aggregator !== "string" || provenance.anchor.aggregator.toLowerCase() !== REVIEWED_API_ANCHOR_AGGREGATOR.toLowerCase() ||
      provenance.hopCount !== 0 || !Array.isArray(provenance.path) || provenance.path.length !== 0) {
    throw exampleError("PRICE_SOURCE_CHANGED", "WETH USD seed must retain its reviewed direct Chainlink anchor; obtain a new source review");
  }
  const sourceTimestamp = apiUint256(provenance.sourceTimestamp, "Upstream source timestamp", true);
  if (typeof nowSeconds !== "bigint" || nowSeconds < sourceTimestamp) throw exampleError("INVALID_PRICE_QUOTE", "Upstream source timestamp cannot be in the future");
  return {
    source: "abyss-api", apiOrigin, chainId: 4663, tokenAddress: REVIEWED_WETH, tokenDecimals: 18,
    priceUsdX18: apiUint256(row.priceUsdX18, "WETH USD x18 price", true),
    anchorToken: REVIEWED_WETH, anchorKind: "chainlink", anchorAggregator: REVIEWED_API_ANCHOR_AGGREGATOR, priceSource: "anchor",
    indexedBlock: apiUint256(snapshot.indexedBlock, "API indexed block"),
    blockNumber: apiUint256(snapshot.blockNumber, "API graph block"),
    graphBlockNumber: apiUint256(provenance.graphBlockNumber, "WETH graph block"),
    sourceTimestamp, retrievedAt: nowSeconds, upstreamAgeSeconds: nowSeconds - sourceTimestamp,
  };
}

/** One bounded GET only: no redirects, pagination, retry or fallback. */
export async function readApiWethUsdSeed({ sdk, fixture, signal, fetchImpl = fetch }) {
  if (fixture.chainId !== "4663" || fixture.quoteDecimals !== 18 ||
      sdk.getAddresses(4663).weth?.toLowerCase() !== REVIEWED_WETH.toLowerCase() || fixture.quoteAsset?.toLowerCase() !== REVIEWED_WETH.toLowerCase()) {
    throw exampleError("PRICE_SOURCE_CHANGED", "The reviewed chain-4663 WETH seed asset changed; obtain a new source review");
  }
  const apiUrl = launchApiUrl(fixture.apiUrl);
  const url = new URL("/api/v1/token-prices", apiUrl);
  url.searchParams.set("chainId", "4663"); url.searchParams.set("limit", "100");
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const maxBytes = 1024 * 1024;
  try {
    requestSignal.throwIfAborted();
    const response = await fetchImpl(url, { method: "GET", redirect: "error", cache: "no-store", headers: { Accept: "application/json" }, signal: requestSignal });
    if (!response.ok || response.redirected || response.url && new URL(response.url).href !== url.href) throw exampleError("PRICE_API_UNAVAILABLE", "Token-prices request failed or changed its endpoint", { status: response.status });
    if (!response.body) throw exampleError("INVALID_PRICE_QUOTE", "Token-prices response body is missing");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d{1,20}$/.test(length) || BigInt(length) > BigInt(maxBytes))) throw exampleError("INVALID_PRICE_QUOTE", "Token-prices response exceeds its 1 MiB body limit");
      while (true) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw exampleError("INVALID_PRICE_QUOTE", "Token-prices response exceeds its 1 MiB body limit");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    let snapshot;
    try { snapshot = JSON.parse(text); }
    catch { throw exampleError("INVALID_PRICE_QUOTE", "Token-prices response is not valid JSON"); }
    return validateApiWethUsdSeed({ snapshot, apiUrl });
  } catch (error) {
    if (error.name === "LaunchExampleError") throw error;
    throw exampleError("PRICE_API_UNAVAILABLE", "Token-prices snapshot could not be retrieved or decoded", { cause: error });
  }
}
export function resolveExampleQuotes({ sdk, fixture, scenario }) {
  const quotes = [...new Set(scenario.markets.map((market) => market.quote ?? "WETH"))].map((symbol) => {
    if (symbol === "WETH") return { symbol, tokenAddress: fixture.quoteAsset, tokenDecimals: fixture.quoteDecimals };
    const catalog = sdk.AUCTION_QUOTE_OPTIONS?.find((quote) => quote.id === "USDG");
    if (symbol !== "USDG" || !catalog || catalog.address.toLowerCase() !== sdk.ROBINHOOD_USDG?.toLowerCase() ||
        catalog.decimals !== 6 || catalog.usdPeg !== true) {
      throw exampleError("UNSUPPORTED_QUOTE", "USDG requires the SDK's reviewed chain-4663 six-decimal USD-peg asset");
    }
    return { symbol, tokenAddress: catalog.address, tokenDecimals: catalog.decimals };
  });
  return quotes.sort((left, right) => BigInt(left.tokenAddress) < BigInt(right.tokenAddress) ? -1 : 1);
}

export async function readExampleQuoteUsdSeed({ sdk, fixture, quote, signal, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  if (quote.symbol === "WETH") return readApiWethUsdSeed({
    sdk, fixture: { ...fixture, quoteAsset: quote.tokenAddress, quoteDecimals: quote.tokenDecimals }, signal, fetchImpl,
  });
  const catalog = sdk.AUCTION_QUOTE_OPTIONS?.find((row) => row.id === "USDG");
  if (fixture.chainId !== "4663" || quote.symbol !== "USDG" || !catalog || catalog.usdPeg !== true ||
      catalog.decimals !== 6 || quote.tokenDecimals !== 6 ||
      catalog.address.toLowerCase() !== sdk.ROBINHOOD_USDG?.toLowerCase() ||
      quote.tokenAddress.toLowerCase() !== catalog.address.toLowerCase()) {
    throw exampleError("PRICE_SOURCE_CHANGED", "The reviewed chain-4663 USDG peg asset changed; obtain a new explicit review");
  }
  return { source: "usd-peg", priceSource: "usd-peg", chainId: 4663,
    tokenAddress: quote.tokenAddress, tokenDecimals: 6, priceUsdX18: USD_UNIT,
    retrievedAt: BigInt(Math.floor(Date.now() / 1000)) };
}

/** Each quote's protected conversion output is split across its ordered buys exactly. */
export function buildExampleBuysAndFunding({ sdk, fixture, scenario, markets, quotes, predictedToken }) {
  const allocations = new Map(quotes.map((quote) => {
    if (!quote.conversion) throw exampleError("MISSING_CONVERSION", "Every quote requires actual reviewed funding evidence; no funding fallback");
    const count = markets.filter((market) => market.quoteAsset.toLowerCase() === quote.tokenAddress.toLowerCase()).length * scenario.buysPerMarket;
    // Native-wrap (WETH) buys consume the exact per-buy ETH input; Kyber-funded
    // quotes consume the API's protected minimum output, split exactly.
    const total = quote.conversion.nativeWrap === true
      ? quote.conversion.nativeInputPerBuy * BigInt(count)
      : BigInt(quote.conversion.response.amountOutMinimum);
    const amounts = allocateMarketBudgets(total, count);
    return [quote.tokenAddress.toLowerCase(), { amounts, next: 0 }];
  }));
  const buys = markets.flatMap((market, marketIndex) => {
    const allocation = allocations.get(market.quoteAsset.toLowerCase());
    if (!allocation) throw exampleError("UNSUPPORTED_QUOTE", "Every market must have a reviewed funding output");
    const token0 = BigInt(predictedToken) < BigInt(market.quoteAsset);
    return Array.from({ length: scenario.buysPerMarket }, () => ({
      marketIndex, quoteAmountIn: allocation.amounts[allocation.next++], minTokenOut: 1n, recipient: fixture.creator,
      sqrtPriceLimitX96: token0 ? 1461446703485210103287273052203988822378723970341n : 4295128740n,
    }));
  });
  const funding = quotes.map((quote) => {
    if (quote.conversion.nativeWrap === true) {
      // Payable native-wrap escrow funding: the launch transaction carries this
      // ETH as msg.value and the escrow wraps it to WETH during activation.
      const amount = quote.conversion.nativeInputPerBuy * BigInt(quote.conversion.buyCount);
      return { asset: quote.tokenAddress, amount, kind: sdk.LifecycleFundingKind.NativeWrap,
        inputAsset: quote.tokenAddress, inputAmount: amount, target: "0x0000000000000000000000000000000000000000", data: "0x" };
    }
    const response = quote.conversion.response;
    return { asset: quote.tokenAddress, amount: BigInt(response.amountOutMinimum), kind: sdk.LifecycleFundingKind.Swap,
      inputAsset: "0x0000000000000000000000000000000000000000", inputAmount: BigInt(response.amountIn),
      target: response.transaction.to, data: response.transaction.data };
  });
  return { buys, funding };
}

export function assertFutureLaunchDeadline(deadline, nowMs = Date.now()) {
  if (deadline * 1000n <= BigInt(nowMs)) throw exampleError("LAUNCH_DEADLINE_EXPIRED",
    "The reviewed launch deadline expired; obtain a new explicit economic review. Never extend or rewrite the saved plan.");
}


export function assertUnchangedEconomicQuote(reviewed, current) {
  const keys = ["source", "chainId", "tokenAddress", "tokenDecimals", "priceSource", "priceUsdX18"];
  if (reviewed.source === "abyss-api") keys.push("apiOrigin", "anchorToken", "anchorKind", "anchorAggregator");
  for (const key of keys) {
    const address = ["tokenAddress", "anchorToken", "anchorAggregator"].includes(key);
    const normalize = (value) => address ? String(value).toLowerCase() : String(value);
    if (reviewed[key] === undefined || current[key] === undefined || normalize(reviewed[key]) !== normalize(current[key])) throw exampleError("ECONOMIC_REVIEW_CHANGED", "Quote USD seed economics changed; stop and obtain a new explicit economic review, never rewrite or replay the saved intent");
  }
}

/** Both signature paths must pass the same final economic review guard. */
export function guardEconomicReviewWallet(wallet, assertEconomicAuthority) {
  return {
    address: wallet.address,
    async signTypedData(typedData) { await assertEconomicAuthority(); return wallet.signTypedData(typedData); },
    async signTransaction(wire) { await assertEconomicAuthority(); return wallet.signTransaction(wire); },
  };
}

export function allocateMarketBudgets(supply, count) {
  if (supply <= 0n || !Number.isSafeInteger(count) || count < 1 || supply < BigInt(count)) throw exampleError("INVALID_ALLOCATION", "Each market requires a positive share of actual total supply");
  const base = supply / BigInt(count);
  return Array.from({ length: count }, (_, index) => index === count - 1 ? supply - base * BigInt(index) : base);
}

/** Rounded-up mint debit, not the cap. Matches canonical SqrtPriceMath funding. */
export function positionMintDebit({ liquidity, sqrtPriceLowerX96: lower, sqrtPriceUpperX96: upper }, tokenIsCurrency0) {
  const ceil = (a, b) => (a + b - 1n) / b;
  return tokenIsCurrency0 ? ceil(ceil((liquidity << 96n) * (upper - lower), upper), lower) : ceil(liquidity * (upper - lower), Q96);
}

/** Rational token price in raw paired units. x18 displays floor only at the end. */
export function openingEconomics({ sqrtPriceX96, tokenIsCurrency0, quoteDecimals, quoteUsdX18, supply }) {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  const numerator = tokenIsCurrency0 ? squared : 1n << 192n;
  const denominator = tokenIsCurrency0 ? 1n << 192n : squared;
  const quoteUnit = 10n ** BigInt(quoteDecimals);
  return {
    rawQuotePerRawToken: { numerator, denominator },
    unitPriceQuoteX18: numerator * USD_UNIT * USD_UNIT / (denominator * quoteUnit),
    unitPriceUsdX18: numerator * USD_UNIT * quoteUsdX18 / (denominator * quoteUnit),
    openingValuationUsdX18: numerator * supply * quoteUsdX18 / (denominator * quoteUnit),
  };
}

export function deriveExampleMarketEconomics({ sdk, supply, tokenBudget, tokenIsCurrency0, positions, venue, quoteUsdX18, targetUsdX18, quoteDecimals, distributionPreset = "staircase" }) {
  const recipe = sdk.deriveLaunchPoolRecipe({ supply, tokenBudget, pairedTokenDecimals: quoteDecimals,
    pairedTokenUsdPriceX18: quoteUsdX18, targetMarketCapUsdX18: targetUsdX18, launchedTokenIsQuote: tokenIsCurrency0, fee: 3000, tickSpacing: 60 });
  const ranges = positions === 1 ? [{
    tickLower: recipe.tickLower, tickUpper: recipe.tickUpper, liquidity: recipe.liquidity, maxTokenAmount: tokenBudget,
    sqrtPriceLowerX96: sdk.getSqrtRatioAtTick(recipe.tickLower), sqrtPriceUpperX96: sdk.getSqrtRatioAtTick(recipe.tickUpper),
  }] : sdk.deriveLaunchPositionRanges({ launchSqrtPriceX96: recipe.launchSqrtPriceX96, launchedTokenIsQuote: tokenIsCurrency0,
    tokenBudget, tickSpacing: 60, venue: venue === "v4" ? "uniswap-v4" : "abyss", distributionPreset,
    positionGaps: "adjacent", extendFinalRangeToBoundary: true, positionCount: positions }).positions;
  const reviewedPositions = ranges.map((position) => {
    const expectedMintDebit = positionMintDebit(position, tokenIsCurrency0);
    if (expectedMintDebit <= 0n || expectedMintDebit > position.maxTokenAmount) throw exampleError("INVALID_ALLOCATION", "Recipe mint debit exceeds its exact allocation");
    return { ...position, expectedMintDebit, roundingBurn: position.maxTokenAmount - expectedMintDebit };
  });
  return { venue, tokenBudget, distributionPreset: positions === 1 ? "single-range" : distributionPreset,
    positionGaps: "adjacent", extendFinalRangeToBoundary: true,
    tokenIsCurrency0, openingTick: recipe.launchTick, sqrtPriceX96: recipe.launchSqrtPriceX96, tickSpacing: 60,
    ...openingEconomics({ sqrtPriceX96: recipe.launchSqrtPriceX96, tokenIsCurrency0, quoteDecimals, quoteUsdX18, supply }),
    positions: reviewedPositions, roundingBurn: reviewedPositions.reduce((sum, position) => sum + position.roundingBurn, 0n) };
}

export function economicReviewHash(review) {
  return keccak256(toHex(JSON.stringify(review, (_key, value) => typeof value === "bigint" ? value.toString() : value)));
}

export function assertEconomicReviewAdmission(reviewHash, admittedHash) {
  if (admittedHash !== reviewHash) throw exampleError("ECONOMIC_REVIEW_REQUIRED", "Explicit admission must match this exact economic review hash");
}

export async function admitEconomicReview(reviewHash) {
  let admittedHash = process.env.EXAMPLE_ECONOMIC_REVIEW_HASH;
  if (!admittedHash && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { admittedHash = await prompt.question("Type the economic review hash to authorize this exact launch: "); }
    finally { prompt.close(); }
  }
  assertEconomicReviewAdmission(reviewHash, admittedHash);
  return { reviewHash, admittedAt: new Date().toISOString(), policy: "unchanged-exact-api-price-and-source; upstream-age-preserved" };
}


export function exampleError(code, message, details = {}) {
  return Object.assign(new Error(message), { name: "LaunchExampleError", code, ...details });
}

/** An interrupted simulation still must restore its snapshot; never revert source state. */
export function rpcRequestSignal(signal, backend, method) {
  const cleanup = backend === "simulation" && ["evm_revert", "anvil_stopImpersonatingAccount", "hardhat_stopImpersonatingAccount"].includes(method);
  if (!cleanup) signal.throwIfAborted();
  // Cold nested-fork state fetches can exceed 30 seconds. Bound each request,
  // including instrumented controlled simulation; never retry a source broadcast.
  const timeout = AbortSignal.timeout(120_000);
  return cleanup ? timeout : AbortSignal.any([signal, timeout]);
}


export function loopbackUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw exampleError("UNSAFE_ENDPOINT", `${label} must be an explicit loopback HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw exampleError("UNSAFE_ENDPOINT", `${label} must be a loopback HTTP(S) service root without credentials, path, query or fragment`);
  }
  return url.href;
}

/** Register endpoint secrets before parsing/validation can emit public evidence. */
export function registerEndpointSecrets(redactor, value) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    const values = [url.username, url.password, url.search, url.hash, ...url.searchParams.values()];
    if (url.pathname !== "/") values.push(url.pathname, ...url.pathname.split("/").filter(Boolean));
    for (const secret of values) {
      redactor.addSecret(secret);
      try { redactor.addSecret(decodeURIComponent(secret)); } catch { /* Invalid encoding remains registered verbatim. */ }
    }
    if (values.some(Boolean)) redactor.addSecret(value);
  } catch { redactor.addSecret(value); }
}

export function executionRpcUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw exampleError("UNSAFE_ENDPOINT", "RPC_URL must be HTTPS or an owned loopback HTTP URL"); }
  if (url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw exampleError("UNSAFE_ENDPOINT", "RPC_URL must be HTTPS or an owned loopback HTTP URL without a fragment");
  return url.href;
}

export function launchApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw exampleError("UNSAFE_ENDPOINT", "LAUNCH_API_URL must be HTTPS or an owned loopback root"); }
  if (url.protocol === "http:") return loopbackUrl(value, "Launch API");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || !["", "/"].includes(url.pathname)) throw exampleError("UNSAFE_ENDPOINT", "LAUNCH_API_URL must be a service root without credentials, path, query or fragment");
  return url.href;
}

/** Image capability/public URLs may carry a path/query, but never credentials or fragments. */
export function exampleImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw exampleError("UNSAFE_ENDPOINT", "Image URL must be HTTPS or an owned loopback HTTP URL"); }
  // The published image is served from the launch API's public CDN (e.g. the R2
  // bucket host), which is a different origin than the API service root. Accept
  // any credential-free HTTPS image URL, plus owned loopback HTTP for local runs.
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || loopback)) throw exampleError("UNSAFE_ENDPOINT", "Image URL must be HTTPS or an owned loopback HTTP URL");
  if (url.username || url.password || url.hash) throw exampleError("UNSAFE_ENDPOINT", "Image URL must not contain credentials or a fragment");
  return url.href;
}

let environmentLoaded = false;
export function loadExampleEnvironment() {
  if (environmentLoaded) return;
  environmentLoaded = true;
  try { process.loadEnvFile(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
/** Bound descriptor reads, including file growth, without following a final symlink. */
function readBoundedExampleFile(path, limit, label, privateFile = false) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0") || Buffer.byteLength(path) > 4096) {
    throw exampleError("INVALID_CONFIGURATION", `${label} requires a valid local file path`);
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || privateFile && ((before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid())) {
      throw exampleError("UNSAFE_LOCAL_FILE", `${label} must be a regular file${privateFile ? " owned by the current user with owner-only permissions" : ""}`);
    }
    if (before.size < 1 || before.size > limit) throw exampleError("LOCAL_FILE_SIZE", `${label} must contain 1..${limit} bytes`);
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      bytes.fill(0);
      throw exampleError("LOCAL_FILE_CHANGED", `${label} changed while being read`);
    }
    return bytes.subarray(0, size);
  } catch (error) {
    if (error.name === "LaunchExampleError") throw error;
    throw exampleError("LOCAL_FILE_UNAVAILABLE", `${label} could not be read`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Minimal authenticated V3 scrypt/AES-128-CTR decryption using Node + existing viem. */
export async function loadExampleKeystore({ path, password = "", redactor = new Redactor() }) {
  redactor.addSecret(path); redactor.addSecret(password);
  if (typeof password !== "string" || !password.isWellFormed() || Buffer.byteLength(password) > 4096) {
    throw exampleError("INVALID_CONFIGURATION", "Keystore password must be valid UTF-8 within 4096 bytes");
  }
  const bytes = readBoundedExampleFile(path, 64 * 1024, "Keystore", true);
  let derived, passwordBytes, plaintext, macInput, computedMac;
  try {
    let json;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw exampleError("KEYSTORE_INVALID_FORMAT", "Keystore must be valid UTF-8 V3 JSON"); }
    const crypto = json?.crypto ?? json?.Crypto;
    if (json?.version !== 3 || crypto?.cipher !== "aes-128-ctr" || crypto?.kdf !== "scrypt") {
      throw exampleError("KEYSTORE_UNSUPPORTED_FORMAT", "Keystore must use V3 scrypt and AES-128-CTR");
    }
    const hex = (value, length) => typeof value === "string" && value.length === length * 2 && /^[\da-f]+$/i.test(value);
    const params = crypto.kdfparams;
    if (!hex(crypto.ciphertext, 32) || !hex(crypto.mac, 32) || !hex(crypto.cipherparams?.iv, 16) ||
        !params || params.dklen !== 32 || typeof params.salt !== "string" || !/^(?:[\da-f]{2}){1,64}$/i.test(params.salt) ||
        ![params.n, params.r, params.p].every((value) => Number.isSafeInteger(value) && value > 0) ||
        params.n < 2 || !Number.isInteger(Math.log2(params.n)) ||
        json.address !== undefined && !hex(json.address, 20)) {
      throw exampleError("KEYSTORE_INVALID_FORMAT", "Keystore contains invalid V3 cryptographic fields");
    }
    const maxmem = 320 * 1024 * 1024;
    if (params.n > 2 ** 18 || params.r > 32 || params.p > 16 || params.n * params.r * params.p > 2 ** 21 ||
        128 * params.n * params.r + 128 * params.r * params.p + 256 * params.r > maxmem ||
        Math.log2(params.n) >= 16 * params.r) {
      throw exampleError("KEYSTORE_KDF_LIMIT", "Keystore scrypt exceeds the supported resource limits");
    }
    passwordBytes = Buffer.from(password, "utf8");
    derived = await promisify(scrypt)(passwordBytes, Buffer.from(params.salt, "hex"), 32, { N: params.n, r: params.r, p: params.p, maxmem });
    const ciphertext = Buffer.from(crypto.ciphertext, "hex");
    macInput = Buffer.concat([derived.subarray(16, 32), ciphertext]);
    computedMac = Buffer.from(keccak256(macInput).slice(2), "hex");
    if (!timingSafeEqual(computedMac, Buffer.from(crypto.mac, "hex"))) {
      throw exampleError("KEYSTORE_AUTH_FAILED", "Keystore authentication failed");
    }
    const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(crypto.cipherparams.iv, "hex"));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const privateKey = toHex(plaintext);
    redactor.addSecret(privateKey); redactor.addSecret(privateKey.slice(2));
    let account;
    try { account = privateKeyToAccount(privateKey); }
    catch { throw exampleError("KEYSTORE_INVALID_KEY", "Authenticated keystore contains an invalid private key"); }
    if (json.address !== undefined && account.address.toLowerCase() !== `0x${json.address}`.toLowerCase()) {
      throw exampleError("KEYSTORE_ADDRESS_MISMATCH", "Keystore address does not match the decrypted key");
    }
    return privateKey;
  } catch (error) {
    if (error.name === "LaunchExampleError") throw error;
    throw exampleError("KEYSTORE_CRYPTO_FAILED", "Keystore cryptographic operation could not be completed");
  } finally { for (const buffer of [bytes, derived, passwordBytes, plaintext, macInput, computedMac]) buffer?.fill(0); }
}

export function resolveExampleIdentity(scenario, env = process.env) {
  const text = (key, fallback, maximum, byteMaximum, required) => {
    const raw = env[key] ?? fallback;
    if (typeof raw !== "string" || !raw.isWellFormed()) throw exampleError("INVALID_CONFIGURATION", `${key} must be valid Unicode text`);
    const value = raw.normalize("NFC").trim();
    if (required && !value || [...value].length > maximum || byteMaximum !== undefined && Buffer.byteLength(value) > byteMaximum) {
      throw exampleError("INVALID_CONFIGURATION", `${key} exceeds the token/API metadata text bounds`);
    }
    return value;
  };
  return {
    name: text("EXAMPLE_TOKEN_NAME", `Example ${scenario.id}`, 100, 128, true),
    symbol: text("EXAMPLE_TOKEN_SYMBOL", "EXAMPLE", 32, 32, true),
    description: text("EXAMPLE_TOKEN_DESCRIPTION", `Actual Node SDK launch example: ${scenario.id}`, 2000, undefined, false),
  };
}

export function readExampleImage({ sdk, path }) {
  if (!path) return undefined;
  const bytes = readBoundedExampleFile(path, sdk.MAX_LAUNCH_IMAGE_BYTES, "Launch image");
  const contentType = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!contentType || !sdk.LAUNCH_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw exampleError("IMAGE_INVALID", "Launch image bytes must identify an API-supported PNG, JPEG or WebP image");
  }
  return { bytes, descriptor: { sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`, contentType, contentLength: bytes.length } };
}
export async function readExamplePublishedImage({ url, descriptor, artifacts, signal, timeoutMs = 30_000,
  maxBytes = 5 * 1024 * 1024, fetchImpl = fetch }) {
  const endpoint = exampleImageUrl(url);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  const evidence = { url: endpoint, expected: descriptor, status: "requesting" };
  artifacts.event("published-image-request", evidence);
  try {
    const response = await fetchImpl(endpoint, { method: "GET", redirect: "error", signal: requestSignal });
    evidence.httpStatus = response.status;
    evidence.contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (response.status !== 200) throw exampleError("PUBLISHED_IMAGE_HTTP_ERROR", `Published image GET must return HTTP 200, received ${response.status}`);
    if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(evidence.contentType)) throw exampleError("PUBLISHED_IMAGE_TYPE_MISMATCH", "Published image must have the signed image content-type family");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d{1,20}$/.test(length) || BigInt(length) > BigInt(maxBytes))) {
      throw exampleError("PUBLISHED_IMAGE_SIZE", "Published image exceeds its bounded body limit");
    }
    if (!response.body) throw exampleError("PUBLISHED_IMAGE_EMPTY", "Published image body is missing");
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        evidence.contentLength = size;
        if (size > maxBytes) throw exampleError("PUBLISHED_IMAGE_SIZE", "Published image exceeds its bounded body limit");
        digest.update(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    requestSignal.throwIfAborted();
    if (size === 0) throw exampleError("PUBLISHED_IMAGE_EMPTY", "Published image body is empty");
    evidence.sha256 = `0x${digest.digest("hex")}`;
    evidence.transformed = evidence.sha256 !== descriptor.sha256;
    if (!evidence.transformed) {
      if (evidence.contentType !== descriptor.contentType) throw exampleError("PUBLISHED_IMAGE_TYPE_MISMATCH", "Byte-identical published image has a different content type");
      if (size !== descriptor.contentLength) throw exampleError("PUBLISHED_IMAGE_SIZE", "Byte-identical published image has a different length");
      evidence.verification = "byte-identical-upload";
    } else {
      evidence.verification = "nonempty-image-family";
      evidence.note = "[INFERENCE] API/CDN image transformation: served bytes differ from the signed upload; image family and nonempty bounded body verified, not byte-for-byte upload identity";
    }
    evidence.status = "passed";
    artifacts.save("published-image.json", evidence);
    artifacts.event("published-image-verified", evidence);
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = errorEvidence(error);
    artifacts.save("published-image.json", evidence);
    artifacts.event("published-image-failed", evidence);
    throw error;
  }
}



export async function readExampleConfiguration(sdk, redactor, env = process.env) {
  for (const value of [env.PRIVATE_KEY, env.EXAMPLE_KEYSTORE_PASSWORD, env.EXAMPLE_KEYSTORE_PATH, env.EXAMPLE_IMAGE_PATH]) redactor.addSecret(value);
  if (typeof env.PRIVATE_KEY === "string") redactor.addSecret(env.PRIVATE_KEY.slice(2));
  for (const value of [env.RPC_URL, env.LAUNCH_API_URL, env.EXAMPLE_KYBER_API_URL, env.NFT_BASE_URI]) registerEndpointSecrets(redactor, value);
  const hasKey = typeof env.PRIVATE_KEY === "string" && env.PRIVATE_KEY.trim().length > 0;
  const hasKeystore = typeof env.EXAMPLE_KEYSTORE_PATH === "string" && env.EXAMPLE_KEYSTORE_PATH.trim().length > 0;
  if (hasKey && hasKeystore) throw exampleError("SIGNER_SOURCE_CONFLICT", "Configure exactly one of PRIVATE_KEY or EXAMPLE_KEYSTORE_PATH, never both");
  if (!hasKey && !hasKeystore) throw exampleError("MISSING_CONFIGURATION", "Exactly one of PRIVATE_KEY or EXAMPLE_KEYSTORE_PATH is required");
  if (!env.LAUNCH_API_URL?.trim()) throw exampleError("MISSING_CONFIGURATION", "LAUNCH_API_URL is required in the environment or working-directory .env");
  const privateKey = hasKey ? env.PRIVATE_KEY : await loadExampleKeystore({ path: env.EXAMPLE_KEYSTORE_PATH, password: env.EXAMPLE_KEYSTORE_PASSWORD ?? "", redactor });
  if (!/^0x[\da-f]{64}$/i.test(privateKey)) throw exampleError("INVALID_PRIVATE_KEY", "PRIVATE_KEY must be a 32-byte hex private key");
  let account;
  try { account = privateKeyToAccount(privateKey); }
  catch { throw exampleError("INVALID_PRIVATE_KEY", "PRIVATE_KEY must be a valid 32-byte secp256k1 hex private key"); }
  const addresses = sdk.getAddresses(4663);
  const rpcUrl = executionRpcUrl(env.RPC_URL || sdk.robinhoodMainnet.rpcUrls.default.http[0]);
  const gasCap = (key) => {
    const value = env[key];
    if (value === undefined || value === "") return undefined;
    if (!/^[1-9]\d*$/.test(value)) throw exampleError("INVALID_CONFIGURATION", `${key} must be a positive decimal integer`);
    return value;
  };
  const integer = (key, fallback, minimum, maximum) => {
    if (fallback === undefined && (env[key] === undefined || env[key] === "")) return undefined;
    const value = env[key] || String(fallback);
    if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw exampleError("INVALID_CONFIGURATION", `${key} is outside its allowed integer range`);
    return Number(value);
  };
  const buyAmountWei = env.EXAMPLE_BUY_AMOUNT_WEI || "10000000000000";
  if (!/^[1-9]\d{0,77}$/.test(buyAmountWei) || BigInt(buyAmountWei) >= 1n << 256n) throw exampleError("INVALID_CONFIGURATION", "EXAMPLE_BUY_AMOUNT_WEI must be a positive canonical uint256 wei amount");
  const fixture = {
    chainId: "4663", rpcUrl, apiUrl: launchApiUrl(env.LAUNCH_API_URL),
    kyberApiUrl: launchApiUrl(env.EXAMPLE_KYBER_API_URL || env.LAUNCH_API_URL),
    orchestrator: addresses.launchOrchestrator, implementationRegistry: addresses.launchImplementationRegistry, creator: account.address,
    quoteAsset: addresses.weth, quoteDecimals: 18, oracleFactory: addresses.abyssFactory,
    targetMarketCapUsdX18: targetMarketCapUsdX18(env.EXAMPLE_TARGET_MARKET_CAP_USD),
    nftBaseUri: env.NFT_BASE_URI || "",
    buyAmountWei, signerSource: hasKey ? "private-key" : "v3-keystore",
    identityOverrides: Object.fromEntries(["EXAMPLE_TOKEN_NAME", "EXAMPLE_TOKEN_SYMBOL", "EXAMPLE_TOKEN_DESCRIPTION"].filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    imagePath: env.EXAMPLE_IMAGE_PATH || undefined,
    executionLimits: {
      chainTransactionGasLimit: gasCap("EXAMPLE_CHAIN_GAS_CAP"),
      rpcTransactionGasLimit: gasCap("EXAMPLE_RPC_GAS_CAP"),
      accountTransactionGasLimit: gasCap("EXAMPLE_ACCOUNT_GAS_CAP"),
      maxCalldataBytes: integer("EXAMPLE_MAX_CALLDATA_BYTES", undefined, 1, Number.MAX_SAFE_INTEGER),
      headroomBps: integer("EXAMPLE_HEADROOM_BPS", 1500, 0, 10000),
      provenance: { scope: "user-ceilings", note: "Optional local tightening restrictions, not verified provider or account limits" },
    },
  };
  return { fixture, privateKey };
}

const envelopeFields = ["chainId", "from", "to", "data", "value", "gas", "gasPrice", "nonce", "maxFeePerGas", "maxPriorityFeePerGas", "type", "accessList"];
export function transactionEnvelope(transaction) {
  return Object.fromEntries(envelopeFields.filter((field) => transaction[field] !== undefined).map((field) => [field, transaction[field]]));
}

function exactNumber(value, label) {
  const result = Number(BigInt(value));
  if (!Number.isSafeInteger(result) || result < 0) throw exampleError("INVALID_ENVELOPE", `${label} must be a nonnegative safe integer`);
  return result;
}

const transactionTypes = { "0x0": "legacy", "0x1": "eip2930", "0x2": "eip1559", legacy: "legacy", eip2930: "eip2930", eip1559: "eip1559" };

/**
 * Bounded local signer for exact SDK envelopes. No unlocked-account RPC, retries,
 * gas estimation, impersonation, source mutations or endpoint defaults.
 * Endpoint configuration belongs to the example; this helper also works
 * against an owned local Anvil supplied by the verification owner.
 */
export function createLocalLaunchWallet({ privateKey, creator, chainId, orchestrator, client, redactor }) {
  redactor.addSecret(privateKey);
  if (typeof privateKey === "string") redactor.addSecret(privateKey.slice(2));
  if (typeof privateKey !== "string" || !/^0x[\da-f]{64}$/i.test(privateKey)) throw exampleError("INVALID_PRIVATE_KEY", "PRIVATE_KEY must be a 32-byte hex private key");
  let account;
  try { account = privateKeyToAccount(privateKey); }
  catch { throw exampleError("INVALID_PRIVATE_KEY", "PRIVATE_KEY is not a valid secp256k1 private key"); }
  const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (!equal(account.address, creator)) throw exampleError("CREATOR_KEY_MISMATCH", "Local key must match the launch creator");
  const id = exactNumber(chainId, "chainId");
  const publicClient = createPublicClient({ transport: custom(client, { retryCount: 0 }) });
  async function assertChain() {
    if (BigInt(await client.request({ method: "eth_chainId" })) !== BigInt(id)) throw exampleError("CHAIN_MISMATCH", "Wallet RPC chain must match the launch/envelope");
  }
  return {
    address: account.address,
    async signTypedData(typedData) {
      await assertChain();
      if (BigInt(typedData.domain?.chainId ?? 0) !== BigInt(id) || !equal(typedData.domain?.verifyingContract, orchestrator) ||
          !equal(typedData.message?.wallet, creator) || BigInt(typedData.message?.chainId ?? 0) !== BigInt(id)) {
        throw exampleError("TYPED_DATA_MISMATCH", "Attribution domain, chain and wallet must match the launch");
      }
      const signature = await account.signTypedData(typedData);
      redactor.addSecret(signature);
      return signature;
    },
    async signTransaction(envelope) {
      await assertChain();
      for (const field of Object.keys(envelope)) if (!envelopeFields.includes(field)) throw exampleError("INVALID_ENVELOPE", `Unsupported transaction envelope field ${field}`);
      if (!equal(envelope.from, creator) || BigInt(envelope.chainId ?? 0) !== BigInt(id) || !isAddress(envelope.to)) throw exampleError("INVALID_ENVELOPE", "Transaction sender, chain and destination must be explicit and match the wallet");
      if (!/^0x(?:[\da-f]{2})*$/i.test(envelope.data ?? "") || envelope.value === undefined || envelope.gas === undefined || BigInt(envelope.gas) <= 0n) throw exampleError("INVALID_ENVELOPE", "Exact calldata, value and admitted positive gas are required");
      const request = { ...envelope, chainId: id };
      delete request.from;
      for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"]) {
        if (request[field] !== undefined) {
          request[field] = BigInt(request[field]);
          if (request[field] < 0n) throw exampleError("INVALID_ENVELOPE", `${field} must be unsigned`);
        }
      }
      request.nonce = envelope.nonce === undefined
        ? exactNumber(await client.request({ method: "eth_getTransactionCount", params: [creator, "pending"] }), "nonce")
        : exactNumber(envelope.nonce, "nonce");
      if (request.type !== undefined) {
        request.type = transactionTypes[request.type];
        if (!request.type) throw exampleError("INVALID_ENVELOPE", "Only legacy/EIP-2930/EIP-1559 envelopes are supported");
      }
      if (request.gasPrice !== undefined && (request.maxFeePerGas !== undefined || request.maxPriorityFeePerGas !== undefined)) throw exampleError("INVALID_ENVELOPE", "Do not mix legacy and EIP-1559 fee fields");
      if (request.gasPrice === undefined && request.maxFeePerGas === undefined && request.maxPriorityFeePerGas === undefined && request.type !== "eip1559") {
        request.gasPrice = BigInt(await client.request({ method: "eth_gasPrice" }));
      } else if (request.gasPrice === undefined && (request.maxFeePerGas === undefined || request.maxPriorityFeePerGas === undefined)) {
        const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
        request.maxFeePerGas ??= fees.maxFeePerGas;
        request.maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas;
      }
      const rawTransaction = await account.signTransaction(request);
      redactor.addSecret(rawTransaction);
      const wire = { ...envelope, chainId: toHex(id), nonce: toHex(request.nonce) };
      for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"]) if (request[field] !== undefined) wire[field] = toHex(request[field]);
      return { wire, rawTransaction, transactionHash: keccak256(rawTransaction) };
    },
  };
}

/** Persist hash + exact unsigned envelope BEFORE the single raw broadcast attempt. */
export async function submitSignedRecorded({ transaction, wallet, client, wait, artifacts, signal }) {
  signal?.throwIfAborted();
  const signed = await wallet.signTransaction(transaction.wire);
  artifacts.privateRecovery({ ...artifacts.recovery, signedTransactions: [
    ...(artifacts.recovery?.signedTransactions ?? []),
    { id: transaction.id, transactionHash: signed.transactionHash, rawTransaction: signed.rawTransaction },
  ] });
  signal?.throwIfAborted();
  const row = artifacts.submission({ ...transaction, wire: signed.wire }, signed.transactionHash, "broadcast-attempt");
  // The attempt is durable even if send times out, throws, or is interrupted.
  const returnedHash = await client.request({ method: "eth_sendRawTransaction", params: [signed.rawTransaction] });
  if (typeof returnedHash !== "string" || returnedHash.toLowerCase() !== signed.transactionHash.toLowerCase()) {
    throw exampleError("BROADCAST_HASH_MISMATCH", "RPC returned a hash different from the locally signed transaction", { transactionHash: signed.transactionHash, returnedHash });
  }
  row.status = "submitted"; row.submittedAt = new Date().toISOString();
  artifacts.saveReceipts();
  artifacts.event("transaction-submitted", row);
  signal?.throwIfAborted();
  const receipt = await wait(signed.transactionHash);
  artifacts.inclusion(row, receipt);
  return { row, receipt };
}

// Public evidence retains transaction calldata and revert bytes. Secrets are identified
// by field names, capability syntax, URLs, and values learned before any persistence.
export class Redactor {
  secrets = new Set();
  addSecret(value) { if (typeof value === "string" && value.length > 0) this.secrets.add(value); }
  text(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try { return JSON.stringify(this.value(JSON.parse(trimmed))); } catch { /* Not a serialized JSON value. */ }
    }
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join("[REDACTED]");
    result = result.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        const credentials = Boolean(url.username || url.password);
        const query = Boolean(url.search);
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        return `${url.href}${credentials || query ? "[REDACTED_URL_SECRET]" : ""}`;
      } catch { return "[REDACTED_URL]"; }
    });
    result = result.replace(/\blus_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
    result = result.replace(/\b(?:Launch-Upload-Capability|Bearer|Basic)\s+[^\s,"'}]+/gi, "[REDACTED_AUTH]");
    return result.replace(/((?:private[_ -]?key|signature|capability|authorization|password|secret|mnemonic|seed[_ -]?phrase|api[_ -]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|0x[\da-f]+|[^\s,"'}]+)/gi, "$1[REDACTED]");
  }
  value(value) {
    const visited = new WeakSet();
    const visit = (item, depth) => {
      if (depth > 30) return "[DEPTH_LIMIT]";
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "string") return this.text(item);
      if (typeof item === "function") return undefined;
      if (item === null || typeof item !== "object") return item;
      if (visited.has(item)) return "[CIRCULAR]";
      visited.add(item);
      if (Array.isArray(item)) {
        const result = item.map((entry) => visit(entry, depth + 1));
        visited.delete(item);
        return result;
      }
      const result = {};
      const keys = item instanceof Error ? [...new Set(["name", "message", "stack", "cause", ...Object.getOwnPropertyNames(item)])] : Object.keys(item);
      for (const key of keys) {
        if (/private.?key|secret|signature|capability|authorization|authentication|password|credential|mnemonic|seed.?phrase|(?:access|refresh|auth)[_-]?token|api[_-]?key|cookie/i.test(key)) result[key] = "[REDACTED]";
        else if (key === "apiOrigin") {
          try {
            const origin = new URL(launchApiUrl(item[key])).origin;
            result[key] = item[key] === origin ? origin : "[REDACTED_URL]";
          } catch { result[key] = "[REDACTED_URL]"; }
        }
        else if (item[key] !== undefined) result[key] = visit(item[key], depth + 1);
      }
      visited.delete(item);
      return result;
    };
    return visit(value, 0);
  }
}

export function errorEvidence(error) {
  if (!(error instanceof Error)) return { name: "UnknownError", message: String(error), cause: error };
  const evidence = { name: error.name, code: error.code, message: error.message, stack: error.stack, cause: error.cause, revertData: error.revertData, data: error.data };
  for (const key of Object.getOwnPropertyNames(error)) if (!(key in evidence)) evidence[key] = error[key];
  if (evidence.revertData === undefined) evidence.revertData = findRevertData(error.data ?? error.cause);
  return evidence;
}

export function findRevertData(value, seen = new WeakSet()) {
  if (typeof value === "string") return /^0x(?:[\da-f]{2})+$/i.test(value) ? value : undefined;
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const key of ["revertData", "returnValue", "output", "data", "result", "cause"]) {
    const data = findRevertData(value[key], seen);
    if (data) return data;
  }
  return undefined;
}

function durableWrite(path, content, mode = 0o600) {
  const fd = openSync(path, "w", mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}

export class RunArtifacts {
  constructor(output, caseId, redactor = new Redactor(), { resume = false } = {}) {
    this.directory = resolve(output);
    this.redactor = redactor;
    this.transactions = [];
    if (resume) {
      const recoveryPath = join(this.directory, "private-recovery.json");
      if (!existsSync(recoveryPath)) throw exampleError("MISSING_RECOVERY", "Resume requires private-recovery.json in the original recovery directory");
      this.recovery = JSON.parse(readBoundedExampleFile(recoveryPath, 16 * 1024 * 1024, "Private launch recovery", true).toString("utf8"));
      for (const secret of [this.recovery.capability, this.recovery.session?.capability, this.recovery.request?.authorization?.signature,
        ...(this.recovery.signedTransactions ?? []).map((row) => row.rawTransaction)]) redactor.addSecret(secret);
      for (const value of [this.recovery.apiUrl, this.recovery.session?.upload?.url, this.recovery.plan?.token?.metadataURI]) registerEndpointSecrets(redactor, value);
      const receiptsPath = join(this.directory, "receipts.json");
      if (existsSync(receiptsPath)) {
        const retained = JSON.parse(readBoundedExampleFile(receiptsPath, 16 * 1024 * 1024, "Retained launch receipts").toString("utf8"));
        if (!Array.isArray(retained.transactions)) throw exampleError("INVALID_RECOVERY", "Retained receipt journal requires transaction rows");
        this.transactions = retained.transactions;
      }
      const configurationPath = join(this.directory, "run-config.json");
      if (existsSync(configurationPath)) {
        this.configuration = JSON.parse(readBoundedExampleFile(configurationPath, 16 * 1024 * 1024, "Retained launch configuration").toString("utf8")).configuration;
      }
      caseId = this.recovery.caseId ?? caseId;
    } else mkdirSync(this.directory, { mode: 0o700 }); // EEXIST deliberately refuses reuse.
    this.result = {
      schema: "black-market.launch-example-result.v1", sdk: "node", caseId: caseId ?? null,
      status: "failed", stage: "configuration", scope: "end-to-end", execution: "not-run",
      chain: { status: "not-run", confirmations: 1, transactions: this.transactions },
      api: { status: "not-run" }, startedAt: new Date().toISOString(), completedAt: null,
    };
    this.stageStartedAt = Date.now();
    if (resume) {
      this.result.stage = "resume";
      this.result.execution = "resuming";
    }
  }
  initialize() {
    this.event(this.recovery ? "resumed" : "started", { directory: this.directory });
    if (!this.recovery) this.saveReceipts();
  }
  event(event, observations = {}) {
    const row = this.redactor.value({ timestamp: new Date().toISOString(), sdk: "node", caseId: this.result.caseId, stage: this.result.stage, event, ...observations });
    const fd = openSync(join(this.directory, "events.jsonl"), "a", 0o600);
    try { appendFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  }
  stage(stage, observations = {}) {
    this.event("stage-completed", { elapsedMs: Date.now() - this.stageStartedAt });
    this.result.stage = stage;
    this.stageStartedAt = Date.now();
    this.event("stage-started", observations);
  }
  save(name, value) {
    const path = join(this.directory, name);
    durableWrite(`${path}.tmp`, `${JSON.stringify(this.redactor.value(value), null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }
  privateRecovery(value) {
    const recovery = { ...this.recovery, ...value };
    // Session and broadcast updates cannot replace the original finalized intent.
    for (const key of ["plan", "mode", "confirmations", "economicReview", "economicAdmission"]) {
      if (this.recovery?.[key] !== undefined) recovery[key] = this.recovery[key];
    }
    const content = `${JSON.stringify(recovery, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
    const path = join(this.directory, "private-recovery.json");
    durableWrite(`${path}.tmp`, content, 0o600);
    renameSync(`${path}.tmp`, path);
    // Sync both the replacement and the fresh run directory's parent entry.
    for (const directory of [this.directory, dirname(this.directory)]) {
      const fd = openSync(directory, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.recovery = JSON.parse(content);
  }
  submission(transaction, transactionHash, status = "submitted") {
    const row = { id: transaction.id, kind: transaction.kind, transaction: transaction.wire, transactionHash, status, attemptedAt: new Date().toISOString(), receipt: null };
    if (status === "submitted") row.submittedAt = row.attemptedAt;
    this.transactions.push(row);
    this.saveReceipts();
    this.event(status === "broadcast-attempt" ? "transaction-broadcast-attempt" : "transaction-submitted", row);
    return row;
  }
  inclusion(row, receipt) {
    row.receipt = receipt;
    row.status = "included"; // Status/provenance is checked only after preserving it.
    row.includedAt = new Date().toISOString();
    this.saveReceipts();
    this.event("transaction-included", { id: row.id, transactionHash: row.transactionHash, receipt });
  }
  saveReceipts() {
    this.save("receipts.json", { schema: "black-market.launch-example-receipts.v1", sdk: "node", caseId: this.result.caseId, transactions: this.transactions });
  }
  finish(status, error) {
    this.result.status = status;
    this.result.completedAt = new Date().toISOString();
    if (error) this.result.error = errorEvidence(error);
    // Write the terminal result before its journal row, so a journal I/O error cannot
    // erase a completed transaction or the original failure diagnosis.
    this.save("result.json", this.result);
    this.event(status, { elapsedMs: Date.now() - this.stageStartedAt, scope: this.result.scope, error: this.result.error });
  }
}


export async function pause(ms, signal) {
  signal?.throwIfAborted();
  await delay(ms, undefined, { signal });
}

export async function publishUntilIndexed({ publish, isPending, timeoutMs, artifacts, signal, now = Date.now, sleep = pause }) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw exampleError("PUBLISH_TIMEOUT", "Actual API publication did not reach indexed optimistic/final state before the deadline");
    artifacts.event("publish-request", { attempt: ++attempt, remainingMs });
    try {
      const session = await publish(remainingMs);
      if (now() >= deadline) throw exampleError("PUBLISH_TIMEOUT", "The API publication response arrived after the indexing deadline");
      return session;
    }
    catch (error) {
      if (!isPending(error)) throw error; // No retry of API/RPC/schema/provenance errors.
      artifacts.result.api.status = "awaiting-indexer";
      artifacts.result.api.session = error.session;
      artifacts.event("publish-pending", { session: error.session, retryAfterMs: error.retryAfterMs });
      const retryAfterMs = Number(error.retryAfterMs);
      if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw exampleError("INVALID_RETRY_AFTER", "The API returned an invalid pending publication delay");
      const availableMs = deadline - now();
      if (availableMs <= 0) throw exampleError("PUBLISH_TIMEOUT", "Actual API publication exhausted its indexing deadline");
      await sleep(Math.min(Math.max(250, retryAfterMs), availableMs), signal);
    }
  }
}
