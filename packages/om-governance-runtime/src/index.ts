import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  GovernanceRuntimeBinding,
  GovernancePolicy,
  AttestedPermitAuthorization,
  ObservationIntent,
  ObservationIntentRequest,
  ObservationOutcome,
  PermitAuthorizationRequest,
  PermitConsumption,
  PermitConsumptionRequest,
  PurgeResult,
  StateSnapshot,
} from "./contracts.js";
import {
  GovernanceEngine,
  deploymentBindingFingerprint,
  parseDeploymentApproval,
  parsePolicyTemplate,
  parseRetentionControl,
  type GovernanceStore,
  type GovernanceTransactionStore,
} from "./core.js";

export * from "./contracts.js";
export * from "./core.js";

interface GovernanceEnv {
  GOVERNANCE_STATE: DurableObjectNamespace<GovernanceRuntimeState>;
  OM_GOVERNANCE_POLICY: string;
  OM_GOVERNANCE_DEPLOYMENT_APPROVAL?: string;
  OM_GOVERNANCE_RETENTION_CONTROL?: string;
  OM_GOVERNANCE_ACCOUNT_ID: string;
  OM_GOVERNANCE_RUNTIME_WORKER: string;
  OM_GOVERNANCE_ADAPTER_WORKER: string;
  OM_GOVERNANCE_STAGE: string;
  OM_GOVERNANCE_RETENTION_APPROVAL_ID: string;
  P3_SPREADSHEET_ID?: string;
  P3_ALLOWED_RANGE?: string;
}

interface GovernanceBindingProps {
  callerId: string;
}

class DurableGovernanceStore implements GovernanceStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.storage.put(key, value);
  }

  delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    return this.storage.list<T>(options);
  }

  transaction<T>(closure: (store: GovernanceTransactionStore) => Promise<T>): Promise<T> {
    return this.storage.transaction((transaction) => closure({
      get: <V>(key: string) => transaction.get<V>(key),
      put: async <V>(key: string, value: V) => { await transaction.put(key, value); },
      delete: (key: string) => transaction.delete(key),
      list: <V>(options?: { prefix?: string; limit?: number }) => transaction.list<V>(options),
    }));
  }
}

export class GovernanceRuntimeState extends DurableObject<GovernanceEnv> {
  private readonly engine: GovernanceEngine;
  private readonly state: DurableObjectState;
  private readonly runtimeEnv: GovernanceEnv;
  private readonly policy: GovernancePolicy;

  constructor(ctx: DurableObjectState, env: GovernanceEnv) {
    super(ctx, env);
    this.state = ctx;
    this.runtimeEnv = env;
    this.policy = parsePolicyTemplate(
      env.OM_GOVERNANCE_POLICY,
      env.P3_SPREADSHEET_ID,
      env.P3_ALLOWED_RANGE,
    );
    this.engine = new GovernanceEngine(new DurableGovernanceStore(ctx.storage), this.policy);
  }

  private async scheduleRetentionAlarm(when: string): Promise<void> {
    const candidate = Date.parse(when);
    const current = await this.state.storage.getAlarm();
    if (current === null || candidate < current) await this.state.storage.setAlarm(candidate);
  }

  async prepareObservation(input: ObservationIntent) {
    return this.state.blockConcurrencyWhile(async () => {
      const preparation = await this.engine.prepareObservation(input);
      await this.scheduleRetentionAlarm(preparation.retentionExpiresAt);
      return preparation;
    });
  }

  authorizeObservationAttested(input: AttestedPermitAuthorization) {
    return this.state.blockConcurrencyWhile(() => this.engine.authorizeObservation(input));
  }

  consumeObservationPermit(input: PermitConsumption) {
    return this.state.blockConcurrencyWhile(() => this.engine.consumeObservationPermit(input));
  }

  recordObservationOutcome(input: ObservationOutcome) {
    return this.state.blockConcurrencyWhile(() => this.engine.recordObservationOutcome(input));
  }

  getStateSnapshot(): Promise<StateSnapshot> {
    return this.state.blockConcurrencyWhile(() => this.engine.getStateSnapshot());
  }

