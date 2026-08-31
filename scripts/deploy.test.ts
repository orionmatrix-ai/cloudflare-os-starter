import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import {
  aiGatewayPlan,
  buildCommands,
  generateConfigs,
  governancePolicyHash,
  validateConfig,
} from "./deploy.ts";
import type {
  BaseConfigs,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
} from "./deployment-config.ts";

const validConfig: DeploymentConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicBaseUrl: null,
  workers: {
    router: { name: "acme-cloudflare-os", route: { customDomain: "os.example.com" } },
    workshop: { name: "acme-cloudflare-os-backend" },
    context: { name: "acme-cloudflare-os-context" },
    scheduler: { name: "acme-cloudflare-os-scheduler" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    googleSheetsGuard: { name: "acme-cloudflare-os-google-sheets" },
    omGovernanceRuntime: { name: "acme-cloudflare-os-governance" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
  },
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com"],
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: null,
    providers: ["anthropic", "cloudflare"],
  },
  context: {
    sharingDomain: null,
    kvNamespaceId: "context-kv-id",
    artifacts: { enabled: true, namespace: "acme-context-collections" },
  },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  googleSheetsGuard: { enabled: false },
  governanceRuntime: { enabled: false },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

/**
 * A copy of {@link validConfig} with `mutate` applied, typed loosely on purpose.
 *
 * Most of these variants assign something `DeploymentConfig` forbids, which is exactly what
 * `validateConfig` exists to catch: `deployment.jsonc` is hand-edited JSONC with no schema behind
 * it, so the type describes the valid shape rather than guaranteeing what is on disk.
 */
function variant(mutate: (config: Record<string, any>) => void): DeploymentConfig {
  const config = structuredClone(validConfig) as Record<string, any>;
  mutate(config);
  return config as DeploymentConfig;
}

function enableP3Runtime(config: Record<string, any>): void {
  config.googleSheetsGuard = { enabled: true };
  config.governanceRuntime = {
    enabled: true,
    deploymentStage: "p3-evaluation",
    approvalReference: "human-gate:p3-runtime-evaluation",
    retentionApprovalReference: "human-gate:p3-retention-purge",
    runtimeEnablementApproved: true,
    policy: {
      policyId: "om-p3-google-sheets-v1",
      principalId: "principal:om-inc:p3-evaluator",
      capabilityId: "capability:google-sheets:range-read",
      authorityId: "authority:om-inc:p3-synthetic-read",
      permissionId: "permission:om-inc:p3-fixed-range",
      operation: "google.sheets.range.read",
      service: "google-sheets",
      dataClass: "synthetic",
      preparationTtlSeconds: 120,
      permitTtlSeconds: 30,
      recordRetentionSeconds: 86_400,
      mandatoryHumanGate: true,
      initialState: { E: .8, K: .8, U: .2, R: .2, C: .1, D: .1, L: .2, A: .1, X: .2 },
      initialMeasurementConfidence: {
        E: .8, K: .8, U: .8, R: .8, C: .8, D: .8, L: .8, A: .8, X: .8,
      },
    },
  };
}

function enableKnowledgeSnapshot(config: Record<string, any>): void {
  config.aiGateway = { enabled: false };
  config.workers.knowledgeSnapshot = { name: "acme-knowledge-snapshot" };
  config.knowledgeSnapshot = {
    enabled: true,
    approvalReference: "human-gate:synthetic1-knowledge",
    artifactRevision: "0123456789abcdef0123456789abcdef01234567",
    deploymentId: "oao-knowledge-synthetic1",
    enablementApproved: true,
  };
}

async function knowledgeBaseConfigs(): Promise<BaseConfigs> {
  return {
    ...await baseConfigs(),
    knowledgeSnapshot: await baseConfig("../packages/knowledge-snapshot/wrangler.jsonc"),
  };
}

// Read from disk rather than inlined, including the Error Reporter's: deploy.ts derives every
// generated config from these files, so a copy here could drift from what actually ships.
async function baseConfigs(): Promise<BaseConfigs> {
  return {
    router: await baseConfig("../cloudflare-os/packages/router/wrangler.jsonc"),
    workshop: await baseConfig("../cloudflare-os/packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../cloudflare-os/packages/gatekeeper-context/wrangler.jsonc"),
    scheduler: await baseConfig("../cloudflare-os/packages/gatekeeper-scheduler/wrangler.jsonc"),
    customGatekeeper: await baseConfig("../packages/custom-gatekeeper/wrangler.jsonc"),
    googleSheetsGuard: await baseConfig("../packages/google-sheets-guard/wrangler.jsonc"),
    omGovernanceRuntime: await baseConfig("../packages/om-governance-runtime/wrangler.jsonc"),
    systemStateVerifier: await baseConfig("../packages/system-state-verifier/wrangler.jsonc"),
    errorReporter: await baseConfig("../packages/error-reporter/wrangler.jsonc"),
  };
}

// Parsed the way `deploy.ts` parses it, errors included. Swallowing them would let a base config
// that the deploy cannot read still pass these tests on a best-effort parse -- which is how the
// Scheduler's trailing commas hid: nine parse errors, and a config object that still looked usable.
async function baseConfig(path: string): Promise<ProdWranglerConfig> {
  const errors: ParseError[] = [];
  const result = parse(
    await readFile(new URL(path, import.meta.url), "utf8"),
    errors,
    { allowTrailingComma: true },
  ) as ProdWranglerConfig;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

/** The Context data-isolation boundary carried by the Workshop's Gatekeeper binding. */
function sharingDomain(generated: GeneratedConfigs): unknown {
  return generated.workshop.services!
    .find((service) => service.binding === "GATEKEEPER_CONTEXT")!.props!.sharingDomain;
}

test("rejects deployment placeholders", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.accountId = "<CLOUDFLARE_ACCOUNT_ID>"; })),
    /placeholder/i);
});

