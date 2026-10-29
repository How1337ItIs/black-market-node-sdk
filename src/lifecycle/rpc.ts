import { decodeFunctionResult, encodeFunctionData, isAddress, isHex, keccak256, multicall3Abi, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import { LifecyclePlanningError, type LifecycleBlock, type LifecycleDiagnosticEvent, type LifecycleDiagnosticListener, type LifecycleDiagnosticStage, type LifecycleLimitContext, type LifecycleLimitSource, type LifecycleLimits, type LifecycleRpcClient, type LifecycleSessionCache, type LifecycleTransaction, type ResolvedLifecycleLimits } from "./types.js";
import { lifecycleRegistryAbi } from "./abi.js";
import type { ProfileTopologyV1 } from "./schema.js";
import { robinhoodMainnet } from "../addresses.js";
import { ROBINHOOD_NATIVE_TRANSACTION_GAS_LIMIT } from "./presets.js";

// Reviewed chain4663 deployment, independently observed at block 98,136,655.
const multicall3CodeHash = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
const sessionObservations = new WeakMap<object, Map<string, Promise<unknown>>>();
const clientChainIds = new WeakMap<LifecycleRpcClient, Promise<bigint>>();

function rememberClientChainId(source: LifecycleRpcClient, request: Promise<unknown>): Promise<bigint> {
  const pending = request.then((value) => rpcQuantity(value, "chain ID"));
  clientChainIds.set(source, pending);
  void pending.catch(() => { if (clientChainIds.get(source) === pending) clientChainIds.delete(source); });
  return pending;
}
const canonicalWireValue = (_key: string, value: unknown): unknown => typeof value === "string" && value.startsWith("0x") ? value.toLowerCase() : value;
type IndependentRead = { params: readonly unknown[]; resolve: (value: unknown) => void; reject: (failure: unknown) => void };

const lifecycleReadConcurrency = 8;
const diagnosticRpcMethods: Record<string, true> = {
  eth_chainId: true, eth_getBlockByNumber: true, eth_getBlockByHash: true, eth_getCode: true,
  eth_getBalance: true, eth_call: true, eth_estimateGas: true, eth_gasPrice: true,
  eth_simulateV1: true, eth_getTransactionCount: true, eth_getTransactionReceipt: true, eth_getTransactionByHash: true,
};

type SessionReadGroup = {
  chainId?: bigint;
  block: Readonly<Pick<LifecycleBlock, "number" | "hash">>;
  values: Map<string, Hex>;
};

/** Private wire observations; callers can inspect the pin or discard it, never install values. */
class SessionLifecycleCache implements LifecycleSessionCache {
  #group?: SessionReadGroup;

  get block(): LifecycleSessionCache["block"] { return this.#group?.block; }

  invalidate(): void {
    this.#group?.values.clear();
    this.#group = undefined;
  }

  pin(block: LifecycleBlock, chainId?: bigint): SessionReadGroup {
    const group = this.#group;
    if (group !== undefined && group.block.number === block.number && group.block.hash.toLowerCase() === block.hash.toLowerCase() &&
      (chainId === undefined || group.chainId === undefined || group.chainId === chainId)) {
      if (chainId !== undefined) group.chainId = chainId;
      return group;
    }
    this.invalidate();
    return this.#group = {
      chainId,
      block: Object.freeze({ number: block.number, hash: block.hash }),
      values: new Map(),
    };
  }

  isCurrent(group: SessionReadGroup, block: LifecycleBlock): boolean {
    return this.#group === group &&
      group.block.number === block.number && group.block.hash.toLowerCase() === block.hash.toLowerCase();
  }

  observeChain(group: SessionReadGroup, chainId: bigint): void {
    if (this.#group !== group) return;
    if (group.chainId !== undefined && group.chainId !== chainId) this.invalidate();
    else group.chainId = chainId;
  }
}

/** Opt-in pinned read reuse; client-bound identity/capability facts are separate. */
export function createLifecycleSessionCache(): LifecycleSessionCache {
  return new SessionLifecycleCache();
}

/** Owns only one invocation's immutable RPC observations, never live checks or writes. */
class InvocationLifecycleClient implements LifecycleRpcClient {
  private readonly reads = new Map<string, Promise<unknown>>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  private readonly concurrency: number;
  private diagnosticSequence = 0;
  private chainId?: Promise<bigint>;
  private gasPrice?: Promise<unknown>;
  private readonly immutableReads = new Map<string, Promise<unknown>>();
  private readonly independentReads = new Map<string, { block: LifecycleBlock; reads: IndependentRead[] }>();
  readonly finalChecks = new Set<() => void>();
  private readonly limitObservations = new Map<LifecycleLimitSource | undefined, Map<string, Promise<LifecycleLimitObservation>>>();
  private readonly session?: SessionLifecycleCache;
  private sessionGroup?: SessionReadGroup;
  private observedChainId?: bigint;
  private sessionHits = 0;
  private sessionMisses = 0;
  private sessionReuses = 0;
  constructor(readonly source: LifecycleRpcClient) {
    this.concurrency = source.supportsReadBatching === true ? lifecycleReadConcurrency : 1;
    if (source.sessionCache !== undefined) {
      if (!(source.sessionCache instanceof SessionLifecycleCache)) throw new LifecyclePlanningError("INVALID_SESSION_CACHE", "Lifecycle session cache must be created by createLifecycleSessionCache");
      this.session = source.sessionCache;
      if (source.onDiagnostic !== undefined) emitLifecycleDiagnostic(source.onDiagnostic, { stage: "session-cache", phase: "start" });
    }
  }

  async request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    this.assertOpen();
    const result = await this.source.request(args);
    this.assertOpen();
    return result;
  }

  assertOpen(): void {
    if (this.closed) throw new LifecyclePlanningError("READ_SCOPE_CLOSED", "Lifecycle read invocation has already settled");
  }

  async run(method: string, params: readonly unknown[]): Promise<unknown> {
    this.assertOpen();
    const listener = this.source.onDiagnostic;
    const observedMethod = listener === undefined ? undefined : diagnosticRpcMethods[method] === true ? method : "other";
    const queuedAt = listener === undefined ? 0 : performance.now();
    const requestId = listener === undefined ? 0 : ++this.diagnosticSequence;
    if (listener !== undefined) emitLifecycleDiagnostic(listener, { stage: "rpc", phase: "queued", requestId, method: observedMethod });
    while (this.active.size >= this.concurrency) await Promise.race(this.active);
    this.assertOpen();
    const started = listener === undefined ? 0 : performance.now();
    if (listener !== undefined) emitLifecycleDiagnostic(listener, { stage: "rpc", phase: "start", requestId, method: observedMethod, queueMs: started - queuedAt });
    const pending = this.request({ method, params });
    const settled = pending.then(
      () => { this.active.delete(settled); },
      () => { this.active.delete(settled); },
    );
    this.active.add(settled);
    try {
      const result = await pending;
      if (listener !== undefined) emitLifecycleDiagnostic(listener, { stage: "rpc", phase: "success", requestId, method: observedMethod, durationMs: performance.now() - started });
      if (this.session !== undefined && method === "eth_chainId") {
        this.observedChainId = rpcQuantity(result, "chain ID");
        if (this.sessionGroup !== undefined) this.session.observeChain(this.sessionGroup, this.observedChainId);
      }
      return result;
    } catch (error) {
      if (listener !== undefined) emitLifecycleDiagnostic(listener, { stage: "rpc", phase: "failure", requestId, method: observedMethod, durationMs: performance.now() - started });
      throw error;
    }
  }

  observeBlock(block: LifecycleBlock, latest: boolean): void {
    if (this.session === undefined) return;
    this.assertOpen();
    if (latest) {
      this.sessionGroup = this.session.pin(block, this.observedChainId);
    } else if (this.sessionGroup?.block.number === block.number && this.sessionGroup.block.hash.toLowerCase() !== block.hash.toLowerCase()) {
      this.invalidateSession();
    }
  }

  invalidateSession(): void {
    this.session?.invalidate();
    this.sessionGroup = undefined;
  }

  observeChainId(): Promise<bigint> {
    this.assertOpen();
    if (this.chainId === undefined) {
      const observed = clientChainIds.get(this.source) ?? rememberClientChainId(this.source, this.run("eth_chainId", []));
      this.chainId = this.session === undefined ? observed : observed.then((chainId) => {
        if (!this.closed) {
          this.observedChainId = chainId;
          if (this.sessionGroup !== undefined) this.session!.observeChain(this.sessionGroup, chainId);
        }
        return chainId;
      });
    }
    return this.chainId;
  }

  observeGasPrice(): Promise<unknown> {
    this.assertOpen();
    return this.gasPrice ??= this.run("eth_gasPrice", []);
  }

  immutableRead(key: string, work: () => Promise<unknown>): Promise<unknown> {
    this.assertOpen();
    let pending = this.immutableReads.get(key);
    if (pending === undefined) {
      pending = work();
      this.immutableReads.set(key, pending);
      const owned = pending;
      void pending.catch(() => { if (this.immutableReads.get(key) === owned) this.immutableReads.delete(key); });
    }
    return pending.then((value) => { this.assertOpen(); return value; });
  }


  async finalize(): Promise<void> {
    this.assertOpen();
    for (const check of this.finalChecks) check();
  }

  independentRead(params: readonly unknown[], block: LifecycleBlock, staticRead: boolean): Promise<unknown> {
    return this.read("eth_call", params, block, staticRead, () => new Promise((resolve, reject) => {
      const key = `${block.number}:${block.hash.toLowerCase()}`;
      let group = this.independentReads.get(key);
      if (group === undefined) {
        group = { block, reads: [] };
        this.independentReads.set(key, group);
        queueMicrotask(() => {
          this.independentReads.delete(key);
          void this.flushIndependentReads(group!);
        });
      }
      group.reads.push({ params, resolve, reject });
    }));
  }

  private async flushIndependentReads(group: { block: LifecycleBlock; reads: IndependentRead[] }): Promise<void> {
    const { block, reads } = group;
    try {
      if (await this.observeChainId() !== 4663n) {
        await Promise.all(reads.map(async (read) => {
          try { read.resolve(await this.run("eth_call", read.params)); }
          catch (failure) { read.reject(failure); }
        }));
        return;
      }
      const to = robinhoodMainnet.contracts.multicall3.address;
      await attestLifecycleMulticall(this, block);
      const calls = reads.map((read) => {
        const request = read.params[0] as { to: Address; data: Hex };
        return { target: request.to, allowFailure: true, callData: request.data };
      });
      const data = encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
      const raw = rpcHex(await this.run("eth_call", [{ to, data }, toHex(block.number)]), "Multicall3 result");
      const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
      if (results.length !== reads.length) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Multicall3 omitted independent pinned results");
      for (let index = 0; index < reads.length; index += 1) {
        const result = results[index]!;
        if (result.success) reads[index]!.resolve(result.returnData);
        else reads[index]!.reject(new LifecyclePlanningError("MULTICALL_READ_FAILED", "An independent pinned getter reverted"));
      }
    } catch (failure) { for (const read of reads) read.reject(failure); }
  }

  observeLimits(context: LifecycleLimitContext, source?: LifecycleLimitSource): Promise<LifecycleLimitObservation> {
    this.assertOpen();
    // A caller callback is live policy, not an immutable pinned observation.
    // Its current result must validate provenance; native fixed-state reads still reuse their wire cache.
    if (typeof source === "function") return resolveLifecycleLimitsFresh(context, source).then((result) => {
      this.assertOpen();
      result.assertCurrent();
      return result;
    });
    const key = JSON.stringify([context.chainId.toString(), context.account.toLowerCase(), context.orchestrator.toLowerCase(), context.block.number.toString(), context.block.hash.toLowerCase(), context.block.timestamp.toString(), context.block.gasLimit.toString(), context.block.baseFeePerGas?.toString()]);
    let byContext = this.limitObservations.get(source);
    if (byContext === undefined) { byContext = new Map(); this.limitObservations.set(source, byContext); }
    const contexts = byContext;
    let observation = byContext.get(key);
    if (observation === undefined) {
      observation = resolveLifecycleLimitsFresh(context, source);
      byContext.set(key, observation);
      const owned = observation;
      void owned.catch(() => { if (contexts.get(key) === owned) contexts.delete(key); });
    }
    return observation.then((result) => { this.assertOpen(); result.assertCurrent(); return result; });
  }

  read(method: string, params: readonly unknown[], block: LifecycleBlock, staticRead = false, load?: () => Promise<unknown>): Promise<unknown> {
    this.assertOpen();
    // Source identity is this scope's original client. The complete wire call includes
    // caller, value, gas and any other call fields; no selector-only/ABI-name aliasing.
    const key = JSON.stringify([block.number.toString(), block.hash, method, params], canonicalWireValue);
    const existing = this.reads.get(key);
    if (existing !== undefined) {
      if (staticRead && this.session !== undefined) this.sessionReuses += 1;
      const listener = this.source.onDiagnostic;
      if (listener !== undefined) emitLifecycleDiagnostic(listener, { stage: "rpc", phase: "reuse", method: diagnosticRpcMethods[method] === true ? method : "other" });
      return existing;
    }
    const group = staticRead && this.observedChainId !== undefined && this.sessionGroup !== undefined &&
      this.session?.isCurrent(this.sessionGroup, block) ? this.sessionGroup : undefined;
    const cached = group?.values.get(key);
    let pending: Promise<unknown>;
    if (cached !== undefined) {
      this.sessionHits += 1;
      pending = Promise.resolve(cached);
    } else {
      if (staticRead && this.session !== undefined) this.sessionMisses += 1;
      pending = load === undefined ? this.run(method, params) : load();
      if (group !== undefined) pending = pending.then((value) => {
        // Never share in-flight work or install late results after invalidation/closure.
        // Only wire hex is retained, so public decoded DTOs cannot mutate authority.
        if (!this.closed && this.session?.isCurrent(group, block) && typeof value === "string" && isHex(value)) group.values.set(key, value);
        return value;
      });
    }
    this.reads.set(key, pending);
    void pending.catch(() => { if (this.reads.get(key) === pending) this.reads.delete(key); });
    return pending;
  }

  seed(method: string, params: readonly unknown[], block: LifecycleBlock, value: unknown): void {
    this.assertOpen();
    const key = JSON.stringify([block.number.toString(), block.hash, method, params], canonicalWireValue);
    this.reads.set(key, Promise.resolve(value));
  }

  close(success: boolean): void {
    this.closed = true;
    this.reads.clear();
    this.chainId = undefined;
    this.limitObservations.clear();
    this.gasPrice = undefined;
    this.immutableReads.clear();
    this.independentReads.clear();
    this.finalChecks.clear();
    const listener = this.source.onDiagnostic;
    if (this.session !== undefined && listener !== undefined) emitLifecycleDiagnostic(listener, {
      stage: "session-cache", phase: success ? "success" : "failure",
      hits: this.sessionHits, misses: this.sessionMisses, reuses: this.sessionReuses,
    });
  }
}

/** Internal callers join the same invocation; only explicit static reads opt in to a session. */
export async function withLifecycleReadClient<T>(source: LifecycleRpcClient, work: (client: LifecycleRpcClient) => Promise<T>): Promise<T> {
  if (source instanceof InvocationLifecycleClient) return work(source);
  const client = new InvocationLifecycleClient(source);
  let success = false;
  try {
    let result: T;
    try { result = await work(client); }
    catch (failure) {
      // Live policy is rechecked even when exact execution or a source read refuses.
      await client.finalize();
      throw failure;
    }
    await client.finalize();
    success = true;
    return result;
  } finally { client.close(success); }
}

export function lifecycleSourceClient(client: LifecycleRpcClient): LifecycleRpcClient {
  return client instanceof InvocationLifecycleClient ? client.source : client;
}

/** Internal continuations cannot retain proof after their read owner settles. */
export function assertLifecycleReadClientOpen(client: LifecycleRpcClient): boolean {
  if (!(client instanceof InvocationLifecycleClient)) return false;
  client.assertOpen();
  return true;
}

function emitLifecycleDiagnostic(listener: LifecycleDiagnosticListener, event: LifecycleDiagnosticEvent): void {
  try {
    const pending = listener(event);
    if (pending !== undefined) void pending.catch(() => {});
  } catch { /* Observers cannot change financial behavior. */ }
}

/** No clock, event allocation or extra promise when diagnostics are disabled. */
export function lifecycleStage<T>(client: LifecycleRpcClient, stage: LifecycleDiagnosticStage, work: () => Promise<T>): Promise<T> {
  const listener = lifecycleSourceClient(client).onDiagnostic;
  return listener === undefined ? work() : observedLifecycleStage(listener, stage, work);
}

async function observedLifecycleStage<T>(listener: LifecycleDiagnosticListener, stage: LifecycleDiagnosticStage, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  emitLifecycleDiagnostic(listener, { stage, phase: "start" });
  try {
    const result = await work();
    emitLifecycleDiagnostic(listener, { stage, phase: "success", durationMs: performance.now() - started });
    return result;
  } catch (error) {
    emitLifecycleDiagnostic(listener, { stage, phase: "failure", durationMs: performance.now() - started });
    throw error;
  }
}

/** Only explicitly pinned fixed-state reads may participate in invocation reuse. */
export async function lifecyclePinnedRpc(client: LifecycleRpcClient, method: "eth_call" | "eth_getCode" | "eth_getBalance", params: readonly unknown[], block: LifecycleBlock, staticRead = false): Promise<unknown> {
  if (params.length !== 2 || params[1] !== toHex(block.number)) throw new LifecyclePlanningError("INVALID_READ_CONTEXT", "Reusable lifecycle reads require the exact pinned block and no state overrides");
  return client instanceof InvocationLifecycleClient ? client.read(method, params, block, staticRead && method !== "eth_getBalance") : lifecycleRpc(client, method, params);
}

/** Explicit SDK-owned static class only; balances and execution calls never use this path. */
export function lifecycleStaticRpc(client: LifecycleRpcClient, method: "eth_call" | "eth_getCode", params: readonly unknown[], block: LifecycleBlock): Promise<unknown> {
  return lifecyclePinnedRpc(client, method, params, block, true);
}

export async function lifecycleRpc(client: LifecycleRpcClient, method: string, params: readonly unknown[] = []): Promise<unknown> {
  return client instanceof InvocationLifecycleClient ? client.run(method, params) : client.request({ method, params });
}
/** Client-bound identity, observed once per underlying client, never a freshness guard. */
export function readLifecycleChainId(client: LifecycleRpcClient): Promise<bigint> {
  if (client instanceof InvocationLifecycleClient) return client.observeChainId();
  return clientChainIds.get(client) ?? rememberClientChainId(client, lifecycleRpc(client, "eth_chainId"));
}

/** A single operation-local recommendation, never a session or cross-head quote. */
export function readLifecycleGasPrice(client: LifecycleRpcClient, block: LifecycleBlock, chainId: bigint): Promise<bigint> {
  if (chainId === 4663n) return readNitroPrices(client, block).then((prices) => prices[5]);
  return (client instanceof InvocationLifecycleClient ? client.observeGasPrice() : lifecycleRpc(client, "eth_gasPrice"))
    .then((price) => rpcQuantity(price, "gas price"));
}

/** Only the reviewed immutable factory identity may use an invocation-wide key. */
export function readLifecycleImmutable<T>(client: LifecycleRpcClient, key: string, work: () => Promise<T>): Promise<T> {
  return (client instanceof InvocationLifecycleClient ? client.immutableRead(key, work) : work()) as Promise<T>;
}

/** Successful deployment/backend observations live for the caller's session, not one block. */
export function lifecycleSessionRead<T>(client: LifecycleRpcClient, key: string, work: () => Promise<T>): Promise<T> {
  const source = lifecycleSourceClient(client);
  const owner = source.sessionCache ?? source;
  let values = sessionObservations.get(owner);
  if (values === undefined) { values = new Map(); sessionObservations.set(owner, values); }
  let pending = values.get(key);
  if (pending === undefined) {
    pending = work();
    values.set(key, pending);
    const owned = pending;
    void pending.catch(() => { if (values.get(key) === owned) values.delete(key); });
  }
  return pending as Promise<T>;
}

export async function attestLifecycleMulticall(client: LifecycleRpcClient, block?: LifecycleBlock): Promise<void> {
  const to = robinhoodMainnet.contracts.multicall3.address;
  await lifecycleSessionRead(client, `4663:multicall:${to}`, async () => {
    const code = rpcHex(await lifecycleRpc(client, "eth_getCode", [to, block === undefined ? "latest" : toHex(block.number)]), "Multicall3 code");
    if (keccak256(code) !== multicall3CodeHash) throw new LifecyclePlanningError("MULTICALL_CODE_MISMATCH", "Multicall3 runtime differs from the reviewed chain4663 deployment");
  });
}

/** Installs only SDK-observed wire results from this invocation's aggregate/lens. */
export function seedLifecycleRead(client: LifecycleRpcClient, method: string, params: readonly unknown[], block: LifecycleBlock, value: unknown): void {
  if (!(client instanceof InvocationLifecycleClient)) throw new LifecyclePlanningError("INVALID_READ_CONTEXT", "Snapshot reads require an invocation owner");
  client.observeBlock(block, true);
  client.seed(method, params, block, value);
}

/** Recheck live policy after the owner's final asynchronous canonical guards. */
export function registerLifecycleFinalCheck(client: LifecycleRpcClient, check: () => void): void {
  if (client instanceof InvocationLifecycleClient) { client.assertOpen(); client.finalChecks.add(check); }
}

/** SDK-selected caller-independent getters only; never poster quotes or execution. */
function lifecycleIndependentRpc(client: LifecycleRpcClient, params: readonly unknown[], block: LifecycleBlock, staticRead: boolean): Promise<unknown> {
  return client instanceof InvocationLifecycleClient
    ? client.independentRead(params, block, staticRead)
    : lifecyclePinnedRpc(client, "eth_call", params, block, staticRead);
}
export function rpcObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", `${label} must be an object`);
  // The object guard establishes the RPC record boundary; fields remain untrusted unknowns.
  const record = value as Record<string, unknown>;
  return record;
}
export function rpcHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value)) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", `${label} must be hex`);
  return value;
}
export function rpcQuantity(value: unknown, label: string): bigint {
  const hex = rpcHex(value, label);
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", `${label} must be a quantity`);
  return BigInt(hex);
}

