import test from "node:test";
import assert from "node:assert/strict";

import { createNewtonBrowserDriver as createDriver } from "../dist/driver.js";
import { compileOriginGrant } from "../dist/origin-containment.js";

function createNewtonBrowserDriver(options = {}) {
  const allowedOrigins = options.allowedOrigins ?? ["https://example.com"];
  const debuggerPort = options.debuggerPort ?? {
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; },
  };
  const driver = createDriver({ ...options, allowedOrigins, debuggerPort });
  driver.containment = compileOriginGrant(allowedOrigins[0], allowedOrigins.slice(1));
  return driver;
}

function primeObservationDriver(driver, origin = "https://example.com") {
  driver.mainTargetId = "main-target";
  driver.containmentReady = true;
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin });
  driver.targetRegistry.commitTopLevelDocument("main-target", origin);
}

function initialNavigationDriver(cdp) {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.attached = true;
  driver.containmentReady = true;
  driver.protocolGeneration = 1;
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page" });
  driver.browserControlSessionId = "browser-control";
  driver.cdp = cdp;
  return driver;
}

test("initial owned navigation buffers commit-before-response and requires the exact frame and loader", async () => {
  const calls = [];
  let driver;
  driver = initialNavigationDriver(async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Page.navigate") {
      await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
        frame: { id: "wrong-frame", loaderId: "loader-1", url: "https://example.com/wrong-frame" },
      });
      await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
        frame: { id: "main-frame", loaderId: "wrong-loader", url: "https://example.com/wrong-loader" },
      });
      await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
        frame: { id: "main-frame", loaderId: "loader-1", url: "https://example.com/redirected" },
      });
      return { frameId: "main-frame", loaderId: "loader-1" };
    }
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target" } };
    return {};
  });

  const commit = await driver.navigateInitialGranted("https://example.com/start");
  assert.deepEqual(commit, {
    frameId: "main-frame",
    loaderId: "loader-1",
    url: "https://example.com/redirected",
    origin: "https://example.com",
  });
  assert.equal(calls[0].method, "Page.navigate");
  assert.deepEqual(calls.at(-1), {
    method: "Target.getTargetInfo",
    params: { targetId: "main-target" },
    route: { sessionId: "browser-control" },
  });
  assert.equal(driver.initialNavigation, null);
});

test("initial owned navigation accepts response-before-commit and rejects a denied redirect observed by Fetch", async () => {
  let navigateStartedResolve;
  const navigateStarted = new Promise((resolve) => { navigateStartedResolve = resolve; });
  const driver = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      navigateStartedResolve();
      return { frameId: "main-frame", loaderId: "loader-2" };
    }
    if (method === "Fetch.failRequest" || method === "Target.getTargetInfo") return {};
    return {};
  });
  const navigation = driver.navigateInitialGranted("https://example.com/start");
  await navigateStarted;
  await driver.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "denied-redirect",
    frameId: "main-frame",
    resourceType: "Document",
    request: { url: "https://outside.test/redirect", method: "GET" },
  });
  await assert.rejects(navigation, (error) => error?.code === "ungranted_navigation");
  assert.equal(driver.initialNavigation, null);
});

test("initial owned navigation rejects invalid Page.navigate responses without leaving a waiter", async () => {
  for (const [response, code] of [
    [{ errorText: "net::ERR_FAILED", frameId: "main", loaderId: "loader" }, "initial_navigation_failed"],
    [{ isDownload: true, frameId: "main", loaderId: "loader" }, "initial_navigation_download"],
    [{ loaderId: "loader" }, "initial_navigation_uncommitted"],
    [{ frameId: "main" }, "initial_navigation_uncommitted"],
  ]) {
    const driver = initialNavigationDriver(async (method) => method === "Page.navigate" ? response : {});
    await assert.rejects(
      driver.navigateInitialGranted("https://example.com/start"),
      (error) => error?.code === code,
    );
    assert.equal(driver.initialNavigation, null);
  }
});

test("initial owned navigation rejects detach, concurrent navigation, and a failed containment fence", async () => {
  let navigateStartedResolve;
  const navigateStarted = new Promise((resolve) => { navigateStartedResolve = resolve; });
  const detached = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      navigateStartedResolve();
      return { frameId: "main", loaderId: "loader" };
    }
    return {};
  });
  const first = detached.navigateInitialGranted("https://example.com/start");
  await navigateStarted;
  await assert.rejects(
    detached.navigateInitialGranted("https://example.com/second"),
    (error) => error?.code === "initial_navigation_conflict",
  );
  detached.markDetached("target_closed");
  await assert.rejects(first, (error) => error?.code === "debugger_conflict");
  assert.equal(detached.initialNavigation, null);

  let fenceStartedResolve;
  let releaseFence;
  const fenceStarted = new Promise((resolve) => { fenceStartedResolve = resolve; });
  const fenceRelease = new Promise((resolve) => { releaseFence = resolve; });
  let inFlight;
  inFlight = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      inFlight.noteInitialNavigationEvent({}, "Page.frameNavigated", {
        frame: { id: "main", loaderId: "loader", url: "https://example.com/ready" },
      });
      return { frameId: "main", loaderId: "loader" };
    }
    if (method === "Target.getTargetInfo") {
      fenceStartedResolve();
      await fenceRelease;
      return {};
    }
    return {};
  });
  const inFlightNavigation = inFlight.navigateInitialGranted("https://example.com/start");
  await fenceStarted;
  await assert.rejects(
    inFlight.navigateInitialGranted("https://example.com/second"),
    (error) => error?.code === "initial_navigation_conflict",
  );
  releaseFence();
  await inFlightNavigation;

  let fenced;
  fenced = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      await fenced.recordDebuggerEvent({}, "Page.frameNavigated", {
        frame: { id: "main", loaderId: "loader", url: "https://example.com/ready" },
      });
      return { frameId: "main", loaderId: "loader" };
    }
    if (method === "Target.getTargetInfo") throw new Error("browser target detached");
    return {};
  });
  await assert.rejects(
    fenced.navigateInitialGranted("https://example.com/start"),
    (error) => error?.code === "containment_fence_failed",
  );
  assert.equal(fenced.containmentReady, false);
  assert.equal(fenced.initialNavigation, null);
});

test("initial owned navigation revalidates debugger identity after a successful fence", async () => {
  let fenceStartedResolve;
  let releaseFence;
  const fenceStarted = new Promise((resolve) => { fenceStartedResolve = resolve; });
  const fenceRelease = new Promise((resolve) => { releaseFence = resolve; });
  let driver;
  driver = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      driver.noteInitialNavigationEvent({}, "Page.frameNavigated", {
        frame: { id: "main", loaderId: "loader", url: "https://example.com/ready" },
      });
      return { frameId: "main", loaderId: "loader" };
    }
    if (method === "Target.getTargetInfo") {
      fenceStartedResolve();
      await fenceRelease;
    }
    return {};
  });
  const navigation = driver.navigateInitialGranted("https://example.com/start");
  await fenceStarted;
  driver.markDetached("target_closed");
  releaseFence();
  await assert.rejects(navigation, (error) => error?.code === "debugger_conflict");
});

test("initial owned navigation deadline rejects and clears the exact pending waiter", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let deadline;
  globalThis.setTimeout = (callback) => {
    deadline = callback;
    return { fakeTimer: true };
  };
  globalThis.clearTimeout = () => {};
  try {
    const driver = initialNavigationDriver(async (method) => method === "Page.navigate"
      ? { frameId: "main", loaderId: "loader" }
      : {});
    const navigation = driver.navigateInitialGranted("https://example.com/start");
    await Promise.resolve();
    assert.equal(typeof deadline, "function");
    deadline();
    await assert.rejects(navigation, (error) => error?.code === "initial_navigation_uncommitted");
    assert.equal(driver.initialNavigation, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("initial owned navigation fails closed when buffered commit evidence exceeds its cap", async () => {
  let driver;
  driver = initialNavigationDriver(async (method) => {
    if (method === "Page.navigate") {
      for (let index = 0; index < 33; index += 1) {
        driver.noteInitialNavigationEvent({}, "Page.frameNavigated", {
          frame: { id: "main", loaderId: `loader-${index}`, url: "https://example.com/redirect" },
        });
      }
      return { frameId: "main", loaderId: "loader-32" };
    }
    return {};
  });
  await assert.rejects(
    driver.navigateInitialGranted("https://example.com/start"),
    (error) => error?.code === "initial_navigation_event_overflow",
  );
  assert.equal(driver.initialNavigation, null);
});

test("injected debugger port receives attach, session-routed commands, and detach without touching Chrome globals", async () => {
  const calls = [];
  const debuggerPort = {
    async attach() { calls.push({ kind: "attach" }); },
    async detach() { calls.push({ kind: "detach" }); },
    async sendCommand(source, method, params) {
      calls.push({ kind: "command", source, method, params });
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "main-target", url: "https://example.com/" } };
      }
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
      return {};
    },
  };
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort,
  });
  await driver.attach();
  await driver.cdp("Accessibility.getFullAXTree", { depth: 2 }, { sessionId: "child-session", timeoutMs: 100 });
  await driver.detach();

  assert.deepEqual(calls[0], { kind: "attach" });
  assert.deepEqual(calls.find((call) => call.method === "Accessibility.getFullAXTree"), {
    kind: "command",
    source: { sessionId: "child-session" },
    method: "Accessibility.getFullAXTree",
    params: { depth: 2 },
  });
  assert.deepEqual(calls.at(-1), { kind: "detach" });
});

test("subscribed debugger processes an event emitted during attach and preserves exact event sources", async () => {
  let harness;
  harness = subscribedDebuggerHarness({
    async onAttach() {
      await harness.emit(
        {},
        "Runtime.consoleAPICalled",
        { type: "log", args: [{ value: "during attach" }] },
      );
    },
  });
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: harness.port,
  });
  const forwarded = [];
  const recordDebuggerEvent = driver.recordDebuggerEvent.bind(driver);
  driver.recordDebuggerEvent = (source, method, params) => {
    forwarded.push({ source, method, params });
    return recordDebuggerEvent(source, method, params);
  };

  await driver.attach();
  assert.equal(driver.consoleBuffer[0]?.text, "during attach");
  await harness.emit(
    { sessionId: "child-session" },
    "Page.frameNavigated",
    { frame: { id: "child-frame", url: "https://example.com/frame" } },
  );
  assert.deepEqual(forwarded.at(-1), {
    source: { sessionId: "child-session" },
    method: "Page.frameNavigated",
    params: { frame: { id: "child-frame", url: "https://example.com/frame" } },
  });
  driver.markDetached("transport_closed");
  assert.equal(harness.unsubscribeCount(), 1);
});

test("subscribed debugger delivery stays ordered across asynchronous event work", async () => {
  const harness = subscribedDebuggerHarness();
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: harness.port,
  });
  await driver.attach();
  const order = [];
  let firstStartedResolve;
  let releaseFirstResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const releaseFirst = new Promise((resolve) => { releaseFirstResolve = resolve; });
  driver.recordTargetEventNow = async (_source, method) => {
    order.push(`start:${method}`);
    if (method === "Test.first") {
      firstStartedResolve();
      await releaseFirst;
    }
    order.push(`end:${method}`);
  };

  const first = harness.emit({}, "Test.first", {});
  const second = harness.emit({}, "Test.second", {});
  await firstStarted;
  assert.deepEqual(order, ["start:Test.first"]);
  releaseFirstResolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "start:Test.first",
    "end:Test.first",
    "start:Test.second",
    "end:Test.second",
  ]);
  await driver.detach();
});

test("root attach failure and setup rollback release their debugger event subscriptions", async () => {
  const rootFailureHarness = subscribedDebuggerHarness({
    async onAttach() { throw new Error("attach failed"); },
  });
  const rootFailure = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: rootFailureHarness.port,
  });
  await assert.rejects(rootFailure.attach(), (error) => error?.code === "root_debugger_attach_failed");
  assert.equal(rootFailure.attached, false);
  assert.equal(rootFailure.debuggerEventUnsubscribe, null);
  assert.equal(rootFailureHarness.unsubscribeCount(), 1);
  assert.equal(rootFailureHarness.hasListener(), false);

  let failed = false;
  const harness = subscribedDebuggerHarness({
    async onCommand(_target, method) {
      if (!failed && method === "DOM.enable") {
        failed = true;
        throw new Error("setup failed");
      }
      return undefined;
    },
  });
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: harness.port,
  });
  await assert.rejects(driver.attach(), (error) => error?.code === "root_protocol_setup_failed");
  assert.equal(driver.attached, false);
  assert.equal(driver.debuggerEventUnsubscribe, null);
  assert.equal(harness.unsubscribeCount(), 1);
  assert.equal(harness.hasListener(), false);
});

test("detach failure retains the debugger subscription until one confirmed retry removes it", async () => {
  let detachAttempts = 0;
  const harness = subscribedDebuggerHarness({
    async onDetach() {
      detachAttempts += 1;
      if (detachAttempts === 1) throw new Error("detach uncertain");
    },
  });
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: harness.port,
  });
  await driver.attach();
  await assert.rejects(driver.detach(), (error) => error?.code === "shutdown_detach_failed");
  assert.equal(harness.hasListener(), true);
  assert.equal(harness.unsubscribeCount(), 0);
  await harness.emit(
    {},
    "Runtime.consoleAPICalled",
    { type: "log", args: [{ value: "still owned" }] },
  );
  assert.equal(driver.consoleBuffer.at(-1)?.text, "still owned");

  await driver.detach();
  assert.equal(detachAttempts, 2);
  assert.equal(harness.hasListener(), false);
  assert.equal(harness.unsubscribeCount(), 1);
  driver.markDetached();
  assert.equal(harness.unsubscribeCount(), 1);
});

test("driver event recorder remains usable before a private port is attached", async () => {
  const driver = createNewtonBrowserDriver();
  await driver.recordDebuggerEvent(
    {},
    "Runtime.consoleAPICalled",
    { type: "log", args: [{ value: "external" }] },
  );
  assert.deepEqual(driver.consoleBuffer.map((entry) => entry.text), ["external"]);
  assert.equal(driver.debuggerEventUnsubscribe, null);
});

function subscribedDebuggerHarness({ onAttach, onDetach, onCommand } = {}) {
  let listener = null;
  let unsubscribeCount = 0;
  const port = {
    onDebuggerEvent(next) {
      assert.equal(listener, null, "only one active debugger listener");
      listener = next;
      return () => {
        unsubscribeCount += 1;
        listener = null;
      };
    },
    async attach() { await onAttach?.(); },
    async detach() { await onDetach?.(); },
    async sendCommand(source, method, params) {
      const overridden = await onCommand?.(source, method, params);
      if (overridden !== undefined) return overridden;
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "main-target", url: "https://example.com/" } };
      }
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
      return {};
    },
  };
  return {
    port,
    emit(source, method, params) {
      assert.ok(listener, "debugger listener is active");
      return Promise.resolve(listener(source, method, params));
    },
    hasListener: () => listener !== null,
    unsubscribeCount: () => unsubscribeCount,
  };
}

test("root debugger detach failure retains ownership and retries without relationship cleanup", async () => {
  let detachAttempts = 0;
  const debuggerPort = {
    async attach() {},
    async detach() {
      detachAttempts += 1;
      if (detachAttempts === 1) throw new Error("raw browser detail");
    },
    async sendCommand() { return {}; },
  };
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
  primeRelatedDriver(driver);
  driver.attached = true;
  driver.mainFrameId = "main-frame";
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    return {};
  };

  await assert.rejects(driver.detach(), (error) => {
    assert.equal(error?.code, "shutdown_detach_failed");
    assert.equal(error?.message, "shutdown_detach_failed");
    return true;
  });
  assert.equal(driver.attached, true);
  assert.equal(driver.mainTargetId, "main-target");
  assert.equal(driver.mainFrameId, "main-frame");
  assert.equal(driver.relationshipCleanupComplete, true);
  assert.equal(driver.browserControlSessionId, null);
  assert.equal(driver.closing, true);
  assert.equal(driver.containmentReady, false);
  assert.equal(calls.filter((call) => call.method === "Target.detachFromTarget").length, 1);

  await driver.detach();
  assert.equal(calls.filter((call) => call.method === "Target.detachFromTarget").length, 1);
  assert.equal(calls.filter((call) => call.method === "Target.setAutoAttach" && call.params?.autoAttach === false).length, 1);
  assert.equal(driver.attached, false);
  assert.equal(driver.mainTargetId, null);
  assert.equal(driver.relationshipCleanupComplete, false);
  assert.equal(detachAttempts, 2);
});

function primeRelatedDriver(driver, browserSessionId = "browser-control") {
  driver.mainTargetId = "main-target";
  driver.browserControlSessionId = browserSessionId;
  driver.browserPageAutoAttachActive = true;
  driver.containmentReady = true;
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
}

test("relationship-scoped duplicate root attachment resumes without duplicate setup", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };

  await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
    sessionId: "duplicate-root",
    waitingForDebugger: true,
    targetInfo: { targetId: "main-target", type: "page", url: "https://example.com" },
  });

  assert.equal(driver.browserRootSessionId, "duplicate-root");
  assert.deepEqual(calls, [{ method: "Runtime.runIfWaitingForDebugger", params: {}, route: { sessionId: "duplicate-root" } }]);
  assert.equal(driver.targetRegistry.getSnapshot().counts.targets.active, 1);
});

test("attach drains the related-target queue before publishing containment readiness", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  const order = [];
  driver.calibrate = async () => { order.push("calibrate"); };
  driver.cdp = async (method, _params, route) => {
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
    if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
    if (method === "Target.setAutoAttach" && route?.sessionId === "browser-control") {
      order.push("browser-page-autoattach");
      driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
        sessionId: "duplicate-root",
        waitingForDebugger: true,
        targetInfo: { targetId: "main-target", type: "page", url: "https://example.com" },
      }).catch(() => {});
    }
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "duplicate-root") order.push("resume-root");
    return {};
  };
  await driver.attach();
  assert.equal(driver.containmentReady, true);
  assert.deepEqual(order, ["browser-page-autoattach", "resume-root", "calibrate"]);
  await driver.detach();
});

test("related denied popup is controlled before close and prevention is acknowledged centrally", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://denied.test/popup" },
    });
    return { status: "verified", changed: {} };
  };

  const result = await driver.executeAction({ kind: "click", selector: "#open" }, { commandId: "cmd-popup" });
  const setup = calls.findIndex((call) => call.method === "Fetch.enable" && call.route?.sessionId === "popup-session");
  const close = calls.findIndex((call) => call.method === "Target.closeTarget");
  assert.equal(setup, -1);
  assert.equal(close >= 0, true);
  assert.equal(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger" && call.route?.sessionId === "popup-session"), false);
  assert.deepEqual(calls[close].route, { sessionId: "browser-control" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_target");
  assert.equal(result.changed.containmentPrevention, "ungranted_target");
});

test("a denied worker target is command-scoped and acknowledged closed before prevention", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  let closeResolve;
  let closeStartedResolve;
  const closeAcknowledged = new Promise((resolve) => { closeResolve = resolve; });
  const closeStarted = new Promise((resolve) => { closeStartedResolve = resolve; });
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Target.closeTarget") {
      closeStartedResolve();
      await closeAcknowledged;
      return { success: true };
    }
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "worker-session",
      waitingForDebugger: true,
      targetInfo: {
        targetId: "worker-target",
        type: "worker",
        url: "https://denied.test/worker.js",
      },
    });
    return { status: "verified", changed: {} };
  };

  let settled = false;
  const action = driver.executeAction({ kind: "click", selector: "#worker" })
    .finally(() => { settled = true; });
  await closeStarted;
  assert.equal(settled, false);
  assert.equal(calls.some((call) => call.method === "Fetch.enable" && call.route?.sessionId === "worker-session"), false);
  assert.equal(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger" && call.route?.sessionId === "worker-session"), false);
  closeResolve();
  const result = await action;
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_target");
  assert.equal(result.changed.containmentPrevention, "ungranted_target");
  assert.deepEqual(calls.find((call) => call.method === "Target.closeTarget")?.route, { sessionId: "browser-control" });
  assert.equal(driver.relatedLaunchTickets.size, 0);
});

test("a denied worker outside a command is closed without poisoning the next command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    return method === "Target.closeTarget" ? { success: true } : {};
  };
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "late-worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "late-worker-target",
      type: "worker",
      url: "https://denied.test/worker.js",
    },
  });
  assert.equal(driver.relatedLaunchTickets.size, 0);
  assert.equal(calls.filter((call) => call.method === "Target.closeTarget").length, 1);

  driver.executeActionNow = async () => ({ status: "verified", changed: {} });
  const result = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(result.status, "verified");
  assert.equal(result.changed.containmentPrevention, undefined);
});

