import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { AccountDescription, AppUiContext, GatekeeperUiFrame, GatekeeperUser,
  GatekeeperUserVerifier, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { KnowledgeHold, type ReadResult } from "./contracts.js";
import { OaoKnowledgeSession, type SnapshotBinding } from "./oao-session.js";
import { loadPilotScope, PILOT_CALLER, requireUiAuthority, requireWorkshopCaller,
  type PilotEnv } from "./pilot.js";
import type { KnowledgePilotLedger, PilotReceipt } from "./pilot-ledger.js";
import { PILOT_HTML } from "./pilot-ui.js";

const ICON = { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext x='3' y='26'%3EK%3C/text%3E%3C/svg%3E" };
type Ledger = Pick<KnowledgePilotLedger, "reserve" | "finish" | "receipt">;
type AccountState = Pick<KnowledgePilotLedger, "isAccountActive" | "revokeAccount">;
export type PilotReadOutput = { result: ReadResult; receipt: PilotReceipt };

@validateRpc()
export class KnowledgePilotUi extends RpcTarget {
  readonly #openedAt = Date.now();
  #used = false;
  constructor(private readonly env: PilotEnv, private readonly owner: string,
    private readonly isAdmin: boolean, private readonly ledger: Ledger,
    private readonly account: AccountState, private readonly binding: SnapshotBinding) { super(); }

  async #authorize(): Promise<void> {
    requireUiAuthority(this.isAdmin, this.#openedAt);
    if (!await this.account.isAccountActive()) throw new KnowledgeHold();
    requireUiAuthority(this.isAdmin, this.#openedAt);
  }
  async describeRead(): Promise<{ approvalHash: string; documentId: string; workPackageId: string; expiresAt: string }> {
    await this.#authorize();
    const scope = await loadPilotScope(this.env);
    return { approvalHash: scope.approvalHash, documentId: scope.request.documentId,
      workPackageId: scope.request.workPackageId, expiresAt: scope.expiresAt };
  }
  async readSynthetic(expectedApprovalHash: string): Promise<PilotReadOutput> {
    await this.#authorize();
    if (this.#used) throw new KnowledgeHold();
    this.#used = true;
    const scope = await loadPilotScope(this.env);
    if (expectedApprovalHash !== scope.approvalHash) throw new KnowledgeHold();
    if (!await this.ledger.reserve(this.owner, scope.approvalHash)) throw new KnowledgeHold();
    try {
      const revalidate = async () => {
        await this.#authorize();
        if ((await loadPilotScope(this.env)).approvalHash !== scope.approvalHash) throw new KnowledgeHold();
      };
      const guardedBinding: SnapshotBinding = { fetch: async (request) => {
        await revalidate();
        return this.binding.fetch(request);
      } };
      const session = new OaoKnowledgeSession(guardedBinding,
        { authorizeObservation: revalidate }, scope.request, scope.request.workPackageId, 1);
      const result = await session.read();
      await revalidate();
      const receipt = await this.ledger.finish(this.owner, scope.approvalHash, true);
      if (!receipt) throw new KnowledgeHold();
      await revalidate();
      return { result, receipt };
    } catch {
      await this.ledger.finish(this.owner, scope.approvalHash, false).catch(() => {});
      throw new KnowledgeHold();
    }
  }
  async getReceipt(): Promise<PilotReceipt | null> {
    await this.#authorize();
    return this.ledger.receipt(this.owner);
  }
}

type AccountProps = { owner: string; callerId: string };
@validateRpc()
export class KnowledgePilotAccount extends WorkerEntrypoint<PilotEnv, AccountProps> implements GatekeeperUser {
  #check(): void { requireWorkshopCaller(this.env, this.ctx.props.callerId); }
  #account() { return this.ctx.exports.KnowledgePilotLedger.getByName("account:" + this.ctx.props.owner); }
  async describe(): Promise<AccountDescription> {
    this.#check();
    return { displayName: "OM Knowledge synthetic pilot", avatar: ICON,
      providesUi: { title: "Knowledge synthetic pilot", icon: ICON } };
  }
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    this.#check();
    requireUiAuthority(context.isAdmin, Date.now());
    if (!await this.#account().isAccountActive()) throw new KnowledgeHold();
    return { iframeHtml: PILOT_HTML, ui: new RpcStub(new KnowledgePilotUi(this.env,
      this.ctx.props.owner, context.isAdmin, this.ctx.exports.KnowledgePilotLedger.getByName("pilot"),
      this.#account(), this.ctx.exports.KnowledgeSnapshotMcp({ props: { callerId: PILOT_CALLER } }))) };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new KnowledgeHold(); }
  startResourceConfigurator(_pattern: string): never { throw new KnowledgeHold(); }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { throw new KnowledgeHold(); }
  async revoke(): Promise<void> { this.#check(); await this.#account().revokeAccount(); }
  reconnect(): never { throw new KnowledgeHold(); }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { throw new KnowledgeHold(); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<PilotEnv, { callerId?: string }> {
  async describe(): Promise<VendorDescription> {
    requireWorkshopCaller(this.env, this.ctx.props.callerId);
    return { displayName: "OM Knowledge synthetic pilot", url: "https://github.com/orionmatrix-ai/cloudflare-os-starter",
      logo: ICON, autoProvisionsAccount: true, providesAuth: false,
      description: "Admin-only manual synthetic read. No agent singleton, AI call or live Vault access." };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    requireWorkshopCaller(this.env, this.ctx.props.callerId);
    return this.ctx.exports.KnowledgePilotAccount({ props: {
      owner: crypto.randomUUID(), callerId: this.env.KNOWLEDGE_WORKSHOP_WORKER!,
    } });
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return "// No agent capability is provided."; }
}
