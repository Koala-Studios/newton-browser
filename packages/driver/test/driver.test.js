import test from "node:test";
import assert from "node:assert/strict";

import { createNewtonBrowserDriver } from "../src/driver.js";

test("driver emulates focus for an inactive owned tab and restores it on detach", async () => {
  const originalChrome = globalThis.chrome;
  const debuggerCalls = [];
  globalThis.chrome = {
    debugger: {
      async attach(target, version) { debuggerCalls.push({ method: "attach", target, version }); },
      async detach(target) { debuggerCalls.push({ method: "detach", target }); },
    },
    runtime: { lastError: null },
  };
  try {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    const commands = [];
    driver.cdp = async (method, params) => { commands.push({ method, params }); return {}; };
    driver.calibrate = async () => {};
    driver.reassertOverlay = async () => {};
    driver.sendToPage = async () => {};

    await driver.attach(17);
    await driver.detach();

    const fetchEnable = commands.findIndex((call) => call.method === "Fetch.enable");
    const autoAttach = commands.findIndex((call) => call.method === "Target.setAutoAttach");
    assert.equal(fetchEnable >= 0 && fetchEnable < autoAttach, true, "root Fetch containment is installed before child auto-attach");
    assert.equal(commands[autoAttach].params.waitForDebuggerOnStart, true);
    assert.deepEqual(commands.filter((call) => call.method === "Emulation.setFocusEmulationEnabled"), [
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } },
    ]);
    assert.deepEqual(debuggerCalls, [
      { method: "attach", target: { tabId: 17 }, version: "1.3" },
      { method: "detach", target: { tabId: 17 } },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("driver routes flattened CDP commands through an exact child session", async () => {
  const originalChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    debugger: {
      sendCommand(target, method, params, callback) {
        calls.push({ target, method, params });
        callback({ ok: true });
      },
    },
    runtime: { lastError: null },
  };
  try {
    const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
    driver.tabId = 17;
    await driver.cdp("Accessibility.getFullAXTree", {}, { sessionId: "child-session", timeoutMs: 100 });
    assert.deepEqual(calls, [{
      target: { tabId: 17, sessionId: "child-session" },
      method: "Accessibility.getFullAXTree",
      params: {},
    }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
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
    params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
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

test("driver observation emits stable refs and excludes bridge overlay nodes", async () => {
  const driver = createNewtonBrowserDriver();
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
        axNode(103, "button", "Bridge cursor"),
      ],
    };
  };
  driver.isOwnedOverlayNodeCached = async (backendNodeId) => backendNodeId === 103;
  driver.boxFor = async (backendNodeId) => {
    boxCalls += 1;
    return { x: backendNodeId, y: 10, width: 80, height: 20 };
  };

  const first = await driver.observe({ maxNodes: 10 });
  assert.deepEqual(first.nodes.map((node) => node.ref), ["d1:e101", "d1:e102"]);
  assert.deepEqual(first.nodes.map((node) => node.name), ["Save", "Docs"]);
  assert.equal(driver.refIndex.get("d1:e101").backendNodeId, 101);
  assert.equal(driver.refIndex.get("d1:e102").backendNodeId, 102);
  assert.equal(boxCalls, 2);

  const second = await driver.observe({ maxNodes: 10 });
  assert.deepEqual(second.nodes.map((node) => node.ref), ["d1:e101", "d1:e102"]);
  assert.equal(boxCalls, 2, "unchanged nodes reuse cached bboxes when the page has not scrolled");
});

test("driver full-page screenshot bounds clip size and marks truncation", async () => {
  const driver = createNewtonBrowserDriver();
  const cdpCalls = [];
  driver.evalString = async (expression) => {
    if (expression === "location.href") return "https://example.com/long";
    if (expression === "document.title") return "Long page";
    return "";
  };
  driver.sendToPage = async () => {};
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

  const result = await driver.screenshot({ fullPage: true, inline: true });
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

  const evidence = await driver.resolveEvidence({ kind: "click", target: { ref } });
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

test("driver rejects ambiguous accessible-name and selector targets", async () => {
  const accessible = createNewtonBrowserDriver();
  accessible.observe = async () => ({
    nodes: [
      { ref: "e1", role: "button", name: "Duplicate target" },
      { ref: "e2", role: "button", name: "Duplicate target" },
    ],
  });
  await assert.rejects(
    accessible.resolveTarget({ kind: "click", target: { role: "button", name: "Duplicate target", exact: true } }),
    /ambiguous/,
  );

  const selector = createNewtonBrowserDriver();
  selector.cdp = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [2, 3] };
    return {};
  };
  await assert.rejects(selector.resolveTarget({ kind: "click", target: { selector: ".duplicate" } }), /ambiguous/);
});

test("driver reports target_moved when an attached target never stabilizes", async () => {
  const driver = createNewtonBrowserDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7 });
  driver.actionablePoint = async () => null;
  driver.cdp = async () => ({});
  driver.observe = async () => ({ kind: "observation", nodes: [], nodeCount: 0, capturedAt: "2026-07-10T00:00:00.000Z" });

  const result = await driver.click({ kind: "click", target: { ref: "e7" } });
  assert.equal(result.status, "stale_target");
  assert.equal(result.reason, "target_moved");
});

test("driver observes same-origin iframe AX trees and excludes cross-origin frames", async () => {
  const driver = createNewtonBrowserDriver();
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
  driver.isOwnedOverlayNodeCached = async () => false;
  driver.boxFor = async (backendNodeId) => ({ x: backendNodeId, y: 10, width: 80, height: 20 });

  const observation = await driver.observe({ maxNodes: 10 });

  assert.deepEqual(requestedFrames, ["main", "same"]);
  assert.deepEqual(observation.nodes.map((node) => node.name), ["Main button", "Same-origin frame button"]);
  assert.match(observation.nodes[1].ref, /^d1:f\d+:e202$/);
  assert.deepEqual(observation.excludedFrames, [{ frameId: "cross", frameOrigin: "https://other.example", reason: "origin_not_granted" }]);
});

test("driver reports invalid selector syntax before action dispatch", async () => {
  const driver = createNewtonBrowserDriver();
  let inputDispatched = false;
  driver.cdp = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") throw new Error("Failed to execute 'querySelectorAll': ']' is not a valid selector");
    if (method.startsWith("Input.")) inputDispatched = true;
    return {};
  };
  await assert.rejects(
    driver.executeAction({ kind: "click", target: { selector: "]" } }),
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
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") throw new Error("SyntaxError: invalid selector");
    return {};
  };
  await assert.rejects(
    driver.preflightAction({ kind: "wait_for", waitFor: { selector: "]" } }),
    (error) => error.code === "invalid_selector",
  );
  assert.equal(calls, 2);
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
  assert.equal((await driver.resolveTarget({ target: { ref } })).sessionId, "child-session");
  assert.equal(calls.some((call) => call.method === "Accessibility.getFullAXTree" && call.route?.sessionId === "child-session"), true);
  assert.equal(calls.some((call) => call.method === "DOM.getContentQuads" && call.route?.sessionId === "child-session"), true);
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
  driver.actionablePoint = async (_backendNodeId, route) => { routed.push(route); return { x: 10, y: 10 }; };
  driver.elementState = async (_backendNodeId, route) => { routed.push(route); return {}; };
  driver.pressMouse = async (_point, route) => { routed.push(route); };
  driver.releaseMouse = async (_point, route) => { routed.push(route); };
  driver.paintCursorField = () => {};
  driver.cdp = async (_method, _params, route) => { routed.push(route); return {}; };
  driver.observeDelta = async () => ({ kind: "observation_delta", nodes: [], nodeCount: 0 });

  await driver.fill({ kind: "fill", target: { ref }, value: "hello" });
  assert.equal(routed.length > 5, true);
  assert.equal(routed.every((route) => route?.sessionId === "child-session"), true);
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
  await assert.rejects(driver.resolveTarget({ target: { ref: staleRef, name: "Same name" } }), (error) => error?.code === "stale_target");
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
  driver.sendToPage = async () => {};
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

  await driver.click({ kind: "click", target: { ref: "e7" } });

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

  const result = await driver.click({ kind: "click", target: { ref: "e7" } });

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

  const result = await driver.click({ kind: "click", target: { ref: "d2:e7" } });
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

  const result = await driver.click({ kind: "click", target: { ref: "e7" } });
  assert.equal(result.status, "blocked");
  assert.equal(result.verified, false);
  assert.equal(result.reason, "post_action_network_write");
  assert.equal(result.changed.networkWrite, true);
  assert.equal(result.observation.actionStatus, "blocked");
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

  const result = await driver.click({ kind: "click", target: { ref: "e7" } });
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

  const result = await driver.executeAction({ kind: "set_files", target: { ref: "e7" }, files: ["C:\\fixtures\\asset.png"] });
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
    driver.executeAction({ kind: "set_files", target: { selector: "#hidden" }, files: ["C:\\fixtures\\asset.png"] }),
    /hidden_file_input_requires_ref/,
  );
  await assert.rejects(
    driver.executeAction({ kind: "set_files", target: { ref: "e9" }, files: ["C:\\fixtures\\one.png", "C:\\fixtures\\two.png"] }),
    /file_input_not_multiple/,
  );
  const cancelled = await driver.executeAction({ kind: "set_files", target: { ref: "e9" }, files: [] });
  assert.equal(cancelled.status, "verified");
  assert.deepEqual(commands, [{ method: "DOM.setFileInputFiles", params: { backendNodeId: 9, files: [] } }]);
  assert.equal(commands.some((entry) => /click|submit/i.test(entry.method)), false);
});

