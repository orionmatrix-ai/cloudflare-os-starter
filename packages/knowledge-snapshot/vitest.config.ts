import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import capnwebValidate from "capnweb-validate/vite";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
      durableObjects: { TEST_LEDGER: { className: "TestLedger", useSQLite: true } },
    },
  })],
  test: { include: ["__tests__/*.test.ts"] },
});