test("owned-browser unpaused workers stay proxy-only and never enter the actionable registry", async () => {
  for (const rawType of ["worker", "shared_worker", "service_worker"]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    const calls = [];
    driver.cdp = async (method, params, route) => {
      calls.push({ method, params, route });
      return {};
    };
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: `${rawType}-session`,
      waitingForDebugger: false,
      targetInfo: {
        targetId: `${rawType}-target`,
        type: rawType,
        url: "https://example.com/worker.js",
      },
    });
    assert.equal(driver.targetRegistry.targetForSession(`${rawType}-session`), undefined);
    assert.deepEqual(calls, []);
    driver.markDetached();
  }
});

test("owned-browser unpaused popups are proxy-guarded and never become actionable", async () => {
  for (const [url, changedUrl, expectedStatus] of [
    ["https://denied.test/popup", null, "blocked"],
    ["about:blank", "https://denied.test/popup", "blocked"],
    ["about:blank", "https://example.com/popup", "verified"],
  ]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    const calls = [];
    driver.cdp = async (method, params, route) => {
      calls.push({ method, params, route });
      return method === "Target.closeTarget" ? { success: true } : {};
    };
    driver.executeActionNow = async () => {
      await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
        sessionId: "popup-session",
        waitingForDebugger: false,
        targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url },
      });
      if (changedUrl) {
        await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.targetInfoChanged", {
          targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: changedUrl },
        });
      }
      return { status: "verified", changed: {} };
    };

    const result = await driver.executeAction({ kind: "click", selector: "#popup" });
    assert.equal(result.status, expectedStatus);
    assert.equal(driver.targetRegistry.targetForSession("popup-session"), undefined);
    assert.equal(calls.some((call) => call.method === "Fetch.enable" && call.route?.sessionId === "popup-session"), false);
    assert.equal(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger"
      && call.route?.sessionId === "popup-session"), false);
    assert.equal(calls.some((call) => call.method === "Target.closeTarget"), expectedStatus === "blocked");
    assert.equal(driver.proxyGuardedRelatedPages.has("popup"), expectedStatus === "verified");
    driver.markDetached();
  }
});

test("owned-browser unpaused child setup is deferred across input and flushed afterward", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  driver.activeCommandToken = 7;
  const calls = [];
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };
  const attached = {
    sessionId: "child-session",
    waitingForDebugger: false,
    targetInfo: { targetId: "child", type: "iframe", url: "https://example.com/frame" },
  };

  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", attached);
  assert.equal(driver.pendingOwnedChildTargets.size, 1);
  assert.equal(driver.targetRegistry.targetForSession("child-session"), undefined);
  assert.deepEqual(calls, []);

  driver.activeCommandToken = null;
  await driver.flushPendingOwnedChildTargets();
  assert.equal(driver.pendingOwnedChildTargets.size, 0);
  assert.equal(driver.targetRegistry.targetForSession("child-session")?.type, "iframe");
  assert.equal(calls.some((call) => call.method === "Target.setAutoAttach" && call.route?.sessionId === "child-session"), true);
  assert.equal(calls.some((call) => call.method === "Fetch.enable" && call.route?.sessionId === "child-session"), true);
  assert.equal(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger"), false);
});

test("owned-browser child setup excludes a transient unconfigurable route without poisoning the main session", async () => {
  const attached = {
    sessionId: "child-session",
    waitingForDebugger: false,
    targetInfo: { targetId: "child", type: "iframe", url: "https://example.com/frame" },
  };
  const makeDriver = () => {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    const calls = [];
    driver.cdp = async (method, params, route) => {
      calls.push({ method, params, route });
      if (method === "Runtime.enable") throw new Error("child_setup_failed");
      return {};
    };
    return { driver, calls };
  };

  const { driver, calls } = makeDriver();
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", attached);
  assert.equal(driver.targetRegistry.targetForSession("child-session"), undefined);
  assert.equal(driver.protocolEventFailure, null);
  assert.deepEqual(calls.at(-1), {
    method: "Target.detachFromTarget",
    params: { sessionId: "child-session" },
    route: { sessionId: "browser-control" },
  });
});

test("related popup prevention is not authoritative before close acknowledgement", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let acknowledgeClose;
  let closeStarted;
  const started = new Promise((resolve) => { closeStarted = resolve; });
  const acknowledged = new Promise((resolve) => { acknowledgeClose = resolve; });
  driver.cdp = async (method) => {
    if (method === "Target.closeTarget") {
      closeStarted();
      await acknowledged;
      return { success: true };
    }
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://denied.test/popup" },
    });
    return { status: "verified", changed: {} };
  };
  let settled = false;
  const action = driver.executeAction({ kind: "click", selector: "#open" }).finally(() => { settled = true; });
  await started;
  assert.equal(settled, false);
  acknowledgeClose();
  assert.equal((await action).reason, "ungranted_target");
});

test("related about:blank is controlled and resumed before its first Document settles the command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    return method === "Target.closeTarget" ? { success: true } : {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "about:blank" },
    });
    return { status: "verified", changed: {} };
  };

  let settled = false;
  const action = driver.executeAction({ kind: "click", selector: "#x" }).finally(() => { settled = true; });
  await resumed;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(calls.some((call) => call.method === "Fetch.enable" && call.route?.sessionId === "popup-session"), true);
  assert.equal(calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger" && call.route?.sessionId === "popup-session"), true);
  assert.equal(calls.some((call) => call.method === "Target.closeTarget"), false);
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "denied-document",
    request: { url: "https://denied.test/popup", method: "GET" },
    resourceType: "Document",
  });
  const result = await action;
  assert.equal(calls.some((call) => call.method === "Target.closeTarget" && call.route?.sessionId === "browser-control"), true);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_navigation");
});

test("related about:blank allowed Document settles from browser target commit without page domains", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "about:blank" },
    });
    return { status: "verified", changed: {} };
  };

  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await resumed;
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "allowed-document",
    request: { url: "https://example.com/popup", method: "GET" },
    resourceType: "Document",
  });
  await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.targetInfoChanged", {
    targetInfo: { targetId: "popup", type: "page", url: "https://example.com/popup" },
  });
  const result = await action;
  assert.equal(result.status, "verified");
  assert.equal(calls.some((call) => call.method === "Fetch.enable" && call.route?.sessionId === "popup-session"), true);
  assert.equal(calls.some((call) => call.method === "Page.enable" && call.route?.sessionId === "popup-session"), false);
});

test("related popup prevention settles before root post-click probing", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let settledRoot = false;
  let observedRoot = false;
  let relatedCalls = 0;
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.hitTestTarget = async () => true;
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.cdp = async () => ({});
  driver.fenceBrowserProtocolEvents = async () => {};
  driver.awaitRelatedLaunches = async () => {
    relatedCalls += 1;
    return relatedCalls === 1 ? "ungranted_target" : null;
  };
  driver.settleShort = async () => { settledRoot = true; };
  driver.observeDelta = async () => {
    observedRoot = true;
    return { kind: "observation_delta", nodes: [] };
  };

  const result = await driver.executeAction({ kind: "click", selector: "#popup" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_target");
  assert.equal(result.changed.containmentPrevention, "ungranted_target");
  assert.equal(settledRoot, false);
  assert.equal(observedRoot, false);
  assert.equal(relatedCalls, 2);
});

test("command waits for deferred child Document prevention and does not attribute it to the next command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  const calls = [];
  driver.cdp = async (method, _params, route) => {
    calls.push({ method, route });
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
    });
    return { status: "verified", changed: {} };
  };
  let actionSettled = false;
  const first = driver.executeAction({ kind: "click", selector: "#open" }).finally(() => { actionSettled = true; });
  await resumed;
  await Promise.resolve();
  assert.equal(actionSettled, false);
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "denied-document",
    request: { url: "https://denied.test/popup", method: "GET" },
    resourceType: "Document",
  });
  const firstResult = await first;
  assert.equal(firstResult.status, "blocked");
  assert.equal(firstResult.reason, "ungranted_navigation");

  driver.executeActionNow = async () => ({ status: "verified", changed: {} });
  const second = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(second.status, "verified");
  assert.equal(second.changed.containmentPrevention, undefined);
});

test("root causal fence captures a related attach deferred beyond action dispatch", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let delivered = false;
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  driver.cdp = async (method, _params, route) => {
    if (method === "Target.getTargetInfo" && route?.sessionId === undefined && !delivered) {
      delivered = true;
      driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
        sessionId: "popup-session", waitingForDebugger: true,
        targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
      }).catch(() => {});
    }
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => ({ status: "verified", changed: {} });
  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await resumed;
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "denied", request: { url: "https://denied.test", method: "GET" }, resourceType: "Document",
  });
  assert.equal((await action).reason, "ungranted_navigation");
});

test("concrete granted noopener popup settles only after allowed redirect Documents and commit", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://redirect.test"] });
  primeRelatedDriver(driver);
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  const calls = [];
  driver.cdp = async (method, _params, route) => {
    calls.push({ method, route });
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", url: "https://example.com/start" },
    });
    return { status: "verified", changed: {} };
  };
  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await resumed;
  for (const [requestId, url] of [["doc-1", "https://example.com/start"], ["doc-2", "https://redirect.test/final"]]) {
    await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
      requestId,
      request: { url, method: "GET" },
      resourceType: "Document",
    });
  }
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Page.frameNavigated", {
    frame: { id: "popup-root", url: "https://redirect.test/final" },
  });
  const result = await action;
  assert.equal(result.status, "verified");
  assert.equal(driver.relatedLaunchTickets.has("popup"), true);
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
      requestId: "late-write",
      request: { url: "https://denied.test/write", method: "POST" },
      resourceType: "Fetch",
    });
    return { status: "verified", changed: {} };
  };
  const next = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(next.status, "verified");
  assert.equal(next.changed.containmentPrevention, undefined);
  await driver.closeOutstandingRelatedLaunches();
  assert.equal(calls.some((call) => call.method === "Target.closeTarget" && call.route?.sessionId === "browser-control"), true);
  assert.equal(driver.relatedLaunchTickets.size, 0);
});

test("unexpected related target detach before allowed commit is uncertainty", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let resumedResolve;
  const resumed = new Promise((resolve) => { resumedResolve = resolve; });
  driver.cdp = async (method, _params, route) => {
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") resumedResolve();
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
    });
    return { status: "verified", changed: {} };
  };
  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await resumed;
  await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.detachedFromTarget", {
    targetId: "popup", sessionId: "popup-session",
  });
  await assert.rejects(action, (error) => error?.code === "containment_fence_failed");
  assert.equal(driver.relatedLaunchTickets.has("popup"), false);
  assert.equal(driver.relatedCommandFailures.size, 0);
});

test("an affirmatively closed expired ticket releases its timer and storage but preserves command failure", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const cleared = [];
  globalThis.setTimeout = () => ({ fake: true });
  globalThis.clearTimeout = (timer) => { cleared.push(timer); };
  try {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    driver.activeCommandToken = 7;
    driver.cdp = async (method) => method === "Target.closeTarget" ? { success: true } : {};
    const ticket = await driver.createRelatedLaunchTicket("popup", "popup-session", "browser-control", driver.protocolGeneration, "main-target");
    driver.armRelatedLaunchDeadline(ticket);
    const rejected = assert.rejects(ticket.promise, (error) => error?.code === "containment_fence_failed");
    await driver.expireRelatedLaunchTicket(ticket);
    await rejected;
    assert.equal(ticket.timer, null);
    assert.equal(cleared.length, 1);
    assert.equal(driver.relatedLaunchTickets.has("popup"), false);
    assert.equal(driver.relatedCommandFailures.get(7)?.code, "containment_fence_failed");
    assert.throws(() => driver.consumeRelatedCommandFailure(7), (error) => error?.code === "containment_fence_failed");
    assert.equal(driver.relatedCommandFailures.size, 0);
    driver.markDetached();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("sequential closed popup failures consume only their originating command token", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  driver.cdp = async () => ({});
  for (let index = 0; index < 65; index += 1) {
    const targetId = `failed-popup-${index}`;
    const sessionId = `failed-popup-session-${index}`;
    driver.containmentReady = true;
    driver.executeActionNow = async () => {
      await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
        sessionId,
        waitingForDebugger: true,
        targetInfo: { targetId, type: "page", openerId: "main-target", url: "https://example.com/popup" },
      });
      await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.detachedFromTarget", {
        targetId,
        sessionId,
      });
      return { status: "verified", changed: {} };
    };
    await assert.rejects(
      driver.executeAction({ kind: "click", selector: "#open" }),
      (error) => error?.code === "containment_fence_failed",
    );
    assert.equal(driver.relatedCommandFailures.size, 0);
    assert.equal(driver.relatedLaunchTickets.size, 0);
  }

  driver.containmentReady = true;
  driver.executeActionNow = async () => ({ status: "verified", changed: {} });
  const next = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(next.status, "verified");
  assert.equal(next.changed.containmentPrevention, undefined);
  assert.equal(driver.relatedCommandFailures.size, 0);
});

test("related page must be paused and a queued setup failure prevents command completion", async () => {
  for (const waitingForDebugger of [false, undefined]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    driver.cdp = async () => ({});
    await assert.rejects(driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: `popup-${String(waitingForDebugger)}`,
      ...(waitingForDebugger !== undefined ? { waitingForDebugger } : {}),
      targetInfo: { targetId: `popup-${String(waitingForDebugger)}`, type: "page", openerId: "main-target", url: "https://denied.test" },
    }), (error) => error?.code === "containment_fence_failed");
    assert.equal(driver.commandContainmentPrevention, null);
    assert.equal(driver.containmentReady, false);
  }

  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  driver.cdp = async (method) => method === "Target.closeTarget" ? { success: false } : {};
  driver.executeActionNow = async () => {
    driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session",
      waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://denied.test" },
    }).catch(() => {});
    return { status: "verified", changed: {} };
  };
  await assert.rejects(
    driver.executeAction({ kind: "click", selector: "#open" }),
    (error) => error?.code === "containment_fence_failed",
  );
  assert.equal(driver.containmentReady, false);
});

test("related popup setup failures close before fail-closed teardown", async () => {
  for (const failedMethod of ["Target.setAutoAttach", "Runtime.enable", "Fetch.enable"]) {
      const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
      primeRelatedDriver(driver);
      driver.attached = true;
      const calls = [];
      driver.cdp = async (method, params, route) => {
        calls.push({ method, params, route });
        if (method === failedMethod && route?.sessionId === "popup-session") throw new Error("setup failed");
        if (method === "Target.closeTarget") return { success: true };
        return {};
      };
      await assert.rejects(driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
        sessionId: "popup-session", waitingForDebugger: true,
        targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
      }), (error) => error?.code === "containment_fence_failed");
      await driver.detach();
      const close = calls.findIndex((call) => call.method === "Target.closeTarget");
      const disable = calls.findIndex((call) => call.method === "Target.setAutoAttach" && call.params?.autoAttach === false);
      assert.equal(close >= 0 && close < disable, true, failedMethod);
  }
});

test("failed popup close blocks teardown and retains exact cleanup identity", async () => {
  let rootDetach = 0;
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: { async attach() {}, async detach() { rootDetach += 1; }, async sendCommand() { return {}; } },
  });
    primeRelatedDriver(driver);
    driver.attached = true;
    driver.cdp = async (method) => method === "Target.closeTarget" ? { success: false } : {};
    driver.closing = true;
    await assert.rejects(driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "about:blank" },
    }), (error) => error?.code === "containment_fence_failed");
    await assert.rejects(driver.detach(), (error) => error?.code === "containment_fence_failed");
    assert.equal(driver.browserControlSessionId, "browser-control");
    assert.equal(driver.relatedLaunchTickets.has("popup"), true);
  assert.equal(rootDetach, 0);
});

test("popup delivered during teardown is closed before relationship detach", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    driver.attached = true;
    const order = [];
    driver.cdp = async (method, _params, route) => {
      if (method === "Target.getTargetInfo" && route?.sessionId === "browser-control" && !order.includes("delivered")) {
        order.push("delivered");
        driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
          sessionId: "late-popup", waitingForDebugger: true,
          targetInfo: { targetId: "late-popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
        }).catch(() => {});
      }
      if (method === "Target.closeTarget") { order.push("closed"); return { success: true }; }
      if (method === "Target.detachFromTarget") order.push("detached-browser");
      return {};
    };
    await driver.detach();
  assert.equal(order.indexOf("closed") < order.indexOf("detached-browser"), true);
});

test("unknown flattened sessions cannot mutate buffers, dialogs, signals, or registry", async () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
  driver.targetRegistry.registerTarget({ targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child", sessionId: "child-session" });
  const signals = driver.beginActionSignals();
  for (const [method, params] of [
    ["Network.requestWillBeSent", { requestId: "x", request: { method: "POST", url: "https://denied.test" } }],
    ["Page.javascriptDialogOpening", { type: "alert", message: "forged" }],
    ["Target.detachedFromTarget", { targetId: "child", sessionId: "child-session" }],
  ]) await driver.recordDebuggerEvent({ sessionId: "stale-session" }, method, params);
  assert.equal(driver.networkBuffer.size, 0);
  assert.equal(driver.pendingDialog, null);
  assert.deepEqual(signals.finish(), {});
  assert.equal(driver.targetRegistry.targetForSession("child-session")?.targetId, "child");
});

test("paused related targetInfo changes resume granted URLs and close denied URLs", async () => {
  for (const [url, expected] of [["https://example.com/popup", "resume"], ["https://denied.test/popup", "close"]]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    primeRelatedDriver(driver);
    const calls = [];
    driver.cdp = async (method, params, route) => {
      calls.push({ method, params, route });
      return method === "Target.closeTarget" ? { success: true } : {};
    };
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "data:text/html,pending" },
    });
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.targetInfoChanged", {
      targetInfo: { targetId: "popup", type: "page", url },
    });
    assert.equal(calls.some((call) => call.method === (expected === "resume" ? "Runtime.runIfWaitingForDebugger" : "Target.closeTarget")), true);
    driver.markDetached();
  }
});

test("a denied related grandchild is attributed to the originating popup command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let parentResumedResolve;
  const parentResumed = new Promise((resolve) => { parentResumedResolve = resolve; });
  driver.cdp = async (method, params, route) => {
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "parent-session") parentResumedResolve();
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "parent-session", waitingForDebugger: true,
      targetInfo: { targetId: "parent-popup", type: "page", openerId: "main-target", url: "https://example.com/parent" },
    });
    return { status: "verified", changed: {} };
  };
  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await parentResumed;
  await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
    sessionId: "grandchild-session", waitingForDebugger: true,
    targetInfo: { targetId: "grandchild", type: "page", openerId: "parent-popup", url: "https://denied.test/child" },
  });
  await driver.recordDebuggerEvent({ sessionId: "parent-session" }, "Fetch.requestPaused", {
    requestId: "parent-document", request: { url: "https://example.com/parent", method: "GET" }, resourceType: "Document",
  });
  await driver.recordDebuggerEvent({ sessionId: "parent-session" }, "Page.frameNavigated", {
    frame: { id: "parent-root", url: "https://example.com/parent" },
  });
  const result = await action;
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_target");
});

test("a pending popup descendant Document denial prevents its originating command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let popupResumedResolve;
  const popupResumed = new Promise((resolve) => { popupResumedResolve = resolve; });
  driver.cdp = async (method, _params, route) => {
    if (method === "Runtime.runIfWaitingForDebugger" && route?.sessionId === "popup-session") popupResumedResolve();
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
    });
    return { status: "verified", changed: {} };
  };
  const action = driver.executeAction({ kind: "click", selector: "#open" });
  await popupResumed;
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Target.attachedToTarget", {
    sessionId: "popup-child-session", waitingForDebugger: true,
    targetInfo: { targetId: "popup-child", type: "iframe", openerFrameId: "popup-child", url: "https://example.com/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "popup-child-session" }, "Fetch.requestPaused", {
    requestId: "denied-child-document",
    request: { url: "https://denied.test/frame", method: "GET" },
    resourceType: "Document",
    frameId: "popup-child",
  });
  const result = await action;
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ungranted_navigation");
});

test("a settled popup descendant denial is failed without poisoning a later command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
    });
    return { status: "verified", changed: {} };
  };
  const first = driver.executeAction({ kind: "click", selector: "#open" });
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "popup-document", request: { url: "https://example.com/popup", method: "GET" }, resourceType: "Document",
  });
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Page.frameNavigated", {
    frame: { id: "popup-root", url: "https://example.com/popup" },
  });
  assert.equal((await first).status, "verified");
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Target.attachedToTarget", {
    sessionId: "popup-child-session", waitingForDebugger: true,
    targetInfo: { targetId: "popup-child", type: "iframe", openerFrameId: "popup-child", url: "https://example.com/frame" },
  });

  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "popup-child-session" }, "Fetch.requestPaused", {
      requestId: "late-denied-child",
      request: { url: "https://denied.test/frame", method: "GET" },
      resourceType: "Document",
      frameId: "popup-child",
    });
    return { status: "verified", changed: {} };
  };
  const second = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(second.status, "verified");
  assert.equal(second.changed.containmentPrevention, undefined);
  assert.equal(calls.some((call) => call.method === "Fetch.failRequest" && call.route?.sessionId === "popup-child-session"), true);
  assert.equal(calls.some((call) => call.method === "Target.closeTarget" && call.params?.targetId === "popup"), true);
});

