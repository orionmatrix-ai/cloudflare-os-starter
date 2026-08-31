# OAO Knowledge Snapshot — synthetic pilot Candidate

## v0.2 implementation status and operating boundary

The current change adds an **Implemented / locally Tested Candidate** for an
administrator-operated synthetic read in the existing OAO Workshop. It is not
live connection, successful hosted CI, Production operation or automatic
Canonical promotion evidence. The v0.1 record below is historical; the following
section describes the additional implementation and its remaining limitations.

The human authorized an initial experiment using one synthetic document only,
with no real Vault text, synchronization or AI calls. The permitted body is the
literal `SYNTHETIC_CONTENT` in [pilot.ts](./src/pilot.ts); relabeling another body
as synthetic, even with recomputed hashes, is rejected. No filesystem/export
path is present. Other Workshop capabilities are preserved, not disabled globally.

### Trust and data path

```text
Authenticated Workshop management API (account ownership + server isAdmin)
  -> GatekeeperVendor private service binding (fixed Workshop caller props)
  -> own Account -> 60-second admin management UI capability
  -> manual read with displayed approval hash
  -> administrator-provisioned exact approval + durable single reservation
  -> OaoKnowledgeSession revalidation -> private MCP loopback binding
  -> transient browser result + bounded body-free durable receipt
```

This uses the existing Gatekeeper management UI, **not** an AI agent singleton,
general work-package dispatcher or automatic Knowledge search. The synthetic
work-package ID is fixed in server-provisioned approval; this does not implement
generic OAO task ownership. `ApprovalQueue.authorizeObservation` is not used as
evidence of human approval: upstream it records sharing/observation, not that Gate.

Workshop checks account ownership and computes `isAdmin`; the iframe cannot set
them. Captured admin authority lasts at most 60 seconds, and reopening requires
another Workshop check. Account revocation and manifest/time/hash are rechecked
before every MCP transport request and result release. Role removal is **not** instant revocation
of an already issued 60-second capability. Environment updates likewise do not
guarantee immediate termination on older in-flight Worker versions.

[pilot-ledger.ts](./src/pilot-ledger.ts) permits **one attempt per deployed Worker
namespace**, across accounts, sessions and concurrent calls. Failure consumes it.
Replacing the grant or reopening the page does not reset it. There is no reset,
list, deletion, purge or automatic retry API. One attempt record contains opaque
IDs, hashes, timestamps and status; per-account objects may retain one revocation
boolean. No document body is persisted by this ledger. A crash may leave
`RESERVED`: hold for investigation, never infer permission to retry. `OBSERVED_COPY`
means MCP observation succeeded, not proof of UI delivery or live source accuracy.
This receipt is not yet integrated with OM Execution Event, Judgement Log or
System State. Retained records have no automatic deletion in this experiment.

### Deployment contract

The root generator accepts optional `knowledgeSnapshot.enabled=true` only with
`enablementApproved=true`, an opaque approval reference/deployment ID, a lowercase
40-character artifact revision and a unique private Worker name. It requires
`aiGateway.enabled=false` for this pilot; adding Knowledge does not remove the
Workshop's existing Workers AI binding or unrelated secret requirements. Existing
configurations without Knowledge are unchanged. Repository defaults are disabled.

The generated Worker has no public URL/routes, telemetry, AI binding or external
service binding. Workshop receives only `GATEKEEPER_KNOWLEDGE_SNAPSHOT`, targeting
`GatekeeperVendor` with its own name in trusted `callerId` props. Router is unchanged.
The same private Worker exports a named MCP entrypoint; the gateway uses a
Cloudflare loopback service binding. Test-only ledger configuration is not exported
by the production entrypoint. Browser RPC is bundled locally, with no CDN request.

In addition to the v0.1 snapshot and read grant, provision
`KNOWLEDGE_PILOT_APPROVAL_JSON` against [pilotApprovalSchema](./src/pilot.ts).
It binds approval ID, artifact, exact Worker names, deployment, task, document,
snapshot hash, expiry and maximumReads=1. This is trusted administrator-provisioned
configuration, **not a signature or cryptographic proof of human approval**.
Provisioning must reference the actual human authorization and verified artifact.
No secret values belong in Git, chat, screenshots or diagnostic output.

For the first live evaluation, verify exact CI/artifact and current Workshop
configuration, record the rollback version, deploy the new private Worker before
adding its Workshop binding, then set this vendor to **Optional**, not globally
auto-provisioned Enabled. The owner adds their account and opens its management
app. Verify the displayed scope before the single read. No source export, Google
read, AI call, retention deletion or other service enablement is included.
Do not use the root all-Workers deploy command for this two-Worker scoped change.

### Verification and recovery

