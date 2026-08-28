import { describe, expect, it, vi } from "vitest";
import type { GovernanceRuntimeBinding } from "om-governance-runtime";
import {
  GatekeeperUserImpl,
  GatekeeperVendor,
  GoogleSheetsGatekeeperImpl,
  GuardedGoogleSheetSessionImpl,
} from "../src/index.js";
import {
  normalizeConnectOptions,
  parseApprovedSpreadsheetUrl,
  parseGuardConfig,
  readAfterAuthorization,
  SHEETS_RESOURCE_PATTERN,
} from "../src/policy.js";

const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const POLICY_HASH = `sha256:${"a".repeat(64)}`;
const BINDING_FINGERPRINT = `sha256:${"b".repeat(64)}`;

function governanceBinding(order: string[] = []): GovernanceRuntimeBinding {
  return {
    prepareObservation: vi.fn(async (intent) => {
      order.push("governance:prepare");
      return {
        schemaVersion: "1.0",
        status: "human-gate-required",
        preparationId: "preparation-1",
        requestId: intent.requestId,
        stateSnapshotId: "GSS-0",
        stateHash: POLICY_HASH,
        policyHash: POLICY_HASH,
        deploymentBindingFingerprint: BINDING_FINGERPRINT,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        stageAuthorizationCandidate: {
          candidateId: "stage-candidate-1",
          simulationOnly: true,
          sideEffectsAllowed: false,
        },
        provisionalBranch: {
          branchId: "provisional-branch-1",
          baseSnapshotId: "GSS-0",
          isolated: true,
        },
        simulationAssertion: {
          method: "bounded-observation",
          assurance: "deployment-bound",
          calibrated: false,
          blindSpots: [
            "live provider content version is not observed before authorization",
          ] as string[],
        },
        provisionalState: { E: 0.8, K: 0.8, U: 0.2, R: 0.2, C: 0.1, D: 0.1, L: 0.2, A: 0.1, X: 0.2 },
        projectedGovernanceState: { E: 0.8, K: 0.8, U: 0.2, R: 0.2, C: 0.1, D: 0.1, L: 0.2, A: 0.1, X: 0.2 },
        projectedMeasurementConfidence: { E: 0.8, K: 0.8, U: 0.8, R: 0.8, C: 0.8, D: 0.8, L: 0.8, A: 0.8, X: 0.8 },
        envelope: {
          riskIndex: 0.2,
          minimumMeasurementConfidence: 0.8,
          verificationIntensity: "standard",
          modelRoutingRequirement: "baseline-eligible",
          humanGateRequired: true,
          authorityCeilingId: "authority:om-inc:p3-synthetic-read",
          authorityExpansionAllowed: false,
          permissionExpansionAllowed: false,
          scopeExpansionAllowed: false,
          automaticGateRelaxationAllowed: false,
        },
      } as const;
    }),
    authorizeObservation: vi.fn(async (input) => {
      order.push("governance:authorize");
      return {
        schemaVersion: "1.0",
        permitId: "permit-1",
        requestId: input.requestId,
        preparationId: input.preparationId,
        stateHash: POLICY_HASH,
        policyHash: POLICY_HASH,
        scope: {
          service: "google-sheets",
          resourceId: SPREADSHEET_ID,
          resourceScope: "'P3_READONLY'!A1:D20",
          dataClass: "synthetic",
        },
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        useLimit: 1,
        nonTransferable: true,
        observationAllowed: true,
      } as const;
    }),
    consumeObservationPermit: vi.fn(async (input) => {
      order.push("governance:consume");
      return { allowed: true as const, permitId: input.permitId };
    }),
    recordObservationOutcome: vi.fn(async (outcome) => {
      order.push(`governance:outcome:${outcome.status}`);
      return {
        snapshotId: "GSS-1",
        version: 1,
        updatedAt: new Date().toISOString(),
        components: { E: 0.8, K: 0.8, U: 0.2, R: 0.2, C: 0.1, D: 0.1, L: 0.2, A: 0.1, X: 0.2 },
        measurementConfidence: { E: 0.79, K: 0.79, U: 0.79, R: 0.79, C: 0.79, D: 0.79, L: 0.79, A: 0.79, X: 0.79 },
        evidenceRefs: ["outcome:test"],
        policyHash: POLICY_HASH,
        deploymentBindingFingerprint: BINDING_FINGERPRINT,
        contentHash: POLICY_HASH,
      };
    }),
    getStateSnapshot: vi.fn(),
    getOMSystemState: vi.fn(),
  };
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    P3_SPREADSHEET_ID: SPREADSHEET_ID,
    P3_ALLOWED_RANGE: "'P3_READONLY'!A1:D20",
    OM_GOVERNANCE_POLICY_HASH: POLICY_HASH,
    OM_GOVERNANCE_PRINCIPAL_ID: "principal:om-inc:p3-evaluator",
    OM_GOVERNANCE_CAPABILITY_ID: "capability:google-sheets:range-read",
    OM_GOVERNANCE_AUTHORITY_ID: "authority:om-inc:p3-synthetic-read",
    OM_GOVERNANCE_PERMISSION_ID: "permission:om-inc:p3-fixed-range",
    OM_GOVERNANCE: governanceBinding(),
    ...overrides,
  } as unknown as Cloudflare.Env & {
    P3_SPREADSHEET_ID?: string;
    P3_ALLOWED_RANGE?: string;
  };
}