test("a settled popup worker denial is failed without poisoning a later command", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };
  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: "popup-session", waitingForDebugger: true,
      targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "https://example.com/popup" },
    });
    return { status: "verified", changed: {} };
  };
  const first = driver.executeAction({ kind: "click", selector: "#open" });
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "popup-document", request: { url: "https://example.com/popup", method: "GET" }, resourceType: "Document",
  });
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Page.frameNavigated", {
    frame: { id: "popup-root", url: "https://example.com/popup" },
  });
  assert.equal((await first).status, "verified");
  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Target.attachedToTarget", {
    sessionId: "popup-worker-session", waitingForDebugger: true,
    targetInfo: { targetId: "popup-worker", type: "worker", url: "https://example.com/worker.js" },
  });
  assert.equal(driver.targetRegistry.targetForSession("popup-worker-session")?.parentTargetId, "popup");

  driver.executeActionNow = async () => {
    await driver.recordDebuggerEvent({ sessionId: "popup-worker-session" }, "Fetch.requestPaused", {
      requestId: "late-denied-worker",
      request: { url: "https://denied.test/write", method: "POST" },
      resourceType: "Fetch",
    });
    return { status: "verified", changed: {} };
  };
  const second = await driver.executeAction({ kind: "click", selector: "#next" });
  assert.equal(second.status, "verified");
  assert.equal(second.changed.containmentPrevention, undefined);
  assert.equal(calls.some((call) => call.method === "Fetch.failRequest" && call.route?.sessionId === "popup-worker-session"), true);
  driver.markDetached();
});

test("related popup page and OOPIF subtree remain containment-only during observation", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main");
  driver.targetRegistry.registerTarget({
    targetId: "popup", type: "page", parentTargetId: "main", sessionId: "popup-session", origin: "https://example.com",
  });
  driver.targetRegistry.registerFrame({ frameId: "popup-host", targetId: "popup", origin: "https://example.com" });
  driver.targetRegistry.registerTarget({
    targetId: "popup-child", type: "iframe", parentTargetId: "popup", hostFrameId: "popup-host",
    sessionId: "popup-child-session", origin: "https://example.com",
  });
  driver.targetRegistry.registerFrame({ frameId: "popup-child-root", targetId: "popup-child", origin: "https://example.com" });
  const readSessions = [];
  driver.cdp = async (method, _params, route) => {
    if (method === "Accessibility.getFullAXTree") readSessions.push(route?.sessionId ?? "root");
    return { nodes: [] };
  };
  await driver.accessibilityTreesForOrigin("https://example.com");
  assert.deepEqual(readSessions, ["root"]);
  assert.deepEqual(driver.targetRegistry.listObservationRoutes().map((route) => route.targetId), ["main"]);
});

test("related launch tickets are bounded and overflow is closed", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(driver);
  let closes = 0;
  driver.cdp = async (method) => {
    if (method === "Target.closeTarget") { closes += 1; return { success: true }; }
    return {};
  };
  for (let index = 0; index < 64; index += 1) {
    await driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
      sessionId: `pending-session-${index}`, waitingForDebugger: true,
      targetInfo: { targetId: `pending-${index}`, type: "page", openerId: "main-target", url: `data:text/html,${index}` },
    });
  }
  await assert.rejects(driver.recordDebuggerEvent({ sessionId: "browser-control" }, "Target.attachedToTarget", {
    sessionId: "overflow-session", waitingForDebugger: true,
    targetInfo: { targetId: "overflow", type: "page", openerId: "main-target", url: "data:text/html,overflow" },
  }), (error) => error?.code === "containment_fence_failed");
  assert.equal(driver.relatedLaunchTickets.size, 64);
  assert.equal(closes, 1);
  driver.markDetached();
});

test("multiple unacknowledged overflow closes permanently fence bounded teardown", async () => {
  let rootDetach = 0;
  const driver = createNewtonBrowserDriver({
    allowedOrigins: ["https://example.com"],
    debuggerPort: { async attach() {}, async detach() { rootDetach += 1; }, async sendCommand() { return {}; } },
  });
    primeRelatedDriver(driver);
    driver.attached = true;
    driver.cdp = async (method) => method === "Target.closeTarget" ? { success: false } : {};
    await assert.rejects(
      driver.closeUntrackedRelatedTarget("overflow-a", "browser-control", "close-a"),
      (error) => error?.code === "containment_fence_failed",
    );
    await assert.rejects(
      driver.closeUntrackedRelatedTarget("overflow-b", "browser-control", "close-b"),
      (error) => error?.code === "containment_fence_failed",
    );
    assert.deepEqual(driver.unresolvedRelatedClose, { targetId: "overflow-a", browserSessionId: "browser-control" });
    assert.equal(driver.unresolvedRelatedCloseOverflow, true);
    driver.cdp = async (method) => method === "Target.closeTarget" ? { success: true } : {};
    await assert.rejects(driver.detach(), (error) => error?.code === "containment_fence_failed");
    assert.equal(driver.attached, true);
  assert.equal(rootDetach, 0);
});

test("wrong browser sessions and separate drivers cannot admit each other's popups", async () => {
  const first = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  const second = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(first, "browser-one");
  primeRelatedDriver(second, "browser-two");
  first.cdp = async () => ({});
  second.cdp = async (method) => method === "Target.closeTarget" ? { success: true } : {};
  const event = {
    sessionId: "popup-session",
    waitingForDebugger: true,
    targetInfo: { targetId: "popup", type: "page", openerId: "main-target", url: "about:blank" },
  };
  await first.recordDebuggerEvent({ sessionId: "browser-two" }, "Target.attachedToTarget", event);
  await second.recordDebuggerEvent({ sessionId: "browser-two" }, "Target.attachedToTarget", event);
  assert.equal(first.targetRegistry.targetForSession("popup-session"), undefined);
  assert.equal(second.targetRegistry.targetForSession("popup-session")?.type, "page");
  assert.equal(second.relatedLaunchTickets.has("popup"), true);
  second.markDetached();
  first.markDetached();
  await first.recordDebuggerEvent({ sessionId: "browser-one" }, "Target.attachedToTarget", { ...event, sessionId: "stale-popup" });
  assert.equal(first.targetRegistry.targetForSession("stale-popup"), undefined);
});

test("attach fails closed when browser-page auto-attach setup fails", async () => {
  let detached = 0;
  const debuggerPort = { async attach() {}, async detach() { detached += 1; }, async sendCommand() { return {}; } };
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
    driver.cdp = async (method) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
      if (method === "Target.setAutoAttach") throw new Error("unsupported");
      return {};
    };
    await assert.rejects(driver.attach(), (error) => error?.code === "browser_page_autoattach_failed");
    assert.equal(driver.attached, false);
    assert.equal(driver.containmentReady, false);
    assert.equal(driver.browserControlSessionId, null);
  assert.equal(detached, 1);
});

test("attach failures expose only exact closed stage codes and preserve typed security failures", async () => {
  let failDebuggerAttach = false;
  const debuggerPort = {
    async attach() { if (failDebuggerAttach) throw new Error("raw debugger path"); },
    async detach() {},
    async sendCommand() { return {}; },
  };
    failDebuggerAttach = true;
    const rootAttach = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
    await assert.rejects(rootAttach.attach(), (error) => {
      assert.deepEqual({ code: error?.code, message: error?.message, detail: error?.detail }, {
        code: "root_debugger_attach_failed", message: "root_debugger_attach_failed", detail: undefined,
      });
      return true;
    });
    assert.equal(rootAttach.attached, false);
    failDebuggerAttach = false;

    const stages = [
      { code: "root_protocol_setup_failed", fail(method) { return method === "DOM.enable"; } },
      { code: "browser_control_attach_failed", fail(method) { return method === "Target.attachToBrowserTarget"; } },
      { code: "browser_page_autoattach_failed", fail(method, _params, route) { return method === "Target.setAutoAttach" && route?.sessionId === "browser-control"; } },
      { code: "browser_control_fence_failed", fail(method, _params, route) { return method === "Target.getTargetInfo" && route?.sessionId === "browser-control"; } },
      { code: "root_autoattach_failed", fail(method, params, route) { return method === "Target.setAutoAttach" && params?.autoAttach === true && route?.sessionId === undefined; } },
      { code: "calibration_failed", calibration: true, fail() { return false; } },
    ];
    for (const stage of stages) {
      const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
      driver.calibrate = stage.calibration ? async () => { throw new Error("raw calibration metrics"); } : async () => {};
      let failed = false;
      driver.cdp = async (method, params, route) => {
        if (!failed && stage.fail(method, params, route)) {
          failed = true;
          throw new Error("raw protocol and page detail");
        }
        if (method === "Target.getTargetInfo" && route?.sessionId !== "browser-control") {
          return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
        }
        if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
        return {};
      };
      await assert.rejects(driver.attach(), (error) => {
        assert.deepEqual({ code: error?.code, message: error?.message, detail: error?.detail }, {
          code: stage.code, message: stage.code, detail: undefined,
        });
        return true;
      }, stage.code);
      assert.equal(driver.attached, false, stage.code);
    }

    const preserved = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
    preserved.cdp = async (method) => {
      if (method === "DOM.enable") throw Object.assign(new Error("frame_conflict"), { code: "frame_conflict" });
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
      return {};
    };
  await assert.rejects(preserved.attach(), (error) => error?.code === "frame_conflict");
});

test("attach rollback preserves retryable ownership when root debugger detach fails", async () => {
  let allowDetach = false;
  const debuggerPort = {
    async attach() {},
    async detach() { if (!allowDetach) throw new Error("raw detach failure"); },
    async sendCommand() { return {}; },
  };
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"], debuggerPort });
    driver.cdp = async (method) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-control" };
      if (method === "Target.setAutoAttach") throw new Error("unsupported");
      return {};
    };
    await assert.rejects(driver.attach(), (error) => {
      assert.equal(error?.code, "shutdown_detach_failed");
      assert.equal(error?.message, "shutdown_detach_failed");
      return true;
    });
    assert.equal(driver.attached, true);
    assert.equal(driver.mainTargetId, "main-target");
    assert.equal(driver.relationshipCleanupComplete, true);
    assert.equal(driver.browserControlSessionId, null);
    allowDetach = true;
    await driver.detach();
  assert.equal(driver.attached, false);
});

test("mutating command fails closed when browser control identity is missing or detached", async () => {
  const missing = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  missing.containmentReady = true;
  missing.executeActionNow = async () => ({ status: "verified", changed: {} });
  await assert.rejects(
    missing.executeAction({ kind: "click", selector: "#x" }),
    (error) => error?.code === "containment_fence_failed",
  );
  assert.equal(missing.containmentReady, false);

  const detached = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeRelatedDriver(detached);
  detached.cdp = async () => ({});
  detached.executeActionNow = async () => {
    await detached.recordDebuggerEvent({}, "Target.detachedFromTarget", { sessionId: "browser-control" });
    return { status: "verified", changed: {} };
  };
  await assert.rejects(
    detached.executeAction({ kind: "click", selector: "#x" }),
    (error) => error?.code === "containment_fence_failed",
  );
  assert.equal(detached.browserControlSessionId, null);
  assert.equal(detached.browserRootSessionId, null);
  assert.equal(detached.containmentReady, false);
  assert.equal(detached.targetRegistry.getSnapshot().counts.targets.active, 1);
});

test("driver records flattened target/frame lifecycle without swallowing detach", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test", "https://nested.test"] });
  const cdpCalls = [];
  driver.cdp = async (method, params, route) => { cdpCalls.push({ method, params, route }); return {}; };
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");

  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "child-session",
    targetInfo: { targetId: "child-frame", type: "iframe", url: "https://child.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Page.frameNavigated", {
    frame: { id: "child-frame", url: "https://child.test/frame" },
  });
  const snapshot = driver.targetRegistry.getSnapshot();
  assert.equal(snapshot.counts.targets.active, 2);
  assert.equal(snapshot.counts.frames.active, 1);
  assert.equal(driver.targetRegistry.targetForSession("child-session").targetId, "child-frame");
  assert.deepEqual(cdpCalls[0], {
    method: "Target.setAutoAttach",
    params: {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
      filter: [
        { type: "iframe", exclude: false },
        { type: "worker", exclude: false },
        { type: "shared_worker", exclude: false },
        { type: "service_worker", exclude: false },
        { exclude: true },
      ],
    },
    route: { sessionId: "child-session" },
  });

  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Target.attachedToTarget", {
    sessionId: "nested-session",
    targetInfo: { targetId: "nested-frame", type: "iframe", url: "https://nested.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "nested-session" }, "Page.frameNavigated", {
    frame: { id: "nested-root", url: "https://nested.test/frame" },
  });
  assert.equal(driver.targetRegistry.targetForSession("nested-session").parentTargetId, "child-frame");
  assert.equal(cdpCalls.some((call) => call.method === "Target.setAutoAttach" && call.route?.sessionId === "nested-session"), true);

  await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", { sessionId: "child-session" });
  assert.equal(driver.targetRegistry.getSnapshot().counts.targets.active, 1);
});

test("driver observation emits stable refs for every actionable page node", async () => {
  const driver = createNewtonBrowserDriver();
  primeObservationDriver(driver);
  let boxCalls = 0;
  driver.evalString = async (expression) => {
    if (expression === "location.href") return "https://example.com/page";
    if (expression === "document.title") return "Example";
    return "";
  };
  driver.evalNumber = async (expression) => (expression === "window.scrollY" ? 0 : 0);
  driver.cdp = async (method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/page" } } };
    assert.equal(method, "Accessibility.getFullAXTree");
    return {
      nodes: [
        axNode(101, "button", "Save"),
        axNode(102, "link", "Docs"),
        axNode(103, "button", "Cursor"),
      ],
    };
  };
  driver.describedNodeFactsCached = async () => ({ localName: "button", attributes: {} });
  driver.boxFor = async (backendNodeId) => {
    boxCalls += 1;
    return { x: backendNodeId, y: 10, width: 80, height: 20 };
  };

  const first = await driver.observe({ maxNodes: 10 });
  assert.deepEqual(first.nodes.map((node) => node.ref), ["d1:e101", "d1:e102", "d1:e103"]);
  assert.deepEqual(first.nodes.map((node) => node.name), ["Save", "Docs", "Cursor"]);
  assert.equal(driver.refIndex.get("d1:e101").backendNodeId, 101);
  assert.equal(driver.refIndex.get("d1:e102").backendNodeId, 102);
  assert.equal(boxCalls, 3);

  const second = await driver.observe({ maxNodes: 10 });
  assert.deepEqual(second.nodes.map((node) => node.ref), ["d1:e101", "d1:e102", "d1:e103"]);
  assert.equal(boxCalls, 3, "unchanged nodes reuse cached bboxes when the page has not scrolled");
});

test("driver full-page screenshot bounds clip size and marks truncation", async () => {
  const driver = createNewtonBrowserDriver();
  const cdpCalls = [];
  driver.evalString = async (expression) => {
    if (expression === "location.href") return "https://example.com/long";
    if (expression === "document.title") return "Long page";
    return "";
  };
  driver.cdp = async (method, params) => {
    cdpCalls.push({ method, params });
    if (method === "Page.getLayoutMetrics") {
      return { cssContentSize: { width: 2880, height: 12000 } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: "abc123" };
    }
    return {};
  };

  const result = await driver.screenshot({ fullPage: true });
  const shot = cdpCalls.find((call) => call.method === "Page.captureScreenshot");
  assert.ok(shot);
  assert.deepEqual(shot.params.clip, { x: 0, y: 0, width: 2880, height: 6000, scale: 0.5 });
  assert.equal(shot.params.captureBeyondViewport, true);
  assert.equal(result.truncated, true);
  assert.equal(result.width, 1440);
  assert.equal(result.height, 3000);
  assert.equal(result.dataUrl, "data:image/png;base64,abc123");
});

test("driver resolveEvidence uses AX accessible name and commit signals", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main");
  const ref = driver.targetRegistry.createRef("main", 7);
  driver.refIndex.set(ref, driver.targetRegistry.resolveRef(ref));
  driver.evalString = async (expression) => (expression === "location.origin" ? "https://example.com" : "");
  driver.objectIdFor = async (backendNodeId) => (backendNodeId === 7 ? "object-7" : null);
  driver.cdp = async (method) => {
    if (method === "Runtime.callFunctionOn") {
      return {
        result: {
          value: {
            role: "button",
            accessibleName: "Fallback",
            formOwner: "checkout",
            inputType: "",
            autocomplete: "",
            formSubmit: true,
          },
        },
      };
    }
    if (method === "Accessibility.getPartialAXTree") {
      return { nodes: [{ backendDOMNodeId: 7, name: { value: "Place order" } }] };
    }
    return {};
  };

  const evidence = await driver.resolveEvidence({ kind: "click", ref });
  assert.deepEqual(evidence, {
    resolved: {
      role: "button",
      accessibleName: "Place order",
      formOwner: "checkout",
      inputType: "",
      autocomplete: "",
      origin: "https://example.com",
    },
    signals: { formSubmit: true },
  });
});

test("driver actionablePoint scrolls offscreen targets and verifies candidate hit tests", async () => {
  const driver = createNewtonBrowserDriver();
  let scrolled = 0;
  let hitTests = 0;
  driver.evalNumber = async (expression) => {
    if (expression === "window.innerHeight") return 800;
    if (expression === "window.innerWidth") return 1200;
    return 0;
  };
  driver.scrollIntoView = async () => {
    scrolled += 1;
  };
  driver.prepareEmbeddingFrames = async () => { throw new Error("unframed main targets must not prepare iframe owners"); };
  driver.boxFor = async () => ({ x: 10, y: 20, width: 100, height: 40 });
  driver.candidatePoints = async () => [{ x: 100, y: 40 }, { x: 60, y: 40 }];
  driver.hitTestTarget = async (_backendNodeId, x) => {
    hitTests += 1;
    return x === 60;
  };

  const point = await driver.actionablePoint(77);
  assert.deepEqual(point, { x: 60, y: 40 });
  assert.equal(scrolled, 1);
  assert.equal(hitTests, 2);
});

test("driver scrolls and locally verifies nested iframe owners outer-to-inner", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main");
  driver.targetRegistry.registerFrame({ frameId: "outer-frame", targetId: "main" });
  driver.targetRegistry.registerTarget({
    targetId: "outer-frame",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "outer-frame",
    sessionId: "child-session",
  });
  driver.targetRegistry.reconcileOopifFrame({ frameId: "outer-frame", targetId: "outer-frame" });
  driver.targetRegistry.registerFrame({ frameId: "inner-frame", targetId: "outer-frame", parentFrameId: "outer-frame" });
  driver.targetRegistry.registerTarget({
    targetId: "inner-frame",
    type: "iframe",
    parentTargetId: "outer-frame",
    hostFrameId: "inner-frame",
    sessionId: "nested-session",
  });
  driver.targetRegistry.reconcileOopifFrame({ frameId: "inner-frame", targetId: "inner-frame" });
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "DOM.getFrameOwner") {
      return { backendNodeId: params.frameId === "outer-frame" ? 11 : 22 };
    }
    return {};
  };
  driver.scrollIntoView = async (backendNodeId, route) => calls.push({ method: "scroll", backendNodeId, route });
  driver.locallyActionable = async (backendNodeId, route) => {
    calls.push({ method: "local-hit", backendNodeId, route });
    return true;
  };
  driver.iframeOwnerGeometry = async (backendNodeId) => ({
    x: backendNodeId === 11 ? 100 : 30,
    y: backendNodeId === 11 ? 200 : 40,
    viewportWidth: 500,
    viewportHeight: 400,
  });
  driver.evalNumber = async (expression) => expression === "window.innerWidth" ? 500 : 400;

  const prepared = await driver.prepareEmbeddingFrames({ targetId: "inner-frame", sessionId: "nested-session", frameId: "inner-frame" });
  assert.equal(prepared?.geometries.length, 2);
  assert.deepEqual(calls.map((call) => [call.method, call.params?.frameId ?? call.backendNodeId, call.route?.sessionId ?? null]), [
    ["DOM.getFrameOwner", "outer-frame", null],
    ["scroll", 11, null],
    ["DOM.getFrameOwner", "inner-frame", "child-session"],
    ["scroll", 22, "child-session"],
    ["DOM.getFrameOwner", "outer-frame", null],
    ["local-hit", 11, null],
    ["DOM.getFrameOwner", "inner-frame", "child-session"],
    ["local-hit", 22, "child-session"],
  ]);

  calls.length = 0;
  driver.locallyActionable = async (backendNodeId, route) => {
    calls.push({ method: "local-hit", backendNodeId, route });
    return false;
  };
  assert.equal(await driver.prepareEmbeddingFrames({ targetId: "inner-frame", sessionId: "nested-session", frameId: "inner-frame" }), null);
  assert.equal(calls.some((call) => call.method === "local-hit" && call.route?.sessionId === "child-session"), false);

  driver.locallyActionable = async () => true;
  driver.iframeOwnerGeometry = async () => ({ x: 0, y: 0, viewportWidth: 499, viewportHeight: 400 });
  assert.equal(await driver.prepareEmbeddingFrames({ targetId: "inner-frame", sessionId: "nested-session", frameId: "inner-frame" }), null);

  driver.cdp = async () => ({});
  assert.equal(await driver.prepareEmbeddingFrames({ targetId: "inner-frame", sessionId: "nested-session", frameId: "inner-frame" }), null);
});

