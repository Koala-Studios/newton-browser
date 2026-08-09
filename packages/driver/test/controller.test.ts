import test from "node:test";
import assert from "node:assert/strict";

import { createBridgeRuntime } from "../src/controller.js";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferredPromise<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function commandByteCount(command: unknown): number {
  return Buffer.byteLength(JSON.stringify(command), "utf8");
}

type CommandSeed = {
  sessionId: string;
  commandId: string;
  actionKind: string;
  action: unknown;
  sessionEpoch?: number;
  sequence?: number;
};

function createCommandSequencer() {
  const state = new Map<string, { epoch: number; next: number }>();
  return function nextCommand(seed: CommandSeed) {
    const current = state.get(seed.sessionId) ?? { epoch: 1, next: 1 };
    const sequence = seed.sequence ?? current.next;
    const sessionEpoch = seed.sessionEpoch ?? current.epoch;
    const next = {
      ...seed,
      sessionEpoch,
      sequence,
    };
    if (seed.sequence === undefined && seed.sessionEpoch === undefined) {
      current.next += 1;
      if (!state.has(seed.sessionId)) {
        state.set(seed.sessionId, { epoch: current.epoch, next: current.next });
      }
      state.get(seed.sessionId)!.next = current.next;
    }
    return next;
  };
}

function makeCommandForByteSize(seed: CommandSeed, targetBytes: number) {
  const baseline = commandByteCount(seed);
  const payload = Math.max(0, targetBytes - baseline);
  const action = seed.action && typeof seed.action === "object" ? seed.action as Record<string, unknown> : {};
  const command = { ...seed, action: { ...action, payload: "a".repeat(payload) } };
  const actual = commandByteCount(command);
  if (actual === targetBytes) return command;
  const adjustment = targetBytes - actual;
  return { ...command, action: { ...action, payload: "a".repeat(Math.max(0, payload + adjustment)) } };
}

type CommandHarnessState = {
  runtime: ReturnType<typeof createBridgeRuntime>;
  getCommandHandler: (sessionId: string) => ((command: unknown) => Promise<void> | void) | null;
  awaitCommandResult: (commandId: string) => Promise<unknown>;
  transport: {
    posts: unknown[];
    events: Array<{ commandId: string; eventType: string; detail: unknown }>;
    stopCalls: string[];
    stopAllCalls: string[];
    createOwnedTab: () => Promise<{ tabId: number; groupId: number }>;
    removeTab: (tabId: number) => void | Promise<void>;
    finalizeTab: (tabId: number, disposition: string) => void | Promise<void>;
    getTab: (tabId: number) => Promise<unknown>;
  };
  tabs: {
    createOwnedTab: () => Promise<{ tabId: number; groupId: number }>;
    removeTab: (tabId: number) => void | Promise<void>;
    getTab: (tabId: number) => Promise<unknown>;
    focusTab?: (tabId: number) => void | Promise<void>;
    finalizeTab?: (tabId: number, disposition: string) => void | Promise<void>;
  };
  drivers: any[];
};

