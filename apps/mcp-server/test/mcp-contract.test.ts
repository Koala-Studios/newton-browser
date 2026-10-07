import test from "node:test";
import assert from "node:assert/strict";

import { EngineHost } from "../src/browser-runtime/engine-host.ts";
import { ENGINE_TOOL_CATALOG } from "../src/engine-mcp.ts";
import { CLASSIC_MCP_PROTOCOL_VERSIONS, createMcpConnectionHandler, handleMcpMessage } from "../src/mcp-server.ts";
import { MODERN_MCP_PROTOCOL_VERSION } from "../src/modern-mcp-stdio.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "newton-test", version: "1" },
};

function unlaunchedHost(): { host: EngineHost; launches: () => number } {
  let launches = 0;
  return { host: new EngineHost(async () => { launches++; throw new Error("not_started"); }), launches: () => launches };
}

test("server/discover publishes the single modern protocol and untrusted-page instructions", async () => {
  const { host } = unlaunchedHost();
  try {
    const response = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } });
    assert.ok(response && "result" in response);
    const result = response.result as Record<string, unknown>;
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.supportedVersions, [MODERN_MCP_PROTOCOL_VERSION]);
    assert.match(String(result.instructions), /untrusted/u);
    assert.equal((result._meta as Record<string, { name: string }>)["io.modelcontextprotocol/serverInfo"].name, "newton-browser");
  } finally { await host.close(); }
});

test("modern metadata is mandatory and old protocol handshakes are rejected", async () => {
  const { host } = unlaunchedHost();
  try {
    const missing = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.ok(missing && "error" in missing);
    assert.equal(missing.error.code, -32602);
    const old = await handleMcpMessage(host, { jsonrpc: "2.0", id: 2, method: "initialize",
      params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } });
    assert.ok(old && "error" in old);
    assert.equal(old.error.code, -32022);
    assert.deepEqual(old.error.data, { supported: [MODERN_MCP_PROTOCOL_VERSION], requested: "2025-11-25" });
    const retired = await handleMcpMessage(host, { jsonrpc: "2.0", id: 3, method: "initialize", params: { _meta: META } });
    assert.ok(retired && "error" in retired);
    assert.equal(retired.error.code, -32601);
  } finally { await host.close(); }
});

test("session.start publishes one object that shows existing mode and the new_tab target", async () => {
  // A client that cannot show a root oneOf merged the branches and kept only mode "owned" and the tab target.
  const start = ENGINE_TOOL_CATALOG.find(tool => tool.name === "browser.session.start")!.inputSchema as Record<string, any>;
  assert.equal(start.oneOf, undefined);
  assert.deepEqual(start.properties.mode, { enum: ["owned", "existing"] });
  assert.deepEqual(start.properties.target.oneOf.map((shape: any) => shape.properties.kind.const), ["tab", "new_tab"]);
  assert.ok(start.properties.connectionId && start.properties.url && start.properties.viewport);
  let claims = 0;
  const host = new EngineHost(async () => { throw new Error("not_started"); }, async () => { claims++; throw new Error("not_started"); });
  try {
    const call = async (args: unknown) => {
      const reply = await handleMcpMessage(host, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { _meta: META, name: "browser.session.start", arguments: args } });
      return JSON.parse(((reply as { result: { content: { text: string }[] } }).result.content[0]).text);
    };
    // A new_tab target is explained against the new_tab shape, not the tab shape.
    assert.deepEqual((({ field, expected }) => ({ field, expected }))(await call({ mode: "existing", connectionId: "c", target: { kind: "new_tab", url: "https://example.com/" } })),
      { field: "arguments.target.instanceId", expected: "required" });
    assert.equal((await call({ mode: "existing", target: { kind: "tab", tabId: 3, instanceId: "i", url: "https://example.com/" } })).field, "arguments.target.url");
    assert.equal((await call({ mode: "owned", url: "https://example.com/", target: { kind: "new_tab", url: "https://example.com/", instanceId: "i" } })).field, "arguments.target");
    assert.equal(claims, 0);
  } finally {
    await host.close();
  }
});

test("the catalog is the engine's, and unknown fields and tools are refused before any browser starts", async () => {
  const { host, launches } = unlaunchedHost();
  try {
    const listed = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
    assert.ok(listed && "result" in listed);
    assert.equal((listed.result as { resultType: string }).resultType, "complete");
    for (const tool of ENGINE_TOOL_CATALOG) assert.equal((tool.inputSchema as { type?: string }).type, "object", tool.name);
    const names = (listed.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
    assert.deepEqual(names, ENGINE_TOOL_CATALOG.map(tool => tool.name));
    for (const name of ["browser.session.start", "browser.act", "browser.observe", "browser.console", "browser.network"]) assert.ok(names.includes(name), name);
    const cursor = await handleMcpMessage(host, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META, cursor: "two" } });
    assert.ok(cursor && ("error" in cursor || (cursor.result as { isError?: boolean }).isError));
    for (const params of [
      { _meta: META, name: "browser.sessions.list", arguments: {}, requestState: "legacy" },
      { _meta: META, name: "browser.retired", arguments: {} },
      { _meta: META, name: "browser.observe", arguments: { sessionId: "missing", legacyMode: "compact" } },
    ]) {
      const reply = await handleMcpMessage(host, { jsonrpc: "2.0", id: 3, method: "tools/call", params });
      assert.ok(reply && ("error" in reply || (reply.result as { isError?: boolean }).isError), JSON.stringify(params));
    }
    assert.equal(launches(), 0);
  } finally { await host.close(); }
});

// Claude Code 2.1.228 opened with the classic handshake on 2026-10-05 and could not connect.
test("a connection opened with the classic initialize handshake gets the same tools without per-request metadata", async () => {
  const { host, launches } = unlaunchedHost();
  const signal = new AbortController().signal;
  try {
    const handle = createMcpConnectionHandler(host);
    const init = await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.228" } } }, { signal });
    assert.ok(init && "result" in init);
    const result = init.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    assert.equal(result.protocolVersion, "2025-11-25");
    assert.equal(result.serverInfo.name, "newton-browser");
    assert.match(result.instructions, /untrusted/u);
    const older = await createMcpConnectionHandler(host)({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-01-01" } }, { signal });
    assert.equal((older as { result: { protocolVersion: string } }).result.protocolVersion, CLASSIC_MCP_PROTOCOL_VERSIONS[0], "an unknown version gets the newest classic one");

    const listed = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "x" } }, { signal });
    assert.ok(listed && "result" in listed);
    assert.deepEqual((listed.result as { tools: { name: string }[] }).tools.map(tool => tool.name), ENGINE_TOOL_CATALOG.map(tool => tool.name));
    const ping = await handle({ jsonrpc: "2.0", id: 2, method: "ping" }, { signal });
    assert.deepEqual(ping, { jsonrpc: "2.0", id: 2, result: {} });
    const call = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser.sessions.list", arguments: {} } }, { signal });
    assert.ok(call && "result" in call);
    assert.deepEqual(JSON.parse((call.result as { content: { text: string }[] }).content[0]!.text), { sessions: [] });
    const unknown = await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, { signal });
    assert.ok(unknown && "error" in unknown && unknown.error.code === -32601);
    assert.equal(launches(), 0);
  } finally { await host.close(); }
});
