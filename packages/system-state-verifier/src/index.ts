export * from "./gatekeeper.js";
export * from "./types.js";
export * from "./verification.js";

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      service: "om-system-state-verifier",
      status: "private-gatekeeper-binding-only",
    });
  },
};