function createControllerHarness({
  sessionId = "s-session",
  createSession = async () => ({ sessionId }),
  listSessions = async () => [],
  notify,
  evaluateFloor = () => ({
    blocked: false,
    approvalRequired: false,
    reasons: [],
    class: "agentic",
    permissionRequired: "newton_browser.act",
    commitBoundary: "none",
  }),
  transportOverrides = {},
  tabsOverrides = {},
  driverOverrides = {},
  driverFactory,
}: {
  sessionId?: string;
  createSession?: () => Promise<{ sessionId: string }>;
  notify?: (event: any) => Promise<void> | void;
  listSessions?: () => Promise<unknown[]>;
  evaluateFloor?: () => unknown;
  transportOverrides?: Record<string, any>;
  tabsOverrides?: Record<string, any>;
  driverOverrides?: Record<string, any>;
  driverFactory?: () => any;
} = {}): CommandHarnessState {
  const commandHandlers = new Map<string, (command: unknown) => Promise<void> | void>();
  const commandWaiters = new Map<string, Deferred<unknown>>();
  const commandResults = new Map<string, unknown>();
  const events: Array<{ commandId: string; eventType: string; detail: unknown }> = [];
  const posts: unknown[] = [];
  const stopCalls: string[] = [];
  const stopAllCalls: string[] = [];
  const drivers: any[] = [];

  const transport = {
    async createSession() {
      return createSession();
    },
    async attachTab() {},
    subscribe(sessionId: string, callback: (command: unknown) => Promise<void> | void) {
      commandHandlers.set(sessionId, callback);
      return () => {
        commandHandlers.delete(sessionId);
      };
    },
    async listSessions() {
      return listSessions();
    },
    async postEvent(commandId: string, eventType: string, detail: unknown) {
      events.push({ commandId, eventType, detail });
    },
    async postResult(event: unknown) {
      posts.push(event);
      const commandId = (event as { commandId?: string })?.commandId;
      if (typeof commandId === "string") {
        const waiter = commandWaiters.get(commandId);
        if (waiter) {
          waiter.resolve(event);
          commandWaiters.delete(commandId);
          return;
        }
        commandResults.set(commandId, event);
      }
    },
    async stopSession(sessionId: string) {
      stopCalls.push(sessionId);
    },
    async stopAll() {
      stopAllCalls.push("stopAll");
    },
    ...transportOverrides,
  } as any;

  const tabs = {
    async createOwnedTab() {
      return { tabId: 101, groupId: 201 };
    },
    async removeTab() {},
    async finalizeTab() {},
    async getTab(tabId: number) {
      return { id: tabId, url: "https://example.com/page" };
    },
    async focusTab() {},
    ...tabsOverrides,
  } as any;

  const runtime = createBridgeRuntime({
    transport,
    evaluateFloor,
    tabs,
    notify,
    driverFactory: () => {
      const driverDefaults: any = {
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
          return { resolved: { origin: "https://example.com" }, signals: {} };
        },
        async executeAction() {
          return { status: "verified", verified: true, changed: {} };
        },
      };
      const driver = driverFactory
        ? driverFactory()
        : ({ ...driverDefaults, ...driverOverrides });
      drivers.push(driver);
      return driver;
    },
  });

  function getCommandHandler(sessionIdParam: string) {
    return commandHandlers.get(sessionIdParam) ?? null;
  }

  function awaitCommandResult(commandId: string) {
    const existingResult = commandResults.get(commandId);
    if (existingResult !== undefined) {
      commandResults.delete(commandId);
      return Promise.resolve(existingResult);
    }
    const existing = commandWaiters.get(commandId);
    if (existing) return existing.promise;
    const next = deferredPromise<unknown>();
    commandWaiters.set(commandId, next);
    return next.promise;
  }

  return {
    runtime,
    getCommandHandler,
    awaitCommandResult,
    transport: {
      posts,
      events,
      stopCalls,
      stopAllCalls,
      createOwnedTab: tabs.createOwnedTab,
      removeTab: tabs.removeTab,
      finalizeTab: tabs.finalizeTab,
      getTab: tabs.getTab,
    },
    tabs,
    drivers,
  };
}

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
    async executeAction(action: { kind?: string; target?: { ref?: string }; value?: string }) {
      if (action.kind === "fill") {
        assert.equal(action.target?.ref, "ref_otp");
        assert.equal(action.value, "123456");
        return { status: "verified", verified: true, changed: { filled: true } };
      }
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
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" };
    },
    tabs,
    driverFactory: () => driver,
  });

  const sessionId = await runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  assert.equal(sessionId, "s1");
  assert.equal(runtime.snapshot().count, 1);
  assert.ok(commandHandler);
  const nextCommand = createCommandSequencer();

  await commandHandler?.(nextCommand({
    commandId: "c1",
    sessionId: "s1",
    actionKind: "click",
    action: { kind: "click", target: { ref: "e1" } },
  }));

  await commandHandler?.(nextCommand({
    commandId: "c2",
    sessionId: "s1",
    actionKind: "__trusted_fill",
    action: { kind: "__trusted_fill", target: { ref: "ref_otp" }, value: "123456" },
  }));

  assert.deepEqual(events.map((event) => event.eventType), ["running", "running"]);
  assert.deepEqual(results, [{
    commandId: "c1",
    sessionEpoch: 1,
    sequence: 1,
    ok: true,
    outcome: "completed",
    retrySafe: false,
    decision: {
      blocked: false,
      approvalRequired: false,
      reasons: [],
      class: "agentic",
      permissionRequired: "newton_browser.act",
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
  }, {
    commandId: "c2",
    sessionEpoch: 1,
    sequence: 2,
    ok: true,
    result: { filled: true },
    outcome: "completed",
    retrySafe: false,
  }]);
  assert.doesNotMatch(JSON.stringify(results), /123456/u);
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
        permissionRequired: "newton_browser.act",
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
  const nextCommand = createCommandSequencer();
  await commandHandler?.(nextCommand({
    commandId: "c1",
    sessionId: "s1",
    actionKind: "click",
    action: { kind: "click", name: "Publish" },
  }));

  assert.deepEqual(results, [{
    commandId: "c1",
    sessionEpoch: 1,
    sequence: 1,
    ok: true,
    result: { kind: "ack", message: "verified" },
    outcome: "completed",
    retrySafe: false,
    decision: {
      blocked: false,
      approvalRequired: true,
      reasons: ["structural_commit"],
      class: "approval_required",
      permissionRequired: "newton_browser.act",
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
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" };
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
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" };
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

test("BridgeRuntime accepts the granted pending URL while an owned tab is loading", async () => {
  let attachCalls = 0;
  let stopCalls = 0;
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach() { this.attached = true; },
    async detach() { this.attached = false; },
    isAttachedTo() { return this.attached; },
    async reassertOverlay() {},
    markDetached() { this.attached = false; },
  };
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "unused" }; },
      async attachTab() { attachCalls += 1; },
      subscribe() { return () => {}; },
      async listSessions() {
        return [{
          sessionId: "pending-navigation",
          origin: "https://example.com/path",
          allowedOrigins: ["https://example.com"],
          tabMode: "owned_group",
        }];
      },
      async postEvent() {},
      async postResult() {},
      async stopSession() { stopCalls += 1; },
      async stopAll() {},
    },
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" };
    },
    tabs: {
      async createOwnedTab() { return { tabId: 101, groupId: 201 }; },
      async removeTab() {},
      async getTab() { return { id: 101, url: "about:blank", pendingUrl: "https://example.com/path" }; },
    },
    driverFactory: () => driver,
  });

  await runtime.ensureForActiveSessions();

  assert.equal(attachCalls, 2, "pending and attached states are both reported");
  assert.equal(stopCalls, 0, "the granted pending navigation is not rejected");
  assert.equal(runtime.snapshot().sessions[0]?.tabId, 101);
});

test("BridgeRuntime reuses a persisted owned tab after an extension worker restart", async () => {
  let createOwnedTabCalls = 0;
  const attached: any[] = [];
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach(tabId: number) { this.attached = true; attached.push(tabId); },
    async detach() { this.attached = false; },
    isAttachedTo(tabId: number) { return this.attached && tabId === 707; },
    async reassertOverlay() {},
    markDetached() { this.attached = false; },
  };
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "unused" }; },
      async attachTab() {},
      subscribe() { return () => {}; },
      async listSessions() {
        return [{ sessionId: "restored-session", origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" }];
      },
      async postEvent() {},
      async postResult() {},
      async stopSession() {},
      async stopAll() {},
    },
    evaluateFloor() {
      return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" };
    },
    tabs: {
      async createOwnedTab() { createOwnedTabCalls += 1; return { tabId: 999, groupId: 998 }; },
      async removeTab() {},
      async getTab(tabId: number) { return tabId === 707 ? { id: 707, url: "https://example.com/page" } : null; },
    },
    driverFactory: () => driver,
  });

  await runtime.ensureForActiveSessions(undefined, [{ sessionId: "restored-session", tabId: 707, tabGroupId: 808 }]);

  assert.equal(createOwnedTabCalls, 0, "restart must not create a duplicate owned tab");
  assert.deepEqual(attached, [707]);
  assert.equal(runtime.snapshot().sessions[0]?.tabId, 707);
  assert.equal(runtime.snapshot().sessions[0]?.tabGroupId, 808);
  assert.equal(runtime.snapshot().sessions[0]?.ownsTab, true);
});

