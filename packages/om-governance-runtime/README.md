# OM Governance Runtime

Private Cloudflare Worker that enforces the OM OS observation lifecycle for wrapper-owned
Gatekeepers. Its core contract accepts any exact service, operation, resource, sub-resource scope,
and data classification; the first deployment adapter is the P3 Google Sheets read path. It is a
runtime enforcement component, not a source of organizational authority.

## Design authority and scope

- Implementation source: OM-Knowledge Candidate `OMOS-GOVDYN-ADR-001-20260828`,
  `07_GENERATED/OM-OS-Governance-Dynamics-v0.1/ARCHITECTURE.md`.
- Governing boundaries: OM OS project README and Phase 7.7 Execution Authorization Governance.
- This package is the executable **observation slice** of Governance Dynamics. It does not replace
  the full Provisional Execution Branch, side-effect simulation, execution authorization, or
  canonical OM OS contracts.
- Its observation permit is adapter-local. It is not a Phase 7.7 Execution Authorization, does not
  create Capability, Authority, or Permission, and cannot authorize writes or side effects.
- The source Candidate is non-Canonical. Runtime deployment and enablement remain disabled by
  default and require a separate P3 approval reference in deployment configuration.

The Google Sheets adapter uses this sequence:

1. prepare an exact-scope observation against the current nine-component governance state;
2. complete the discrete Cloudflare OS `ApprovalQueue` gate;
3. revalidate policy, state, deployment binding, authority, permission, and exact scope;
4. issue and immediately consume a short-lived, single-use observation permit;
5. perform the upstream read;
6. return outcome evidence without cell values and update the state conservatively.

`E`, `K`, `U`, `R`, `C`, `D`, `L`, `A`, and `X` are retained independently. Measurement
confidence is a separate vector. The caller cannot submit either vector, and model confidence is
never accepted as governance state. Successful observations do not expand authority, permission,
scope, or relax the mandatory human gate.

## OM System State view

`getOMSystemState()` exposes a private, read-only `subjectType: system-self` view over the current
Governance State Snapshot. It is self-observation plus state estimation, not consciousness or a
self-reported model belief. The view combines:

- the current `E`, `K`, `U`, `R`, `C`, `D`, `L`, `A`, and `X` vector;
- raw change from the immediate predecessor and a per-day rate only when the basis is at least five
  minutes; shorter windows are marked `insufficient-basis` instead of being over-extrapolated;
- separate Knowledge, Governance, Agent, Execution, and System Health views;
- the mandatory Human Gate and Authority ceiling as discrete controls rather than continuous state;
- measurement confidence, Evidence references, and explicit telemetry blind spots.

The view never grants Authority, Permission, scope, gate relaxation, or Execution Authorization.
Unobserved active-agent details, execution lifecycle counts, error rate, cost, and latency remain
`not-observed` or `null`; the Runtime does not infer them from missing telemetry. Observation outcomes
remain `unverified` until a separate verifier ingestion path exists.

The view labels the estimator `calibrated: false` and identifies its update basis as policy-initialized
state with conservative adjustments from unverified outcomes. Current and previous Snapshot content
hashes are recomputed, and the previous version must be the immediate predecessor before a delta is
reported.

The Worker has no public route. Its policy is deployment-managed through
`OM_GOVERNANCE_POLICY`; the deploy script binds the private Worker to the guarded connector.
The deploy generator derives the policy hash from canonicalized policy content; operators do not
enter it manually. The Runtime independently derives a SHA-256 deployment binding fingerprint from
the policy hash, service, operation, exact resource ID, exact sub-resource scope, and data class.
That fingerprint namespaces the Durable Object and is bound into every State, Preparation, and
Permit. The current adapter does not observe a live Google content version before authorization and
reports that blind spot in every preparation.

Runtime use also requires the `OM_GOVERNANCE_DEPLOYMENT_APPROVAL` secret. It is a bounded approval
manifest containing the approval ID, policy hash, deployment binding fingerprint, Cloudflare
account, Runtime and adapter Worker names, stage, validity window, and revocation state. A mismatch,
expiry, or revocation fails closed. The manifest is Cloudflare-secret-bound evidence supplied after
a Human Gate; it is not a substitute for an OM-Knowledge Canonical approval record.

The manifest also binds `artifactRevision` to the Runtime's compiled-in
`GOVERNANCE_ARTIFACT_REVISION`. Any code release that changes this revision fails closed against an
older deployment approval secret. A fresh artifact-bound Human Gate and secret update are required
before that release can be deployed; an older approval reference cannot authorize changed code.

Cloudflare `ApprovalQueue` currently returns no opaque signed approval record. The private service
binding therefore stamps a trusted connector attestation after the queue call returns. This is a
runtime trust boundary, not proof of an OM-Knowledge Canonical Human Gate record.

Preparation, request replay, gate replay, permit, purge-evidence, and quarantine records carry
`retentionExpiresAt` and a deadline-ordered retention index. A Durable Object alarm evaluates the secret-bound
`OM_GOVERNANCE_RETENTION_CONTROL` manifest before deletion. It verifies the approved retention
policy, policy and deployment fingerprints, account, Worker, stage, validity, revocation, legal
hold, and bounded batch size. Each alarm reads at most the approved batch plus one lookahead index
entry; the deletion limit therefore also bounds the scan. The manifest's retention approval ID must
exactly match the deployment-configured Human Gate reference. Active legal hold deletes nothing and
coalesces repeated rechecks into one held Evidence state. Eligible expired records are deleted in one
storage transaction with key hashes and success/failure Evidence. Malformed indexed records are moved
out of active prefixes into a bounded-retention quarantine without blocking other eligible deletions.
Repeated control and transaction failures are coalesced instead of creating unbounded failure records.
The governance state record is never a purge target. Deployment does not create or fill
the secret, so retention enablement remains a separate Human Gate.
