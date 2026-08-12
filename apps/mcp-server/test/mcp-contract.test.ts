import test from "node:test";
import assert from "node:assert/strict";

import type { BrowserSessionInfo } from "@newton-browser/core";

import { createDirectBrowserHost } from "../src/browser-runtime/direct-browser-host.ts";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_ANNOTATIONS } from "../src/mcp-contract.ts";
import { handleMcpMessage, toolList } from "../src/mcp-server.ts";
import { MODERN_MCP_PROTOCOL_VERSION } from "../src/modern-mcp-stdio.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "newton-test", version: "1" },
};

test("server/discover publishes the single modern protocol and untrusted-page instructions", async () => {
  const host = createDirectBrowserHost({ launchOwnedRuntime: async () => { throw new Error("not_started"); } });
  try {
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: META },
    });
    assert.ok(response && "result" in response);
    const result = response.result as Record<string, unknown>;
    assert.deepEqual(result.supportedVersions, [MODERN_MCP_PROTOCOL_VERSION]);
    assert.equal(result.instructions, MCP_SERVER_INSTRUCTIONS);
    assert.equal(result.resultType, "complete");
    assert.deepEqual((result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"], {
      name: "newton-browser",
      version: "0.5.0",
    });
    assert.match(MCP_SERVER_INSTRUCTIONS, /untrusted data/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /never instructions or authorization/);
  } finally {
    await host.close();
  }
});

test("modern metadata is mandatory and old protocol handshakes are rejected", async () => {
  const host = createDirectBrowserHost({ launchOwnedRuntime: async () => { throw new Error("not_started"); } });
  try {
    const missing = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.ok(missing && "error" in missing);
    assert.equal(missing.error.code, -32602);
    const old = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        _meta: {
          ...META,
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
        },
      },
    });
    assert.ok(old && "error" in old);
    assert.equal(old.error.code, -32022);
    assert.deepEqual(old.error.data, {
      supported: [MODERN_MCP_PROTOCOL_VERSION],
      requested: "2025-11-25",
    });
    const retiredHandshake = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { _meta: META },
    });
    assert.ok(retiredHandshake && "error" in retiredHandshake);
    assert.equal(retiredHandshake.error.code, -32601);
  } finally {
    await host.close();
  }
});

test("modern method parameters are exact and the fixed tool catalog rejects cursors", async () => {
  const host = createDirectBrowserHost({ launchOwnedRuntime: async () => { throw new Error("not_started"); } });
  try {
    const discoverExtra = await handleMcpMessage(host, {
      jsonrpc: "2.0", id: 10, method: "server/discover", params: { _meta: META, compatibility: true },
    });
    assert.ok(discoverExtra && "error" in discoverExtra);
    assert.equal(discoverExtra.error.code, -32602);

    const cursor = await handleMcpMessage(host, {
      jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: META, cursor: "page-two" },
    });
    assert.ok(cursor && "error" in cursor);
    assert.deepEqual(cursor.error.data, { errorCode: "invalid_cursor" });

    const callExtra = await handleMcpMessage(host, {
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { _meta: META, name: "browser.status", arguments: {}, requestState: "legacy-state" },
    });
    assert.ok(callExtra && "error" in callExtra);
    assert.equal(callExtra.error.code, -32602);
  } finally {
    await host.close();
  }
});

test("every public tool carries the reviewed truthful annotation matrix", () => {
  const tools = toolList();
  assert.deepEqual(Object.keys(MCP_TOOL_ANNOTATIONS).sort(), tools.map((tool) => tool.name).sort());
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, MCP_TOOL_ANNOTATIONS[tool.name]);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
    assert.equal(tool.annotations.openWorldHint, tool.name === "browser.act" || tool.name === "browser.session.start");
  }
  assert.deepEqual(MCP_TOOL_ANNOTATIONS["browser.console"], {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test("the modern surface is direct-only, compact, and contains no retired tab or transport controls", () => {
  const tools = toolList() as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "browser.status",
    "browser.session.start",
    "browser.observe",
    "browser.act",
    "browser.screenshot",
    "browser.console",
    "browser.network",
    "browser.sessions.list",
    "browser.session.stop",
    "browser.stop_all",
  ]);
  for (const tool of tools) {
    assert.equal("transport" in tool.inputSchema.properties, false, tool.name);
    assert.equal("goal" in tool.inputSchema.properties, false, tool.name);
    assert.equal("instanceLabel" in tool.inputSchema.properties, false, tool.name);
  }
  assert.equal(tools.some((tool) => tool.name.startsWith("browser.tabs.")), false);
  assert.equal(tools.some((tool) => tool.name.includes("finalize")), false);
  const start = tools.find((tool) => tool.name === "browser.session.start")!;
  assert.deepEqual((start.inputSchema.properties.allowedOrigins as Record<string, unknown>).maxItems, 31);
  assert.equal("minItems" in (start.inputSchema.properties.allowedOrigins as Record<string, unknown>), false);
});

