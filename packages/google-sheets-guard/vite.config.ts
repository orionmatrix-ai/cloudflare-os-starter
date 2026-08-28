export default {
  run: {
    tasks: {
      "clean:error-reporting-artifacts": {
        command:
          "node ../../cloudflare-os/scripts/clean-error-reporting-artifacts.ts .",
        cache: false,
      },
      "build:configurator": {
        command:
          "node ../../cloudflare-os/scripts/build-gatekeeper-configurator.ts .",
        dependsOn: ["clean:error-reporting-artifacts"],
        input: [
          { auto: true },
          { pattern: "!**/src/generated/**", base: "workspace" },
        ],
        output: ["src/generated/**"],
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
      build: {
        command: "tsc --noEmit",
        dependsOn: ["build:configurator"],
        input: [{ auto: true }],
        output: [],
      },
      test: {
        command: "vitest run",
        input: [{ auto: true }],
        output: [],
      },
    },
  },
};
