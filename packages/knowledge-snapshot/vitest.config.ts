import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./src/index.ts",
    miniflare: {
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["nodejs_compat"],
    },
  })],
  test: { include: ["__tests__/*.test.ts"] },
});
