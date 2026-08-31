import { describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LIMITS, type KnowledgeEnv, type ReadGrant, type Snapshot } from "../src/contracts.js";
import { prepareSnapshotCandidate, readApprovedDocument, sha256 } from "../src/snapshot.js";
import { handleKnowledgeMcp } from "../src/mcp.js";
import publicWorker, { KnowledgeSnapshotMcp } from "../src/index.js";
import { OaoKnowledgeSession } from "../src/oao-session.js";

const CALLER = "oao-evaluation-bridge";
async function fixture() {
  const now = Date.now();
  const text = "Synthetic procedure: review the checklist and return a proposal to the human.";
  const snapshot: Snapshot = {
    schemaVersion: "om.knowledge-snapshot.v1", snapshotId: "snapshot-synthetic-01",
    dataClass: "synthetic", createdAt: new Date(now - 2_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    documents: [{ id: "procedure-01", title: "Synthetic daily review", sourceRef: "synthetic-procedure-01",
      sourceRevision: "a".repeat(40), knowledgeStatus: "candidate", content: text,
      contentSha256: await sha256(text) }],
  };
  const candidate = await prepareSnapshotCandidate(snapshot, now);
  const grant: ReadGrant = {
    schemaVersion: "om.knowledge-read-grant.v1", approvalId: "synthetic-test-approval",
    purpose: "oao-knowledge-evaluation", deploymentId: "synthetic-deployment",
    callerId: CALLER, workPackageId: "synthetic-work-package", snapshotId: snapshot.snapshotId,
    snapshotSha256: candidate.snapshotSha256, documentIds: ["procedure-01"], dataClass: "synthetic",
    approvedAt: new Date(now - 1_000).toISOString(), expiresAt: snapshot.expiresAt, revoked: false,
  };
  const env: KnowledgeEnv = {
    KNOWLEDGE_ENABLED: "true", KNOWLEDGE_DEPLOYMENT_ID: grant.deploymentId,
    KNOWLEDGE_SNAPSHOT_JSON: candidate.snapshotJson, KNOWLEDGE_READ_GRANT_JSON: JSON.stringify(grant),
  };
  return { now, snapshot, grant, env, request: {
    workPackageId: grant.workPackageId,
    snapshotId: snapshot.snapshotId, snapshotSha256: candidate.snapshotSha256, documentId: "procedure-01",
  } };
}
const rpc = (body: unknown) => new Request("https://knowledge.internal/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body),
});
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-client", version: "1.0" },
} };

