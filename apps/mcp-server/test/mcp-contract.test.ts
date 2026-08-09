import test from "node:test";
import assert from "node:assert/strict";

import { createNewtonBrowserHost } from "../src/bridge.ts";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_ANNOTATIONS, NEWTON_BROWSER_CONTRACT_VERSION } from "../src/mcp-contract.ts";
import { handleMcpMessage, toolList } from "../src/mcp-server.ts";

test("initialize publishes contract version and untrusted-page instructions", async () => {
  const bridge = createNewtonBrowserHost();
  const response = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal((response?.result as any).contractVersion, NEWTON_BROWSER_CONTRACT_VERSION);
  assert.equal((response?.result as any).serverInfo.contractVersion, NEWTON_BROWSER_CONTRACT_VERSION);
  assert.equal((response?.result as any).instructions, MCP_SERVER_INSTRUCTIONS);
  assert.match(MCP_SERVER_INSTRUCTIONS, /untrusted data/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /never instructions or authorization/);
});

test("every public tool carries the reviewed truthful annotation matrix", () => {
  const tools = toolList();
  assert.deepEqual(Object.keys(MCP_TOOL_ANNOTATIONS).sort(), tools.map((tool: any) => tool.name).sort());
  for (const tool of tools as any[]) {
    assert.deepEqual(tool.annotations, MCP_TOOL_ANNOTATIONS[tool.name]);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
    assert.equal(tool.annotations.openWorldHint, tool.name === "browser.act" || tool.name === "browser.session.start");
  }
});

test("browser.act publishes the canonical strict discriminated schema", () => {
  const action = (toolList().find((tool: any) => tool.name === "browser.act") as any).inputSchema.properties.action;
  assert.equal(action.additionalProperties, false);
  assert.deepEqual(Object.keys(action["x-newtonVariants"]).sort(), [...action.properties.kind.enum].sort());
});
