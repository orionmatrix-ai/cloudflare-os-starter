import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/knowledge-snapshot-ci.yml", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// These are invariant checks, not a general YAML or GitHub workflow validator.
test("CI uses a read-only PR context, no secrets and no automatic deployment", () => {
  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run:|secrets\.|id-token:|write-all|: write\b/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /clean: false/);
  assert.match(workflow, /package-manager-cache: false/);
  const commands = [...workflow.matchAll(/\brun: (.+)/g)].map(match => match[1]);
  for (const command of commands) {
    if (/\bdeploy\b/.test(command) && !/deploy\.test\.ts/.test(command)) {
      assert.match(command, /\bdeploy --dry-run\b/);
    }
    assert.doesNotMatch(command, /secret\s+(put|bulk)|git\s+(push|reset|clean)|curl\b/);
  }
});

test("CI pins actions, runtimes, dependencies and an explicit job budget", () => {
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.equal(actions.length, 2);
  for (const action of actions) assert.match(action, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.ok(workflow.includes(`npm install --global ${manifest.packageManager}`));
  assert.ok(workflow.includes(`node-version: '${manifest.engines.node.replace(/^>=/, "")}'`));
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
});

test("CI includes the synthetic boundary tests, type checks and existing deployment tests", () => {
  for (const command of [
    "node --test scripts/knowledge-ci.test.ts",
    "pnpm --filter knowledge-snapshot types:check",
    "pnpm --filter knowledge-snapshot test:run",
    "node --test scripts/deploy.test.ts",
    "pnpm run lint:check packages/knowledge-snapshot/src packages/knowledge-snapshot/__tests__",
  ]) assert.ok(workflow.includes(`run: ${command}`));
});
