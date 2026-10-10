import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { economicReviewHash, RunArtifacts } from "../examples/launch-example-support.ts";
import { apiTransport, readLaunchExampleArguments, refreshExampleUploadSession, resumeLaunchExample } from "../examples/launch-example.ts";
const sdk = await import(process.env.SDK_SOURCE_TEST === "1" ? "../src/index.ts" : "../dist/index.js");

// Offline control-flow and evidence-boundary tests, not on-chain launch/API proof.
// All RPC/HTTP observations are injected; the CLI cases fail before configuration.
const key = `0x${"42".repeat(32)}`;
const account = privateKeyToAccount(key);
const core = `0x${"11".repeat(20)}`;
const registry = `0x${"22".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const blockHash = `0x${"ab".repeat(32)}`;
const beginHash = `0x${"bc".repeat(32)}`;
const activationHash = `0x${"cd".repeat(32)}`;
const capability = "lus_original_offline_resume_capability";
const apiUrl = "https://api.example.invalid";
const png = Buffer.from("89504e470d0a1a0a0000000000000000", "hex");
const imageDescriptor = { sha256: `0x${createHash("sha256").update(png).digest("hex")}`, contentType: "image/png", contentLength: png.length };
const wireVector = JSON.parse(readFileSync(new URL("./fixtures/launch-lifecycle-v1.json", import.meta.url), "utf8"));
const portable = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const json = (artifacts, name) => JSON.parse(readFileSync(join(artifacts.directory, name), "utf8"));
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "launch-resume-offline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function context(t, { phase = sdk.LifecyclePhase.Active, mode = "staged", image, expired = false } = {}) {
  const parent = temporary(t);
  const original = new RunArtifacts(join(parent, "original"), "retained-case");
  original.initialize();
  const plan = sdk.parseLaunchPlan(JSON.stringify(wireVector.plan));
  Object.assign(plan, { chainId: 4663n, orchestrator: core, creator: account.address, deadline: expired ? 1n : BigInt(Math.floor(Date.now() / 1000)) + 3600n });
  plan.token.inventoryRecipient = account.address;
  const metadata = { name: plan.token.name, symbol: plan.token.symbol, description: "Retained offline description" };
  const economicReview = { schema: "black-market.launch-economic-review.v1", caseId: "retained-case", chainId: "4663",
    targetMarketCapUsdX18: 5000n * 10n ** 18n, actualMintedSupply: plan.token.supply, predictedToken: token,
    planHash: sdk.hashLaunchPlan(plan), finalizedPlan: JSON.parse(sdk.serializeLaunchPlan(plan)), metadata, image: image ?? null,
    quotes: [{ symbol: "WETH", conversion: { nativeInputPerBuy: 100n, buyCount: 1, nativeWrap: true } }],
    markets: [{ venue: "v4", positions: [{ liquidity: 1n }, { liquidity: 2n }] }, { venue: "abyss", positions: [{ liquidity: 3n }] }] };
  const reviewHash = economicReviewHash(economicReview);
  const hashes = mode === "atomic" ? [activationHash] : phase === sdk.LifecyclePhase.Active ? [beginHash, activationHash] : [beginHash];
  const references = hashes.map((transactionHash, index) => ({ transactionHash, observedBlockNumber: 100n + BigInt(index), observedBlockHash: blockHash, confirmations: 2 }));
  const receipts = references.map((reference) => ({ transactionHash: reference.transactionHash, status: "0x1", blockNumber: `0x${reference.observedBlockNumber.toString(16)}`,
    blockHash: reference.observedBlockHash, from: account.address, to: core, logs: [] }));
  const response = { sessionId: "retained-session", chainId: 4663, wallet: account.address, status: image ? "awaiting_upload" : "ready_to_launch",
    metadata, image: image ? { ...image, width: null, height: null } : null, imageStatus: image ? "upload_pending" : "none",
    upload: image ? { method: "PUT", url: "https://objects.example.invalid/image?signature=old", headers: { "Content-Type": image.contentType }, expiresInSeconds: 1 } : undefined };
  const recovery = { schema: "black-market.launch-example-recovery.v1", sdk: "node", caseId: "retained-case", apiUrl,
    plan: JSON.parse(sdk.serializeLaunchPlan(plan)), mode, confirmations: 2, receipts: references,
    economicReview: { ...economicReview, reviewHash }, economicAdmission: { reviewHash, admittedAt: "2026-10-10T00:00:00Z" },
    executionLimits: { headroomBps: 1234, maxCalldataBytes: 100_000, provenance: { scope: "user-ceilings" } },
    request: { metadata, ...(image ? { image } : {}), authorization: { signature: `0x${"12".repeat(65)}` } },
    session: { ...response, capability }, capability,
    signedTransactions: hashes.map((transactionHash) => ({ transactionHash, rawTransaction: "0xfeed" })),
    ...(phase === sdk.LifecyclePhase.Active ? { activation: { transactionHash: activationHash, receipt: receipts.at(-1) } } : {}) };
  original.privateRecovery(recovery);
  for (const receipt of receipts) original.transactions.push({ transactionHash: receipt.transactionHash, receipt, status: "confirmed" });
  original.saveReceipts();
  original.finish("failed", new Error("Original interruption"));
  const artifacts = new RunArtifacts(original.directory, "ignored-wrapper-case", undefined, { resume: true });
  artifacts.initialize();
  const calls = [];
  const fixture = { chainId: "4663", rpcUrl: "https://rpc.example.invalid", apiUrl, orchestrator: core, creator: account.address,
    implementationRegistry: registry, executionLimits: { headroomBps: 1500 }, targetMarketCapUsdX18: 1n };
  const planned = { plan, mode, confirmations: 2, chainId: 4663n, account: plan.creator, planHash: sdk.hashLaunchPlan(plan),
    launchId: sdk.hashLaunchIdentity(plan), predictedToken: token, transactions: [], profiles: [], simulation: { admitted: true } };
  const progress = { canonical: { phase, token }, confirmationSafe: true, receipts: references.map((reference) => ({
    transactionHash: reference.transactionHash, effectiveHash: reference.transactionHash, status: "confirmed",
    blockNumber: reference.observedBlockNumber, blockHash: reference.observedBlockHash })) };
  const client = { async request({ method, params }) {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getCode") return params[0] === fixture.creator ? "0x" : "0x6000";
    if (method === "eth_call") return encodeFunctionResult({ abi: sdk.launchLifecycleAbi, functionName: "registry", result: registry });
    if (method === "eth_getTransactionReceipt") { calls.push(`receipt:${params[0]}`); return receipts.find((receipt) => receipt.transactionHash === params[0]); }
    assert.fail(`No real RPC writes or unexpected reads: ${method}`);
  } };
  const readSdk = { ...sdk,
    prepareAndPlanLifecycleLaunch() { assert.fail("Resume must never mine identity or prepare a new plan"); },
    async planLaunch(options) {
      calls.push("plan");
      assert.deepEqual(JSON.parse(sdk.serializeLaunchPlan(options.plan)), recovery.plan);
      assert.equal(options.mode, mode); assert.equal(options.account, plan.creator); assert.equal(options.confirmations, 2);
      assert.deepEqual(options.receipts, references);
      const limits = await options.limits({ block: { number: 200n, hash: blockHash }, chainId: 4663n, account: plan.creator, orchestrator: core });
      assert.equal(limits.headroomBps, 1234); assert.equal(limits.maxCalldataBytes, 100_000);
      return planned;
    },
    async readLaunchProgress(options) {
      calls.push("progress"); assert.deepEqual(options.receipts, references); assert.equal(options.confirmations, 2);
      return progress;
    },
    async readLifecycleProfiles(options) {
      calls.push("profiles"); assert.deepEqual(options.profileIds, plan.markets.map((market) => market.profileId));
      return plan.markets.map((market) => ({ id: market.profileId, adapter: { implementation: core } }));
    },
    buildNextTransaction() { assert.fail("Injected branch tests must not execute lifecycle writes"); },
  };
  const transport = apiTransport({ artifacts, apiUrl, fetchImpl: async (url, init) => {
    calls.push("session"); assert.equal(init.method, "GET"); assert.equal(init.headers.Authorization, `Launch-Upload-Capability ${capability}`);
    assert.ok(String(url).includes("/retained-session?chainId=4663")); return new Response(JSON.stringify(response));
  } });
  const executed = { references, activation: { transactionHash: activationHash, receipt: receipts.at(-1) } };
  const options = { fixture, privateKey: key, sdk: readSdk, artifacts, client, transport, signal: new AbortController().signal,
    async execute(input) {
      calls.push("execute"); assert.deepEqual(input.references, references); assert.equal(input.planned, planned);
      assert.ok(input.wallet.signTransaction); return executed;
    },
    async verify(input) {
      calls.push("verify"); assert.equal(input.planned, planned); assert.deepEqual(input.references, references);
      assert.deepEqual(input.scenario, { id: "retained-case", mode, tokenKind: plan.token.kind, rewardMode: plan.token.rewardMode,
        markets: [{ venue: "v4", positions: 2 }, { venue: "abyss", positions: 1 }] });
      assert.equal(input.activation.transactionHash, activationHash);
    },
    async publish(input) {
      calls.push("publish"); assert.equal(input.session.capability, capability); assert.deepEqual(input.session.metadata, metadata);
      assert.equal(input.activation.transactionHash, activationHash); assert.deepEqual(input.references, references);
    },
  };
  return { options, original, artifacts, fixture, recovery, plan, planned, progress, response, references, receipts, calls, transport, parent };
}

test("launch arguments select dry-run, broadcast or resume and reject ambiguous commands with usage", () => {
  assert.deepEqual(readLaunchExampleArguments([]), { mode: "dry-run" });
  assert.deepEqual(readLaunchExampleArguments(["--broadcast"]), { mode: "broadcast" });
  assert.deepEqual(readLaunchExampleArguments(["--resume", "launch-results/original"]), { mode: "resume", resumeDirectory: "launch-results/original" });
  for (const args of [["--resume"], ["--resume", ""], ["--resume", "  "], ["--resume", "--other"], ["--resume", "dir", "extra"],
    ["--resume", "dir", "--broadcast"]]) {
    assert.throws(() => readLaunchExampleArguments(args), { code: "MISSING_RECOVERY", message: /Usage:.*--broadcast.*--resume/s });
  }
  for (const args of [["dir"], ["--unknown"], ["--resuem", "dir"], ["--dry-run"], ["--broadcast=true"], ["--broadcast", "false"],
    ["--broadcast", "--broadcast"], ["--broadcast", "--resume", "dir"]]) {
    assert.throws(() => readLaunchExampleArguments(args), { code: "INVALID_ARGUMENTS", message: /Usage:.*--broadcast.*--resume/s });
  }
});

test("all eleven wrapper commands route --resume before configuration and never create a replacement run", (t) => {
  const directory = temporary(t);
  const examples = fileURLToPath(new URL("../examples/", import.meta.url));
  const wrappers = readdirSync(examples).filter((name) => /^launch-erc(?:20|404)-.*\.ts$/.test(name));
  assert.equal(wrappers.length, 11);
  for (const wrapper of wrappers) {
    const result = spawnSync(process.execPath, [join(examples, wrapper), "--resume", join(directory, "missing")], {
      cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000,
    });
    assert.equal(result.status, 1, wrapper); assert.equal(result.stdout, "", wrapper);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.stage, "resume"); assert.equal(failure.error.code, "MISSING_RECOVERY");
  }
  assert.deepEqual(readdirSync(directory), [], "No replacement launch-results directory");
});

test("resume reopens the original evidence without truncating receipts or exposing retained secrets", (t) => {
  const { original, artifacts } = context(t);
  assert.equal(artifacts.result.caseId, "retained-case");
  assert.deepEqual(json(artifacts, "receipts.json"), json(original, "receipts.json"));
  const events = readFileSync(join(artifacts.directory, "events.jsonl"), "utf8");
  assert.ok(events.includes('"event":"resumed"')); assert.ok(events.includes("Original interruption"));
  artifacts.event("secret-boundary", { message: `${capability}; 0xfeed`, signature: artifacts.recovery.request.authorization.signature });
  const publicEvidence = readFileSync(join(artifacts.directory, "events.jsonl"), "utf8");
  assert.ok(!publicEvidence.includes(capability)); assert.ok(!publicEvidence.includes("0xfeed"));
  assert.equal(statSync(join(artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
  assert.throws(() => new RunArtifacts(artifacts.directory, "new-case"), { code: "EEXIST" });
  chmodSync(join(artifacts.directory, "private-recovery.json"), 0o644);
  assert.throws(() => new RunArtifacts(artifacts.directory, "new-case", undefined, { resume: true }), { code: "UNSAFE_LOCAL_FILE" });
});

for (const mode of ["atomic", "staged"]) test(`canonical Active ${mode} resumes verify/publication only, even after the signing deadline`, async (t) => {
  const c = context(t, { mode, expired: true });
  c.options.execute = () => assert.fail("Active must never re-execute");
  await resumeLaunchExample(c.options);
  assert.ok(c.calls.includes("plan")); assert.ok(c.calls.includes("profiles"));
  assert.ok(!c.calls.includes("execute")); assert.deepEqual(c.calls.slice(-3), ["session", "verify", "publish"]);
  assert.equal(c.artifacts.result.stage, "completed");
  assert.equal(json(c.artifacts, "private-recovery.json").session.capability, capability);
  assert.equal(json(c.artifacts, "private-recovery.json").capability, capability);
  assert.equal(c.artifacts.transactions.length, c.references.length);
});

for (const phase of [sdk.LifecyclePhase.Preparing, sdk.LifecyclePhase.Ready]) test(`canonical ${sdk.LifecyclePhase[phase] ?? phase} resumes the remaining execute path with retained typed receipts`, async (t) => {
  const c = context(t, { phase });
  await resumeLaunchExample(c.options);
  assert.deepEqual(c.calls.slice(-4), ["session", "execute", "verify", "publish"]);
  assert.ok(!c.calls.includes("profiles"), "Nonterminal planner already retains execution metadata");
  assert.equal(c.artifacts.result.stage, "completed");
});

test("resume refuses unstarted or cancelled canonical state rather than executing a new launch", async (t) => {
  for (const phase of [sdk.LifecyclePhase.None, sdk.LifecyclePhase.Cancelled]) {
    const c = context(t, { phase });
    await assert.rejects(resumeLaunchExample(c.options), { code: "RESUME_PHASE_UNSUPPORTED" });
    assert.ok(!c.calls.includes("session")); assert.ok(!c.calls.includes("execute"));
  }
});

test("resume stops read-only on reorged, moved, replaced, pending or confirmation-unsafe retained evidence", async (t) => {
  for (const change of ["reorg", "number", "hash", "replacement", "pending", "missing", "unsafe"]) {
    const c = context(t, { phase: sdk.LifecyclePhase.Preparing });
    if (change === "reorg") c.progress.receipts[0].status = "reorged";
    if (change === "number") c.progress.receipts[0].blockNumber += 1n;
    if (change === "hash") c.progress.receipts[0].blockHash = activationHash;
    if (change === "replacement") c.progress.receipts[0].effectiveHash = activationHash;
    if (change === "pending") c.progress.receipts[0].status = "pending";
    if (change === "missing") c.progress.receipts = [];
    if (change === "unsafe") c.progress.confirmationSafe = false;
    await assert.rejects(resumeLaunchExample(c.options), { code: "RECEIPT_RECONCILIATION_REQUIRED" });
    assert.equal(c.artifacts.result.execution, "reconciliation-required");
    assert.ok(!c.calls.includes("session")); assert.ok(!c.calls.includes("execute")); assert.ok(!c.calls.includes("publish"));
  }
});

test("Active recovery rechecks the actual activation inclusion after SDK progress before API work", async (t) => {
  const c = context(t);
  c.receipts.at(-1).blockHash = activationHash;
  await assert.rejects(resumeLaunchExample(c.options), { code: "RECEIPT_RECONCILIATION_REQUIRED" });
  assert.ok(!c.calls.includes("session")); assert.ok(!c.calls.includes("verify"));
});

test("resume never silently adopts a known replacement or resends an unresolved signed hash", async (t) => {
  for (const change of ["signed", "replacement"]) {
    const c = context(t, { phase: sdk.LifecyclePhase.Preparing });
    if (change === "signed") c.artifacts.recovery.signedTransactions.push({ transactionHash: activationHash, rawTransaction: "0xfeed" });
    else c.artifacts.recovery.receipts[0].replacementHash = activationHash;
    await assert.rejects(resumeLaunchExample(c.options), { code: "RECEIPT_RECONCILIATION_REQUIRED" });
    assert.equal(c.calls.length, 0, "Stop before admission or any API/chain writes");
  }
});

test("resume preserves the exact economic review admission and committed identity", async (t) => {
  for (const change of ["review", "admission", "plan", "creator", "mode", "refused"]) {
    const c = context(t, { phase: sdk.LifecyclePhase.Ready });
    if (change === "review") c.artifacts.recovery.economicReview.actualMintedSupply = "1";
    if (change === "admission") c.artifacts.recovery.economicAdmission.reviewHash = activationHash;
    if (change === "plan") c.artifacts.recovery.plan.nonce = "1";
    if (change === "creator") c.options.fixture = { ...c.fixture, creator: core };
    if (change === "mode") c.planned.mode = "atomic";
    if (change === "refused") c.planned.simulation.admitted = false;
    await assert.rejects(resumeLaunchExample(c.options));
    assert.ok(!c.calls.includes("session")); assert.ok(!c.calls.includes("execute"));
  }
});

function imageContext(t, { uploadStatus = 403, secondStatus = 200, alreadyReady = false, renewal = true } = {}) {
  const c = context(t, { image: imageDescriptor });
  const path = join(c.parent, "original.png"); writeFileSync(path, png); c.fixture.imagePath = path;
  const calls = []; let puts = 0;
  const ready = { ...c.response, status: "ready_to_launch", imageStatus: "ready", image: { ...imageDescriptor, width: 1, height: 1 } };
  const renewed = { ...c.response, upload: { ...c.response.upload, url: "https://objects.example.invalid/image?signature=fresh" } };
  const transport = apiTransport({ artifacts: c.artifacts, apiUrl, fetchImpl: async (url, init) => {
    const endpoint = new URL(url);
    if (init.method === "PUT") {
      calls.push("put"); puts++;
      assert.equal(endpoint.searchParams.get("signature"), puts === 1 ? "old" : "fresh");
      assert.deepEqual(Buffer.from(await init.body.arrayBuffer()), png);
      return new Response(null, { status: puts === 1 ? uploadStatus : secondStatus });
    }
    assert.equal(init.headers.Authorization, `Launch-Upload-Capability ${capability}`);
    if (endpoint.pathname.endsWith("/upload-url")) { calls.push("renew"); return new Response(JSON.stringify(renewed)); }
    if (endpoint.pathname.endsWith("/upload/complete")) { calls.push("complete"); return new Response(JSON.stringify(ready)); }
    assert.equal(init.method, "GET"); calls.push("get"); return new Response(JSON.stringify(alreadyReady ? ready : c.response));
  } });
  const imageSdk = renewal ? sdk : { ...sdk, LaunchApiClient: class extends sdk.LaunchApiClient { renewUploadUrl = undefined; } };
  const options = { fixture: c.fixture, planned: c.planned, recovery: c.artifacts.recovery, sdk: imageSdk, artifacts: c.artifacts, transport, signal: new AbortController().signal };
  return { ...c, options, path, calls };
}

for (const status of [403, 410, 412]) test(`resume renews an expired image PUT once on HTTP ${status}, retaining the original capability and bytes`, async (t) => {
  const c = imageContext(t, { uploadStatus: status });
  const session = await refreshExampleUploadSession(c.options);
  assert.deepEqual(c.calls, ["get", "put", "renew", "put", "complete"]);
  assert.equal(session.capability, capability); assert.deepEqual(session.image, imageDescriptor);
  const retained = json(c.artifacts, "private-recovery.json");
  assert.equal(retained.capability, capability); assert.equal(retained.session.capability, capability); assert.equal(retained.session.imageStatus, "ready");
  assert.equal(statSync(join(c.artifacts.directory, "private-recovery.json")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(c.artifacts.directory, "events.jsonl"), "utf8").includes(capability));
});

test("resume image PUT does not renew unrelated failures, retry twice, or pretend an absent renew method exists", async (t) => {
  for (const settings of [{ uploadStatus: 503 }, { uploadStatus: 403, secondStatus: 410 }, { uploadStatus: 403, renewal: false }]) {
    const c = imageContext(t, settings);
    await assert.rejects(refreshExampleUploadSession(c.options), { code: "UPLOAD_CONFLICT" });
    assert.deepEqual(c.calls, settings.secondStatus ? ["get", "put", "renew", "put"] : ["get", "put"]);
  }
});

test("resume reloads only the original signed image and fails before PUT if bytes differ or the path is missing", async (t) => {
  for (const missing of [false, true]) {
    const c = imageContext(t);
    if (missing) delete c.fixture.imagePath;
    else writeFileSync(c.path, Buffer.concat([png, Buffer.from([1])]));
    await assert.rejects(refreshExampleUploadSession(c.options));
    assert.deepEqual(c.calls, ["get"]);
  }
});

test("live ready-image refresh supersedes a stale awaiting-upload snapshot without reupload or a new attribution session", async (t) => {
  const c = imageContext(t, { alreadyReady: true }); delete c.fixture.imagePath;
  const session = await refreshExampleUploadSession(c.options);
  assert.deepEqual(c.calls, ["get"]); assert.equal(session.capability, capability);
  assert.equal(json(c.artifacts, "private-recovery.json").session.imageStatus, "ready");
});

test("in-flight resume reaches the existing build-next loop with every retained receipt and the freshly reviewed envelope", async (t) => {
  const c = context(t, { phase: sdk.LifecyclePhase.Ready });
  delete c.options.execute;
  const reviewed = { id: "activate", kind: "activate" };
  c.planned.transactions = [reviewed];
  const observed = Object.assign(new Error("Offline immediate-next boundary observed"), { code: "OFFLINE_BUILD_NEXT" });
  c.options.sdk.buildNextTransaction = async (options) => {
    c.calls.push("build-next");
    assert.deepEqual(options.receipts, c.references);
    assert.equal(options.reviewedTransaction, reviewed);
    assert.equal(options.submissionClient, c.options.client);
    throw observed; // Do not sign/broadcast in this control-flow test.
  };
  await assert.rejects(resumeLaunchExample(c.options), observed);
  assert.deepEqual(c.calls.slice(-2), ["session", "build-next"]);
  assert.ok(!c.calls.includes("verify")); assert.ok(!c.calls.includes("publish"));
});

test("a retained begin reorg between re-admission and build-next stops before any remaining signature or broadcast", async (t) => {
  const c = context(t, { phase: sdk.LifecyclePhase.Preparing });
  delete c.options.execute;
  const reviewed = { id: "activate", kind: "activate" };
  c.planned.transactions = [reviewed];
  c.options.sdk.buildNextTransaction = async (options) => {
    assert.deepEqual(options.receipts, c.references);
    c.progress.receipts[0].status = "reorged";
    return reviewed;
  };
  await assert.rejects(resumeLaunchExample(c.options), { code: "RECEIPT_RECONCILIATION_REQUIRED" });
  assert.ok(!c.calls.includes("verify")); assert.ok(!c.calls.includes("publish"));
  assert.equal(c.artifacts.transactions.length, 1);
  assert.equal(json(c.artifacts, "private-recovery.json").signedTransactions.length, 1);
});

test("historical recovery restores policy from run-config and canonical receipt logs without a public receipt journal", async (t) => {
  const c = context(t);
  const retained = json(c.artifacts, "private-recovery.json");
  const policy = retained.executionLimits;
  delete retained.executionLimits;
  delete retained.session.capability; // completeUpload persisted only the top-level secret.
  writeFileSync(join(c.artifacts.directory, "private-recovery.json"), JSON.stringify(portable(retained)));
  writeFileSync(join(c.artifacts.directory, "run-config.json"), JSON.stringify({ configuration: { executionLimits: policy } }));
  rmSync(join(c.artifacts.directory, "receipts.json"));
  const artifacts = new RunArtifacts(c.artifacts.directory, "ignored-case", undefined, { resume: true });
  artifacts.initialize();
  const transport = apiTransport({ artifacts, apiUrl, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, `Launch-Upload-Capability ${capability}`);
    return new Response(JSON.stringify(c.response));
  } });
  c.options.execute = () => assert.fail("Historical Active recovery must not re-execute");
  await resumeLaunchExample({ ...c.options, artifacts, transport });
  assert.equal(artifacts.transactions.length, c.references.length);
  assert.deepEqual(artifacts.transactions.map((row) => row.receipt), c.receipts);
  const recovered = json(artifacts, "private-recovery.json");
  assert.equal(recovered.session.capability, capability);
  assert.deepEqual(recovered.plan, retained.plan);
  assert.deepEqual(recovered.economicAdmission, retained.economicAdmission);
});

test("Active resume completes the pending original image before verification/publication without another chain execution", async (t) => {
  const c = context(t, { image: imageDescriptor });
  const path = join(c.parent, "original.png"); writeFileSync(path, png); c.fixture.imagePath = path;
  const ready = { ...c.response, status: "ready_to_launch", imageStatus: "ready", image: { ...imageDescriptor, width: 1, height: 1 } };
  c.options.transport = apiTransport({ artifacts: c.artifacts, apiUrl, fetchImpl: async (url, init) => {
    if (init.method === "PUT") {
      c.calls.push("image-put"); assert.deepEqual(Buffer.from(await init.body.arrayBuffer()), png);
      return new Response(null, { status: 200 });
    }
    assert.equal(init.headers.Authorization, `Launch-Upload-Capability ${capability}`);
    if (String(url).includes("/upload/complete")) { c.calls.push("image-complete"); return new Response(JSON.stringify(ready)); }
    assert.equal(init.method, "GET"); c.calls.push("image-session"); return new Response(JSON.stringify(c.response));
  } });
  c.options.execute = () => assert.fail("Active image continuation must not re-execute");
  const publish = c.options.publish;
  c.options.publish = async (options) => { assert.deepEqual(options.session.image, imageDescriptor); await publish(options); };
  await resumeLaunchExample(c.options);
  assert.deepEqual(c.calls.slice(-5), ["image-session", "image-put", "image-complete", "verify", "publish"]);
  assert.equal(json(c.artifacts, "private-recovery.json").session.capability, capability);
});
