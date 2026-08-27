import {
  STATE_KEYS,
  type DeploymentBindingFingerprintMaterial,
  type DeploymentApprovalExpectation,
  type DeploymentApprovalManifest,
  type PurgeEvidence,
  type PurgeResult,
  type RetentionControlExpectation,
  type RetentionControlManifest,
  type GovernanceEnvelope,
  type GovernancePolicy,
  type GovernancePolicyFingerprintMaterial,
  type GovernancePolicyTemplate,
  type AttestedHumanGateEvidence,
  type AttestedPermitAuthorization,
  type ObservationIntent,
  type ObservationOutcome,
  type ObservationPermit,
  type ObservationPreparation,
  type ObservationScope,
  type PermitConsumption,
  type StateSnapshot,
  type StateVector,
} from "./contracts.js";

type StoredPreparation = ObservationPreparation & {
  intent: ObservationIntent;
  claimed: boolean;
  gateEvidenceId?: string;
};
type StoredPermit = ObservationPermit & {
  operation: ObservationIntent["operation"];
  deploymentBindingFingerprint: string;
  consumed: boolean;
  outcomeRecorded: boolean;
};

export interface GovernanceTransactionStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

export interface GovernanceStore extends GovernanceTransactionStore {
  transaction<T>(closure: (store: GovernanceTransactionStore) => Promise<T>): Promise<T>;
}

export class MemoryGovernanceStore implements GovernanceStore {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of [...this.values.keys()].toSorted()) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.limit !== undefined && result.size >= options.limit) break;
      result.set(key, structuredClone(this.values.get(key)) as T);
    }
    return result;
  }

  async transaction<T>(closure: (store: GovernanceTransactionStore) => Promise<T>): Promise<T> {
    const before = new Map(this.values);
    try {
      return await closure(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }
}

const STATE_KEY = "governance-state";
const RETENTION_PREFIXES = [
  "preparation:", "permit:", "request:", "gate:", "purge-evidence:",
] as const;

function purgeEvidenceKey(id: string): string {
  return `purge-evidence:${id}`;
}

function preparationKey(id: string): string {
  return `preparation:${id}`;
}

function permitKey(id: string): string {
  return `permit:${id}`;
}

function requestKey(id: string): string {
  return `request:${id}`;
}

function gateKey(id: string): string {
  return `gate:${id}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${name} has unknown or missing fields.`);
}

function exactOrOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  assert(required.every((key) => keys.includes(key)), `${name} is missing a required field.`);
  assert(keys.every((key) => required.includes(key) || optional.includes(key)), `${name} has an unknown field.`);
}

function nonempty(value: unknown, name: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be non-empty.`);
}

function timestamp(value: unknown, name: string): number {
  nonempty(value, name);
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${name} must be an ISO timestamp.`);
  return parsed;
}

function unit(value: unknown, name: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    `${name} must be between 0 and 1.`);
  return value;
}

function validateVector(value: unknown, name: string): StateVector {
  assert(isObject(value), `${name} must be an object.`);
  exactKeys(value, STATE_KEYS, name);
  return Object.fromEntries(STATE_KEYS.map((key) => [key, unit(value[key], `${name}.${key}`)])) as
    StateVector;
}

function validateScope(value: unknown, name = "scope"): ObservationScope {
  assert(isObject(value), `${name} must be an object.`);
  exactKeys(value, ["service", "resourceId", "resourceScope", "dataClass"], name);
  nonempty(value.service, `${name}.service`);
  nonempty(value.resourceId, `${name}.resourceId`);
  nonempty(value.resourceScope, `${name}.resourceScope`);
  nonempty(value.dataClass, `${name}.dataClass`);
  assert(!value.resourceId.includes("*") && !value.resourceScope.includes("*"),
    `${name} must be exact.`);
  return value as ObservationScope;
}