  alarm(): Promise<void> {
    return this.state.blockConcurrencyWhile(async () => {
      let result: PurgeResult;
      try {
        const bindingFingerprint = await deploymentBindingFingerprint(this.policy);
        const control = parseRetentionControl(this.runtimeEnv.OM_GOVERNANCE_RETENTION_CONTROL, {
          retentionApprovalId: this.runtimeEnv.OM_GOVERNANCE_RETENTION_APPROVAL_ID,
          policyHash: this.policy.policyHash,
          deploymentBindingFingerprint: bindingFingerprint,
          accountId: this.runtimeEnv.OM_GOVERNANCE_ACCOUNT_ID,
          runtimeWorkerName: this.runtimeEnv.OM_GOVERNANCE_RUNTIME_WORKER,
          stage: this.runtimeEnv.OM_GOVERNANCE_STAGE,
        });
        result = await this.engine.purgeExpiredRecords(control);
      } catch (error) {
        result = await this.engine.recordRetentionControlFailure();
        console.error(JSON.stringify({
          event: "om_governance_retention_purge_failed_closed",
          purgeRunId: result.evidence.purgeRunId,
          errorCode: result.evidence.errorCode,
        }));
      }
      await this.state.storage.setAlarm(Date.parse(result.nextAlarmAt));
    });
  }
}

export class GovernanceRuntimeService extends WorkerEntrypoint<GovernanceEnv, GovernanceBindingProps>
    implements GovernanceRuntimeBinding {
  private bindingFingerprint?: Promise<string>;
  private parsedPolicy?: GovernancePolicy;

  private policy(): GovernancePolicy {
    this.parsedPolicy ??= parsePolicyTemplate(
      this.env.OM_GOVERNANCE_POLICY,
      this.env.P3_SPREADSHEET_ID,
      this.env.P3_ALLOWED_RANGE,
    );
    return this.parsedPolicy;
  }

  private assertCaller(): void {
    if (this.ctx.props.callerId !== this.policy().trustedCallerId) {
      throw new Error("Governance Runtime caller is not trusted.");
    }
  }

  private currentBindingFingerprint(): Promise<string> {
    this.bindingFingerprint ??= deploymentBindingFingerprint(this.policy());
    return this.bindingFingerprint;
  }

  private async runtime(): Promise<DurableObjectStub<GovernanceRuntimeState>> {
    const fingerprint = await this.currentBindingFingerprint();
    const policy = this.policy();
    parseDeploymentApproval(this.env.OM_GOVERNANCE_DEPLOYMENT_APPROVAL, {
      approvalId: policy.deploymentApprovalReference,
      policyHash: policy.policyHash,
      deploymentBindingFingerprint: fingerprint,
      accountId: this.env.OM_GOVERNANCE_ACCOUNT_ID,
      runtimeWorkerName: this.env.OM_GOVERNANCE_RUNTIME_WORKER,
      adapterWorkerName: this.env.OM_GOVERNANCE_ADAPTER_WORKER,
      stage: this.env.OM_GOVERNANCE_STAGE,
    });
    return this.env.GOVERNANCE_STATE.getByName(`om-inc:${fingerprint}`);
  }

  async prepareObservation(input: ObservationIntentRequest) {
    this.assertCaller();
    const bindingFingerprintValue = await this.currentBindingFingerprint();
    return (await this.runtime()).prepareObservation({
      ...input,
      deploymentBindingFingerprint: bindingFingerprintValue,
    });
  }

  async authorizeObservation(input: PermitAuthorizationRequest) {
    this.assertCaller();
    const bindingFingerprintValue = await this.currentBindingFingerprint();
    return (await this.runtime()).authorizeObservationAttested({
      ...input,
      deploymentBindingFingerprint: bindingFingerprintValue,
      gate: { ...input.gate, attestedBy: this.ctx.props.callerId },
    });
  }

  async consumeObservationPermit(input: PermitConsumptionRequest) {
    this.assertCaller();
    const bindingFingerprintValue = await this.currentBindingFingerprint();
    return (await this.runtime()).consumeObservationPermit({
      ...input,
      deploymentBindingFingerprint: bindingFingerprintValue,
    });
  }

  async recordObservationOutcome(input: ObservationOutcome) {
    this.assertCaller();
    return (await this.runtime()).recordObservationOutcome(input);
  }

  async getStateSnapshot(): Promise<StateSnapshot> {
    this.assertCaller();
    return (await this.runtime()).getStateSnapshot();
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ service: "om-governance-runtime", status: "private-service-binding-only" });
  },
};
