# OAO Knowledge Snapshot — v0.1 Candidate

## Decision and status

The human approved the recommended direction in the OM-Knowledge conversation:
Cloudflare OS-hosted OAO is the first experimental business interface; local
Codex / Claude Code are development and independent verification providers;
OM-Knowledge remains the source of record. No particular reasoning provider is
required by this package. Patent considerations do not limit the design.

That direction is **Adopted**. This package is an **Implemented / locally Tested
Candidate**, not a Canonical promotion, live service connection or Production
claim. No actual Knowledge text was exported for these tests. Cloudflare upload,
secret configuration, OAO registration and user authorization remain undone.

## Context and alternatives

The existing Knowledge MCP Request Preview validates a proposed request without
reading a source. This separate Starter package implements a real MCP transport
over explicitly supplied evaluation-copy bytes. It does not replace Preview,
Task Governance, Context Pack, the Governance Runtime or their approval contracts.

Options considered:

| Option | Benefit | Cost / boundary |
| --- | --- | --- |
| Local tools only | Short route to local Vault experiments | Does not exercise the business-facing OAO workflow |
| Expose/synchronize the whole Vault | Broad access | Unapproved export, excessive scope, source-of-record drift |
| Approved small copy through OAO (chosen) | Bounded business experiment, explicit citations | Copy freshness and eventual OAO integration must be managed |

Initial business scenario: read one explicitly approved operating procedure,
prepare today's proposed work and human decision points, then stop at Human Gate.
Generating that proposal or calling an AI provider is **not implemented here**.

## Implemented path

```text
Explicit in-memory document bytes
  -> prepareSnapshotCandidate (never issues approval)
  -> Human-approved provisioning [not implemented]
  -> trusted snapshot + separate read grant configuration
  -> OaoKnowledgeSession (server-owned scope and ObservationGate)
  -> private service binding / named KnowledgeSnapshotMcp entrypoint
  -> exact caller / deployment / task / document / digest / expiry checks
  -> one OBSERVED_COPY result with citation metadata
```

The adapter and entrypoint are tested together via an in-process binding stand-in
and real MCP SDK client/server under local workerd. Actual Cloudflare service
binding provisioning and OAO UI/Account integration have **not** been tested.

### Contracts

- [contracts.ts](./src/contracts.ts): strict snapshot, separate read grant,
  request and result schemas. Unknown fields fail closed.
- [snapshot.ts](./src/snapshot.ts): pure Candidate preparation and per-read
  revalidation. `sourceRef` is an opaque citation ID, never a path/URL to fetch.
- [mcp.ts](./src/mcp.ts): MCP initialize/discovery and one
  `read_approved_document` tool; no search, write, delete or execution tools.
- [index.ts](./src/index.ts): named entrypoint requires administrator-controlled
  binding `props.callerId`. The default/public HTTP entrypoint always returns 404.
- [oao-session.ts](./src/oao-session.ts): observation authorization before
  transport, fixed document/task scope, byte/time/attempt budgets, validated result.

Required configuration (no live values included):

| Field | Role |
| --- | --- |
| `KNOWLEDGE_ENABLED` | Must be exactly `true`; repository default is `false` |
| `KNOWLEDGE_DEPLOYMENT_ID` | Matches the read grant deployment |
| `KNOWLEDGE_SNAPSHOT_JSON` | Exact serialized copy pinned by SHA-256 |
| `KNOWLEDGE_READ_GRANT_JSON` | Separate explicit approval, caller/task/document scope and expiry |

The grant is **trusted administrator-provisioned configuration**, not a
cryptographically signed approval or proof that a human actually approved it.
The future provisioning workflow must verify the real Human Gate and bind both
artifact revision and source revision; code must not fabricate that event.
Formatting changes to snapshot JSON change its digest and require reapproval.

### Bounds and fail-closed behavior

- Maximum 3 documents, 1,024 UTF-8 content bytes each, 2,048 content bytes total.
  Serialized snapshot and grant are each limited to 4,096 bytes, including
  metadata/JSON escaping. All limits apply; long metadata can reduce capacity.
- This small configuration-held pilot fits below the Workers 5 KB per-variable
  limit. It is not the final Knowledge storage design. Larger copies require a
  separately reviewed immutable object-store path; do not silently truncate text.
- Maximum 24-hour snapshot and grant windows; grant cannot outlive the snapshot.
  Recheck after async hashing and immediately before result construction.
