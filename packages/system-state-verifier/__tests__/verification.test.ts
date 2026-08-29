import { describe, expect, it } from "vitest";
import type {
  OMSystemStateVerificationBundle,
  StateSnapshot,
  StateVector,
  VerifierApprovalManifest,
} from "om-governance-runtime";
import {
  SystemStateVerifierSessionImpl,
  expectedBindings,
  readAndVerifyState,
} from "../src/gatekeeper.js";
import {
  independentFingerprint,
  parseVerifierApprovalIndependent,
  verifySystemStateBundle,
} from "../src/verification.js";

const NOW = Date.parse("2026-08-29T03:00:00.000Z");
const DEPLOYMENT_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const VECTOR: StateVector = {
  E: 0.8,
  K: 0.8,
  U: 0.2,
  R: 0.2,
  C: 0.1,
  D: 0.1,
  L: 0.2,
  A: 0.1,
  X: 0.2,
};
const CONFIDENCE: StateVector = {
  E: 0.8,
  K: 0.8,
  U: 0.8,
  R: 0.8,
  C: 0.8,
  D: 0.8,
  L: 0.8,
  A: 0.8,
  X: 0.8,
};
const POLICY = {
  policyId: "om-p3-google-sheets-v1",
  deploymentApprovalReference: "human-gate:p3-runtime-evaluation",
  trustedCallerId: "google-sheets-guard",
  principalId: "principal:om-inc:p3-evaluator",
  capabilityId: "capability:google-sheets:range-read",
  authorityId: "authority:om-inc:p3-synthetic-read",
  permissionId: "permission:om-inc:p3-fixed-range",
  operation: "google.sheets.range.read",
  service: "google-sheets",
  dataClass: "synthetic",
  preparationTtlSeconds: 120,
  permitTtlSeconds: 30,
  recordRetentionSeconds: 86_400,
  mandatoryHumanGate: true as const,
  initialState: structuredClone(VECTOR),
  initialMeasurementConfidence: structuredClone(CONFIDENCE),
};
const POLICY_HASH = await independentFingerprint(POLICY);

function manifest(overrides: Partial<VerifierApprovalManifest> = {}): VerifierApprovalManifest {
  return {
    schemaVersion: "1.0",
    approvalId: "human-gate:p3-system-state-verifier",
    artifactRevision: "om-p3-governed-sheets-system-state-verifier-v1",
    policyHash: POLICY_HASH,
    deploymentBindingFingerprint: DEPLOYMENT_FINGERPRINT,
    accountId: "0123456789abcdef0123456789abcdef",
    runtimeWorkerName: "om-os-p3-governance-runtime",
    verifierWorkerName: "om-os-p3-system-state-verifier",
    routerWorkerName: "om-os-p2-router",
    stage: "p3-evaluation",
    callerId: "system-state-verifier",
    approvedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    revoked: false,
    ...overrides,
  };
}

function environment(approval = manifest()) {
  return {
    OM_GOVERNANCE_VERIFIER_APPROVAL: JSON.stringify(approval),
    OM_STATE_VERIFIER_FRESHNESS_SECONDS: "86400",
    OM_STATE_VERIFIER_APPROVAL_ID: approval.approvalId,
    OM_STATE_VERIFIER_ARTIFACT_REVISION: approval.artifactRevision,
    OM_STATE_VERIFIER_POLICY_HASH: approval.policyHash,
    OM_STATE_VERIFIER_ACCOUNT_ID: approval.accountId,
    OM_STATE_VERIFIER_RUNTIME_WORKER: approval.runtimeWorkerName,
    OM_STATE_VERIFIER_WORKER: approval.verifierWorkerName,
    OM_STATE_VERIFIER_ROUTER_WORKER: approval.routerWorkerName,
    OM_STATE_VERIFIER_STAGE: approval.stage,
    OM_STATE_VERIFIER_CALLER_ID: approval.callerId,
  };
}