[pilot.test.ts](./__tests__/pilot.test.ts) tests strict synthetic approval, real MCP
client/server transport, admin/revocation/time boundaries, durable SQLite quota,
parallel calls, failure terminality and receipt privacy. Local transport includes
binding stand-ins; successful live Workshop UI and cross-Worker provisioning must
be verified separately. The deployment tests verify legacy compatibility and exact
private binding generation. CI regenerates browser RPC before types/tests/bundling.

Local verification of this slice: 98 package tests, 49 deployment tests and 3 CI
invariant tests passed, along with package/script types, scoped lint and Worker
bundle dry-run. Independent read-only HARUSPEX review reproduced an initial P2:
account revocation after MCP initialize did not prevent a later tools/call. The
per-request binding revalidation fix closed it (independent reproduction changed
tools/call from 1 to 0). Re-review found no remaining P1/P2 in its scoped code
review and recommended adoption for the limited synthetic pilot. These statements
do not assert hosted CI success, live connectivity or recovery verification.

If setup or read fails, keep the pilot disabled/held, inspect body-free evidence
and do not automatically reset its one-attempt quota. Recovery starts by disabling
the vendor, removing the added Workshop binding or restoring the recorded Workshop
version, and disabling Knowledge flags. Preserve the ledger; no destructive rollback
is authorized by this runbook. Verify denied reads after rollback. Restoring code
does not undo already displayed copies or reset durable state.

## Historical v0.1 Candidate record

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
  Rejected redirect bodies and responses arriving after abort are cancelled before
  acquiring a reader. Cleanup rejection is suppressed and cleanup is not awaited,
  so stalled underlying cancellation cannot delay HOLD. Cancellation is requested,
  not a guarantee that a remote provider has finished releasing its resources.
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

Initial local verification, recorded in Candidate commit `4297282` (base `9f0d3b7`):
63 synthetic tests passed, 35 existing deployment-generator tests passed,
TypeScript check and scoped lint passed. Independent HARUSPEX review identified
two P2 issues (SDK subscription stream and redirect policy); both received local
fixes and negative tests. Independent re-review reproduced their closure and
recommended adoption as a local Candidate, with no remaining P1/P2 in that
review scope. It did not rerun the entire suite or approve live deployment.

PR #4's later independent review found a separate P2 cleanup defect: a late
response after timeout retained its reader lock, and a rejected 302 response
did not cancel its body. The follow-up fix rejects both before reader acquisition
and requests body cancellation without waiting for cleanup. Six new negative
tests cover immediate, rejected and pending cancellation for both paths; all six
failed on the prior implementation and passed after this fix. The updated suite
passed 69 synthetic tests, alongside 35 existing deployment-generator tests,
TypeScript and scoped lint. These checks are local evidence, not hosted CI or
live Cloudflare behavior. Independent re-review and the human merge decision
remain separate from this implementation record.

Worker bundle check, from this package directory (no upload):

```powershell
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .wrangler/dry-run
```

Windows sandbox permission prevented esbuild/workerd launch; targeted synthetic
tests and dry-run were rerun with permission adjustment. Dependency installation
used `--ignore-scripts`. Do not infer a full repository regression or successful
hosted CI from these commands. The initial Candidate did not include hosted CI.

### Continuous integration

[Knowledge Snapshot CI](../../.github/workflows/knowledge-snapshot-ci.yml) runs on
pull requests targeting `main`, pushes to `main`, and manual dispatch. It uses
an ephemeral Ubuntu runner, exact Node.js/pnpm versions, commit-pinned official
Actions, the committed submodule revision and a frozen lockfile. Each job has a
15-minute limit; superseded runs are cancelled. Dependencies are installed
without lifecycle scripts and no package cache is restored or saved.

The workflow checks its [safety invariants](../../scripts/knowledge-ci.test.ts),
Knowledge Snapshot types/lint/synthetic tests, existing deployment-generator
tests and a Worker bundle dry-run. The invariant tests are not a general YAML
validator or proof that an arbitrary workflow is safe. Hosted run status must
be verified for the exact commit; local success is not hosted CI evidence.

Permissions are `contents: read`, checkout credentials are not retained, and no
Cloudflare credential, real Knowledge copy, artifact upload, deployment, source
export or feature enablement is part of CI. Use separate deployment approval and
runtime revalidation; a green check never grants execution or Canonical authority.

References: [GitHub workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
and [pinning Actions](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).

Before live integration, there is no running Knowledge service to roll back.
Withdraw a merged change with a reviewed revert PR, without rewriting history.
After a future approved integration, first disable the feature/remove
the caller binding, restore the previously verified artifact/configuration and
verify denied reads. Revocation does not erase copies already read. Deleting
retained copy data or reverting Canonical content requires its own authority.
