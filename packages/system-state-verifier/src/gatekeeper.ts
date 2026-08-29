import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GovernanceStateReadBinding } from "om-governance-runtime";
import type {
  OMSystemStateVerificationReport,
  SystemStateVerifierSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";
import {
  parseVerifierApprovalIndependent,
  verifySystemStateBundle,
  type VerifierExpectedBindings,
} from "./verification.js";

const VERIFIER_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='18'><path d='M128 22 42 54v62c0 55 35 98 86 118 51-20 86-63 86-118V54z'/><path d='m83 127 29 29 61-67'/></svg>",
  ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export type StateVerifierEnv = {
  OM_STATE_READ?: GovernanceStateReadBinding;
  OM_GOVERNANCE_VERIFIER_APPROVAL?: string;
  OM_STATE_VERIFIER_FRESHNESS_SECONDS: string;
  OM_STATE_VERIFIER_APPROVAL_ID: string;
  OM_STATE_VERIFIER_ARTIFACT_REVISION: string;
  OM_STATE_VERIFIER_POLICY_HASH: string;
  OM_STATE_VERIFIER_ACCOUNT_ID: string;
  OM_STATE_VERIFIER_RUNTIME_WORKER: string;
  OM_STATE_VERIFIER_WORKER: string;
  OM_STATE_VERIFIER_ROUTER_WORKER: string;
  OM_STATE_VERIFIER_STAGE: string;
  OM_STATE_VERIFIER_CALLER_ID: string;
};

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be configured.`);
  return value;
}

export function expectedBindings(env: StateVerifierEnv): VerifierExpectedBindings {
  return {
    approvalId: required(env.OM_STATE_VERIFIER_APPROVAL_ID, "OM_STATE_VERIFIER_APPROVAL_ID"),
    artifactRevision: required(
      env.OM_STATE_VERIFIER_ARTIFACT_REVISION, "OM_STATE_VERIFIER_ARTIFACT_REVISION"),
    policyHash: required(env.OM_STATE_VERIFIER_POLICY_HASH, "OM_STATE_VERIFIER_POLICY_HASH"),
    accountId: required(env.OM_STATE_VERIFIER_ACCOUNT_ID, "OM_STATE_VERIFIER_ACCOUNT_ID"),
    runtimeWorkerName: required(
      env.OM_STATE_VERIFIER_RUNTIME_WORKER, "OM_STATE_VERIFIER_RUNTIME_WORKER"),
    verifierWorkerName: required(
      env.OM_STATE_VERIFIER_WORKER, "OM_STATE_VERIFIER_WORKER"),
    routerWorkerName: required(env.OM_STATE_VERIFIER_ROUTER_WORKER, "OM_STATE_VERIFIER_ROUTER_WORKER"),
    stage: required(env.OM_STATE_VERIFIER_STAGE, "OM_STATE_VERIFIER_STAGE"),
    callerId: required(env.OM_STATE_VERIFIER_CALLER_ID, "OM_STATE_VERIFIER_CALLER_ID"),
  };
}

export function freshnessSeconds(env: StateVerifierEnv): number {
  const value = Number(env.OM_STATE_VERIFIER_FRESHNESS_SECONDS);
  if (!Number.isSafeInteger(value) || value < 60 || value > 86_400) {
    throw new Error("OM_STATE_VERIFIER_FRESHNESS_SECONDS must be 60..86400.");
  }
  return value;
}

export async function readAndVerifyState(
  env: StateVerifierEnv,
  now = Date.now(),
  id: () => string = () => crypto.randomUUID(),
): Promise<OMSystemStateVerificationReport> {
  const stateRead = env.OM_STATE_READ;
  if (!stateRead) throw new Error("OM_STATE_READ service binding is required; no fallback is permitted.");
  const manifest = parseVerifierApprovalIndependent(
    env.OM_GOVERNANCE_VERIFIER_APPROVAL,
    expectedBindings(env),
    now,
  );
  const requestId = `OMSVQ-${id()}`;
  const bundle = await stateRead.getVerificationBundle({
    requestId,
    requestedAt: new Date(now).toISOString(),
  });
  if (bundle.requestId !== requestId) {
    throw new Error("verification bundle request binding mismatch.");
  }
  return verifySystemStateBundle(bundle, manifest, {
    now,
    freshnessSeconds: freshnessSeconds(env),
    id,
  });
}

export function describeVerifierVendor(): VendorDescription {
  return {
    displayName: "OM System State Verifier",
    url: "https://github.com/orionmatrix-ai/cloudflare-os-starter",
    logo: VERIFIER_ICON,
    color: "#e7f6ef",
    tagline: "Independent read-only OM System State integrity verification",
    description:
      "Verifies snapshot integrity and governance boundaries without exposing raw state or granting authority.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeVerifierAccount(): AccountDescription {
  return {
    displayName: "OM System State Verifier",
    avatar: VERIFIER_ICON,
    singleton: { tsType: "SystemStateVerifierSession" },
  };
}

@validateRpc()
export class SystemStateVerifierSessionImpl extends RpcTarget
    implements SystemStateVerifierSession {
  constructor(
    private readonly approvalQueue: ObservationQueue,
    private readonly env: StateVerifierEnv,
  ) {
    super();
  }

  async getVerificationReport(): Promise<OMSystemStateVerificationReport> {
    await this.approvalQueue.authorizeObservation({
      title: "Verify OM System State integrity",
      description:
        "Read the private current/previous state bundle and return only a redacted integrity report.",
    });
    return readAndVerifyState(this.env);
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class SystemStateVerifierGatekeeper extends DurableObject<Cloudflare.Env>
    implements Gatekeeper<SystemStateVerifierSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "om-system-state://current",
      title: "OM System State integrity",
      snippet: "Read-only; redacted report; no authority or execution effect.",
      suggestedBindingName: "OM_SYSTEM_STATE_VERIFIER",
      tsType: "SystemStateVerifierSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SystemStateVerifierSession> {
    return new SystemStateVerifierSessionImpl(approvalQueue.dup(), this.env);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(action: number): Promise<void> {
    throw new Error(`System State Verifier has no actions (${action}).`);
  }
  async rejectAction(_action: number): Promise<void> {}
  async revertAction(_action: number): Promise<void> {
    throw new Error("System State Verifier has no actions to revert.");
  }
}

@validateRpc()
export class SystemStateVerifierAccount extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeVerifierAccount();
  }

  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<SystemStateVerifierSession>>
  > {
    return this.ctx.exports.SystemStateVerifierGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("OM System State Verifier has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("OM System State Verifier has no resource configurator.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  reconnect(): Promise<{ url: string }> {
    throw new Error("OM System State Verifier has no credentials to reconnect.");
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SystemStateVerifierUserVerifier({});
  }
}

@validateRpc()
export class SystemStateVerifierUserVerifier extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> { return describeVerifierVendor(); }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SystemStateVerifierAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("OM System State Verifier is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
