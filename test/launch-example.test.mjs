import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { keccak256, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { typescriptNodeArgs } from "./register-typescript.mjs";
import {
  createLocalLaunchWallet, errorEvidence, executionRpcUrl, launchApiUrl,
  publishUntilIndexed, readExampleConfiguration, Redactor, registerEndpointSecrets,
  rpcRequestSignal, RunArtifacts, exampleError, submitSignedRecorded,
  targetMarketCapUsdX18, validateApiWethUsdSeed, readApiWethUsdSeed, assertUnchangedEconomicQuote, allocateMarketBudgets,
  guardEconomicReviewWallet,
  deriveExampleMarketEconomics, openingEconomics, economicReviewHash,
} from "../examples/launch-example-support.ts";
import { selectExampleFixedV4Profile, validateCase, verifyLaunchInventory } from "../examples/launch-example.ts";
const pricingSdk = await import(process.env.SDK_SOURCE_TEST === "1" ? "../src/index.ts" : "../dist/index.js");

const hash = `0x${"ab".repeat(32)}`;
const revertData = "0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001";
const transaction = { id: "activate", kind: "activate", wire: { from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, data: revertData, value: "0x0", gas: "0x100000", gasPrice: "0x1", nonce: "0x0", chainId: "0x1237" } };
function run(t) {
  const parent = mkdtempSync(join(tmpdir(), "node-launch-example-unit-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const artifacts = new RunArtifacts(join(parent, "run"), "diagnostic-boundary");
  artifacts.initialize();
  return artifacts;
}
const json = (artifacts, name) => JSON.parse(readFileSync(join(artifacts.directory, name), "utf8"));

// Diagnostic boundaries only. These tests do not pretend to deploy a token,
// simulate a chain, or prove publication against a mocked API/indexer.
test("fixed V4 examples select their original offering and never adopt a newly admitted dynamic hook", () => {
  const fixture = { chainId: 4663, orchestrator: pricingSdk.getAddresses(4663).launchOrchestrator };
  const fixed = { ...pricingSdk.getKnownLifecycleProfile({ ...fixture, key: pricingSdk.KnownLifecycleProfile.V4FixedFeePool }).profile, admitted: true };
  const dynamic = { ...pricingSdk.getKnownLifecycleProfile({ ...fixture, key: pricingSdk.KnownLifecycleProfile.V4DynamicFeePool }).profile, admitted: true };
  const select = (profiles, selectedFixture = fixture) => selectExampleFixedV4Profile({ profiles, fixture: selectedFixture, sdk: pricingSdk });
  assert.equal(select([dynamic, fixed]), fixed);
  assert.equal(select([fixed, dynamic]), fixed);
  assert.equal(select([dynamic, fixed], { ...fixture, chainId: "4663" }), fixed);
  assert.throws(() => select([dynamic]), { code: "PROFILE_NOT_ADMITTED" });
  assert.throws(() => select([{ ...fixed, admitted: false }, dynamic]), { code: "PROFILE_NOT_ADMITTED" });
  const unlisted = { ...fixture, orchestrator: zeroAddress };
  assert.equal(select([fixed], unlisted), fixed);
  assert.throws(() => select([dynamic, fixed], unlisted), { code: "PROFILE_NOT_ADMITTED" });
});

test("recursive evidence redaction preserves selector/calldata/cause and public capabilities", () => {
  const redactor = new Redactor();
  const signature = `0x${"cd".repeat(65)}`;
  const capability = "lus_private_recovery_capability_value";
  redactor.addSecret(signature); redactor.addSecret(capability);
  const cause = Object.assign(new Error(`execution reverted ${revertData}`), { code: -32000, data: { data: revertData } });
  const failure = Object.assign(new Error(`signature=${signature}; ${capability}; RPC https://user:password@example.org/path?credential=secret`), { code: "PLAN_NOT_ADMITTED", cause, data: { nested: { signature, capability, privateKey: "disposable-private", mnemonic: "secret words", headers: { Authorization: "Bearer hidden", "X-API-Key": "hidden-api-key" } }, capabilities: 123n, transaction: { data: revertData, token: transaction.wire.to }, url: "https://object.example.org/item?X-Amz-Signature=signed-query" } });
  const evidence = redactor.value(errorEvidence(failure));
  const text = JSON.stringify(evidence);
  for (const secret of [signature, capability, "disposable-private", "secret words", "password@example", "credential=secret", "signed-query", "hidden-api-key", "Bearer hidden"]) assert.ok(!text.includes(secret), secret);
  assert.equal(evidence.cause.code, -32000);
  assert.equal(evidence.cause.data.data, revertData);
  assert.equal(evidence.data.transaction.data, revertData);
  assert.equal(evidence.data.transaction.token, transaction.wire.to);
  assert.equal(evidence.data.capabilities, "123");
  assert.equal(evidence.code, "PLAN_NOT_ADMITTED");
});

test("one-time recovery secrets exist only in a mode0600 file", (t) => {
  const artifacts = run(t);
  const capability = "lus_owned_session_recovery_value";
  const signature = `0x${"12".repeat(65)}`;
  artifacts.redactor.addSecret(capability); artifacts.redactor.addSecret(signature);
  artifacts.privateRecovery({ capability, authorization: { signature } });
  artifacts.result.api.session = { capability, authorization: { signature } };
  artifacts.event("session", { capability, authorization: { signature } });
  artifacts.finish("failed", exampleError("API_NOT_READY", `Do not log ${capability} or ${signature}`));
  assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
  assert.equal(json(artifacts, "private-recovery.json").capability, capability);
  for (const name of ["events.jsonl", "result.json", "receipts.json"]) {
    const text = readFileSync(join(artifacts.directory, name), "utf8");
    assert.ok(!text.includes(capability)); assert.ok(!text.includes(signature));
  }
});

test("endpoint secrets redact values without corrupting structured field names", () => {
  const redactor = new Redactor();
  const uri = "https://example.invalid/nft/";
  registerEndpointSecrets(redactor, uri);
  registerEndpointSecrets(redactor, "https://user:pass@rpc.example/nftUnit?api_key=credential-query");
  const input = { token: { nftUnit: 100n * 10n ** 18n, metadataURI: uri }, nftSignature: "unregistered-signature", nested: { credential: "unregistered-credential", message: "nft nftUnit user pass credential-query" } };
  const evidence = redactor.value(input);
  assert.deepEqual(Object.keys(evidence.token), ["nftUnit", "metadataURI"]);
  assert.equal(evidence.token.nftUnit, "100000000000000000000");
  assert.equal(evidence.nftSignature, "[REDACTED]");
  assert.equal(evidence.nested.credential, "[REDACTED]");
  assert.notEqual(evidence.token.metadataURI, uri);
  for (const secret of ["nft", "nftUnit", "user", "pass", "credential-query"]) assert.ok(!evidence.nested.message.includes(secret));
  const serialized = JSON.parse(redactor.text(JSON.stringify({ token: { nftUnit: "100000000000000000000", metadataURI: uri } })));
  assert.deepEqual(serialized.token, evidence.token);
});

test("private recovery retains the exact complete plan and original policy across session updates", async (t) => {
  const artifacts = run(t);
  const sdkPath = process.env.SDK_SOURCE_TEST === "1" ? "../src/index.ts" : "../dist/index.js";
  const { hashLaunchPlan, parseLaunchPlan, serializeLaunchPlan } = await import(sdkPath);
  // Reuse the complete offline wire vector, not a claimed live/admitted launch.
  const vector = JSON.parse(readFileSync(new URL("./fixtures/launch-lifecycle-v1.json", import.meta.url), "utf8"));
  const plan = parseLaunchPlan(JSON.stringify(vector.plan));
  const uri = "https://user:pass@example.invalid/nft/?api_key=credential-query";
  plan.token.metadataURI = uri;
  registerEndpointSecrets(artifacts.redactor, uri);
  const exactPlan = JSON.parse(serializeLaunchPlan(plan));
  const expectedHash = hashLaunchPlan(plan);
  artifacts.privateRecovery({ plan: exactPlan, mode: "staged", confirmations: 2 });
  const initial = json(artifacts, "private-recovery.json");
  assert.deepEqual(initial, { plan: exactPlan, mode: "staged", confirmations: 2 });
  assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
  assert.equal(statSync(artifacts.directory).mode & 0o777, 0o700);
  artifacts.save("plan.json", exactPlan);
  assert.equal(json(artifacts, "plan.json").token.nftUnit, exactPlan.token.nftUnit);
  assert.notEqual(json(artifacts, "plan.json").token.metadataURI, uri);
  const capability = "lus_owned_recovery_update";
  const signature = `0x${"12".repeat(65)}`;
  artifacts.redactor.addSecret(capability); artifacts.redactor.addSecret(signature);
  // Metadata/signature and capability updates may be partial or carry stale intent.
  artifacts.privateRecovery({ request: { authorization: { signature } } });
  artifacts.privateRecovery({ plan: { token: { metadataURI: "[REDACTED]" } }, mode: "atomic", confirmations: 1, session: { capability }, capability });
  exactPlan.token.metadataURI = "mutated-caller-input";
  artifacts.privateRecovery({ signedTransactions: [{ transactionHash: hash, rawTransaction: "0x1234" }] });
  const recovered = json(artifacts, "private-recovery.json");
  assert.deepEqual(recovered.plan, initial.plan);
  assert.equal(recovered.mode, "staged"); assert.equal(recovered.confirmations, 2);
  assert.equal(recovered.capability, capability);
  assert.equal(recovered.request.authorization.signature, signature);
  assert.equal(recovered.signedTransactions[0].transactionHash, hash);
  assert.equal(hashLaunchPlan(parseLaunchPlan(JSON.stringify(recovered.plan))), expectedHash);
  assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
  artifacts.event("session", { session: { capability }, request: recovered.request, metadataURI: uri });
  artifacts.finish("failed", exampleError("API_NOT_READY", "Recovery boundary test"));
  for (const name of ["plan.json", "events.jsonl", "result.json", "receipts.json"]) {
    const text = readFileSync(join(artifacts.directory, name), "utf8");
    for (const secret of [uri, "credential-query", capability, signature]) assert.ok(!text.includes(secret));
  }
  assert.ok(!readdirSync(artifacts.directory).some((name) => name.endsWith(".tmp")));
});

test("exclusive output refuses reuse without overwriting recovery evidence", (t) => {
  const artifacts = run(t);
  artifacts.finish("failed", exampleError("ORIGINAL", "Keep original failure"));
  assert.throws(() => new RunArtifacts(artifacts.directory, "other-case"), { code: "EEXIST" });
  assert.equal(json(artifacts, "result.json").error.code, "ORIGINAL");
});

test("pending publication respects server delay and uses a decreasing deadline", async (t) => {
  const artifacts = run(t);
  let clock = 0; const sleeps = []; const remaining = [];
  const pending = Object.assign(new Error("pending"), { pending: true, session: { status: "awaiting_indexer", token: null }, retryAfterMs: 5000 });
  const result = await publishUntilIndexed({ artifacts, timeoutMs: 10_000, now: () => clock,
    isPending: (error) => error.pending === true,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    publish: async (ms) => { remaining.push(ms); if (remaining.length === 1) throw pending; return { status: "optimistic" }; },
  });
  assert.deepEqual(sleeps, [5000]); assert.deepEqual(remaining, [10000, 5000]);
  assert.equal(result.status, "optimistic");
});

test("pending indexing expires without an extra publication after deadline", async (t) => {
  const artifacts = run(t);
  let clock = 0; let calls = 0;
  await assert.rejects(publishUntilIndexed({ artifacts, timeoutMs: 1000, now: () => clock,
    isPending: (error) => error.pending === true,
    sleep: async (ms) => { assert.equal(ms, 1000); clock += ms; },
    publish: async () => { calls += 1; throw Object.assign(new Error("pending"), { pending: true, session: {}, retryAfterMs: 5000 }); },
  }), { code: "PUBLISH_TIMEOUT" });
  assert.equal(calls, 1);
});

test("non-pending API errors fail immediately instead of retrying or relaunching", async (t) => {
  const artifacts = run(t);
  let calls = 0;
  const failure = Object.assign(new Error("Real indexer unavailable"), { status: 503, code: "INDEXER_UNAVAILABLE" });
  await assert.rejects(publishUntilIndexed({ artifacts, timeoutMs: 1000,
    isPending: () => false,
    sleep: async () => assert.fail("API error must not sleep"),
    publish: async () => { calls += 1; throw failure; },
  }), failure);
  assert.equal(calls, 1); assert.equal(artifacts.transactions.length, 0);
});

test("late publication success cannot become an in-bound pass", async (t) => {
  const artifacts = run(t);
  let clock = 0;
  await assert.rejects(publishUntilIndexed({ artifacts, timeoutMs: 1000, now: () => clock,
    isPending: () => false,
    publish: async () => { clock = 1001; return { status: "final" }; },
  }), { code: "PUBLISH_TIMEOUT" });
});

test("interruption refuses every further RPC request without a simulation cleanup bypass", () => {
  const controller = new AbortController();
  const failure = exampleError("INTERRUPTED", "Preserve the original launch and reconcile its receipts");
  controller.abort(failure);
  assert.throws(() => rpcRequestSignal(controller.signal), failure);
});

test("serialized diagnostic JSON redacts secrets without treating repeated objects as cycles", () => {
  const redactor = new Redactor();
  const shared = { data: revertData };
  const value = redactor.value({
    serializedError: JSON.stringify({ signature: "unregistered-signature", nested: { privateKey: "unregistered-key", capabilities: "123", data: revertData } }),
    first: shared, second: shared,
  });
  assert.ok(!value.serializedError.includes("unregistered-signature"));
  assert.ok(!value.serializedError.includes("unregistered-key"));
  assert.equal(JSON.parse(value.serializedError).nested.data, revertData);
  assert.equal(JSON.parse(value.serializedError).nested.capabilities, "123");
  assert.equal(value.first.data, revertData); assert.equal(value.second.data, revertData);
});

const signingKey = `0x${"42".repeat(32)}`;
const signingCreator = privateKeyToAccount(signingKey).address;
function localSigner(artifacts, request) {
  const client = { request: request ?? (async ({ method }) => {
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    assert.equal(method, "eth_chainId");
    return "0x1237";
  }) };
  return { client, wallet: createLocalLaunchWallet({
    privateKey: signingKey, creator: signingCreator, chainId: 4663,
    orchestrator: transaction.wire.to, client, redactor: artifacts.redactor,
  }) };
}
const signingTransaction = { ...transaction, wire: { ...transaction.wire, from: signingCreator } };

test("example endpoint guards accept HTTPS and owned loopback, never insecure remote writes", () => {
  assert.equal(executionRpcUrl("https://provider.example/credential?api_key=secret"), "https://provider.example/credential?api_key=secret");
  assert.equal(executionRpcUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545/");
  for (const url of ["http://provider.example", "ftp://provider.example", "https://provider.example/#secret"]) assert.throws(() => executionRpcUrl(url), { code: "UNSAFE_ENDPOINT" });
  assert.equal(launchApiUrl("https://api.example"), "https://api.example/");
  assert.equal(launchApiUrl("http://127.0.0.1:18763"), "http://127.0.0.1:18763/");
  for (const url of ["http://api.example", "https://user:secret@api.example", "https://api.example/private", "https://api.example/?key=secret"]) assert.throws(() => launchApiUrl(url), { code: "UNSAFE_ENDPOINT" });
});

test("RPC URL credential path/query values are registered before public errors", () => {
  const redactor = new Redactor();
  registerEndpointSecrets(redactor, "https://user:pass@rpc.example/v2/credential-path?api_key=credential-query");
  const text = redactor.text("RPC credential-path credential-query user pass https://user:pass@rpc.example/v2/credential-path?api_key=credential-query");
  for (const secret of ["credential-path", "credential-query", "user", "pass"]) assert.ok(!text.includes(secret));
});

test("local wallet signs exact legacy and EIP1559 fields without unlocked RPC", async (t) => {
  const artifacts = run(t);
  for (const wire of [
    signingTransaction.wire,
    { ...signingTransaction.wire, gasPrice: undefined, type: "eip1559", maxFeePerGas: "0x20", maxPriorityFeePerGas: "0x2", nonce: "0x7" },
  ]) {
    const envelope = Object.fromEntries(Object.entries(wire).filter(([, value]) => value !== undefined));
    const { wallet } = localSigner(artifacts, async ({ method }) => {
      if (method === "eth_getTransactionCount") return envelope.nonce;
      if (method === "eth_getBalance") return "0x100000000000000000000";
      assert.equal(method, "eth_chainId"); return "0x1237";
    });
    const signed = await wallet.signTransaction(envelope);
    assert.equal(signed.transactionHash, keccak256(signed.rawTransaction));
    assert.equal((await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction })).toLowerCase(), signingCreator.toLowerCase());
    const parsed = parseTransaction(signed.rawTransaction);
    for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"]) if (envelope[field] !== undefined) assert.equal(field === "value" ? parsed.value ?? 0n : parsed[field], BigInt(envelope[field]));
    assert.equal(parsed.nonce, Number(BigInt(envelope.nonce)));
    assert.equal(parsed.chainId, 4663); assert.equal(parsed.data, envelope.data);
    assert.equal(parsed.to.toLowerCase(), envelope.to.toLowerCase());
    assert.equal(artifacts.redactor.text(signed.rawTransaction), "[REDACTED]");
  }
});

test("wallet prepares only absent nonce/legacy fee and retains exact supplied fields", async (t) => {
  const artifacts = run(t); const methods = [];
  const { wallet } = localSigner(artifacts, async ({ method, params }) => {
    methods.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getTransactionCount") { assert.deepEqual(params, [signingCreator, "pending"]); return "0x5"; }
    if (method === "eth_getBalance") { assert.deepEqual(params, [signingCreator, "pending"]); return "0x100000000000000000000"; }
    if (method === "eth_gasPrice") return "0x99";
    assert.fail(`Unexpected wallet RPC: ${method}`);
  });
  const { nonce, gasPrice, ...wire } = signingTransaction.wire;
  const signed = await wallet.signTransaction(wire);
  assert.equal(signed.wire.nonce, "0x5"); assert.equal(signed.wire.gasPrice, "0x99");
  assert.equal(signed.wire.gas, wire.gas); assert.equal(signed.wire.data, wire.data);
  assert.deepEqual(methods, ["eth_chainId", "eth_gasPrice", "eth_getTransactionCount", "eth_getBalance", "eth_chainId"]);
});

test("held nonce, pending affordability and final chain changes block the local example signature", async (t) => {
  const artifacts = run(t);
  for (const [change, code] of [["nonce", "PENDING_NONCE_CHANGED"], ["balance", "INSUFFICIENT_PENDING_BALANCE"], ["chain", "CHAIN_MISMATCH"]]) {
    let chainReads = 0;
    const { wallet } = localSigner(artifacts, async ({ method, params }) => {
      if (method === "eth_chainId") return change === "chain" && ++chainReads === 2 ? "0x1" : "0x1237";
      if (method === "eth_getTransactionCount") { assert.equal(params[1], "pending"); return change === "nonce" ? "0x1" : "0x0"; }
      if (method === "eth_getBalance") { assert.equal(params[1], "pending"); return change === "balance" ? "0x0" : "0x100000000000000000000"; }
      assert.fail(`Unexpected signing-boundary read ${method}`);
    });
    await assert.rejects(wallet.signTransaction(signingTransaction.wire), { code });
  }
});

test("wallet refuses wrong creator, chain, gas and attribution domain", async (t) => {
  const artifacts = run(t);
  const { wallet, client } = localSigner(artifacts);
  assert.throws(() => createLocalLaunchWallet({ privateKey: signingKey, creator: transaction.wire.from, chainId: 4663, client, redactor: artifacts.redactor }), { code: "CREATOR_KEY_MISMATCH" });
  await assert.rejects(wallet.signTransaction({ ...signingTransaction.wire, chainId: "0x1" }), { code: "INVALID_ENVELOPE" });
  await assert.rejects(wallet.signTransaction({ ...signingTransaction.wire, from: transaction.wire.from }), { code: "INVALID_ENVELOPE" });
  await assert.rejects(wallet.signTransaction({ ...signingTransaction.wire, gas: undefined }), { code: "INVALID_ENVELOPE" });
  const types = { Attribution: [{ name: "wallet", type: "address" }, { name: "chainId", type: "uint256" }] };
  const typedData = { domain: { name: "test", version: "1", chainId: 4663, verifyingContract: transaction.wire.to }, types, primaryType: "Attribution", message: { wallet: signingCreator, chainId: 4663n } };
  const signature = await wallet.signTypedData(typedData);
  assert.equal((await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase(), signingCreator.toLowerCase());
  await assert.rejects(wallet.signTypedData({ ...typedData, domain: { ...typedData.domain, chainId: 1 } }), { code: "TYPED_DATA_MISMATCH" });
  await assert.rejects(wallet.signTypedData({ ...typedData, domain: { ...typedData.domain, verifyingContract: transaction.wire.from } }), { code: "TYPED_DATA_MISMATCH" });
  const changed = localSigner(artifacts, async () => "0x1");
  await assert.rejects(changed.wallet.signTransaction(signingTransaction.wire), { code: "CHAIN_MISMATCH" });
});

test("ambiguous raw broadcast retains computed hash before send with no retry", async (t) => {
  const artifacts = run(t); const failure = exampleError("RPC_TIMEOUT", "Broadcast outcome unknown");
  let sends = 0;
  const { wallet, client } = localSigner(artifacts, async ({ method, params }) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    assert.equal(method, "eth_sendRawTransaction"); sends += 1;
    const row = json(artifacts, "receipts.json").transactions[0];
    assert.equal(row.transactionHash, keccak256(params[0]));
    assert.equal(row.status, "broadcast-attempt"); assert.deepEqual(row.transaction, signingTransaction.wire);
    const recovery = json(artifacts, "private-recovery.json");
    assert.equal(recovery.signedTransactions[0].rawTransaction, params[0]);
    assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
    throw failure;
  });
  await assert.rejects(submitSignedRecorded({ transaction: signingTransaction, wallet, client, artifacts, wait: async () => assert.fail("Do not poll an ambiguous send") }), failure);
  artifacts.finish("failed", failure);
  assert.equal(sends, 1);
  const recovery = json(artifacts, "private-recovery.json");
  const signed = recovery.signedTransactions[0];
  assert.equal(json(artifacts, "result.json").chain.transactions[0].transactionHash, signed.transactionHash);
  for (const name of ["events.jsonl", "result.json", "receipts.json"]) assert.ok(!readFileSync(join(artifacts.directory, name), "utf8").includes(signed.rawTransaction));
});

test("raw returned-hash mismatch keeps attempt hash and refuses polling", async (t) => {
  const artifacts = run(t);
  const { wallet, client } = localSigner(artifacts, async ({ method }) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    assert.equal(method, "eth_sendRawTransaction"); return hash;
  });
  await assert.rejects(submitSignedRecorded({ transaction: signingTransaction, wallet, client, artifacts, wait: async () => assert.fail("Hash mismatch must not poll") }), { code: "BROADCAST_HASH_MISMATCH" });
  assert.notEqual(json(artifacts, "receipts.json").transactions[0].transactionHash, hash);
  assert.equal(json(artifacts, "receipts.json").transactions[0].status, "broadcast-attempt");
});

test("example fails missing key or API upfront and retains redacted configuration evidence", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "node-example-config-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const script = new URL("../examples/launch-erc20-v4.ts", import.meta.url).pathname;
  for (const [index, privateKey, apiUrl] of [
    [0, "", "https://api.invalid"],
    [1, signingKey, ""],
  ]) {
    const cwd = mkdtempSync(join(parent, `case-${index}-`));
    const child = spawnSync(process.execPath, [...typescriptNodeArgs, script], {
      cwd, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PRIVATE_KEY: privateKey, EXAMPLE_KEYSTORE_PATH: "", EXAMPLE_KEYSTORE_PASSWORD: "",
        LAUNCH_API_URL: apiUrl, RPC_URL: "https://rpc.invalid/private-path?key=private-query" },
    });
    assert.equal(child.status, 1, child.stderr);
    const results = join(cwd, "launch-results");
    const runs = readdirSync(results);
    assert.equal(runs.length, 1);
    const result = JSON.parse(readFileSync(join(results, runs[0], "result.json"), "utf8"));
    assert.equal(result.error.code, "MISSING_CONFIGURATION");
    assert.equal(result.execution, "not-run"); assert.equal(result.chain.transactions.length, 0);
    assert.ok(!child.stderr.includes(signingKey));
    for (const secret of ["private-path", "private-query"]) assert.ok(!child.stderr.includes(secret));
  }
});

