import assert from "node:assert/strict";
import test from "node:test";
import { LaunchApiClient, LaunchApiError } from "../dist/index.js";

const token = "0x1111111111111111111111111111111111111111";
const hash = `0x${"22".repeat(32)}`;
const body = {
  chainId: 4663, indexedBlock: "100212754", finalizedBlock: "100210706",
  item: { chainId: 4663, token, transactionHash: hash, blockNumber: "100207495", canonicalStatus: "final", lifecycle: { marketCount: "16" } },
};

test("getLaunch reads the directory without a wallet or publication request", async () => {
  let calls = 0;
  const client = new LaunchApiClient({ baseUrl: "https://example.invalid/", retries: 1, fetch: async (input, init) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.pathname, `/api/v1/launches/${token}`);
    assert.equal(url.searchParams.get("chainId"), "4663");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, undefined);
    return Response.json(body);
  } });
  assert.deepEqual(await client.getLaunch(4663, token), body);
  assert.equal(calls, 1);
});

for (const [status, code] of [[404, "NOT_FOUND"], [400, "UNSUPPORTED_CHAIN"], [429, "RATE_LIMITED"], [503, "INDEXER_UNAVAILABLE"]]) {
  test(`getLaunch preserves ${status} / ${code} rather than inferring onchain state`, async () => {
    let calls = 0;
    const client = new LaunchApiClient({ retries: 1, fetch: async () => {
      calls++;
      return Response.json({ code, error: "upstream detail" }, { status });
    } });
    await assert.rejects(client.getLaunch(4663, token), (error) =>
      error instanceof LaunchApiError && error.status === status && error.code === code && error.message === "upstream detail");
    assert.equal(calls, 1);
  });
}

test("getLaunch retains a missing-entry response that has no machine-readable code", async () => {
  const client = new LaunchApiClient({ retries: 1, fetch: async () =>
    Response.json({ error: "launch not found" }, { status: 404 }) });
  await assert.rejects(client.getLaunch(4663, token), (error) =>
    error instanceof LaunchApiError && error.status === 404 && error.message === "launch not found");
});