test("rejects destructive or malformed deployment values", () => {
  const duplicateWorkers = structuredClone(validConfig);
  duplicateWorkers.workers.context.name = duplicateWorkers.workers.workshop.name;
  assert.throws(() => validateConfig(duplicateWorkers), /unique/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.observability.enabled = "true"; })), /boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.workers.router.route.customDomain = "os.example.com/path";
    })), /hostname/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.sharingDomain = ""; })),
    /sharingDomain must be null or a non-empty string/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.issuer += "/team"; })), /issuer.*origin/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = "   "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = " access-audience "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.admins = ["bad-address"]; })), /email/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.observability.traces.headSamplingRate = 2;
    })), /sampling/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.enabled = "true"; })),
    /Artifacts enabled.*boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = null; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = []; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = null; })),
    /namespace must be omitted/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = "context/collections"; })),
    /namespace must be omitted/i);
});

test("rejects AI Gateway keys that no longer do anything", () => {
  // A silently-ignored workersAi block is how a deploy succeeds with an empty model picker.
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.workersAi = { mode: "gateway" }; })),
    /aiGateway\.workersAi does nothing/i);
  // Even with AI off: the key means the operator believes it still does something.
  assert.throws(
    () => validateConfig(variant((c) => {
      c.aiGateway = { enabled: false, workersAi: { mode: "direct" } };
    })),
    /aiGateway\.workersAi does nothing/i);
});

test("rejects malformed AI Gateway providers and account", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = []; })),
    /Missing required deployment value: aiGateway.providers/);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = ["anthropic", "mistral"]; })),
    /providers must be a non-empty subset/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.accountId = "not-an-account"; })),
    /aiGateway.accountId must be null or 32 hexadecimal/i);
});

test("generates Access-mode Workshop, Context, and custom Gatekeeper configs", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(generated.workshop.name, "acme-cloudflare-os-backend");
  assert.deepEqual(vars.ADMINS, ["admin@example.com"]);
  assert.equal(vars.CF_ACCESS_ISS, validConfig.access.issuer);
  assert.equal(vars.CF_ACCESS_AUD, validConfig.access.audience);
  assert.equal(vars.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services, [
    {
      binding: "ERROR_REPORTER",
      service: "acme-cloudflare-os-errors",
      entrypoint: "ErrorReporter",
      props: {
        service: "acme-cloudflare-os-backend",
        environment: "production",
        release: "abc123",
      },
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: "acme-cloudflare-os-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "https://os.example.com" },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: "acme-cloudflare-os-custom",
      entrypoint: "GatekeeperVendor",
    },
  ]);
  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" },
    { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.equal(generated.workshop.r2_buckets![0].bucket_name, "cloudflare-os-blueprints");
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces![0].id, "context-kv-id");
  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "acme-context-collections",
  }]);
  assert.equal(generated.customGatekeeper.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper.vars, {
    CUSTOM_NAME: "Acme",
    CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter!.name, "acme-cloudflare-os-errors");
  assert.deepEqual(generated.workshop.observability!.logs, {
    invocation_logs: false,
  });
  assert.deepEqual(generated.workshop.observability!.traces, {
    enabled: true,
    head_sampling_rate: 0.25,
  });
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "FRONTEND_ERROR_REPORTER"), false);
});

test("gives the router the public route, the frontend, and every service binding", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.router.name, "acme-cloudflare-os");
  assert.equal(generated.router.workers_dev, false);
  assert.deepEqual(generated.router.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  // No entrypoint on any of the three: the router forwards whole HTTP requests rather than making
  // vendor RPC calls, and the binding name is what selects the /gatekeeper/<name> path.
  assert.deepEqual(generated.router.services, [
    { binding: "WORKSHOP_BACKEND", service: "acme-cloudflare-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-cloudflare-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" },
    { binding: "GATEKEEPER_CUSTOM", service: "acme-cloudflare-os-custom" },
  ]);
  // Inherited untouched: the base config already carries the ASSETS binding, the SPA fallback, and
  // the /gatekeeper/* prefix an OAuth Gatekeeper redirect needs.
  assert.deepEqual(generated.router.assets, bases.router.assets);
  assert.equal(generated.router.assets!.binding, "ASSETS");
  assert.equal(generated.router.assets!.directory, "../workshop-frontend/dist");
  assert.ok(generated.router.assets!.run_worker_first!.includes("/gatekeeper/*"),
    JSON.stringify(generated.router.assets));
});

/**
 * The hosted deploy preinstalls this one on every fresh instance (`PREINSTALL` in
 * cloudflare-os/scripts/release/manifest-lib.ts), so a starter that skipped it would not be the same
 * topology: a migrated instance would show none of its existing schedules, and the
 * Durable Objects holding them would be orphaned behind a Worker nothing is bound to.
 */
test("deploys the ambient Scheduler Gatekeeper the hosted flow preinstalls", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases);

  assert.equal(generated.scheduler.name, "acme-cloudflare-os-scheduler");
  // Reached by both, for the two different things a Gatekeeper does: vendor RPC from the backend,
  // and whole HTTP requests under /gatekeeper/scheduler from the router.
  assert.deepEqual(
    generated.workshop.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    });
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" });

  // Its Durable Object history has to arrive verbatim: those classes are where the schedules live.
  assert.deepEqual(generated.scheduler.migrations, bases.scheduler.migrations);
  assert.ok(generated.scheduler.migrations!.length > 0, "scheduler lost its DO migrations");
  // No configuration surface of its own -- which is what makes it installable with no user input
  // upstream, and deployable here from nothing but a Worker name.
  assert.equal(generated.scheduler.vars, undefined);
  assert.equal(generated.scheduler.kv_namespaces, undefined);
  assert.equal(generated.scheduler.secrets, undefined);

  const builds = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-scheduler"));
  assert.deepEqual(builds.map((args) => args.at(-1)), ["build:app", "build"]);
});

test("keeps the P3 Google Sheets guard absent by default", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  assert.equal(generated.googleSheetsGuard, undefined);
  assert.equal(generated.omGovernanceRuntime, undefined);
  assert.equal(generated.systemStateVerifier, undefined);
  assert.equal(generated.router.services!.some(
    (service) => service.binding === "GATEKEEPER_GOOGLE_SHEETS_GUARD"), false);
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "GATEKEEPER_GOOGLE_SHEETS_GUARD"), false);
  assert.equal(buildCommands(validConfig).some(
    ({ args }) => args.includes("google-sheets-guard")), false);
  assert.equal(buildCommands(validConfig).some(
    ({ args }) => args.includes("system-state-verifier")), false);
});

