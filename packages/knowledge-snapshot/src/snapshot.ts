import {
  grantSchema, KnowledgeHold, LIMITS, readRequestSchema, readResultSchema, snapshotSchema,
  type KnowledgeEnv, type ReadGrant, type ReadResult, type Snapshot,
} from "./contracts.js";

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).byteLength;
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return "sha256:" + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

function boundedJson(value: string | undefined, limit: number): unknown {
  if (typeof value !== "string" || value.length > limit || byteLength(value) > limit) {
    throw new KnowledgeHold();
  }
  return JSON.parse(value);
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function timeWindow(start: string, end: string, now: number): void {
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(now) || a > now || now >= b || b <= a || b - a > LIMITS.ttlMs) {
    throw new KnowledgeHold();
  }
}

async function validateSnapshot(snapshot: Snapshot, now: number): Promise<void> {
  timeWindow(snapshot.createdAt, snapshot.expiresAt, now);
  if (!unique(snapshot.documents.map(d => d.id))) throw new KnowledgeHold();
  let total = 0;
  for (const doc of snapshot.documents) {
    const size = byteLength(doc.content);
    total += size;
    if (size > LIMITS.documentBytes || total > LIMITS.totalBytes ||
        await sha256(doc.content) !== doc.contentSha256) throw new KnowledgeHold();
  }
}

/** Pure candidate assembly from explicitly supplied text. No files, upload or approval issuance. */
export async function prepareSnapshotCandidate(input: unknown, now = Date.now()): Promise<{
  status: "CANDIDATE"; snapshotJson: string; snapshotSha256: string; approved: false;
}> {
  try {
    const json = JSON.stringify(input);
    const snapshot = snapshotSchema.parse(boundedJson(json, LIMITS.snapshotJsonBytes));
    await validateSnapshot(snapshot, now);
    return { status: "CANDIDATE", snapshotJson: json, snapshotSha256: await sha256(json), approved: false };
  } catch { throw new KnowledgeHold(); }
}

export async function loadApprovedSnapshot(
  env: KnowledgeEnv, trustedCallerId: string | undefined, clock: () => number = Date.now,
): Promise<{ snapshot: Snapshot; grant: ReadGrant }> {
  try {
    if (env.KNOWLEDGE_ENABLED !== "true") throw new KnowledgeHold();
    // Capture one version. Recheck configuration and time after asynchronous hashing.
    const raw = env.KNOWLEDGE_SNAPSHOT_JSON;
    const rawGrant = env.KNOWLEDGE_READ_GRANT_JSON;
    const deployment = env.KNOWLEDGE_DEPLOYMENT_ID;
    const grant = grantSchema.parse(boundedJson(rawGrant, LIMITS.grantJsonBytes));
    if (!trustedCallerId || grant.callerId !== trustedCallerId ||
        grant.deploymentId !== deployment || grant.revoked || !unique(grant.documentIds)) {
      throw new KnowledgeHold();
    }
    timeWindow(grant.approvedAt, grant.expiresAt, clock());
    const snapshot = snapshotSchema.parse(boundedJson(raw, LIMITS.snapshotJsonBytes));
    if (snapshot.snapshotId !== grant.snapshotId || snapshot.dataClass !== grant.dataClass ||
        await sha256(raw!) !== grant.snapshotSha256 ||
        Date.parse(grant.approvedAt) < Date.parse(snapshot.createdAt) ||
        Date.parse(grant.expiresAt) > Date.parse(snapshot.expiresAt) ||
        grant.documentIds.some(id => !snapshot.documents.some(d => d.id === id))) {
      throw new KnowledgeHold();
    }
    await validateSnapshot(snapshot, clock());
    timeWindow(grant.approvedAt, grant.expiresAt, clock());
    timeWindow(snapshot.createdAt, snapshot.expiresAt, clock());
    if (env.KNOWLEDGE_ENABLED !== "true" || env.KNOWLEDGE_SNAPSHOT_JSON !== raw ||
        env.KNOWLEDGE_READ_GRANT_JSON !== rawGrant || env.KNOWLEDGE_DEPLOYMENT_ID !== deployment) {
      throw new KnowledgeHold();
    }
    return { snapshot, grant };
  } catch { throw new KnowledgeHold(); }
}

/** Returns one exact approved document with immutable citation metadata. Never follows sourceRef. */
export async function readApprovedDocument(
  env: KnowledgeEnv, trustedCallerId: string | undefined, input: unknown,
  clock: () => number = Date.now,
): Promise<ReadResult> {
  try {
    const request = readRequestSchema.parse(input);
    const { snapshot, grant } = await loadApprovedSnapshot(env, trustedCallerId, clock);
    if (request.workPackageId !== grant.workPackageId ||
        request.snapshotId !== grant.snapshotId || request.snapshotSha256 !== grant.snapshotSha256 ||
        !grant.documentIds.includes(request.documentId)) throw new KnowledgeHold();
    const document = snapshot.documents.find(d => d.id === request.documentId);
    if (!document) throw new KnowledgeHold();
    const observedAt = clock();
    timeWindow(grant.approvedAt, grant.expiresAt, observedAt);
    timeWindow(snapshot.createdAt, snapshot.expiresAt, observedAt);
    return readResultSchema.parse({
      schemaVersion: "om.knowledge-read-result.v1", status: "OBSERVED_COPY",
      snapshotId: snapshot.snapshotId, snapshotSha256: grant.snapshotSha256, document,
      dataClass: snapshot.dataClass, observedAt: new Date(observedAt).toISOString(),
      expiresAt: grant.expiresAt, approvalId: grant.approvalId, workPackageId: grant.workPackageId,
      instructionAuthority: false, liveSourceVerified: false,
      canonicalPromotion: false, executionAuthorized: false,
    });
  } catch { throw new KnowledgeHold(); }
}