/** Public refusal details contain only fixed text and numeric RPC/HTTP codes, never provider messages. */
export function lifecycleFailureReason(failure: unknown): string {
  for (let depth = 0; depth < 8 && failure !== null && typeof failure === "object"; depth += 1) {
    const error = failure as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    const status = error.status ?? error.statusCode;
    if (typeof status === "number" && Number.isSafeInteger(status) && status >= 400 && status <= 599) return `HTTP read failed (status ${status})`;
    if (typeof error.code === "number" && Number.isSafeInteger(error.code)) return `RPC request failed (code ${error.code})`;
    if (failure instanceof LifecyclePlanningError) return "Lifecycle planning guard rejected the request";
    failure = error.cause;
  }
  return "Read or execution proof failed";
}
export async function readLifecycleBlock(client: LifecycleRpcClient, tag: Hex | "latest" = "latest"): Promise<LifecycleBlock> {
  const value = rpcObject(await lifecycleRpc(client, "eth_getBlockByNumber", [tag, false]), "block");
  const hash = rpcHex(value.hash, "block hash");
  if (hash.length !== 66) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Block hash must have 32 bytes");
  const block = {
    number: rpcQuantity(value.number, "block number"), hash,
    timestamp: rpcQuantity(value.timestamp, "block timestamp"), gasLimit: rpcQuantity(value.gasLimit, "block gas limit"),
    baseFeePerGas: value.baseFeePerGas === undefined || value.baseFeePerGas === null ? undefined : rpcQuantity(value.baseFeePerGas, "base fee"),
  };
  if (client instanceof InvocationLifecycleClient) client.observeBlock(block, tag === "latest");
  return block;
}
export async function assertLifecycleBlock(client: LifecycleRpcClient, block: Pick<LifecycleBlock, "number" | "hash">): Promise<void> {
  if (client instanceof InvocationLifecycleClient) return;
  const current = await readLifecycleBlock(client, toHex(block.number));
  if (current.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new LifecyclePlanningError("STATE_REORGED", "Pinned launch state changed during the operation; read canonical progress again");
  }
}
export async function readLifecycleContract<T>(client: LifecycleRpcClient, to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: LifecycleBlock, from?: Address, staticRead = false, independent = false): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args });
  const request = [{ to, from, data }, toHex(block.number)];
  const getter = abi.some((item) => item.type === "function" && item.name === functionName && (item.stateMutability === "view" || item.stateMutability === "pure"));
  const result = rpcHex(await (independent
    ? lifecycleIndependentRpc(client, request, block, staticRead)
    : getter
      ? staticRead ? lifecycleStaticRpc(client, "eth_call", request, block) : lifecyclePinnedRpc(client, "eth_call", request, block)
      : lifecycleRpc(client, "eth_call", request)), functionName);
  // ABI decoding validates scalar widths and tuple layout; T names that exact frozen ABI result.
  const decoded = decodeFunctionResult({ abi, functionName, data: result }) as T;
  return decoded;
}