test("generates a private, secret-bound P3 Google Sheets guard when enabled", async () => {
  const config = variant(enableP3Runtime);
  const generated = generateConfigs(config, await baseConfigs());
  const guard = generated.googleSheetsGuard!;
  const governance = generated.omGovernanceRuntime!;
  if (!config.governanceRuntime?.enabled) throw new Error("test fixture must enable Governance Runtime");
  const expectedPolicyHash = governancePolicyHash({
    ...config.governanceRuntime!.policy!,
    deploymentApprovalReference: config.governanceRuntime!.approvalReference,
    trustedCallerId: "google-sheets-guard",
  });

  assert.equal(guard.name, "acme-cloudflare-os-google-sheets");
  assert.equal(guard.workers_dev, false);
  assert.equal(guard.preview_urls, false);
  assert.deepEqual(guard.vars, {
    BASE_URL: "https://os.example.com/gatekeeper/google-sheets-guard",
    OM_GOVERNANCE_POLICY_HASH: expectedPolicyHash,
    OM_GOVERNANCE_PRINCIPAL_ID: "principal:om-inc:p3-evaluator",
    OM_GOVERNANCE_CAPABILITY_ID: "capability:google-sheets:range-read",
    OM_GOVERNANCE_AUTHORITY_ID: "authority:om-inc:p3-synthetic-read",
    OM_GOVERNANCE_PERMISSION_ID: "permission:om-inc:p3-fixed-range",
  });
  assert.deepEqual(guard.secrets, { required: [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "P3_SPREADSHEET_ID",
    "P3_ALLOWED_RANGE",
  ] });
  assert.ok(generated.router.services!.some((service) =>
    service.binding === "GATEKEEPER_GOOGLE_SHEETS_GUARD" &&
    service.service === "acme-cloudflare-os-google-sheets" &&
    service.entrypoint === undefined));
  assert.ok(generated.workshop.services!.some((service) =>
    service.binding === "GATEKEEPER_GOOGLE_SHEETS_GUARD" &&
    service.service === "acme-cloudflare-os-google-sheets" &&
    service.entrypoint === "GatekeeperVendor"));
  assert.ok(guard.services!.some((service) =>
    service.binding === "OM_GOVERNANCE" &&
    service.service === "acme-cloudflare-os-governance" &&
    service.entrypoint === "GovernanceRuntimeService" &&
    service.props?.callerId === "google-sheets-guard"));
  assert.equal(governance.name, "acme-cloudflare-os-governance");
  assert.equal(governance.workers_dev, false);
  assert.equal(governance.preview_urls, false);
  assert.deepEqual(governance.secrets, { required: [
    "P3_SPREADSHEET_ID",
    "P3_ALLOWED_RANGE",
    "OM_GOVERNANCE_DEPLOYMENT_APPROVAL",
    "OM_GOVERNANCE_RETENTION_CONTROL",
  ] });
  assert.equal(governance.vars!.OM_GOVERNANCE_ACCOUNT_ID, config.accountId);
  assert.equal(governance.vars!.OM_GOVERNANCE_RUNTIME_WORKER, "acme-cloudflare-os-governance");
  assert.equal(governance.vars!.OM_GOVERNANCE_ADAPTER_WORKER, "acme-cloudflare-os-google-sheets");
  assert.equal(governance.vars!.OM_GOVERNANCE_STAGE, "p3-evaluation");
  assert.equal(
    governance.vars!.OM_GOVERNANCE_RETENTION_APPROVAL_ID,
    "human-gate:p3-retention-purge",
  );
  assert.equal(typeof governance.vars!.OM_GOVERNANCE_POLICY, "string");
  assert.ok(buildCommands(config).some(
    ({ args }) => args.includes("google-sheets-guard")));
  assert.ok(buildCommands(config).some(
    ({ args }) => args.includes("om-governance-runtime")));
  assert.ok(buildCommands(config).some(({ args }) =>
    args.includes("@gadgets/google-gatekeeper") && args.at(-1) === "build:configurator"));
});

test("generates a private read-only System State Verifier with a separate approval", async () => {
  const config = variant((c) => {
    enableP3Runtime(c);
    c.workers.systemStateVerifier = { name: "acme-cloudflare-os-state-verifier" };
    c.systemStateVerifier = {
      enabled: true,
      approvalReference: "human-gate:p3-system-state-verifier",
      freshnessSeconds: 86_400,
      verifierEnablementApproved: true,
    };
  });
  const generated = generateConfigs(config, await baseConfigs());
  const verifier = generated.systemStateVerifier!;
  const governance = generated.omGovernanceRuntime!;
  if (!config.governanceRuntime?.enabled) throw new Error("test fixture must enable Governance Runtime");
  const expectedPolicyHash = governancePolicyHash({
    ...config.governanceRuntime.policy,
    deploymentApprovalReference: config.governanceRuntime.approvalReference,
    trustedCallerId: "google-sheets-guard",
  });

  assert.equal(verifier.name, "acme-cloudflare-os-state-verifier");
  assert.equal(verifier.workers_dev, false);
  assert.equal(verifier.preview_urls, false);
  assert.equal(verifier.routes, undefined);
  assert.deepEqual(verifier.secrets, {
    required: ["OM_GOVERNANCE_VERIFIER_APPROVAL"],
  });
  assert.deepEqual(verifier.services, [{
    binding: "OM_STATE_READ",
    service: "acme-cloudflare-os-governance",
    entrypoint: "GovernanceStateReadService",
    props: { callerId: "system-state-verifier" },
  }]);
  assert.equal(verifier.services!.some(
    (service) => service.entrypoint === "GovernanceRuntimeService"), false);
  assert.deepEqual(verifier.vars, {
    OM_STATE_VERIFIER_FRESHNESS_SECONDS: "86400",
    OM_STATE_VERIFIER_APPROVAL_ID: "human-gate:p3-system-state-verifier",
    OM_STATE_VERIFIER_ARTIFACT_REVISION:
      "om-p3-governed-sheets-system-state-verifier-v1",
    OM_STATE_VERIFIER_POLICY_HASH: expectedPolicyHash,
    OM_STATE_VERIFIER_ACCOUNT_ID: config.accountId,
    OM_STATE_VERIFIER_RUNTIME_WORKER: "acme-cloudflare-os-governance",
    OM_STATE_VERIFIER_WORKER: "acme-cloudflare-os-state-verifier",
    OM_STATE_VERIFIER_ROUTER_WORKER: "acme-cloudflare-os",
    OM_STATE_VERIFIER_STAGE: "p3-evaluation",
    OM_STATE_VERIFIER_CALLER_ID: "system-state-verifier",
  });
  assert.ok(generated.router.services!.some((service) =>
    service.binding === "GATEKEEPER_SYSTEM_STATE_VERIFIER" &&
    service.service === "acme-cloudflare-os-state-verifier" &&
    service.entrypoint === undefined));
  assert.ok(generated.workshop.services!.some((service) =>
    service.binding === "GATEKEEPER_SYSTEM_STATE_VERIFIER" &&
    service.service === "acme-cloudflare-os-state-verifier" &&
    service.entrypoint === "GatekeeperVendor"));
  assert.equal(
    governance.vars!.OM_GOVERNANCE_VERIFIER_APPROVAL_ID,
    "human-gate:p3-system-state-verifier",
  );
  assert.equal(
    governance.vars!.OM_GOVERNANCE_VERIFIER_WORKER,
    "acme-cloudflare-os-state-verifier",
  );
  assert.ok(governance.secrets!.required.includes("OM_GOVERNANCE_VERIFIER_APPROVAL"));
  assert.ok(buildCommands(config).some(
    ({ args }) => args.includes("system-state-verifier")));
});

