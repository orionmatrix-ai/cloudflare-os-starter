export const STATE_KEYS = ["E", "K", "U", "R", "C", "D", "L", "A", "X"] as const;
export const GOVERNANCE_ARTIFACT_REVISION =
  "om-p3-governed-sheets-system-state-verifier-v1" as const;
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
  schemaVersion: "1.1";
  approvalId: string;
  artifactRevision: typeof GOVERNANCE_ARTIFACT_REVISION;
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
  "approvalId" | "artifactRevision" | "policyHash" | "deploymentBindingFingerprint" | "accountId" |
  "runtimeWorkerName" | "adapterWorkerName" | "stage"
>;

export type VerifierApprovalManifest = {
  schemaVersion: "1.0";
  approvalId: string;
  artifactRevision: typeof GOVERNANCE_ARTIFACT_REVISION;
  policyHash: string;
  deploymentBindingFingerprint: string;
  accountId: string;
  runtimeWorkerName: string;
  verifierWorkerName: string;
  routerWorkerName: string;
  stage: string;
  callerId: string;
  approvedAt: string;
  expiresAt: string;
  revoked: false;
};

export type VerifierApprovalExpectation = Pick<
  VerifierApprovalManifest,
  "approvalId" | "artifactRevision" | "policyHash" | "deploymentBindingFingerprint" |
  "accountId" | "runtimeWorkerName" | "verifierWorkerName" | "routerWorkerName" | "stage" |
  "callerId"
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

export type StateRateVector = Record<StateKey, number | null>;

export type OMSystemStateView = {
  schemaVersion: "1.0";
  subjectType: "system-self";
  epistemicStatus: "estimated";
  observedAt: string;
  baseSnapshot: {
    snapshotId: string;
    version: number;
    contentHash: string;
    previousSnapshotId: string | null;
  };
  dynamics: {
    current: StateVector;
    rawDelta: StateRateVector;
    ratePerDay: StateRateVector;
    rateBasisSeconds: number | null;
    rateAssessment: "insufficient-history" | "insufficient-basis" | "usable";
    calibrated: false;
    updateBasis: "policy-initialized-and-unverified-outcome-adjusted";
    measurementConfidence: StateVector;
  };
  knowledgeState: {
    evidenceQuality: number;
    knowledgeIntegrity: number;
    uncertainty: number;
    unresolvedConflictIndex: number;
  };
  governanceState: {
    risk: number;
    uncertainty: number;
    policyConflict: number;
    policyDrift: number;
    authorityCeilingId: string;
    humanGate: "mandatory";
    verificationIntensity: GovernanceEnvelope["verificationIntensity"];
    modelRoutingRequirement: GovernanceEnvelope["modelRoutingRequirement"];
  };
  agentState: {
    activityIndex: number;
    configuredPrincipalId: string;
    configuredCallerId: string;
    activeAgentTelemetry: "not-observed";
    modelSelfReportedConfidenceAccepted: false;
  };
  executionState: {
    exposureIndex: number;
    configuredOperation: string;
    configuredService: string;
    lifecycleTelemetry: "not-observed";
  };
  systemHealth: {
    loadIndex: number;
    driftIndex: number;
    riskIndex: number;
    minimumMeasurementConfidence: number;
    errorRate: null;
    cost: null;
    processingLatencyMs: null;
  };
  evidence: {
    refs: string[];
    verificationStatus: "unverified";
    sourceSnapshotHash: string;
  };
  controlBoundaries: {
    authorityExpansionAllowed: false;
    permissionExpansionAllowed: false;
    scopeExpansionAllowed: false;
    automaticGateRelaxationAllowed: false;
    executionAuthorizationGenerated: false;
  };
  blindSpots: string[];
};

export type StateVerificationRequest = {
  requestId: string;
  requestedAt: string;
};

export type OMSystemStateVerificationBundle = {
  schemaVersion: "1.0";
  generatedAt: string;
  requestId: string;
  policyHash: string;
  policy: GovernancePolicyFingerprintMaterial;
  deploymentBindingFingerprint: string;
  current: StateSnapshot;
  previous: StateSnapshot | null;
  stateView: OMSystemStateView;
};

/** Read-only capability intentionally separated from GovernanceRuntimeBinding's mutating methods. */
export interface GovernanceStateReadBinding {
  getVerificationBundle(input: StateVerificationRequest): Promise<OMSystemStateVerificationBundle>;
}

export interface GovernanceRuntimeBinding {
  prepareObservation(intent: ObservationIntentRequest): Promise<ObservationPreparation>;
  authorizeObservation(input: PermitAuthorizationRequest): Promise<ObservationPermit>;
  consumeObservationPermit(input: PermitConsumptionRequest): Promise<{ allowed: true; permitId: string }>;
  recordObservationOutcome(input: ObservationOutcome): Promise<StateSnapshot>;
  getStateSnapshot(): Promise<StateSnapshot>;
  getOMSystemState(): Promise<OMSystemStateView>;
}