test("working-directory .env loads once and existing environment wins", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "node-example-dotenv-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".env"), 'EXAMPLE_TEST_KEEP="file value"\nEXAMPLE_TEST_LOAD="quoted # value" # comment\n', { mode: 0o600 });
  const helper = new URL("../examples/launch-example-support.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, [...typescriptNodeArgs, "--input-type=module", "-e", `
    import { writeFileSync } from "node:fs";
    import { loadExampleEnvironment } from ${JSON.stringify(helper)};
    loadExampleEnvironment();
    writeFileSync(".env", 'EXAMPLE_TEST_LOAD=changed\\n');
    loadExampleEnvironment();
    console.log(JSON.stringify([process.env.EXAMPLE_TEST_KEEP, process.env.EXAMPLE_TEST_LOAD]));
  `], { cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, EXAMPLE_TEST_KEEP: "process value", EXAMPLE_TEST_LOAD: undefined } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["process value", "quoted # value"]);
});

test("signed broadcast interruption and reverted receipts retain durable evidence", async (t) => {
  const artifacts = run(t);
  const controller = new AbortController();
  const failure = exampleError("INTERRUPTED", "Retain the signed attempt");
  const { wallet, client } = localSigner(artifacts, async ({ method, params }) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    assert.equal(method, "eth_sendRawTransaction");
    controller.abort(failure);
    return keccak256(params[0]);
  });
  await assert.rejects(submitSignedRecorded({ transaction: signingTransaction, wallet, client, artifacts, signal: controller.signal, wait: async () => assert.fail("Interrupted send must not poll") }), failure);
  assert.equal(json(artifacts, "receipts.json").transactions[0].status, "submitted");
  const next = run(t);
  const signer = localSigner(next, async ({ method, params }) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    assert.equal(method, "eth_sendRawTransaction"); return keccak256(params[0]);
  });
  const submitted = await submitSignedRecorded({ transaction: signingTransaction, ...signer, artifacts: next, wait: async (transactionHash) => ({ transactionHash, status: "0x0", logs: [] }) });
  next.finish("failed", exampleError("TRANSACTION_REVERTED", "Launch reverted", { revertData }));
  assert.equal(submitted.receipt.status, "0x0");
  assert.equal(json(next, "result.json").chain.transactions[0].receipt.status, "0x0");
});

test("fixed example configuration never invents optional execution caps and defaults to fifteen percent headroom", async () => {
  const sdk = {
    getAddresses(chainId) { assert.equal(chainId, 4663); return { launchOrchestrator: transaction.wire.to, launchImplementationRegistry: transaction.wire.to, weth: transaction.wire.to, abyssFactory: transaction.wire.to }; },
    robinhoodMainnet: { rpcUrls: { default: { http: ["https://rpc.example.invalid/"] } } },
  };
  const env = { PRIVATE_KEY: signingKey, LAUNCH_API_URL: "https://api.example.invalid/" };
  const { fixture: configuration } = await readExampleConfiguration(sdk, new Redactor(), env);
  assert.equal(configuration.implementationRegistry, transaction.wire.to);
  const policy = configuration.executionLimits;
  assert.equal(policy.headroomBps, 1500);
  for (const field of ["chainTransactionGasLimit", "rpcTransactionGasLimit", "accountTransactionGasLimit", "maxCalldataBytes"]) assert.equal(policy[field], undefined);
  assert.equal("forkRpcUrl" in configuration, false);
  const { fixture: restrictedConfiguration } = await readExampleConfiguration(sdk, new Redactor(), { ...env, EXAMPLE_RPC_GAS_CAP: "12000000", EXAMPLE_MAX_CALLDATA_BYTES: "120000", EXAMPLE_HEADROOM_BPS: "0" });
  const restricted = restrictedConfiguration.executionLimits;
  assert.equal(restricted.rpcTransactionGasLimit, "12000000"); assert.equal(restricted.maxCalldataBytes, 120000); assert.equal(restricted.headroomBps, 0);
  for (const value of ["-1", "0", "1.5", "unknown"]) await assert.rejects(readExampleConfiguration(sdk, new Redactor(), { ...env, EXAMPLE_RPC_GAS_CAP: value }), { code: "INVALID_CONFIGURATION" });
});

test("launch receipt accounting accepts burned mint residuals without a creator reserve", () => {
  const evidence = {
    supply: 1000n, totalSupply: 950n, orchestrator: transaction.wire.to, creator: signingCreator,
    transfers: [
      { from: zeroAddress, to: transaction.wire.to, value: 1000n },
      { from: transaction.wire.to, to: zeroAddress, value: 50n },
    ],
    buys: [{ recipient: signingCreator, tokenOut: 10n }, { recipient: signingCreator, tokenOut: 20n }],
    orchestratorBalance: 0n, creatorBalance: 30n,
  };
  assert.deepEqual(verifyLaunchInventory(evidence), { minted: 1000n, burned: 50n, remainingSupply: 950n, creatorBought: 30n });
  assert.deepEqual(verifyLaunchInventory({ ...evidence, totalSupply: 1000n, transfers: evidence.transfers.slice(0, 1) }),
    { minted: 1000n, burned: 0n, remainingSupply: 1000n, creatorBought: 30n });
  for (const change of [
    { totalSupply: 1000n }, { creatorBalance: 80n }, { orchestratorBalance: 50n },
    { transfers: [] },
    { transfers: [{ from: zeroAddress, to: signingCreator, value: 1000n }, evidence.transfers[1]] },
    { transfers: [evidence.transfers[0], { from: signingCreator, to: zeroAddress, value: 50n }] },
  ]) assert.throws(() => verifyLaunchInventory({ ...evidence, ...change }), { code: "ERR_ASSERTION" });
});

const apiSeedOrigin = "https://api.abyss.trading";
const seedWeth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const seedAggregator = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
function apiPriceSnapshot(sourceTimestamp = "1791552898") {
  return {
    chainId: 4663, indexedBlock: "84269486", blockNumber: "84269370",
    items: [{
      chainId: 4663, address: seedWeth.toLowerCase(), decimals: 18, metadataStatus: "ready",
      priced: true, source: "anchor", priceUsdX18: "2486280000000000000000",
      provenance: { anchorToken: seedWeth, anchor: { kind: "chainlink", aggregator: seedAggregator },
        path: [], hopCount: 0, sourceTimestamp, graphBlockNumber: "84195615" },
    }],
    nextCursor: seedWeth.toLowerCase(),
  };
}
const validateSeed = (snapshot = apiPriceSnapshot(), nowSeconds = 1791560098n) =>
  validateApiWethUsdSeed({ snapshot, apiUrl: apiSeedOrigin, nowSeconds });
const seedReaderFixture = { chainId: "4663", apiUrl: apiSeedOrigin, quoteAsset: seedWeth, quoteDecimals: 18 };
const seedReaderSdk = { getAddresses: (chainId) => { assert.equal(chainId, 4663); return { weth: seedWeth }; } };

test("published API WETH seed preserves exact price and two-hour upstream age, not retrieval freshness", () => {
  const quote = validateSeed();
  assert.equal(quote.priceUsdX18, 2486280000000000000000n);
  assert.equal(quote.source, "abyss-api"); assert.equal(quote.apiOrigin, apiSeedOrigin);
  assert.equal(quote.tokenAddress, seedWeth); assert.equal(quote.tokenDecimals, 18);
  assert.equal(quote.anchorKind, "chainlink"); assert.equal(quote.anchorAggregator, seedAggregator);
  assert.equal(quote.indexedBlock, 84269486n); assert.equal(quote.blockNumber, 84269370n);
  assert.equal(quote.graphBlockNumber, 84195615n);
  assert.equal(quote.sourceTimestamp, 1791552898n);
  assert.equal(quote.retrievedAt, 1791560098n); assert.equal(quote.upstreamAgeSeconds, 7200n);
  const older = validateSeed(apiPriceSnapshot(), 1791563698n);
  assert.equal(older.sourceTimestamp, quote.sourceTimestamp); assert.equal(older.upstreamAgeSeconds, 10800n);
  assert.doesNotThrow(() => assertUnchangedEconomicQuote(quote, older));
  const maximal = apiPriceSnapshot();
  maximal.items[0].priceUsdX18 = ((1n << 256n) - 1n).toString();
  assert.equal(validateSeed(maximal).priceUsdX18, (1n << 256n) - 1n);
});

test("API seed rejects malformed, absent, unpriced, wrong-chain/asset/decimals and inexact uint256 data", () => {
  for (const snapshot of [null, {}, { ...apiPriceSnapshot(), chainId: 1 }, { ...apiPriceSnapshot(), chainId: "4663" },
    { ...apiPriceSnapshot(), items: {} }, { ...apiPriceSnapshot(), items: [] },
    { ...apiPriceSnapshot(), items: Array(101).fill(apiPriceSnapshot().items[0]) },
    { ...apiPriceSnapshot(), items: [...apiPriceSnapshot().items, ...apiPriceSnapshot().items] }]) {
    assert.throws(() => validateSeed(snapshot), { code: "INVALID_PRICE_QUOTE" });
  }
  for (const change of [{ chainId: 1 }, { address: zeroAddress }, { address: undefined }, { address: 123 },
    { decimals: 6 }, { decimals: "18" }, { metadataStatus: "pending" }, { priced: false }, { priced: "true" }]) {
    const snapshot = apiPriceSnapshot(); Object.assign(snapshot.items[0], change);
    assert.throws(() => validateSeed(snapshot), { code: "INVALID_PRICE_QUOTE" });
  }
  for (const price of [undefined, null, 2486.28, 2486280000000000000000n, "0", "-1", "+1", "01", "1.0", "1e18", " 1", "0x1", (1n << 256n).toString()]) {
    const snapshot = apiPriceSnapshot(); snapshot.items[0].priceUsdX18 = price;
    assert.throws(() => validateSeed(snapshot), { code: "INVALID_PRICE_QUOTE" });
  }
  for (const field of ["indexedBlock", "blockNumber"]) {
    const snapshot = apiPriceSnapshot(); snapshot[field] = "8e7";
    assert.throws(() => validateSeed(snapshot), { code: "INVALID_PRICE_QUOTE" });
  }
  for (const change of [{ sourceTimestamp: undefined }, { sourceTimestamp: "0" }, { sourceTimestamp: "1791560099" }, { graphBlockNumber: "01" }]) {
    const snapshot = apiPriceSnapshot(); Object.assign(snapshot.items[0].provenance, change);
    assert.throws(() => validateSeed(snapshot), { code: "INVALID_PRICE_QUOTE" });
  }
});

test("API seed requires the reviewed direct WETH Chainlink anchor, never routed or alternate provenance", () => {
  for (const change of [
    { provenance: undefined }, { source: "pool-route" },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, anchorToken: zeroAddress } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, anchorToken: 123 } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, anchor: { kind: "dexscreener", aggregator: seedAggregator } } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, anchor: { kind: "chainlink", aggregator: zeroAddress } } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, anchor: { kind: "chainlink", aggregator: 123 } } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, hopCount: 1 } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, path: [zeroAddress] } },
    { provenance: { ...apiPriceSnapshot().items[0].provenance, path: undefined } },
  ]) {
    const snapshot = apiPriceSnapshot(); Object.assign(snapshot.items[0], change);
    assert.throws(() => validateSeed(snapshot), { code: "PRICE_SOURCE_CHANGED" });
  }
});

test("API reader performs one bounded no-redirect GET at the configured origin, without RPC or pagination", async () => {
  const requests = [];
  const quote = await readApiWethUsdSeed({ sdk: seedReaderSdk, fixture: seedReaderFixture,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(apiPriceSnapshot("1000")), { headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${apiSeedOrigin}/api/v1/token-prices?chainId=4663&limit=100`);
  assert.equal(requests[0].init.method, "GET"); assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.cache, "no-store"); assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(quote.priceUsdX18, 2486280000000000000000n);
  assert.equal(quote.sourceTimestamp, 1000n); assert.equal(quote.upstreamAgeSeconds, quote.retrievedAt - 1000n);
});

