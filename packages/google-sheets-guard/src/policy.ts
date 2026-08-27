import type { SpreadsheetRange, SpreadsheetValueMode } from "./types.js";
import type {
  GovernanceRuntimeBinding,
  ObservationIntentRequest,
  ObservationOutcome,
  ObservationScope,
} from "om-governance-runtime";

export const SHEETS_RESOURCE_PATTERN =
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/;
const BOUNDED_RANGE =
  /^'(?<sheet>[^']+)'!(?<startColumn>[A-Z]+)(?<startRow>[1-9][0-9]*):(?<endColumn>[A-Z]+)(?<endRow>[1-9][0-9]*)$/;
const MAX_APPROVED_CELLS = 1_000;

export type GuardEnv = {
  P3_SPREADSHEET_ID?: string;
  P3_ALLOWED_RANGE?: string;
  OM_GOVERNANCE_POLICY_HASH?: string;
  OM_GOVERNANCE_PRINCIPAL_ID?: string;
  OM_GOVERNANCE_CAPABILITY_ID?: string;
  OM_GOVERNANCE_AUTHORITY_ID?: string;
  OM_GOVERNANCE_PERMISSION_ID?: string;
  OM_GOVERNANCE?: GovernanceRuntimeBinding;
};

export type GuardConfig = {
  spreadsheetId: string;
  allowedRange: string;
  approvedCells: number;
  policyHash: string;
  principalId: string;
  capabilityId: string;
  authorityId: string;
  permissionId: string;
};

export type GuardConnectOptions = {
  scopes?: "auth" | "full";
  resourceUrlPatterns?: string[];
};

export type ObservationQueue = {
  authorizeObservation(description: { title: string; description: string }): Promise<void>;
  [Symbol.dispose]?(): void;
};

export type UpstreamReader = {
  readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange>;
  [Symbol.dispose]?(): void;
};

function columnNumber(column: string): number {
  let result = 0;
  for (const character of column) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

export function parseGuardConfig(env: GuardEnv): GuardConfig {
  const spreadsheetId = env.P3_SPREADSHEET_ID;
  if (!spreadsheetId || !SPREADSHEET_ID.test(spreadsheetId)) {
    throw new Error("P3_SPREADSHEET_ID must be one exact Google spreadsheet ID.");
  }
  const allowedRange = env.P3_ALLOWED_RANGE;
  const match = allowedRange?.match(BOUNDED_RANGE);
  if (!allowedRange || !match?.groups) {
    throw new Error("P3_ALLOWED_RANGE must be one quoted-sheet bounded A1 range.");
  }
  const startColumn = columnNumber(match.groups.startColumn);
  const endColumn = columnNumber(match.groups.endColumn);
  const startRow = Number(match.groups.startRow);
  const endRow = Number(match.groups.endRow);
  if (![startColumn, endColumn, startRow, endRow].every(Number.isSafeInteger)) {
    throw new Error("P3_ALLOWED_RANGE row and column bounds must be safe integers.");
  }
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error("P3_ALLOWED_RANGE must run from top-left to bottom-right.");
  }
  const approvedCells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
  if (!Number.isSafeInteger(approvedCells) || approvedCells > MAX_APPROVED_CELLS) {
    throw new Error(`P3_ALLOWED_RANGE may contain at most ${MAX_APPROVED_CELLS} cells.`);
  }
  const policyHash = env.OM_GOVERNANCE_POLICY_HASH;
  if (!policyHash || !/^sha256:[0-9a-f]{64}$/.test(policyHash)) {
    throw new Error("OM_GOVERNANCE_POLICY_HASH must bind the guard to one governance policy.");
  }
  const bindings = {
    principalId: env.OM_GOVERNANCE_PRINCIPAL_ID,
    capabilityId: env.OM_GOVERNANCE_CAPABILITY_ID,
    authorityId: env.OM_GOVERNANCE_AUTHORITY_ID,
    permissionId: env.OM_GOVERNANCE_PERMISSION_ID,
  };
  for (const [name, value] of Object.entries(bindings)) {
    if (!value || value.trim().length === 0) {
      throw new Error(`${name} must be bound by the deployment governance policy.`);
    }
  }
  if (!env.OM_GOVERNANCE) {
    throw new Error("OM_GOVERNANCE service binding is required; no fallback is permitted.");
  }
  return {
    spreadsheetId,
    allowedRange,
    approvedCells,
    policyHash,
    principalId: bindings.principalId!,
    capabilityId: bindings.capabilityId!,
    authorityId: bindings.authorityId!,
    permissionId: bindings.permissionId!,
  };
}

