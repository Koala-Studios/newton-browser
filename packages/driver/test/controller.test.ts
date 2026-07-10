import test from "node:test";
import assert from "node:assert/strict";

import { createBridgeRuntime } from "../src/controller.js";

test("BridgeRuntime drives a click command through a fake transport", async () => {
  const events: Array<{ commandId: string; eventType: string; detail: unknown }> = [];
  const results: unknown[] = [];
  let commandHandler: ((command: unknown) => Promise<void> | void) | null = null;
  const transport = {
    async createSession() {
      return { sessionId: "s1" };
    },
    async attachTab() {},
    subscribe(_sessionId: string, onCommand: (command: unknown) => Promise<void> | void) {
      commandHandler = onCommand;
      return () => {
        commandHandler = null;
      };
    },
    async listSessions() {
      return [{ sessionId: "s1", origin: "https://example.com", tabMode: "owned_group", ownedTabId: 101 }];
    },
    async postEvent(commandId: string, eventType: string, detail: unknown) {
      events.push({ commandId, eventType, detail });
    },
    async postResult(event: unknown) {
      results.push(event);
    },
    async stopSession() {},
    async stopAll() {},
  };
  const tabs = {
    async createOwnedTab() {
      return { tabId: 101, groupId: 201 };
    },
    async removeTab() {},
    async getTab() {
      return { id: 101, url: "https://example.com/page" };
    },
  };
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach(tabId: number) {
      assert.equal(tabId, 101);
      this.attached = true;
    },
    async detach() {
      this.attached = false;
    },
    isAttachedTo(tabId: number) {
      return this.attached && tabId === 101;
    },
    async reassertOverlay() {},
    markDetached() {
      this.attached = false;
    },
    async resolveEvidence() {
      return { resolved: { origin: "https://example.com", accessibleName: "Open" }, signals: {} };
    },
    async executeAction(action: { kind?: string }) {
      assert.equal(action.kind, "click");
      return {
        status: "verified",
        verified: true,
        changed: { clicked: true },
        observation: {
          kind: "observation",
          mode: "cdp",
          origin: "https://example.com",
          title: "Example",
          nodes: [],
          nodeCount: 0,
          truncated: false,
          capturedAt: "2026-06-30T00:00:00.000Z",
        },
      };
    },
  };
  const runtime = createBridgeRuntime({
    transport,
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "browser_bridge.act", commitBoundary: "none" };
    },
    tabs,
    driverFactory: () => driver,
  });

  const sessionId = await runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  assert.equal(sessionId, "s1");
  assert.equal(runtime.snapshot().count, 1);
  assert.ok(commandHandler);

  await commandHandler?.({
    commandId: "c1",
    sessionId: "s1",
    actionKind: "click",
    action: { kind: "click", target: { ref: "e1" } },
  });

  assert.deepEqual(events.map((event) => event.eventType), ["running"]);
  assert.deepEqual(results, [{
    commandId: "c1",
    ok: true,
    decision: {
      blocked: false,
      approvalRequired: false,
      reasons: [],
      class: "agentic",
      permissionRequired: "browser_bridge.act",
      commitBoundary: "none",
    },
    result: {
      kind: "observation",
      mode: "cdp",
      origin: "https://example.com",
      title: "Example",
      nodes: [],
      nodeCount: 0,
      truncated: false,
      capturedAt: "2026-06-30T00:00:00.000Z",
      actionStatus: "verified",
      verified: true,
      changed: { clicked: true },
    },
  }]);
});

test("BridgeRuntime treats approval-required floor decisions as non-blocking metadata", async () => {
  const results: unknown[] = [];
  let commandHandler: ((command: unknown) => Promise<void> | void) | null = null;
  const transport = {
    async createSession() {
      return { sessionId: "s1" };
    },
    async attachTab() {},
    subscribe(_sessionId: string, onCommand: (command: unknown) => Promise<void> | void) {
      commandHandler = onCommand;
      return () => {
        commandHandler = null;
      };
    },
    async listSessions() {
      return [{ sessionId: "s1", origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group", ownedTabId: 101 }];
    },
    async postEvent() {},
    async postResult(event: unknown) {
      results.push(event);
    },
    async stopSession() {},
    async stopAll() {},
  };
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach() {
      this.attached = true;
    },
    async detach() {
      this.attached = false;
    },
    isAttachedTo() {
      return this.attached;
    },
    async reassertOverlay() {},
    markDetached() {
      this.attached = false;
    },
    async resolveEvidence() {
      return { resolved: { origin: "https://example.com", accessibleName: "Publish" }, signals: { formSubmit: true } };
    },
    async executeAction(action: { kind?: string }) {
      assert.equal(action.kind, "click");
      return { status: "verified", verified: true, changed: { clicked: true } };
    },
  };
  const runtime = createBridgeRuntime({
    transport,
    evaluateFloor() {
      return {
        blocked: false,
        approvalRequired: true,
        reasons: ["structural_commit"],
        class: "approval_required",
        permissionRequired: "browser_bridge.act",
        commitBoundary: "commit",
      };
    },
    tabs: {
      async createOwnedTab() {
        return { tabId: 101, groupId: 201 };
      },
      async removeTab() {},
      async getTab() {
        return { id: 101, url: "https://example.com/page" };
      },
    },
    driverFactory: () => driver,
  });

  await runtime.startSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  await commandHandler?.({
    commandId: "c1",
    sessionId: "s1",
    actionKind: "click",
    action: { kind: "click", name: "Publish" },
  });

  assert.deepEqual(results, [{
    commandId: "c1",
    ok: true,
    result: { kind: "ack", message: "verified" },
    decision: {
      blocked: false,
      approvalRequired: true,
      reasons: ["structural_commit"],
      class: "approval_required",
      permissionRequired: "browser_bridge.act",
      commitBoundary: "commit",
    },
  }]);
});

test("BridgeRuntime forwards debugger events into the active driver", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const transport = {
    async createSession() {
      return { sessionId: "s1" };
    },
    async attachTab() {},
    subscribe() {
      return () => {};
    },
    async listSessions() {
      return [];
    },
    async stopSession() {},
    async stopAll() {},
  };
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach() {
      this.attached = true;
    },
    async detach() {
      this.attached = false;
    },
    isAttachedTo() {
      return this.attached;
    },
    async reassertOverlay() {},
    markDetached() {
      this.attached = false;
    },
    recordDebuggerEvent(method: string, params: unknown) {
      seen.push({ method, params });
    },
  };
  const runtime = createBridgeRuntime({
    transport,
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "browser_bridge.act", commitBoundary: "none" };
    },
    tabs: {
      async createOwnedTab() {
        return { tabId: 101, groupId: 201 };
      },
      async removeTab() {},
      async getTab() {
        return { id: 101, url: "https://example.com/page" };
      },
    },
    driverFactory: () => driver,
  });

  await runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  await runtime.handleDebuggerEvent({ tabId: 101 }, "Network.requestWillBeSent", { request: { method: "POST" } });
  assert.deepEqual(seen, [{ method: "Network.requestWillBeSent", params: { request: { method: "POST" } } }]);
});