test("API reader fails closed on source configuration, HTTP, JSON, endpoint, timeout and body-limit failures", async () => {
  const read = (fetchImpl, fixture = seedReaderFixture, signal) => readApiWethUsdSeed({ sdk: seedReaderSdk, fixture, fetchImpl, signal });
  let calls = 0;
  const counted = async () => { calls++; return new Response(JSON.stringify(apiPriceSnapshot("1000"))); };
  for (const change of [{ chainId: "1" }, { quoteAsset: zeroAddress }, { quoteDecimals: 6 }]) {
    await assert.rejects(read(counted, { ...seedReaderFixture, ...change }), { code: "PRICE_SOURCE_CHANGED" });
  }
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(read(counted, seedReaderFixture, controller.signal), { code: "PRICE_API_UNAVAILABLE" });
  assert.equal(calls, 0);
  for (const [fetchImpl, code] of [
    [async () => { calls++; throw new TypeError("fetch failed"); }, "PRICE_API_UNAVAILABLE"],
    [async () => new Response("unavailable", { status: 503 }), "PRICE_API_UNAVAILABLE"],
    [async () => new Response("not JSON"), "INVALID_PRICE_QUOTE"],
    [async () => new Response(null), "INVALID_PRICE_QUOTE"],
    [async () => new Response("{}", { headers: { "Content-Length": "1048577" } }), "INVALID_PRICE_QUOTE"],
    [async () => new Response("x".repeat(1048577)), "INVALID_PRICE_QUOTE"],
    [async () => { const response = new Response("{}"); Object.defineProperty(response, "url", { value: "https://other.example/api/v1/token-prices" }); return response; }, "PRICE_API_UNAVAILABLE"],
    [async () => { const response = new Response("{}"); Object.defineProperty(response, "redirected", { value: true }); return response; }, "PRICE_API_UNAVAILABLE"],
    [async () => { throw new DOMException("timed out", "TimeoutError"); }, "PRICE_API_UNAVAILABLE"],
  ]) await assert.rejects(read(fetchImpl), { code });
  assert.equal(calls, 1, "Network failure has no retry or fallback");
});