async function snapshot(
  version = 0,
  updatedAt = new Date(NOW).toISOString(),
  components: StateVector = VECTOR,
): Promise<StateSnapshot> {
  const body = {
    snapshotId: `GSS-${version}`,
    version,
    updatedAt,
    components: structuredClone(components),
    measurementConfidence: structuredClone(CONFIDENCE),
    evidenceRefs: ["policy:om-p3-google-sheets-v1", "human-gate:p3-runtime-evaluation"],
    policyHash: POLICY_HASH,
    deploymentBindingFingerprint: DEPLOYMENT_FINGERPRINT,
  };
  return { ...body, contentHash: await independentFingerprint(body) };
}

async function bundle(): Promise<OMSystemStateVerificationBundle> {
  const current = await snapshot();
  const unavailable = {
    E: null, K: null, U: null, R: null, C: null, D: null, L: null, A: null, X: null,
  };
  return {
    schemaVersion: "1.0",
    generatedAt: new Date(NOW).toISOString(),
    requestId: "OMSVQ-request",
    policyHash: POLICY_HASH,
    policy: structuredClone(POLICY),
    deploymentBindingFingerprint: DEPLOYMENT_FINGERPRINT,
    current,
    previous: null,
    stateView: {
      schemaVersion: "1.0",
      subjectType: "system-self",
      epistemicStatus: "estimated",
      observedAt: current.updatedAt,
      baseSnapshot: {
        snapshotId: current.snapshotId,
        version: current.version,
        contentHash: current.contentHash,
        previousSnapshotId: null,
      },
      dynamics: {
        current: structuredClone(VECTOR),
        rawDelta: structuredClone(unavailable),
        ratePerDay: structuredClone(unavailable),
        rateBasisSeconds: null,
        rateAssessment: "insufficient-history",
        calibrated: false,
        updateBasis: "policy-initialized-and-unverified-outcome-adjusted",
        measurementConfidence: structuredClone(CONFIDENCE),
      },
      knowledgeState: {
        evidenceQuality: 0.8,
        knowledgeIntegrity: 0.8,
        uncertainty: 0.2,
        unresolvedConflictIndex: 0.1,
      },
      governanceState: {
        risk: 0.2,
        uncertainty: 0.2,
        policyConflict: 0.1,
        policyDrift: 0.1,
        authorityCeilingId: "authority:om-inc:p3-synthetic-read",
        humanGate: "mandatory",
        verificationIntensity: "standard",
        modelRoutingRequirement: "baseline-eligible",
      },
      agentState: {
        activityIndex: 0.1,
        configuredPrincipalId: "principal:om-inc:p3-evaluator",
        configuredCallerId: "google-sheets-guard",
        activeAgentTelemetry: "not-observed",
        modelSelfReportedConfidenceAccepted: false,
      },
      executionState: {
        exposureIndex: 0.2,
        configuredOperation: "google.sheets.range.read",
        configuredService: "google-sheets",
        lifecycleTelemetry: "not-observed",
      },
      systemHealth: {
        loadIndex: 0.2,
        driftIndex: 0.1,
        riskIndex: 0.2,
        minimumMeasurementConfidence: 0.8,
        errorRate: null,
        cost: null,
        processingLatencyMs: null,
      },
      evidence: {
        refs: [...current.evidenceRefs],
        verificationStatus: "unverified",
        sourceSnapshotHash: current.contentHash,
      },
      controlBoundaries: {
        authorityExpansionAllowed: false,
        permissionExpansionAllowed: false,
        scopeExpansionAllowed: false,
        automaticGateRelaxationAllowed: false,
        executionAuthorizationGenerated: false,
      },
      blindSpots: [
        "active agent identities and model selections are not observed by this runtime slice",
        "execution lifecycle counts are not yet aggregated",
        "error rate, cost, and processing latency telemetry are not yet ingested",
        "outcomes remain unverified until a separate verifier ingestion path is implemented",
      ],
    },
  };
}