test("rejects unsafe or incomplete System State Verifier enablement", () => {
  assert.throws(() => validateConfig(variant((c) => {
    c.systemStateVerifier = {
      enabled: true,
      approvalReference: "human-gate:p3-system-state-verifier",
      freshnessSeconds: 86_400,
      verifierEnablementApproved: true,
    };
    c.workers.systemStateVerifier = { name: "acme-state-verifier" };
  })), /requires governanceRuntime.enabled/);

  for (const freshnessSeconds of [59, 86_401, 1.5]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableP3Runtime(c);
      c.workers.systemStateVerifier = { name: "acme-state-verifier" };
      c.systemStateVerifier = {
        enabled: true,
        approvalReference: "human-gate:p3-system-state-verifier",
        freshnessSeconds,
        verifierEnablementApproved: true,
      };
    })), /freshnessSeconds must be 60\.\.86400/);
  }

  assert.throws(() => validateConfig(variant((c) => {
    enableP3Runtime(c);
    c.workers.systemStateVerifier = { name: "acme-state-verifier" };
    c.systemStateVerifier = {
      enabled: true,
      approvalReference: "human-gate:p3-system-state-verifier",
      freshnessSeconds: 86_400,
      verifierEnablementApproved: false,
    };
  })), /verifierEnablementApproved must be true/);

  assert.throws(() => validateConfig(variant((c) => {
    enableP3Runtime(c);
    c.systemStateVerifier = {
      enabled: true,
      approvalReference: "human-gate:p3-system-state-verifier",
      freshnessSeconds: 86_400,
      verifierEnablementApproved: true,
    };
  })), /workers.systemStateVerifier.name/);

  assert.throws(() => validateConfig(variant((c) => {
    enableP3Runtime(c);
    c.workers.systemStateVerifier = { name: "acme-state-verifier" };
    c.systemStateVerifier = {
      enabled: true,
      approvalReference: "human-gate:p3-system-state-verifier",
      freshnessSeconds: 86_400,
      verifierEnablementApproved: true,
      executionApprovalReference: "must-not-be-accepted",
    };
  })), /unknown or missing fields/);
});

test("requires a P3 guard Worker name only when the guard is enabled", () => {
  const disabled = variant((c) => {
    delete c.workers.googleSheetsGuard;
    c.googleSheetsGuard = { enabled: false };
  });
  assert.doesNotThrow(() => validateConfig(disabled));

  const enabled = variant((c) => {
    delete c.workers.googleSheetsGuard;
    c.googleSheetsGuard = { enabled: true };
    c.governanceRuntime = {
      enabled: true,
      deploymentStage: "p3-evaluation",
      approvalReference: "human-gate:p3-runtime-evaluation",
      retentionApprovalReference: "human-gate:p3-retention-purge",
      runtimeEnablementApproved: true,
      policy: {},
    };
  });
  assert.throws(() => validateConfig(enabled));
});

test("refuses to enable the P3 guard without the Governance Runtime", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.googleSheetsGuard = { enabled: true }; })),
    /requires governanceRuntime.enabled/,
  );
});

test("refuses to enable the P3-bound Governance Runtime without the Google adapter", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.governanceRuntime = { enabled: true }; })),
    /requires googleSheetsGuard.enabled/,
  );
});

test("rejects governance policies that shrink mandatory boundaries", () => {
  const base = variant((c) => {
    c.googleSheetsGuard = { enabled: true };
    c.governanceRuntime = {
      enabled: true,
      deploymentStage: "p3-evaluation",
      approvalReference: "human-gate:p3-runtime-evaluation",
      retentionApprovalReference: "human-gate:p3-retention-purge",
      runtimeEnablementApproved: true,
      policy: {
        policyId: "policy",
        principalId: "principal", capabilityId: "capability", authorityId: "authority",
        permissionId: "permission", operation: "google.sheets.range.read",
        service: "google-sheets", dataClass: "synthetic", preparationTtlSeconds: 120,
        permitTtlSeconds: 30, mandatoryHumanGate: true,
        recordRetentionSeconds: 86_400,
        initialState: { E: .8, K: .8, U: .2, R: .2, C: .1, D: .1, L: .2, A: .1, X: .2 },
        initialMeasurementConfidence: {
          E: .8, K: .8, U: .8, R: .8, C: .8, D: .8, L: .8, A: .8, X: .8,
        },
      },
    };
  });
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig(variant((c) => {
    Object.assign(c, structuredClone(base));
    c.governanceRuntime.policy.mandatoryHumanGate = false;
  })), /must remain true/);
  assert.throws(() => validateConfig(variant((c) => {
    Object.assign(c, structuredClone(base));
    delete c.governanceRuntime.policy.initialState.X;
    c.governanceRuntime.policy.initialState.R = 2;
  })), /initialState/);
  assert.throws(() => validateConfig(variant((c) => {
    Object.assign(c, structuredClone(base));
    c.governanceRuntime.approvalReference = "";
  })), /approvalReference/);
  assert.throws(() => validateConfig(variant((c) => {
    Object.assign(c, structuredClone(base));
    c.governanceRuntime.retentionApprovalReference = "";
  })), /retentionApprovalReference/);
  assert.throws(() => validateConfig(variant((c) => {
    Object.assign(c, structuredClone(base));
    c.governanceRuntime.runtimeEnablementApproved = false;
  })), /runtimeEnablementApproved/);
});