test("target parsing and review provenance preserve exact economics", () => {
  assert.equal(targetMarketCapUsdX18(), 5000n * 10n ** 18n);
  assert.equal(targetMarketCapUsdX18("5000.000000000000000001"), 5000n * 10n ** 18n + 1n);
  for (const value of ["0", "-5", "5e3", "5000.0000000000000000001", " 5000", "05000"]) assert.throws(() => targetMarketCapUsdX18(value), { code: "INVALID_CONFIGURATION" });
  const quote = validateSeed();
  const advanced = { ...quote, indexedBlock: quote.indexedBlock + 1n, blockNumber: quote.blockNumber + 1n,
    graphBlockNumber: quote.graphBlockNumber + 1n, sourceTimestamp: quote.sourceTimestamp + 1n,
    retrievedAt: quote.retrievedAt + 1n };
  assert.doesNotThrow(() => assertUnchangedEconomicQuote(quote, advanced));
  for (const changed of [{ source: "other-api" }, { apiOrigin: "https://other.example" }, { chainId: 1 },
    { tokenAddress: zeroAddress }, { tokenDecimals: 6 }, { anchorToken: zeroAddress },
    { anchorKind: "dexscreener" }, { anchorAggregator: zeroAddress }, { priceSource: "pool-route" },
    { priceUsdX18: quote.priceUsdX18 + 1n }, { priceUsdX18: undefined }]) {
    assert.throws(() => assertUnchangedEconomicQuote(quote, { ...quote, ...changed }), { code: "ECONOMIC_REVIEW_CHANGED" });
  }
  const hash = economicReviewHash({ quote, target: 5000n });
  assert.equal(hash, economicReviewHash({ quote, target: "5000" }));
  assert.notEqual(hash, economicReviewHash({ quote, target: 6000n }));
});