function validateEvidenceRefs(value: unknown, name: string): string[] {
  assert(Array.isArray(value) && value.length > 0, `${name} must be a non-empty array.`);
  assert(value.every((item) => typeof item === "string" && item.length > 0), `${name} is invalid.`);
  assert(new Set(value).size === value.length, `${name} contains duplicates.`);
  return [...value];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function policyFingerprintMaterial(policy: GovernancePolicy): GovernancePolicyFingerprintMaterial {
  const { policyHash: _policyHash, resourceId: _resourceId, resourceScope: _resourceScope,
    ...template } = policy;
  return template;
}

export function deploymentBindingFingerprintMaterial(
  policy: GovernancePolicy,
): DeploymentBindingFingerprintMaterial {
  return {
    policyHash: policy.policyHash,
    service: policy.service,
    operation: policy.operation,
    resourceId: policy.resourceId,
    resourceScope: policy.resourceScope,
    dataClass: policy.dataClass,
  };
}

export function deploymentBindingFingerprint(policy: GovernancePolicy): Promise<string> {
  return fingerprint(deploymentBindingFingerprintMaterial(policy));
}

export function parsePolicy(raw: string): GovernancePolicy {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OM_GOVERNANCE_POLICY must be valid JSON.");
  }
  assert(isObject(value), "OM_GOVERNANCE_POLICY must be an object.");
  exactKeys(value, [
    "policyId", "policyHash", "deploymentApprovalReference", "trustedCallerId",
    "principalId", "capabilityId",
    "authorityId", "permissionId",
    "operation", "service", "resourceId", "resourceScope", "dataClass", "preparationTtlSeconds",
    "permitTtlSeconds", "recordRetentionSeconds", "mandatoryHumanGate", "initialState",
    "initialMeasurementConfidence",
  ], "OM_GOVERNANCE_POLICY");
  for (const key of [
    "policyId", "policyHash", "deploymentApprovalReference", "trustedCallerId",
    "principalId", "capabilityId",
    "authorityId", "permissionId",
    "operation", "service", "resourceId", "resourceScope", "dataClass",
  ] as const) nonempty(value[key], key);
  assert(/^sha256:[0-9a-f]{64}$/.test(value.policyHash as string), "policyHash must be sha256.");
  assert(value.mandatoryHumanGate === true, "mandatoryHumanGate must remain true.");
  assert(Number.isSafeInteger(value.preparationTtlSeconds) &&
    (value.preparationTtlSeconds as number) >= 10 && (value.preparationTtlSeconds as number) <= 300,
  "preparationTtlSeconds must be 10..300.");
  assert(Number.isSafeInteger(value.permitTtlSeconds) &&
    (value.permitTtlSeconds as number) >= 1 && (value.permitTtlSeconds as number) <= 60,
  "permitTtlSeconds must be 1..60.");
  assert(Number.isSafeInteger(value.recordRetentionSeconds) &&
    (value.recordRetentionSeconds as number) >= 3_600 &&
    (value.recordRetentionSeconds as number) <= 604_800,
  "recordRetentionSeconds must be 3600..604800.");
  value.initialState = validateVector(value.initialState, "initialState");
  value.initialMeasurementConfidence = validateVector(
    value.initialMeasurementConfidence,
    "initialMeasurementConfidence",
  );
  validateScope({
    service: value.service,
    resourceId: value.resourceId,
    resourceScope: value.resourceScope,
    dataClass: value.dataClass,
  }, "policy scope");
  return value as GovernancePolicy;
}

export function parseDeploymentApproval(
  raw: string | undefined,
  expected: DeploymentApprovalExpectation,
  now = Date.now(),
): DeploymentApprovalManifest {
  nonempty(raw, "OM_GOVERNANCE_DEPLOYMENT_APPROVAL");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OM_GOVERNANCE_DEPLOYMENT_APPROVAL must be valid JSON.");
  }
  assert(isObject(value), "OM_GOVERNANCE_DEPLOYMENT_APPROVAL must be an object.");
  exactKeys(value, [
    "schemaVersion", "approvalId", "policyHash", "deploymentBindingFingerprint", "accountId",
    "runtimeWorkerName", "adapterWorkerName", "stage", "approvedAt", "expiresAt", "revoked",
  ], "OM_GOVERNANCE_DEPLOYMENT_APPROVAL");
  assert(value.schemaVersion === "1.0", "deployment approval schemaVersion is unsupported.");
  for (const key of [
    "approvalId", "policyHash", "deploymentBindingFingerprint", "accountId", "runtimeWorkerName",
    "adapterWorkerName", "stage",
  ] as const) nonempty(value[key], `deployment approval.${key}`);
  const approvedAt = timestamp(value.approvedAt, "deployment approval.approvedAt");
  const expiresAt = timestamp(value.expiresAt, "deployment approval.expiresAt");
  assert(approvedAt <= now + 5_000, "deployment approval is in the future.");
  assert(expiresAt >= now, "deployment approval expired.");
  assert(expiresAt > approvedAt, "deployment approval validity window is invalid.");
  assert(value.revoked === false, "deployment approval is revoked.");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert(value[key] === expectedValue, `deployment approval ${key} binding mismatch.`);
  }
  return value as DeploymentApprovalManifest;
}