test("requires an explicit boolean for the P3 guard enabled state", () => {
  for (const invalid of ["false", "true", 0, 1, null]) {
    assert.throws(
      () => validateConfig(variant((c) => { c.googleSheetsGuard.enabled = invalid; })),
      /Google Sheets Guard.*boolean/i,
    );
  }
  assert.throws(
    () => validateConfig(variant((c) => { c.googleSheetsGuard = null; })),
    /Google Sheets Guard.*boolean/i,
  );
});

test("keeps every Worker behind the router off the public internet", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const workers = Object.entries(generated) as [string, ProdWranglerConfig][];

  for (const [name, worker] of workers) {
    if (name !== "router") {
      assert.equal(worker.workers_dev, false, `${name} answers on workers.dev`);
      assert.equal(worker.routes, undefined, `${name} carries a public route`);
    }
    // A preview URL is an unauthenticated path around the Access-protected origin.
    assert.equal(worker.preview_urls, false, `${name} leaves preview URLs enabled`);
  }
  // The router serves the frontend, so the backend uploads no assets of its own.
  assert.equal(generated.workshop.assets, undefined);
});

test("scopes PUBLIC_BASE_URL and Context sharing to the public origin", async () => {
  const onWorkersDev = variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = "https://acme-cloudflare-os.acme.workers.dev";
  });

  const derived = generateConfigs(validConfig, await baseConfigs());
  const explicit = generateConfigs(onWorkersDev, await baseConfigs());

  assert.equal(derived.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(
    explicit.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.acme.workers.dev");
  assert.equal(explicit.router.workers_dev, true);
  assert.equal(explicit.router.routes, undefined);

  // sharingDomain: null follows the public origin, which is what the hosted deploy sets it to.
  assert.equal(sharingDomain(derived), "https://os.example.com");
  assert.equal(sharingDomain(explicit), "https://acme-cloudflare-os.acme.workers.dev");

  // A pinned literal keeps the boundary stable across a hostname change, so it wins.
  const pinned = generateConfigs(
    variant((c) => { c.context.sharingDomain = "production"; }), await baseConfigs());
  assert.equal(sharingDomain(pinned), "production");
  assert.equal(pinned.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
});

test("rejects a public origin it cannot derive or cannot trust", async () => {
  // Nothing in deployment.jsonc names the account's workers.dev subdomain, and PUBLIC_BASE_URL and
  // the Context sharing boundary both need an origin, so this cannot be left to a fallback.
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.router.route = { workersDev: true }; })),
    /publicBaseUrl is required on a workersDev route/i);

  // Scoping Context data to a hostname the deployment does not answer on hides its collections.
  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://other.example.com"; })),
    /does not match workers.router.route.customDomain/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com/"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "http://os.example.com"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { delete c.publicBaseUrl; })),
    /publicBaseUrl must be present/i);
});

test("rejects a workersDev origin that is not the router's own", async () => {
  const onWorkersDev = (publicBaseUrl: string) => variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = publicBaseUrl;
  });

  // The account's workers.dev subdomain is unknowable here, but the rest of the hostname is not: a
  // typo in the Worker label, or an unrelated host, would silently become both PUBLIC_BASE_URL and
  // the Context isolation boundary.
  assert.throws(
    () => validateConfig(onWorkersDev("https://acme-cloudflare-o.acme.workers.dev")),
    /names Worker "acme-cloudflare-o", but the router is "acme-cloudflare-os"/);

  assert.throws(
    () => validateConfig(onWorkersDev("https://os.example.com")),
    /not a workers.dev origin/i);

  // A deeper name is a preview URL or an unrelated host, not the route wrangler serves.
  assert.throws(
    () => validateConfig(onWorkersDev("https://staging.acme-cloudflare-os.acme.workers.dev")),
    /not a workers.dev origin/i);

  // The shape wrangler actually serves stays valid, whatever the account subdomain is.
  const generated = generateConfigs(
    onWorkersDev("https://acme-cloudflare-os.some-account.workers.dev"), await baseConfigs());
  assert.equal(
    generated.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.some-account.workers.dev");

  // The rule is scoped to the workersDev route. A custom domain has its own hostname, unrelated to
  // any Worker name, and is checked against `customDomain` instead -- both spellings stay valid.
  assert.equal(
    validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com"; })).publicBaseUrl,
    "https://os.example.com");
  assert.equal(validateConfig(validConfig).publicBaseUrl, null);
});

test("routes AI Gateway over the Workers AI binding without an API token", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  // Absent, not "true": the backend takes the binding whenever it is bound, and the binding is
  // pre-authenticated inside the deployment's own account.
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.deepEqual(aiGatewayPlan(validConfig), {
    gatewayAccountId: validConfig.accountId,
    crossAccount: false,
    needsToken: false,
    tokenReasons: [],
  });
});

test("requires a token for a gateway in another account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = "fedcba9876543210fedcba9876543210"; });
  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, "fedcba9876543210fedcba9876543210");
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, "false");
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // The Workers AI binding stays bound: webFetch's toMarkdown() runs on it too.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config)!.tokenReasons.length, 1);
});

test("treats a differently-cased account ID as the same account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = c.accountId.toUpperCase(); });
  const generated = generateConfigs(config, await baseConfigs());

  // Same account written two ways, which the hex pattern accepts: the binding reaches this gateway,
  // so no CF_AI_GATEWAY_USE_BINDING opt-out and no token.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.equal(aiGatewayPlan(config)!.crossAccount, false);
  assert.deepEqual(aiGatewayPlan(config)!.tokenReasons, []);
});