describe("OM System State independent verifier", () => {
  it("accepts an exact, fresh bundle and returns only a redacted integrity report", async () => {
    const report = await verifySystemStateBundle(await bundle(), manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "report-1",
    });
    expect(report).toMatchObject({
      reportId: "OMSVR-report-1",
      status: "pass",
      snapshot: { id: "GSS-0", version: 0, ageSeconds: 0 },
      claims: {
        stateIntegrityVerified: true,
        externalOutcomeTruthVerified: false,
        authorityGranted: false,
        permissionGranted: false,
        executionAuthorized: false,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("evidenceRefs");
    expect(serialized).not.toContain("measurementConfidence");
    expect(serialized).not.toContain("principal:om-inc:p3-evaluator");
    expect(serialized).not.toContain("authority:om-inc:p3-synthetic-read");
  });

  it("independently validates a usable one-day state rate", async () => {
    const dynamic = await bundle();
    const previous = await snapshot(0, new Date(NOW - 86_400_000).toISOString());
    const currentComponents = { ...VECTOR, R: 0.3, D: 0.15 };
    const current = await snapshot(1, new Date(NOW).toISOString(), currentComponents);
    dynamic.previous = previous;
    dynamic.current = current;
    dynamic.stateView.observedAt = current.updatedAt;
    dynamic.stateView.baseSnapshot = {
      snapshotId: current.snapshotId,
      version: current.version,
      contentHash: current.contentHash,
      previousSnapshotId: previous.snapshotId,
    };
    dynamic.stateView.dynamics.current = structuredClone(currentComponents);
    dynamic.stateView.dynamics.rawDelta = {
      E: 0, K: 0, U: 0, R: 0.1, C: 0, D: 0.05, L: 0, A: 0, X: 0,
    };
    dynamic.stateView.dynamics.ratePerDay = structuredClone(
      dynamic.stateView.dynamics.rawDelta,
    );
    dynamic.stateView.dynamics.rateBasisSeconds = 86_400;
    dynamic.stateView.dynamics.rateAssessment = "usable";
    dynamic.stateView.governanceState.risk = 0.3;
    dynamic.stateView.governanceState.policyDrift = 0.15;
    dynamic.stateView.systemHealth.driftIndex = 0.15;
    dynamic.stateView.systemHealth.riskIndex = 0.3;
    dynamic.stateView.evidence.refs = [...current.evidenceRefs];
    dynamic.stateView.evidence.sourceSnapshotHash = current.contentHash;
    const report = await verifySystemStateBundle(dynamic, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "dynamic-rate",
    });
    expect(report.status).toBe("pass");
    expect(report.checks).toContainEqual({
      id: "view-projection",
      status: "pass",
      code: "VIEW_PROJECTION_MATCH",
    });
  });

  it("fails on current snapshot tampering", async () => {
    const altered = await bundle();
    altered.current.components.R = 0.9;
    const report = await verifySystemStateBundle(altered, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "tampered-current",
    });
    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "current-content-hash",
      status: "fail",
      code: "CURRENT_HASH_MISMATCH",
    });
    expect(report.claims.stateIntegrityVerified).toBe(false);
  });

  it("fails when Runtime-reported dynamics or routing do not match independent derivation", async () => {
    const altered = await bundle();
    altered.stateView.dynamics.rateAssessment = "usable";
    altered.stateView.governanceState.verificationIntensity = "critical";
    altered.stateView.governanceState.modelRoutingRequirement = "high-assurance-required";
    const report = await verifySystemStateBundle(altered, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "wrong-dynamics",
    });
    expect(report.checks).toContainEqual({
      id: "view-projection",
      status: "fail",
      code: "VIEW_PROJECTION_MISMATCH",
    });
  });

  it("fails when policy material no longer matches the approved policy hash", async () => {
    const altered = await bundle();
    altered.policy.authorityId = "authority:expanded";
    altered.stateView.governanceState.authorityCeilingId = "authority:expanded";
    const report = await verifySystemStateBundle(altered, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "wrong-policy",
    });
    expect(report.checks).toContainEqual({
      id: "policy-binding",
      status: "fail",
      code: "POLICY_BINDING_MISMATCH",
    });
  });

  it("fails on an invalid predecessor chain", async () => {
    const altered = await bundle();
    altered.current.version = 2;
    const currentBody = { ...altered.current };
    delete (currentBody as Partial<StateSnapshot>).contentHash;
    altered.current.contentHash = await independentFingerprint(currentBody);
    altered.stateView.baseSnapshot.version = 2;
    altered.stateView.baseSnapshot.contentHash = altered.current.contentHash;
    altered.stateView.evidence.sourceSnapshotHash = altered.current.contentHash;
    const report = await verifySystemStateBundle(altered, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "invalid-chain",
    });
    expect(report.checks).toContainEqual({
      id: "snapshot-adjacency",
      status: "fail",
      code: "SNAPSHOT_ADJACENCY_INVALID",
    });
  });

  it("returns inconclusive for a stale snapshot without granting any authority", async () => {
    const stale = await bundle();
    stale.current = await snapshot(0, new Date(NOW - 86_401_000).toISOString());
    stale.stateView.observedAt = stale.current.updatedAt;
    stale.stateView.baseSnapshot.contentHash = stale.current.contentHash;
    stale.stateView.evidence.sourceSnapshotHash = stale.current.contentHash;
    const report = await verifySystemStateBundle(stale, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "stale",
    });
    expect(report.status).toBe("inconclusive");
    expect(report.checks).toContainEqual({
      id: "freshness",
      status: "inconclusive",
      code: "SNAPSHOT_STALE",
    });
    expect(report.claims).toMatchObject({
      stateIntegrityVerified: false,
      authorityGranted: false,
      permissionGranted: false,
      executionAuthorized: false,
    });
  });

  it("fails closed when any control boundary is opened", async () => {
    const altered = await bundle();
    (altered.stateView.controlBoundaries as { authorityExpansionAllowed: boolean })
      .authorityExpansionAllowed = true;
    const report = await verifySystemStateBundle(altered, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
      id: () => "opened-boundary",
    });
    expect(report.checks).toContainEqual({
      id: "control-boundaries",
      status: "fail",
      code: "CONTROL_BOUNDARIES_OPEN",
    });
  });

  it("rejects unknown top-level fields rather than silently trusting them", async () => {
    await expect(verifySystemStateBundle({
      ...await bundle(),
      executionPermit: "unexpected",
    }, manifest(), {
      now: NOW,
      freshnessSeconds: 86_400,
    })).rejects.toThrow(/unknown or missing fields/);
  });

  it("independently rejects expired, revoked, or mismatched verifier approval", () => {
    const valid = manifest();
    const expected = expectedBindings(environment(valid));
    expect(parseVerifierApprovalIndependent(JSON.stringify(valid), expected, NOW)).toEqual(valid);
    expect(() => parseVerifierApprovalIndependent(JSON.stringify({
      ...valid,
      expiresAt: new Date(NOW - 1).toISOString(),
    }), expected, NOW)).toThrow(/validity window/);
    expect(() => parseVerifierApprovalIndependent(JSON.stringify({
      ...valid,
      revoked: true,
    }), expected, NOW)).toThrow(/revoked/);
    expect(() => parseVerifierApprovalIndependent(JSON.stringify({
      ...valid,
      routerWorkerName: "other-router",
    }), expected, NOW)).toThrow(/routerWorkerName binding mismatch/);
  });

  it("uses only the narrow read binding and binds the response to a fresh request", async () => {
    const env = environment();
    const fixture = await bundle();
    const requests: unknown[] = [];
    Object.assign(env, {
      OM_STATE_READ: {
        async getVerificationBundle(request: { requestId: string; requestedAt: string }) {
          requests.push(request);
          return { ...fixture, requestId: request.requestId };
        },
      },
    });
    const ids = ["request-id", "report-id"];
    const report = await readAndVerifyState(env, NOW, () => ids.shift()!);
    expect(requests).toEqual([{
      requestId: "OMSVQ-request-id",
      requestedAt: new Date(NOW).toISOString(),
    }]);
    expect(report).toMatchObject({ requestId: "OMSVQ-request-id", reportId: "OMSVR-report-id" });
  });

  it("requires approval before the private Runtime read", async () => {
    const order: string[] = [];
    const env = environment();
    const fixture = await bundle();
    Object.assign(env, {
      OM_STATE_READ: {
        async getVerificationBundle(request: { requestId: string }) {
          order.push("read");
          return { ...fixture, requestId: request.requestId };
        },
      },
    });
    const session = new SystemStateVerifierSessionImpl({
      async authorizeObservation() { order.push("approve"); },
    } as never, env);
    await session.getVerificationReport();
    expect(order).toEqual(["approve", "read"]);
  });

  it("has no fallback when the private read binding is absent", async () => {
    await expect(readAndVerifyState(environment(), NOW, () => "id"))
      .rejects.toThrow(/no fallback is permitted/);
  });
});