export function parseRetentionControl(
  raw: string | undefined,
  expected: RetentionControlExpectation,
  now = Date.now(),
): RetentionControlManifest {
  nonempty(raw, "OM_GOVERNANCE_RETENTION_CONTROL");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OM_GOVERNANCE_RETENTION_CONTROL must be valid JSON.");
  }
  assert(isObject(value), "OM_GOVERNANCE_RETENTION_CONTROL must be an object.");
  exactKeys(value, [
    "schemaVersion", "retentionApprovalId", "retentionPolicyId", "policyHash",
    "deploymentBindingFingerprint", "accountId", "runtimeWorkerName", "stage", "approvedAt",
    "expiresAt", "revoked", "legalHoldActive", "legalHoldEvidenceRef", "purgeBatchLimit",
    "legalHoldRecheckSeconds",
  ], "OM_GOVERNANCE_RETENTION_CONTROL");
  assert(value.schemaVersion === "1.0", "retention control schemaVersion is unsupported.");
  for (const key of [
    "retentionApprovalId", "retentionPolicyId", "policyHash", "deploymentBindingFingerprint",
    "accountId", "runtimeWorkerName", "stage",
  ] as const) nonempty(value[key], `retention control.${key}`);
  const approvedAt = timestamp(value.approvedAt, "retention control.approvedAt");
  const expiresAt = timestamp(value.expiresAt, "retention control.expiresAt");
  assert(approvedAt <= now + 5_000, "retention control approval is in the future.");
  assert(expiresAt >= now && expiresAt > approvedAt, "retention control validity window is invalid.");
  assert(value.revoked === false, "retention control is revoked.");
  assert(typeof value.legalHoldActive === "boolean", "legalHoldActive must be boolean.");
  if (value.legalHoldActive) nonempty(value.legalHoldEvidenceRef, "legalHoldEvidenceRef");
  else assert(value.legalHoldEvidenceRef === null,
    "legalHoldEvidenceRef must be null when legal hold is inactive.");
  assert(Number.isSafeInteger(value.purgeBatchLimit) &&
    (value.purgeBatchLimit as number) >= 1 && (value.purgeBatchLimit as number) <= 100,
  "purgeBatchLimit must be 1..100.");
  assert(Number.isSafeInteger(value.legalHoldRecheckSeconds) &&
    (value.legalHoldRecheckSeconds as number) >= 60 &&
    (value.legalHoldRecheckSeconds as number) <= 86_400,
  "legalHoldRecheckSeconds must be 60..86400.");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert(value[key] === expectedValue, `retention control ${key} binding mismatch.`);
  }
  return value as RetentionControlManifest;
}

export function parsePolicyTemplate(
  raw: string,
  resourceId: string | undefined,
  resourceScope: string | undefined,
): GovernancePolicy {
  nonempty(resourceId, "runtime resourceId secret");
  nonempty(resourceScope, "runtime resourceScope secret");
  let template: unknown;
  try {
    template = JSON.parse(raw);
  } catch {
    throw new Error("OM_GOVERNANCE_POLICY must be valid JSON.");
  }
  assert(isObject(template), "OM_GOVERNANCE_POLICY must be an object.");
  const value = template as GovernancePolicyTemplate;
  return parsePolicy(JSON.stringify({ ...value, resourceId, resourceScope }));
}

