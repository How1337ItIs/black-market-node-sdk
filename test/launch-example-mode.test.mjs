import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { typescriptNodeArgs } from "./register-typescript.mjs";
import { economicReviewHash, Redactor } from "../examples/launch-example-support.ts";
import { launchExampleBroadcastCommand } from "../examples/launch-example.ts";

const driver = new URL("./fixtures/launch-example-mode.mjs", import.meta.url).href;
const examples = fileURLToPath(new URL("../examples/", import.meta.url));
function offlineRun(t, argv = [], options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "launch-example-mode-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [...typescriptNodeArgs, "--input-type=module", "-e",
    `import { runOfflineExample } from ${JSON.stringify(driver)}; await runOfflineExample(${JSON.stringify(argv)}, ${JSON.stringify(options)});`], {
    cwd, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, SDK_SOURCE_TEST: process.env.SDK_SOURCE_TEST },
  });
  const observations = JSON.parse(readFileSync(join(cwd, "offline-observations.json"), "utf8"));
  const runs = readdirSync(join(cwd, "launch-results"));
  assert.equal(runs.length, 1);
  const directory = join(cwd, "launch-results", runs[0]);
  const json = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
  return { child, cwd, directory, json, ...observations };
}

// Offline evidence-boundary tests; injected admission and publication are not live proof.
test("default dry-run exits zero, prints the full review and command, and never creates or calls a signer", (t) => {
  const c = offlineRun(t, [], { withImage: true });
  assert.equal(c.child.status, 0, c.child.stderr);
  assert.equal(c.child.stderr, "");
  assert.ok(c.child.stdout.startsWith("DRY RUN — no transactions signed or broadcast.\n"));
  assert.match(c.child.stdout, /Economic review 0x[\da-f]{64}/);
  assert.match(c.child.stdout, /retained-supply opening valuation USD/);
  assert.match(c.child.stdout, /Expected rounding burn/);
  assert.match(c.child.stdout, /Buy 0 market 0\/WETH: quote spent/);
  assert.match(c.child.stdout, /WETH\/USD .*source abyss-api/);
  assert.match(c.child.stdout, /Image image\/png/);
  const command = `node ${relative(c.cwd, join(examples, "launch-erc20-abyss.ts"))} --broadcast`;
  assert.ok(c.child.stdout.endsWith(`To sign, broadcast and publish, re-run with --broadcast:\n${command}\n`));
  assert.equal(c.calls.planning, 1);
  assert.equal(c.calls.prices, 1);
  for (const name of ["wallet", "signTypedData", "signTransaction", "send", "stage", "execute", "verify", "publish"]) {
    assert.equal(c.calls[name], 0, name);
  }
  assert.ok(!c.calls.requests.some((method) => /send|sign|personal_/i.test(method)));
  assert.equal(c.result.status, "passed");
  assert.equal(c.result.runMode, "dry-run");
  assert.equal(c.result.execution, "dry-run");
  assert.equal(c.result.scope, "planning");
  assert.equal(c.result.chain.status, "not-run");
  assert.equal(c.result.api.status, "not-run");
  assert.deepEqual(c.json("result.json"), c.result);
  for (const name of ["identity.json", "profiles.json", "draft-plan.json", "plan.json", "planning.json", "economic-review.json",
    "hook-deployments.json", "run-config.json", "receipts.json", "events.jsonl", "private-recovery.json"]) {
    assert.ok(existsSync(join(c.directory, name)), name);
  }
  const { reviewHash, ...review } = c.json("economic-review.json");
  assert.equal(economicReviewHash(review), reviewHash);
  assert.match(c.child.stdout, new RegExp(reviewHash));
  assert.deepEqual(c.json("plan.json"), review.finalizedPlan);
  assert.equal(review.image.contentType, "image/png");
  assert.equal(review.initialBuy.funding.length, 1);
  assert.deepEqual(c.json("receipts.json").transactions, []);
  const recovery = c.json("private-recovery.json");
  assert.deepEqual(recovery.plan, review.finalizedPlan);
  assert.equal(recovery.economicReview.reviewHash, reviewHash);
  for (const name of ["economicAdmission", "signedTransactions", "request", "session", "capability"]) assert.equal(recovery[name], undefined, name);
  assert.equal(statSync(join(c.directory, "private-recovery.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(c.directory, "economic-admission.json")), false);
  assert.equal(existsSync(join(c.directory, "published-token.json")), false);
});

test("--broadcast needs no hash input and routes through guarded signing, execution, verification and publication", (t) => {
  for (const withImage of [false, true]) {
    const c = offlineRun(t, ["--broadcast"], { withImage });
    assert.equal(c.child.status, 0, c.child.stderr);
    assert.equal(c.child.stderr, "");
    assert.ok(!c.child.stdout.includes("DRY RUN"));
    assert.match(c.child.stdout, /Economic review 0x[\da-f]{64}/);
    assert.match(c.child.stdout, /Actual chain launch and API publication\/indexing passed/);
    assert.ok(!c.child.stdout.includes("Type the economic review"));
    for (const name of ["planning", "wallet", "signTypedData", "signTransaction", "send", "stage", "execute", "verify", "publish"]) {
      assert.equal(c.calls[name], 1, name);
    }
    assert.equal(c.calls.prices, 3, "Both signature paths retain fresh economic-authority checks");
    const admission = c.json("economic-admission.json");
    assert.equal(admission.authorization, "--broadcast");
    assert.equal(admission.reviewHash, c.json("economic-review.json").reviewHash);
    assert.ok(!Number.isNaN(Date.parse(admission.admittedAt)));
    assert.deepEqual(c.json("private-recovery.json").economicAdmission, admission);
    assert.equal(c.result.runMode, "broadcast");
    assert.equal(c.result.scope, "end-to-end");
    assert.equal(c.result.execution, "completed");
  }
});

test("neither mode bypasses planner admission or reaches a signer after refusal", (t) => {
  for (const argv of [[], ["--broadcast"]]) {
    const c = offlineRun(t, argv, { admitted: false });
    assert.equal(c.child.status, 1);
    assert.equal(c.result.error.code, "PLAN_NOT_ADMITTED");
    assert.equal(c.result.error.message, "Offline planner refusal");
    assert.equal(c.calls.planning, 1);
    for (const name of ["wallet", "signTypedData", "signTransaction", "send", "stage", "execute", "verify", "publish"]) {
      assert.equal(c.calls[name], 0, name);
    }
    assert.ok(c.json("economic-review.json").reviewHash);
    assert.equal(existsSync(join(c.directory, "economic-admission.json")), false);
  }
});

test("all eleven wrappers reject malformed mode flags before configuration or artifact creation", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "launch-mode-usage-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const wrappers = readdirSync(examples).filter((name) => /^launch-erc(?:20|404)-.*\.ts$/.test(name));
  assert.equal(wrappers.length, 11);
  const malformed = [["--broadcast", "--broadcast"], ["--broadcast=false"], ["--broadcast", "--resume", "dir"],
    ["--resume", "dir", "--broadcast"], ["--resume"], ["--unknown"]];
  for (const [index, wrapper] of wrappers.entries()) {
    const child = spawnSync(process.execPath, [...typescriptNodeArgs, join(examples, wrapper), ...malformed[index % malformed.length]], {
      cwd, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000,
    });
    assert.equal(child.status, 1, wrapper);
    assert.equal(child.stdout, "", wrapper);
    const failure = JSON.parse(child.stderr);
    assert.match(failure.error.message, /Usage: node examples\/<case>\.ts \[--broadcast \| --resume <recovery-dir>\]/);
    assert.ok(["INVALID_ARGUMENTS", "MISSING_RECOVERY"].includes(failure.error.code));
  }
  assert.deepEqual(readdirSync(cwd), [], "Malformed flags must fail before artifacts or configuration");
});

test("broadcast command preserves the case path and Node flags with shell-safe quoting", () => {
  assert.equal(launchExampleBroadcastCommand({ script: "/repo/examples/launch-erc20-v4.ts", cwd: "/repo", execArgv: [] }),
    "node examples/launch-erc20-v4.ts --broadcast");
  assert.equal(launchExampleBroadcastCommand({ script: "/repo/examples/owner's launch.ts", cwd: "/repo", execArgv: ["--no-warnings"] }),
    "node --no-warnings 'examples/owner'\\''s launch.ts' --broadcast");
});

test("public mode authorization remains evidence while API and unrecognized authorization stay secret", () => {
  const redactor = new Redactor();
  const provenance = { authorization: "--broadcast", reviewHash: `0x${"ab".repeat(32)}`, admittedAt: "2026-10-10T00:00:00Z" };
  assert.deepEqual(redactor.value(provenance), provenance);
  assert.deepEqual(JSON.parse(redactor.text(JSON.stringify(provenance))), provenance);
  for (const authorization of ["Bearer credential", "--broadcast", { signature: "private-signature", nonce: "nonce" }]) {
    assert.equal(redactor.value({ authorization }).authorization, "[REDACTED]");
  }
  assert.equal(redactor.value({ ...provenance, authorization: "Bearer credential" }).authorization, "[REDACTED]");
});