describe("snapshot and release boundary", () => {
  it("assembles only a Candidate; reads one digest-bound copy without promoting it", async () => {
    const { env, request, snapshot } = await fixture();
    const before = JSON.stringify(env);
    const candidate = await prepareSnapshotCandidate(snapshot);
    expect(candidate.approved).toBe(false);
    const result = await readApprovedDocument(env, CALLER, request);
    expect(result.document.content).toBe(snapshot.documents[0].content);
    expect(result).toMatchObject({ status: "OBSERVED_COPY", instructionAuthority: false,
      liveSourceVerified: false, canonicalPromotion: false, executionAuthorized: false });
    expect(JSON.stringify(env)).toBe(before);
  });
  for (const [name, change] of Object.entries({
    disabled: (e: KnowledgeEnv) => { e.KNOWLEDGE_ENABLED = "false"; },
    missingEnabled: (e: KnowledgeEnv) => { delete e.KNOWLEDGE_ENABLED; },
    missingGrant: (e: KnowledgeEnv) => { delete e.KNOWLEDGE_READ_GRANT_JSON; },
    missingSnapshot: (e: KnowledgeEnv) => { delete e.KNOWLEDGE_SNAPSHOT_JSON; },
    wrongDeployment: (e: KnowledgeEnv) => { e.KNOWLEDGE_DEPLOYMENT_ID = "another-deployment"; },
    malformedGrant: (e: KnowledgeEnv) => { e.KNOWLEDGE_READ_GRANT_JSON = "{"; },
    malformedSnapshot: (e: KnowledgeEnv) => { e.KNOWLEDGE_SNAPSHOT_JSON = "{"; },
    oversizedSnapshot: (e: KnowledgeEnv) => { e.KNOWLEDGE_SNAPSHOT_JSON = "x".repeat(LIMITS.snapshotJsonBytes + 1); },
    oversizedGrant: (e: KnowledgeEnv) => { e.KNOWLEDGE_READ_GRANT_JSON = "x".repeat(LIMITS.grantJsonBytes + 1); },
  })) it(`HOLD: ${name}`, async () => {
    const { env, request } = await fixture(); change(env);
    await expect(readApprovedDocument(env, CALLER, request)).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
  });
  for (const patch of [
    { revoked: true }, { callerId: "wrong-caller" }, { documentIds: ["another-document"] },
    { documentIds: ["procedure-01", "procedure-01"] }, { dataClass: "approved-evaluation-copy" },
    { snapshotSha256: `sha256:${"0".repeat(64)}` }, { snapshotId: "other-snapshot" },
    { expiresAt: "2020-01-01T00:00:00.000Z" }, { approvedAt: "2099-01-01T00:00:00.000Z" },
    { expiresAt: "2099-01-01T00:00:00.000Z" }, { approvalId: "" }, { purpose: "production" },
    { unexpected: true }, { workPackageId: "" },
  ]) it(`rejects altered grant ${JSON.stringify(patch)}`, async () => {
    const { env, grant, request } = await fixture();
    env.KNOWLEDGE_READ_GRANT_JSON = JSON.stringify({ ...grant, ...patch });
    await expect(readApprovedDocument(env, CALLER, request)).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
  });
  for (const patch of [
    { documentId: "../outside" }, { documentId: "https://example.com" }, { documentId: "another-document" },
    { snapshotSha256: `sha256:${"b".repeat(64)}` }, { snapshotId: "another-snapshot" },
    { callerId: CALLER }, { canonicalPromotion: true }, { documentId: "" }, { workPackageId: "wrong-task" },
  ]) it(`rejects unbound read ${JSON.stringify(patch)}`, async () => {
    const { env, request } = await fixture();
    await expect(readApprovedDocument(env, CALLER, { ...request, ...patch })).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
  });
  it("rejects missing binding identity and content drift even with a newly pinned bundle hash", async () => {
    const { env, snapshot, grant, request } = await fixture();
    await expect(readApprovedDocument(env, undefined, request)).rejects.toThrow("KNOWLEDGE_HOLD");
    snapshot.documents[0].content = "changed";
    env.KNOWLEDGE_SNAPSHOT_JSON = JSON.stringify(snapshot);
    grant.snapshotSha256 = await sha256(env.KNOWLEDGE_SNAPSHOT_JSON);
    env.KNOWLEDGE_READ_GRANT_JSON = JSON.stringify(grant);
    await expect(readApprovedDocument(env, CALLER, { ...request, snapshotSha256: grant.snapshotSha256 }))
      .rejects.toThrow("KNOWLEDGE_HOLD");
  });
  it("checks expiry after asynchronous validation, not only on entry", async () => {
    const { env, request, grant, now } = await fixture(); let calls = 0;
    await expect(readApprovedDocument(env, CALLER, request,
      () => ++calls > 1 ? Date.parse(grant.expiresAt) : now)).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  for (const kind of ["duplicate", "count", "bytes", "total", "path", "expiry", "future", "unknown"]) {
    it(`rejects invalid snapshot ${kind}`, async () => {
      const { snapshot, now } = await fixture();
      if (kind === "duplicate") snapshot.documents.push(snapshot.documents[0]);
      if (kind === "count") snapshot.documents = Array.from({ length: LIMITS.documents + 1 }, (_, i) => ({ ...snapshot.documents[0], id: `doc-${i}` }));
      if (kind === "bytes") {
        snapshot.documents[0].content = "字".repeat(400);
        snapshot.documents[0].contentSha256 = await sha256(snapshot.documents[0].content);
      }
      if (kind === "total") {
        const text = "x".repeat(700);
        snapshot.documents = await Promise.all(Array.from({ length: 3 }, async (_, i) => ({
          ...snapshot.documents[0], id: `doc-${i}`, content: text, contentSha256: await sha256(text),
        })));
      }
      if (kind === "path") snapshot.documents[0].sourceRef = "C:/secret";
      if (kind === "expiry") snapshot.expiresAt = new Date(now - 1).toISOString();
      if (kind === "future") snapshot.createdAt = new Date(now + 100).toISOString();
      const input = kind === "unknown" ? { ...snapshot, approval: true } : snapshot;
      await expect(prepareSnapshotCandidate(input, now)).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
    });
  }
});

describe("MCP transport", () => {
  it("public entry point never exposes MCP", () => expect(publicWorker.fetch().status).toBe(404));
  it("named Worker entrypoint uses binding props and fails closed when absent", async () => {
    const { env } = await fixture();
    const denied = new KnowledgeSnapshotMcp(createExecutionContext(), env);
    expect((await denied.fetch(rpc(initialize))).status).toBe(403);
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "props", { value: { callerId: CALLER } });
    const allowed = new KnowledgeSnapshotMcp(ctx, env);
    expect((await allowed.fetch(rpc(initialize))).status).toBe(200);
  });
  it("rejects forged identity headers, origin, wrong path and oversized body", async () => {
    const { env } = await fixture();
    const forged = rpc(initialize); forged.headers.set("x-caller-id", CALLER);
    expect((await handleKnowledgeMcp(forged, env, undefined)).status).toBe(403);
    const origin = rpc(initialize); origin.headers.set("origin", "https://example.com");
    expect((await handleKnowledgeMcp(origin, env, CALLER)).status).toBe(403);
    expect((await handleKnowledgeMcp(new Request("https://knowledge.internal/admin"), env, CALLER)).status).toBe(404);
    expect((await handleKnowledgeMcp(new Request("https://knowledge.internal/mcp"), env, CALLER)).status).toBe(405);
    expect((await handleKnowledgeMcp(rpc({ pad: "x".repeat(5_000) }), env, CALLER)).status).toBe(403);
  });
  for (const method of ["subscriptions/listen", "resources/read", "resources/subscribe", "unknown"]) {
    it(`rejects SDK-wide method ${method} without opening a stream`, async () => {
      const { env } = await fixture();
      const response = await handleKnowledgeMcp(rpc({ jsonrpc: "2.0", id: 1, method }), env, CALLER);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).not.toBe("text/event-stream");
      expect(await response.text()).toBe("KNOWLEDGE_HOLD");
    });
  }
  it("cancels a stalled request body and closes on its deadline", async () => {
    const { env } = await fixture(); let cancelled = false;
    vi.useFakeTimers();
    try {
      const response = handleKnowledgeMcp(new Request("https://knowledge.internal/mcp", {
        method: "POST", body: new ReadableStream({ cancel() { cancelled = true; } }),
      }), env, CALLER);
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1);
      expect((await response).status).toBe(403);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("propagates cancellation from the original request", async () => {
    const { env } = await fixture();
    const controller = new AbortController(); controller.abort();
    const response = await handleKnowledgeMcp(new Request(rpc(initialize), { signal: controller.signal }), env, CALLER);
    expect(response.status).toBe(403);
  });
  it("rejects JSON-RPC batches", async () => {
    const { env } = await fixture();
    expect((await handleKnowledgeMcp(rpc([initialize]), env, CALLER)).status).toBe(403);
  });
  it("SDK client handshake, tool discovery and exact read work without external fetch", async () => {
    const { env, request } = await fixture();
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://knowledge.internal/mcp"), {
      fetch: (url, init) => handleKnowledgeMcp(new Request(url, init), env, CALLER),
    });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      expect(catalog.tools.map(t => t.name)).toEqual(["read_approved_document"]);
      const result = await client.callTool({ name: "read_approved_document", arguments: request });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("OBSERVED_COPY");
      const denied = await client.callTool({ name: "read_approved_document", arguments: { ...request, documentId: "outside" } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("Synthetic procedure");
      await expect(client.callTool({ name: "write_document", arguments: {} })).rejects.toThrow();
    } finally { await client.close(); }
  });
});

describe("OAO observation adapter", () => {
  it("stops a stalled ObservationGate at the deadline without transport", async () => {
    const { request, grant } = await fixture(); let calls = 0;
    vi.useFakeTimers();
    try {
      const session = new OaoKnowledgeSession({ fetch: async () => { calls++; return new Response(); } },
        { authorizeObservation: () => new Promise(() => {}) }, request, grant.workPackageId);
      const rejected = expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1);
      await rejected;
      expect(calls).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("cancels a stalled protocol response at the deadline", async () => {
    const { request, grant } = await fixture(); let cancelled = false;
    vi.useFakeTimers();
    try {
      const session = new OaoKnowledgeSession({ fetch: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "application/json" } }) },
      { authorizeObservation: async () => {} }, request, grant.workPackageId);
      const rejected = expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
      await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1);
      await rejected;
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  for (const cleanup of ["immediate", "rejected", "pending"]) {
    const cancelBody = () => vi.fn(() => {
      if (cleanup === "rejected") return Promise.reject(new Error("synthetic cancellation failure"));
      if (cleanup === "pending") return new Promise<void>(() => {});
    });
    it(`releases a late response after timeout (${cleanup} cancellation)`, async () => {
      const { request, grant } = await fixture();
      const cancel = cancelBody();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      });
      let release!: (response: Response) => void;
      let incomingSignal: AbortSignal | undefined;
      const fetch = vi.fn(async (incoming: Request) => {
        incomingSignal = incoming.signal;
        return new Promise<Response>(resolve => { release = resolve; });
      });
      vi.useFakeTimers();
      try {
        const session = new OaoKnowledgeSession({ fetch },
          { authorizeObservation: async () => {} }, request, grant.workPackageId);
        const rejected = expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
        await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1);
        await rejected;
        expect(incomingSignal?.aborted).toBe(true);
        release(response);
        await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.body?.locked).toBe(false);
        await expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });
    it(`releases a rejected redirect body (${cleanup} cancellation)`, async () => {
      const { request, grant } = await fixture();
      const cancel = cancelBody();
      const response = new Response(new ReadableStream({ cancel }), {
        status: 302, headers: { location: "https://example.com", "content-type": "application/json" },
      });
      const fetch = vi.fn(async (incoming: Request) => {
        expect(incoming.redirect).toBe("manual");
        return response;
      });
      vi.useFakeTimers();
      try {
        const session = new OaoKnowledgeSession({ fetch },
          { authorizeObservation: async () => {} }, request, grant.workPackageId);
        const rejected = expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
        await vi.advanceTimersByTimeAsync(0);
        await rejected;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.body?.locked).toBe(false);
        await expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });
  }
  it("authorizes before transport and returns validated citations; one-use session by default", async () => {
    const { env, request, grant } = await fixture(); const events: string[] = [];
    const session = new OaoKnowledgeSession({ fetch: async incoming => {
      events.push("transport"); return handleKnowledgeMcp(incoming, env, CALLER);
    } }, { authorizeObservation: async () => { events.push("authorize"); } }, request, grant.workPackageId);
    expect((await session.read()).document.id).toBe(request.documentId);
    expect(events[0]).toBe("authorize");
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  it("denied observation causes zero MCP calls and consumes attempt budget", async () => {
    const { request, grant } = await fixture(); let calls = 0;
    const session = new OaoKnowledgeSession({ fetch: async () => { calls++; return new Response(); } },
      { authorizeObservation: async () => { throw new Error("denied"); } }, request, grant.workPackageId);
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
    expect(calls).toBe(0);
  });
  it("revalidates revocation after Human Gate and does not return text", async () => {
    const { env, request, grant } = await fixture();
    const session = new OaoKnowledgeSession({ fetch: r => handleKnowledgeMcp(r, env, CALLER) },
      { authorizeObservation: async () => { env.KNOWLEDGE_READ_GRANT_JSON = JSON.stringify({ ...grant, revoked: true }); } },
      request, grant.workPackageId);
    await expect(session.read()).rejects.toThrow(/^KNOWLEDGE_HOLD$/);
  });
  it("reserves attempt budget before concurrent calls", async () => {
    const { env, request, grant } = await fixture(); let authorizations = 0;
    const session = new OaoKnowledgeSession({ fetch: r => handleKnowledgeMcp(r, env, CALLER) },
      { authorizeObservation: async () => { authorizations++; } }, request, grant.workPackageId);
    const results = await Promise.allSettled([session.read(), session.read()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(authorizations).toBe(1);
  });
  it("rejects cross-work-package requests before content release", async () => {
    const { env, request } = await fixture();
    const session = new OaoKnowledgeSession({ fetch: r => handleKnowledgeMcp(r, env, CALLER) },
      { authorizeObservation: async () => {} }, { ...request, workPackageId: "another-work-package" }, "another-work-package");
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
  });
  it("rejects oversized protocol responses before SDK parsing", async () => {
    const { request, grant } = await fixture(); let cancelled = false;
    const session = new OaoKnowledgeSession({ fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }) },
    { authorizeObservation: async () => {} }, request, grant.workPackageId);
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
    expect(cancelled).toBe(true);
  });
  it("will not follow a redirect to an external endpoint", async () => {
    const { request, grant } = await fixture(); let calls = 0;
    const session = new OaoKnowledgeSession({ fetch: async incoming => {
      calls++; expect(incoming.redirect).toBe("manual");
      return Response.redirect("https://example.com", 302);
    } }, { authorizeObservation: async () => {} }, request, grant.workPackageId);
    await expect(session.read()).rejects.toThrow("KNOWLEDGE_HOLD");
    expect(calls).toBe(1);
  });
});