test("production economic guard refuses both signature paths on changed source/price and preserves original review", async (t) => {
  const artifacts = run(t);
  const quote = validateSeed();
  const review = { quote, target: 5000n * 10n ** 18n };
  const hash = economicReviewHash(review);
  artifacts.privateRecovery({ economicReview: review, economicAdmission: { reviewHash: hash } });
  let current = { ...quote };
  let signerChecks = 0;
  const { wallet: localWallet } = localSigner(artifacts, async ({ method }) => {
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return "0x100000000000000000000";
    signerChecks++; assert.equal(method, "eth_chainId"); return "0x1237";
  });
  const wallet = guardEconomicReviewWallet(localWallet, async () => {
    assert.equal(economicReviewHash(review), hash);
    assertUnchangedEconomicQuote(quote, current);
  });
  const typedData = { domain: { name: "test", version: "1", chainId: 4663, verifyingContract: transaction.wire.to },
    types: { Attribution: [{ name: "wallet", type: "address" }, { name: "chainId", type: "uint256" }] },
    primaryType: "Attribution", message: { wallet: signingCreator, chainId: 4663n } };
  for (const change of [{ priceUsdX18: quote.priceUsdX18 + 1n }, { apiOrigin: "https://other.example" },
    { anchorAggregator: zeroAddress }, { tokenAddress: zeroAddress }, { tokenDecimals: 6 }]) {
    current = { ...quote, ...change };
    await assert.rejects(wallet.signTypedData(typedData), { code: "ECONOMIC_REVIEW_CHANGED" });
    await assert.rejects(wallet.signTransaction(signingTransaction.wire), { code: "ECONOMIC_REVIEW_CHANGED" });
  }
  assert.equal(signerChecks, 0, "Changed economics never reach the local signer");
  current = { ...quote, retrievedAt: quote.retrievedAt + 60n, upstreamAgeSeconds: quote.upstreamAgeSeconds + 60n };
  const signature = await wallet.signTypedData(typedData);
  assert.equal((await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase(), signingCreator.toLowerCase());
  const signed = await wallet.signTransaction(signingTransaction.wire);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction })).toLowerCase(), signingCreator.toLowerCase());
  assert.equal(signerChecks, 3);
  assert.equal(economicReviewHash(review), hash);
  assert.equal(json(artifacts, "private-recovery.json").economicReview.quote.sourceTimestamp, quote.sourceTimestamp.toString());
  assert.equal(json(artifacts, "private-recovery.json").economicReview.quote.priceUsdX18, quote.priceUsdX18.toString());
});