export function parseApprovedSpreadsheetUrl(url: string, expectedId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Google Sheets resource must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com" ||
      parsed.search || parsed.hash) {
    throw new Error("Google Sheets resource must be an exact HTTPS URL without query or fragment.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "spreadsheets" ||
      segments[1] !== "d" || segments[3] !== "edit") {
    throw new Error("Google Sheets resource URL has an invalid path.");
  }
  const spreadsheetId = segments[2];
  if (spreadsheetId !== expectedId) {
    throw new Error("Google Sheets resource does not match P3_SPREADSHEET_ID.");
  }
  return spreadsheetId;
}

export function normalizeConnectOptions(options?: GuardConnectOptions): Required<GuardConnectOptions> {
  if (options?.scopes === "auth") {
    throw new Error("The OM OS Google Sheets guard cannot be used for sign-in.");
  }
  if (options?.resourceUrlPatterns &&
      (options.resourceUrlPatterns.length !== 1 ||
       options.resourceUrlPatterns[0] !== SHEETS_RESOURCE_PATTERN)) {
    throw new Error("The OM OS Google Sheets guard permits only the Google Spreadsheet resource.");
  }
  return { scopes: "full", resourceUrlPatterns: [SHEETS_RESOURCE_PATTERN] };
}

export async function readAfterAuthorization(
  approvalQueue: ObservationQueue,
  upstream: UpstreamReader,
  config: GuardConfig,
  governance: GovernanceRuntimeBinding,
  options?: { valueMode?: SpreadsheetValueMode },
): Promise<SpreadsheetRange> {
  const requestId = `google-sheets-read:${crypto.randomUUID()}`;
  const scope: ObservationScope = {
    service: "google-sheets",
    resourceId: config.spreadsheetId,
    resourceScope: config.allowedRange,
    dataClass: "synthetic",
  };
  const intent: ObservationIntentRequest = {
    schemaVersion: "1.0",
    requestId,
    principalId: config.principalId,
    capabilityId: config.capabilityId,
    authorityId: config.authorityId,
    permissionId: config.permissionId,
    operation: "google.sheets.range.read",
    requestedAt: new Date().toISOString(),
    scope,
    evidenceRefs: [
      `policy:${config.policyHash}`,
      `guard:google-sheets:${config.spreadsheetId}:${config.allowedRange}`,
    ],
  };
  const preparation = await governance.prepareObservation(intent);
  await approvalQueue.authorizeObservation({
    title: `Read approved Google Sheets range ${config.allowedRange}`,
    description:
      `Read ${config.approvedCells.toLocaleString()} cell(s) from the single ` +
      `deployment-approved spreadsheet range. Governance verification: ` +
      `${preparation.envelope.verificationIntensity}; risk index ` +
      `${preparation.envelope.riskIndex.toFixed(3)}.`,
  });
  const permit = await governance.authorizeObservation({
    preparationId: preparation.preparationId,
    requestId,
    gate: {
      source: "cloudflare-approval-queue",
      evidenceId: `cloudflare-approval:${requestId}:${preparation.preparationId}`,
      approvedAt: new Date().toISOString(),
    },
  });
  await governance.consumeObservationPermit({
    permitId: permit.permitId,
    requestId,
    operation: "google.sheets.range.read",
    scope,
  });
  let result: SpreadsheetRange;
  try {
    result = await upstream.readRange(config.allowedRange, options);
  } catch (error) {
    const outcome: ObservationOutcome = {
      permitId: permit.permitId,
      requestId,
      status: "failed",
      observedAt: new Date().toISOString(),
      verificationStatus: "unverified",
      evidenceRefs: [`observation:${requestId}:upstream-read-failed`],
      errorCode: "UPSTREAM_READ_FAILED",
    };
    try {
      await governance.recordObservationOutcome(outcome);
    } catch (recordError) {
      throw new Error("Read failed and outcome evidence could not be recorded.", {
        cause: recordError,
      });
    }
    throw error;
  }
  const outcome: ObservationOutcome = {
    permitId: permit.permitId,
    requestId,
    status: "succeeded",
    observedAt: new Date().toISOString(),
    verificationStatus: "unverified",
    evidenceRefs: [`observation:${requestId}:upstream-read-complete`],
  };
  await governance.recordObservationOutcome(outcome);
  return result;
}