test("driver prepares one mixed same-process and OOPIF owner chain without binary routing", async () => {
  const driver = createNewtonBrowserDriver();
  const owners = [
    { targetId: "main", sessionId: null, frameId: "outer-same" },
    { targetId: "main", sessionId: null, frameId: "child-host" },
    { targetId: "child-host", sessionId: "child-session", frameId: "child-same" },
    { targetId: "child-host", sessionId: "child-session", frameId: "nested-host" },
    { targetId: "nested-host", sessionId: "nested-session", frameId: "nested-same" },
  ];
  driver.targetRegistry.embeddingOwnerRoutes = () => owners;
  const ownerCalls = [];
  const viewportRoutes = [];
  driver.cdp = async (method, params, route) => {
    if (method === "DOM.getFrameOwner") {
      ownerCalls.push({ frameId: params.frameId, sessionId: route?.sessionId ?? null });
      return { backendNodeId: ownerCalls.length };
    }
    return {};
  };
  driver.scrollIntoView = async () => {};
  driver.locallyActionable = async () => true;
  driver.iframeOwnerGeometry = async () => ({ x: 1, y: 2, viewportWidth: 500, viewportHeight: 400 });
  driver.evalNumber = async (expression, route) => {
    viewportRoutes.push(route);
    return expression === "window.innerWidth" ? 500 : 400;
  };

  const prepared = await driver.prepareEmbeddingFrames({
    targetId: "nested-host",
    sessionId: "nested-session",
    frameId: "nested-same",
  });
  assert.deepEqual(prepared?.routes, owners);
  const expectedOwnerPass = owners.map((owner) => ({ frameId: owner.frameId, sessionId: owner.sessionId }));
  assert.deepEqual(ownerCalls, [...expectedOwnerPass, ...expectedOwnerPass]);
  assert.deepEqual(viewportRoutes.map((route) => route.sessionId), ["child-session", "child-session", "nested-session", "nested-session"]);
});

test("child actionability composes first-level and nested local geometry into root coordinates", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  const routes = [];
  const firstLevel = {
    routes: [{ targetId: "main", sessionId: null, frameId: "outer" }],
    geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
  };
  const nested = {
    routes: [
      { targetId: "main", sessionId: null, frameId: "outer" },
      { targetId: "child", sessionId: "child-session", frameId: "inner" },
    ],
    geometries: [
      { x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 },
      { x: 30, y: 40, viewportWidth: 300, viewportHeight: 200 },
    ],
  };
  assert.deepEqual(driver.composeThroughEmbeddingFrames({ x: 10, y: 20 }, firstLevel), { x: 110, y: 220 });
  assert.deepEqual(driver.composeThroughEmbeddingFrames({ x: 10, y: 20 }, nested), { x: 140, y: 260 });
  driver.prepareEmbeddingFrames = async () => nested;
  driver.scrollIntoView = async (_backendNodeId, route) => routes.push({ kind: "scroll", route });
  driver.evalNumber = async (_expression, route) => {
    routes.push({ kind: "viewport", route });
    return 1000;
  };
  driver.localBoxFor = async () => ({ x: 10, y: 20, width: 100, height: 40 });
  driver.locallyActionable = async (_backendNodeId, route) => {
    routes.push({ kind: "local-hit", route });
    return true;
  };
  driver.localCandidatePoints = async () => [{ x: 10, y: 20 }];
  driver.embeddingTopologyMatches = () => true;
  driver.hitTestTarget = async () => { throw new Error("must not compare child backend ids at absolute coordinates"); };

  const point = await driver.actionablePoint(77, { targetId: "child", sessionId: "child-session", frameId: "child-root" });

  assert.deepEqual(point, { x: 140, y: 260 });
  assert.equal(routes.find((entry) => entry.kind === "viewport")?.route?.sessionId, undefined);
  assert.equal(routes.find((entry) => entry.kind === "local-hit")?.route?.sessionId, "child-session");
});

test("same-site same-process frames compose first-level and nested points without a child session", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "http://localhost:3000" });
  driver.targetRegistry.commitTopLevelDocument("main");
  driver.targetRegistry.registerFrame({
    frameId: "outer",
    targetId: "main",
    backendNodeId: 11,
    origin: "http://localhost:3001",
  });
  driver.targetRegistry.registerFrame({
    frameId: "inner",
    targetId: "main",
    parentFrameId: "outer",
    backendNodeId: 22,
    origin: "http://localhost:3002",
  });
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "DOM.getFrameOwner") return { backendNodeId: params.frameId === "outer" ? 11 : 22 };
    return {};
  };
  driver.scrollIntoView = async (_backendNodeId, route) => calls.push({ method: "scroll", route });
  driver.locallyActionable = async (_backendNodeId, route) => {
    calls.push({ method: "local-hit", route });
    return true;
  };
  driver.iframeOwnerGeometry = async (backendNodeId) => ({
    x: backendNodeId === 11 ? 100 : 30,
    y: backendNodeId === 11 ? 200 : 40,
    viewportWidth: 500,
    viewportHeight: 400,
  });
  driver.localBoxFor = async (_backendNodeId, route) => {
    calls.push({ method: "local-box", route });
    return { x: 10, y: 20, width: 20, height: 20 };
  };
  driver.localCandidatePoints = async (_backendNodeId, route) => {
    calls.push({ method: "local-candidates", route });
    return [{ x: 10, y: 20 }];
  };
  driver.evalNumber = async (_expression, route) => {
    assert.equal(route?.sessionId, undefined);
    assert.equal(route?.frameId, undefined);
    return 1000;
  };

  assert.deepEqual(await driver.actionablePoint(77, { targetId: "main", sessionId: null, frameId: "outer" }), { x: 110, y: 220 });
  assert.deepEqual(await driver.actionablePoint(77, { targetId: "main", sessionId: null, frameId: "inner" }), { x: 140, y: 260 });
  assert.equal(calls.filter((call) => call.method === "DOM.getFrameOwner").every((call) => !call.route?.sessionId), true);
  assert.equal(calls.filter((call) => call.method === "local-box" || call.method === "local-candidates")
    .every((call) => call.route?.frameId === "outer" || call.route?.frameId === "inner"), true);
});

test("child actionability classification follows the exact frame-qualified route", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "mutable-main-identity";
  const frames = {
    routes: [{ targetId: "parent", sessionId: null, frameId: "child-frame" }],
    geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
  };
  driver.prepareEmbeddingFrames = async () => frames;
  driver.scrollIntoView = async () => {};
  driver.evalNumber = async () => 1000;
  driver.localBoxFor = async () => ({ x: 10, y: 20, width: 20, height: 20 });
  driver.locallyActionable = async () => true;
  driver.localCandidatePoints = async () => [{ x: 10, y: 20 }];
  driver.embeddingTopologyMatches = () => true;
  driver.boxFor = async () => { throw new Error("flattened child route must not use main-target geometry"); };

  assert.deepEqual(
    await driver.actionablePoint(77, { targetId: "mutable-main-identity", sessionId: "child-session", frameId: "child-frame" }),
    { x: 110, y: 220 },
  );
});

test("iframe owner geometry rejects transformed, scaled, and missing records", async () => {
  const driver = createNewtonBrowserDriver();
  const valid = {
    x: 100, y: 200, viewportWidth: 500, viewportHeight: 400,
    renderedWidth: 504, renderedHeight: 404, layoutWidth: 504, layoutHeight: 404,
    transform: "none", zoom: "1", axisAligned: true,
  };
  driver.objectIdFor = async () => "owner-object";
  driver.cdp = async () => ({ result: { value: valid } });
  assert.deepEqual(await driver.iframeOwnerGeometry(77, {}), {
    x: 100, y: 200, viewportWidth: 500, viewportHeight: 400,
  });
  driver.cdp = async () => ({ result: { value: { ...valid, transform: "matrix(1, 0, 0, 1, 0, 0)" } } });
  assert.equal(await driver.iframeOwnerGeometry(77, {}), null);
  driver.cdp = async () => ({ result: { value: { ...valid, renderedWidth: 252 } } });
  assert.equal(await driver.iframeOwnerGeometry(77, {}), null);
  driver.objectIdFor = async () => null;
  assert.equal(await driver.iframeOwnerGeometry(77, {}), null);
});

test("child actionability fails closed for an obscured ancestor or local target", async () => {
  const ancestorBlocked = createNewtonBrowserDriver();
  ancestorBlocked.mainTargetId = "main";
  ancestorBlocked.prepareEmbeddingFrames = async () => null;
  let targetScrolled = false;
  ancestorBlocked.scrollIntoView = async () => { targetScrolled = true; };
  assert.equal(await ancestorBlocked.actionablePoint(77, { targetId: "child", sessionId: "child-session", frameId: "child-root" }), null);
  assert.equal(targetScrolled, true, "framed attempts scroll the target before measuring or rejecting the owner chain");

  const targetBlocked = createNewtonBrowserDriver();
  targetBlocked.mainTargetId = "main";
  targetBlocked.prepareEmbeddingFrames = async () => ({
    routes: [{ targetId: "main", sessionId: null, frameId: "child" }],
    geometries: [{ x: 0, y: 0, viewportWidth: 1000, viewportHeight: 1000 }],
  });
  targetBlocked.scrollIntoView = async () => {};
  targetBlocked.evalNumber = async () => 1000;
  targetBlocked.localBoxFor = async () => ({ x: 10, y: 20, width: 20, height: 20 });
  targetBlocked.locallyActionable = async () => false;
  assert.equal(await targetBlocked.actionablePoint(77, { targetId: "child", sessionId: "child-session", frameId: "child-root" }), null);
});

test("child actionability re-prepares embedding geometry outside the root viewport", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  let preparations = 0;
  let targetScrolls = 0;
  driver.prepareEmbeddingFrames = async () => ({
    routes: [{ targetId: "main", sessionId: null, frameId: "child" }],
    geometries: [{ x: preparations++ === 0 ? 200 : 50, y: 200, viewportWidth: 500, viewportHeight: 400 }],
  });
  driver.scrollIntoView = async () => { targetScrolls += 1; };
  driver.evalNumber = async () => 1000;
  driver.localBoxFor = async () => ({ x: 10, y: 20, width: 20, height: 20 });
  driver.locallyActionable = async () => true;
  driver.localCandidatePoints = async () => [{ x: 900, y: 20 }];
  driver.embeddingTopologyMatches = () => true;

  assert.deepEqual(await driver.actionablePoint(77, { targetId: "child", sessionId: "child-session", frameId: "child-root" }), { x: 950, y: 220 });
  assert.equal(preparations, 2);
  assert.equal(targetScrolls, 2);
});

test("framed actionability captures owner geometry only after target scrolling settles", async () => {
  const driver = createNewtonBrowserDriver();
  const route = { targetId: "child", sessionId: "child-session", frameId: "child-root" };
  const owners = [{ targetId: "main", sessionId: null, frameId: "child-host" }];
  driver.targetRegistry.embeddingOwnerRoutes = () => owners;
  let ownerX = 500;
  const order = [];
  driver.scrollIntoView = async (backendNodeId) => {
    if (backendNodeId === 77) {
      order.push("target-scroll");
      ownerX = 100;
    } else {
      order.push("owner-scroll");
    }
  };
  driver.cdp = async (method) => method === "DOM.getFrameOwner" ? { backendNodeId: 11 } : {};
  driver.iframeOwnerGeometry = async () => {
    order.push("owner-geometry");
    return { x: ownerX, y: 200, viewportWidth: 500, viewportHeight: 400 };
  };
  driver.evalNumber = async (expression, evalRoute) => {
    if (evalRoute?.sessionId === "child-session") return expression === "window.innerWidth" ? 500 : 400;
    return 1000;
  };
  driver.localBoxFor = async () => ({ x: 10, y: 20, width: 20, height: 20 });
  driver.localCandidatePoints = async () => [{ x: 10, y: 20 }];
  driver.locallyActionable = async () => true;
  driver.runtimeHitTestTarget = async () => true;

  const point = await driver.actionablePoint(77, route);
  assert.deepEqual(point, { x: 110, y: 220 });
  assert.deepEqual(order.slice(0, 3), ["target-scroll", "owner-scroll", "owner-geometry"]);
  assert.equal(driver.framedPointProof.frames.geometries[0].x, 100);
  assert.equal(await driver.verifyFramedPoint(77, route, point), true);
});

test("two-phase owner preparation uses geometry after the innermost owner scroll", async () => {
  const driver = createNewtonBrowserDriver();
  const route = { targetId: "nested", sessionId: "nested-session", frameId: "nested-root" };
  const owners = [
    { targetId: "main", sessionId: null, frameId: "outer" },
    { targetId: "child", sessionId: "child-session", frameId: "inner" },
  ];
  driver.targetRegistry.embeddingOwnerRoutes = () => owners;
  driver.cdp = async (method, params) => method === "DOM.getFrameOwner"
    ? { backendNodeId: params.frameId === "outer" ? 11 : 22 }
    : {};
  let outerX = 500;
  const order = [];
  driver.scrollIntoView = async (backendNodeId) => {
    order.push(`scroll-${backendNodeId}`);
    if (backendNodeId === 22) outerX = 100;
  };
  driver.locallyActionable = async () => true;
  driver.iframeOwnerGeometry = async (backendNodeId) => {
    order.push(`geometry-${backendNodeId}`);
    return {
      x: backendNodeId === 11 ? outerX : 30,
      y: backendNodeId === 11 ? 200 : 40,
      viewportWidth: 500,
      viewportHeight: 400,
    };
  };
  driver.evalNumber = async (expression) => expression === "window.innerWidth" ? 500 : 400;
  driver.runtimeHitTestTarget = async () => true;

  const prepared = await driver.prepareEmbeddingFrames(route);
  assert.deepEqual(order, ["scroll-11", "scroll-22", "geometry-11", "geometry-22"]);
  assert.equal(prepared.geometries[0].x, 100);
  driver.framedPointProof = {
    targetId: "nested", frameId: "nested-root", sessionId: "nested-session",
    point: { x: 140, y: 260 }, frames: prepared,
  };
  assert.equal(await driver.verifyFramedPoint(77, route, { x: 140, y: 260 }), true);
});

test("child actionability fails closed when embedding topology changes before dispatch", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.prepareEmbeddingFrames = async () => ({
    routes: [{ targetId: "main", sessionId: null, frameId: "child" }],
    geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
  });
  driver.scrollIntoView = async () => {};
  driver.evalNumber = async () => 1000;
  driver.localBoxFor = async () => ({ x: 10, y: 20, width: 20, height: 20 });
  driver.locallyActionable = async () => true;
  driver.localCandidatePoints = async () => [{ x: 10, y: 20 }];
  driver.embeddingTopologyMatches = () => false;

  assert.equal(await driver.actionablePoint(77, { targetId: "child", sessionId: "child-session", frameId: "child-root" }), null);
});

test("post-hover framed verification hit-tests the projected point through every owner", async () => {
  const driver = createNewtonBrowserDriver();
  const route = { targetId: "nested", sessionId: "nested-session", frameId: "nested-root" };
  const frames = {
    routes: [
      { targetId: "main", sessionId: null, frameId: "outer" },
      { targetId: "child", sessionId: "child-session", frameId: "inner" },
    ],
    geometries: [
      { x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 },
      { x: 30, y: 40, viewportWidth: 300, viewportHeight: 200 },
    ],
  };
  driver.framedPointProof = {
    targetId: "nested", frameId: "nested-root", sessionId: "nested-session",
    point: { x: 140, y: 260 }, frames,
  };
  driver.embeddingTopologyMatches = () => true;
  driver.frameOwnerBackendNodeId = async (owner) => owner.frameId === "outer" ? 11 : 22;
  driver.iframeOwnerGeometry = async (backendNodeId) => frames.geometries[backendNodeId === 11 ? 0 : 1];
  const hits = [];
  driver.runtimeHitTestTarget = async (backendNodeId, x, y, hitRoute) => {
    hits.push({ backendNodeId, x, y, route: hitRoute });
    return true;
  };

  assert.equal(await driver.verifyFramedPoint(77, route, { x: 140, y: 260 }), true);
  assert.deepEqual(hits.map((hit) => [hit.backendNodeId, hit.x, hit.y, hit.route.sessionId ?? null]), [
    [11, 140, 260, null],
    [22, 40, 60, "child-session"],
    [77, 10, 20, "nested-session"],
  ]);

  driver.runtimeHitTestTarget = async (backendNodeId) => backendNodeId !== 22;
  assert.equal(await driver.verifyFramedPoint(77, route, { x: 140, y: 260 }), false);
  assert.equal(driver.actionabilityFailure, "frame_owner_hit_failed");

  driver.runtimeHitTestTarget = async () => true;
  driver.iframeOwnerGeometry = async (backendNodeId) => backendNodeId === 11
    ? { ...frames.geometries[0], x: 101 }
    : frames.geometries[1];
  assert.equal(await driver.verifyFramedPoint(77, route, { x: 140, y: 260 }), false);
  assert.equal(driver.actionabilityFailure, "frame_owner_geometry_changed");

  driver.embeddingTopologyMatches = () => false;
  assert.equal(await driver.verifyFramedPoint(77, route, { x: 140, y: 260 }), false);
  assert.equal(driver.actionabilityFailure, "frame_topology_changed");
});

test("trusted child input uses the root debuggee while retaining timeout metadata", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };

  await driver.dispatchInput({ sessionId: "child-session", timeoutMs: 4321 }, (input) => input.pointerMove({ x: 10, y: 20 }));

  assert.equal(calls[0].method, "Input.dispatchMouseEvent");
  assert.deepEqual(calls[0].route, { timeoutMs: 4321 });

  calls.length = 0;
  await driver.dispatchInput({ targetId: "main", frameId: "same-process", timeoutMs: 1234 }, (input) => input.pointerMove({ x: 30, y: 40 }));
  assert.equal(calls[0].method, "Input.dispatchMouseEvent");
  assert.deepEqual(calls[0].route, { timeoutMs: 1234 });
});

test("a focused child node automatically receives trusted click input through its target session", async () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
  driver.targetRegistry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
  });
  const calls = [];
  driver.resolveTarget = async () => ({ targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 });
  driver.actionablePoint = async () => {
    driver.framedPointProof = {
      targetId: "child", sessionId: "child-session", frameId: "child-root", point: { x: 500, y: 300 },
      frames: {
        routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
        geometries: [{ x: 100, y: 100, viewportWidth: 800, viewportHeight: 600 }],
      },
    };
    return { x: 500, y: 300 };
  };
  driver.embeddingTopologyMatches = () => true;
  driver.verifyFramedPoint = async () => true;
  driver.locallyActionable = async () => { throw new Error("child click must not repeat the local hit test after root pointer movement"); };
  driver.pageSignature = async () => ({ url: "https://example.com", title: "Example" });
  driver.elementState = async () => ({});
  driver.settleShort = async () => {};
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
  driver.paintCursorClick = () => {};
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };

  await driver.click({ kind: "click", ref: "unused" });

  assert.equal(calls.find((call) => call.method === "DOM.focus")?.route?.sessionId, "child-session");
  const inputCalls = calls.filter((call) => call.method.startsWith("Input."));
  assert.equal(inputCalls.length, 3);
  assert.equal(inputCalls.every((call) => call.route?.sessionId === "child-session"), true);
  assert.deepEqual({ x: inputCalls[0].params.x, y: inputCalls[0].params.y }, { x: 400, y: 200 });
});

test("a same-process framed click skips root backend-id hit testing and dispatches root input", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.resolveTarget = async () => ({ targetId: "main", sessionId: null, frameId: "same-process", backendNodeId: 88 });
  driver.actionablePoint = async () => ({ x: 140, y: 260 });
  driver.verifyFramedPoint = async () => { calls.push({ method: "verify-framed-point" }); return true; };
  driver.hitTestTarget = async () => { throw new Error("framed backend ids must not be root-hit-tested"); };
  driver.pageSignature = async () => ({ url: "http://localhost:3000", title: "Example" });
  driver.elementState = async () => ({});
  driver.settleShort = async () => {};
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
  driver.paintCursorClick = () => {};
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };

  await driver.click({ kind: "click", ref: "unused" });

  const inputCalls = calls.filter((call) => call.method.startsWith("Input."));
  assert.equal(inputCalls.length, 3);
  assert.equal(inputCalls.every((call) => call.route?.frameId === undefined && call.route?.sessionId === undefined), true);
  assert.deepEqual(calls.filter((call) => call.method === "verify-framed-point" || call.method.startsWith("Input."))
    .map((call) => [call.method, call.params?.type ?? null]), [
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["verify-framed-point", null],
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"],
  ]);
});

