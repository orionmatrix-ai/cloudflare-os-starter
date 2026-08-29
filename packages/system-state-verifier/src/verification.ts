import type {
  OMSystemStateVerificationBundle,
  GovernancePolicyFingerprintMaterial,
  StateSnapshot,
  StateRateVector,
  StateVector,
  VerifierApprovalManifest,
} from "om-governance-runtime";
import type {
  OMSystemStateVerificationReport,
  VerificationCheckStatus,
} from "./types.js";

export type VerifierExpectedBindings = {
  approvalId: string;
  artifactRevision: string;
  policyHash: string;
  accountId: string;
  runtimeWorkerName: string;
  verifierWorkerName: string;
  routerWorkerName: string;
  stage: string;
  callerId: string;
};

type Check = OMSystemStateVerificationReport["checks"][number];
const STATE_KEYS = ["E", "K", "U", "R", "C", "D", "L", "A", "X"] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  assert(JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted()),
    `${name} has unknown or missing fields.`);
}

function nonempty(value: unknown, name: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be non-empty.`);
}

function time(value: unknown, name: string): number {
  nonempty(value, name);
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${name} must be an ISO timestamp.`);
  return parsed;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).toSorted().map(
      (key) => `${JSON.stringify(key)}:${stable(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function independentFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function snapshotMaterial(snapshot: StateSnapshot): Omit<StateSnapshot, "contentHash"> {
  const { contentHash: _contentHash, ...body } = snapshot;
  return body;
}

function vectorIsBounded(value: StateVector): boolean {
  return Object.keys(value).toSorted().join(",") === [...STATE_KEYS].toSorted().join(",") &&
    STATE_KEYS.every((key) => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1);
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function independentStateRate(
  current: StateSnapshot,
  previous: StateSnapshot | null,
): {
  rawDelta: StateRateVector;
  ratePerDay: StateRateVector;
  rateBasisSeconds: number | null;
  rateAssessment: "insufficient-history" | "insufficient-basis" | "usable";
} {
  const unavailable = Object.fromEntries(STATE_KEYS.map((key) => [key, null])) as StateRateVector;
  if (!previous) {
    return {
      rawDelta: unavailable,
      ratePerDay: unavailable,
      rateBasisSeconds: null,
      rateAssessment: "insufficient-history",
    };
  }
  const elapsedMilliseconds = Date.parse(current.updatedAt) - Date.parse(previous.updatedAt);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    return {
      rawDelta: unavailable,
      ratePerDay: unavailable,
      rateBasisSeconds: null,
      rateAssessment: "insufficient-basis",
    };
  }
  const rateBasisSeconds = elapsedMilliseconds / 1_000;
  const rawDelta = Object.fromEntries(STATE_KEYS.map((key) => [
    key,
    rounded(current.components[key] - previous.components[key]),
  ])) as StateRateVector;
  if (rateBasisSeconds < 300) {
    return {
      rawDelta,
      ratePerDay: unavailable,
      rateBasisSeconds: rounded(rateBasisSeconds),
      rateAssessment: "insufficient-basis",
    };
  }
  const ratePerDay = Object.fromEntries(STATE_KEYS.map((key) => [
    key,
    rounded((rawDelta[key] as number) * 86_400 / rateBasisSeconds),
  ])) as StateRateVector;
  return {
    rawDelta,
    ratePerDay,
    rateBasisSeconds: rounded(rateBasisSeconds),
    rateAssessment: "usable",
  };
}

function independentEnvelope(current: StateSnapshot): {
  riskIndex: number;
  minimumMeasurementConfidence: number;
  verificationIntensity: "standard" | "high" | "critical";
  modelRoutingRequirement: "baseline-eligible" | "high-assurance-required";
} {
  const { E, K, U, R, C, D, L, A, X } = current.components;
  const riskIndex = rounded(Math.max(1 - E, 1 - K, U, R, C, D, X, L * 0.5, A * 0.5));
  const minimumMeasurementConfidence = rounded(
    Math.min(...Object.values(current.measurementConfidence)),
  );
  const verificationIntensity = riskIndex >= 0.75 || minimumMeasurementConfidence < 0.4
    ? "critical"
    : riskIndex >= 0.5 || minimumMeasurementConfidence < 0.7
      ? "high"
      : "standard";
  return {
    riskIndex,
    minimumMeasurementConfidence,
    verificationIntensity,
    modelRoutingRequirement: verificationIntensity === "standard"
      ? "baseline-eligible"
      : "high-assurance-required",
  };
}

export function parseVerifierApprovalIndependent(
  raw: string | undefined,
  expected: VerifierExpectedBindings,
  now = Date.now(),
): VerifierApprovalManifest {
  nonempty(raw, "OM_GOVERNANCE_VERIFIER_APPROVAL");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OM_GOVERNANCE_VERIFIER_APPROVAL must be valid JSON.");
  }
  assert(isObject(value), "OM_GOVERNANCE_VERIFIER_APPROVAL must be an object.");
  exactKeys(value, [
    "schemaVersion", "approvalId", "artifactRevision", "policyHash",
    "deploymentBindingFingerprint", "accountId", "runtimeWorkerName", "verifierWorkerName",
    "routerWorkerName", "stage", "callerId", "approvedAt", "expiresAt", "revoked",
  ], "OM_GOVERNANCE_VERIFIER_APPROVAL");
  assert(value.schemaVersion === "1.0", "verifier approval schemaVersion is unsupported.");
  assert(/^sha256:[0-9a-f]{64}$/.test(String(value.policyHash)),
    "verifier approval policyHash is invalid.");
  assert(/^sha256:[0-9a-f]{64}$/.test(String(value.deploymentBindingFingerprint)),
    "verifier approval deploymentBindingFingerprint is invalid.");
  const approvedAt = time(value.approvedAt, "verifier approval.approvedAt");
  const expiresAt = time(value.expiresAt, "verifier approval.expiresAt");
  assert(approvedAt <= now + 5_000, "verifier approval is in the future.");
  assert(expiresAt >= now && expiresAt > approvedAt, "verifier approval validity window is invalid.");
  assert(value.revoked === false, "verifier approval is revoked.");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert(value[key] === expectedValue, `verifier approval ${key} binding mismatch.`);
  }
  return value as VerifierApprovalManifest;
}

function statusOf(checks: Check[]): VerificationCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "inconclusive")) return "inconclusive";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function resultCheck(id: string, passed: boolean, passCode: string, failCode: string): Check {
  return { id, status: passed ? "pass" : "fail", code: passed ? passCode : failCode };
}

function projectionMatches(bundle: OMSystemStateVerificationBundle): boolean {
  const current = bundle.current;
  const view = bundle.stateView;
  const policy: GovernancePolicyFingerprintMaterial = bundle.policy;
  const rate = independentStateRate(current, bundle.previous);
  const envelope = independentEnvelope(current);
  const { E, K, U, R, C, D, L, A, X } = current.components;
  return view.schemaVersion === "1.0" && view.subjectType === "system-self" &&
    view.epistemicStatus === "estimated" && view.observedAt === current.updatedAt &&
    view.baseSnapshot.snapshotId === current.snapshotId &&
    view.baseSnapshot.version === current.version &&
    view.baseSnapshot.contentHash === current.contentHash &&
    view.baseSnapshot.previousSnapshotId === (bundle.previous?.snapshotId ?? null) &&
    same(view.dynamics.current, current.components) &&
    same(view.dynamics.rawDelta, rate.rawDelta) &&
    same(view.dynamics.ratePerDay, rate.ratePerDay) &&
    view.dynamics.rateBasisSeconds === rate.rateBasisSeconds &&
    view.dynamics.rateAssessment === rate.rateAssessment &&
    same(view.dynamics.measurementConfidence, current.measurementConfidence) &&
    view.dynamics.calibrated === false &&
    view.dynamics.updateBasis === "policy-initialized-and-unverified-outcome-adjusted" &&
    view.knowledgeState.evidenceQuality === E && view.knowledgeState.knowledgeIntegrity === K &&
    view.knowledgeState.uncertainty === U && view.knowledgeState.unresolvedConflictIndex === C &&
    view.governanceState.risk === R && view.governanceState.uncertainty === U &&
    view.governanceState.policyConflict === C && view.governanceState.policyDrift === D &&
    view.governanceState.authorityCeilingId === policy.authorityId &&
    view.governanceState.humanGate === "mandatory" &&
    view.governanceState.verificationIntensity === envelope.verificationIntensity &&
    view.governanceState.modelRoutingRequirement === envelope.modelRoutingRequirement &&
    view.agentState.activityIndex === A && view.agentState.configuredPrincipalId === policy.principalId &&
    view.agentState.configuredCallerId === policy.trustedCallerId &&
    view.agentState.activeAgentTelemetry === "not-observed" &&
    view.agentState.modelSelfReportedConfidenceAccepted === false &&
    view.executionState.exposureIndex === X &&
    view.executionState.configuredOperation === policy.operation &&
    view.executionState.configuredService === policy.service &&
    view.executionState.lifecycleTelemetry === "not-observed" &&
    view.systemHealth.loadIndex === L &&
    view.systemHealth.driftIndex === D &&
    view.systemHealth.riskIndex === envelope.riskIndex &&
    view.systemHealth.minimumMeasurementConfidence === envelope.minimumMeasurementConfidence &&
    view.evidence.verificationStatus === "unverified" &&
    same(view.evidence.refs, current.evidenceRefs) &&
    view.evidence.sourceSnapshotHash === current.contentHash;
}

export async function verifySystemStateBundle(
  rawBundle: unknown,
  manifest: VerifierApprovalManifest,
  options: {
    now?: number;
    freshnessSeconds: number;
    id?: () => string;
  },
): Promise<OMSystemStateVerificationReport> {
  assert(isObject(rawBundle), "verification bundle must be an object.");
  exactKeys(rawBundle, [
    "schemaVersion", "generatedAt", "requestId", "policyHash", "policy",
    "deploymentBindingFingerprint", "current", "previous", "stateView",
  ], "verification bundle");
  assert(rawBundle.schemaVersion === "1.0", "verification bundle schemaVersion is unsupported.");
  nonempty(rawBundle.requestId, "verification bundle.requestId");
  const generatedAt = time(rawBundle.generatedAt, "verification bundle.generatedAt");
  assert(isObject(rawBundle.current), "verification bundle.current must be an object.");
  assert(isObject(rawBundle.policy), "verification bundle.policy must be an object.");
  assert(rawBundle.previous === null || isObject(rawBundle.previous),
    "verification bundle.previous must be an object or null.");
  assert(isObject(rawBundle.stateView), "verification bundle.stateView must be an object.");
  const bundle = rawBundle as unknown as OMSystemStateVerificationBundle;
  const now = options.now ?? Date.now();
  assert(Number.isSafeInteger(options.freshnessSeconds) && options.freshnessSeconds >= 60 &&
    options.freshnessSeconds <= 86_400, "freshnessSeconds must be 60..86400.");
  const observedAt = time(bundle.current.updatedAt, "current.updatedAt");
  const ageSeconds = Math.max(0, Math.floor((now - observedAt) / 1_000));

  const currentHash = await independentFingerprint(snapshotMaterial(bundle.current));
  const previousHash = bundle.previous
    ? await independentFingerprint(snapshotMaterial(bundle.previous))
    : null;
  const adjacencyMatches = bundle.previous === null
    ? bundle.current.version === 0 && bundle.stateView.baseSnapshot.previousSnapshotId === null
    : bundle.previous.version === bundle.current.version - 1 &&
      bundle.previous.snapshotId === bundle.stateView.baseSnapshot.previousSnapshotId &&
      Date.parse(bundle.previous.updatedAt) <= observedAt;
  const controls = bundle.stateView.controlBoundaries;
  const policyHash = await independentFingerprint(bundle.policy);
  const checks: Check[] = [
    resultCheck("bundle-generated-at", generatedAt <= now + 5_000,
      "BUNDLE_TIME_VALID", "BUNDLE_TIME_FUTURE"),
    resultCheck("policy-binding", policyHash === manifest.policyHash &&
      bundle.policyHash === manifest.policyHash &&
      bundle.current.policyHash === manifest.policyHash &&
      (bundle.previous === null || bundle.previous.policyHash === manifest.policyHash),
    "POLICY_BINDING_MATCH", "POLICY_BINDING_MISMATCH"),
    resultCheck("deployment-binding", bundle.deploymentBindingFingerprint ===
      manifest.deploymentBindingFingerprint && bundle.current.deploymentBindingFingerprint ===
      manifest.deploymentBindingFingerprint && (bundle.previous === null ||
      bundle.previous.deploymentBindingFingerprint === manifest.deploymentBindingFingerprint),
    "DEPLOYMENT_BINDING_MATCH", "DEPLOYMENT_BINDING_MISMATCH"),
    resultCheck("current-content-hash", currentHash === bundle.current.contentHash,
      "CURRENT_HASH_MATCH", "CURRENT_HASH_MISMATCH"),
    resultCheck("previous-content-hash", previousHash === null || previousHash === bundle.previous?.contentHash,
      "PREVIOUS_HASH_MATCH", "PREVIOUS_HASH_MISMATCH"),
    resultCheck("snapshot-adjacency", adjacencyMatches,
      "SNAPSHOT_ADJACENCY_VALID", "SNAPSHOT_ADJACENCY_INVALID"),
    resultCheck("state-bounds", vectorIsBounded(bundle.current.components) &&
      vectorIsBounded(bundle.current.measurementConfidence) && (bundle.previous === null ||
      vectorIsBounded(bundle.previous.components) && vectorIsBounded(bundle.previous.measurementConfidence)),
    "STATE_BOUNDS_VALID", "STATE_BOUNDS_INVALID"),
    resultCheck("view-projection", projectionMatches(bundle),
      "VIEW_PROJECTION_MATCH", "VIEW_PROJECTION_MISMATCH"),
    resultCheck("control-boundaries", controls.authorityExpansionAllowed === false &&
      controls.permissionExpansionAllowed === false && controls.scopeExpansionAllowed === false &&
      controls.automaticGateRelaxationAllowed === false &&
      controls.executionAuthorizationGenerated === false,
    "CONTROL_BOUNDARIES_CLOSED", "CONTROL_BOUNDARIES_OPEN"),
    {
      id: "freshness",
      status: observedAt > now + 5_000 ? "fail" :
        ageSeconds <= options.freshnessSeconds ? "pass" : "inconclusive",
      code: observedAt > now + 5_000 ? "SNAPSHOT_TIME_FUTURE" :
        ageSeconds <= options.freshnessSeconds ? "SNAPSHOT_FRESH" : "SNAPSHOT_STALE",
    },
    resultCheck("telemetry-disclosure", Array.isArray(bundle.stateView.blindSpots) &&
      bundle.stateView.blindSpots.length > 0 && bundle.stateView.systemHealth.errorRate === null &&
      bundle.stateView.systemHealth.cost === null &&
      bundle.stateView.systemHealth.processingLatencyMs === null,
    "BLIND_SPOTS_DISCLOSED", "BLIND_SPOTS_NOT_DISCLOSED"),
  ];
  const status = statusOf(checks);
  const createId = options.id ?? (() => crypto.randomUUID());
  return {
    schemaVersion: "1.0",
    reportId: `OMSVR-${createId()}`,
    requestId: bundle.requestId,
    verifiedAt: new Date(now).toISOString(),
    status,
    snapshot: {
      id: bundle.current.snapshotId,
      version: bundle.current.version,
      observedAt: bundle.current.updatedAt,
      ageSeconds,
    },
    checks,
    claims: {
      stateIntegrityVerified: status === "pass" || status === "warn",
      externalOutcomeTruthVerified: false,
      authorityGranted: false,
      permissionGranted: false,
      executionAuthorized: false,
    },
    blindSpots: [
      "external observation truth is not independently re-observed by this verifier",
      "the report does not promote unverified outcomes to verified evidence",
      "the report does not grant authority, permission, scope, or execution authorization",
      "the Runtime supplies both snapshots; self-consistent malicious Runtime output is not detected",
      "snapshots do not cryptographically bind current content to previous content; only adjacency is checked",
    ],
  };
}