test("public economic review preserves exact safe API origin and hash without exposing endpoint secrets", (t) => {
  const artifacts = run(t);
  const review = { quote: validateSeed(), targetMarketCapUsdX18: 5000n * 10n ** 18n };
  const reviewHash = economicReviewHash(review);
  artifacts.save("economic-review.json", { ...review, reviewHash });
  const saved = json(artifacts, "economic-review.json");
  assert.equal(saved.quote.apiOrigin, apiSeedOrigin, "Do not append a slash to the hash-bound origin");
  const { reviewHash: savedHash, ...savedReview } = saved;
  assert.equal(savedHash, reviewHash); assert.equal(economicReviewHash(savedReview), reviewHash);
  const redactor = new Redactor();
  assert.deepEqual(redactor.value({ apiOrigin: "http://127.0.0.1:18763" }), { apiOrigin: "http://127.0.0.1:18763" });
  for (const value of ["https://user:secret@api.example", "https://api.example/?key=secret",
    "https://api.example/private", "https://api.example/#secret", "not-a-url", undefined]) {
    assert.equal(redactor.value({ apiOrigin: value }).apiOrigin, "[REDACTED_URL]");
  }
});

test("all eleven wrappers preserve their exact workloads and per-quote economics in every token order", async () => {
  const directory = new URL("../examples/", import.meta.url);
  const wrappers = readdirSync(directory).filter((name) => /^launch-erc(?:20|404)-.*\.ts$/.test(name));
  const expected = {
    "erc20-v4": [0, 0, "atomic", [["v4", "WETH", 1]], 1],
    "erc20-abyss": [0, 0, "atomic", [["abyss", "WETH", 1]], 1],
    "erc404-v4": [1, 0, "staged", [["v4", "WETH", 1]], 1],
    "erc404-abyss": [1, 0, "atomic", [["abyss", "WETH", 1]], 1],
    "erc20-staking-v4": [0, 1, "staged", [["v4", "WETH", 2]], 2],
    "erc20-dividends-abyss": [0, 2, "staged", [["abyss", "WETH", 3]], 1],
    "erc20-burn-mixed": [0, 0, "staged", [["v4", "WETH", 2], ["abyss", "WETH", 1]], 1],
    "erc404-dividends-mixed": [1, 2, "staged", [["v4", "WETH", 2], ["abyss", "WETH", 3]], 1],
    "erc20-multi-quote": [0, 0, "staged", [["v4", "WETH", 1], ["v4", "USDG", 1], ["abyss", "WETH", 1]], 1],
    "erc20-depth-v4": [0, 0, "staged", [["v4", "WETH", 4]], 1],
    "erc20-dividends-multiquote-mixed": [0, 2, "staged", [["v4", "WETH", 2], ["v4", "USDG", 2], ["abyss", "WETH", 3]], 1],
  };
  assert.deepEqual(wrappers.sort(), Object.keys(expected).map((suffix) => `launch-${suffix}.ts`).sort());
  const quote = validateSeed();
  const unit = 10n ** 18n;
  for (const file of wrappers) {
    const source = readFileSync(new URL(file, directory), "utf8");
    const sharedImport = 'import { runLaunchExample } from "./launch-example.ts";';
    assert.ok(source.startsWith(sharedImport), file);
    let scenario;
    // Capture only the fixed case, never invoke the signing/broadcast runner.
    await runInNewContext(`(async () => { ${source.slice(sharedImport.length)} })()`, {
      runLaunchExample(value) { assert.equal(scenario, undefined); scenario = JSON.parse(JSON.stringify(value)); },
    });
    assert.ok(scenario, file);
    validateCase(scenario);
    const suffix = file.slice("launch-".length, -".ts".length);
    assert.deepEqual([scenario.tokenKind, scenario.rewardMode, scenario.mode,
      scenario.markets.map((spec) => [spec.venue, spec.quote ?? "WETH", spec.positions]), scenario.buysPerMarket], expected[suffix], file);
    if (suffix === "erc20-burn-mixed") { assert.equal(scenario.burnBps, 3000); assert.equal(scenario.markets[0].feeMode, 1); }
    if (suffix === "erc20-depth-v4") assert.equal(scenario.markets[0].distributionPreset, "early-scarcity");
    const v4Quotes = scenario.markets.filter((spec) => spec.venue === "v4").map((spec) => spec.quote ?? "WETH");
    assert.equal(new Set(v4Quotes).size, v4Quotes.length, "No repeated V4 quote");
    const supply = (scenario.tokenKind === 1 ? 10_000n : 1_000_000n) * unit;
    const budgets = allocateMarketBudgets(supply, scenario.markets.length);
    // Below both quotes, between them, above both: order is independent per market.
    for (const tokenAddress of ["0x0000000000000000000000000000000000000001",
      "0x2000000000000000000000000000000000000000", "0xffffffffffffffffffffffffffffffffffffffff"]) {
      const markets = scenario.markets.map((spec, index) => {
        const usdg = spec.quote === "USDG";
        const quoteAsset = usdg ? pricingSdk.ROBINHOOD_USDG : seedWeth;
        return deriveExampleMarketEconomics({
          sdk: pricingSdk, supply, tokenBudget: budgets[index], tokenIsCurrency0: BigInt(tokenAddress) < BigInt(quoteAsset),
          positions: spec.positions, venue: spec.venue, quoteUsdX18: usdg ? unit : quote.priceUsdX18,
          targetUsdX18: targetMarketCapUsdX18(), quoteDecimals: usdg ? 6 : quote.tokenDecimals,
          distributionPreset: spec.distributionPreset,
        });
      });
      assert.equal(markets.flatMap((market) => market.positions).reduce((sum, position) => sum + position.maxTokenAmount, 0n), supply, file);
      for (const [index, market] of markets.entries()) {
        assert.equal(market.positions.length, scenario.markets[index].positions, file);
        assert.equal(market.tokenBudget, budgets[index], file);
        assert.ok(market.openingValuationUsdX18 >= 4950n * unit && market.openingValuationUsdX18 <= 5050n * unit, file);
        assert.equal(market.positionGaps, "adjacent"); assert.equal(market.extendFinalRangeToBoundary, true);
        for (let position = 1; position < market.positions.length; position++) {
          const previous = market.positions[position - 1]; const current = market.positions[position];
          assert.equal(market.tokenIsCurrency0 ? previous.tickUpper : previous.tickLower,
            market.tokenIsCurrency0 ? current.tickLower : current.tickUpper, "All buy-side bands are contiguous");
          if (suffix === "erc20-depth-v4") assert.ok(current.maxTokenAmount > previous.maxTokenAmount, "Depth increases later inventory");
        }
        const final = market.positions.at(-1);
        assert.equal(market.tokenIsCurrency0 ? final.tickUpper : final.tickLower, market.tokenIsCurrency0 ? 887220 : -887220);
        for (let other = 0; other < index; other++) {
          if ((scenario.markets[other].quote ?? "WETH") === (scenario.markets[index].quote ?? "WETH")) {
            assert.equal(market.sqrtPriceX96, markets[other].sqrtPriceX96, "Repeated quote retains whole-supply opening value");
          } else assert.notEqual(market.sqrtPriceX96, markets[other].sqrtPriceX96, "Different quote precision/pricing has distinct raw sqrt price");
        }
      }
    }
    assert.equal(scenario.markets.length * scenario.buysPerMarket, expected[suffix][3].length * expected[suffix][4], file);
  }
});