test("session-backed framed click automatically dispatches one target-local stream after verification", async () => {
  const runCase = async ({ target, point, frames, expectedPoint }) => {
    const driver = createNewtonBrowserDriver();
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
    driver.targetRegistry.registerTarget({
      targetId: "child",
      type: "iframe",
      parentTargetId: "main",
      hostFrameId: "child-host",
      sessionId: "child-session",
    });
    if (target.targetId === "nested") {
      driver.targetRegistry.registerTarget({
        targetId: "nested",
        type: "iframe",
        parentTargetId: "child",
        hostFrameId: "nested-host",
        sessionId: "nested-session",
      });
    }
    const calls = [];
    driver.resolveTarget = async () => target;
    driver.actionablePoint = async () => {
      driver.framedPointProof = {
        targetId: target.targetId,
        frameId: target.frameId,
        sessionId: target.sessionId,
        point,
        frames,
      };
      return point;
    };
    driver.embeddingTopologyMatches = () => true;
    driver.verifyFramedPoint = async () => { calls.push({ method: "verify-framed-point" }); return true; };
    driver.pageSignature = async () => ({ url: "https://example.com", title: "Example" });
    driver.elementState = async () => ({});
    driver.settleShort = async () => {};
    driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
    driver.paintCursorClick = () => {};
    driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };

    await driver.click({ kind: "click", ref: "unused" });

    const ordered = calls.filter((call) => call.method === "verify-framed-point" || call.method.startsWith("Input."));
    assert.deepEqual(ordered.map((call) => [call.method, call.params?.type ?? null]), [
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["verify-framed-point", null],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
    const inputCalls = ordered.filter((call) => call.method.startsWith("Input."));
    assert.equal(inputCalls.every((call) => call.route?.sessionId === target.sessionId), true);
    assert.deepEqual({ x: inputCalls[0].params.x, y: inputCalls[0].params.y }, expectedPoint);
    assert.equal(inputCalls.some((call) => call.route?.sessionId === undefined), false);
  };

  await runCase({
    target: { targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 },
    point: { x: 140, y: 260 },
    frames: {
      routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
      geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
    },
    expectedPoint: { x: 40, y: 60 },
  });
  await runCase({
    target: { targetId: "nested", sessionId: "nested-session", frameId: "nested-same", backendNodeId: 88 },
    point: { x: 172, y: 304 },
    frames: {
      routes: [
        { targetId: "main", sessionId: null, frameId: "outer-same" },
        { targetId: "main", sessionId: null, frameId: "child-host" },
        { targetId: "child", sessionId: "child-session", frameId: "child-same" },
        { targetId: "child", sessionId: "child-session", frameId: "nested-host" },
        { targetId: "nested", sessionId: "nested-session", frameId: "nested-same" },
      ],
      geometries: [
        { x: 100, y: 200, viewportWidth: 800, viewportHeight: 600 },
        { x: 20, y: 30, viewportWidth: 600, viewportHeight: 500 },
        { x: 30, y: 40, viewportWidth: 500, viewportHeight: 400 },
        { x: 5, y: 6, viewportWidth: 300, viewportHeight: 200 },
        { x: 7, y: 8, viewportWidth: 200, viewportHeight: 100 },
      ],
    },
    expectedPoint: { x: 17, y: 28 },
  });
});

test("automatic target-session click fails closed without a unique live child session or point", async () => {
  const runBlocked = async ({ target, topologyMatches, point = { x: 140, y: 260 } }) => {
    const driver = createNewtonBrowserDriver();
    if (target.sessionId) {
      driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
      driver.targetRegistry.registerTarget({
        targetId: target.targetId,
        type: "iframe",
        parentTargetId: "main",
        hostFrameId: "child-host",
        sessionId: target.sessionId,
      });
    }
    const calls = [];
    const frames = {
      routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
      geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
    };
    driver.resolveTarget = async () => target;
    driver.actionablePoint = async () => {
      driver.framedPointProof = {
        targetId: target.targetId, frameId: target.frameId, sessionId: target.sessionId ?? null, point, frames,
      };
      return point;
    };
    driver.embeddingTopologyMatches = () => topologyMatches;
    driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };
    driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date(0).toISOString() });

    const result = await driver.click({ kind: "click", ref: "unused" });
    assert.equal(result.status, "stale_target");
    assert.equal(calls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type !== "mouseMoved"), false);
    assert.equal(calls.some((call) => call.method.startsWith("Input.")), false);
  };

  await runBlocked({ target: { targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 }, topologyMatches: false });
  await runBlocked({
    target: { targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 },
    topologyMatches: true,
    point: { x: 700, y: 260 },
  });
});

test("target-main viewport point uses the rounded proof and exact ancestor prefix", () => {
  const calculate = ({ targetId = "child", sessionId = "child-session", frameId = "target-frame", point, routes, geometries }) => {
    const driver = createNewtonBrowserDriver();
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
    driver.targetRegistry.registerTarget({
      targetId,
      type: "iframe",
      parentTargetId: "main",
      hostFrameId: "target-host",
      sessionId,
    });
    driver.embeddingTopologyMatches = () => true;
    driver.framedPointProof = {
      targetId, sessionId, frameId, point,
      frames: { routes, geometries },
    };
    return driver.targetMainViewportPoint({ targetId, sessionId, frameId }, point);
  };

  assert.deepEqual(calculate({
    point: { x: 140, y: 260 },
    routes: [{ targetId: "main", sessionId: null, frameId: "target-host" }],
    geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
  }), { x: 40, y: 60 });

  assert.deepEqual(calculate({
    targetId: "deep", sessionId: "deep-session", point: { x: 172, y: 304 },
    routes: [
      { targetId: "main", sessionId: null, frameId: "outer" },
      { targetId: "middle", sessionId: "middle-session", frameId: "deep-host" },
    ],
    geometries: [
      { x: 100, y: 200, viewportWidth: 800, viewportHeight: 600 },
      { x: 30, y: 40, viewportWidth: 300, viewportHeight: 200 },
    ],
  }), { x: 42, y: 64 });

  assert.deepEqual(calculate({
    targetId: "deep", sessionId: "deep-session", point: { x: 172, y: 304 },
    routes: [
      { targetId: "main", sessionId: null, frameId: "outer" },
      { targetId: "middle", sessionId: "middle-session", frameId: "deep-host" },
      { targetId: "deep", sessionId: "deep-session", frameId: "same-one" },
      { targetId: "deep", sessionId: "deep-session", frameId: "same-two" },
    ],
    geometries: [
      { x: 100, y: 200, viewportWidth: 800, viewportHeight: 600 },
      { x: 30, y: 40, viewportWidth: 300, viewportHeight: 200 },
      { x: 7, y: 8, viewportWidth: 200, viewportHeight: 100 },
      { x: 3, y: 4, viewportWidth: 100, viewportHeight: 50 },
    ],
  }), { x: 42, y: 64 });

  assert.deepEqual(calculate({
    point: { x: 141, y: 261 },
    routes: [{ targetId: "main", sessionId: null, frameId: "target-host" }],
    geometries: [{ x: 100.25, y: 200.75, viewportWidth: 500.5, viewportHeight: 400.5 }],
  }), { x: 40.75, y: 60.25 });
});

test("target-main viewport point rejects session, proof, topology, and suffix ambiguity", () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
  driver.targetRegistry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
  });
  const point = { x: 140, y: 260 };
  const geometry = { x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 };
  const setProof = (routes, patch = {}) => {
    driver.embeddingTopologyMatches = () => patch.topologyMatches ?? true;
    driver.framedPointProof = {
      targetId: "child", sessionId: "child-session", frameId: "child-frame", point,
      frames: { routes, geometries: routes.map(() => geometry) },
      ...patch.proof,
    };
  };
  const route = { targetId: "child", sessionId: "child-session", frameId: "child-frame" };

  setProof([{ targetId: "main", sessionId: null, frameId: "child-host" }]);
  assert.equal(driver.targetMainViewportPoint({ ...route, sessionId: null }, point), null);
  assert.equal(driver.targetMainViewportPoint({ ...route, sessionId: "missing-session" }, point), null);
  assert.equal(driver.targetMainViewportPoint(route, { x: 141, y: 260 }), null);

  setProof([{ targetId: "main", sessionId: null, frameId: "child-host" }], { proof: { frameId: "other-frame" } });
  assert.equal(driver.targetMainViewportPoint(route, point), null);
  setProof([{ targetId: "main", sessionId: null, frameId: "child-host" }], { topologyMatches: false });
  assert.equal(driver.targetMainViewportPoint(route, point), null);
  setProof([
    { targetId: "main", sessionId: null, frameId: "child-host" },
    { targetId: "child", sessionId: "child-session", frameId: "same-one" },
    { targetId: "main", sessionId: null, frameId: "ambiguous-return" },
  ]);
  assert.equal(driver.targetMainViewportPoint(route, point), null);
  setProof([{ targetId: "main", sessionId: null, frameId: "child-host" }], { proof: { point: { x: 140.5, y: 260 } } });
  assert.equal(driver.targetMainViewportPoint(route, { x: 140.5, y: 260 }), null);
});

test("automatic target-session click handles detach by exact dispatch phase and balances post-down cleanup", async () => {
  const runCase = async (failureType) => {
    const driver = createNewtonBrowserDriver();
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
    driver.targetRegistry.registerTarget({
      targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
    });
    const target = { targetId: "child", sessionId: "child-session", frameId: "child-frame", backendNodeId: 77 };
    const point = { x: 140, y: 260 };
    const frames = {
      routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
      geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
    };
    const inputTypes = [];
    let releaseAttempts = 0;
    driver.resolveTarget = async () => target;
    driver.actionablePoint = async () => {
      driver.framedPointProof = { targetId: "child", sessionId: "child-session", frameId: "child-frame", point, frames };
      return point;
    };
    driver.embeddingTopologyMatches = () => true;
    driver.verifyFramedPoint = async () => {
      if (failureType === "after-move") {
        driver.targetRegistry.detachTarget("child", "child-session");
        driver.actionabilityFailure = "frame_topology_changed";
        return false;
      }
      return true;
    };
    driver.paintCursorClick = () => {};
    driver.pageSignature = async () => ({ url: "https://example.com", title: "Example" });
    driver.elementState = async () => ({});
    driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date(0).toISOString() });
    driver.cdp = async (method, params) => {
      if (method !== "Input.dispatchMouseEvent") return {};
      inputTypes.push(params.type);
      if (failureType === "before-move" && params.type === "mouseMoved") throw new Error("No session with given id");
      if (failureType === "after-down" && params.type === "mouseReleased" && releaseAttempts++ === 0) throw new Error("No session with given id");
      return {};
    };

    const result = await driver.click({ kind: "click", ref: "unused" });
    await driver.inputDispatcher.whenIdle();
    return { inputTypes, result };
  };

  const beforeMove = await runCase("before-move");
  assert.deepEqual(beforeMove.inputTypes, ["mouseMoved"]);
  assert.equal(beforeMove.result.status, "stale_target");
  const afterMove = await runCase("after-move");
  assert.deepEqual(afterMove.inputTypes, ["mouseMoved"]);
  assert.equal(afterMove.result.status, "stale_target");
  const afterDown = await runCase("after-down");
  assert.deepEqual(afterDown.inputTypes, ["mouseMoved", "mousePressed", "mouseReleased", "mouseReleased"]);
  assert.equal(afterDown.result.status, "dispatched_unverified");
  assert.equal(afterDown.result.reason, "input_dispatch_uncertain");
});

test("owned root click reports a missing release acknowledgement once after causal verification", async () => {
  const driver = createNewtonBrowserDriver();
  const inputCalls = [];
  let signatures = 0;
  let waitForInput = null;
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.hitTestTarget = async () => true;
  driver.pageSignature = async () => signatures++ === 0
    ? { url: "https://example.com/page", title: "Before" }
    : { url: "https://example.com/page", title: "After" };
  driver.elementState = async () => ({});
  driver.settleShort = async () => {};
  driver.waitForCondition = async (waitFor, timeoutMs) => {
    waitForInput = { waitFor, timeoutMs };
    return { matched: true };
  };
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
  driver.cdp = async (method, params, route) => {
    if (method !== "Input.dispatchMouseEvent") return {};
    inputCalls.push({ type: params.type, route });
    if (params.type === "mouseReleased") {
      throw Object.assign(new Error("renderer_unresponsive"), {
        code: "renderer_unresponsive",
        detail: "cdp_timeout_Input.dispatchMouseEvent",
      });
    }
    return {};
  };

  const result = await driver.click({
    kind: "click",
    selector: "#popup",
    waitFor: { text: "popup-opened" },
    timeoutMs: 4_000,
  });
  await driver.inputDispatcher.whenIdle();

  assert.deepEqual(inputCalls.map((call) => call.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(inputCalls.every((call) => call.route?.timeoutMs === 2_000), true);
  assert.deepEqual(waitForInput, { waitFor: { text: "popup-opened" }, timeoutMs: 4_000 });
  assert.equal(result.status, "dispatched_unverified");
  assert.equal(result.reason, "input_release_unacknowledged");
  assert.equal(result.changed.inputReleaseAcknowledgement, "unacknowledged");
  assert.equal(result.changed.waitedFor, true);
});

test("automatic target-session click keeps root and child dialogs session scoped", async () => {
  const makeDriver = () => {
    const driver = createNewtonBrowserDriver();
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
    driver.targetRegistry.registerTarget({
      targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
    });
    const point = { x: 140, y: 260 };
    driver.resolveTarget = async () => ({ targetId: "child", sessionId: "child-session", frameId: "child-frame", backendNodeId: 77 });
    driver.actionablePoint = async () => {
      driver.framedPointProof = {
        targetId: "child", sessionId: "child-session", frameId: "child-frame", point,
        frames: {
          routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
          geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
        },
      };
      return point;
    };
    driver.embeddingTopologyMatches = () => true;
    driver.verifyFramedPoint = async () => true;
    driver.paintCursorClick = () => {};
    driver.pageSignature = async () => ({ url: "https://example.com", title: "Example" });
    driver.elementState = async () => ({});
    driver.settleShort = async () => {};
    driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
    return driver;
  };

  const rootDialog = makeDriver();
  const rootCalls = [];
  rootDialog.dialogTracker.open("root", { type: "alert", message: "root" });
  rootDialog.cdp = async (method, params, route) => { rootCalls.push({ method, params, route }); return {}; };
  await rootDialog.click({ kind: "click", ref: "unused" });
  assert.equal(rootCalls.filter((call) => call.method.startsWith("Input.")).length, 3);

  const childDialog = makeDriver();
  const childCalls = [];
  childDialog.recordDebuggerEvent(
    { sessionId: "child-session" },
    "Page.javascriptDialogOpening",
    { type: "alert", message: "child" },
  );
  childDialog.cdp = async (method, params, route) => { childCalls.push({ method, params, route }); return {}; };
  await assert.rejects(
    childDialog.click({ kind: "click", ref: "unused" }),
    (error) => error?.code === "dialog_blocked",
  );
  assert.equal(childCalls.some((call) => call.method.startsWith("Input.")), false);
});

test("driver rejects ambiguous accessible-name and selector targets", async () => {
  const accessible = createNewtonBrowserDriver();
  accessible.observe = async () => ({
    nodes: [
      { ref: "e1", role: "button", name: "Duplicate target" },
      { ref: "e2", role: "button", name: "Duplicate target" },
    ],
  });
  await assert.rejects(
    accessible.resolveTarget({ kind: "click", role: "button", name: "Duplicate target", exact: true }),
    /ambiguous/,
  );

  const selector = createNewtonBrowserDriver();
  selector.cdp = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [2, 3] };
    return {};
  };
  await assert.rejects(selector.resolveTarget({ kind: "click", selector: ".duplicate" }), /ambiguous/);
});

test("driver reports target_moved when an attached target never stabilizes", async () => {
  const driver = createNewtonBrowserDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7 });
  driver.actionablePoint = async () => null;
  driver.cdp = async () => ({});
  driver.observe = async () => ({ kind: "observation", nodes: [], nodeCount: 0, capturedAt: "2026-07-10T00:00:00.000Z" });

  const result = await driver.click({ kind: "click", ref: "e7" });
  assert.equal(result.status, "stale_target");
  assert.equal(result.reason, "target_moved");
});

test("driver observes same-origin iframe AX trees and excludes cross-origin frames", async () => {
  const driver = createNewtonBrowserDriver();
  primeObservationDriver(driver);
  const requestedFrames = [];
  driver.evalString = async (expression) => {
    if (expression === "location.href") return "https://example.com/page";
    if (expression === "document.title") return "Frame fixture";
    return "";
  };
  driver.evalNumber = async () => 0;
  driver.cdp = async (method, params) => {
    if (method === "Page.getFrameTree") return {
      frameTree: {
        frame: { id: "main", url: "https://example.com/page" },
        childFrames: [
          { frame: { id: "same", url: "https://example.com/frame.html" } },
          { frame: { id: "cross", url: "https://other.example/frame.html" } },
        ],
      },
    };
    if (method === "Accessibility.getFullAXTree") {
      requestedFrames.push(params?.frameId ?? "main");
      if (params?.frameId === "same") return { nodes: [axNode(202, "button", "Same-origin frame button")] };
      if (params?.frameId === "cross") return { nodes: [axNode(303, "button", "Cross-origin denied target")] };
      return { nodes: [axNode(101, "button", "Main button")] };
    }
    return {};
  };
  driver.boxFor = async (backendNodeId) => ({ x: backendNodeId, y: 10, width: 80, height: 20 });

  const observation = await driver.observe({ maxNodes: 10 });

  assert.deepEqual(requestedFrames, ["main", "same"]);
  assert.deepEqual(observation.nodes.map((node) => node.name), ["Main button", "Same-origin frame button"]);
  assert.match(observation.nodes[1].ref, /^d1:f\d+:e202$/);
  assert.deepEqual(observation.excludedFrames, [{ frameId: "cross", frameOrigin: "https://other.example", reason: "origin_not_granted" }]);
});

test("parent frame-tree snapshots keep opaque child origins unknown and exclude them fail-closed", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  const requestedFrames = [];
  driver.cdp = async (method, params) => {
    if (method === "Page.getFrameTree") return {
      frameTree: {
        frame: { id: "main-frame", url: "https://example.com/page" },
        childFrames: [{
          frame: {
            id: "opaque-frame",
            parentId: "main-frame",
            url: "about:blank",
            securityOrigin: "https://example.com",
          },
        }],
      },
    };
    if (method === "Accessibility.getFullAXTree") requestedFrames.push(params?.frameId ?? "main");
    return { nodes: [] };
  };

  const result = await driver.accessibilityTreesForOrigin("https://example.com");

  assert.deepEqual(requestedFrames, ["main"]);
  assert.deepEqual(result.excludedFrames, [{
    frameId: "opaque-frame",
    frameOrigin: null,
    reason: "origin_not_granted",
  }]);
  assert.equal(driver.targetRegistry.frames.get("opaque-frame")?.origin, "");
});

test("snapshot-first top-level loader identity preserves refs across a late same-loader event", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  const beforeSnapshot = driver.targetRegistry.createRef("main-target", 1);

  driver.reconcileFrameTree({
    frame: { id: "main-frame", loaderId: "loader-a", url: "https://example.com/page" },
  }, "https://example.com");
  assert.throws(() => driver.targetRegistry.resolveRef(beforeSnapshot), (error) => error?.code === "stale_target");
  driver.targetRegistry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main-target",
    hostFrameId: "oopif",
    sessionId: "child-session",
    origin: "https://child.test",
  });
  driver.targetRegistry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", origin: "https://child.test" });
  const ref = driver.targetRegistry.createRef("oopif", 2, { frameId: "oopif" });
  const epoch = driver.targetRegistry.documentEpoch;

  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", loaderId: "loader-a", url: "https://example.com/page" },
  });

  assert.equal(driver.targetRegistry.documentEpoch, epoch);
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "child-session");
});

test("event-first top-level loader identity is not recommitted by a same-loader snapshot", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", loaderId: "loader-a", url: "https://example.com/page" },
  });
  driver.targetRegistry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main-target",
    hostFrameId: "oopif",
    sessionId: "child-session",
    origin: "https://child.test",
  });
  driver.targetRegistry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", origin: "https://child.test" });
  const ref = driver.targetRegistry.createRef("oopif", 2, { frameId: "oopif" });
  const epoch = driver.targetRegistry.documentEpoch;

  driver.reconcileFrameTree({
    frame: { id: "main-frame", loaderId: "loader-a", url: "https://example.com/page" },
  }, "https://example.com");

  assert.equal(driver.targetRegistry.documentEpoch, epoch);
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "child-session");
});

