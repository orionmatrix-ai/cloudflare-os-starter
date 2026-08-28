import { beforeEach, describe, expect, it } from "vitest";
import type {
  GovernancePolicy,
  ObservationIntent,
  RetentionControlManifest,
  StateSnapshot,
  StateVector,
} from "../src/contracts.js";
import { GOVERNANCE_ARTIFACT_REVISION } from "../src/contracts.js";
import {
  GovernanceEngine,
  MemoryGovernanceStore,
  deploymentBindingFingerprint,
  deriveEnvelope,
  deriveStateRate,
  fingerprint,
  parseDeploymentApproval,
  parsePolicy,
  parseRetentionControl,
  policyFingerprintMaterial,
} from "../src/core.js";

const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const RANGE = "'P3_READONLY'!A1:D20";
const POLICY_HASH = `sha256:${"a".repeat(64)}`;
let ACTIVE_BINDING_FINGERPRINT = `sha256:${"0".repeat(64)}`;
const initialState: StateVector = {
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
const initialMeasurementConfidence: StateVector = {
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

class FaultingMemoryGovernanceStore extends MemoryGovernanceStore {
  failOnPrefix?: string;
  failDeleteOnPrefix?: string;

  override async put<T>(key: string, value: T): Promise<void> {
    if (this.failOnPrefix && key.startsWith(this.failOnPrefix)) {
      throw new Error(`injected storage failure: ${key}`);
    }
    await super.put(key, value);
  }

  override async delete(key: string): Promise<boolean> {
    if (this.failDeleteOnPrefix && key.startsWith(this.failDeleteOnPrefix)) {
      throw new Error(`injected delete failure: ${key}`);
    }
    return super.delete(key);
  }
}

class TrackingMemoryGovernanceStore extends MemoryGovernanceStore {
  readonly listLimits: Array<number | undefined> = [];

  override async list<T>(
    options: { prefix?: string; limit?: number } = {},
  ): Promise<Map<string, T>> {
    this.listLimits.push(options.limit);
    return super.list<T>(options);
  }
}

function policy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
  return {
    policyId: "om-p3-google-sheets-v1",
    policyHash: POLICY_HASH,
    deploymentApprovalReference: "human-gate:p3-runtime-evaluation",
    trustedCallerId: "google-sheets-guard",
    principalId: "principal:om-inc:p3-evaluator",
    capabilityId: "capability:google-sheets:range-read",
    authorityId: "authority:om-inc:p3-synthetic-read",
    permissionId: "permission:om-inc:p3-fixed-range",
    operation: "google.sheets.range.read",
    service: "google-sheets",
    resourceId: SPREADSHEET_ID,
    resourceScope: RANGE,
    dataClass: "synthetic",
    preparationTtlSeconds: 120,
    permitTtlSeconds: 30,
    recordRetentionSeconds: 86_400,
    mandatoryHumanGate: true,
    initialState,
    initialMeasurementConfidence,
    ...overrides,
  };
}

function intent(now: number, overrides: Partial<ObservationIntent> = {}): ObservationIntent {
  return {
    schemaVersion: "1.0",
    requestId: "request-1",
    principalId: "principal:om-inc:p3-evaluator",
    capabilityId: "capability:google-sheets:range-read",
    authorityId: "authority:om-inc:p3-synthetic-read",
    permissionId: "permission:om-inc:p3-fixed-range",
    operation: "google.sheets.range.read",
    deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    requestedAt: new Date(now).toISOString(),
    scope: {
      service: "google-sheets",
      resourceId: SPREADSHEET_ID,
      resourceScope: RANGE,
      dataClass: "synthetic",
    },
    evidenceRefs: ["deployment:om-p3", "guard:fixed-range"],
    ...overrides,
  };
}

function retentionControl(
  now: number,
  policyHash: string,
  overrides: Partial<RetentionControlManifest> = {},
): RetentionControlManifest {
  return {
    schemaVersion: "1.0",
    retentionApprovalId: "human-gate:retention-purge-v1",
    retentionPolicyId: "retention:om-p3:86400s",
    policyHash,
    deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    accountId: "0123456789abcdef0123456789abcdef",
    runtimeWorkerName: "om-cloudflare-os-governance",
    stage: "p3-evaluation",
    approvedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    revoked: false,
    legalHoldActive: false,
    legalHoldEvidenceRef: null,
    purgeBatchLimit: 100,
    legalHoldRecheckSeconds: 3_600,
    ...overrides,
  };
}

describe("OM Governance Runtime", () => {
  let now: number;
  let sequence: number;
  let store: MemoryGovernanceStore;
  let engine: GovernanceEngine;
  let activePolicyHash: string;

  beforeEach(async () => {
    now = Date.parse("2026-08-28T09:00:00.000Z");
    sequence = 0;
    store = new MemoryGovernanceStore();
    const activePolicy = policy();
    activePolicyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    activePolicy.policyHash = activePolicyHash;
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    engine = new GovernanceEngine(store, activePolicy, () => now, () => `id-${++sequence}`);
  });

  async function permitted(
    requestId = "request-1",
    gateEvidenceId = "cf-approval:request-1",
  ) {
    const preparation = await engine.prepareObservation(intent(now, { requestId }));
    now += 1_000;
    const permit = await engine.authorizeObservation({
      preparationId: preparation.preparationId,
      requestId: preparation.requestId,
      deploymentBindingFingerprint: preparation.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue",
        attestedBy: "google-sheets-guard",
        evidenceId: gateEvidenceId,
        approvedAt: new Date(now).toISOString(),
      },
    });
    return { preparation, permit };
  }

  it("parses all nine state components and keeps the gate mandatory", () => {
    const parsed = parsePolicy(JSON.stringify(policy()));
    expect(Object.keys(parsed.initialState)).toEqual(["E", "K", "U", "R", "C", "D", "L", "A", "X"]);
    expect(parsed.mandatoryHumanGate).toBe(true);
  });

  it("exposes an evidence-bound system-self view without inventing missing telemetry", async () => {
    const view = await engine.getOMSystemState();
    expect(view).toMatchObject({
      schemaVersion: "1.0",
      subjectType: "system-self",
      epistemicStatus: "estimated",
      baseSnapshot: {
        snapshotId: "GSS-0",
        version: 0,
        previousSnapshotId: null,
      },
      knowledgeState: {
        evidenceQuality: 0.8,
        knowledgeIntegrity: 0.8,
        uncertainty: 0.2,
        unresolvedConflictIndex: 0.1,
      },
      governanceState: {
        risk: 0.2,
        humanGate: "mandatory",
        authorityCeilingId: "authority:om-inc:p3-synthetic-read",
      },
      agentState: {
        activityIndex: 0.1,
        activeAgentTelemetry: "not-observed",
        modelSelfReportedConfidenceAccepted: false,
      },
      executionState: {
        exposureIndex: 0.2,
        lifecycleTelemetry: "not-observed",
      },
      systemHealth: {
        loadIndex: 0.2,
        errorRate: null,
        cost: null,
        processingLatencyMs: null,
      },
      evidence: { verificationStatus: "unverified" },
      controlBoundaries: {
        authorityExpansionAllowed: false,
        permissionExpansionAllowed: false,
        scopeExpansionAllowed: false,
        automaticGateRelaxationAllowed: false,
        executionAuthorizationGenerated: false,
      },
    });
    expect(Object.values(view.dynamics.rawDelta)).toEqual(Array(9).fill(null));
    expect(Object.values(view.dynamics.ratePerDay)).toEqual(Array(9).fill(null));
    expect(view.dynamics.rateBasisSeconds).toBeNull();
    expect(view.dynamics.rateAssessment).toBe("insufficient-history");
    expect(view.dynamics.calibrated).toBe(false);
    expect(view.blindSpots).toHaveLength(4);
  });

  it("reports a normalized state rate only when the observation basis is sufficient", () => {
    const previous = {
      updatedAt: new Date(now).toISOString(),
      components: initialState,
    } as StateSnapshot;
    const current = {
      updatedAt: new Date(now + 86_400_000).toISOString(),
      components: { ...initialState, R: 0.3, D: 0.15 },
    } as StateSnapshot;
    expect(deriveStateRate(current, previous)).toMatchObject({
      rawDelta: { R: 0.1, D: 0.05 },
      ratePerDay: { R: 0.1, D: 0.05 },
      rateBasisSeconds: 86_400,
      rateAssessment: "usable",
    });
  });

  it("binds deployment approval to policy, exact resource fingerprint, account, Workers, and stage", () => {
    const expected = {
      approvalId: "human-gate:p3-runtime-evaluation",
      artifactRevision: GOVERNANCE_ARTIFACT_REVISION,
      policyHash: activePolicyHash,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
      accountId: "0123456789abcdef0123456789abcdef",
      runtimeWorkerName: "om-cloudflare-os-governance",
      adapterWorkerName: "om-cloudflare-os-google-sheets",
      stage: "p3-evaluation",
    };
    const manifest = {
      schemaVersion: "1.1",
      ...expected,
      approvedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      revoked: false,
    };
    expect(parseDeploymentApproval(JSON.stringify(manifest), expected, now)).toEqual(manifest);
    expect(() => parseDeploymentApproval(JSON.stringify({
      ...manifest,
      deploymentBindingFingerprint: `sha256:${"f".repeat(64)}`,
    }), expected, now)).toThrow(/deploymentBindingFingerprint binding mismatch/);
    expect(() => parseDeploymentApproval(JSON.stringify({
      ...manifest,
      revoked: true,
    }), expected, now)).toThrow(/revoked/);
    expect(() => parseDeploymentApproval(JSON.stringify({
      ...manifest,
      artifactRevision: "older-artifact",
    }), expected, now)).toThrow(/artifactRevision binding mismatch/);
    expect(() => parseDeploymentApproval(JSON.stringify({
      ...manifest,
      schemaVersion: "1.0",
    }), expected, now)).toThrow(/schemaVersion is unsupported/);
  });

  it("binds retention control to policy, exact resource, account, Worker, stage, and legal hold", () => {
    const control = retentionControl(now, activePolicyHash);
    const expected = {
      retentionApprovalId: control.retentionApprovalId,
      policyHash: activePolicyHash,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
      accountId: control.accountId,
      runtimeWorkerName: control.runtimeWorkerName,
      stage: control.stage,
    };
    expect(parseRetentionControl(JSON.stringify(control), expected, now)).toEqual(control);
    expect(() => parseRetentionControl(JSON.stringify({
      ...control,
      legalHoldActive: true,
      legalHoldEvidenceRef: null,
    }), expected, now)).toThrow(/legalHoldEvidenceRef/);
    expect(() => parseRetentionControl(JSON.stringify({
      ...control,
      revoked: true,
    }), expected, now)).toThrow(/revoked/);
  });

  it("transactionally purges only expired retention records and records hashed-key Evidence", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    const stateBefore = await engine.getStateSnapshot();
    now += 86_400_001;
    const result = await engine.purgeExpiredRecords(retentionControl(now, activePolicyHash));
    expect(result.evidence).toMatchObject({ status: "succeeded", deletedRecordCount: 2 });
    expect(result.evidence.deletedRecordKeyHashes).toHaveLength(2);
    expect(result.evidence.deletedRecordKeyHashes.every((value) => value.startsWith("sha256:")))
      .toBe(true);
    expect(await store.get(`preparation:${preparation.preparationId}`)).toBeUndefined();
    expect(await store.get(`request:${preparation.requestId}`)).toBeUndefined();
    expect(await engine.getStateSnapshot()).toEqual(stateBefore);
    expect(await store.get(`purge-evidence:${result.evidence.purgeRunId}`)).toEqual(result.evidence);
  });

  it("deletes nothing under legal hold and records held Evidence", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    now += 86_400_001;
    const control = retentionControl(now, activePolicyHash, {
      legalHoldActive: true,
      legalHoldEvidenceRef: "legal-hold:case-2026-001",
    });
    const result = await engine.purgeExpiredRecords(control);
    expect(result.evidence).toMatchObject({
      status: "held",
      deletedRecordCount: 0,
      legalHoldEvidenceRef: "legal-hold:case-2026-001",
    });
    expect(await store.get(`preparation:${preparation.preparationId}`)).toBeDefined();
  });

  it("coalesces repeated legal-hold rechecks", async () => {
    await engine.prepareObservation(intent(now));
    const control = retentionControl(now, activePolicyHash, {
      legalHoldActive: true,
      legalHoldEvidenceRef: "legal-hold:case-2026-001",
    });
    await engine.purgeExpiredRecords(control);
    now += 3_600_000;
    await engine.purgeExpiredRecords({
      ...control,
      approvedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    });
    const holds = await store.list<Record<string, unknown>>({ prefix: "retention-legal-hold" });
    expect(holds.size).toBe(1);
    expect([...holds.values()][0]).toMatchObject({ status: "held", recheckCount: 2 });
  });

  it("quarantines a malformed indexed record without blocking other expired records", async () => {
    const { preparation } = await permitted();
    store.values.set("gate:cf-approval:request-1", { evidenceId: "malformed" });
    now += 86_400_001;
    const result = await engine.purgeExpiredRecords(retentionControl(now, activePolicyHash));
    expect(result.evidence).toMatchObject({
      status: "succeeded-with-quarantine",
      quarantinedRecordCount: 1,
    });
    expect(await store.get(`preparation:${preparation.preparationId}`)).toBeUndefined();
    expect(await store.get(`request:${preparation.requestId}`)).toBeUndefined();
    expect(await store.get("gate:cf-approval:request-1")).toBeUndefined();
    expect((await store.list({ prefix: "retention-quarantine:" })).size).toBe(1);
  });

  it("bounds each retention index scan to the approved batch plus lookahead", async () => {
    const trackingStore = new TrackingMemoryGovernanceStore();
    const activePolicy = policy();
    activePolicy.policyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    const isolated = new GovernanceEngine(trackingStore, activePolicy, () => now, () => `scan-${++sequence}`);
    await isolated.prepareObservation(intent(now));
    now += 86_400_001;
    const result = await isolated.purgeExpiredRecords(retentionControl(now, activePolicy.policyHash, {
      purgeBatchLimit: 1,
    }));
    expect(trackingStore.listLimits).toContain(2);
    expect(result.evidence.deletedRecordCount).toBeLessThanOrEqual(1);
    expect(Date.parse(result.nextAlarmAt)).toBe(now + 1_000);
  });

  it("sleeps until the earliest future expiry even when lookahead finds more indexes", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    const result = await engine.purgeExpiredRecords(retentionControl(now, activePolicyHash, {
      purgeBatchLimit: 1,
    }));
    expect(result.evidence.deletedRecordCount).toBe(0);
    expect(result.nextAlarmAt).toBe(preparation.retentionExpiresAt);
  });

  it("coalesces repeated invalid retention-control Evidence", async () => {
    await engine.recordRetentionControlFailure();
    now += 60_000;
    await engine.recordRetentionControlFailure();
    const failures = await store.list<Record<string, unknown>>({
      prefix: "retention-control-failure",
    });
    expect(failures.size).toBe(1);
    expect([...failures.values()][0]).toMatchObject({
      status: "failed",
      errorCode: "RETENTION_CONTROL_INVALID",
      failureCount: 2,
    });
  });

  it("rolls back every deletion when purge storage fails and records failure Evidence", async () => {
    const faultingStore = new FaultingMemoryGovernanceStore();
    const activePolicy = policy();
    activePolicy.policyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    const isolated = new GovernanceEngine(faultingStore, activePolicy, () => now, () => `purge-${++sequence}`);
    const preparation = await isolated.prepareObservation(intent(now));
    now += 86_400_001;
    faultingStore.failDeleteOnPrefix = "preparation:";
    const result = await isolated.purgeExpiredRecords(retentionControl(now, activePolicy.policyHash));
    expect(result.evidence).toMatchObject({
      status: "failed",
      deletedRecordCount: 0,
      errorCode: "PURGE_TRANSACTION_FAILED",
    });
    expect(await faultingStore.get(`preparation:${preparation.preparationId}`)).toBeDefined();
    expect(await faultingStore.get(`request:${preparation.requestId}`)).toBeDefined();
  });

  it("coalesces repeated purge transaction failures", async () => {
    const faultingStore = new FaultingMemoryGovernanceStore();
    const activePolicy = policy();
    activePolicy.policyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    const isolated = new GovernanceEngine(faultingStore, activePolicy, () => now, () => `failure-${++sequence}`);
    await isolated.prepareObservation(intent(now));
    now += 86_400_001;
    faultingStore.failDeleteOnPrefix = "preparation:";
    await isolated.purgeExpiredRecords(retentionControl(now, activePolicy.policyHash));
    now += 60_000;
    await isolated.purgeExpiredRecords(retentionControl(now, activePolicy.policyHash));
    const failures = await faultingStore.list<Record<string, unknown>>({
      prefix: "retention-purge-failure",
    });
    expect(failures.size).toBe(1);
    expect([...failures.values()][0]).toMatchObject({
      status: "failed",
      errorCode: "PURGE_TRANSACTION_FAILED",
      failureCount: 2,
    });
  });

  it("keeps the Runtime contract generic while the first adapter remains Google Sheets", () => {
    const generic = parsePolicy(JSON.stringify(policy({
      operation: "oao.document.observe",
      service: "oao-artifact-store",
      resourceId: "artifact-123",
      resourceScope: "section:approved-summary",
      dataClass: "internal",
    })));
    expect(generic).toMatchObject({
      operation: "oao.document.observe",
      service: "oao-artifact-store",
      resourceScope: "section:approved-summary",
      dataClass: "internal",
    });
  });

  it.each([
    ["missing state component", { ...initialState, X: undefined }],
    ["out-of-range state", { ...initialState, R: 1.1 }],
  ])("rejects %s", (_name, vector) => {
    expect(() => parsePolicy(JSON.stringify(policy({ initialState: vector as StateVector })))).toThrow();
  });

  it("rejects policies that make the discrete gate optional", () => {
    expect(() => parsePolicy(JSON.stringify({ ...policy(), mandatoryHumanGate: false }))).toThrow(
      /must remain true/,
    );
  });

  it("does not accept caller-provided state or model confidence", async () => {
    await expect(engine.prepareObservation({
      ...intent(now),
      modelConfidence: 0.99,
    } as ObservationIntent)).rejects.toThrow(/unknown or missing fields/);
  });

  it("prepares an exact-scope transition without granting permission", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    expect(preparation).toMatchObject({
      status: "human-gate-required",
      requestId: "request-1",
      policyHash: activePolicyHash,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
      stageAuthorizationCandidate: {
        simulationOnly: true,
        sideEffectsAllowed: false,
      },
      provisionalBranch: {
        baseSnapshotId: "GSS-0",
        isolated: true,
      },
      simulationAssertion: {
        method: "bounded-observation",
        assurance: "deployment-bound",
        calibrated: false,
      },
      envelope: {
        humanGateRequired: true,
        authorityExpansionAllowed: false,
        permissionExpansionAllowed: false,
        scopeExpansionAllowed: false,
        automaticGateRelaxationAllowed: false,
      },
    });
    expect(preparation.provisionalState).toEqual(initialState);
    expect(preparation.projectedGovernanceState).toEqual(initialState);
    expect(preparation).not.toHaveProperty("observationAllowed");
  });

  it.each([
    ["principal", { principalId: "principal:other" }],
    ["authority", { authorityId: "authority:other" }],
    ["permission", { permissionId: "permission:other" }],
    ["resource", { scope: {
      service: "google-sheets", resourceId: "other-resource", resourceScope: RANGE,
      dataClass: "synthetic",
    } }],
    ["range", { scope: {
      service: "google-sheets", resourceId: SPREADSHEET_ID, resourceScope: "'OTHER'!A1:A2",
      dataClass: "synthetic",
    } }],
  ])("fails closed on %s mismatch", async (_name, overrides) => {
    await expect(engine.prepareObservation(intent(now, overrides as Partial<ObservationIntent>)))
      .rejects.toThrow();
  });

  it("issues a short-lived non-transferable permit only after gate evidence", async () => {
    const { permit } = await permitted();
    expect(permit).toMatchObject({
      useLimit: 1,
      nonTransferable: true,
      observationAllowed: true,
      requestId: "request-1",
    });
    expect(Date.parse(permit.expiresAt) - Date.parse(permit.issuedAt)).toBe(30_000);
  });

  it("rejects untrusted gate evidence", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    await expect(engine.authorizeObservation({
      preparationId: preparation.preparationId,
      requestId: preparation.requestId,
      deploymentBindingFingerprint: preparation.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue",
        attestedBy: "google-sheets-guard",
        evidenceId: "",
        approvedAt: new Date(now).toISOString(),
      },
    })).rejects.toThrow(/evidenceId/);
  });

  it("claims each preparation and gate evidence exactly once", async () => {
    const preparation = await engine.prepareObservation(intent(now));
    const authorization = {
      preparationId: preparation.preparationId,
      requestId: preparation.requestId,
      deploymentBindingFingerprint: preparation.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue" as const,
        attestedBy: "google-sheets-guard" as const,
        evidenceId: "cf-approval:single-use",
        approvedAt: new Date(now).toISOString(),
      },
    };
    await engine.authorizeObservation(authorization);
    await expect(engine.authorizeObservation(authorization)).rejects.toThrow(/already claimed/);

    const second = await engine.prepareObservation(intent(now, { requestId: "request-2" }));
    await expect(engine.authorizeObservation({
      ...authorization,
      preparationId: second.preparationId,
      requestId: second.requestId,
      deploymentBindingFingerprint: second.deploymentBindingFingerprint,
    })).rejects.toThrow(/gate evidence was already claimed/);
  });

  it("rejects duplicate request IDs", async () => {
    await engine.prepareObservation(intent(now));
    await expect(engine.prepareObservation(intent(now))).rejects.toThrow(/requestId was already used/);
  });

  it("atomically rolls back gate claim and preparation claim when permit issuance storage fails", async () => {
    const faultingStore = new FaultingMemoryGovernanceStore();
    const activePolicy = policy();
    activePolicy.policyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    const isolated = new GovernanceEngine(faultingStore, activePolicy, () => now, () => `tx-${++sequence}`);
    const preparation = await isolated.prepareObservation(intent(now));
    const authorization = {
      preparationId: preparation.preparationId,
      requestId: preparation.requestId,
      deploymentBindingFingerprint: preparation.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue" as const,
        attestedBy: "google-sheets-guard",
        evidenceId: "cf-approval:transaction-rollback",
        approvedAt: new Date(now).toISOString(),
      },
    };
    faultingStore.failOnPrefix = "gate:";
    await expect(isolated.authorizeObservation(authorization)).rejects.toThrow(/injected storage failure/);
    faultingStore.failOnPrefix = undefined;
    await expect(isolated.authorizeObservation(authorization)).resolves.toMatchObject({
      requestId: preparation.requestId,
      observationAllowed: true,
    });
  });

  it("atomically rolls back outcome claim when state persistence fails", async () => {
    const faultingStore = new FaultingMemoryGovernanceStore();
    const activePolicy = policy();
    activePolicy.policyHash = await fingerprint(policyFingerprintMaterial(activePolicy));
    ACTIVE_BINDING_FINGERPRINT = await deploymentBindingFingerprint(activePolicy);
    const isolated = new GovernanceEngine(faultingStore, activePolicy, () => now, () => `outcome-${++sequence}`);
    const preparation = await isolated.prepareObservation(intent(now));
    const permit = await isolated.authorizeObservation({
      preparationId: preparation.preparationId,
      requestId: preparation.requestId,
      deploymentBindingFingerprint: preparation.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue",
        attestedBy: "google-sheets-guard",
        evidenceId: "cf-approval:outcome-transaction",
        approvedAt: new Date(now).toISOString(),
      },
    });
    await isolated.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    const outcome = {
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "failed" as const,
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified" as const,
      evidenceRefs: ["outcome:transaction-failure"],
      errorCode: "UPSTREAM_FAILURE",
    };
    faultingStore.failOnPrefix = "governance-state";
    await expect(isolated.recordObservationOutcome(outcome)).rejects.toThrow(/injected storage failure/);
    faultingStore.failOnPrefix = undefined;
    await expect(isolated.recordObservationOutcome(outcome)).resolves.toMatchObject({ version: 1 });
  });

  it("rejects a policy body that does not match its hash", async () => {
    const mismatched = policy();
    mismatched.policyHash = `sha256:${"0".repeat(64)}`;
    const invalid = new GovernanceEngine(new MemoryGovernanceStore(), mismatched, () => now);
    await expect(invalid.getStateSnapshot()).rejects.toThrow(/policy hash mismatch/);
  });

  it("fails closed when the exact resource changes under the same policy body hash", async () => {
    await engine.getStateSnapshot();
    const changedResourcePolicy = policy({
      policyHash: activePolicyHash,
      resourceScope: "'P3_READONLY'!A1:B2",
    });
    const changed = new GovernanceEngine(store, changedResourcePolicy, () => now);
    await expect(changed.getStateSnapshot()).rejects.toThrow(/deployment binding mismatch/);
  });

  it("invalidates preparation when governance state changes", async () => {
    const first = await permitted();
    await engine.consumeObservationPermit({
      permitId: first.permit.permitId,
      requestId: first.permit.requestId,
      operation: "google.sheets.range.read",
      scope: first.permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await engine.recordObservationOutcome({
      permitId: first.permit.permitId,
      requestId: first.permit.requestId,
      status: "failed",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified" as const,
      evidenceRefs: ["outcome:failure"],
      errorCode: "UPSTREAM_FAILURE",
    });
    const stale = await engine.prepareObservation(intent(now, { requestId: "request-stale" }));
    const staleRecord = store.values.get(`preparation:${stale.preparationId}`) as Record<string, unknown>;
    const state = await engine.getStateSnapshot();
    staleRecord.stateHash = `sha256:${"0".repeat(64)}`;
    store.values.set(`preparation:${stale.preparationId}`, staleRecord);
    expect(state.version).toBe(1);
    await expect(engine.authorizeObservation({
      preparationId: stale.preparationId,
      requestId: stale.requestId,
      deploymentBindingFingerprint: stale.deploymentBindingFingerprint,
      gate: {
        source: "cloudflare-approval-queue",
        attestedBy: "google-sheets-guard",
        evidenceId: "cf-approval:stale",
        approvedAt: new Date(now).toISOString(),
      },
    })).rejects.toThrow(/state drift/);
  });

  it("consumes a permit once and rejects replay", async () => {
    const { permit } = await permitted();
    const consumption = {
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read" as const,
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    };
    await expect(engine.consumeObservationPermit(consumption)).resolves.toEqual({
      allowed: true,
      permitId: permit.permitId,
    });
    await expect(engine.consumeObservationPermit(consumption)).rejects.toThrow(/already consumed/);
  });

  it("rejects drift immediately before execution", async () => {
    const { permit } = await permitted();
    await expect(engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: `sha256:${"f".repeat(64)}`,
    })).rejects.toThrow(/deployment binding drift/);
  });

  it("feeds a failed outcome back into state and lowers confidence", async () => {
    const { permit } = await permitted();
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    const next = await engine.recordObservationOutcome({
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "failed",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:google-503"],
      errorCode: "GOOGLE_503",
    });
    expect(next.version).toBe(1);
    expect(next.components).toMatchObject({ E: 0.75, K: 0.78, U: 0.3, R: 0.3, D: 0.15, X: 0.25 });
    expect(next.measurementConfidence.E).toBe(0.79);

    const view = await engine.getOMSystemState();
    expect(view.baseSnapshot.previousSnapshotId).toBe("GSS-0");
    expect(view.dynamics.rateBasisSeconds).toBe(1);
    expect(view.dynamics.rateAssessment).toBe("insufficient-basis");
    expect(Object.values(view.dynamics.ratePerDay)).toEqual(Array(9).fill(null));
    expect(view.dynamics.rawDelta).toMatchObject({
      E: -0.05,
      K: -0.02,
      U: 0.1,
      R: 0.1,
      D: 0.05,
      X: 0.05,
    });
    expect(view.governanceState).toMatchObject({
      risk: 0.3,
      verificationIntensity: "standard",
      humanGate: "mandatory",
    });
  });

  it("does not relax state on an unverified success", async () => {
    const { permit } = await permitted();
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    const next = await engine.recordObservationOutcome({
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "succeeded",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:read-complete"],
    });
    expect(next.components).toEqual(initialState);
    expect(next.measurementConfidence.E).toBe(0.79);
  });

  it("keeps only the immediate predecessor across consecutive transitions", async () => {
    const first = await permitted();
    await engine.consumeObservationPermit({
      permitId: first.permit.permitId,
      requestId: first.permit.requestId,
      operation: "google.sheets.range.read",
      scope: first.permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await engine.recordObservationOutcome({
      permitId: first.permit.permitId,
      requestId: first.permit.requestId,
      status: "succeeded",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:first"],
    });

    const second = await permitted("request-2", "cf-approval:request-2");
    await engine.consumeObservationPermit({
      permitId: second.permit.permitId,
      requestId: second.permit.requestId,
      operation: "google.sheets.range.read",
      scope: second.permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await engine.recordObservationOutcome({
      permitId: second.permit.permitId,
      requestId: second.permit.requestId,
      status: "succeeded",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:second"],
    });

    const view = await engine.getOMSystemState();
    expect(view.baseSnapshot).toMatchObject({
      snapshotId: "GSS-2",
      version: 2,
      previousSnapshotId: "GSS-1",
    });
  });

  it("rejects a previous state whose content no longer matches its hash", async () => {
    const { permit } = await permitted();
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await engine.recordObservationOutcome({
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "failed",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:integrity-test"],
      errorCode: "UPSTREAM_FAILURE",
    });
    const previous = structuredClone(
      store.values.get("governance-state-previous") as StateSnapshot,
    );
    previous.components.R = 0.9;
    store.values.set("governance-state-previous", previous);
    await expect(engine.getOMSystemState()).rejects.toThrow(/previous state content hash mismatch/);
  });

  it("keeps mandatory gates and authority ceilings after successful evidence", async () => {
    const { permit } = await permitted();
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    const next = await engine.recordObservationOutcome({
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "succeeded",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: ["outcome:successful-read"],
    });
    expect(deriveEnvelope(next, policy())).toMatchObject({
      humanGateRequired: true,
      authorityCeilingId: "authority:om-inc:p3-synthetic-read",
      authorityExpansionAllowed: false,
      automaticGateRelaxationAllowed: false,
    });
  });

  it("rejects inline claims of independent verification", async () => {
    const { permit } = await permitted();
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await expect(engine.recordObservationOutcome({
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "succeeded",
      observedAt: new Date(now).toISOString(),
      verificationStatus: "verified",
      evidenceRefs: ["caller:claimed-verification"],
    } as never)).rejects.toThrow(/separate verifier ingestion/);
  });

  it("requires permit consumption before outcome and accepts only one outcome", async () => {
    const { permit } = await permitted();
    const outcome = {
      permitId: permit.permitId,
      requestId: permit.requestId,
      status: "succeeded" as const,
      observedAt: new Date(now).toISOString(),
      verificationStatus: "unverified" as const,
      evidenceRefs: ["outcome:read-complete"],
    };
    await expect(engine.recordObservationOutcome(outcome)).rejects.toThrow(/before permit consumption/);
    await engine.consumeObservationPermit({
      permitId: permit.permitId,
      requestId: permit.requestId,
      operation: "google.sheets.range.read",
      scope: permit.scope,
      deploymentBindingFingerprint: ACTIVE_BINDING_FINGERPRINT,
    });
    await engine.recordObservationOutcome(outcome);
    await expect(engine.recordObservationOutcome(outcome)).rejects.toThrow(/already recorded/);
  });
});
