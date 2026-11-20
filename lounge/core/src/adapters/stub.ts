import type { Adapter, AdapterName } from "./types.ts";

export function unavailableAdapter(name: AdapterName, reason: string): Adapter {
  return {
    name,
    available: async () => ({ ok: false, reason }),
    chatTurn: async () => {
      throw new Error(reason);
    },
  };
}

// A fixed reply. An empty reply passes.
export function replyAdapter(name: AdapterName, reply: string): Adapter {
  return {
    name,
    available: async () => ({ ok: true }),
    chatTurn: async () => (reply.trim() === "" ? { kind: "pass" } : { kind: "post", text: reply }),
  };
}