test("a genuinely new top-level loader advances once and permanently stales old refs", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", loaderId: "loader-a", url: "https://example.com/page" },
  });
  const ref = driver.targetRegistry.createRef("main-target", 1);
  const epoch = driver.targetRegistry.documentEpoch;

  driver.reconcileFrameTree({
    frame: { id: "main-frame", loaderId: "loader-b", url: "https://example.com/next" },
  }, "https://example.com");
  assert.equal(driver.targetRegistry.documentEpoch, epoch + 1);
  assert.throws(() => driver.targetRegistry.resolveRef(ref), (error) => error?.code === "stale_target");
  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", loaderId: "loader-b", url: "https://example.com/next" },
  });
  assert.equal(driver.targetRegistry.documentEpoch, epoch + 1);
  assert.throws(() => driver.targetRegistry.resolveRef(ref), (error) => error?.code === "stale_target");
});

test("missing loader identity preserves snapshot behavior and keeps navigation events fail-safe", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  const ref = driver.targetRegistry.createRef("main-target", 1);
  const epoch = driver.targetRegistry.documentEpoch;

  driver.reconcileFrameTree({
    frame: { id: "main-frame", url: "https://example.com/page" },
  }, "https://example.com");
  assert.equal(driver.targetRegistry.documentEpoch, epoch);
  assert.equal(driver.targetRegistry.resolveRef(ref).targetId, "main-target");

  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", url: "https://example.com/page" },
  });
  assert.equal(driver.targetRegistry.documentEpoch, epoch + 1);
  assert.throws(() => driver.targetRegistry.resolveRef(ref), (error) => error?.code === "stale_target");
});

test("driver enriches AX state and same-origin DOM facts without mutating the page", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeObservationDriver(driver);
  const calls = [];
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/form" : expression === "document.title" ? "Form" : "";
  driver.evalNumber = async () => 0;
  driver.boxFor = async (backendNodeId) => ({ x: backendNodeId, y: 1, width: 20, height: 10 });
  driver.cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/form" } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { ...axNode(201, "checkbox", "Terms"), properties: [{ name: "checked", value: { value: "mixed" } }, { name: "required", value: { value: true } }] },
      axNode(202, "link", "Account"),
      { ...axNode(203, "heading", "Details"), properties: [{ name: "level", value: { value: 2 } }] },
      axNode(204, "link", "External"),
    ] };
    if (method === "DOM.describeNode") {
      const facts = {
        201: { localName: "input", attributes: ["type", "checkbox"] },
        202: { localName: "a", attributes: ["href", "/account?token=secret#profile"] },
        203: { localName: "h2", attributes: [] },
        204: { localName: "a", attributes: ["href", "https://outside.test/path"] },
      };
      return { node: facts[params.backendNodeId] };
    }
    return {};
  };

  const observation = await driver.observe({ roles: ["checkbox", "link", "heading"] });
  assert.deepEqual(observation.nodes.map((node) => node.role), ["checkbox", "link", "heading", "link"]);
  assert.equal(observation.nodes[0].checked, "mixed");
  assert.equal(observation.nodes[0].required, true);
  assert.equal(observation.nodes[0].elementType, "input:checkbox");
  assert.equal(observation.nodes[1].href, "https://example.com/account");
  assert.equal(observation.nodes[2].level, 2);
  assert.equal(observation.nodes[3].href, undefined);
  assert.equal(calls.some((call) => /setAttribute|removeAttribute|Runtime\.evaluate/.test(call.method)), false);
});

test("optional interactive discovery recovers an AX-missing control with zero DOM writes", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeObservationDriver(driver);
  const calls = [];
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/app" : expression === "document.title" ? "App" : "";
  driver.evalNumber = async () => 0;
  driver.boxFor = async () => ({ x: 1, y: 2, width: 30, height: 12 });
  driver.axNameFor = async () => "Custom action";
  driver.elementFacts = async () => ({ role: "button", accessibleName: "Custom action", disabled: false });
  driver.cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/app" } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [9] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 209, localName: "button", attributes: ["tabindex", "0"] } };
    return {};
  };

  const observation = await driver.observe({ includeInteractive: true });
  assert.equal(observation.nodes.length, 1);
  assert.equal(observation.nodes[0].role, "button");
  assert.equal(observation.nodes[0].name, "Custom action");
  assert.equal(calls.some((call) => /setAttribute|removeAttribute|Runtime\.evaluate/.test(call.method)), false);
});

test("diff observation reports state-only AX changes", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  primeObservationDriver(driver);
  let checked = false;
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/form" : expression === "document.title" ? "Form" : "";
  driver.evalNumber = async () => 0;
  driver.describedNodeFactsCached = async () => ({ localName: "input", attributes: { type: "checkbox" } });
  driver.boxFor = async () => ({ x: 1, y: 1, width: 20, height: 20 });
  driver.cdp = async (method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/form" } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [{
      ...axNode(301, "checkbox", "Remember me"),
      properties: [{ name: "checked", value: { value: checked } }],
    }] };
    return {};
  };

  await driver.observe({ mode: "full" });
  checked = true;
  const delta = await driver.observe({ mode: "diff" });
  assert.equal(delta.kind, "observation_delta");
  assert.equal(delta.updated[0].ref, "d1:e301");
  assert.equal(delta.updated[0].checked, true);
});

test("driver selector preflight reports invalid syntax without dispatching input", async () => {
  const driver = createNewtonBrowserDriver();
  let inputDispatched = false;
  driver.cdp = async (method) => {
    if (method === "Runtime.evaluate") return {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "SyntaxError: Failed to execute 'querySelector': ']' is not a valid selector" },
      },
    };
    if (method.startsWith("Input.")) inputDispatched = true;
    return {};
  };
  await assert.rejects(
    driver.validateSelector("]"),
    (error) => error.code === "invalid_selector",
  );
  assert.equal(inputDispatched, false);
});

test("driver preflights wait selectors before entering the wait loop", async () => {
  const driver = createNewtonBrowserDriver();
  driver.containment = { contains: () => true };
  driver.containmentReady = true;
  let calls = 0;
  driver.cdp = async (method) => {
    calls += 1;
    if (method === "Runtime.evaluate") return {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "SyntaxError: invalid selector" },
      },
    };
    return {};
  };
  await assert.rejects(
    driver.preflightAction({ kind: "wait_for", waitFor: { selector: "]" } }),
    (error) => error.code === "invalid_selector",
  );
  assert.equal(calls, 1);
});

test("driver observes and resolves a granted OOPIF through its exact flattened session", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  const calls = [];
  driver.cdp = async (method, params, route) => {
    calls.push({ method, params, route });
    if (method === "Target.setAutoAttach") return {};
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/page" } } };
    if (method === "Accessibility.getFullAXTree") {
      return route?.sessionId === "child-session" ? { nodes: [axNode(77, "button", "Child action")] } : { nodes: [] };
    }
    if (method === "DOM.describeNode") return { node: {} };
    if (method === "DOM.getContentQuads") return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
    return {};
  };
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "child-session",
    targetInfo: { targetId: "child-target", type: "iframe", url: "https://child.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Page.frameNavigated", {
    frame: { id: "child-root", url: "https://child.test/frame" },
  });
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/page" : "Example";
  driver.evalNumber = async () => 0;
  driver.fileInputObservationNodes = async () => [];

  const observation = await driver.observe({});
  const ref = observation.nodes[0].ref;
  assert.match(ref, /^d1:f\d+:e77$/);
  assert.equal((await driver.resolveTarget({ kind: "click", ref })).sessionId, "child-session");
  assert.equal(calls.some((call) => call.method === "Accessibility.getFullAXTree" && call.route?.sessionId === "child-session"), true);
  assert.equal(calls.some((call) => call.method === "DOM.getContentQuads" && call.route?.sessionId === "child-session"), true);
});

test("driver treats the embedding frame as an OOPIF target boundary, not a local parent", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  driver.targetRegistry.registerFrame({ frameId: "host-frame", targetId: "main-target", origin: "https://child.test" });
  driver.cdp = async () => ({});

  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "child-session",
    targetInfo: {
      targetId: "child-target",
      type: "iframe",
      url: "https://child.test/frame",
    },
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Page.frameNavigated", {
    frame: { id: "child-root", parentId: "host-frame", url: "https://child.test/frame" },
  });

  const ref = driver.targetRegistry.createRef("child-target", 77, { frameId: "child-root" });
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "child-session");
  assert.equal(driver.targetRegistry.frames.get("child-root").parentFrameId, null);
});

test("driver reconciles Chromium's same-identity parent-first OOPIF event order", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  driver.cdp = async () => ({});

  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "main-frame", url: "https://example.com" },
  });
  await driver.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "main-frame", url: "https://child.test/frame" },
  });
  const oldRef = driver.targetRegistry.createRef("main-target", 7, { frameId: "oopif" });
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "child-session",
    targetInfo: { targetId: "oopif", type: "iframe", url: "https://child.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "oopif", url: "https://child.test/frame" },
  });

  assert.throws(() => driver.targetRegistry.resolveRef(oldRef), (error) => error?.code === "frame_detached");
  const ref = driver.targetRegistry.createRef("oopif", 7, { frameId: "oopif" });
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "child-session");
  assert.equal(driver.targetRegistry.frames.get("oopif").parentFrameId, null);
});

test("driver preserves same-identity OOPIF swap fencing across target detach and reattach", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  driver.cdp = async () => ({});

  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "old-session",
    targetInfo: { targetId: "oopif", type: "iframe", url: "https://child.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "oopif", url: "https://child.test/frame" },
  });
  const oldRef = driver.targetRegistry.createRef("oopif", 9, { frameId: "oopif" });

  await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameDetached", { frameId: "oopif", reason: "swap" });
  await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", { targetId: "oopif", sessionId: "old-session" });
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "new-session",
    targetInfo: { targetId: "oopif", type: "iframe", url: "https://child.test/frame-next" },
  });
  await driver.recordDebuggerEvent({ sessionId: "new-session" }, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "oopif", url: "https://child.test/frame-next" },
  });

  assert.throws(() => driver.targetRegistry.resolveRef(oldRef), (error) => error?.code === "frame_detached");
  const ref = driver.targetRegistry.createRef("oopif", 9, { frameId: "oopif" });
  assert.notEqual(ref, oldRef);
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "new-session");
});

test("parent frame-tree snapshots do not re-register a child-owned OOPIF while it is swapping", () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
  driver.mainTargetId = "main-target";
  driver.mainFrameId = "main-frame";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  driver.targetRegistry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main-target",
    hostFrameId: "oopif",
    sessionId: "old-session",
    origin: "https://child.test",
  });
  driver.targetRegistry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "oopif",
    backendNodeId: 1,
    origin: "https://child.test",
  });
  const parentSnapshot = {
    frame: { id: "main-frame", url: "https://example.com" },
    childFrames: [{
      frame: { id: "oopif", parentId: "main-frame", url: "https://child.test/frame" },
      childFrames: [{
        frame: { id: "nested-snapshot", parentId: "oopif", url: "https://child.test/nested" },
      }],
    }],
  };
  assert.doesNotThrow(() => driver.reconcileFrameTree(parentSnapshot, "https://example.com"));
  assert.equal(driver.targetRegistry.listObservationRoutes().find((route) => route.frameId === "oopif")?.targetId, "oopif");
  assert.equal(driver.targetRegistry.frameIdentity("nested-snapshot"), null);
  const oldRef = driver.targetRegistry.createRef("oopif", 2, { frameId: "oopif" });
  driver.targetRegistry.beginFrameSwap("oopif", "oopif");

  assert.doesNotThrow(() => driver.reconcileFrameTree(parentSnapshot, "https://example.com"));
  assert.throws(() => driver.targetRegistry.resolveRef(oldRef), (error) => error?.code === "frame_detached");
  assert.deepEqual(driver.targetRegistry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 1 });
});

test("driver ignores a stale old-session detach before or after the replacement frame commits", async () => {
  for (const detachAfterFrame of [false, true]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://child.test"] });
    driver.mainTargetId = "main-target";
    driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
    driver.targetRegistry.commitTopLevelDocument("main-target");
    driver.cdp = async () => ({});
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "old-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://child.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://child.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameDetached", {
      frameId: "oopif",
      reason: "swap",
    });
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "new-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://child.test/frame-next" },
    });
    if (!detachAfterFrame) {
      await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", {
        targetId: "oopif",
        sessionId: "old-session",
      });
    }
    await driver.recordDebuggerEvent({ sessionId: "new-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://child.test/frame-next" },
    });
    if (detachAfterFrame) {
      await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", {
        targetId: "oopif",
        sessionId: "old-session",
      });
    }

    const ref = driver.targetRegistry.createRef("oopif", 10, { frameId: "oopif" });
    assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "new-session");
  }
});

test("driver keeps containment authoritative across exact cross-origin OOPIF swap reattachment", async () => {
  for (const granted of [true, false]) {
    const driver = createNewtonBrowserDriver({
      allowedOrigins: granted
        ? ["https://example.com", "https://old.test", "https://new.test"]
        : ["https://example.com", "https://old.test"],
    });
    driver.mainTargetId = "main-target";
    driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
    driver.targetRegistry.commitTopLevelDocument("main-target");
    driver.cdp = async () => ({});
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "old-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://old.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://old.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameDetached", {
      frameId: "oopif",
      reason: "swap",
    });
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "new-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://new.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "new-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://new.test/frame" },
    });

    const route = driver.targetRegistry.listObservationRoutes().find((candidate) => candidate.frameId === "oopif");
    assert.equal(route.origin, "https://new.test");
    assert.equal(driver.heldTargets.has("oopif"), !granted);
  }
});

test("a delayed old detach preserves the new ungranted replacement hold in both frame orders", async () => {
  for (const detachAfterFrame of [false, true]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    driver.mainTargetId = "main-target";
    driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
    driver.targetRegistry.commitTopLevelDocument("main-target");
    driver.cdp = async () => ({});
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "old-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://old-denied.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://old-denied.test/frame" },
    });
    await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameDetached", {
      frameId: "oopif",
      reason: "swap",
    });
    await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
      sessionId: "new-session",
      targetInfo: { targetId: "oopif", type: "iframe", url: "https://new-denied.test/frame" },
    });
    assert.equal(driver.heldTargets.get("oopif")?.sessionId, "new-session");
    if (!detachAfterFrame) {
      await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", {
        targetId: "oopif",
        sessionId: "old-session",
      });
    }
    await driver.recordDebuggerEvent({ sessionId: "new-session" }, "Page.frameNavigated", {
      frame: { id: "oopif", parentId: "oopif", url: "https://new-denied.test/frame" },
    });
    if (detachAfterFrame) {
      await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", {
        targetId: "oopif",
        sessionId: "old-session",
      });
    }

    assert.equal(driver.heldTargets.get("oopif")?.sessionId, "new-session");
    assert.equal(driver.targetRegistry.targetForSession("new-session")?.targetId, "oopif");
  }
});

test("a granted replacement clears a stale same-ID ungranted hold", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com", "https://new.test"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  driver.cdp = async () => ({});
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "old-session",
    targetInfo: { targetId: "oopif", type: "iframe", url: "https://old-denied.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "oopif", url: "https://old-denied.test/frame" },
  });
  assert.equal(driver.heldTargets.get("oopif")?.sessionId, "old-session");
  await driver.recordDebuggerEvent({ sessionId: "old-session" }, "Page.frameDetached", {
    frameId: "oopif",
    reason: "swap",
  });
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "new-session",
    targetInfo: { targetId: "oopif", type: "iframe", url: "https://new.test/frame" },
  });
  assert.equal(driver.heldTargets.has("oopif"), false);
  await driver.recordDebuggerEvent({}, "Target.detachedFromTarget", {
    targetId: "oopif",
    sessionId: "old-session",
  });
  await driver.recordDebuggerEvent({ sessionId: "new-session" }, "Page.frameNavigated", {
    frame: { id: "oopif", parentId: "oopif", url: "https://new.test/frame" },
  });

  assert.equal(driver.heldTargets.has("oopif"), false);
  const ref = driver.targetRegistry.createRef("oopif", 10, { frameId: "oopif" });
  assert.equal(driver.targetRegistry.resolveRef(ref).sessionId, "new-session");
});

test("driver does not read an ungranted OOPIF and reports bounded exclusion metadata", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.mainTargetId = "main-target";
  driver.targetRegistry.registerTarget({ targetId: "main-target", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main-target");
  let childReads = 0;
  driver.cdp = async (method, _params, route) => {
    if (method === "Target.setAutoAttach") return {};
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://example.com/page" } } };
    if (method === "Accessibility.getFullAXTree") {
      if (route?.sessionId === "child-session") childReads += 1;
      return { nodes: [] };
    }
    return {};
  };
  await driver.recordDebuggerEvent({}, "Target.attachedToTarget", {
    sessionId: "child-session",
    targetInfo: { targetId: "child-target", type: "iframe", url: "https://denied.test/frame" },
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Page.frameNavigated", {
    frame: { id: "child-root", url: "https://denied.test/frame" },
  });
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/page" : "Example";
  driver.evalNumber = async () => 0;
  driver.fileInputObservationNodes = async () => [];

  const observation = await driver.observe({});
  assert.equal(childReads, 0);
  assert.deepEqual(observation.excludedFrames, [{ frameId: "child-root", frameOrigin: "https://denied.test", reason: "origin_not_granted" }]);
});

test("driver routes a composite-ref fill through the recorded child session", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main");
  driver.targetRegistry.registerTarget({ targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "host", sessionId: "child-session", origin: "https://child.test" });
  driver.targetRegistry.registerFrame({ frameId: "root", targetId: "child", origin: "https://child.test" });
  const ref = driver.targetRegistry.createRef("child", 77, { frameId: "root" });
  const routed = [];
  driver.actionablePoint = async (_backendNodeId, route) => {
    routed.push(route);
    const point = { x: 10, y: 10 };
    driver.framedPointProof = {
      targetId: "child", sessionId: "child-session", frameId: "root", point,
      frames: {
        routes: [{ targetId: "main", sessionId: null, frameId: "host" }],
        geometries: [{ x: 0, y: 0, viewportWidth: 100, viewportHeight: 100 }],
      },
    };
    return point;
  };
  driver.embeddingTopologyMatches = () => true;
  driver.verifyFramedPoint = async () => true;
  driver.elementState = async (_backendNodeId, route) => { routed.push(route); return {}; };
  driver.pressMouse = async (_point, route) => { routed.push(route); };
  driver.releaseMouse = async (_point, route) => { routed.push(route); };
  driver.paintCursorField = () => {};
  driver.cdp = async (_method, _params, route) => { routed.push(route); return {}; };
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });

  await driver.fill({ kind: "fill", ref, value: "hello" });
  assert.equal(routed.length > 5, true);
  assert.equal(routed.some((route) => route?.sessionId === "child-session"), true);
  assert.equal(routed.some((route) => route?.sessionId === undefined), false);
});

test("framed fill verifies after pointer movement and aborts all post-failure input", async () => {
  const observation = { kind: "observation", mode: "cdp", origin: "https://example.com", title: "", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date(0).toISOString() };
  const createFillDriver = () => {
    const driver = createNewtonBrowserDriver();
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
    driver.targetRegistry.registerTarget({
      targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
    });
    driver.resolveTarget = async () => ({ targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 });
    driver.actionablePoint = async () => {
      const point = { x: 140, y: 260 };
      driver.framedPointProof = {
        targetId: "child", sessionId: "child-session", frameId: "child-root", point,
        frames: {
          routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
          geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
        },
      };
      return point;
    };
    driver.embeddingTopologyMatches = () => true;
    driver.elementState = async () => ({});
    driver.paintCursorField = () => {};
    driver.observeDelta = async () => ({ kind: "observation_delta", mode: "cdp", origin: "https://example.com", title: "", added: [], removed: [], updated: [], nodeCount: 0, capturedAt: new Date(0).toISOString() });
    driver.observe = async () => observation;
    return driver;
  };

  const success = createFillDriver();
  const successCalls = [];
  success.cdp = async (method, params, route) => { successCalls.push({ method, params, route }); return {}; };
  const successActionablePoint = success.actionablePoint;
  success.actionablePoint = async (...args) => { successCalls.push({ method: "actionable-point" }); return successActionablePoint(...args); };
  success.verifyFramedPoint = async () => { successCalls.push({ method: "verify-framed-point" }); return true; };
  await success.fill({ kind: "fill", ref: "unused", value: "hello" });
  assert.equal(successCalls.findIndex((call) => call.method === "DOM.focus")
    < successCalls.findIndex((call) => call.method === "actionable-point"), true);
  const successOrder = successCalls
    .filter((call) => call.method === "verify-framed-point" || call.method.startsWith("Input."))
    .map((call) => [call.method, call.params?.type ?? null]);
  assert.deepEqual(successOrder.slice(0, 4), [
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["verify-framed-point", null],
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"],
  ]);
  assert.equal(successOrder.some(([method]) => method === "Input.insertText"), true);
  const successInputCalls = successCalls.filter((call) => call.method.startsWith("Input."));
  assert.equal(successInputCalls.every((call) => call.route?.sessionId === "child-session"), true);
  assert.deepEqual(
    { x: successInputCalls[0].params.x, y: successInputCalls[0].params.y },
    { x: 40, y: 60 },
  );

  const blocked = createFillDriver();
  const blockedCalls = [];
  blocked.cdp = async (method, params, route) => { blockedCalls.push({ method, params, route }); return {}; };
  blocked.verifyFramedPoint = async () => {
    blocked.actionabilityFailure = "frame_owner_hit_failed";
    blockedCalls.push({ method: "verify-framed-point" });
    return false;
  };
  const result = await blocked.fill({ kind: "fill", ref: "unused", value: "must-not-dispatch" });
  assert.equal(result.status, "stale_target");
  assert.equal(result.reason, "frame_owner_hit_failed");
  const postFailureInput = blockedCalls.filter((call) => call.method.startsWith("Input.") && call.params?.type !== "mouseMoved");
  assert.deepEqual(postFailureInput, []);

  const uncertain = createFillDriver();
  const uncertainCalls = [];
  let releaseAttempts = 0;
  uncertain.verifyFramedPoint = async () => true;
  uncertain.cdp = async (method, params, route) => {
    uncertainCalls.push({ method, params, route });
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && releaseAttempts++ === 0) {
      throw new Error("No session with given id");
    }
    return {};
  };
  const uncertainResult = await uncertain.fill({ kind: "fill", ref: "unused", value: "must-not-retry" });
  assert.equal(uncertainResult.status, "dispatched_unverified");
  assert.equal(uncertainResult.reason, "input_dispatch_uncertain");
  assert.equal(uncertainCalls.some((call) => call.method === "Input.insertText"), false);
  assert.deepEqual(uncertainCalls.filter((call) => call.params?.type === "mouseReleased").length, 2);
});

