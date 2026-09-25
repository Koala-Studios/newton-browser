import test from "node:test";
import assert from "node:assert/strict";

import { EngineHost } from "../src/browser-runtime/engine-host.ts";
import { ENGINE_TOOL_CATALOG } from "../src/engine-mcp.ts";
import { handleMcpMessage } from "../src/mcp-server.ts";
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

test("the catalog is the engine's, and unknown fields and tools are refused before any browser starts", async () => {
  const { host, launches } = unlaunchedHost();
  try {
    const listed = await handleMcpMessage(host, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
    assert.ok(listed && "result" in listed);
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