test("both token orders and actual 1m/10k supplies imply a $5000 aligned valuation across decimal scales", () => {
  const unit = 10n ** 18n;
  for (const tokens of [1_000_000n, 10_000n]) for (const tokenIsCurrency0 of [true, false]) for (const quoteDecimals of [0, 6, 18]) {
    const supply = tokens * unit;
    const market = deriveExampleMarketEconomics({ sdk: pricingSdk, supply, tokenBudget: supply, tokenIsCurrency0,
      positions: 1, venue: "abyss", quoteUsdX18: 2400n * unit, targetUsdX18: 5000n * unit, quoteDecimals });
    // Independent economic bounds: spacing60 costs <1% in either orientation,
    // and changing total minted supply changes token price, not target valuation.
    assert.ok(market.openingValuationUsdX18 >= 4950n * unit && market.openingValuationUsdX18 <= 5050n * unit);
    assert.ok(market.unitPriceUsdX18 >= 4950n * unit / tokens && market.unitPriceUsdX18 <= 5050n * unit / tokens);
    assert.equal(market.positions[0].maxTokenAmount, supply);
    assert.ok(market.positions[0].expectedMintDebit <= supply);
    assert.ok(market.roundingBurn < supply / 1_000_000n, "Rounding cannot burn meaningful launch inventory");
    assert.ok(market.positions[0].tickLower % 60 === 0);
    assert.ok(market.positions[0].tickUpper % 60 === 0);
    assert.notEqual(market.sqrtPriceX96, 1n << 96n);
  }
});

