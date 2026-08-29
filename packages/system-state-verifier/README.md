# OM System State Verifier

Private Cloudflare OS Gatekeeper that independently checks the integrity of the current OM System
State and returns a redacted, transient report through the existing Workshop.

## Boundary

- It reads only through `GovernanceStateReadService`; the broad Governance Runtime entrypoint is not
  bound to this Worker.
- Every report call first passes Cloudflare OS `ApprovalQueue.authorizeObservation()`.
- It has no actions, write methods, OAuth flow, resource configurator, R2, KV, D1, or retention store.
- It does not verify Google Sheets cell truth, promote an outcome to Verified Evidence, grant
  Capability, Authority, Permission, scope, or Execution Authorization, or relax a Human Gate.
- It does not persist reports. Existing Workshop or platform-level conversation/log retention is a
  separate operational boundary and is not changed by this package.

## Independent checks

The verifier parses `OM_GOVERNANCE_VERIFIER_APPROVAL` independently from the Runtime and binds it to
the artifact revision, policy hash, exact-resource deployment fingerprint, account, Runtime,
Verifier and Router Worker names, stage, caller binding ID, validity window, and revocation state.

For each approved read it independently recomputes:

- current and previous snapshot content hashes;
- approved policy fingerprint;
- immediate predecessor version, ID, and timestamp adjacency;
- all nine state-vector bounds;
- raw delta, rate basis, and per-day rate;
- risk index, minimum measurement confidence, verification intensity, and model-routing requirement;
- Knowledge, Governance, Agent, Execution, System Health, Evidence, and closed control projections.

The result contains only report metadata, check IDs/codes, snapshot ID/version/time/age, claims, and
blind spots. It does not return the state vector, measurement confidence, Evidence references,
principal, Authority ID, exact resource, or source bundle.

## Known limits

- Both snapshots originate from the Runtime. The verifier detects corruption and inconsistent
  derivation, not a malicious Runtime that forges a fully self-consistent bundle.
- Snapshot schema v1 does not include the previous content hash in the current snapshot. The
  verifier therefore checks adjacency rather than claiming a cryptographic hash chain.
- External observation truth is not independently re-observed.
- A report is fresh only when the snapshot age is within the deployment-configured range of
  60–86,400 seconds; the approved initial value is 86,400 seconds.

## Deployment gate

Deployment remains disabled unless `deployment.jsonc` explicitly sets `systemStateVerifier.enabled`
with a Worker name, separate Human Gate reference, freshness value, and
`verifierEnablementApproved: true`. Both Runtime and Verifier Workers require the same verifier
approval secret. No secret is generated, stored, or deployed by this package or by the deploy script.