test("requires a token for the google provider", async () => {
  const config = variant((c) => { c.aiGateway.providers = ["cloudflare", "google"]; });
  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // Same account, so the binding still carries every other provider.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.match(aiGatewayPlan(config)!.tokenReasons[0], /google/i);
});

test("omits disabled backend error reporting", async () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: "<RELEASE>" };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.errorReporter, undefined);
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "ERROR_REPORTER"), false);
});

test("omits dormant AI Gateway configuration", async () => {
  const config = variant((c) => {
    c.aiGateway = {
      enabled: false,
      name: "<AI_GATEWAY_NAME>",
      accountId: "<AI_GATEWAY_ACCOUNT_ID>",
      providers: [],
    };
  });

  const generated = generateConfigs(config, await baseConfigs());
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY, undefined);
  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, undefined);
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  // Still bound: it is what webFetch's toMarkdown() runs on, independent of the model catalog.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config), null);
});

test("uses the default Context Artifacts namespace when omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts.namespace; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "gatekeeper-context-collections",
  }]);
});

test("omits disabled Context Artifacts configuration", async () => {
  const config = variant((c) => { c.context.artifacts = {}; });
  const bases = await baseConfigs();
  bases.context.artifacts = [{ binding: "ARTIFACTS", namespace: "upstream-default" }];

  const generated = generateConfigs(config, bases);

  assert.equal(generated.context.artifacts, undefined);
});

test("defaults Context Artifacts to disabled when configuration is omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts; });

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.context.artifacts, undefined);
});

test("generates binding-only storage for automatic provisioning", async () => {
  const config = variant((c) => {
    c.context.kvNamespaceId = null;
    c.resources = {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    };
  });

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
});

/**
 * The equivalent, for this repository, of upstream's `deploy-scripts.test.ts`. That one
 * auto-discovers per-package `deploy` scripts; here deploying is centralised in `deploy.ts`, so the
 * same invariant has to be asserted against the commands it spawns.
 *
 * Both halves are silent failures: a replayed cache hit and a dropped build-time flag each exit
 * zero and each still deploy.
 */
test("never lets a deploy replay a cached build artifact", () => {
  const commands = buildCommands(validConfig);
  assert.ok(commands.length > 0, "expected at least one build command");
  for (const { args } of commands) {
    const command = args.join(" ");
    // `pnpm --filter <pkg> build` cannot see a Vite+ task, and two of the three submodule targets
    // are now tasks rather than scripts. `vp run` runs both.
    assert.ok(command.includes("vp run"),
      `build step does not go through vp run: ${command}`);
    assert.ok(command.includes("--no-cache"),
      `build step runs a vp task while deploying without --no-cache: ${command}\n` +
      "Deploys must not replay a cached artifact -- add --no-cache.");
    // Everything after the task specifier is forwarded to the task's own command, so a trailing
    // flag reaches `tsc` as an unknown option instead of reaching vp.
    assert.ok(args.indexOf("--no-cache") < args.indexOf("run") + 4,
      `--no-cache must precede the task name, not follow it: ${command}`);
  }
});

test("rebuilds the Context configurator app rather than replaying it", () => {
  // `gatekeeper-context`'s `build` script spawns `vp run --cache build:app` of its own, which the
  // outer --no-cache does not reach. Without this step a deploy ships whatever app.txt the cache
  // last archived.
  const context = buildCommands(validConfig)
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-context"));
  assert.deepEqual(context.map((args) => args.at(-1)), ["build:app", "build"]);
  assert.ok(context.every((args) => args.at(-2) === "--no-cache"), context.join("\n"));
});

test("passes VITE_CF_ACCESS_MODE explicitly rather than inheriting it", () => {
  const withAccessMode = buildCommands(validConfig).filter(({ env }) => env);
  assert.deepEqual(withAccessMode.map(({ env }) => env), [{ VITE_CF_ACCESS_MODE: "true" }]);
  // It has to reach the frontend, which inlines it into the bundle, and nothing else.
  assert.match(withAccessMode[0].args.join(" "), /@gadgets\/workshop-frontend/);
});

test("builds the frontend before the router", () => {
  const order = buildCommands(validConfig).map(({ args }) => args.join(" "));
  const frontend = order.findIndex((command) => command.includes("workshop-frontend"));
  const router = order.findIndex((command) => command.includes("@gadgets/router"));
  // The router deploy picks up ../workshop-frontend/dist as its assets.
  assert.ok(frontend >= 0 && router >= 0 && frontend < router, order.join("\n"));
});

test("skips the Error Reporter build when error reporting is disabled", () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: null };
  });
  const commands = buildCommands(config).map(({ args }) => args.join(" "));
  assert.equal(commands.some((command) => command.includes("error-reporter")), false);
});

test("Knowledge Snapshot absent and disabled preserve legacy configs and builds exactly", async () => {
  const bases = await baseConfigs(); // Legacy callers need not load the optional base at all.
  for (const aiEnabled of [true, false]) {
    const legacy = variant((c) => { c.aiGateway.enabled = aiEnabled; });
    const expected = generateConfigs(legacy, bases);
    for (const enabled of [undefined, false]) {
      const config = structuredClone(legacy);
      if (enabled === false) config.knowledgeSnapshot = { enabled: false };
      // A dormant worker identity does not join active-worker duplicate checking.
      config.workers.knowledgeSnapshot = { name: config.workers.workshop.name };
      const generated = generateConfigs(config, bases);
      assert.deepEqual(generated, expected);
      assert.equal(JSON.stringify(generated), JSON.stringify(expected));
      assert.deepEqual(buildCommands(config), buildCommands(legacy));
      assert.equal(Object.hasOwn(generated, "knowledgeSnapshot"), false);
      assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
    }
  }
});

test("rejects malformed Knowledge Snapshot blocks and disabled unknown fields", () => {
  for (const knowledge of [
    null, true, false, [], "enabled", {}, { enabled: "true" }, { enabled: 1 },
    { enabled: false, approvalReference: "human-gate:unapproved" },
    { enabled: false, enablementApproved: true },
    { enabled: false, unknown: false },
  ]) {
    assert.throws(() => validateConfig(variant((c) => { c.knowledgeSnapshot = knowledge; })),
      /knowledgeSnapshot/);
  }
});

