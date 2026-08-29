const TYPES_CODE = String.raw`
export type VerificationCheckStatus = "pass" | "warn" | "fail" | "inconclusive";

export type OMSystemStateVerificationReport = {
  schemaVersion: "1.0";
  reportId: string;
  requestId: string;
  verifiedAt: string;
  status: VerificationCheckStatus;
  snapshot: {
    id: string;
    version: number;
    observedAt: string;
    ageSeconds: number;
  };
  checks: Array<{
    id: string;
    status: VerificationCheckStatus;
    code: string;
  }>;
  claims: {
    stateIntegrityVerified: boolean;
    externalOutcomeTruthVerified: false;
    authorityGranted: false;
    permissionGranted: false;
    executionAuthorized: false;
  };
  blindSpots: string[];
};

export interface SystemStateVerifierSession {
  /** Verifies state integrity only; it does not verify external outcome truth or grant authority. */
  getVerificationReport(): Promise<OMSystemStateVerificationReport>;
}
`;

export default TYPES_CODE;