test("framed hover fails closed when its post-move projected proof changes", async () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page" });
  driver.targetRegistry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child-host", sessionId: "child-session",
  });
  const calls = [];
  let settled = false;
  driver.resolveTarget = async () => ({ targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 });
  driver.actionablePoint = async () => {
    const point = { x: 140, y: 260 };
    driver.framedPointProof = {
      targetId: "child", sessionId: "child-session", frameId: "child-root", point,
      frames: {
        routes: [{ targetId: "main", sessionId: null, frameId: "child-host" }],
        geometries: [{ x: 100, y: 200, viewportWidth: 500, viewportHeight: 400 }],
      },
    };
    return point;
  };
  driver.embeddingTopologyMatches = () => true;
  driver.verifyFramedPoint = async () => {
    calls.push({ method: "verify-framed-point" });
    driver.actionabilityFailure = "frame_topology_changed";
    return false;
  };
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };
  driver.settleShort = async () => { settled = true; };
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date(0).toISOString() });

  const result = await driver.hover({ kind: "hover", ref: "unused" });
  assert.equal(result.status, "stale_target");
  assert.equal(result.reason, "frame_topology_changed");
  assert.equal(settled, false);
  assert.deepEqual(calls.filter((call) => call.method.startsWith("Input.") || call.method === "verify-framed-point")
    .map((call) => [call.method, call.params?.type ?? null]), [
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["verify-framed-point", null],
  ]);
  assert.equal(calls.find((call) => call.method.startsWith("Input."))?.route?.sessionId, "child-session");
  assert.deepEqual(
    calls.filter((call) => call.method.startsWith("Input.")).map((call) => [call.params.x, call.params.y]),
    [[40, 60]],
  );
});

test("targeted keyboard actions use the child session while global and sessionless actions stay root", async () => {
  const target = { targetId: "child", sessionId: "child-session", frameId: "child-root", backendNodeId: 77 };
  const run = async (kind) => {
    const driver = createNewtonBrowserDriver();
    const calls = [];
    driver.resolveTarget = async () => target;
    driver.elementState = async () => ({});
    driver.objectIdFor = async () => "object-1";
    driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
    driver.cdp = async (method, params, route) => {
      calls.push({ method, params, route });
      if (method === "Runtime.callFunctionOn") return { result: { value: false } };
      return {};
    };
    if (kind === "press") await driver.press({ kind: "press", ref: "unused", keys: ["Enter"] });
    if (kind === "clear") await driver.clear({ kind: "clear", ref: "unused" });
    if (kind === "select") await driver.select({ kind: "select", ref: "unused", value: "Choice" });
    return calls.filter((call) => call.method.startsWith("Input."));
  };

  for (const kind of ["press", "clear", "select"]) {
    const calls = await run(kind);
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((call) => call.route?.sessionId === "child-session"), true, kind);
  }

  const domOnly = createNewtonBrowserDriver();
  const domCalls = [];
  domOnly.resolveTarget = async () => target;
  domOnly.elementState = async () => ({});
  domOnly.objectIdFor = async () => "object-1";
  domOnly.fileInputFacts = async () => ({ isFileInput: true, multiple: false, visible: true });
  domOnly.fileInputState = async () => [{ filename: "asset.png", sizeBytes: 1, mimeType: "image/png" }];
  domOnly.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
  domOnly.cdp = async (method, params, route) => {
    domCalls.push({ method, params, route });
    if (method === "Runtime.callFunctionOn") return { result: { value: true } };
    return {};
  };
  await domOnly.select({ kind: "select", ref: "unused", value: "Choice" });
  await domOnly.setFiles({ kind: "set_files", ref: "unused", files: ["C:\\fixture\\asset.png"] });
  assert.equal(domCalls.some((call) => call.method.startsWith("Input.")), false);
  assert.equal(domCalls.filter((call) => call.method === "Runtime.callFunctionOn" || call.method === "DOM.setFileInputFiles")
    .every((call) => call.route?.sessionId === "child-session"), true);

  const globalPress = createNewtonBrowserDriver();
  const globalCalls = [];
  globalPress.resolveTarget = async () => null;
  globalPress.cdp = async (method, params, route) => { globalCalls.push({ method, params, route }); return {}; };
  globalPress.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });
  await globalPress.press({ kind: "press", keys: ["Escape"] });
  assert.equal(globalCalls.filter((call) => call.method.startsWith("Input.")).every((call) => call.route?.sessionId === undefined), true);

  assert.equal(createNewtonBrowserDriver().targetInputMode({ targetId: "main" }), "root");
  assert.equal(createNewtonBrowserDriver().targetInputMode({ targetId: "main", frameId: "same-process", sessionId: null }), "root");
  assert.deepEqual(createNewtonBrowserDriver().pointerInputRoute({ targetId: "main" }, { x: 11, y: 22 }), {
    mode: "root", point: { x: 11, y: 22 },
  });
  assert.deepEqual(createNewtonBrowserDriver().pointerInputRoute(
    { targetId: "main", frameId: "same-process", sessionId: null },
    { x: 33, y: 44 },
  ), { mode: "root", point: { x: 33, y: 44 } });
});

test("driver never heals stale or detached composite refs by semantic rematching", async () => {
  const driver = createNewtonBrowserDriver();
  driver.mainTargetId = "main";
  driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
  driver.targetRegistry.commitTopLevelDocument("main");
  const staleRef = driver.targetRegistry.createRef("main", 7);
  driver.targetRegistry.commitTopLevelDocument("main");
  let observed = false;
  driver.observe = async () => { observed = true; return { nodes: [{ ref: "d2:e7", role: "button", name: "Same name" }] }; };
  await assert.rejects(driver.resolveTarget({ kind: "click", ref: staleRef, name: "Same name" }), (error) => error?.code === "stale_target");
  assert.equal(observed, false);
});

test("driver uses CDP page coordinates for iframe candidates and hit testing", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "DOM.getContentQuads") return { quads: [[100, 200, 180, 200, 180, 240, 100, 240]] };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 77, frameId: "same" };
    return {};
  };

  assert.deepEqual(await driver.candidatePoints(77), [{ x: 140, y: 220 }]);
  assert.deepEqual(await driver.boxFor(77), { x: 100, y: 200, width: 80, height: 40 });
  assert.equal(await driver.hitTestTarget(77, 140, 220), true);
  assert.deepEqual(calls.find((call) => call.method === "DOM.getNodeForLocation")?.params, {
    x: 140,
    y: 220,
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });
});

test("driver falls back to the proven DOM hit test when the page-coordinate hit differs", async () => {
  const driver = createNewtonBrowserDriver();
  const functions = [];
  driver.objectIdFor = async (backendNodeId) => `object-${backendNodeId}`;
  driver.cdp = async (method, params) => {
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 88, frameId: "main" };
    if (method === "Runtime.callFunctionOn") {
      functions.push(params.functionDeclaration);
      return { result: { value: params.functionDeclaration.includes("elementFromPoint") } };
    }
    return {};
  };

  assert.equal(await driver.hitTestTarget(77, 140, 220), true);
  assert.equal(functions.length, 2);
  assert.equal(functions[0].includes("this.contains(hit)"), true);
  assert.equal(functions[1].includes("document.elementFromPoint"), true);
});

test("driver verifies scroll state when Chrome drops the wheel acknowledgement", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  const positions = [0, 900];
  driver.evalNumber = async (expression) => expression === "window.scrollY" ? positions.shift() ?? 900 : 0;
  driver.cdp = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    if (method === "Input.dispatchMouseEvent") throw new Error("cdp_timeout_input_dispatchmouseevent");
    return {};
  };
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [] });

  const result = await driver.scroll({ value: 900 });

  assert.equal(result.status, "verified");
  assert.deepEqual(result.changed, { scrollY: 900, wheelAcknowledged: false });
  assert.deepEqual(calls[0].timeoutMs, { timeoutMs: 2000 });
});

test("driver resolves top-level action target shorthands from observations", async () => {
  const driver = createNewtonBrowserDriver();
  const textbox = { backendNodeId: 2 };
  const button = { backendNodeId: 7 };
  driver.refIndex.set("d1:e2", textbox);
  driver.refIndex.set("d1:e7", button);
  driver.observe = async () => ({
    kind: "observation",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    nodes: [
      { ref: "d1:e2", role: "textbox", name: "Name " },
      { ref: "d1:e7", role: "button", name: "Increment" },
    ],
    nodeCount: 2,
    truncated: false,
    capturedAt: "2026-06-30T00:00:00.000Z",
  });

  assert.deepEqual(await driver.resolveTarget({ kind: "fill", label: "Name" }), { backendNodeId: 2 });
  assert.deepEqual(await driver.resolveTarget({ kind: "click", name: "Increment" }), { backendNodeId: 7 });
});

test("driver wait_for text normalizes layout whitespace", async () => {
  const driver = createNewtonBrowserDriver();
  let expression = "";
  driver.evalBool = async (input) => {
    expression = input;
    return input.includes("Count: 1") && input.includes("replace(/\\s+/g");
  };

  assert.equal(await driver.waitConditionMet({ text: "Count: 1" }), true);
  assert.match(expression, /innerText \|\| body\.textContent/);
});

test("driver click dispatches complete CDP mouse button state", async () => {
  const driver = createNewtonBrowserDriver();
  const mouseEvents = [];
  const commandOrder = [];
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.hitTestTarget = async () => true;
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.cdp = async (method, params) => {
    commandOrder.push(method);
    if (method === "Input.dispatchMouseEvent") mouseEvents.push(params);
    return {};
  };
  driver.settleShort = async () => {};
  driver.observeDelta = async () => ({
    kind: "observation_delta",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    added: [],
    removed: [],
    updated: [],
    nodeCount: 0,
    capturedAt: "2026-06-30T00:00:00.000Z",
  });

  await driver.click({ kind: "click", ref: "e7" });

  assert.deepEqual(commandOrder.slice(0, 4), ["DOM.focus", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
  assert.deepEqual(mouseEvents, [
    { type: "mouseMoved", x: 20, y: 30, button: "none", buttons: 0, modifiers: 0, pointerType: "mouse" },
    { type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1, modifiers: 0, pointerType: "mouse" },
    { type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1, modifiers: 0, pointerType: "mouse" },
  ]);
});

test("driver rejects a target that moves after pointer entry before pressing", async () => {
  const driver = createNewtonBrowserDriver();
  let pressed = false;
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.cdp = async () => ({});
  driver.moveMouse = async () => {};
  driver.hitTestTarget = async () => false;
  driver.pressMouse = async () => { pressed = true; };
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: "2026-07-10T00:00:00.000Z" });

  const result = await driver.click({ kind: "click", ref: "e7" });

  assert.equal(result.status, "stale_target");
  assert.equal(result.reason, "target_moved");
  assert.equal(pressed, false, "driver must not press at a point the target vacated");
});

test("driver returns bounded evidence for an element intercepting a click", async () => {
  const driver = createNewtonBrowserDriver();
  let pressed = false;
  const blocker = {
    role: "dialog",
    name: "Cookie preferences",
    tag: "section",
    point: { x: 20, y: 30 },
    frame: { targetId: "main", documentEpoch: 2 },
  };
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 }, targetId: "main", documentEpoch: 2 });
  driver.paintCursorClick = () => {};
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.hitTestTarget = async () => false;
  driver.blockingElementEvidence = async () => blocker;
  driver.inputDispatcher = {
    async run(_route, operation) {
      return operation({ pointerMove: async () => {}, mouseDown: async () => { pressed = true; }, mouseUp: async () => {} });
    },
  };
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: "2026-08-09T00:00:00.000Z" });

  const result = await driver.click({ kind: "click", ref: "d2:e7" });
  assert.equal(result.reason, "click_intercepted");
  assert.deepEqual(result.changed.blocker, blocker);
  assert.equal(pressed, false);
});

test("driver settling observes mutation revision and network quiet instead of element counts", async () => {
  const driver = createNewtonBrowserDriver();
  const expressions = [];
  driver.evalString = async (expression) => { expressions.push(expression); return "complete:4:https://example.com/page"; };
  await driver.waitForSettle(500);
  assert.ok(expressions[0].includes("MutationObserver"));
  assert.ok(expressions[0].includes('document.addEventListener("input"'));
  assert.equal(expressions[0].includes("querySelectorAll('*').length"), false);
});

test("driver reconciles post-action network writes after an allowed click", async () => {
  const driver = createNewtonBrowserDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.hitTestTarget = async () => true;
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.cdp = async () => ({});
  driver.settleShort = async () => {
    driver.recordDebuggerEvent("Network.requestWillBeSent", { request: { method: "GET", url: "https://example.com/pixel" } });
    driver.recordDebuggerEvent("Network.requestWillBeSent", { request: { method: "POST", url: "https://example.com/save" } });
  };
  driver.observeDelta = async () => ({
    kind: "observation_delta",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    added: [],
    removed: [],
    updated: [],
    nodeCount: 0,
    capturedAt: "2026-06-30T00:00:00.000Z",
  });

  const result = await driver.click({ kind: "click", ref: "e7" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "post_action_network_write");
  assert.equal(result.changed.networkWrite, true);
  assert.equal(result.observation.changed.networkWrite, true);
});

test("driver ignores read-only network traffic during post-action reconciliation", async () => {
  const driver = createNewtonBrowserDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
  driver.hitTestTarget = async () => true;
  driver.pageSignature = async () => ({ url: "https://example.com/page", title: "Example" });
  driver.elementState = async () => ({});
  driver.cdp = async () => ({});
  driver.settleShort = async () => {
    driver.recordDebuggerEvent("Network.requestWillBeSent", { request: { method: "GET", url: "https://example.com/pixel" } });
  };
  driver.observeDelta = async () => ({
    kind: "observation_delta",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    added: [],
    removed: [],
    updated: [],
    nodeCount: 0,
    capturedAt: "2026-06-30T00:00:00.000Z",
  });

  const result = await driver.click({ kind: "click", ref: "e7" });
  assert.equal(result.status, "dispatched_unverified");
  assert.equal(result.changed.networkWrite, undefined);
});

test("driver sets exact files through DOM.setFileInputFiles and returns sanitized acceptance", async () => {
  const driver = createNewtonBrowserDriver();
  const commands = [];
  driver.resolveTarget = async () => ({ backendNodeId: 7 });
  driver.fileInputFacts = async () => ({ isFileInput: true, multiple: true, visible: true });
  driver.fileInputState = async () => [{ filename: "asset.png", sizeBytes: 12, mimeType: "image/png" }];
  driver.observeDelta = async () => ({
    kind: "observation_delta",
    mode: "cdp",
    origin: "https://example.com",
    title: "Upload",
    added: [],
    removed: [],
    updated: [],
    nodeCount: 1,
    capturedAt: "2026-07-10T00:00:00.000Z",
  });
  driver.cdp = async (method, params) => {
    commands.push({ method, params });
    return {};
  };

  const result = await driver.executeAction({ kind: "set_files", ref: "e7", files: ["C:\\fixtures\\asset.png"] });
  assert.deepEqual(commands, [{ method: "DOM.setFileInputFiles", params: { backendNodeId: 7, files: ["C:\\fixtures\\asset.png"] } }]);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.changed.files, [{ filename: "asset.png", sizeBytes: 12, mimeType: "image/png" }]);
});

test("driver requires a fresh ref for hidden inputs, enforces multiple, and supports cancellation without submit", async () => {
  const driver = createNewtonBrowserDriver();
  const commands = [];
  driver.resolveTarget = async () => ({ backendNodeId: 9 });
  driver.fileInputFacts = async () => ({ isFileInput: true, multiple: false, visible: false });
  driver.fileInputState = async () => [];
  driver.observeDelta = async () => ({
    kind: "observation_delta", mode: "cdp", origin: "https://example.com", title: "Upload",
    added: [], removed: [], updated: [], nodeCount: 1, capturedAt: "2026-07-10T00:00:00.000Z",
  });
  driver.cdp = async (method, params) => { commands.push({ method, params }); return {}; };

  await assert.rejects(
    driver.executeAction({ kind: "set_files", selector: "#hidden", files: ["C:\\fixtures\\asset.png"] }),
    /hidden_file_input_requires_ref/,
  );
  await assert.rejects(
    driver.executeAction({ kind: "set_files", ref: "e9", files: ["C:\\fixtures\\one.png", "C:\\fixtures\\two.png"] }),
    /file_input_not_multiple/,
  );
  const cancelled = await driver.executeAction({ kind: "set_files", ref: "e9", files: [] });
  assert.equal(cancelled.status, "verified");
  assert.deepEqual(commands, [{ method: "DOM.setFileInputFiles", params: { backendNodeId: 9, files: [] } }]);
  assert.equal(commands.some((entry) => /click|submit/i.test(entry.method)), false);
});

test("driver observation emits a fresh ref for a hidden file input", async () => {
  const driver = createNewtonBrowserDriver();
  primeObservationDriver(driver);
  driver.cdp = async (method) => {
    if (method === "Runtime.evaluate") return { result: { value: method.includes?.("scrollY") ? "0" : "https://example.com/upload" } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [17] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 71 } };
    return {};
  };
  driver.evalString = async (expression) => expression === "location.href" ? "https://example.com/upload" : "Upload";
  driver.fileInputDisplayFacts = async () => ({ name: "Creative asset", bbox: null });

  const observation = await driver.observe({});
  assert.deepEqual(observation.nodes, [{ ref: "d1:e71", role: "file", name: "Creative asset", documentEpoch: 1 }]);
  assert.equal(driver.refIndex.get("d1:e71").backendNodeId, 71);
});

test("driver records dialog, download, new-target, navigation, and network-write signals", () => {
  const driver = createNewtonBrowserDriver();
  const window = driver.beginActionSignals();
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "confirm" });
  driver.recordDebuggerEvent("Page.downloadWillBegin", { url: "https://example.com/file" });
  driver.recordDebuggerEvent("Target.targetCreated", { targetInfo: { type: "page", url: "https://example.com/new" } });
  driver.recordDebuggerEvent("Page.frameNavigated", { frame: { id: "main" } });
  driver.recordDebuggerEvent("Network.requestWillBeSent", { request: { method: "POST", url: "https://example.com/write" } });
  assert.deepEqual(window.finish(), { dialog: true, download: true, newTarget: true, navigation: true, networkWrite: true });
});

test("driver observe mode:text returns bounded main-content text", async () => {
  const driver = createNewtonBrowserDriver();
  const longText = "word ".repeat(100); // 500 chars, over the 200 floor
  driver.evalString = async (expression) => {
    if (expression === "location.href") return "https://example.com/article";
    if (expression === "document.title") return "Article";
    if (expression.includes("main,article")) return longText;
    return "";
  };
  const result = await driver.observe({ mode: "text", maxChars: 200 });
  assert.equal(result.kind, "observation_text");
  assert.equal(result.mode, "text");
  assert.equal(result.origin, "https://example.com");
  assert.equal(result.title, "Article");
  assert.equal(result.text.length, 200);
  assert.equal(result.chars, 200);
  assert.equal(result.truncated, true);
});

test("driver observe mode:text does not consult the accessibility tree", async () => {
  const driver = createNewtonBrowserDriver();
  driver.evalString = async (expression) => (expression.includes("main,article") ? "Just some prose." : expression === "location.href" ? "https://example.com/" : "");
  driver.cdp = async (method) => { throw new Error(`unexpected cdp call: ${method}`); };
  const result = await driver.observe({ mode: "text" });
  assert.equal(result.text, "Just some prose.");
  assert.equal(result.truncated, false);
});

