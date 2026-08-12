import test from "node:test";
import assert from "node:assert/strict";

import { createDirectBrowserHost } from "../src/browser-runtime/direct-browser-host.ts";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_ANNOTATIONS, NEWTON_BROWSER_CONTRACT_VERSION } from "../src/mcp-contract.ts";
import { handleMcpMessage, toolList } from "../src/mcp-server.ts";

test("initialize publishes contract version and untrusted-page instructions", async () => {
  const bridge = createDirectBrowserHost({ launchOwnedRuntime: async () => { throw new Error("not_started"); } });
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

test("the v2 surface is direct-only, compact, and contains no retired tab or transport controls", () => {
  const tools = toolList() as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  assert.equal(NEWTON_BROWSER_CONTRACT_VERSION, "2.0");
  assert.deepEqual(tools.map((tool) => tool.name), [
    "browser.status",
    "browser.session.start",
    "browser.observe",
    "browser.act",
    "browser.screenshot",
    "browser.console",
    "browser.network",
    "browser.sessions.list",
    "browser.session.finalize",
    "browser.session.stop",
    "browser.stop_all",
  ]);
  for (const tool of tools) assert.equal("transport" in tool.inputSchema.properties, false, tool.name);
  assert.equal(tools.some((tool) => tool.name.startsWith("browser.tabs.")), false);
  assert.deepEqual(tools.find((tool) => tool.name === "browser.session.finalize")?.inputSchema.properties.disposition, {
    type: "string",
    enum: ["close"],
  });
});

test("browser.act publishes the canonical strict discriminated schema", () => {
  const actTool = toolList().find((tool: any) => tool.name === "browser.act") as any;
  const action = actTool.inputSchema.properties.action;
  assert.deepEqual(actTool.inputSchema.properties.timeoutMs, { type: "integer", minimum: 1, maximum: 300000 });
  assert.equal(action.additionalProperties, false);
  assert.deepEqual(Object.keys(action["x-newtonVariants"]).sort(), [...action.properties.kind.enum].sort());
  for (const dedicated of ["observe", "screenshot", "console", "network"]) {
    assert.equal(action.properties.kind.enum.includes(dedicated), false);
    assert.equal(dedicated in action["x-newtonVariants"], false);
  }
  for (const dedicatedField of ["sensitiveZones", "fullPage", "query", "maxNodes", "urlPattern", "requestId"]) {
    assert.equal(dedicatedField in action.properties, false);
  }
});

test("browser.screenshot publishes bounded trusted-raster sensitive zones", () => {
  const screenshot = toolList().find((tool: any) => tool.name === "browser.screenshot") as any;
  const zones = screenshot.inputSchema.properties.sensitiveZones;
  assert.equal(zones.minItems, 1);
  assert.equal(zones.maxItems, 32);
  assert.equal(zones.items.additionalProperties, false);
  assert.equal(zones.items.minProperties, 1);
  assert.equal(zones.items.maxProperties, 1);
  assert.deepEqual(zones.items.oneOf, [
    { required: ["ref"] },
    { required: ["selector"] },
    { required: ["name"] },
    { required: ["label"] },
  ]);
});

test("browser.act rejects dedicated-tool kinds before host dispatch", async () => {
  let dispatches = 0;
  const host = {
    listSessions: () => [{
      sessionId: "s1", hostInstanceId: "h1", origin: "https://example.com",
      allowedOrigins: ["https://example.com"], attached: true, liveOrigin: "https://example.com",
      lifecycleState: "active", goal: "", instanceLabel: "test",
    }],
    dispatch: async () => { dispatches += 1; throw new Error("must_not_dispatch"); },
  } as never;
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "browser.act", arguments: { sessionId: "s1", action: { kind: "screenshot" } } },
  });
  const content = (response?.result as { content: Array<{ text?: string }> }).content;
  assert.equal(JSON.parse(content[0]?.text ?? "{}").errorCode, "use_dedicated_tool");
  assert.equal(dispatches, 0);
});
