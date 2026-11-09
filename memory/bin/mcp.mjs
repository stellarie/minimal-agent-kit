#!/usr/bin/env node
import readline from "node:readline";
import { findTool, TOOLS } from "../src/commands.mjs";
import { Store } from "../src/store.mjs";

const SERVER_INFO = { name: "agent-memory", version: "0.1.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(request) {
  const { method, params = {} } = request;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case "tools/call": {
      const tool = findTool(params.name);
      if (!tool || !tool.name.startsWith("memory_")) {
        throw Object.assign(new Error(`unknown tool: ${params.name}`), { code: -32602 });
      }
      try {
        // A new store per call sees writes from other processes.
        const text = tool.run(new Store(), params.arguments ?? {});
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    send({ id: null, error: { code: -32600, message: "invalid request" } });
    return;
  }
  const isRequest = request.id !== undefined && request.id !== null;
  try {
    const result = handle(request);
    if (isRequest) send({ id: request.id, result });
  } catch (err) {
    if (isRequest) send({ id: request.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