test("driver observation emits a fresh ref for a hidden file input", async () => {
  const driver = createNewtonBrowserDriver();
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
  assert.deepEqual(observation.nodes, [{ ref: "d1:e71", role: "file", name: "Creative asset", documentEpoch: 1, target: { ref: "d1:e71" } }]);
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

test("driver resize applies an owned-tab viewport and persists it across re-attach", async () => {
  const driver = createNewtonBrowserDriver({ ownsTab: true, allowedOrigins: ["https://example.com"] });
  const calls = [];
  driver.cdp = async (method, params) => { calls.push({ method, params }); return {}; };
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
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { debugger: { async attach() {}, async detach() {} }, runtime: { lastError: null } };
  try {
    calls.length = 0;
    driver.calibrate = async () => {};
    driver.reassertOverlay = async () => {};
    await driver.attach(21);
    assert.ok(calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride" && c.params.width === 1024));
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("driver resize refuses a current (non-owned) tab", async () => {
  const driver = createNewtonBrowserDriver({ ownsTab: false });
  driver.cdp = async () => { throw new Error("should not dispatch"); };
  driver.observe = async () => ({ kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example", nodes: [], nodeCount: 0, truncated: false, capturedAt: new Date().toISOString() });
  const result = await driver.executeAction({ kind: "resize", viewport: { width: 800, height: 600 } });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "resize_needs_owned_tab");
  assert.equal(driver.sessionViewport, null);
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
  const cleared = driver.getConsole({ clear: true });
  assert.equal(cleared.entries.length, 3);
  assert.equal(driver.getConsole({}).entries.length, 0);
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
  const result = await driver.getNetwork({ requestId: "r2" });
  assert.equal(result.body.data, "{\"ok\":true}");
  assert.equal(result.body.base64Encoded, false);
});

test("driver Fetch containment blocks ungranted effects before continuation", async () => {
  const driver = createNewtonBrowserDriver({ allowedOrigins: ["https://example.com"] });
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
  assert.deepEqual(calls[1], { method: "Fetch.continueRequest", params: { requestId: "cdn-read" }, route: { sessionId: "child-session" } });
  assert.deepEqual(calls[2], { method: "Fetch.continueRequest", params: { requestId: "allowed-post" }, route: {} });
  assert.equal(signalWindow.finish().containmentPrevention, "ungranted_mutation");
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
  driver.applyDeviceEmulation = async () => ({ restore: async () => {}, clip: null });
  driver.maskZones = async () => {};
  driver.unmaskZones = async () => {};
  driver.evalNumber = async () => 100;
  driver.evalString = async (expression) => (expression === "location.href" ? "https://example.com/" : "Example");
  driver.cdp = async (method, params) => {
    if (method === "Page.captureScreenshot") { captureParams = params; return { data: "ZmFrZQ==" }; }
    return {};
  };
  const shot = await driver.screenshot({ format: "jpeg", quality: 55, inline: true });
  assert.equal(captureParams.format, "jpeg");
  assert.equal(captureParams.quality, 55);
  assert.match(shot.dataUrl, /^data:image\/jpeg;base64,/);
});

function axNode(backendNodeId, role, name) {
  return {
    backendDOMNodeId: backendNodeId,
    role: { value: role },
    name: { value: name },
  };
}