test("driver tracks a pending dialog and surfaces it in observation metadata", async () => {
  const driver = createNewtonBrowserDriver();
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "confirm", message: "Delete this item?" });
  assert.deepEqual(driver.pendingDialog, { dialogType: "confirm", message: "Delete this item?" });
  const meta = driver.withObservationMeta("verified", {}, await driver.observe({}));
  assert.deepEqual(meta.observation.pendingDialog, { dialogType: "confirm", message: "Delete this item?" });
});

test("driver does not clear another target's pending dialog", () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.registerTarget({ targetId: "child-a", type: "page", sessionId: "child-a" });
  driver.targetRegistry.registerTarget({ targetId: "child-b", type: "page", sessionId: "child-b" });
  driver.recordDebuggerEvent({ sessionId: "child-a" }, "Page.javascriptDialogOpening", { type: "alert", message: "A" });
  driver.recordDebuggerEvent({ sessionId: "child-b" }, "Page.javascriptDialogOpening", { type: "confirm", message: "B" });
  driver.recordDebuggerEvent({ sessionId: "child-a" }, "Page.javascriptDialogClosed", {});
  assert.deepEqual(driver.pendingDialog, { dialogType: "confirm", message: "B" });
  assert.equal(driver.pendingDialogRoute.sessionId, "child-b");
  driver.recordDebuggerEvent({ sessionId: "child-a" }, "Page.javascriptDialogOpening", { type: "alert", message: "A2" });
  driver.recordDebuggerEvent({ sessionId: "child-a" }, "Page.javascriptDialogClosed", {});
  assert.deepEqual(driver.pendingDialog, { dialogType: "confirm", message: "B" });
});

test("driver dialog_accept resolves the dialog via CDP and clears pending state", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.cdp = async (method, params) => { calls.push({ method, params }); return {}; };
  driver.waitForSettle = async () => {};
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
  const result = await driver.executeAction({ kind: "dialog_accept" });
  assert.equal(result.status, "verified");
  assert.equal(result.changed.dialog, "accepted");
  assert.equal(driver.pendingDialog, null);
  assert.deepEqual(calls.find((c) => c.method === "Page.handleJavaScriptDialog").params, { accept: true });
  assert.equal(result.observation.pendingDialog, undefined);
});

test("driver dialog_accept forwards promptText for a prompt dialog", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.cdp = async (method, params) => { calls.push({ method, params }); return {}; };
  driver.waitForSettle = async () => {};
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "prompt", message: "Your name?", defaultPrompt: "Anon" });
  await driver.executeAction({ kind: "dialog_accept", promptText: "Ada" });
  assert.deepEqual(calls.find((c) => c.method === "Page.handleJavaScriptDialog").params, { accept: true, promptText: "Ada" });
});

test("driver dialog_dismiss rejects the dialog and a no-op is typed when none is open", async () => {
  const driver = createNewtonBrowserDriver();
  const calls = [];
  driver.cdp = async (method, params) => { calls.push({ method, params }); return {}; };
  driver.waitForSettle = async () => {};
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  const none = await driver.executeAction({ kind: "dialog_dismiss" });
  assert.equal(none.status, "failed");
  assert.equal(none.reason, "no_dialog_open");
  assert.equal(calls.length, 0);
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "alert", message: "Saved" });
  const result = await driver.executeAction({ kind: "dialog_dismiss" });
  assert.equal(result.status, "verified");
  assert.equal(result.changed.dialog, "dismissed");
  assert.deepEqual(calls.find((c) => c.method === "Page.handleJavaScriptDialog").params, { accept: false });
});

test("driver resize applies an isolated-process viewport and persists it across re-attach", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  const calls = [];
  driver.cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "main-target", type: "page", url: "about:blank" } };
    return method === "Target.attachToBrowserTarget" ? { sessionId: "browser-control" } : {};
  };
  driver.settleShort = async () => {};
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  const result = await driver.executeAction({ kind: "resize", viewport: { width: 1024, height: 768 } });
  assert.equal(result.status, "verified");
  assert.equal(result.changed.viewport, "1024x768");
  assert.deepEqual(driver.sessionViewport, { width: 1024, height: 768 });
  const metrics = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.equal(metrics.params.width, 1024);
  assert.equal(metrics.params.height, 768);

  // A re-attach must re-apply the stored viewport.
  calls.length = 0;
  driver.calibrate = async () => {};
  await driver.attach();
  assert.ok(calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride" && c.params.width === 1024));
});

test("driver buffers console output and filters by level and pattern", async () => {
  const driver = createNewtonBrowserDriver();
  driver.lastObserveUrl = "https://example.com/";
  driver.recordDebuggerEvent("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello world" }] });
  driver.recordDebuggerEvent("Runtime.consoleAPICalled", { type: "warning", args: [{ value: "careful now" }] });
  driver.recordDebuggerEvent("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: boom" } } });
  const all = driver.getConsole({});
  assert.equal(all.kind, "console_log");
  assert.equal(all.entries.length, 3);
  const errorsOnly = driver.getConsole({ level: "error" });
  assert.equal(errorsOnly.entries.length, 1);
  assert.match(errorsOnly.entries[0].text, /TypeError/);
  const matched = driver.getConsole({ pattern: "careful" });
  assert.equal(matched.entries.length, 1);
  assert.equal(matched.entries[0].level, "warn");
  const repeated = driver.getConsole({});
  assert.equal(repeated.entries.length, 3);
});

test("driver buffers network request metadata without headers", async () => {
  const driver = createNewtonBrowserDriver();
  driver.lastObserveUrl = "https://example.com/";
  driver.recordDebuggerEvent("Network.requestWillBeSent", { requestId: "r1", request: { method: "POST", url: "https://example.com/api/save", headers: { authorization: "Bearer secret" } }, type: "XHR" });
  driver.recordDebuggerEvent("Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json" } });
  driver.recordDebuggerEvent("Network.loadingFinished", { requestId: "r1", encodedDataLength: 1234 });
  const list = await driver.getNetwork({});
  assert.equal(list.kind, "network_log");
  assert.equal(list.entries.length, 1);
  const entry = list.entries[0];
  assert.equal(entry.method, "POST");
  assert.equal(entry.status, 200);
  assert.equal(entry.bytes, 1234);
  assert.equal("headers" in entry, false, "network entries must never carry headers");
  assert.equal(JSON.stringify(entry).includes("Bearer"), false);
});

test("driver network body fetch is refused for a cross-origin request", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.lastObserveUrl = "https://example.com/";
  let cdpCalled = false;
  driver.cdp = async () => { cdpCalled = true; return { body: "leak", base64Encoded: false }; };
  driver.recordDebuggerEvent("Network.requestWillBeSent", { requestId: "r9", request: { method: "GET", url: "https://tracker.example.net/pixel" }, type: "Image" });
  const result = await driver.getNetwork({ requestId: "r9" });
  assert.equal(result.body, null);
  assert.equal(result.reason, "origin_not_granted");
  assert.equal(cdpCalled, false, "a cross-origin body must not even be fetched");
});

test("driver network body fetch returns a same-origin body", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.lastObserveUrl = "https://example.com/";
  driver.cdp = async (method) => (method === "Network.getResponseBody" ? { body: "{\"ok\":true}", base64Encoded: false } : {});
  driver.recordDebuggerEvent("Network.requestWillBeSent", { requestId: "r2", request: { method: "GET", url: "https://example.com/api/data" }, type: "XHR" });
  driver.recordDebuggerEvent("Network.responseReceived", { requestId: "r2", response: { status: 200, mimeType: "application/json" } });
  const result = await driver.getNetwork({ requestId: "r2" });
  assert.equal(result.body.data, "{\"ok\":true}");
  assert.equal(result.body.encoding, "utf-8");
  assert.equal(result.bodyDisposition, "text_body_returned");
});

test("driver refuses base64, binary MIME, and malformed UTF-8 bodies with digest metadata", async () => {
  for (const fixture of [
    { id: "base64", mimeType: "application/json", response: { body: "eyJzZWNyZXQiOiJ4In0=", base64Encoded: true }, encoding: "base64" },
    { id: "binary", mimeType: "application/octet-stream", response: { body: "raw-binary", base64Encoded: false }, encoding: "unknown" },
    { id: "malformed", mimeType: "text/plain", response: { body: "bad\uFFFDtext", base64Encoded: false }, encoding: "malformed_utf8" },
  ]) {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    driver.lastObserveUrl = "https://example.com/";
    driver.cdp = async (method) => method === "Network.getResponseBody" ? fixture.response : {};
    driver.recordDebuggerEvent("Network.requestWillBeSent", { requestId: fixture.id, request: { method: "GET", url: `https://example.com/${fixture.id}` }, type: "XHR" });
    driver.recordDebuggerEvent("Network.responseReceived", { requestId: fixture.id, response: { status: 200, mimeType: fixture.mimeType } });
    const result = await driver.getNetwork({ requestId: fixture.id });
    assert.equal(result.body, null);
    assert.equal(result.bodyDisposition, "opaque_body_not_returned");
    assert.equal(result.bodyMetadata.declaredEncoding, fixture.encoding);
    assert.match(result.bodyMetadata.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(fixture.response.body), false);
  }
});

test("driver Fetch containment blocks ungranted effects without temporally attributing them", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.targetRegistry.registerTarget({ targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "child", sessionId: "child-session" });
  const calls = [];
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };
  const signalWindow = driver.beginActionSignals();

  await driver.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "denied-post",
    request: { url: "https://denied.test/save", method: "POST" },
    resourceType: "Fetch",
  });
  await driver.recordDebuggerEvent({ sessionId: "child-session" }, "Fetch.requestPaused", {
    requestId: "cdn-read",
    request: { url: "https://cdn.test/image.png", method: "GET" },
    resourceType: "Image",
  });
  await driver.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "allowed-post",
    request: { url: "https://example.com/save", method: "POST" },
    resourceType: "Fetch",
  });

  assert.deepEqual(calls[0], { method: "Fetch.failRequest", params: { requestId: "denied-post", errorReason: "BlockedByClient" }, route: {} });
  assert.deepEqual(calls[1], { method: "Fetch.failRequest", params: { requestId: "cdn-read", errorReason: "BlockedByClient" }, route: { sessionId: "child-session" } });
  assert.deepEqual(calls[2], { method: "Fetch.continueRequest", params: { requestId: "allowed-post" }, route: {} });
  assert.equal(signalWindow.finish().containmentPrevention, undefined);
});

test("Fetch request churn relies on the policy proxy without poisoning the page session", async () => {
  const paused = [
    {
      requestId: "vanished-denied",
      request: { url: "https://denied.test/save", method: "POST" },
      resourceType: "Fetch",
    },
    {
      requestId: "vanished-allowed",
      request: { url: "https://example.com/image.png", method: "GET" },
      resourceType: "Image",
    },
  ];
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.cdp = async (method) => {
    if (method === "Fetch.failRequest" || method === "Fetch.continueRequest") throw new Error("request_already_gone");
    return {};
  };
  for (const event of paused) await driver.recordDebuggerEvent({}, "Fetch.requestPaused", event);
  assert.equal(driver.protocolEventFailure, null);
});

test("driver Fetch containment blocks an unflagged unrelated Document without temporal attribution", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.targetRegistry.registerTarget({ targetId: "popup", type: "page", sessionId: "popup-session" });
  const calls = [];
  driver.cdp = async (method, params, route) => { calls.push({ method, params, route }); return {}; };
  const signalWindow = driver.beginActionSignals();

  await driver.recordDebuggerEvent({ sessionId: "popup-session" }, "Fetch.requestPaused", {
    requestId: "popup-document",
    request: { url: "https://denied.test/popup", method: "GET" },
    resourceType: "Document",
  });

  assert.deepEqual(calls, [{
    method: "Fetch.failRequest",
    params: { requestId: "popup-document", errorReason: "BlockedByClient" },
    route: { sessionId: "popup-session" },
  }]);
  assert.equal(signalWindow.finish().containmentPrevention, undefined);
});

test("an allowed main navigation keeps blocked child-document provenance without failing the agent command", async () => {
  const run = async (frameId) => {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    driver.mainFrameId = "main-frame";
    driver.cdp = async () => ({});
    driver.executeActionNow = async () => {
      await driver.recordDebuggerEvent({}, "Fetch.requestPaused", {
        requestId: `document-${frameId}`,
        frameId,
        request: { url: "https://denied.test/frame", method: "GET" },
        resourceType: "Document",
      });
      return { status: "verified", changed: { navigated: "https://example.com/page" } };
    };
    return driver.executeAction({ kind: "navigate", url: "https://example.com/page" });
  };

  const child = await run("child-frame");
  assert.equal(child.status, "verified");
  assert.equal(child.changed.containmentPrevention, undefined);

  const main = await run("main-frame");
  assert.equal(main.status, "blocked");
  assert.equal(main.reason, "ungranted_navigation");
  assert.equal(main.changed.containmentPrevention, "ungranted_navigation");
});

test("failed Document containment preserves exact blocked-frame origin across event orders and sessions", async () => {
  const makeDriver = () => {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    driver.mainTargetId = "main";
    driver.mainFrameId = "main-root";
    driver.targetRegistry.registerTarget({ targetId: "main", type: "page", origin: "https://example.com" });
    driver.targetRegistry.commitTopLevelDocument("main");
    driver.cdp = async () => ({});
    return driver;
  };

  const existing = makeDriver();
  existing.targetRegistry.registerFrame({ frameId: "restricted", targetId: "main" });
  await existing.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "restricted-document",
    frameId: "restricted",
    request: { url: "https://denied.test/restricted", method: "GET" },
    resourceType: "Document",
  });
  const observed = await existing.accessibilityTreesForOrigin("https://example.com");
  assert.deepEqual(observed.excludedFrames, [{
    frameId: "restricted",
    frameOrigin: "https://denied.test",
    reason: "origin_not_granted",
  }]);

  const fetchFirst = makeDriver();
  await fetchFirst.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "late-document",
    frameId: "late-frame",
    request: { url: "https://late-denied.test/path", method: "GET" },
    resourceType: "Document",
  });
  assert.equal(fetchFirst.targetRegistry.frameIdentity("late-frame"), null);
  assert.equal(fetchFirst.targetRegistry.getSnapshot().counts.frames.waiting, 1);
  await fetchFirst.recordDebuggerEvent({}, "Page.frameNavigated", {
    frame: { id: "late-frame", parentId: "main-root", url: "about:blank" },
  });
  assert.equal(fetchFirst.targetRegistry.listObservationRoutes().find((route) => route.frameId === "late-frame")?.origin, "https://late-denied.test");
  assert.equal(fetchFirst.targetRegistry.getSnapshot().counts.frames.waiting, 0);

  const child = makeDriver();
  child.targetRegistry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "host", sessionId: "child-session",
  });
  child.targetRegistry.registerFrame({ frameId: "nested", targetId: "child" });
  await child.recordDebuggerEvent({ sessionId: "child-session" }, "Fetch.requestPaused", {
    requestId: "nested-document",
    frameId: "nested",
    request: { url: "https://nested-denied.test/path", method: "GET" },
    resourceType: "Document",
  });
  assert.equal(child.targetRegistry.listObservationRoutes().find((route) => route.frameId === "nested")?.origin, "https://nested-denied.test");

  const main = makeDriver();
  await main.recordDebuggerEvent({}, "Fetch.requestPaused", {
    requestId: "main-document",
    frameId: "main-root",
    request: { url: "https://top-level-denied.test/path", method: "GET" },
    resourceType: "Document",
  });
  assert.deepEqual(main.targetRegistry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 0 });
});

test("driver preflights explicit navigation before Page.navigate", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
  driver.containmentReady = true;
  let pageNavigateCalls = 0;
  driver.cdp = async (method) => { if (method === "Page.navigate") pageNavigateCalls += 1; return {}; };
  await assert.rejects(
    driver.executeAction({ kind: "navigate", url: "https://denied.test/path" }),
    (error) => error?.code === "ungranted_navigation",
  );
  assert.equal(pageNavigateCalls, 0);
});

test("driver screenshot honors jpeg format and quality", async () => {
  const driver = createNewtonBrowserDriver();
  let captureParams = null;
  driver.evalNumber = async () => 100;
  driver.evalString = async (expression) => (expression === "location.href" ? "https://example.com/" : "Example");
  driver.cdp = async (method, params) => {
    if (method === "Page.captureScreenshot") { captureParams = params; return { data: "ZmFrZQ==" }; }
    return {};
  };
  const shot = await driver.screenshot({ format: "jpeg", quality: 55 });
  assert.equal(captureParams.format, "jpeg");
  assert.equal(captureParams.quality, 55);
  assert.match(shot.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(shot.maskDisposition, "mask_not_configured");
});

test("driver applies trusted post-capture masking and upgrades masked JPEG to PNG", async () => {
  const driver = createNewtonBrowserDriver();
  const order = [];
  let captureParams = null;
  driver.evalNumber = async () => 0;
  driver.evalString = async (expression) => (expression === "location.href" ? "https://example.com/" : "Example");
  driver.resolveMaskTargets = async () => { order.push("resolve"); return [{ backendNodeId: 7 }]; };
  driver.pauseForRasterMask = async () => { order.push("pause"); return async () => { order.push("resume"); }; };
  driver.maskRegionsForTargets = async () => { order.push("measure"); return [{ x: 0, y: 0, width: 1, height: 1 }]; };
  driver.cdp = async (method, params) => {
    if (method === "Page.captureScreenshot") {
      order.push("capture");
      captureParams = params;
      return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
    }
    return {};
  };
  const shot = await driver.screenshot({
    format: "jpeg",
    clip: { x: 0, y: 0, width: 1, height: 1 },
    sensitiveZones: [{ selector: "#secret" }],
  });
  assert.equal(captureParams.format, "png");
  assert.equal("quality" in captureParams, false);
  assert.equal(shot.format, "png");
  assert.equal(shot.requestedFormat, "jpeg");
  assert.equal(shot.maskDisposition, "mask_applied");
  assert.match(shot.dataUrl, /^data:image\/png;base64,/u);
  assert.deepEqual(order, ["resolve", "pause", "measure", "capture", "resume"]);
});

test("driver never captures when a configured sensitive zone cannot be resolved", async () => {
  const driver = createNewtonBrowserDriver();
  let captures = 0;
  driver.evalNumber = async () => 0;
  driver.resolveMaskTargets = async () => { throw new Error("mask_target_unavailable"); };
  driver.cdp = async (method) => { if (method === "Page.captureScreenshot") captures += 1; return {}; };
  await assert.rejects(
    driver.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, sensitiveZones: [{ selector: "#missing" }] }),
    /mask_target_unavailable/u,
  );
  assert.equal(captures, 0);
});

test("driver propagates trusted-mask resume uncertainty after capture", async () => {
  const driver = createNewtonBrowserDriver();
  driver.evalNumber = async () => 0;
  driver.evalString = async () => "";
  driver.resolveMaskTargets = async () => [{ backendNodeId: 7 }];
  driver.pauseForRasterMask = async () => async () => { throw new Error("mask_page_resume_failed"); };
  driver.maskRegionsForTargets = async () => [{ x: 0, y: 0, width: 1, height: 1 }];
  driver.cdp = async (method) => method === "Page.captureScreenshot"
    ? { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" }
    : {};
  await assert.rejects(
    driver.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, sensitiveZones: [{ selector: "#secret" }] }),
    /mask_page_resume_failed/u,
  );
});

test("driver derives trusted mask scroll geometry only after every target is frozen", async () => {
  const driver = createNewtonBrowserDriver();
  let frozen = false;
  driver.resolveMaskTargets = async () => [{ backendNodeId: 7 }];
  driver.pauseForRasterMask = async () => {
    frozen = true;
    return async () => { frozen = false; };
  };
  driver.evalNumber = async () => {
    assert.equal(frozen, true, "scroll/viewport facts must be measured only in the frozen state");
    return 0;
  };
  driver.evalString = async () => "";
  driver.maskRegionsForTargets = async () => [{ x: 0, y: 0, width: 1, height: 1 }];
  driver.cdp = async (method) => method === "Page.captureScreenshot"
    ? { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" }
    : {};
  await driver.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, sensitiveZones: [{ selector: "#secret" }] });
  assert.equal(frozen, false);
});

test("failed script freeze rolls back animation state before capture", async () => {
  const driver = createNewtonBrowserDriver();
  driver.targetRegistry.listObservationRoutes = () => [];
  const calls = [];
  driver.cdp = async (method) => {
    calls.push(method);
    if (method === "Emulation.setScriptExecutionDisabled") throw new Error("freeze_rejected");
    return {};
  };
  await assert.rejects(driver.pauseForRasterMask(), /mask_page_freeze_failed/u);
  assert.deepEqual(calls, [
    "Animation.enable",
    "Animation.setPlaybackRate",
    "Emulation.setScriptExecutionDisabled",
    "Emulation.setScriptExecutionDisabled",
    "Animation.setPlaybackRate",
    "Animation.disable",
  ]);
});

function axNode(backendNodeId, role, name) {
  return {
    backendDOMNodeId: backendNodeId,
    role: { value: role },
    name: { value: name },
  };
}