test("BridgeRuntime rejects and closes an owned session after a redirect escapes its origin grant", async () => {
  const results: any[] = [];
  const removed: number[] = [];
  const stopped: string[] = [];
  let currentUrl = "https://example.com/start";
  let handler: ((command: any) => Promise<void> | void) | null = null;
  const driver = {
    attached: false,
    ownsTab: false,
    accent: null,
    async attach() { this.attached = true; },
    async detach() { this.attached = false; },
    isAttachedTo() { return this.attached; },
    async reassertOverlay() {},
    markDetached() { this.attached = false; },
    async resolveEvidence() { return { resolved: { origin: "https://example.com" }, signals: {} }; },
    async executeAction() {
      currentUrl = "https://outside.example/escaped";
      return { status: "verified", verified: true, changed: { navigated: true } };
    },
  };
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "redirect-escape" }; },
      async attachTab() {},
      subscribe(_sessionId: string, callback: (command: any) => Promise<void> | void) { handler = callback; return () => { handler = null; }; },
      async listSessions() { return []; },
      async postEvent() {},
      async postResult(result: any) { results.push(result); },
      async stopSession(sessionId: string) { stopped.push(sessionId); },
      async stopAll() {},
    },
    evaluateFloor() { return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" }; },
    tabs: {
      async createOwnedTab() { return { tabId: 101, groupId: 201 }; },
      async removeTab(tabId: number) { removed.push(tabId); },
      async getTab() { return { id: 101, url: currentUrl }; },
      async finalizeTab() {},
    },
    driverFactory: () => driver,
  });

  await runtime.startSession({ origin: currentUrl, allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const nextCommand = createCommandSequencer();
  await handler?.(nextCommand({
    commandId: "redirect-command",
    sessionId: "redirect-escape",
    actionKind: "navigate",
    action: { kind: "navigate", url: "https://example.com/redirect" },
  }));

  assert.deepEqual(results, [{
    commandId: "redirect-command",
    sessionEpoch: 1,
    sequence: 1,
    ok: false,
    errorCode: "origin_not_granted",
    outcome: "completed",
    retrySafe: false,
  }]);
  assert.deepEqual(removed, [101]);
  assert.deepEqual(stopped, ["redirect-escape"]);
  assert.equal(runtime.snapshot().count, 0);
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
      return { blocked: false, approvalRequired: false, reasons: [], class: "read_only", permissionRequired: "newton_browser.observe", commitBoundary: "none" };
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

test("BridgeRuntime finalizes owned and current tabs with explicit close, deliverable, and handoff semantics", async () => {
  for (const scenario of [
    { mode: "owned_group", disposition: "close", removed: true, kept: false, finalized: false },
    { mode: "owned_group", disposition: "deliverable", removed: false, kept: true, finalized: true },
    { mode: "owned_group", disposition: "handoff", removed: false, kept: true, finalized: true },
    { mode: "current", disposition: "close", removed: false, kept: true, finalized: true },
  ] as const) {
    const removed: number[] = [];
    const finalized: Array<{ tabId: number; disposition: string }> = [];
    const results: any[] = [];
    const stopped: string[] = [];
    let handler: ((command: any) => Promise<void> | void) | null = null;
    const tabId = scenario.mode === "current" ? 202 : 101;
    const runtime = createBridgeRuntime({
      transport: {
        async createSession() { return { sessionId: "s-finalize" }; },
        async attachTab() {},
        subscribe(_sessionId: string, callback: (command: any) => Promise<void> | void) { handler = callback; return () => { handler = null; }; },
        async listSessions() { return []; },
        async postEvent() {},
        async postResult(result: any) { results.push(result); },
        async stopSession(sessionId: string) { stopped.push(sessionId); },
        async stopAll() {},
      },
      evaluateFloor() { return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" }; },
      tabs: {
        async createOwnedTab() { return { tabId, groupId: 301 }; },
        async removeTab(id: number) { removed.push(id); },
        async getTab() { return { id: tabId, url: "https://example.com/page" }; },
        async finalizeTab(id: number, disposition: string) { finalized.push({ tabId: id, disposition }); },
      },
      driverFactory: () => ({
        attached: false, ownsTab: false, accent: null,
        async attach() { this.attached = true; },
        async detach() { this.attached = false; },
        isAttachedTo() { return this.attached; },
        async reassertOverlay() {},
        markDetached() { this.attached = false; },
      }),
    });

    await runtime.startSession({ tabId, origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: scenario.mode });
    const nextCommand = createCommandSequencer();
    await handler?.(nextCommand({
      commandId: `c-${scenario.disposition}`,
      sessionId: "s-finalize",
      actionKind: "__finalize",
      action: { kind: "__finalize", disposition: scenario.disposition },
    }));
    assert.equal(runtime.snapshot().count, 0);
    assert.deepEqual(removed, scenario.removed ? [tabId] : []);
    assert.deepEqual(finalized, scenario.finalized ? [{ tabId, disposition: scenario.disposition }] : []);
    assert.deepEqual(stopped, ["s-finalize"]);
    assert.equal(results[0].result.tabKept, scenario.kept);
    assert.equal(results[0].sessionEpoch, 1);
    assert.equal(results[0].sequence, 1);
  }
});

test("BridgeRuntime focuses an exact session tab without detaching or finalizing it", async () => {
  const focused: number[] = [];
  const results: any[] = [];
  let handler: ((command: any) => Promise<void> | void) | null = null;
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "s-focus" }; }, async attachTab() {},
      subscribe(_sessionId: string, callback: (command: any) => Promise<void> | void) { handler = callback; return () => {}; },
      async listSessions() { return []; }, async postEvent() {}, async postResult(result: any) { results.push(result); },
      async stopSession() {}, async stopAll() {},
    },
    evaluateFloor() { return null; },
    tabs: {
      async createOwnedTab() { return { tabId: 41, groupId: 7 }; }, async removeTab() {},
      async getTab() { return { id: 41, url: "https://example.com" }; }, async focusTab(tabId: number) { focused.push(tabId); },
    },
    driverFactory: () => ({ attached: false, async attach() { this.attached = true; }, async detach() {}, isAttachedTo() { return true; }, async reassertOverlay() {} }),
  });
  await runtime.startSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const nextCommand = createCommandSequencer();
  await handler?.(nextCommand({
    commandId: "focus-1",
    sessionId: "s-focus",
    actionKind: "__focus",
    action: { kind: "__focus" },
  }));
  assert.deepEqual(focused, [41]);
  assert.equal(results[0].result.focused, true);
  assert.equal(runtime.snapshot().count, 1);
});