test("rejects unknown and missing enabled Knowledge Snapshot fields", () => {
  const unknowns = ["vars", "secrets", "routes", "aiGateway", "callerId", "snapshotJson", "worker"];
  for (const key of unknowns) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.knowledgeSnapshot[key] = "not-permitted";
    })), /knowledgeSnapshot.*unknown or missing/);
  }
  for (const key of ["approvalReference", "artifactRevision", "deploymentId", "enablementApproved"]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      delete c.knowledgeSnapshot[key];
    })), /knowledgeSnapshot.*unknown or missing/);
  }
});

test("rejects invalid Knowledge approval and deployment IDs without trimming or coercion", () => {
  for (const key of ["approvalReference", "deploymentId"]) {
    for (const value of [
      undefined, null, 1, true, {}, [], "", " ", " leading", "trailing ", "id\n", "id\r\n",
      "a".repeat(97), "https://approval.example", "../approval", "-prefix", "a.b", "承認",
    ]) {
      assert.throws(() => validateConfig(variant((c) => {
        enableKnowledgeSnapshot(c);
        c.knowledgeSnapshot[key] = value;
      })), new RegExp(`knowledgeSnapshot\\.${key}`));
    }
  }
});

test("requires an exact Knowledge artifact revision and explicit true enablement approval", () => {
  for (const value of [
    undefined, null, 40, "", "a".repeat(39), "a".repeat(41), "g".repeat(40), "A".repeat(40), "a".repeat(40) + "\n",
  ]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.knowledgeSnapshot.artifactRevision = value;
    })), /knowledgeSnapshot\.artifactRevision/);
  }
  for (const value of [undefined, null, false, "true", 1]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.knowledgeSnapshot.enablementApproved = value;
    })), /knowledgeSnapshot\.enablementApproved/);
  }
  const boundary = variant((c) => {
    enableKnowledgeSnapshot(c);
    c.knowledgeSnapshot.approvalReference = "A";
    c.knowledgeSnapshot.deploymentId = "a".repeat(96);
    c.knowledgeSnapshot.artifactRevision = "a".repeat(40);
  });
  assert.equal(validateConfig(boundary), boundary);
});

test("requires Knowledge and existing mandatory Worker identities", () => {
  for (const key of ["router", "workshop", "context", "scheduler", "customGatekeeper", "knowledgeSnapshot"]) {
    for (const value of [undefined, null, {}, { name: "" }, { name: 1 }]) {
      assert.throws(() => validateConfig(variant((c) => {
        enableKnowledgeSnapshot(c);
        c.workers[key] = value;
      })), new RegExp(`workers\\.${key}`));
    }
  }
  for (const value of [
    [], true, "worker", { name: "bad.name" }, { name: "UPPER" }, { name: "worker\n" },
    { name: "a".repeat(64) }, { name: "valid-name", routes: [] },
    { name: "valid-name", props: { callerId: "another-workshop" } },
  ]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.workers.knowledgeSnapshot = value;
    })), /workers\.knowledgeSnapshot/);
  }
});

test("includes the enabled Knowledge Worker in duplicate identity checks", () => {
  for (const worker of ["router", "workshop", "context", "scheduler", "customGatekeeper", "errorReporter"]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.workers.knowledgeSnapshot.name = c.workers[worker].name;
    })), /unique/);
  }
  assert.throws(() => validateConfig(variant((c) => {
    enableP3Runtime(c);
    enableKnowledgeSnapshot(c);
    c.workers.knowledgeSnapshot.name = c.workers.omGovernanceRuntime.name;
  })), /unique/);
});

test("rejects trailing line breaks in pilot Worker identities", () => {
  for (const key of ["workshop", "router", "context", "scheduler", "customGatekeeper", "errorReporter"]) {
    assert.throws(() => validateConfig(variant((c) => {
      enableKnowledgeSnapshot(c);
      c.workers[key].name += "\n";
    })), /Worker names/);
  }
});

test("rejects Knowledge pilot with an enabled or non-boolean AI Gateway", async () => {
  const bases = await knowledgeBaseConfigs();
  for (const enabled of [true, "false", "true", 0, null, undefined]) {
    const config = variant((c) => {
      enableKnowledgeSnapshot(c);
      c.aiGateway.enabled = enabled;
    });
    assert.throws(() => validateConfig(config), /knowledgeSnapshot requires aiGateway.enabled=false/);
    assert.throws(() => generateConfigs(config, bases), /knowledgeSnapshot requires aiGateway.enabled=false/);
  }
});

test("requires a Knowledge base only when the pilot is enabled", async () => {
  const config = variant(enableKnowledgeSnapshot);
  const bases = await baseConfigs();
  for (const missing of [undefined, null, false, []]) {
    assert.throws(() => generateConfigs(config, {
      ...bases, knowledgeSnapshot: missing,
    } as unknown as BaseConfigs), /private package base config/);
  }
  assert.doesNotThrow(() => generateConfigs(validConfig, bases));
});