test("mixed-market recipe consumes exact remainder budgets and preserves one coherent opening value", () => {
  const unit = 10n ** 18n;
  const supply = 10_000n * unit + 1n;
  assert.deepEqual(allocateMarketBudgets(101n, 3), [33n, 33n, 35n]);
  for (const tokenIsCurrency0 of [true, false]) {
    const budgets = allocateMarketBudgets(supply, 2);
    const markets = budgets.map((tokenBudget, index) => deriveExampleMarketEconomics({ sdk: pricingSdk, supply, tokenBudget,
      tokenIsCurrency0, positions: index === 0 ? 2 : 3, venue: index === 0 ? "v4" : "abyss",
      quoteUsdX18: 2400n * unit, targetUsdX18: 5000n * unit, quoteDecimals: 18 }));
    assert.equal(markets[0].sqrtPriceX96, markets[1].sqrtPriceX96);
    assert.equal(markets[0].openingValuationUsdX18, markets[1].openingValuationUsdX18);
    assert.equal(markets.flatMap((market) => market.positions).reduce((sum, position) => sum + position.maxTokenAmount, 0n), supply);
    for (const market of markets) {
      assert.ok(market.roundingBurn < 1_000_000n);
      for (const position of market.positions) {
        const lower = position.sqrtPriceLowerX96, upper = position.sqrtPriceUpperX96, q96 = 1n << 96n;
        // Independent rational maximum: funded L fits, L+1 must exceed its cap.
        const n = tokenIsCurrency0 ? q96 * (upper - lower) : upper - lower;
        const d = tokenIsCurrency0 ? lower * upper : q96;
        assert.ok(position.liquidity * n <= position.maxTokenAmount * d);
        assert.ok((position.liquidity + 1n) * n > position.maxTokenAmount * d);
      }
    }
    const retained = supply - markets.reduce((sum, market) => sum + market.roundingBurn, 0n);
    const valuation = openingEconomics({ sqrtPriceX96: markets[0].sqrtPriceX96, tokenIsCurrency0, quoteDecimals: 18, quoteUsdX18: 2400n * unit, supply: retained });
    assert.ok(valuation.openingValuationUsdX18 >= 4950n * unit && valuation.openingValuationUsdX18 <= 5050n * unit);
  }
});

test("economic review and admission remain exact and immutable across recovery updates", (t) => {
  const artifacts = run(t);
  const review = { targetMarketCapUsdX18: 5000n * 10n ** 18n, actualMintedSupply: 10_000n * 10n ** 18n,
    quote: validateSeed(), markets: [{ tokenBudget: 10_000n * 10n ** 18n }] };
  const admission = { reviewHash: economicReviewHash(review) };
  artifacts.privateRecovery({ economicReview: review, economicAdmission: admission });
  artifacts.privateRecovery({ economicReview: { targetMarketCapUsdX18: 6000n }, economicAdmission: { reviewHash: "changed" }, session: { sessionId: "later" } });
  const recovery = json(artifacts, "private-recovery.json");
  assert.equal(recovery.economicReview.targetMarketCapUsdX18, "5000000000000000000000");
  assert.equal(recovery.economicAdmission.reviewHash, admission.reviewHash);
  assert.equal(recovery.session.sessionId, "later");
  assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
});
