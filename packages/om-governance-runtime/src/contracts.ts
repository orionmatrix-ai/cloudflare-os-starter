export const STATE_KEYS = ["E", "K", "U", "R", "C", "D", "L", "A", "X"] as const;
export type StateKey = typeof STATE_KEYS[number];
export type StateVector = Record<StateKey, number>;

export type GovernancePolicy = {
  policyId: string;
  policyHash: string;
  deploymentApprovalReference: string;
  trustedCallerId: string;
  principalId: string;
  capabilityId: string;
  authorityId: string;
  permissionId: string;
  operation: string;
  service: string;
  resourceId: string;
  resourceScope: string;
  dataClass: string;
  preparationTtlSeconds: number;
  permitTtlSeconds: number;
  recordRetentionSeconds: number;
  mandatoryHumanGate: true;
  initialState: StateVector;
  initialMeasurementConfidence: StateVector;
};

export type GovernancePolicyTemplate = Omit<GovernancePolicy, "resourceId" | "resourceScope">;
export type GovernancePolicyFingerprintMaterial = Omit<
  GovernancePolicy,
  "policyHash" | "resourceId" | "resourceScope"
>;

export type DeploymentApprovalManifest = {
  schemaVersion: "1.0";
  approvalId: string;
  policyHash: string;
  deploymentBindingFingerprint: string;
  accountId: string;
  runtimeWorkerName: string;
  adapterWorkerName: string;
  stage: string;
  approvedAt: string;
  expiresAt: string;
  revoked: false;
};

export type DeploymentApprovalExpectation = Pick<
  DeploymentApprovalManifest,
  "approvalId" | "policyHash" | "deploymentBindingFingerprint" | "accountId" |
  "runtimeWorkerName" | "adapterWorkerName" | "stage"
>;

export type RetentionControlManifest = {
  schemaVersion: "1.0";
  retentionApprovalId: string;
  retentionPolicyId: string;
  policyHash: string;
  deploymentBindingFingerprint: string;
  accountId: string;
  runtimeWorkerName: string;
  stage: string;
  approvedAt: string;
  expiresAt: string;
  revoked: false;
  legalHoldActive: boolean;
  legalHoldEvidenceRef: string | null;
  purgeBatchLimit: number;
  legalHoldRecheckSeconds: number;
};

export type RetentionControlExpectation = Pick<
  RetentionControlManifest,
  "retentionApprovalId" | "policyHash" | "deploymentBindingFingerprint" | "accountId" |
  "runtimeWorkerName" | "stage"
>;

export type PurgeEvidence = {
  schemaVersion: "1.0";
  purgeRunId: string;
  retentionApprovalId: string;
  retentionPolicyId: string;
  policyHash: string;
  deploymentBindingFingerprint: string;
  status: "succeeded" | "succeeded-with-quarantine" | "held" | "failed";
  startedAt: string;
  completedAt: string;
  deletedRecordCount: number;
  deletedRecordKeyHashes: string[];
  quarantinedRecordCount: number;
  quarantinedRecordKeyHashes: string[];
  legalHoldEvidenceRef: string | null;
  errorCode?: "RETENTION_RECORD_INVALID" | "PURGE_TRANSACTION_FAILED" |
    "RETENTION_CONTROL_INVALID";
  retentionExpiresAt: string;
};

export type PurgeResult = {
  evidence: PurgeEvidence;
  nextAlarmAt: string;
};

export type DeploymentBindingFingerprintMaterial = Pick<
  GovernancePolicy,
  "policyHash" | "service" | "operation" | "resourceId" | "resourceScope" | "dataClass"
>;

export type ObservationScope = {
  service: string;
  resourceId: string;
  resourceScope: string;
  dataClass: string;
};

export type ObservationIntent = {
  schemaVersion: "1.0";
  requestId: string;
  principalId: string;
  capabilityId: string;
  authorityId: string;
  permissionId: string;
  operation: string;
  deploymentBindingFingerprint: string;
  requestedAt: string;
  scope: ObservationScope;
  evidenceRefs: string[];
};