test("generates only a private Knowledge vendor RPC binding with fixed caller props and vars", async () => {
  const config = variant(enableKnowledgeSnapshot);
  const bases = await knowledgeBaseConfigs();
  const originalBases = structuredClone(bases);
  const originalConfig = structuredClone(config);
  const generated = generateConfigs(config, bases);
  const knowledge = generated.knowledgeSnapshot!;
  assert.ok(knowledge);
  assert.equal(knowledge.name, config.workers.knowledgeSnapshot!.name);
  assert.equal(knowledge.account_id, config.accountId);
  assert.equal(knowledge.main, bases.knowledgeSnapshot!.main);
  assert.deepEqual(knowledge.build, bases.knowledgeSnapshot!.build);
  assert.deepEqual(knowledge.migrations, bases.knowledgeSnapshot!.migrations);
  assert.equal(knowledge.workers_dev, false);
  assert.equal(knowledge.preview_urls, false);
  assert.deepEqual(knowledge.routes, []);
  assert.deepEqual(knowledge.observability, { enabled: false });
  assert.deepEqual(knowledge.vars, {
    KNOWLEDGE_ENABLED: "true",
    KNOWLEDGE_GATEWAY_ENABLED: "true",
    KNOWLEDGE_DEPLOYMENT_ID: "oao-knowledge-synthetic1",
    KNOWLEDGE_APPROVAL_ID: "human-gate:synthetic1-knowledge",
    KNOWLEDGE_ARTIFACT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    KNOWLEDGE_WORKSHOP_WORKER: config.workers.workshop.name,
    KNOWLEDGE_WORKER: config.workers.knowledgeSnapshot!.name,
  });
  assert.deepEqual(knowledge.secrets, {
    required: ["KNOWLEDGE_SNAPSHOT_JSON", "KNOWLEDGE_READ_GRANT_JSON", "KNOWLEDGE_PILOT_APPROVAL_JSON"],
  });
  assert.deepEqual(generated.workshop.services!.filter(
    (service) => service.binding === "GATEKEEPER_KNOWLEDGE_SNAPSHOT"), [{
    binding: "GATEKEEPER_KNOWLEDGE_SNAPSHOT",
    service: config.workers.knowledgeSnapshot!.name,
    entrypoint: "GatekeeperVendor",
    props: { callerId: config.workers.workshop.name },
  }]);
  const legacy = structuredClone(config);
  delete legacy.knowledgeSnapshot;
  delete legacy.workers.knowledgeSnapshot;
  const previous = generateConfigs(legacy, bases);
  assert.deepEqual(generated.router, previous.router); // No Router HTTP route or binding.
  for (const key of ["context", "scheduler", "customGatekeeper", "errorReporter"] as const) {
    assert.deepEqual(generated[key], previous[key]);
  }
  assert.deepEqual(generated.workshop.ai, previous.workshop.ai);
  assert.equal(knowledge.ai, undefined);
  assert.equal(knowledge.services, undefined);
  assert.equal(knowledge.assets, undefined);
  assert.equal(aiGatewayPlan(config), null);
  assert.equal(Object.keys(generated.workshop.vars!).some((key) => key.startsWith("CF_AI_")), false);
  assert.equal(generated.workshop.secrets?.required.includes("CF_AI_GATEWAY_API_TOKEN") ?? false, false);
  assert.deepEqual(config, originalConfig);
  assert.deepEqual(bases, originalBases);
});

test("Knowledge generation overwrites stale base exposure, AI, vars, secrets, and binding props", async () => {
  const config = variant((c) => {
    enableKnowledgeSnapshot(c);
    c.workers.workshop.name = "different-workshop";
  });
  const bases = await knowledgeBaseConfigs();
  Object.assign(bases.knowledgeSnapshot!, {
    workers_dev: true, preview_urls: true,
    routes: [{ pattern: "leak.example.com", custom_domain: true }],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } },
    ai: { binding: "WORKERS_AI" }, services: [{ binding: "AI", service: "outside-worker" }],
    assets: { directory: "public" }, vars: { KNOWLEDGE_ENABLED: "false", SECRET_COPY: "synthetic" },
    secrets: { required: ["CF_AI_GATEWAY_API_TOKEN"] },
  });
  bases.workshop.services = [{
    binding: "GATEKEEPER_KNOWLEDGE_SNAPSHOT", service: "wrong-worker",
    props: { callerId: "untrusted-caller" },
  }];
  bases.workshop.secrets = { required: ["CF_AI_GATEWAY_API_TOKEN", "UNRELATED_SECRET"] };
  const generated = generateConfigs(config, bases);
  assert.equal(generated.knowledgeSnapshot!.workers_dev, false);
  assert.equal(generated.knowledgeSnapshot!.preview_urls, false);
  assert.deepEqual(generated.knowledgeSnapshot!.routes, []);
  assert.deepEqual(generated.knowledgeSnapshot!.observability, { enabled: false });
  assert.equal(generated.knowledgeSnapshot!.ai, undefined);
  assert.equal(generated.knowledgeSnapshot!.services, undefined);
  assert.equal(generated.knowledgeSnapshot!.assets, undefined);
  assert.equal(generated.knowledgeSnapshot!.vars!.SECRET_COPY, undefined);
  assert.equal(generated.knowledgeSnapshot!.secrets!.required.includes("CF_AI_GATEWAY_API_TOKEN"), false);
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN", "UNRELATED_SECRET"] });
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services!.filter(
    (service) => service.binding === "GATEKEEPER_KNOWLEDGE_SNAPSHOT"), [{
    binding: "GATEKEEPER_KNOWLEDGE_SNAPSHOT", service: "acme-knowledge-snapshot",
    entrypoint: "GatekeeperVendor", props: { callerId: "different-workshop" },
  }]);
  bases.workshop.secrets = { required: ["CF_AI_GATEWAY_API_TOKEN"] };
  assert.deepEqual(generateConfigs(config, bases).workshop.secrets, bases.workshop.secrets);
});

test("builds Knowledge only when enabled through the existing uncached ownBuild path", async () => {
  const commands = buildCommands(variant(enableKnowledgeSnapshot)).map(({ args }) => args);
  const knowledge = commands.filter((args) => args.includes("knowledge-snapshot"));
  assert.deepEqual(knowledge, [["exec", "vp", "run", "-F", "knowledge-snapshot", "--no-cache", "types:check"]]);
  const pkg = JSON.parse(await readFile(new URL("../packages/knowledge-snapshot/package.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.scripts[knowledge[0].at(-1)!], "string");
  assert.equal(buildCommands(validConfig).some(({ args }) => args.includes("knowledge-snapshot")), false);
});

test("root CLI loads Knowledge conditionally and deploys it before Workshop, without running CLI", async () => {
  const source = await readFile(new URL("./deploy.ts", import.meta.url), "utf8");
  assert.match(source, /knowledgeSnapshot: "packages\/knowledge-snapshot"/);
  assert.match(source, /config\.knowledgeSnapshot\?\.enabled \? \{\s*knowledgeSnapshot: await readJsonc/);
  assert.match(source, /if \(config\.knowledgeSnapshot\?\.enabled\) \{\s*deployWorker\(packageDirs\.knowledgeSnapshot, deployArgs\);\s*\}\s*deployWorker\(packageDirs\.workshop, deployArgs\)/);
});
