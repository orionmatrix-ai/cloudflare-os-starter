import { describe, expect, it, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { GatekeeperVendor, KnowledgePilotAccount, KnowledgePilotUi } from "../src/gateway.js";
import { PILOT_HTML } from "../src/pilot-ui.js";
import { loadPilotScope, PILOT_CALLER, SYNTHETIC_CONTENT, SYNTHETIC_DOCUMENT_ID,
  requireUiAuthority, requireWorkshopCaller, type PilotEnv } from "../src/pilot.js";
import { prepareSnapshotCandidate, sha256 } from "../src/snapshot.js";
import { handleKnowledgeMcp } from "../src/mcp.js";
import type { TestLedger } from "./worker.js";

async function fixture() {
  const now = Date.now();
  const approvedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 3600000).toISOString();
  const snapshot = { schemaVersion: "om.knowledge-snapshot.v1", snapshotId: "synthetic-snapshot",
    dataClass: "synthetic", createdAt: new Date(now - 2000).toISOString(), expiresAt,
    documents: [{ id: SYNTHETIC_DOCUMENT_ID, sourceRef: SYNTHETIC_DOCUMENT_ID, title: "Synthetic only",
      sourceRevision: (await sha256(SYNTHETIC_CONTENT)).slice(7), knowledgeStatus: "candidate",
      content: SYNTHETIC_CONTENT, contentSha256: await sha256(SYNTHETIC_CONTENT) }] };
  const candidate = await prepareSnapshotCandidate(snapshot);
  const grant = { schemaVersion: "om.knowledge-read-grant.v1", approvalId: "human-test-approval",
    purpose: "oao-knowledge-evaluation", deploymentId: "synthetic-deployment", callerId: PILOT_CALLER,
    workPackageId: "synthetic-task", snapshotId: snapshot.snapshotId,
    snapshotSha256: candidate.snapshotSha256, documentIds: [SYNTHETIC_DOCUMENT_ID],
    dataClass: "synthetic", approvedAt, expiresAt, revoked: false };
  const approval = { schemaVersion: "om.knowledge-pilot-approval.v1", approvalId: grant.approvalId,
    artifactRevision: "a".repeat(40), deploymentId: grant.deploymentId,
    workshopWorker: "synthetic-workshop", knowledgeWorker: "synthetic-knowledge",
    workPackageId: grant.workPackageId, snapshotSha256: candidate.snapshotSha256,
    documentId: SYNTHETIC_DOCUMENT_ID, dataClass: "synthetic", approvedAt, expiresAt,
    maximumReads: 1, humanApproved: true, revoked: false };
  const config: PilotEnv = { KNOWLEDGE_ENABLED: "true", KNOWLEDGE_GATEWAY_ENABLED: "true",
    KNOWLEDGE_DEPLOYMENT_ID: grant.deploymentId, KNOWLEDGE_SNAPSHOT_JSON: candidate.snapshotJson,
    KNOWLEDGE_READ_GRANT_JSON: JSON.stringify(grant), KNOWLEDGE_PILOT_APPROVAL_JSON: JSON.stringify(approval),
    KNOWLEDGE_APPROVAL_ID: approval.approvalId, KNOWLEDGE_ARTIFACT_REVISION: approval.artifactRevision,
    KNOWLEDGE_WORKSHOP_WORKER: approval.workshopWorker, KNOWLEDGE_WORKER: approval.knowledgeWorker };
  const ledger = (env as unknown as { TEST_LEDGER: DurableObjectNamespace<TestLedger> })
    .TEST_LEDGER.getByName(crypto.randomUUID());
  await ledger.configure(config);
  return { config, ledger, approval, grant, snapshot };
}
const active = { isAccountActive: async () => true, revokeAccount: async () => {} };

