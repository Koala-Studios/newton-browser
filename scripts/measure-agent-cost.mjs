// Model cost of what every task pays before its first action: the engine's discovery
// instructions and tool catalog, counted with the o200k tokenizer.
import process from "node:process";
import { getEncoding } from "js-tiktoken";

import { EngineHost } from "../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { handleMcpMessage } from "../apps/mcp-server/src/mcp-server.ts";
import { MODERN_MCP_PROTOCOL_VERSION } from "../apps/mcp-server/src/modern-mcp-stdio.ts";
import { serializeForBudget } from "./evals/token-budget.mjs";

// Raise only with a reason recorded in the commit; a larger catalog costs every task.
const BUDGETS = { instructions: 60, catalog: 6300 };

const META = { "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} };
const host = new EngineHost(async () => { throw new Error("not_started"); });
try {
  const discover = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } });
  const listed = await handleMcpMessage(host, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } });
  if (!discover || !("result" in discover) || !listed || !("result" in listed)) throw new Error("catalog_unavailable");
  const encoding = getEncoding("o200k_base");
  const tokens = text => encoding.encode(text).length;
  const measured = {
    instructions: tokens(String(discover.result.instructions)),
    catalog: tokens(serializeForBudget(listed.result.tools)),
  };
  const over = Object.entries(measured).filter(([name, value]) => value > BUDGETS[name]);
  const report = { ok: over.length === 0, tokenizer: "o200k_base", tools: listed.result.tools.length, measured, budgets: BUDGETS };
  process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`);
  if (over.length) process.exitCode = 1;
} finally { await host.close(); }