test("BridgeRuntime host reconciliation closes only sessions missing from the aggregate live set", async () => {
  let liveSessions = [
    { sessionId: "host-one-session", origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group", ownedTabId: 101, hostInstanceId: "host-one" },
    { sessionId: "host-two-session", origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group", ownedTabId: 102, hostInstanceId: "host-two" },
  ];
  const removed: number[] = [];
  const stopped: string[] = [];
  const runtime = createBridgeRuntime({
    transport: {
      async createSession() { return { sessionId: "unused" }; },
      async attachTab() {},
      subscribe() { return () => {}; },
      async listSessions() { return liveSessions; },
      async postEvent() {},
      async postResult() {},
      async stopSession(sessionId: string) { stopped.push(sessionId); },
      async stopAll() {},
    },
    evaluateFloor() { return { blocked: false, approvalRequired: false, reasons: [], class: "agentic", permissionRequired: "newton_browser.act", commitBoundary: "none" }; },
    tabs: {
      async createOwnedTab() { throw new Error("existing owned tabs must be reused"); },
      async removeTab(tabId: number) { removed.push(tabId); },
      async getTab(tabId: number) { return { id: tabId, url: "https://example.com/page" }; },
    },
    driverFactory: () => ({
      attached: false, ownsTab: false, accent: null,
      async attach() { this.attached = true; },
      async detach() { this.attached = false; },
      isAttachedTo() { return this.attached; },
      async reassertOverlay() {},
      markDetached() { this.attached = false; },
    }),
  });

  await runtime.ensureForActiveSessions();
  assert.equal(runtime.snapshot().count, 2);
  liveSessions = [liveSessions[1]!];
  await runtime.renewLeases();
  assert.equal(runtime.snapshot().count, 1);
  assert.equal(runtime.snapshot().sessions[0].sessionId, "host-two-session");
  assert.deepEqual(removed, [101]);
  assert.deepEqual(stopped, ["host-one-session"]);
});


test("BridgeRuntime executes same-session mutations sequentially with FIFO order", async () => {
  const executionOrder: string[] = [];
  const runningStarted = deferredPromise<void>();
  const runningRelease = deferredPromise<void>();
  const nextCommand = createCommandSequencer();

  const harness = createControllerHarness({
    sessionId: "s-serial",
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com", accessibleName: "serial" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        executionOrder.push(action?.kind ?? "missing");
        if (action.kind === "first") {
          runningStarted.resolve();
          await runningRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const commandHandler = harness.getCommandHandler("s-serial");
  assert.ok(commandHandler);

  void commandHandler?.(
    nextCommand({
    commandId: "c1",
    sessionId: "s-serial",
    actionKind: "click",
    action: { kind: "first" },
  }),
  );
  void commandHandler?.(
    nextCommand({
    commandId: "c2",
    sessionId: "s-serial",
    actionKind: "click",
    action: { kind: "second" },
  }),
  );

  await runningStarted.promise;
  assert.deepEqual(executionOrder, ["first"]);

  runningRelease.resolve();
  const [firstResult, secondResult] = await Promise.all([
    harness.awaitCommandResult("c1") as Promise<any>,
    harness.awaitCommandResult("c2") as Promise<any>,
  ]);
  assert.deepEqual(executionOrder, ["first", "second"]);
  assert.deepEqual([firstResult.commandId, secondResult.commandId], ["c1", "c2"]);
});

test("BridgeRuntime allows concurrent work across different sessions", async () => {
  const executionOrder: string[] = [];
  const startMap = new Map<string, deferredPromise<void>>();
  const releaseMap = new Map<string, deferredPromise<void>>();
  const sessionOrder = ["session-one", "session-two"];
  const sessionStarted = new Map<string, Promise<void>>();
  let sessionIndex = 0;
  let createSessionCount = 0;
  let ownedTabId = 100;

  const harness = createControllerHarness({
    createSession: async () => {
      const sessionId = sessionOrder[createSessionCount] ?? `session-${createSessionCount + 1}`;
      createSessionCount += 1;
      return { sessionId };
    },
    tabsOverrides: {
      async createOwnedTab() {
        ownedTabId += 1;
        return { tabId: ownedTabId, groupId: 201 };
      },
      async getTab(tabId: number) {
        return { id: tabId, url: "https://example.com/page" };
      },
    },
    driverFactory: () => {
      const label = sessionOrder[sessionIndex] ?? `session-${sessionIndex + 1}`;
      sessionIndex += 1;
      startMap.set(label, deferredPromise<void>());
      releaseMap.set(label, deferredPromise<void>());
      sessionStarted.set(label, startMap.get(label)!.promise);
      return {
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
          return { resolved: { origin: "https://example.com", accessibleName: label }, signals: {} };
        },
        async executeAction(action: { kind?: string }) {
          executionOrder.push(`${label}:${action?.kind ?? "missing"}`);
          startMap.get(label)?.resolve();
          await releaseMap.get(label)?.promise;
          return { status: "verified", changed: { kind: action?.kind } };
        },
      } as any;
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });

  const firstHandler = harness.getCommandHandler("session-one");
  const secondHandler = harness.getCommandHandler("session-two");
  assert.ok(firstHandler);
  assert.ok(secondHandler);
  const nextCommand = createCommandSequencer();

  void firstHandler(
    nextCommand({
    commandId: "session-one-first",
    sessionId: "session-one",
    actionKind: "click",
    action: { kind: "first" },
  }),
  );
  void secondHandler(
    nextCommand({
    commandId: "session-two-second",
    sessionId: "session-two",
    actionKind: "click",
    action: { kind: "second" },
  }),
  );

  await Promise.all([sessionStarted.get("session-one")!, sessionStarted.get("session-two")!]);
  releaseMap.get("session-one")?.resolve();
  releaseMap.get("session-two")?.resolve();

  const [firstResult, secondResult] = await Promise.all([
    harness.awaitCommandResult("session-one-first") as Promise<any>,
    harness.awaitCommandResult("session-two-second") as Promise<any>,
  ]);

  assert.equal(firstResult.commandId, "session-one-first");
  assert.equal(secondResult.commandId, "session-two-second");
  assert.equal(executionOrder.length, 2);
  assert.equal(harness.runtime.snapshot().count, 2);
  assert.ok(executionOrder.includes("session-one:first"));
  assert.ok(executionOrder.includes("session-two:second"));
});

test("BridgeRuntime validates duplicate/lower sequence numbers without advancing state", async () => {
  const sessionId = "s-seq-dup";
  const harness = createControllerHarness({ sessionId });
  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "first",
      sessionId,
      actionKind: "click",
      action: { kind: "first" },
    }),
  );

  const first = await harness.awaitCommandResult("first") as {
    commandId: string;
    ok: boolean;
    sessionEpoch: number;
    sequence: number;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(first.commandId, "first");
  assert.equal(first.sessionEpoch, 1);
  assert.equal(first.sequence, 1);
  assert.equal(first.ok, true);
  assert.equal(first.outcome, "completed");
  assert.equal(first.retrySafe, false);

  void handler(
    nextCommand({
      commandId: "duplicate",
      sessionId,
      actionKind: "click",
      action: { kind: "duplicate" },
      sequence: 1,
    }),
  );
  const duplicate = await harness.awaitCommandResult("duplicate") as {
    commandId: string;
    ok: boolean;
    sessionEpoch: number;
    sequence: number;
    errorCode: string;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(duplicate.commandId, "duplicate");
  assert.equal(duplicate.sessionEpoch, 1);
  assert.equal(duplicate.sequence, 1);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.errorCode, "invalid_command_sequence");
  assert.equal(duplicate.outcome, "prevented");
  assert.equal(duplicate.retrySafe, true);

  void handler(
    nextCommand({
      commandId: "resume",
      sessionId,
      actionKind: "click",
      action: { kind: "resume" },
      sequence: 2,
    }),
  );
  const resume = await harness.awaitCommandResult("resume") as {
    commandId: string;
    ok: boolean;
    sessionEpoch: number;
    sequence: number;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(resume.commandId, "resume");
  assert.equal(resume.sessionEpoch, 1);
  assert.equal(resume.sequence, 2);
  assert.equal(resume.ok, true);
  assert.equal(resume.outcome, "completed");
  assert.equal(resume.retrySafe, false);
});

test("BridgeRuntime accepts higher epoch only at sequence 1 and rejects protocol gaps", async () => {
  const sessionId = "s-seq-epoch";
  const harness = createControllerHarness({ sessionId });
  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);

  const nextCommand = createCommandSequencer();
  const first = nextCommand({
    commandId: "first",
    sessionId,
    actionKind: "click",
    action: { kind: "first" },
  });
  void handler(first);
  const firstResult = await harness.awaitCommandResult("first") as {
    sessionEpoch: number;
    sequence: number;
  };
  assert.equal(firstResult.sessionEpoch, 1);
  assert.equal(firstResult.sequence, 1);

  const gapHandled = handler({
    commandId: "gap",
    sessionId,
    actionKind: "click",
    action: { kind: "gap" },
    sessionEpoch: 1,
    sequence: 5,
  });
  const gap = await harness.awaitCommandResult("gap") as {
    sessionEpoch: number;
    sequence: number;
    errorCode: string;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(gap.sessionEpoch, 1);
  assert.equal(gap.sequence, 5);
  assert.equal(gap.errorCode, "invalid_command_sequence");
  assert.equal(gap.outcome, "prevented");
  assert.equal(gap.retrySafe, true);
  await gapHandled;

  assert.equal(harness.runtime.snapshot().count, 0);
});

test("BridgeRuntime accepts higher epoch only at sequence 1", async () => {
  const sessionId = "s-seq-higher";
  const harness = createControllerHarness({ sessionId });
  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "first",
      sessionId,
      actionKind: "click",
      action: { kind: "first" },
    }),
  );
  await harness.awaitCommandResult("first");

  void handler({
    commandId: "bad-higher-epoch",
    sessionId,
    actionKind: "click",
    action: { kind: "bad-higher-epoch" },
    sessionEpoch: 2,
    sequence: 2,
  });
  const badHigher = await harness.awaitCommandResult("bad-higher-epoch") as {
    sessionEpoch: number;
    sequence: number;
    errorCode: string;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(badHigher.sessionEpoch, 2);
  assert.equal(badHigher.sequence, 2);
  assert.equal(badHigher.errorCode, "invalid_command_sequence");
  assert.equal(badHigher.outcome, "prevented");
  assert.equal(badHigher.retrySafe, true);

  void handler({
    commandId: "fresh-epoch",
    sessionId,
    actionKind: "click",
    action: { kind: "fresh-epoch" },
    sessionEpoch: 3,
    sequence: 1,
  });
  const freshEpoch = await harness.awaitCommandResult("fresh-epoch") as {
    sessionEpoch: number;
    sequence: number;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(freshEpoch.sessionEpoch, 3);
  assert.equal(freshEpoch.sequence, 1);
  assert.equal(freshEpoch.outcome, "completed");
  assert.equal(freshEpoch.retrySafe, false);

  void handler({
    commandId: "resume-epoch",
    sessionId,
    actionKind: "click",
    action: { kind: "resume-epoch" },
    sessionEpoch: 3,
    sequence: 2,
  });
  const resumeEpoch = await harness.awaitCommandResult("resume-epoch") as {
    sessionEpoch: number;
    sequence: number;
    outcome: string;
    retrySafe: boolean;
  };
  assert.equal(resumeEpoch.sessionEpoch, 3);
  assert.equal(resumeEpoch.sequence, 2);
  assert.equal(resumeEpoch.outcome, "completed");
  assert.equal(resumeEpoch.retrySafe, false);
});

test("BridgeRuntime continues queued work when a command fails in the same session", async () => {
  const executionOrder: string[] = [];
  const nextCommand = createCommandSequencer();
  const harness = createControllerHarness({
    sessionId: "s-fail",
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        executionOrder.push(action?.kind ?? "missing");
        if (action.kind === "first") {
          throw new Error("boom");
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler("s-fail");
  assert.ok(handler);

  void handler(
    nextCommand({
      commandId: "c1",
      sessionId: "s-fail",
      actionKind: "click",
      action: { kind: "first" },
    }),
  );
  void handler(
    nextCommand({
      commandId: "c2",
      sessionId: "s-fail",
      actionKind: "click",
      action: { kind: "second" },
    }),
  );

  const [firstResult, secondResult] = await Promise.all([
    harness.awaitCommandResult("c1") as Promise<any>,
    harness.awaitCommandResult("c2") as Promise<any>,
  ]);

  assert.equal(firstResult.commandId, "c1");
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.outcome, "completed");
  assert.equal(firstResult.retrySafe, false);
  assert.equal(secondResult.commandId, "c2");
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.outcome, "completed");
  assert.equal(secondResult.retrySafe, false);
  assert.deepEqual(executionOrder, ["first", "second"]);
});

test("BridgeRuntime enforces per-session item caps including running command", async () => {
  const sessionId = "s-items";
  const runningStarted = deferredPromise<void>();
  const runningRelease = deferredPromise<void>();
  const executed: string[] = [];
  const nextCommand = createCommandSequencer();

  const harness = createControllerHarness({
    sessionId,
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        executed.push(action?.kind ?? "missing");
        if (action.kind === "running") {
          runningStarted.resolve();
          await runningRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);

  const maxItems = harness.runtime.snapshot().sessions[0].commandPump.maxItems;
  assert.equal(maxItems, 32);

  const resultPromises: Promise<unknown>[] = [harness.awaitCommandResult("running")];

  void handler(
    nextCommand({
      commandId: "running",
      sessionId,
      actionKind: "click",
      action: { kind: "running" },
    }),
  );

  await runningStarted.promise;

  for (let index = 1; index < maxItems; index += 1) {
    const commandId = `queued-${index}`;
    resultPromises.push(harness.awaitCommandResult(commandId));
    void handler(
      nextCommand({
      commandId,
      sessionId,
      actionKind: "click",
      action: { kind: `queued-${index}` },
      }),
    );
  }

  const overflowPromise = harness.awaitCommandResult("overflow");
  void handler(
    nextCommand({
      commandId: "overflow",
      sessionId,
      actionKind: "click",
      action: { kind: "overflow" },
    }),
  );

  const overflowResult = await overflowPromise as { errorCode: string };
  assert.equal(overflowResult.errorCode, "session_queue_full");

  runningRelease.resolve();
  await Promise.all(resultPromises);
  assert.equal(executed.length, maxItems);
  assert.equal(harness.runtime.snapshot().sessions[0].commandPump.queueLength, 0);
});

test("BridgeRuntime enforces byte caps and accepts exact boundary work", async () => {
  const sessionId = "s-bytes";
  const firstStarted = deferredPromise<void>();
  const firstRelease = deferredPromise<void>();
  const executed: string[] = [];
  const nextCommand = createCommandSequencer();

  const harness = createControllerHarness({
    sessionId,
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        executed.push(action?.kind ?? "missing");
        if (action.kind === "running") {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  const firstCommand = nextCommand({ commandId: "running", sessionId, actionKind: "click", action: { kind: "running", payload: "" } });
  const firstBytes = commandByteCount(firstCommand);

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);

  const maxBytes = harness.runtime.snapshot().sessions[0].commandPump.maxBytes;
  const atBoundary = maxBytes - firstBytes;
  const atBoundaryCommand = makeCommandForByteSize(
    nextCommand({ commandId: "at-boundary", sessionId, actionKind: "click", action: { kind: "click", payload: "" } }),
    atBoundary,
  );
  const overBoundaryCommand = makeCommandForByteSize(
    nextCommand({ commandId: "over-boundary", sessionId, actionKind: "click", action: { kind: "click", payload: "" } }),
    atBoundary + 1,
  );

  const overflowPromise = harness.awaitCommandResult("over-boundary");

  void handler(firstCommand);
  await firstStarted.promise;

  const atBoundaryResult = harness.awaitCommandResult("at-boundary");
  void handler(atBoundaryCommand);
  void handler(overBoundaryCommand);

  const overflowResult = await overflowPromise as { errorCode: string };
  assert.equal(overflowResult.errorCode, "session_queue_full");

  firstRelease.resolve();
  const [runningResult, boundaryResult] = await Promise.all([
    harness.awaitCommandResult("running") as Promise<any>,
    atBoundaryResult as Promise<any>,
  ]);

  assert.equal(runningResult.commandId, "running");
  assert.equal((boundaryResult as { commandId: string }).commandId, "at-boundary");
  assert.equal(runningResult.ok, true);
  assert.equal((boundaryResult as { ok: boolean }).ok, true);
  assert.equal(executed.length, 2);
});

test("BridgeRuntime closes queued work when finalize command starts", async () => {
  const sessionId = "s-finalize-race";
  const firstStarted = deferredPromise<void>();
  const firstRelease = deferredPromise<void>();

  const harness = createControllerHarness({
    sessionId,
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        if (action.kind === "first") {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({ commandId: "first", sessionId, actionKind: "click", action: { kind: "first" } }),
  );
  void handler(
    nextCommand({ commandId: "finalize", sessionId, actionKind: "__finalize", action: { kind: "__finalize", disposition: "close" } }),
  );
  void handler(
    nextCommand({ commandId: "queued", sessionId, actionKind: "click", action: { kind: "queued" } }),
  );

  await firstStarted.promise;
  firstRelease.resolve();

  const [firstResult, finalizeResult, queuedResult] = await Promise.all([
    harness.awaitCommandResult("first") as Promise<any>,
    harness.awaitCommandResult("finalize") as Promise<any>,
    harness.awaitCommandResult("queued") as Promise<any>,
  ]);

  assert.equal(firstResult.commandId, "first");
  assert.equal(finalizeResult.commandId, "finalize");
  assert.equal(finalizeResult.ok, true);
  assert.equal(queuedResult.commandId, "queued");
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.errorCode, "session_finalizing");
  assert.equal(harness.runtime.snapshot().count, 0);
});

test("BridgeRuntime posts finalize result after local cleanup and before host stop", async () => {
  const sessionId = "s-finalize-order";
  const order: string[] = [];
  const resultPosted = deferredPromise<any>();
  const stopCompleted = deferredPromise<void>();
  const notifications: string[] = [];

  const harness = createControllerHarness({
    sessionId,
    transportOverrides: {
      async postResult(event: unknown) {
        order.push("postResult");
        resultPosted.resolve(event);
      },
      async stopSession() {
        order.push("stopSession");
        stopCompleted.resolve();
      },
    },
    tabsOverrides: {
      async removeTab(tabId: number) {
        order.push(`removeTab:${tabId}`);
      },
    },
    driverOverrides: {
      ownsTab: true,
      async detach() {
        order.push("detach");
      },
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction() {
        return { status: "verified", changed: {} };
      },
    },
    notify: (event: { type?: string }) => {
      const eventType = event?.type ?? "unknown";
      notifications.push(eventType);
      order.push(eventType);
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  notifications.length = 0;
  order.length = 0;
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "finalize",
      sessionId,
      actionKind: "__finalize",
      action: { kind: "__finalize", disposition: "close" },
    }),
  );

  const result = await resultPosted.promise;
  await stopCompleted.promise;

  assert.equal(result.commandId, "finalize");
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["detach", "removeTab:101", "finalized", "state", "postResult", "stopSession"]);
  assert.notEqual(order.indexOf("detach"), -1);
  assert.ok(order.indexOf("removeTab:101") > order.indexOf("detach"));
  assert.ok(order.indexOf("postResult") > order.indexOf("removeTab:101"));
  assert.ok(order.indexOf("stopSession") > order.indexOf("postResult"));
  assert.equal(order.filter((item) => item === "postResult").length, 1);
  assert.deepEqual(notifications, ["finalized", "state"]);
});

test("BridgeRuntime contains synchronous host-stop failures after a terminal finalize result", async () => {
  const sessionId = "s-finalize-sync-stop-failure";
  const harness = createControllerHarness({
    sessionId,
    transportOverrides: {
      stopSession() {
        throw new Error("sync transport failure");
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  const handled = handler({
    commandId: "finalize-sync-stop",
    sessionId,
    actionKind: "__finalize",
    action: { kind: "__finalize", disposition: "close" },
    sessionEpoch: 1,
    sequence: 1,
  });

  const result = await harness.awaitCommandResult("finalize-sync-stop") as any;
  await handled;
  assert.equal(result.outcome, "completed");
  assert.equal(result.ok, true);
  assert.equal(harness.runtime.snapshot().count, 0);
});

test("BridgeRuntime does not restart a closing controller while awaiting external stop", async () => {
  const runningStarted = deferredPromise<void>();
  const runningRelease = deferredPromise<void>();

  const harness = createControllerHarness({
    sessionId: "s-closing",
    transportOverrides: {
      async listSessions() {
        return [{ sessionId: "s-closing", origin: "https://example.com", tabMode: "owned_group" }];
      },
    },
    tabsOverrides: {
      async createOwnedTab() {
        return { tabId: 201, groupId: 202 };
      },
    },
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        if (action.kind === "first") {
          runningStarted.resolve();
          await runningRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler("s-closing");
  assert.ok(handler);
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "long",
      sessionId: "s-closing",
      actionKind: "click",
      action: { kind: "first" },
    }),
  );
  await runningStarted.promise;

  const stopResult = harness.runtime.stop("s-closing");

  await harness.runtime.ensureForActiveSessions();
  assert.equal(harness.runtime.snapshot().sessions[0]?.streaming, false);
  runningRelease.resolve();

  await stopResult;
  assert.equal(harness.runtime.snapshot().count, 0);
  assert.equal(harness.runtime.snapshot().sessions.length, 0);
});

test("BridgeRuntime continues origin-escape cleanup when origin postResult fails", async () => {
  const sessionId = "s-escape-postresult-fail";
  const actionStarted = deferredPromise<void>();
  const actionRelease = deferredPromise<void>();
  const postResult = deferredPromise<any>();
  const stopCompleted = deferredPromise<void>();
  const order: string[] = [];
  let currentUrl = "https://example.com/page";

  const harness = createControllerHarness({
    sessionId,
    notify: (event: { type?: string }) => {
      order.push(event?.type ?? "unknown");
    },
    tabsOverrides: {
      async getTab(tabId: number) {
        return { id: tabId, url: currentUrl };
      },
      async removeTab(tabId: number) {
        order.push(`removeTab:${tabId}`);
      },
    },
    driverOverrides: {
      ownsTab: true,
      async detach() {
        order.push("detach");
      },
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        if (action.kind === "escape") {
          actionStarted.resolve();
          await actionRelease.promise;
          currentUrl = "https://outside.example.com";
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
    transportOverrides: {
      async postResult(event: any) {
        if (event?.commandId === "escape") {
          order.push("postResult");
          postResult.resolve(event);
          return Promise.reject(new Error("post-result-rejected"));
        }
      },
      async stopSession() {
        order.push("stopSession");
        stopCompleted.resolve();
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  order.length = 0;
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "escape",
      sessionId,
      actionKind: "click",
      action: { kind: "escape" },
    }),
  );

  await actionStarted.promise;
  actionRelease.resolve();

  const result = await postResult.promise;
  await stopCompleted.promise;

  assert.equal(result.commandId, "escape");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "origin_not_granted");
  assert.equal(result.outcome, "completed");
  assert.equal(result.retrySafe, false);
  assert.equal(order.filter((item) => item === "postResult").length, 1);
  const postResultStart = order.indexOf("postResult");
  assert.equal(order[postResultStart], "postResult");
  assert.equal(order.indexOf("detach"), postResultStart + 1);
  assert.equal(order.indexOf("removeTab:101"), order.indexOf("detach") + 1);
  assert.equal(order.indexOf("finalized"), order.indexOf("removeTab:101") + 1);
  assert.equal(order.indexOf("state"), order.indexOf("finalized") + 1);
  assert.equal(order.indexOf("stopSession"), order.indexOf("state") + 1);
  assert.equal(order.lastIndexOf("postResult"), postResultStart);
});

test("BridgeRuntime external stop does not deadlock when command escapes origin", async () => {
  const sessionId = "s-stop-escape";
  const commandStarted = deferredPromise<void>();
  const commandRelease = deferredPromise<void>();
  const commandOrder: string[] = [];
  let currentUrl = "https://example.com/page";
  const stateNotifications: string[] = [];

  const harness = createControllerHarness({
    sessionId,
    notify: (event: { type?: string }) => {
      stateNotifications.push(event?.type ?? "unknown");
    },
    tabsOverrides: {
      async getTab(tabId: number) {
        return { id: tabId, url: currentUrl };
      },
    },
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        commandOrder.push(action?.kind ?? "missing");
        if (action.kind === "escape") {
          commandStarted.resolve();
          await commandRelease.promise;
          currentUrl = "https://outside.example.com";
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
  const handler = harness.getCommandHandler(sessionId);
  assert.ok(handler);
  const nextCommand = createCommandSequencer();

  void handler(
    nextCommand({
      commandId: "escape",
      sessionId,
      actionKind: "click",
      action: { kind: "escape" },
    }),
  );

  await commandStarted.promise;
  const queuedResult = harness.awaitCommandResult("queued");
  void handler(
    nextCommand({
      commandId: "queued",
      sessionId,
      actionKind: "click",
      action: { kind: "queued" },
      sequence: 2,
    }),
  );

  const stopResult = harness.runtime.stop(sessionId);
  commandRelease.resolve();

  const [result, queued, stopResponse] = await Promise.all([
    harness.awaitCommandResult("escape") as Promise<any>,
    queuedResult,
    stopResult,
  ]);
  assert.equal(result.errorCode, "origin_not_granted");
  assert.equal(result.outcome, "completed");
  assert.equal(result.retrySafe, false);
  assert.equal(queued.errorCode, "session_finalizing");
  assert.equal(stopResponse.stopped, true);
  assert.deepEqual(stateNotifications, ["state", "finalized", "state"]);
  assert.equal(harness.runtime.snapshot().count, 0);
  assert.deepEqual(commandOrder, ["escape"]);
});
test("BridgeRuntime handles queue rejection without unhandled rejections", async () => {
  const sessionId = "s-unhandled";
  const firstStarted = deferredPromise<void>();
  const firstRelease = deferredPromise<void>();
  let unhandled = false;

  const onUnhandled = () => {
    unhandled = true;
  };
  process.once("unhandledRejection", onUnhandled);

  const harness = createControllerHarness({
    sessionId,
    driverOverrides: {
      async resolveEvidence() {
        return { resolved: { origin: "https://example.com" }, signals: {} };
      },
      async executeAction(action: { kind?: string }) {
        if (action.kind === "first") {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        return { status: "verified", changed: { kind: action?.kind } };
      },
    },
  });

  try {
    await harness.runtime.startSession({ origin: "https://example.com", tabMode: "owned_group" });
    const handler = harness.getCommandHandler(sessionId);
    assert.ok(handler);
    const nextCommand = createCommandSequencer();

    void handler(
      nextCommand({
      commandId: "first",
      sessionId,
      actionKind: "click",
      action: { kind: "first" },
      }),
    );

    await firstStarted.promise;
    const maxItems = harness.runtime.snapshot().sessions[0].commandPump.maxItems;
    for (let index = 0; index < maxItems - 1; index += 1) {
      void handler(
        nextCommand({
          commandId: `queued-${index}`,
          sessionId,
          actionKind: "click",
          action: { kind: `queued-${index}` },
        }),
      );
    }

    const overflow = harness.awaitCommandResult("overflow");
    void handler(
      nextCommand({
        commandId: "overflow",
        sessionId,
        actionKind: "click",
        action: { kind: "overflow" },
      }),
    );

    const overflowResult = await overflow as { errorCode: string };
    assert.equal(overflowResult.errorCode, "session_queue_full");

    firstRelease.resolve();
    await harness.awaitCommandResult("first");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(unhandled, false);
});