describe("synthetic pilot authorization", () => {
  for (const patch of [
    { KNOWLEDGE_GATEWAY_ENABLED: "false" }, { KNOWLEDGE_GATEWAY_ENABLED: undefined },
    { KNOWLEDGE_PILOT_APPROVAL_JSON: undefined }, { KNOWLEDGE_PILOT_APPROVAL_JSON: "{" },
    { KNOWLEDGE_ARTIFACT_REVISION: "b".repeat(40) }, { KNOWLEDGE_APPROVAL_ID: "different" },
    { KNOWLEDGE_WORKSHOP_WORKER: "different" }, { KNOWLEDGE_WORKER: "different" },
  ]) it(`fails closed for configuration ${JSON.stringify(patch)}`, async () => {
    const { config } = await fixture();
    await expect(loadPilotScope({ ...config, ...patch })).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  for (const patch of [ { maximumReads: 2 }, { humanApproved: false }, { revoked: true },
    { extra: true }, { dataClass: "approved-evaluation-copy" }, { documentId: "other" },
    { workPackageId: "other" }, { snapshotSha256: "sha256:" + "0".repeat(64) },
    { approvedAt: "2020-01-01T00:00:00.000Z" } ]) it(`rejects approval ${JSON.stringify(patch)}`, async () => {
    const { config, approval } = await fixture();
    config.KNOWLEDGE_PILOT_APPROVAL_JSON = JSON.stringify({ ...approval, ...patch });
    await expect(loadPilotScope(config)).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  it("rejects real-looking data even if relabeled synthetic and hashes are recomputed", async () => {
    const { config, snapshot, grant, approval } = await fixture();
    snapshot.documents[0].content = "An actual source document must not enter this pilot.";
    snapshot.documents[0].contentSha256 = await sha256(snapshot.documents[0].content);
    const copy = await prepareSnapshotCandidate(snapshot);
    config.KNOWLEDGE_SNAPSHOT_JSON = copy.snapshotJson;
    config.KNOWLEDGE_READ_GRANT_JSON = JSON.stringify({ ...grant, snapshotSha256: copy.snapshotSha256 });
    config.KNOWLEDGE_PILOT_APPROVAL_JSON = JSON.stringify({ ...approval, snapshotSha256: copy.snapshotSha256 });
    await expect(loadPilotScope(config)).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  it("requires trusted Workshop props and a current admin UI capability", async () => {
    const { config } = await fixture();
    expect(() => requireWorkshopCaller(config, "spoofed-header")).toThrow();
    expect(() => requireWorkshopCaller(config, undefined)).toThrow();
    expect(() => requireUiAuthority(false, Date.now())).toThrow();
    expect(() => requireUiAuthority(true, Date.now() - 60001)).toThrow();
    expect(() => requireUiAuthority(true, Number.NaN)).toThrow();
    expect(() => requireUiAuthority(true, Date.now() + 10000)).toThrow();
    expect(() => requireWorkshopCaller(config, config.KNOWLEDGE_WORKSHOP_WORKER)).not.toThrow();
  });
  it("registers management UI only; never an agent singleton or auth provider", async () => {
    const { config } = await fixture();
    const context = createExecutionContext();
    Object.defineProperty(context, "props", { value: { callerId: config.KNOWLEDGE_WORKSHOP_WORKER } });
    const vendor = new GatekeeperVendor(context, config);
    expect(await vendor.describe()).toMatchObject({ autoProvisionsAccount: true, providesAuth: false });
    const accountContext = createExecutionContext();
    Object.defineProperty(accountContext, "props", { value: { callerId: config.KNOWLEDGE_WORKSHOP_WORKER, owner: crypto.randomUUID() } });
    const account = new KnowledgePilotAccount(accountContext, config);
    expect(await account.describe()).not.toHaveProperty("singleton");
    await expect(account.startAppUi({ isAdmin: false })).rejects.toThrow();
    expect(PILOT_HTML).toContain("textContent");
    expect(PILOT_HTML).not.toMatch(/innerHTML|https:\/\/cdn|fetch\(/);
  });
});

describe("durable bounded pilot", () => {
  it("reserves at most once across concurrent callers/sessions and leaves bounded evidence", async () => {
    const { config, ledger } = await fixture();
    const scope = await loadPilotScope(config), owner = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => ledger.reserve(owner, scope.approvalHash)));
    expect(results.filter(r => r)).toHaveLength(1);
    await ledger.finish(owner, scope.approvalHash, false);
    await expect(ledger.finish(owner, scope.approvalHash, false)).resolves.toBeNull();
    await expect(ledger.reserve(crypto.randomUUID(), scope.approvalHash)).resolves.toBe(false);
    expect(await ledger.receipt(crypto.randomUUID())).toBeNull();
    const receipt = await ledger.receipt(owner);
    expect(receipt?.status).toBe("FAILED");
    expect(JSON.stringify(receipt)).not.toContain(SYNTHETIC_CONTENT);
  });
  it("revalidates approval in the ledger before reservation", async () => {
    const { config, ledger } = await fixture();
    const scope = await loadPilotScope(config);
    await ledger.configure({ KNOWLEDGE_GATEWAY_ENABLED: "false" });
    await expect(ledger.reserve(crypto.randomUUID(), scope.approvalHash)).resolves.toBe(false);
  });
  it("revokes an account across later UI sessions", async () => {
    const { ledger } = await fixture();
    expect(await ledger.isAccountActive()).toBe(true); await ledger.revokeAccount();
    expect(await ledger.isAccountActive()).toBe(false);
  });
  it("runs the real MCP client then records success without body persistence", async () => {
    const { config, ledger } = await fixture(); const owner = crypto.randomUUID();
    const fetch = vi.fn((request: Request) => handleKnowledgeMcp(request, config, PILOT_CALLER));
    const ui = new KnowledgePilotUi(config, owner, true, ledger, active, { fetch });
    const description = await ui.describeRead();
    const result = await ui.readSynthetic(description.approvalHash);
    expect(result.result.document.content).toBe(SYNTHETIC_CONTENT);
    expect(result.receipt.status).toBe("OBSERVED_COPY");
    expect(await ui.getReceipt()).toEqual(result.receipt);
    const count = fetch.mock.calls.length;
    const second = new KnowledgePilotUi(config, owner, true, ledger, active, { fetch });
    await expect(second.readSynthetic(description.approvalHash)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("denies non-admin and revoked accounts before transport", async () => {
    const { config, ledger } = await fixture(); const fetch = vi.fn();
    for (const [admin, account] of [[false, active], [true, { ...active,
      isAccountActive: async () => false }]] as const) {
      const ui = new KnowledgePilotUi(config, crypto.randomUUID(), admin, ledger, account, { fetch });
      await expect(ui.readSynthetic("wrong")).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("withholds delivery if the account is revoked during durable success recording", async () => {
    const { config, ledger } = await fixture(); const owner = crypto.randomUUID();
    let activeAccount = true;
    const recordingLedger = {
      reserve: (id: string, hash: string) => ledger.reserve(id, hash),
      receipt: (id: string) => ledger.receipt(id),
      finish: async (id: string, hash: string, success: boolean) => {
        const receipt = await ledger.finish(id, hash, success);
        activeAccount = false;
        return receipt;
      },
    };
    const ui = new KnowledgePilotUi(config, owner, true, recordingLedger,
      { ...active, isAccountActive: async () => activeAccount },
      { fetch: (request: Request) => handleKnowledgeMcp(request, config, PILOT_CALLER) });
    await expect(ui.readSynthetic((await ui.describeRead()).approvalHash)).rejects.toThrow();
    // MCP observation succeeded; this receipt does not assert successful UI delivery.
    expect((await ledger.receipt(owner))?.status).toBe("OBSERVED_COPY");
    expect(await ledger.reserve(owner, (await loadPilotScope(config)).approvalHash)).toBe(false);
  });
  it("does not read after approval changes between displayed scope and click", async () => {
    const { config, ledger, approval } = await fixture(); const fetch = vi.fn();
    const ui = new KnowledgePilotUi(config, crypto.randomUUID(), true, ledger, active, { fetch });
    const description = await ui.describeRead();
    config.KNOWLEDGE_PILOT_APPROVAL_JSON = JSON.stringify({ ...approval, maximumReads: 2 });
    await expect(ui.readSynthetic(description.approvalHash)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not send tools/call after account revocation following MCP initialize", async () => {
    const { config, ledger } = await fixture(); const owner = crypto.randomUUID();
    let activeAccount = true;
    const methods: string[] = [];
    const binding = { fetch: async (request: Request) => {
      const message = await request.clone().json() as { method?: string };
      methods.push(message.method ?? "");
      const response = await handleKnowledgeMcp(request, config, PILOT_CALLER);
      if (message.method === "initialize") activeAccount = false;
      return response;
    } };
    const ui = new KnowledgePilotUi(config, owner, true, ledger,
      { ...active, isAccountActive: async () => activeAccount }, binding);
    await expect(ui.readSynthetic((await ui.describeRead()).approvalHash)).rejects.toThrow();
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("tools/call");
    expect((await ledger.receipt(owner))?.status).toBe("FAILED");
  });
  it("records a single failure and never retries after a transport error", async () => {
    const { config, ledger } = await fixture(); const owner = crypto.randomUUID();
    const fetch = vi.fn(async () => { throw new Error("network"); });
    const ui = new KnowledgePilotUi(config, owner, true, ledger, active, { fetch });
    const scope = await ui.describeRead();
    await expect(ui.readSynthetic(scope.approvalHash)).rejects.toThrow();
    expect((await ui.getReceipt())?.status).toBe("FAILED");
    await expect(ui.readSynthetic(scope.approvalHash)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
