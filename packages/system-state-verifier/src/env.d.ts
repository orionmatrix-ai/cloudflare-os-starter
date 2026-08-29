declare namespace Cloudflare {
  interface Env {
    OM_STATE_READ?: import("om-governance-runtime").GovernanceStateReadBinding;
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
  }

  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "SystemStateVerifierGatekeeper";
  }
}
