import { DurableObject } from "cloudflare:workers";
import { KnowledgeHold } from "./contracts.js";
import { loadPilotScope, type PilotEnv } from "./pilot.js";

export type PilotReceipt = {
  status: "RESERVED" | "OBSERVED_COPY" | "FAILED";
  approvalId: string; approvalHash: string; workPackageId: string;
  snapshotSha256: string; documentId: string; reservedAt: string; completedAt?: string;
};
type StoredAttempt = { owner: string; receipt: PilotReceipt };

/** One deployment-global attempt, plus one boolean in each per-account revocation object.
 * No lists, body storage, retry log, automatic purge or implicit quota reset. */
export class KnowledgePilotLedger extends DurableObject<PilotEnv> {
  async revokeAccount(): Promise<void> { await this.ctx.storage.put("revoked", true); }
  async isAccountActive(): Promise<boolean> {
    return !await this.ctx.storage.get("revoked");
  }
  async hasAttempt(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get("attempt"));
  }
  async reserve(owner: string, approvalHash: string): Promise<boolean> {
    try {
    const scope = await loadPilotScope(this.env);
    if (!/^[a-f0-9-]{36}$/.test(owner) || scope.approvalHash !== approvalHash) throw new KnowledgeHold();
    return await this.ctx.storage.transaction(async txn => {
      if (await txn.get("attempt") || Date.now() >= Date.parse(scope.expiresAt)) return false;
      await txn.put("attempt", { owner, receipt: {
        status: "RESERVED", approvalId: scope.approvalId, approvalHash,
        workPackageId: scope.request.workPackageId, snapshotSha256: scope.request.snapshotSha256,
        documentId: scope.request.documentId, reservedAt: new Date().toISOString(),
      } } satisfies StoredAttempt);
      return true;
    });
    } catch { return false; }
  }
  async finish(owner: string, approvalHash: string, succeeded: boolean): Promise<PilotReceipt | null> {
    const scope = succeeded ? await loadPilotScope(this.env).catch(() => null) : null;
    if (succeeded && (!scope || scope.approvalHash !== approvalHash)) return null;
    // Even failure evidence cannot be overwritten by arbitrary retries.
    return this.ctx.storage.transaction(async txn => {
      const row = await txn.get<StoredAttempt>("attempt");
      if (!row || row.owner !== owner || row.receipt.approvalHash !== approvalHash ||
          row.receipt.status !== "RESERVED" ||
          succeeded && Date.now() >= Date.parse(scope!.expiresAt)) return null;
      row.receipt.status = succeeded ? "OBSERVED_COPY" : "FAILED";
      row.receipt.completedAt = new Date().toISOString();
      await txn.put("attempt", row);
      return row.receipt;
    });
  }
  async receipt(owner: string): Promise<PilotReceipt | null> {
    const row = await this.ctx.storage.get<StoredAttempt>("attempt");
    return row?.owner === owner ? row.receipt : null;
  }
}