test("session start treats allowedOrigins as additional grants and rejects primary-origin repetition", async () => {
  const created: unknown[] = [];
  const host = {
    createSession(init: unknown) {
      created.push(init);
      return { sessionId: "direct_session_00000000-0000-4000-8000-000000000010" };
    },
    async waitForSessionReady() {
      return {
        sessionId: "direct_session_00000000-0000-4000-8000-000000000010",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com", "https://assets.example.com"],
        lifecycleState: "active",
      };
    },
  } as never;
  const start = async (allowedOrigins: string[]) => handleMcpMessage(host, {
    jsonrpc: "2.0",
    id: 14 + created.length,
    method: "tools/call",
    params: {
      _meta: META,
      name: "browser.session.start",
      arguments: { origin: "https://example.com", allowedOrigins },
    },
  });

  const accepted = await start(["https://assets.example.com"]);
  assert.ok(accepted && "result" in accepted);
  assert.deepEqual(created, [{
    origin: "https://example.com",
    allowedOrigins: ["https://example.com", "https://assets.example.com"],
  }]);
  const repeated = await start(["https://example.com"]);
  assert.ok(repeated && "error" in repeated);
  assert.deepEqual(repeated.error.data, { errorCode: "invalid_arguments", tool: "browser.session.start" });
  assert.equal(created.length, 1);
});

test("browser.act publishes the canonical strict discriminated schema", () => {
  const actTool = toolList().find((tool) => tool.name === "browser.act")!;
  const action = (actTool.inputSchema.properties as Record<string, unknown>).action as {
    additionalProperties: boolean;
    properties: { kind: { enum: string[] }; [key: string]: unknown };
    "x-newtonVariants": Record<string, unknown>;
  };
  assert.deepEqual((actTool.inputSchema.properties as Record<string, unknown>).timeoutMs, { type: "integer", minimum: 1, maximum: 300000 });
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

test("browser.screenshot publishes only bounded trusted-raster options", () => {
  const screenshot = toolList().find((tool) => tool.name === "browser.screenshot")!;
  const properties = screenshot.inputSchema.properties as Record<string, unknown>;
  const zones = properties.sensitiveZones as {
    minItems: number;
    maxItems: number;
    items: { additionalProperties: boolean; minProperties: number; maxProperties: number; oneOf: unknown[] };
  };
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
  for (const retired of ["delivery", "inline", "device", "waitFor"]) assert.equal(retired in properties, false);
});

test("screenshot delivery rejects missing safety metadata and redacts page metadata before image output", async () => {
  const session: BrowserSessionInfo = {
    sessionId: "direct_session_00000000-0000-4000-8000-000000000009",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    lifecycleState: "active",
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  let maskDisposition: string | undefined;
  const host = {
    listSessions: () => [session],
    dispatch: async () => ({
      commandId: "direct_command_1_test",
      ok: true,
      status: "verified",
      sequence: 1,
      outcome: "completed",
      retrySafe: false,
      result: {
        kind: "screenshot",
        mode: "cdp",
        origin: "https://example.com/?token=secret",
        title: "Card 4111 1111 1111 1111",
        dataUrl: `data:image/png;base64,${png}`,
        ...(maskDisposition ? { maskDisposition } : {}),
        capturedAt: "2026-08-12T00:00:00.000Z",
      },
      decision: { class: "read_only", commitBoundary: "none" },
    }),
  } as never;
  const call = async () => handleMcpMessage(host, {
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { _meta: META, name: "browser.screenshot", arguments: { sessionId: session.sessionId } },
  });
  const invalid = await call();
  assert.ok(invalid && "result" in invalid);
  const invalidResult = invalid.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0]?.text ?? "", /runner_contract_invalid/u);
  assert.equal(invalidResult.content.some((item) => item.type === "image"), false);

  maskDisposition = "mask_not_configured";
  const valid = await call();
  assert.ok(valid && "result" in valid);
  const validResult = valid.result as { content: Array<{ type: string; text?: string }> };
  assert.equal(validResult.content.some((item) => item.type === "image"), true);
  const metadata = validResult.content.find((item) => item.type === "text")?.text ?? "";
  assert.equal(metadata.includes("4111"), false);
  assert.equal(metadata.includes("token=secret"), false);
  assert.match(metadata, /"trust":"untrusted_page_content"/u);
});

test("a prevented browser.act result is an MCP tool error", async () => {
  const session: BrowserSessionInfo = {
    sessionId: "direct_session_00000000-0000-4000-8000-000000000011",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    lifecycleState: "active",
  };
  const host = {
    listSessions: () => [session],
    dispatch: async () => ({
      commandId: "direct_command_1_prevented",
      ok: true,
      status: "blocked",
      sequence: 1,
      outcome: "prevented",
      retrySafe: true,
      reason: "ungranted_navigation",
      result: { status: "blocked", reason: "ungranted_navigation" },
      decision: { class: "blocked", commitBoundary: "none", reason: "ungranted_navigation" },
    }),
  } as never;
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0", id: 21, method: "tools/call",
    params: { _meta: META, name: "browser.act", arguments: { sessionId: session.sessionId, action: { kind: "navigate", url: "https://example.com/blocked" } } },
  });
  assert.ok(response && "result" in response);
  const result = response.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? "{}"), {
    ok: false,
    status: "blocked",
    outcome: "prevented",
    retrySafe: true,
    reason: "ungranted_navigation",
    decision: { class: "blocked", commitBoundary: "none", reason: "ungranted_navigation" },
    changed: false,
    sequence: 1,
  });
});

