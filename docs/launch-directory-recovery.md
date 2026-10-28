# Launch-directory recovery for external lifecycle deployments

## Activation and listing are separate

A successful activation receipt and live markets do not by themselves prove that
`app.abyss.trading` lists a launch. SDK planning/admission, onchain activation,
API publication, directory indexing, routing and chart-provider coverage are
separate outcomes. A custom deployment graph needs a supported discovery and
publication integration; compatible-looking event signatures alone are not one.

The public SDK can read the existing directory endpoint without a wallet:

```ts
import { LaunchApiClient, LaunchApiError } from "@black-market/sdk";
import type { Address } from "viem";

const chainId = 4663;
const token: Address = "0x8FD3BE0D7D6970d95bfd2F5d954b7F8307d80123";
const api = new LaunchApiClient({ retries: 1 });
try {
  const result = await api.getLaunch(chainId, token);
  if (result.chainId !== chainId || result.item.chainId !== chainId
      || result.item.token.toLowerCase() !== token.toLowerCase()) {
    throw new Error("Directory returned another chain/token");
  }
  console.log({ directory: "returned", indexedBlock: result.indexedBlock,
    activation: result.item.transactionHash, canonicalStatus: result.item.canonicalStatus });
} catch (error) {
  if (!(error instanceof LaunchApiError)) throw error;
  // Keep the service's actual status/code; a 404 is not a failed activation,
  // and a 503, unsupported chain or transport failure is not a missing listing.
  console.log({ directory: "unresolved", status: error.status,
    code: error.code, message: error.message });
}
```

`getLaunch` issues only a GET to `/api/v1/launches/{token}?chainId={chainId}`.
Its response describes the directory, not independently verified chain state.
It retains additional API fields without claiming to fully model their schema.
A 404 does not prove an indexer delay, unsupported core, unsubmitted publication,
or nonexistence of the token. Investigate these independently. Do not publish
metadata, sign authorizations or redeploy as an automatic response.

For a supported graph with a retained upload session, recover publication with
that session and the **original activation transaction**, as described in
[the lifecycle guide](launch-lifecycle.md#publish-metadata).
Do not create a new token to repair a publication failure.

## Concrete motivating case (28 October 2026)

On Robinhood chain 4663, Grouper
`0x8FD3BE0D7D6970d95bfd2F5d954b7F8307d80123` was activated through an external,
modified staged lifecycle graph. Its core is
`0xA136491A7c47998Ba8821AE8DB34dA19EDA830c0`; activation block is `100207495`.
The custom graph supports the intended sixteen-market design and a separate
reserve vault; it is **not an unchanged canonical orchestrator**.

At the captured observation, the directory reported indexed block `100212754`,
but the token detail endpoint returned HTTP 404, `launch not found`. This rules
out only the narrow claim that the reported index height had not reached the
activation block. It does not prove the service had subscribed to this core's
events. The frontend's profile-publication support map also omitted this core;
that observation does not establish the private indexer's exact rejection path.

[Public token/explorer record](https://robinhoodchain.blockscout.com/address/0x8FD3BE0D7D6970d95bfd2F5d954b7F8307d80123).
These observations are a reproducible integration report, not a request to mark
the token official, bypass admission, or assume that a custom deployment is safe.

## Proposed maintainer-side recovery path (not implemented by this SDK PR)

The public SDK repository does not contain the hosted indexer/import service.
The following is an integration proposal for that service, **not a new live API**.
The SDK read method above does not import, list or endorse anything.

### 1. Explicit deployment review before discovery

Use a maintainer-reviewed deployment record keyed by `(chainId, orchestrator)`
with a deployment block, runtime code hash, ABI/event version, registry,
directory, lens and graph bindings. Version records at explicit block boundaries
where code can change, including proxy implementation/code-hash provenance.
Resolve values from canonical receipts and reads, not applicant-supplied claims.
Reject unknown/altered graphs until reviewed. Do not accept any contract merely
because it emits `LaunchActivated`, and do not repoint canonical presets globally.

A future read-only capabilities endpoint could disclose supported orchestrators
and review states, so an integration can check publication support **before**
spending launch gas. The URL/schema need maintainer agreement; this PR invents
neither a supported endpoint nor a success fallback for an absent one.

### 2. Bounded, idempotent replay/import of the original activation

Given a reviewed record and `(chainId, activationTransactionHash)`, the service
should independently:

- Verify chain, successful receipt, block number/hash and confirmation policy;
  validate the activation log emitter against the reviewed core and ABI.
- Cross-check launch ID, plan hash, token, creator and phase with the reviewed
  graph at that block. Derive the token from canonical evidence, not a ticker or
  an arbitrary token field in an import request.
- Reconcile the declared market/position counts and identities, custody, graph
  bindings and public-trading state. Bind market enrichment to its actual
  venue/factory/pool-manager identity; a V4 manager address alone is not a pool.
- Verify any creator metadata authorization under the correct chain/core domain.
  Activation provenance must not grant an unrelated applicant metadata rights.
  Missing metadata can remain visibly unavailable rather than being invented.
- Feed the result through the normal canonical launch materializer. Keep
  reorg/finality handling and idempotent deduplication by canonical event identity
  `(chainId, transactionHash, logIndex)`, with a chain/token uniqueness policy.
- Retain an explicit external/reviewed deployment provenance label; do not set
  `official=true` simply because an import is accepted. Routing, chart coverage
  and safety/admission decisions remain separate.

Bound replay ranges and work per request. Registration/replay administration
must be authenticated; public recovery requests, if provided, need rate limits,
quotas and deterministic status without triggering unbounded RPC scans.

### 3. Explain failures without suggesting a relaunch

Distinguish unsupported/unreviewed deployment, activation not canonical,
confirmation pending, reorged, metadata authorization missing, indexed and
rejected. A service outage must not be returned as an unsupported deployment.
Expose stable error codes and allow retry/resume of the same request without
new signing or spending. Do not promise elapsed-time recovery unless the
service has actually accepted that graph and scheduled its backfill.

### Suggested service acceptance tests

- Reviewed external activation imports exactly once and is discoverable by
  chain/token and list query, with external provenance preserved.
- Same event signature from an unreviewed or counterfeit core is refused.
- Wrong chain, reverted receipt, wrong emitter, plan/token/graph mismatch and
  unauthorized metadata are refused; no partial official entry is created.
- Sixteen markets are retained without truncation; wrong custody or mismatched
  market identities produce a specific failure rather than fabricated enrichment.
- Pending/reorged/replaced receipts cannot produce a permanent final listing;
  duplicate requests are idempotent and finality follows canonical blocks.
- Indexer/RPC failure, unknown graph and absent metadata produce different states.

Maintainer decision needed: which repository/service owns deployment review and
backfill, and whether an existing supported import path can be documented instead.