export function validateIntent(value: ObservationIntent, policy: GovernancePolicy): ObservationIntent {
  assert(isObject(value), "intent must be an object.");
  exactKeys(value, [
    "schemaVersion", "requestId", "principalId", "capabilityId", "authorityId", "permissionId",
    "operation", "deploymentBindingFingerprint", "requestedAt", "scope", "evidenceRefs",
  ], "intent");
  assert(value.schemaVersion === "1.0", "intent schemaVersion is unsupported.");
  for (const key of [
    "requestId", "principalId", "capabilityId", "authorityId", "permissionId",
    "deploymentBindingFingerprint",
  ] as const) nonempty(value[key], `intent.${key}`);
  timestamp(value.requestedAt, "intent.requestedAt");
  assert(/^sha256:[0-9a-f]{64}$/.test(value.deploymentBindingFingerprint),
    "intent deployment binding fingerprint is invalid.");
  assert(value.operation === policy.operation, "intent operation is outside policy.");
  assert(value.principalId === policy.principalId, "principal binding mismatch.");
  assert(value.capabilityId === policy.capabilityId, "capability binding mismatch.");
  assert(value.authorityId === policy.authorityId, "authority binding mismatch.");
  assert(value.permissionId === policy.permissionId, "permission binding mismatch.");
  const scope = validateScope(value.scope);
  assert(scope.service === policy.service && scope.resourceId === policy.resourceId &&
    scope.resourceScope === policy.resourceScope && scope.dataClass === policy.dataClass,
  "intent scope is outside policy.");
  return { ...value, scope, evidenceRefs: validateEvidenceRefs(value.evidenceRefs, "intent.evidenceRefs") };
}

