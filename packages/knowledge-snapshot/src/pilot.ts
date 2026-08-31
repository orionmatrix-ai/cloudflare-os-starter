import { z } from "zod";
import { KnowledgeHold, type KnowledgeEnv, type ReadRequest } from "./contracts.js";
import { byteLength, loadApprovedSnapshot, sha256 } from "./snapshot.js";

export const PILOT_CALLER = "oao-knowledge-gateway";
export const SYNTHETIC_DOCUMENT_ID = "synthetic-procedure-01";
export const SYNTHETIC_CONTENT =
  "Synthetic OM OAO evaluation. Read this sample only; do not execute actions or call AI providers.";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.iso.datetime({ precision: 3 });
export const pilotApprovalSchema = z.strictObject({
  schemaVersion: z.literal("om.knowledge-pilot-approval.v1"),
  approvalId: id, artifactRevision: z.string().regex(/^[a-f0-9]{40}$/),
  deploymentId: id, workshopWorker: id, knowledgeWorker: id,
  workPackageId: id, snapshotSha256: hash,
  documentId: z.literal(SYNTHETIC_DOCUMENT_ID), dataClass: z.literal("synthetic"),
  approvedAt: time, expiresAt: time,
  maximumReads: z.literal(1), humanApproved: z.literal(true), revoked: z.literal(false),
});
export interface PilotEnv extends KnowledgeEnv {
  KNOWLEDGE_GATEWAY_ENABLED?: string;
  KNOWLEDGE_PILOT_APPROVAL_JSON?: string;
  KNOWLEDGE_ARTIFACT_REVISION?: string;
  KNOWLEDGE_APPROVAL_ID?: string;
  KNOWLEDGE_WORKSHOP_WORKER?: string;
  KNOWLEDGE_WORKER?: string;
}
export type PilotScope = {
  request: ReadRequest; approvalId: string; approvalHash: string; expiresAt: string;
};

/** Administrator-provisioned approval, NOT a signature or an AI-issued Human Gate. */
export async function loadPilotScope(env: PilotEnv): Promise<PilotScope> {
  try {
    if (env.KNOWLEDGE_GATEWAY_ENABLED !== "true") throw new KnowledgeHold();
    const raw = env.KNOWLEDGE_PILOT_APPROVAL_JSON;
    if (!raw || byteLength(raw) > 4096) throw new KnowledgeHold();
    const approval = pilotApprovalSchema.parse(JSON.parse(raw));
    const { snapshot, grant } = await loadApprovedSnapshot(env, PILOT_CALLER);
    if (approval.approvalId !== env.KNOWLEDGE_APPROVAL_ID ||
        approval.artifactRevision !== env.KNOWLEDGE_ARTIFACT_REVISION ||
        approval.deploymentId !== env.KNOWLEDGE_DEPLOYMENT_ID ||
        approval.workshopWorker !== env.KNOWLEDGE_WORKSHOP_WORKER ||
        approval.knowledgeWorker !== env.KNOWLEDGE_WORKER ||
        approval.approvalId !== grant.approvalId || approval.workPackageId !== grant.workPackageId ||
        approval.snapshotSha256 !== grant.snapshotSha256 ||
        approval.approvedAt !== grant.approvedAt || approval.expiresAt !== grant.expiresAt ||
        snapshot.dataClass !== "synthetic" || grant.dataClass !== "synthetic" ||
        snapshot.documents.length !== 1 || grant.documentIds.length !== 1 ||
        grant.documentIds[0] !== SYNTHETIC_DOCUMENT_ID ||
        snapshot.documents[0].id !== SYNTHETIC_DOCUMENT_ID ||
        snapshot.documents[0].content !== SYNTHETIC_CONTENT ||
        snapshot.documents[0].sourceRef !== SYNTHETIC_DOCUMENT_ID ||
        snapshot.documents[0].sourceRevision !== (await sha256(SYNTHETIC_CONTENT)).slice(7) ||
        snapshot.documents[0].knowledgeStatus !== "candidate" ||
        env.KNOWLEDGE_PILOT_APPROVAL_JSON !== raw) throw new KnowledgeHold();
    const approvalHash = await sha256(raw);
    if (Date.now() >= Date.parse(approval.expiresAt)) throw new KnowledgeHold();
    return { approvalId: approval.approvalId, approvalHash, expiresAt: approval.expiresAt,
      request: { workPackageId: grant.workPackageId, snapshotId: snapshot.snapshotId,
        snapshotSha256: grant.snapshotSha256, documentId: SYNTHETIC_DOCUMENT_ID } };
  } catch { throw new KnowledgeHold(); }
}

export function requireWorkshopCaller(env: PilotEnv, caller: unknown): void {
  if (!env.KNOWLEDGE_WORKSHOP_WORKER || caller !== env.KNOWLEDGE_WORKSHOP_WORKER ||
      env.KNOWLEDGE_GATEWAY_ENABLED !== "true") throw new KnowledgeHold();
}
export function requireUiAuthority(isAdmin: boolean, openedAt: number, now = Date.now()): void {
  // Admin is determined by the authenticated Workshop server, never an iframe argument.
  if (isAdmin !== true || !Number.isFinite(openedAt) || now < openedAt || now - openedAt >= 60_000) {
    throw new KnowledgeHold();
  }
}
