import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  KnowledgeHold, LIMITS, readRequestSchema, readResultSchema,
  type ReadRequest, type ReadResult,
} from "./contracts.js";
import { sha256 } from "./snapshot.js";

export interface SnapshotBinding { fetch(request: Request): Promise<Response>; }
export interface ObservationGate {
  authorizeObservation(description: { title: string; description: string }): Promise<void>;
}

/** Bound bytes before SDK parsing. Legacy MCP may return finite SSE even in JSON mode. */
async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.status === 202 || response.status === 204) {
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status });
  }
  if (!["application/json", "text/event-stream"].includes(
    response.headers.get("content-type")?.split(";")[0].trim() ?? "")) {
    void response.body?.cancel().catch(() => {});
    throw new KnowledgeHold();
  }
  const reader = response.body?.getReader();
  if (!reader || signal.aborted) throw new KnowledgeHold();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new KnowledgeHold();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMITS.responseBytes) { abort(); throw new KnowledgeHold(); }
      parts.push(next.value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new Response(bytes, { status: response.status, headers: response.headers });
}

/** Server-owned session adapter; not a public RPC export and not a substitute for user ACLs.
 * Its work package, document scope and budget must be fixed by the owning OAO Gatekeeper.
 */
export class OaoKnowledgeSession {
  #used = 0;
  #binding: SnapshotBinding;
  #gate: ObservationGate;
  #scope: ReadRequest;
  #maxReads: number;
  #workPackageId: string;
  constructor(binding: SnapshotBinding, gate: ObservationGate,
    scope: ReadRequest, workPackageId: string, maxReads = 1) {
    this.#binding = binding;
    this.#gate = gate;
    this.#scope = readRequestSchema.parse(scope);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(workPackageId) || this.#scope.workPackageId !== workPackageId ||
        !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > LIMITS.sessionReads) {
      throw new KnowledgeHold();
    }
    this.#maxReads = maxReads;
    this.#workPackageId = workPackageId;
  }

  async read(): Promise<ReadResult> {
    // Reserve before awaiting, including failed/parallel attempts. Never retry or auto-fallback.
    if (++this.#used > this.#maxReads) throw new KnowledgeHold();
    const deadline = Date.now() + LIMITS.timeoutMs;
    const controller = new AbortController();
    const client = new Client({ name: "om-oao-knowledge-adapter", version: "0.1.0" });
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new KnowledgeHold()), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    try {
      return await Promise.race([timeout, (async () => {
        await this.#gate.authorizeObservation({
          title: "Read approved Knowledge evaluation copy",
          description: "One fixed document and snapshot; no live Vault access or write operation.",
        });
        if (controller.signal.aborted) throw new KnowledgeHold();
        const transport = new StreamableHTTPClientTransport(new URL("https://knowledge.internal/mcp"), {
          fetch: async (url, init) => {
            if (controller.signal.aborted || String(url) !== "https://knowledge.internal/mcp") {
              throw new KnowledgeHold();
            }
            // No global fetch, OAuth endpoint, redirects or caller-controlled destination.
            const response = await this.#binding.fetch(new Request(url, {
              ...init, signal: controller.signal, redirect: "manual",
            }));
            if (response.status >= 300 && response.status < 400) throw new KnowledgeHold();
            return boundedResponse(response, controller.signal);
          },
        });
        await client.connect(transport);
        if (controller.signal.aborted) throw new KnowledgeHold();
        const result = await client.callTool({ name: "read_approved_document", arguments: this.#scope });
        if (controller.signal.aborted || result.isError || !Array.isArray(result.content) ||
            result.content.length !== 1 || result.content[0]?.type !== "text") throw new KnowledgeHold();
        const text = result.content[0].text;
        if (typeof text !== "string" || text.length > 32_768) throw new KnowledgeHold();
        const read = readResultSchema.parse(JSON.parse(text));
        if (read.document.id !== this.#scope.documentId || read.snapshotId !== this.#scope.snapshotId ||
            read.snapshotSha256 !== this.#scope.snapshotSha256 || read.workPackageId !== this.#workPackageId ||
            await sha256(read.document.content) !== read.document.contentSha256 ||
            Date.parse(read.observedAt) > Date.now() || Date.now() >= Date.parse(read.expiresAt) ||
            Date.now() >= deadline || controller.signal.aborted) throw new KnowledgeHold();
        return read;
      })()]);
    } catch { throw new KnowledgeHold(); }
    finally {
      clearTimeout(timer);
      controller.abort();
      await client.close().catch(() => {});
    }
  }
}
