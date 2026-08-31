export default {
  run: { tasks: {
    build: { command: "tsc --noEmit", input: [{ auto: true }], output: [] },
    test: { command: "vitest run", input: [{ auto: true }], output: [] },
  } },
};
