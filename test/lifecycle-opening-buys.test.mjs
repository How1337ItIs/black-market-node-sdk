import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { keccak256 } from "viem";

const sdkPath = process.env.SDK_SOURCE_TEST === "1" ? "../src/lifecycle/index.ts" : "../dist/lifecycle/index.js";
const { computeLifecycleOpeningBuys, encodeAbyssLifecycleMarketConfig, encodePoolBoundV4LifecycleMarketConfig,
  parseLaunchPlan, serializeLaunchPlan } = await import(sdkPath);
const base = JSON.parse(await readFile(new URL("./fixtures/launch-lifecycle-v1.json", import.meta.url), "utf8")).plan;
const { vectors } = JSON.parse(await readFile(new URL("./fixtures/lifecycle-opening-buys.json", import.meta.url), "utf8"));
const revive = (value) => JSON.parse(JSON.stringify(value), (_key, item) => typeof item === "string" && /^-?\d+$/.test(item) ? BigInt(item) : item);

function curvePlan(vector) {
  const markets = vector.curve.markets.map(({ config: decoded, configHash, ...market }) => {
    const config = market.configVersion === 1 ? encodeAbyssLifecycleMarketConfig(revive(decoded)) : encodePoolBoundV4LifecycleMarketConfig(revive(decoded));
    assert.equal(keccak256(config), configHash, "Extracted parameters reproduce the actual recorded market config");
    return { ...market, config };
  });
  // The vectors contain curve parameters, not a substitute execution receipt or
  // an admitted full launch. Unused plan fields come from the portable fixture.
  return parseLaunchPlan(JSON.stringify({ ...base, ...vector.curve, markets }));
}
for (const vector of vectors) test(`opening curve matches actual ordered amounts and Swap prices: ${vector.name}`, () => {
  const plan = curvePlan(vector), before = serializeLaunchPlan(plan);
  const quotes = computeLifecycleOpeningBuys({ plan, predictedToken: vector.predictedToken });
  assert.equal(quotes.length, vector.expected.length);
  for (const [index, quote] of quotes.entries()) {
    assert.equal(quote.buyIndex, index);
    assert.equal(quote.marketIndex, plan.buys[index].marketIndex);
    assert.equal(quote.quoteAmountIn, plan.buys[index].quoteAmountIn);
    for (const field of ["quoteSpent", "tokenOut", "sqrtPriceAfterX96"]) assert.equal(quote[field], BigInt(vector.expected[index][field]), `${field} at ordered buy ${index}`);
  }
  assert.equal(serializeLaunchPlan(plan), before, "Local quoting never rewrites committed calldata");
});

test("only V4 resolves the zero price-limit sentinel, without mutating the original buy", () => {
  const vector = vectors.find((row) => row.name.includes("0x3db38db2"));
  const original = curvePlan(vector);
  const plan = { ...original, buys: original.buys.map((buy) => ({ ...buy, sqrtPriceLimitX96: 0n })) };
  const quote = computeLifecycleOpeningBuys({ plan, predictedToken: vector.predictedToken })[0];
  for (const field of ["quoteSpent", "tokenOut", "sqrtPriceAfterX96"]) assert.equal(quote[field], BigInt(vector.expected[0][field]));
  assert.equal(plan.buys[0].sqrtPriceLimitX96, 0n);
  const abyss = vectors.find((row) => row.name.includes("0x4cbc4258")), abyssPlan = curvePlan(abyss);
  assert.throws(() => computeLifecycleOpeningBuys({ plan: { ...abyssPlan, buys: abyssPlan.buys.map((buy) => ({ ...buy, sqrtPriceLimitX96: 0n })) }, predictedToken: abyss.predictedToken }), { code: "INVALID_BUY_PRICE_LIMIT" });
});

test("fee-only dust cannot recross an initialized tick or change the next ordered curve output", () => {
  const vector = vectors.find((row) => row.name.includes("0x4cbc4258")), original = curvePlan(vector);
  const buy = original.buys[0], dust = { ...buy, quoteAmountIn: 1n };
  const quotes = computeLifecycleOpeningBuys({ plan: { ...original, buys: [dust, dust, buy] }, predictedToken: vector.predictedToken });
  for (const quote of quotes.slice(0, 2)) { assert.equal(quote.quoteSpent, 1n); assert.equal(quote.tokenOut, 0n); }
  for (const field of ["quoteSpent", "tokenOut", "sqrtPriceAfterX96"]) assert.equal(quotes[2][field], BigInt(vector.expected[0][field]));
});

test("unknown profiles and invalid exact-input boundaries are never represented as local curve evidence", () => {
  const vector = vectors.find((row) => row.name.includes("0x4cbc4258")), plan = curvePlan(vector);
  assert.throws(() => computeLifecycleOpeningBuys({ plan: { ...plan, markets: plan.markets.map((market) => ({ ...market, profileId: `0x${"ff".repeat(32)}` })) }, predictedToken: vector.predictedToken }), { code: "OPENING_BUY_NOT_PROFILED" });
  for (const quoteAmountIn of [0n, -1n, 1n << 255n, Number.MAX_SAFE_INTEGER]) assert.throws(() => computeLifecycleOpeningBuys({ plan: { ...plan, buys: plan.buys.map((buy) => ({ ...buy, quoteAmountIn })) }, predictedToken: vector.predictedToken }), { code: "INVALID_BUY" });
  assert.throws(() => computeLifecycleOpeningBuys({ plan: { ...plan, buys: plan.buys.map((buy) => ({ ...buy, marketIndex: -1 })) }, predictedToken: vector.predictedToken }), { code: "INVALID_BUY" });
});
