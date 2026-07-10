import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserBridgeDriver } from "../src/driver.js";

test("driver observation emits stable refs and excludes bridge overlay nodes", async () => {
  const driver = createBrowserBridgeDriver();
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
  assert.deepEqual(first.nodes.map((node) => node.ref), ["e101", "e102"]);
  assert.deepEqual(first.nodes.map((node) => node.name), ["Save", "Docs"]);
  assert.equal(driver.refIndex.get("e101"), 101);
  assert.equal(driver.refIndex.get("e102"), 102);
  assert.equal(boxCalls, 2);

  const second = await driver.observe({ maxNodes: 10 });
  assert.deepEqual(second.nodes.map((node) => node.ref), ["e101", "e102"]);
  assert.equal(boxCalls, 2, "unchanged nodes reuse cached bboxes when the page has not scrolled");
});

test("driver full-page screenshot bounds clip size and marks truncation", async () => {
  const driver = createBrowserBridgeDriver();
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
  const driver = createBrowserBridgeDriver();
  driver.refIndex.set("e7", 7);
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

  const evidence = await driver.resolveEvidence({ kind: "click", target: { ref: "e7" } });
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
  const driver = createBrowserBridgeDriver();
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

test("driver observes same-origin iframe AX trees and excludes cross-origin frames", async () => {
  const driver = createBrowserBridgeDriver();
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
});

test("driver uses CDP page coordinates for iframe candidates and hit testing", async () => {
  const driver = createBrowserBridgeDriver();
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
  const driver = createBrowserBridgeDriver();
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
  const driver = createBrowserBridgeDriver();
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
  assert.equal(calls[0].timeoutMs, 2000);
});

test("driver resolves top-level action target shorthands from observations", async () => {
  const driver = createBrowserBridgeDriver();
  driver.refIndex.set("e2", 2);
  driver.refIndex.set("e7", 7);
  driver.observe = async () => ({
    kind: "observation",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    nodes: [
      { ref: "e2", role: "textbox", name: "Name " },
      { ref: "e7", role: "button", name: "Increment" },
    ],
    nodeCount: 2,
    truncated: false,
    capturedAt: "2026-06-30T00:00:00.000Z",
  });

  assert.deepEqual(await driver.resolveTarget({ kind: "fill", label: "Name" }), { backendNodeId: 2 });
  assert.deepEqual(await driver.resolveTarget({ kind: "click", name: "Increment" }), { backendNodeId: 7 });
});

test("driver wait_for text normalizes layout whitespace", async () => {
  const driver = createBrowserBridgeDriver();
  let expression = "";
  driver.evalBool = async (input) => {
    expression = input;
    return input.includes("Count: 1") && input.includes("replace(/\\s+/g");
  };

  assert.equal(await driver.waitConditionMet({ text: "Count: 1" }), true);
  assert.match(expression, /innerText \|\| body\.textContent/);
});

test("driver click dispatches complete CDP mouse button state", async () => {
  const driver = createBrowserBridgeDriver();
  const mouseEvents = [];
  const commandOrder = [];
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
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
    { type: "mouseMoved", x: 20, y: 30, button: "none", buttons: 0, pointerType: "mouse" },
    { type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" },
    { type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" },
  ]);
});

test("driver reconciles post-action network writes after an allowed click", async () => {
  const driver = createBrowserBridgeDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
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
  const driver = createBrowserBridgeDriver();
  driver.resolveTarget = async () => ({ backendNodeId: 7, point: { x: 20, y: 30 } });
  driver.paintCursorClick = () => {};
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
  const driver = createBrowserBridgeDriver();
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
  const driver = createBrowserBridgeDriver();
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
  const driver = createBrowserBridgeDriver();
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
  assert.deepEqual(observation.nodes, [{ ref: "e71", role: "file", name: "Creative asset", target: { ref: "e71" } }]);
  assert.equal(driver.refIndex.get("e71"), 71);
});

test("driver records dialog, download, new-target, navigation, and network-write signals", () => {
  const driver = createBrowserBridgeDriver();
  const window = driver.beginActionSignals();
  driver.recordDebuggerEvent("Page.javascriptDialogOpening", { type: "confirm" });
  driver.recordDebuggerEvent("Page.downloadWillBegin", { url: "https://example.com/file" });
  driver.recordDebuggerEvent("Target.targetCreated", { targetInfo: { type: "page", url: "https://example.com/new" } });
  driver.recordDebuggerEvent("Page.frameNavigated", { frame: { id: "main" } });
  driver.recordDebuggerEvent("Network.requestWillBeSent", { request: { method: "POST", url: "https://example.com/write" } });
  assert.deepEqual(window.finish(), { dialog: true, download: true, newTarget: true, navigation: true, networkWrite: true });
});

function axNode(backendNodeId, role, name) {
  return {
    backendDOMNodeId: backendNodeId,
    role: { value: role },
    name: { value: name },
  };
}
