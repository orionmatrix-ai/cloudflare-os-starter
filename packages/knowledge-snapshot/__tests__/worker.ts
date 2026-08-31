export { default } from "../src/index.js";
export * from "../src/index.js";
import { KnowledgePilotLedger } from "../src/pilot-ledger.js";
import type { PilotEnv } from "../src/pilot.js";
// Test-only entrypoint, never present in production exports.
export class TestLedger extends KnowledgePilotLedger {
  configure(value: PilotEnv): void { Object.assign(this.env, value); }
}