describe("P3 Google Sheets guard", () => {
  it("accepts one exact spreadsheet and bounded range", () => {
    expect(parseGuardConfig(env())).toEqual({
      spreadsheetId: SPREADSHEET_ID,
      allowedRange: "'P3_READONLY'!A1:D20",
      approvedCells: 80,
      policyHash: POLICY_HASH,
      principalId: "principal:om-inc:p3-evaluator",
      capabilityId: "capability:google-sheets:range-read",
      authorityId: "authority:om-inc:p3-synthetic-read",
      permissionId: "permission:om-inc:p3-fixed-range",
    });
  });

  it.each([
    ["missing id", { P3_SPREADSHEET_ID: undefined }],
    ["wildcard id", { P3_SPREADSHEET_ID: "*" }],
    ["unbounded range", { P3_ALLOWED_RANGE: "'P3_READONLY'!A:D" }],
    ["reversed range", { P3_ALLOWED_RANGE: "'P3_READONLY'!D20:A1" }],
    ["too many cells", { P3_ALLOWED_RANGE: "'P3_READONLY'!A1:Z100" }],
    ["unsafe row", { P3_ALLOWED_RANGE: "'P3_READONLY'!A9007199254740992:A9007199254740992" }],
    ["unsafe column", {
      P3_ALLOWED_RANGE: "'P3_READONLY'!ZZZZZZZZZZZZZZZZZZZZ1:ZZZZZZZZZZZZZZZZZZZZ1",
    }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseGuardConfig(env(overrides))).toThrow();
  });

  it("accepts 1,000 cells and rejects 1,001", () => {
    expect(parseGuardConfig(env({ P3_ALLOWED_RANGE: "'P3_READONLY'!A1:J100" })))
      .toMatchObject({ approvedCells: 1_000 });
    expect(() => parseGuardConfig(env({ P3_ALLOWED_RANGE: "'P3_READONLY'!A1:A1001" })))
      .toThrow(/at most 1000 cells/);
  });

  it("accepts only the exact approved spreadsheet URL", () => {
    expect(parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      SPREADSHEET_ID,
    )).toBe(SPREADSHEET_ID);
    expect(() => parseApprovedSpreadsheetUrl(
      "https://docs.google.com/spreadsheets/d/anotherSpreadsheetIdentifier/edit",
      SPREADSHEET_ID,
    )).toThrow(/does not match/);
    expect(() => parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=0`,
      SPREADSHEET_ID,
    )).toThrow(/without query/);
    expect(() => parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/copy`,
      SPREADSHEET_ID,
    )).toThrow(/invalid path/);
  });

  it("normalizes OAuth to the Sheets resource only", () => {
    expect(normalizeConnectOptions()).toEqual({
      scopes: "full",
      resourceUrlPatterns: [SHEETS_RESOURCE_PATTERN],
    });
    expect(() => normalizeConnectOptions({ scopes: "auth" })).toThrow(/cannot be used for sign-in/);
    expect(() => normalizeConnectOptions({
      resourceUrlPatterns: ["https://mail.google.com/*"],
    })).toThrow(/only the Google Spreadsheet/);
  });

  it("authorizes before invoking the upstream read", async () => {
    const order: string[] = [];
    const approvalQueue = {
      authorizeObservation: vi.fn(async () => { order.push("cloudflare:approve"); }),
    };
    const upstream = {
      readRange: vi.fn(async (range: string) => {
        order.push(`read:${range}`);
        return { range, values: [["synthetic"]] };
      }),
    };
    await readAfterAuthorization(
      approvalQueue,
      upstream,
      parseGuardConfig(env()),
      governanceBinding(order),
    );
    expect(order).toEqual([
      "governance:prepare",
      "cloudflare:approve",
      "governance:authorize",
      "governance:consume",
      "read:'P3_READONLY'!A1:D20",
      "governance:outcome:succeeded",
    ]);
  });

  it("does not read upstream when pre-authorization fails", async () => {
    const upstream = { readRange: vi.fn() };
    await expect(readAfterAuthorization(
      { authorizeObservation: vi.fn(async () => { throw new Error("denied"); }) },
      upstream,
      parseGuardConfig(env()),
      governanceBinding(),
    )).rejects.toThrow("denied");
    expect(upstream.readRange).not.toHaveBeenCalled();
  });

  it("blocks the inherited agent-visible session methods at runtime", async () => {
    const session = new GuardedGoogleSheetSessionImpl(
      { authorizeObservation: vi.fn(async () => undefined) },
      { readRange: vi.fn() },
      parseGuardConfig(env()),
      governanceBinding(),
    );
    await expect(session.getSpreadsheet()).rejects.toThrow(/metadata discovery is disabled/);
    await expect(session.readRange("'OTHER'!A1:A2")).rejects.toThrow(/Arbitrary ranges/);
    await expect(session.readRanges(["'OTHER'!A1:A2"])).rejects.toThrow(/Arbitrary ranges/);
  });

  it("keeps the inherited Sheets action surface read-only", async () => {
    const gatekeeper = Object.create(GoogleSheetsGatekeeperImpl.prototype) as
      GoogleSheetsGatekeeperImpl;
    await expect(gatekeeper.getAutoApprovableActions()).resolves.toEqual([]);
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/read-only/);
    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/read-only/);
    expect(() => gatekeeper.revertAction(1)).toThrow(/read-only/);
  });

  it("keeps sign-in and resource discovery disabled while exposing exact URL entry", async () => {
    const vendorDescription = await GatekeeperVendor.prototype.describe.call(
      {} as GatekeeperVendor,
    );
    expect(vendorDescription.providesAuth).toBe(false);
    const configurator = await GatekeeperUserImpl.prototype.startResourceConfigurator.call(
      {} as GatekeeperUserImpl,
      SHEETS_RESOURCE_PATTERN,
    );
    expect(configurator.iframeHtml).toBeTruthy();
    expect(configurator.ui).toBeDefined();
    await expect(GatekeeperUserImpl.prototype.startResourceConfigurator.call(
      {} as GatekeeperUserImpl,
      "https://docs.google.com/document/d/:documentId/*",
    )).rejects.toThrow(/Only the deployment-approved Google Spreadsheet/);
    await expect(GatekeeperUserImpl.prototype.ensureResources.call(
      {} as GatekeeperUserImpl,
      ["https://mail.google.com/*"],
    )).rejects.toThrow(/Only the Google Spreadsheet/);
  });

  it("uses the fixed deployment resource in the actual Gatekeeper description", async () => {
    const description = await GoogleSheetsGatekeeperImpl.prototype.describe.call({
      env: env(),
    } as unknown as GoogleSheetsGatekeeperImpl);
    expect(description).toMatchObject({
      url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      snippet: "Read-only; fixed range 'P3_READONLY'!A1:D20",
      tsType: "GuardedGoogleSheetSession",
    });
  });

  it("denies before the actual inherited session can reach Google", async () => {
    const denied = new Error("pre-authorization denied");
    const approvalQueue = {
      dup() { return this; },
      authorizeObservation: vi.fn(async () => { throw denied; }),
      [Symbol.dispose]() {},
    };
    const session = await GoogleSheetsGatekeeperImpl.prototype.startSession.call({
      env: env(),
      ctx: { props: { userObjectId: "test-user", spreadsheetId: SPREADSHEET_ID } },
    } as unknown as GoogleSheetsGatekeeperImpl, approvalQueue as never);
    await expect(session.readApprovedRange()).rejects.toBe(denied);
  });

  it("fails closed when the OM Governance Runtime binding is absent", () => {
    expect(() => parseGuardConfig(env({ OM_GOVERNANCE: undefined }))).toThrow(/no fallback/);
  });

  it("does not call Cloudflare approval or Google when Governance preparation fails", async () => {
    const approvalQueue = { authorizeObservation: vi.fn() };
    const upstream = { readRange: vi.fn() };
    const governance = governanceBinding();
    vi.mocked(governance.prepareObservation).mockRejectedValueOnce(new Error("governance denied"));
    await expect(readAfterAuthorization(
      approvalQueue,
      upstream,
      parseGuardConfig(env()),
      governance,
    )).rejects.toThrow("governance denied");
    expect(approvalQueue.authorizeObservation).not.toHaveBeenCalled();
    expect(upstream.readRange).not.toHaveBeenCalled();
  });

  it("does not read Google when runtime permit revalidation fails", async () => {
    const upstream = { readRange: vi.fn() };
    const governance = governanceBinding();
    vi.mocked(governance.consumeObservationPermit).mockRejectedValueOnce(new Error("state drift"));
    await expect(readAfterAuthorization(
      { authorizeObservation: vi.fn(async () => undefined) },
      upstream,
      parseGuardConfig(env()),
      governance,
    )).rejects.toThrow("state drift");
    expect(upstream.readRange).not.toHaveBeenCalled();
  });

  it("records failed reads without exposing cell values", async () => {
    const governance = governanceBinding();
    await expect(readAfterAuthorization(
      { authorizeObservation: vi.fn(async () => undefined) },
      { readRange: vi.fn(async () => { throw new Error("Google 503"); }) },
      parseGuardConfig(env()),
      governance,
    )).rejects.toThrow("Google 503");
    expect(governance.recordObservationOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      verificationStatus: "unverified",
      errorCode: "UPSTREAM_READ_FAILED",
    }));
    expect(JSON.stringify(vi.mocked(governance.recordObservationOutcome).mock.calls)).not.toContain("synthetic");
  });

  it("does not release successful data when outcome evidence cannot be recorded", async () => {
    const governance = governanceBinding();
    vi.mocked(governance.recordObservationOutcome).mockRejectedValueOnce(
      new Error("evidence store unavailable"),
    );
    await expect(readAfterAuthorization(
      { authorizeObservation: vi.fn(async () => undefined) },
      { readRange: vi.fn(async (range) => ({ range, values: [["not-released"]] })) },
      parseGuardConfig(env()),
      governance,
    )).rejects.toThrow("evidence store unavailable");
    expect(governance.recordObservationOutcome).toHaveBeenCalledTimes(1);
  });
});
