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

Cloudflare `ApprovalQueue` currently returns no opaque signed approval record. The private service
binding therefore stamps a trusted connector attestation after the queue call returns. This is a
runtime trust boundary, not proof of an OM-Knowledge Canonical Human Gate record.

Preparation, request replay, gate replay, permit, and purge-evidence records carry
`retentionExpiresAt`. A Durable Object alarm evaluates the secret-bound
`OM_GOVERNANCE_RETENTION_CONTROL` manifest before deletion. It verifies the approved retention
policy, policy and deployment fingerprints, account, Worker, stage, validity, revocation, legal
hold, and bounded batch size. The manifest's retention approval ID must exactly match the
deployment-configured Human Gate reference. Active legal hold deletes nothing and records held Evidence. Eligible
expired records are deleted in one storage transaction with key hashes and success/failure
Evidence; the governance state record is never a purge target. Deployment does not create or fill
the secret, so retention enablement remains a separate Human Gate.