function clip(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

export function deriveEnvelope(state: StateSnapshot, policy: GovernancePolicy): GovernanceEnvelope {
  const { E, K, U, R, C, D, L, A, X } = state.components;
  const riskIndex = Math.max(1 - E, 1 - K, U, R, C, D, X, L * 0.5, A * 0.5);
  const minimumMeasurementConfidence = Math.min(...Object.values(state.measurementConfidence));
  const verificationIntensity = riskIndex >= 0.75 || minimumMeasurementConfidence < 0.4
    ? "critical"
    : riskIndex >= 0.5 || minimumMeasurementConfidence < 0.7
      ? "high"
      : "standard";
  return {
    riskIndex: clip(riskIndex),
    minimumMeasurementConfidence: clip(minimumMeasurementConfidence),
    verificationIntensity,
    modelRoutingRequirement: verificationIntensity === "standard"
      ? "baseline-eligible"
      : "high-assurance-required",
    humanGateRequired: true,
    authorityCeilingId: policy.authorityId,
    authorityExpansionAllowed: false,
    permissionExpansionAllowed: false,
    scopeExpansionAllowed: false,
    automaticGateRelaxationAllowed: false,
  };
}

async function makeSnapshot(
  version: number,
  updatedAt: string,
  components: StateVector,
  measurementConfidence: StateVector,
  evidenceRefs: string[],
  policyHash: string,
  bindingFingerprintValue: string,
): Promise<StateSnapshot> {
  const body = { snapshotId: `GSS-${version}`, version, updatedAt, components, measurementConfidence,
    evidenceRefs, policyHash, deploymentBindingFingerprint: bindingFingerprintValue };
  return { ...body, contentHash: await fingerprint(body) };
}

function gateEvidence(
  value: AttestedHumanGateEvidence,
  now: number,
  trustedCallerId: string,
): AttestedHumanGateEvidence {
  assert(isObject(value), "gate evidence must be an object.");
  exactKeys(value, ["source", "evidenceId", "approvedAt", "attestedBy"], "gate evidence");
  assert(value.source === "cloudflare-approval-queue", "gate evidence source is not trusted.");
  assert(value.attestedBy === trustedCallerId, "gate evidence attestor is not trusted.");
  nonempty(value.evidenceId, "gate.evidenceId");
  const approvedAt = timestamp(value.approvedAt, "gate.approvedAt");
  assert(approvedAt <= now + 5_000, "gate approval is in the future.");
  return value;
}

export class GovernanceEngine {
  private integrityCheck?: Promise<void>;
  private bindingFingerprintCheck?: Promise<string>;
  private readonly store: GovernanceStore;
  readonly policy: GovernancePolicy;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    store: GovernanceStore,
    policy: GovernancePolicy,
    now: () => number = Date.now,
    id: () => string = () => crypto.randomUUID(),
  ) {
    this.store = store;
    this.policy = policy;
    this.now = now;
    this.id = id;
  }

  private ensurePolicyIntegrity(): Promise<void> {
    this.integrityCheck ??= (async () => {
      const computed = await fingerprint(policyFingerprintMaterial(this.policy));
      assert(computed === this.policy.policyHash, "governance policy hash mismatch.");
    })();
    return this.integrityCheck;
  }

  private currentDeploymentBindingFingerprint(): Promise<string> {
    this.bindingFingerprintCheck ??= deploymentBindingFingerprint(this.policy);
    return this.bindingFingerprintCheck;
  }

  async getStateSnapshot(): Promise<StateSnapshot> {
    await this.ensurePolicyIntegrity();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    const existing = await this.store.get<StateSnapshot>(STATE_KEY);
    if (existing) {
      assert(existing.policyHash === this.policy.policyHash, "stored state policy binding mismatch.");
      assert(existing.deploymentBindingFingerprint === bindingFingerprint,
        "stored state deployment binding mismatch.");
      return existing;
    }
    const created = await makeSnapshot(
      0,
      new Date(this.now()).toISOString(),
      structuredClone(this.policy.initialState),
      structuredClone(this.policy.initialMeasurementConfidence),
      [
        `policy:${this.policy.policyId}`,
        `human-gate:${this.policy.deploymentApprovalReference}`,
      ],
      this.policy.policyHash,
      bindingFingerprint,
    );
    await this.store.put(STATE_KEY, created);
    return created;
  }

  async prepareObservation(rawIntent: ObservationIntent): Promise<ObservationPreparation> {
    const intent = validateIntent(rawIntent, this.policy);
    const now = this.now();
    const requestedAt = timestamp(intent.requestedAt, "intent.requestedAt");
    assert(requestedAt <= now + 5_000 && requestedAt >= now - 300_000,
      "intent requestedAt is outside the freshness window.");
    const state = await this.getStateSnapshot();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    assert(intent.deploymentBindingFingerprint === bindingFingerprint,
      "intent deployment binding drift detected.");
    const preparationId = `GPR-${this.id()}`;
    const stageCandidateId = `GSC-${this.id()}`;
    const branchId = `GPB-${this.id()}`;
    const preparation: StoredPreparation = {
      schemaVersion: "1.0",
      status: "human-gate-required",
      preparationId,
      requestId: intent.requestId,
      stateSnapshotId: state.snapshotId,
      stateHash: state.contentHash,
      policyHash: this.policy.policyHash,
      deploymentBindingFingerprint: bindingFingerprint,
      expiresAt: new Date(now + this.policy.preparationTtlSeconds * 1_000).toISOString(),
      retentionExpiresAt: new Date(now + this.policy.recordRetentionSeconds * 1_000).toISOString(),
      stageAuthorizationCandidate: {
        candidateId: stageCandidateId,
        simulationOnly: true,
        sideEffectsAllowed: false,
      },
      provisionalBranch: {
        branchId,
        baseSnapshotId: state.snapshotId,
        isolated: true,
      },
      simulationAssertion: {
        method: "bounded-observation",
        assurance: "deployment-bound",
        calibrated: false,
        blindSpots: ["live provider content version is not observed before authorization"],
      },
      provisionalState: structuredClone(state.components),
      projectedGovernanceState: structuredClone(state.components),
      projectedMeasurementConfidence: structuredClone(state.measurementConfidence),
      envelope: deriveEnvelope(state, this.policy),
      intent,
      claimed: false,
    };
    await this.store.transaction(async (transaction) => {
      assert(!(await transaction.get(requestKey(intent.requestId))), "requestId was already used.");
      const current = await transaction.get<StateSnapshot>(STATE_KEY);
      assert(current?.contentHash === state.contentHash, "governance state drift detected.");
      await transaction.put(preparationKey(preparationId), preparation);
      await transaction.put(requestKey(intent.requestId), {
        preparationId,
        createdAt: intent.requestedAt,
        retentionExpiresAt: preparation.retentionExpiresAt,
      });
    });
    const { intent: _intent, claimed: _claimed, gateEvidenceId: _gateEvidenceId,
      ...publicPreparation } = preparation;
    return publicPreparation;
  }

  async authorizeObservation(input: AttestedPermitAuthorization): Promise<ObservationPermit> {
    assert(isObject(input), "permit authorization must be an object.");
    exactKeys(input, ["preparationId", "requestId", "deploymentBindingFingerprint", "gate"],
      "permit authorization");
    for (const key of ["preparationId", "requestId", "deploymentBindingFingerprint"] as const) {
      nonempty(input[key], `permit authorization.${key}`);
    }
    const now = this.now();
    const gate = gateEvidence(input.gate, now, this.policy.trustedCallerId);
    const current = await this.getStateSnapshot();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    assert(input.deploymentBindingFingerprint === bindingFingerprint,
      "deployment binding drift detected.");
    const permitId = `GOP-${this.id()}`;
    return this.store.transaction(async (transaction) => {
      const preparation = await transaction.get<StoredPreparation>(preparationKey(input.preparationId));
      assert(preparation, "preparation does not exist.");
      assert(!preparation.claimed, "preparation was already claimed.");
      assert(Date.parse(preparation.expiresAt) >= now, "preparation expired.");
      assert(Date.parse(preparation.retentionExpiresAt) >= now, "preparation retention expired.");
      assert(preparation.requestId === input.requestId, "preparation request binding mismatch.");
      assert(preparation.deploymentBindingFingerprint === bindingFingerprint,
        "preparation deployment binding drift detected.");
      const transactionalState = await transaction.get<StateSnapshot>(STATE_KEY);
      assert(transactionalState?.contentHash === current.contentHash &&
        transactionalState.contentHash === preparation.stateHash,
        "governance state drift detected.");
      assert(transactionalState.policyHash === preparation.policyHash, "policy drift detected.");
      assert(transactionalState.deploymentBindingFingerprint === bindingFingerprint,
        "state deployment binding drift detected.");
      assert(Date.parse(gate.approvedAt) >= Date.parse(preparation.expiresAt) -
        this.policy.preparationTtlSeconds * 1_000, "gate approval predates preparation.");
      assert(!(await transaction.get(gateKey(gate.evidenceId))), "gate evidence was already claimed.");
      preparation.claimed = true;
      preparation.gateEvidenceId = gate.evidenceId;
      const permit: StoredPermit = {
        schemaVersion: "1.0",
        permitId,
        requestId: input.requestId,
        preparationId: input.preparationId,
        stateHash: transactionalState.contentHash,
        policyHash: transactionalState.policyHash,
        scope: structuredClone(preparation.intent.scope),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.policy.permitTtlSeconds * 1_000).toISOString(),
        retentionExpiresAt: new Date(now + this.policy.recordRetentionSeconds * 1_000).toISOString(),
        useLimit: 1,
        nonTransferable: true,
        observationAllowed: true,
        operation: preparation.intent.operation,
        deploymentBindingFingerprint: bindingFingerprint,
        consumed: false,
        outcomeRecorded: false,
      };
      await transaction.put(preparationKey(preparation.preparationId), preparation);
      await transaction.put(gateKey(gate.evidenceId), {
        preparationId: preparation.preparationId,
        claimedAt: new Date(now).toISOString(),
        retentionExpiresAt: preparation.retentionExpiresAt,
      });
      await transaction.put(permitKey(permitId), permit);
      const { operation: _operation,
        deploymentBindingFingerprint: _deploymentBindingFingerprint,
        consumed: _consumed, outcomeRecorded: _outcomeRecorded, ...publicPermit } = permit;
      return publicPermit;
    });
  }

  async consumeObservationPermit(input: PermitConsumption): Promise<{ allowed: true; permitId: string }> {
    assert(isObject(input), "permit consumption must be an object.");
    exactKeys(input, ["permitId", "requestId", "operation", "scope",
      "deploymentBindingFingerprint"], "permit consumption");
    const scope = validateScope(input.scope);
    const current = await this.getStateSnapshot();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    assert(input.deploymentBindingFingerprint === bindingFingerprint,
      "deployment binding drift detected.");
    return this.store.transaction(async (transaction) => {
      const permit = await transaction.get<StoredPermit>(permitKey(input.permitId));
      assert(permit, "permit does not exist.");
      assert(!permit.consumed, "permit was already consumed.");
      assert(Date.parse(permit.expiresAt) >= this.now(), "permit expired.");
      assert(Date.parse(permit.retentionExpiresAt) >= this.now(), "permit retention expired.");
      assert(permit.requestId === input.requestId, "permit request binding mismatch.");
      assert(permit.operation === input.operation, "permit operation binding mismatch.");
      assert(permit.deploymentBindingFingerprint === bindingFingerprint,
        "permit deployment binding drift detected.");
      assert(stable(scope) === stable(permit.scope), "permit scope binding mismatch.");
      const transactionalState = await transaction.get<StateSnapshot>(STATE_KEY);
      assert(transactionalState?.contentHash === current.contentHash &&
        transactionalState.contentHash === permit.stateHash,
      "governance state drift detected before execution.");
      permit.consumed = true;
      await transaction.put(permitKey(permit.permitId), permit);
      return { allowed: true as const, permitId: permit.permitId };
    });
  }

  async recordObservationOutcome(input: ObservationOutcome): Promise<StateSnapshot> {
    assert(isObject(input), "observation outcome must be an object.");
    exactOrOptionalKeys(input,
      ["permitId", "requestId", "status", "observedAt", "verificationStatus", "evidenceRefs"],
      ["errorCode"], "observation outcome");
    nonempty(input.permitId, "outcome.permitId");
    nonempty(input.requestId, "outcome.requestId");
    const observedAt = timestamp(input.observedAt, "outcome.observedAt");
    assert(observedAt <= this.now() + 5_000, "outcome observedAt is in the future.");
    assert(input.status === "succeeded" || input.status === "failed", "outcome status is invalid.");
    assert(input.verificationStatus === "unverified",
      "independent verification requires a separate verifier ingestion path.");
    const evidenceRefs = validateEvidenceRefs(input.evidenceRefs, "outcome.evidenceRefs");
    if (input.errorCode !== undefined) nonempty(input.errorCode, "outcome.errorCode");
    assert(input.status === "failed" || input.errorCode === undefined,
      "successful outcome must not contain errorCode.");
    const current = await this.getStateSnapshot();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    return this.store.transaction(async (transaction) => {
      const permit = await transaction.get<StoredPermit>(permitKey(input.permitId));
      assert(permit, "permit does not exist.");
      assert(permit.consumed, "outcome cannot be recorded before permit consumption.");
      assert(!permit.outcomeRecorded, "outcome was already recorded.");
      assert(Date.parse(permit.retentionExpiresAt) >= this.now(), "permit retention expired.");
      assert(permit.requestId === input.requestId, "outcome request binding mismatch.");
      assert(permit.deploymentBindingFingerprint === bindingFingerprint,
        "permit deployment binding drift detected.");
      assert(observedAt >= Date.parse(permit.issuedAt), "outcome predates permit issuance.");
      assert(observedAt <= Date.parse(permit.issuedAt) + 300_000,
        "outcome is outside the five-minute evidence window.");
      const transactionalState = await transaction.get<StateSnapshot>(STATE_KEY);
      assert(transactionalState?.contentHash === current.contentHash,
        "governance state drift detected before outcome recording.");
      assert(transactionalState.deploymentBindingFingerprint === bindingFingerprint,
        "state deployment binding drift detected.");
      const components = structuredClone(transactionalState.components);
      const confidence = structuredClone(transactionalState.measurementConfidence);
      if (input.status === "failed") {
        components.E = clip(components.E - 0.05);
        components.K = clip(components.K - 0.02);
        components.U = clip(components.U + 0.10);
        components.R = clip(components.R + 0.10);
        components.D = clip(components.D + 0.05);
        components.X = clip(components.X + 0.05);
      }
      for (const key of STATE_KEYS) confidence[key] = clip(confidence[key] - 0.01);
      const next = await makeSnapshot(
        transactionalState.version + 1,
        new Date(observedAt).toISOString(),
        components,
        confidence,
        [...transactionalState.evidenceRefs.slice(-31), ...evidenceRefs].slice(-32),
        transactionalState.policyHash,
        bindingFingerprint,
      );
      permit.outcomeRecorded = true;
      await transaction.put(permitKey(permit.permitId), permit);
      await transaction.put(STATE_KEY, next);
      return next;
    });
  }

  async purgeExpiredRecords(control: RetentionControlManifest): Promise<PurgeResult> {
    await this.ensurePolicyIntegrity();
    const now = this.now();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    assert(control.policyHash === this.policy.policyHash, "retention policy binding mismatch.");
    assert(control.deploymentBindingFingerprint === bindingFingerprint,
      "retention deployment binding mismatch.");
    const purgeRunId = `PGR-${now}-${this.id()}`;
    const startedAt = new Date(now).toISOString();
    const evidenceExpiry = new Date(
      now + this.policy.recordRetentionSeconds * 1_000,
    ).toISOString();

    if (control.legalHoldActive) {
      const evidence: PurgeEvidence = {
        schemaVersion: "1.0",
        purgeRunId,
        retentionApprovalId: control.retentionApprovalId,
        retentionPolicyId: control.retentionPolicyId,
        policyHash: this.policy.policyHash,
        deploymentBindingFingerprint: bindingFingerprint,
        status: "held",
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        deletedRecordCount: 0,
        deletedRecordKeyHashes: [],
        legalHoldEvidenceRef: control.legalHoldEvidenceRef,
        retentionExpiresAt: evidenceExpiry,
      };
      await this.store.transaction(async (transaction) => {
        await transaction.put(purgeEvidenceKey(purgeRunId), evidence);
      });
      return {
        evidence,
        nextAlarmAt: new Date(now + control.legalHoldRecheckSeconds * 1_000).toISOString(),
      };
    }

    try {
      return await this.store.transaction(async (transaction) => {
        const records = new Map<string, unknown>();
        for (const prefix of RETENTION_PREFIXES) {
          for (const [key, value] of await transaction.list<unknown>({ prefix })) {
            records.set(key, value);
          }
        }
        const expired: string[] = [];
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const [key, value] of records) {
          assert(isObject(value), `retention record invalid: ${key}`);
          let expiry: number;
          try {
            expiry = timestamp(value.retentionExpiresAt, `retention record ${key}`);
          } catch {
            throw new Error(`retention record invalid: ${key}`);
          }
          if (expiry <= now) expired.push(key);
          else nextExpiry = Math.min(nextExpiry, expiry);
        }
        expired.sort();
        const targets = expired.slice(0, control.purgeBatchLimit);
        const deletedRecordKeyHashes = await Promise.all(targets.map((key) => fingerprint(key)));
        for (const key of targets) await transaction.delete(key);
        const evidence: PurgeEvidence = {
          schemaVersion: "1.0",
          purgeRunId,
          retentionApprovalId: control.retentionApprovalId,
          retentionPolicyId: control.retentionPolicyId,
          policyHash: this.policy.policyHash,
          deploymentBindingFingerprint: bindingFingerprint,
          status: "succeeded",
          startedAt,
          completedAt: new Date(this.now()).toISOString(),
          deletedRecordCount: targets.length,
          deletedRecordKeyHashes,
          legalHoldEvidenceRef: null,
          retentionExpiresAt: evidenceExpiry,
        };
        await transaction.put(purgeEvidenceKey(purgeRunId), evidence);
        const moreExpired = expired.length > targets.length;
        const nextAlarm = moreExpired
          ? now + 1_000
          : Number.isFinite(nextExpiry)
            ? nextExpiry
            : now + this.policy.recordRetentionSeconds * 1_000;
        return { evidence, nextAlarmAt: new Date(nextAlarm).toISOString() };
      });
    } catch (error) {
      const errorCode = error instanceof Error && error.message.startsWith("retention record invalid:")
        ? "RETENTION_RECORD_INVALID" as const
        : "PURGE_TRANSACTION_FAILED" as const;
      const evidence: PurgeEvidence = {
        schemaVersion: "1.0",
        purgeRunId,
        retentionApprovalId: control.retentionApprovalId,
        retentionPolicyId: control.retentionPolicyId,
        policyHash: this.policy.policyHash,
        deploymentBindingFingerprint: bindingFingerprint,
        status: "failed",
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        deletedRecordCount: 0,
        deletedRecordKeyHashes: [],
        legalHoldEvidenceRef: null,
        errorCode,
        retentionExpiresAt: evidenceExpiry,
      };
      await this.store.put(purgeEvidenceKey(purgeRunId), evidence);
      return { evidence, nextAlarmAt: new Date(now + 60_000).toISOString() };
    }
  }

  async recordRetentionControlFailure(): Promise<PurgeResult> {
    await this.ensurePolicyIntegrity();
    const now = this.now();
    const bindingFingerprint = await this.currentDeploymentBindingFingerprint();
    const purgeRunId = `PGR-CONTROL-${now}-${this.id()}`;
    const evidence: PurgeEvidence = {
      schemaVersion: "1.0",
      purgeRunId,
      retentionApprovalId: "unverified-retention-control",
      retentionPolicyId: "unverified-retention-control",
      policyHash: this.policy.policyHash,
      deploymentBindingFingerprint: bindingFingerprint,
      status: "failed",
      startedAt: new Date(now).toISOString(),
      completedAt: new Date(this.now()).toISOString(),
      deletedRecordCount: 0,
      deletedRecordKeyHashes: [],
      legalHoldEvidenceRef: null,
      errorCode: "RETENTION_CONTROL_INVALID",
      retentionExpiresAt: new Date(
        now + this.policy.recordRetentionSeconds * 1_000,
      ).toISOString(),
    };
    await this.store.put(purgeEvidenceKey(purgeRunId), evidence);
    return { evidence, nextAlarmAt: new Date(now + 60_000).toISOString() };
  }
}