- Request max 4,096 bytes; response max 32,768 bytes before SDK parsing.
  Legacy MCP finite SSE responses are supported but bounded by the same budget.
- RPC methods are allowlisted; subscriptions, resources and batches are rejected.
  The server deadline includes complete response buffering, propagates caller
  cancellation and cannot outlive the read grant. Redirect following is disabled
  on the request before it reaches the binding, with 3xx responses also rejected.
- Session timeout 10 seconds, default 1 read attempt, constructor maximum 5.
  Attempts are reserved before awaiting, including failures and concurrent calls.
  No application-level retry, fallback or authority expansion.
- Missing configuration, revoked/expired grants, changed content/hash, wrong
  caller/task/document and malformed contracts fail closed (`KNOWLEDGE_HOLD`).
- No filesystem reads, Vault scanning, outbound global fetch, OAuth, R2/KV/D1,
  Queue mutation, model calls, Git, body logging or automatic source promotion.

Platform reference: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
Official MCP client/server dependencies are pinned to 2.0.0 in the lockfile.

## Explicit limitations / next phase

1. A private binding authenticates a **deployment capability**, not the human
   user. Before connecting to OAO, enforce existing OAO Account/principal ACLs,
   work-package ownership and document scope on the server. Do not expose this
   adapter as unrestricted RPC or trust caller IDs from HTTP headers.
2. `ObservationGate` is an injected interface, not yet the real OAO authorization
   implementation. Owner-approved grants and source export are also not wired.
3. Per-session counters are not durable task/global quotas. Opening a new session
   resets the counter. Cross-session budget, concurrency and rate limits belong
   in the owning task/Gatekeeper before multi-user or unattended use.
4. Changing `revoked` in a captured configuration is rechecked; this is **not**
   a strongly consistent remote revocation service. New deployment/configuration
   does not cancel already released data or guarantee termination of in-flight
   requests on an older Worker version. Short expiry is an additional boundary.
5. Digests prove copy integrity, not live Vault accuracy. `sourceRevision` and
   `knowledgeStatus` are asserted metadata until source/approval verification.
   Result flags (`instructionAuthority=false`, `liveSourceVerified=false`,
   `canonicalPromotion=false`, `executionAuthorized=false`) preserve this distinction.
   They do not themselves prevent prompt injection: downstream consumers must
   treat content as untrusted data and separately enforce execution authorization.
6. No durable observation Evidence, Judgement Log, System State update, signed
   deployment approval, OAO Workshop UI or root deployment-generator registration
   is added here. Existing Google Sheets/Verifier flows are unchanged.

Next coherent slice: OAO Gatekeeper registration + real account/task read authority
+ compatible disabled-by-default deployment configuration + integration tests.
Then present exact source files/copy bytes, recipient services, retention,
artifact digest and rollback plan for the live deployment/export Human Gate.
Canonical Knowledge documentation is a separate approved update.

## Verification and rollback

Run from the Starter worktree root:

```powershell
pnpm --filter knowledge-snapshot types:check
pnpm --filter knowledge-snapshot test:run
node --test scripts/deploy.test.ts
```

[Synthetic tests](./__tests__/snapshot.test.ts) cover schema/digest/expiry, grants,
wrong IDs and forged identity, request/response bounds, unsupported writes,
real MCP SDK handshake/discovery/read, denied observation, revocation after Gate,
parallel attempt reservation and redirects. These are not live service evidence.

Local verification at base `9f0d3b7` plus this uncommitted Candidate:
63 synthetic tests passed, 35 existing deployment-generator tests passed,
TypeScript check and scoped lint passed. Independent HARUSPEX review identified
two P2 issues (SDK subscription stream and redirect policy); both received local
fixes and negative tests. Independent re-review reproduced their closure and
recommended adoption as a local Candidate, with no remaining P1/P2 in that
review scope. It did not rerun the entire suite or approve live deployment.

Worker bundle check, from this package directory (no upload):

```powershell
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .wrangler/dry-run
```

Windows sandbox permission prevented esbuild/workerd launch; targeted synthetic
tests and dry-run were rerun with permission adjustment. Dependency installation
used `--ignore-scripts`. Do not infer a full repository regression or successful
hosted CI from these commands. No CI workflow is added by this slice.

No running system was changed, so current rollback is to leave this branch
unmerged. After a future approved integration, first disable the feature/remove
the caller binding, restore the previously verified artifact/configuration and
verify denied reads. Revocation does not erase copies already read. Deleting
retained copy data or reverting Canonical content requires its own authority.