/** Certification/configuration getters, explicitly selected by their SDK callsite. */
export function readLifecycleStaticContract<T>(client: LifecycleRpcClient, to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: LifecycleBlock, from?: Address): Promise<T> {
  return readLifecycleContract<T>(client, to, abi, functionName, args, block, from, true);
}

/** A reviewed registry must supply topology; missing selectors never certify a profile. */
export async function readLifecycleProfileTopology(client: LifecycleRpcClient, registry: Address, profileId: Hex, block: LifecycleBlock): Promise<ProfileTopologyV1> {
  const topology = await readLifecycleStaticContract<{ hookTopology: number; configVersion: number; hookDeployer: Address; hookCreationCodeHash: Hex }>(client, registry, lifecycleRegistryAbi, "profileTopology", [profileId], block);
  if (topology.hookTopology !== 0 && topology.hookTopology !== 1 && topology.hookTopology !== 2) throw new LifecyclePlanningError("INVALID_RPC_RESPONSE", "Registry returned an unsupported hook topology");
  return { ...topology, hookTopology: topology.hookTopology };
}
export const nitroGasInfo = "0x000000000000000000000000000000000000006c";
export const nitroGasInfoAbi = parseAbi([
  // Transaction ceilings are release preset metadata, not guard-only getter reads.
  "function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);
export type LifecycleNitroPrices = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
const maxUint64 = (1n << 64n) - 1n;

/** Seeded by the explicitly pinned planning aggregate. */
export function readNitroPrices(client: LifecycleRpcClient, block: LifecycleBlock): Promise<LifecycleNitroPrices> {
  return readLifecycleContract(client, nitroGasInfo, nitroGasInfoAbi, "getPricesInWei", [], block, undefined, true, true);
}

/** EOA legacy/1559 serialization and Nitro's Brotli allocation bound, not a
 * per-transaction oracle quote. Wallet-added access/auth lists and AA wrappers
 * need their own wallet envelope; they are outside the direct-EOA profile. */
export function nitroPosterGasBound(transaction: Pick<LifecycleTransaction, "data">, prices: LifecycleNitroPrices): { posterGas: bigint; feeBound: bigint } {
  const serializedBytes = BigInt((transaction.data.length - 2) / 2) + 384n;
  const compressedBytes = serializedBytes + 8n * (serializedBytes / 1024n) + 64n;
  const feeBound = compressedBytes * prices[1];
  if (feeBound === 0n) return { posterGas: 0n, feeBound };
  if (prices[5] === 0n) throw new LifecyclePlanningError("NITRO_PRICES_UNAVAILABLE", "Positive poster fees cannot be converted at a zero L2 gas price");
  return { posterGas: 2n * ((feeBound + prices[5] - 1n) / prices[5]), feeBound };
}


export type LifecycleLimitObservation = {
  limits: ResolvedLifecycleLimits;
  configuration: LifecycleLimits;
  assertCurrent: () => void;
};

/** Reuse only SDK-owned, pinned observations inside the still-open invocation.
 * Caller-supplied policies remain checked for mutation on every consumption. */
export function resolveLifecycleLimits(context: LifecycleLimitContext, source?: LifecycleLimitSource): Promise<LifecycleLimitObservation> {
  return context.client instanceof InvocationLifecycleClient
    ? context.client.observeLimits(context, source)
    : resolveLifecycleLimitsFresh(context, source);
}

async function resolveLifecycleLimitsFresh(context: LifecycleLimitContext, source?: LifecycleLimitSource): Promise<LifecycleLimitObservation> {
  let configuration: LifecycleLimits;
  const policyContext = typeof source === "function" && context.client instanceof InvocationLifecycleClient ? { ...context, client: context.client.source } : context;
  try { configuration = source === undefined ? {} : typeof source === "function" ? await source(policyContext) : source; }
  catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;
    throw new LifecyclePlanningError("LIMIT_SOURCE_FAILED", `Supplied execution policy could not be resolved: ${lifecycleFailureReason(failure)}`);
  }
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) throw new LifecyclePlanningError("INVALID_LIMITS", "Supplied execution policy must be an object");
  const suppliedConfiguration = configuration;
  configuration = Object.freeze({ ...configuration });
  const configurationKeys = Object.keys(configuration) as (keyof LifecycleLimits)[];
  const assertCurrent = () => {
    if (Object.keys(suppliedConfiguration).length !== configurationKeys.length || configurationKeys.some((key) => suppliedConfiguration[key] !== configuration[key])) {
      throw new LifecyclePlanningError("LIMIT_CONTEXT_MISMATCH", "Supplied execution policy changed after its pinned observation");
    }
  };
  const headroomBps = configuration.headroomBps === undefined ? 1500 : configuration.headroomBps;
  if (!Number.isSafeInteger(headroomBps) || headroomBps < 0 || headroomBps > 10000) throw new LifecyclePlanningError("INVALID_LIMITS", "Headroom must be between zero and 10000 basis points");
  for (const limit of [context.block.gasLimit, configuration.chainGasLimit, configuration.rpcGasLimit, configuration.accountGasLimit]) {
    if (limit !== undefined && (typeof limit !== "bigint" || limit <= 0n || limit > maxUint64)) throw new LifecyclePlanningError("INVALID_LIMITS", "Gas caps must be positive exact uint64 bigint values");
  }
  if (configuration.maxCalldataBytes !== undefined && (!Number.isSafeInteger(configuration.maxCalldataBytes) || configuration.maxCalldataBytes <= 0)) throw new LifecyclePlanningError("INVALID_LIMITS", "Calldata cap must be a positive byte count");
  if (configuration.estimateDataFee !== undefined && typeof configuration.estimateDataFee !== "function") throw new LifecyclePlanningError("INVALID_LIMITS", "External data-fee estimator must be a function");
  if (configuration.chainId !== undefined && (typeof configuration.chainId !== "bigint" || configuration.chainId !== context.chainId) ||
    configuration.observedBlockNumber !== undefined && (typeof configuration.observedBlockNumber !== "bigint" || configuration.observedBlockNumber !== context.block.number) ||
    configuration.observedBlockHash !== undefined && (typeof configuration.observedBlockHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(configuration.observedBlockHash) || configuration.observedBlockHash.toLowerCase() !== context.block.hash.toLowerCase()) ||
    configuration.account !== undefined && (typeof configuration.account !== "string" || !isAddress(configuration.account) || configuration.account.toLowerCase() !== context.account.toLowerCase()) ||
    configuration.orchestrator !== undefined && (typeof configuration.orchestrator !== "string" || !isAddress(configuration.orchestrator) || configuration.orchestrator.toLowerCase() !== context.orchestrator.toLowerCase())) {
    throw new LifecyclePlanningError("LIMIT_CONTEXT_MISMATCH", "Supplied execution policy provenance differs from the canonical chain/account/core/block context");
  }
  const protocol = context.chainId === 4663n ? "nitro" : "evm";
  if (protocol === "nitro" && configuration.estimateDataFee !== undefined) throw new LifecyclePlanningError("INVALID_LIMITS", "Nitro poster fees are already included in gas; an external data-fee estimator would double-charge them");
  const envelopeCaps = [configuration.chainGasLimit, configuration.rpcGasLimit, configuration.accountGasLimit].filter((limit): limit is bigint => limit !== undefined);
  if (protocol === "evm") envelopeCaps.push(context.block.gasLimit);
  const transactionGasCeiling = envelopeCaps.length === 0 ? undefined : envelopeCaps.reduce((minimum, limit) => limit < minimum ? limit : minimum);
  const executionGasCeiling = protocol === "nitro" ? ROBINHOOD_NATIVE_TRANSACTION_GAS_LIMIT : transactionGasCeiling ?? context.block.gasLimit;
  const unknownExecutionConstraints = [
    ...(protocol === "evm" && configuration.chainGasLimit === undefined ? ["Independent chain per-transaction cap is unknown; the budget is bounded by the pinned header"] : []),
    ...(configuration.rpcGasLimit === undefined ? ["RPC transaction gas-envelope cap is unknown"] : []),
    ...(configuration.accountGasLimit === undefined ? ["Current account/wallet transaction gas-envelope cap is unknown"] : []),
    ...(configuration.maxCalldataBytes === undefined ? ["Applicable chain/account/RPC calldata byte cap is unknown"] : []),
  ];
  assertCurrent();
  return {
    configuration, assertCurrent,
    limits: Object.freeze({
      protocol, executionGasCeiling, transactionGasCeiling, headroomBps,
      maxCalldataBytes: configuration.maxCalldataBytes,
      blockGasLimit: context.block.gasLimit, chainGasLimit: configuration.chainGasLimit,
      rpcGasLimit: configuration.rpcGasLimit, accountGasLimit: configuration.accountGasLimit,
      unknownExecutionConstraints: Object.freeze(unknownExecutionConstraints),
      unknownConstraints: Object.freeze([...unknownExecutionConstraints, ...(protocol === "evm" && configuration.estimateDataFee === undefined ? ["External chain-specific data fee is unavailable"] : [])]),
    }),
  };
}
