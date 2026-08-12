import assert from "node:assert/strict";
import test from "node:test";

import { createDirectBrowserHost } from "../../src/browser-runtime/direct-browser-host.ts";
import { handleMcpMessage } from "../../src/mcp-server.ts";

test("MCP projects direct readiness without extension, identity, process, or target fields", async () => {
  const host = createDirectBrowserHost({
    launchOwnedRuntime: async () => { throw new Error("unused"); },
  });
  try {
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser.status", arguments: { detail: "full" } },
    });
    assert.ok(response && "result" in response);
    const result = response?.result as { content?: Array<{ type?: string; text?: string }> };
    const text = result.content?.[0]?.text;
    assert.equal(typeof text, "string");
    const projected = JSON.parse(text ?? "null") as Record<string, unknown>;
    assert.deepEqual({
      ready: projected.ready,
      configured: projected.configured,
      runtimeState: projected.runtimeState,
      mode: projected.mode,
      sessionCount: projected.sessionCount,
      activeSessionCount: projected.activeSessionCount,
      cleanupUncertainCount: projected.cleanupUncertainCount,
    }, {
      ready: false,
      configured: true,
      runtimeState: "idle",
      mode: "direct",
      sessionCount: 0,
      activeSessionCount: 0,
      cleanupUncertainCount: 0,
    });
    const serialized = JSON.stringify(projected);
    for (const forbidden of ["extension", "identityId", "pid", "rootTargetId", "syntheticTabId", "proxy"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    await host.close();
  }
});

test("MCP forwards only validated direct identity and browser selection into session initialization", async () => {
  const initializations: unknown[] = [];
  const host = createDirectBrowserHost({
    async launchOwnedRuntime({ init }) {
      initializations.push(init);
      return {
        receipt: {
          status: "ready",
          identityId: "nbi_0123456789abcdef0123456789abcdef",
          browserFamily: "edge",
          pid: 441,
        },
        unavailable: new Promise<void>(() => {}),
        claimDriverBootstrap: () => ({
          transport: { async send() { return {}; }, onEvent() { return () => {}; } },
          rootTargetId: "root",
          syntheticTabId: 71,
        }),
        cleanupState: () => "ready",
        async close() {},
      };
    },
    async startDriverSession() {
      return {
        initialObservation: undefined,
        async execute() { return { status: "verified" }; },
        async stop() {},
        snapshot() { return { state: "active", runningCommands: 0, queuedCommands: 0, runningBytes: 0, queuedBytes: 0, queueClosed: false }; },
      };
    },
  });
  try {
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "browser.session.start",
        arguments: {
          origin: "https://example.com",
          identityId: "nbi_0123456789abcdef0123456789abcdef",
          browser: "edge",
        },
      },
    });
    assert.equal(JSON.stringify(response).includes("private"), false);
    assert.equal(initializations.length, 1);
    assert.equal((initializations[0] as { identityId?: string }).identityId, "nbi_0123456789abcdef0123456789abcdef");
    assert.equal((initializations[0] as { browserFamily?: string }).browserFamily, "edge");
  } finally {
    await host.close();
  }
});

test("MCP catalog keeps identity and browser selection bounded", async () => {
  const host = createDirectBrowserHost({ launchOwnedRuntime: async () => { throw new Error("unused"); } });
  try {
    const response = await handleMcpMessage(host, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const start = (response?.result as { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }> })
      ?.tools?.find((tool) => tool.name === "browser.session.start");
    assert.deepEqual(start?.inputSchema?.properties?.browser, { type: "string", enum: ["chrome", "edge"] });
    assert.deepEqual(start?.inputSchema?.properties?.identityId, { type: "string", pattern: "^nbi_[a-f0-9]{32}$" });
  } finally {
    await host.close();
  }
});