test("BridgeRuntime binds host sessions once when ensure runs concurrently", async () => {
  let createOwnedTabCalls = 0;
  let attachTabCalls = 0;
  let resolveCreateOwnedTab: ((value: { tabId: number; groupId: number }) => void) | null = null;
  let markCreateOwnedTabStarted: (() => void) | null = null;
  const createOwnedTabStarted = new Promise<void>((resolve) => {
    markCreateOwnedTabStarted = resolve;
  });
  const transport = {
    async createSession() {
      return { sessionId: "unused" };
    },
    async attachTab() {
      attachTabCalls += 1;
    },
    subscribe() {
      return () => {};
    },
    async listSessions() {
      return [{ sessionId: "external-1", origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" }];
    },
    async postEvent() {},
    async postResult() {},
    async stopSession() {},
    async stopAll() {},
  };
  const runtime = createBridgeRuntime({
    transport,
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "browser_bridge.act", commitBoundary: "none" };
    },
    tabs: {
      async createOwnedTab() {
        createOwnedTabCalls += 1;
        markCreateOwnedTabStarted?.();
        return new Promise((done) => {
          resolveCreateOwnedTab = done;
        });
      },
      async removeTab() {},
      async getTab() {
        return { id: 101, url: "https://example.com/page" };
      },
    },
    driverFactory: () => ({
      attached: false,
      ownsTab: false,
      accent: null,
      async attach() {
        this.attached = true;
      },
      async detach() {
        this.attached = false;
      },
      isAttachedTo() {
        return this.attached;
      },
      async reassertOverlay() {},
      markDetached() {
        this.attached = false;
      },
    }),
  });

  const first = runtime.ensureForActiveSessions();
  await createOwnedTabStarted;
  assert.equal(createOwnedTabCalls, 1);
  const second = runtime.ensureForActiveSessions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createOwnedTabCalls, 1);
  resolveCreateOwnedTab?.({ tabId: 101, groupId: 201 });
  await Promise.all([first, second]);
  assert.equal(createOwnedTabCalls, 1);
  assert.equal(attachTabCalls, 2, "binding reports pending and attached states exactly once each");
});

test("BridgeRuntime refuses a current-tab session when focus moved outside the origin grant", async () => {
  const stopped: string[] = [];
  let attachCalls = 0;
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "unused" }; },
      async attachTab() { attachCalls += 1; },
      subscribe() { return () => {}; },
      async listSessions() {
        return [{
          sessionId: "focused-escape",
          origin: "https://example.com",
          allowedOrigins: ["https://example.com"],
          tabMode: "current",
        }];
      },
      async postEvent() {},
      async postResult() {},
      async stopSession(sessionId: string) { stopped.push(sessionId); },
      async stopAll() {},
    },
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "read_only", permissionRequired: "browser_bridge.observe", commitBoundary: "none" };
    },
    tabs: {
      async createOwnedTab() { throw new Error("must not create an owned tab"); },
      async removeTab() {},
      async getTab() { return { id: 202, url: "https://outside.example/private" }; },
    },
    driverFactory: () => ({
      attached: false,
      ownsTab: false,
      accent: null,
      async attach() { throw new Error("must not attach outside the grant"); },
      async detach() {},
      isAttachedTo() { return false; },
      async reassertOverlay() {},
      markDetached() {},
    }),
  });

  await runtime.ensureForActiveSessions(202);
  assert.equal(runtime.snapshot().count, 0);
  assert.equal(attachCalls, 1, "the pending binding is reported but never marked attached");
  assert.deepEqual(stopped, ["focused-escape"]);
});
