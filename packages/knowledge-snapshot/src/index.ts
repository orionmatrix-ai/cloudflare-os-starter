import { WorkerEntrypoint } from "cloudflare:workers";
import type { KnowledgeEnv } from "./contracts.js";
import { handleKnowledgeMcp } from "./mcp.js";
export { GatekeeperVendor, KnowledgePilotAccount } from "./gateway.js";
export { KnowledgePilotLedger } from "./pilot-ledger.js";

/** Only an administrator-created service binding may supply the caller capability. */
export class KnowledgeSnapshotMcp extends WorkerEntrypoint<KnowledgeEnv, { callerId?: string }> {
  fetch(request: Request): Promise<Response> {
    return handleKnowledgeMcp(request, this.env, this.ctx.props?.callerId);
  }
}
// Public HTTP, Router proxying to the default export and forged headers cannot access the MCP.
export default { fetch(): Response { return new Response(null, { status: 404 }); } };