export type ObservationIntentRequest = Omit<ObservationIntent, "deploymentBindingFingerprint">;

export type GovernanceEnvelope = {
  riskIndex: number;
  minimumMeasurementConfidence: number;
  verificationIntensity: "standard" | "high" | "critical";
  modelRoutingRequirement: "baseline-eligible" | "high-assurance-required";
  humanGateRequired: true;
  authorityCeilingId: string;
  authorityExpansionAllowed: false;
  permissionExpansionAllowed: false;
  scopeExpansionAllowed: false;
  automaticGateRelaxationAllowed: false;
};

export type ObservationPreparation = {
  schemaVersion: "1.0";
  status: "human-gate-required";
  preparationId: string;
  requestId: string;
  stateSnapshotId: string;
  stateHash: string;
  policyHash: string;
  deploymentBindingFingerprint: string;
  expiresAt: string;
  retentionExpiresAt: string;
  stageAuthorizationCandidate: {
    candidateId: string;
    simulationOnly: true;
    sideEffectsAllowed: false;
  };
  provisionalBranch: {
    branchId: string;
    baseSnapshotId: string;
    isolated: true;
  };
  simulationAssertion: {
    method: "bounded-observation";
    assurance: "deployment-bound";
    calibrated: false;
    blindSpots: string[];
  };
  provisionalState: StateVector;
  projectedGovernanceState: StateVector;
  projectedMeasurementConfidence: StateVector;
  envelope: GovernanceEnvelope;
};

export type HumanGateEvidence = {
  source: "cloudflare-approval-queue";
  evidenceId: string;
  approvedAt: string;
};

export type AttestedHumanGateEvidence = HumanGateEvidence & {
  attestedBy: string;
};

export type PermitAuthorization = {
  preparationId: string;
  requestId: string;
  deploymentBindingFingerprint: string;
  gate: HumanGateEvidence;
};

export type PermitAuthorizationRequest = Omit<
  PermitAuthorization,
  "deploymentBindingFingerprint"
>;

export type AttestedPermitAuthorization = Omit<PermitAuthorization, "gate"> & {
  gate: AttestedHumanGateEvidence;
};

export type ObservationPermit = {
  schemaVersion: "1.0";
  permitId: string;
  requestId: string;
  preparationId: string;
  stateHash: string;
  policyHash: string;
  scope: ObservationScope;
  issuedAt: string;
  expiresAt: string;
  retentionExpiresAt: string;
  useLimit: 1;
  nonTransferable: true;
  observationAllowed: true;
};

export type PermitConsumption = {
  permitId: string;
  requestId: string;
  operation: string;
  scope: ObservationScope;
  deploymentBindingFingerprint: string;
};

export type PermitConsumptionRequest = Omit<
  PermitConsumption,
  "deploymentBindingFingerprint"
>;

export type ObservationOutcome = {
  permitId: string;
  requestId: string;
  status: "succeeded" | "failed";
  observedAt: string;
  verificationStatus: "unverified";
  evidenceRefs: string[];
  errorCode?: string;
};

export type StateSnapshot = {
  snapshotId: string;
  version: number;
  updatedAt: string;
  components: StateVector;
  measurementConfidence: StateVector;
  evidenceRefs: string[];
  policyHash: string;
  deploymentBindingFingerprint: string;
  contentHash: string;
};

export interface GovernanceRuntimeBinding {
  prepareObservation(intent: ObservationIntentRequest): Promise<ObservationPreparation>;
  authorizeObservation(input: PermitAuthorizationRequest): Promise<ObservationPermit>;
  consumeObservationPermit(input: PermitConsumptionRequest): Promise<{ allowed: true; permitId: string }>;
  recordObservationOutcome(input: ObservationOutcome): Promise<StateSnapshot>;
  getStateSnapshot(): Promise<StateSnapshot>;
}
