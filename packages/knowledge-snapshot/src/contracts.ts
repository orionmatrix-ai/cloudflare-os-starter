import { z } from "zod";

export const LIMITS = Object.freeze({
  // Initial configuration-held pilot: each JSON value stays below Workers' 5 KB limit.
  documents: 3, documentBytes: 1_024, totalBytes: 2_048,
  snapshotJsonBytes: 4_096, grantJsonBytes: 4_096, requestBytes: 4_096,
  responseBytes: 32_768,
  ttlMs: 86_400_000, sessionReads: 5, timeoutMs: 10_000,
});
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ precision: 3 });

export const documentSchema = z.strictObject({
  id,
  title: z.string().min(1).max(160),
  // An opaque citation identifier, not a filesystem path or a URL to fetch.
  sourceRef: id,
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  knowledgeStatus: z.enum(["candidate", "human-approved"]),
  content: z.string().min(1).max(LIMITS.documentBytes),
  contentSha256: digest,
});
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal("om.knowledge-snapshot.v1"),
  snapshotId: id,
  dataClass: z.enum(["synthetic", "approved-evaluation-copy"]),
  createdAt: instant,
  expiresAt: instant,
  documents: z.array(documentSchema).min(1).max(LIMITS.documents),
});

/** Trusted deployment configuration; never accepted from an MCP argument/header. */
export const grantSchema = z.strictObject({
  schemaVersion: z.literal("om.knowledge-read-grant.v1"),
  approvalId: id,
  purpose: z.literal("oao-knowledge-evaluation"),
  deploymentId: id,
  callerId: id,
  workPackageId: id,
  snapshotId: id,
  snapshotSha256: digest,
  documentIds: z.array(id).min(1).max(LIMITS.documents),
  dataClass: z.enum(["synthetic", "approved-evaluation-copy"]),
  approvedAt: instant,
  expiresAt: instant,
  revoked: z.boolean(),
});
export const readRequestSchema = z.strictObject({
  workPackageId: id,
  snapshotId: id,
  snapshotSha256: digest,
  documentId: id,
});
export const readResultSchema = z.strictObject({
  schemaVersion: z.literal("om.knowledge-read-result.v1"),
  status: z.literal("OBSERVED_COPY"),
  snapshotId: id,
  snapshotSha256: digest,
  document: documentSchema,
  dataClass: z.enum(["synthetic", "approved-evaluation-copy"]),
  observedAt: instant,
  expiresAt: instant,
  approvalId: id,
  workPackageId: id,
  instructionAuthority: z.literal(false),
  liveSourceVerified: z.literal(false),
  canonicalPromotion: z.literal(false),
  executionAuthorized: z.literal(false),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ReadGrant = z.infer<typeof grantSchema>;
export type ReadRequest = z.infer<typeof readRequestSchema>;
export type ReadResult = z.infer<typeof readResultSchema>;

export interface KnowledgeEnv {
  KNOWLEDGE_ENABLED?: string;
  KNOWLEDGE_DEPLOYMENT_ID?: string;
  KNOWLEDGE_SNAPSHOT_JSON?: string;
  KNOWLEDGE_READ_GRANT_JSON?: string;
}

export class KnowledgeHold extends Error {
  constructor() { super("KNOWLEDGE_HOLD"); }
}