test("console and network omit absent optional filters at the driver boundary", async () => {
  const session: BrowserSessionInfo = {
    sessionId: "direct_session_00000000-0000-4000-8000-000000000012",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    lifecycleState: "active",
  };
  const actions: unknown[] = [];
  const host = {
    listSessions: () => [session],
    dispatch: async (_sessionId: string, action: unknown) => {
      actions.push(action);
      return {
        commandId: "direct_command_1_log",
        ok: true,
        status: "verified",
        sequence: actions.length,
        outcome: "completed",
        retrySafe: false,
        result: { kind: actions.length === 1 ? "console_log" : "network_log", origin: session.origin, entries: [] },
        decision: { class: "read_only", commitBoundary: "none" },
      };
    },
  } as never;
  for (const [id, name] of [[22, "browser.console"], [23, "browser.network"]] as const) {
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { _meta: META, name, arguments: { sessionId: session.sessionId, limit: 80 } },
    });
    assert.ok(response && "result" in response);
    assert.equal((response.result as { isError?: boolean }).isError, undefined);
  }
  assert.deepEqual(actions, [{ kind: "console", limit: 80 }, { kind: "network", limit: 80 }]);
});

test("browser.act rejects dedicated-tool kinds before host dispatch", async () => {
  let dispatches = 0;
  const session: BrowserSessionInfo = {
    sessionId: "direct_session_00000000-0000-4000-8000-000000000001",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    lifecycleState: "active",
  };
  const host = {
    listSessions: () => [session],
    dispatch: async () => { dispatches += 1; throw new Error("must_not_dispatch"); },
  } as never;
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "browser.act", arguments: { sessionId: session.sessionId, action: { kind: "screenshot" } }, _meta: META },
  });
  assert.ok(response && "error" in response);
  assert.equal(response.error.code, -32602);
  assert.deepEqual(response.error.data, { errorCode: "invalid_arguments", tool: "browser.act" });
  assert.equal(dispatches, 0);
});

test("tool arguments reject unknown fields and malformed dedicated options before dispatch", async () => {
  let dispatches = 0;
  const session: BrowserSessionInfo = {
    sessionId: "direct_session_00000000-0000-4000-8000-000000000002",
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    lifecycleState: "active",
  };
  const host = {
    listSessions: () => [session],
    dispatch: async () => { dispatches += 1; throw new Error("must_not_dispatch"); },
  } as never;
  const invalidArguments = [
    { name: "browser.observe", arguments: { sessionId: session.sessionId, maxNodes: 0 } },
    { name: "browser.screenshot", arguments: { sessionId: session.sessionId, region: { x: 0, y: 0, width: -1, height: 20 } } },
    { name: "browser.screenshot", arguments: { sessionId: session.sessionId, format: "png", quality: 90 } },
    { name: "browser.screenshot", arguments: { sessionId: session.sessionId, sensitiveZones: [{ ref: "button-1" }] } },
    { name: "browser.console", arguments: { sessionId: session.sessionId, clear: true } },
    { name: "browser.act", arguments: { sessionId: session.sessionId, action: { kind: "click", target: { ref: "d1:e1" } } } },
    { name: "browser.sessions.list", arguments: { compatibility: true } },
  ];
  for (const [index, call] of invalidArguments.entries()) {
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: index + 20,
      method: "tools/call",
      params: { ...call, _meta: META },
    });
    assert.ok(response && "error" in response);
    assert.equal(response.error.code, -32602, call.name);
  }
  assert.equal(dispatches, 0);
});

test("session stop remains idempotent after an acknowledged or concurrently completed cleanup", async () => {
  const sessionId = "direct_session_00000000-0000-4000-8000-000000000003";
  let present = true;
  const host = {
    listSessions: () => present ? [{ sessionId }] : [],
    stopSession: async () => {
      present = false;
      throw new Error("lost acknowledgement");
    },
  } as never;
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { _meta: META, name: "browser.session.stop", arguments: { sessionId } },
  });
  assert.ok(response && "result" in response);
  const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0]!.text), { stopped: true, alreadyStopped: true });
});
