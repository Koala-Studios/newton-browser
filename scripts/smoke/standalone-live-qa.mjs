import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNewtonBrowserHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.NEWTON_BROWSER_PORT ?? 17321);
const requiredBrowsers = String(process.env.NEWTON_BROWSER_QA_REQUIRE_BROWSERS ?? "").split(",").map((value) => value.trim()).filter(Boolean).sort();
const expectedOwner = String(process.env.NEWTON_BROWSER_QA_EXPECT_OWNER ?? "").trim();
const results = [];
const failures = [];

let fixtureServer;
let bridge;
let sessionId = "";
let uploadRoot = "";

try {
  await startFixture();
  uploadRoot = materializeUploadFixtures();
  bridge = createNewtonBrowserHost();
  await bridge.listen(hostPort, "127.0.0.1");
  log("servers_started", { fixture: page(), hostPort });

  if (requiredBrowsers.length > 0) {
    const simultaneous = await waitFor(() => {
      const status = bridge.getStatus();
      return requiredBrowsers.every((browser) => status.connectedBrowsers.includes(browser)) ? status : null;
    }, "all required browser extensions");
    log("simultaneous_browsers_connected", {
      connectedBrowsers: simultaneous.connectedBrowsers,
      browserTarget: simultaneous.browserTarget,
      authenticatedClientCount: simultaneous.authenticatedClientCount,
      eligibleClientCount: simultaneous.eligibleClientCount,
    });
  }

  const started = await mcp("browser.session.start", {
    origin: page("/"),
    allowedOrigins: [`http://127.0.0.1:${fixturePort}`],
    tabMode: "owned_group",
    goal: "standalone holistic QA",
    instanceLabel: "standalone-live-qa",
  });
  sessionId = started.sessionId;
  assert(/^bbs_local_/.test(sessionId), "session did not start", started);
  log("session_started", { sessionId });

  const boundSession = await waitFor(async () => {
    const listed = await mcp("browser.tabs.list", {});
    const session = listed.sessions?.find((item) => item.sessionId === sessionId);
    return session?.ownedTabId ? session : null;
  }, "extension auto-bind");
  log("extension_auto_bound", { ownedTabId: boundSession.ownedTabId, tabGroupId: boundSession.tabGroupId ?? null });
  if (expectedOwner) {
    const ownerStatus = bridge.getStatus();
    const claimEntries = Object.entries(ownerStatus.claimedSessionsByBrowser).filter(([, count]) => count > 0);
    assert(claimEntries.length === 1 && claimEntries[0][1] === 1, "more than one browser claimed the session", ownerStatus);
    const actualOwner = claimEntries[0][0];
    if (expectedOwner !== "any") assert(actualOwner === expectedOwner, "session was not claimed by the expected browser", ownerStatus);
    log("single_browser_claim_ok", { expectedOwner, actualOwner, claimedSessionsByBrowser: ownerStatus.claimedSessionsByBrowser });
  }

  await phase("observe", async () => {
    const observed = okResult(await mcp("browser.observe", { sessionId, maxNodes: 120 }), "observe");
    assert(observed.origin === `http://127.0.0.1:${fixturePort}`, "observe origin mismatch", observed);
    for (const name of ["Increment", "Network write", "Publish fixture", "Name", "Plan", "Password", "Credit card number", "SSN", "IBAN", "Creative assets", "Shadow button", "Nested shadow button", "Same-origin frame button", "Editable notes", "Custom region", "Region options", "Notification email"]) {
      assert(hasName(observed, name), `observe missing ${name}`, observed);
    }
    assert(!hasName(observed, "Cross-origin denied target"), "cross-origin frame target escaped the observation grant", observed);
    log("observe_ok", { nodeCount: observed.nodeCount, kind: observed.kind });
  });

  await phase("fill_label", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Name", value: "Alice" } }), "fill by label");
    log("fill_label_ok");
  });
  await phase("search_flow", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Search records", value: "needle" } }), "search fill");
    const searched = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Run fixture search", waitFor: { text: "search-result:needle" }, timeoutMs: 3000 } });
    assert(statusOf(searched) === "verified", "search result was not verified", searched);
    log("search_flow_ok");
  });
  await phase("placeholder_and_aria", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", placeholder: "Display alias", value: "fixture-alias" } }), "fill by placeholder");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", name: "Notification email", value: "qa@example.invalid" } }), "fill by aria name");
    log("placeholder_and_aria_ok");
  });
  await phase("type_selector", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "type", selector: "#notes", value: "typed notes" } }), "type by selector");
    log("type_selector_ok");
  });
  await phase("contenteditable", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Editable notes", value: "editable notes" } }), "contenteditable fill");
    log("contenteditable_ok");
  });
  await phase("custom_combobox", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Custom region" } }), "custom combobox");
    log("custom_combobox_ok");
  });
  await phase("custom_listbox", async () => {
    const selected = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Canada option", waitFor: { text: "Canada option selected" }, timeoutMs: 3000 } });
    assert(statusOf(selected) === "verified", "custom listbox option was not verified", selected);
    log("custom_listbox_ok");
  });
  await phase("shadow_button", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Shadow button", exact: true } }), "shadow button");
    log("shadow_button_ok");
  });
  await phase("nested_shadow_button", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Nested shadow button" } }), "nested shadow button");
    log("nested_shadow_button_ok");
  });
  await phase("same_origin_frame", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Same-origin frame button" } }), "same-origin frame button");
    log("same_origin_frame_ok");
  });
  await phase("select_label", async () => {
    const selected = await mcp("browser.act", { sessionId, action: { kind: "select", label: "Plan", value: "pro" } });
    assert(["verified", "dispatched_unverified"].includes(statusOf(selected)), "select failed", selected);
    log("select_label_ok", { status: statusOf(selected) });
  });
  await phase("checkbox_radio_date", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Agree" } }), "checkbox");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Standard tier" } }), "radio");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Launch date", value: "2026-07-10" } }), "date");
    log("checkbox_radio_date_ok");
  });
  await phase("click_name", async () => {
    const clicked = await mcp("browser.act", {
      sessionId,
      action: { kind: "click", name: "Increment", waitFor: { text: "Count: 1" }, timeoutMs: 3000 },
    });
    if (statusOf(clicked) !== "verified") {
      const diagnostic = okResult(await mcp("browser.observe", { sessionId, maxNodes: 160 }), "click diagnostic observe");
      const eventLog = (diagnostic.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Event log")?.value ?? "missing";
      assert(false, "click by name failed", { clicked, eventLog });
    }
    log("click_name_ok");
  });
  await phase("hover", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "hover", name: "Increment" } }), "hover");
    log("hover_ok");
  });
  await phase("scroll", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "scroll", value: 900 } }), "scroll");
    log("scroll_ok");
  });

  await phase("screenshot_mobile", async () => {
    const shot = okResult(await mcp("browser.screenshot", {
      sessionId,
      fullPage: true,
      device: "mobile",
      waitMs: 100,
      delivery: "file",
      outputDirectory: uploadRoot,
      filename: "long-page.png",
    }), "screenshot");
    assert(shot.kind === "screenshot" && Number(shot.width) > 0 && Number(shot.height) > 0, "screenshot missing metadata", shot);
    assert(Number(shot.bytes) > 64 * 1024, "full-page screenshot was not larger than 64 KiB", shot);
    const screenshotBytes = fs.readFileSync(shot.path);
    assert(screenshotBytes.length === Number(shot.bytes), "delivered screenshot byte count mismatch", shot);
    assert(screenshotBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "delivered screenshot is not a decodable PNG payload", shot);
    log("screenshot_mobile_ok", { width: shot.width, height: shot.height, fullPage: shot.fullPage, device: shot.device, bytes: shot.bytes, sha256: shot.sha256 });
  });

  await phase("spa_stale_ref", async () => {
    const staleObservation = okResult(await mcp("browser.observe", { sessionId, maxNodes: 160 }), "stale observe");
    const staleRef = (staleObservation.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Stale target")?.ref;
    assert(staleRef, "stale target ref missing", staleObservation);
    okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Rerender counter" } }), "SPA rerender");
    const stale = await mcp("browser.act", { sessionId, action: { kind: "click", target: { ref: staleRef } } });
    assert(["not_found", "stale_target"].includes(statusOf(stale)), "stale ref was not rejected", stale);
    log("spa_stale_ref_ok", { status: statusOf(stale) });
  });
  await phase("spa_moved_target", async () => {
    const moved = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Moving target", exact: true } });
    assert(statusOf(moved) === "stale_target" && reasonOf(moved) === "target_moved", "target that moved under the pointer was not rejected", moved);
    log("spa_moved_target_ok", { status: statusOf(moved), reason: reasonOf(moved) });
  });

  await phase("navigation_history", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "navigate", url: page("/second.html") } }), "navigate");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "back" } }), "back");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "forward" } }), "forward");
    okResult(await mcp("browser.act", { sessionId, action: { kind: "reload" } }), "reload");
    log("navigation_history_ok");
  });

  await phase("navigate_home", async () => {
    okResult(await mcp("browser.act", { sessionId, action: { kind: "navigate", url: page("/") } }), "navigate home");
    log("navigate_home_ok");
  });
  await phase("sensitive_fields_zero_keys", async () => {
    for (const [label, value] of [
      ["Password", "not-a-real-secret"],
      ["One-time code", "123456"],
      ["Credit card number", "4111111111111111"],
      ["SSN", "111-22-3333"],
      ["IBAN", "GB82WEST12345698765432"],
    ]) {
      const blocked = await mcp("browser.act", { sessionId, action: { kind: "fill", label, value } });
      assert(blocked.ok === false && blocked.errorCode === "blocked_by_floor", `${label} fill was not blocked`, blocked);
    }
    const diagnostic = okResult(await mcp("browser.observe", { sessionId, maxNodes: 200 }), "sensitive diagnostic observe");
    const keyLog = (diagnostic.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Sensitive key log")?.value;
    assert(keyLog === "none", "sensitive input dispatched page-side key or input events", { keyLog });
    log("sensitive_fields_zero_keys_ok", { fields: 5, pageKeyLog: keyLog });
  });
  await phase("commit_boundaries", async () => {
    for (const [name, boundary] of [
      ["Publish fixture", "commit"],
      ["Place order", "commit"],
      ["Delete record", "commit"],
      ["Like fixture", "external_effect"],
      ["Subscribe fixture", "external_effect"],
    ]) {
      const acted = await mcp("browser.act", { sessionId, action: { kind: "click", name } });
      assert(acted.ok === true, `${name} did not execute with decision metadata`, acted);
      const decision = decisionOf(acted);
      assert(decision.class === "approval_required" && decision.commitBoundary === boundary, `${name} boundary metadata mismatch`, acted);
    }
    log("commit_boundaries_ok", { controls: 5 });
  });
  await phase("post_action_reconciliation", async () => {
    const localWrite = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Network write" } });
    assert(statusOf(localWrite) === "blocked", "post-action reconciliation did not block local write", localWrite);
    log("post_action_reconciliation_ok");
  });
  await phase("auth_persistence", async () => {
    const observed = okResult(await mcp("browser.observe", { sessionId, maxNodes: 200 }), "auth persistence observe");
    const sentinel = (observed.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Auth persistence")?.value;
    assert(sentinel === "cookie:preserved|local:preserved|session:preserved", "cookie or web storage sentinel changed", { sentinel });
    log("auth_persistence_ok", { sentinel });
  });
  await phase("file_inputs", async () => {
    const uploadObservation = okResult(await mcp("browser.observe", { sessionId, maxNodes: 160 }), "upload observe");
    const uploadNode = (uploadObservation.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Creative assets");
    assert(uploadNode?.ref, "file input ref missing", uploadObservation);
    const uploadFiles = fs.readdirSync(uploadRoot).map((name) => path.join(uploadRoot, name));
    const ambiguous = await mcp("browser.act", { sessionId, action: { kind: "set_files", label: "Ambiguous asset", files: [path.join(uploadRoot, "asset.png")] } });
    assert(ambiguous.ok === false && ambiguous.errorCode === "ambiguous", "ambiguous file inputs were not rejected", ambiguous);
    const uploaded = await mcp("browser.act", { sessionId, action: { kind: "set_files", target: { ref: uploadNode.ref }, files: uploadFiles } });
    assert(statusOf(uploaded) === "verified", "set_files was not verified", uploaded);
    const accepted = uploaded.result?.changed?.files ?? uploaded.changed?.files ?? [];
    assert(accepted.length === uploadFiles.length, "browser FileList acceptance mismatch", uploaded);
    assert(accepted.every((file) => !String(file.filename).includes("\\") && !String(file.filename).includes("/")), "set_files exposed a local path", accepted);
    log("real_file_inputs_ok", { files: accepted.map((file) => file.filename), autoSubmit: false });
  });

  await phase("disallowed_redirect", async () => {
    const redirectStarted = await mcp("browser.session.start", {
      origin: page("/"),
      allowedOrigins: [`http://127.0.0.1:${fixturePort}`],
      tabMode: "owned_group",
      goal: "disallowed redirect QA",
      instanceLabel: "standalone-live-qa-redirect",
    });
    const redirectSessionId = redirectStarted.sessionId;
    assert(redirectSessionId, "redirect session did not start", redirectStarted);
    const redirected = await mcp("browser.act", { redirectSessionId, sessionId: redirectSessionId, action: { kind: "navigate", url: page("/redirect-cross") } });
    assert(redirected.ok === false && redirected.errorCode === "origin_not_granted", "redirect outside the grant was not denied", redirected);
    await waitFor(async () => {
      const listed = await mcp("browser.tabs.list", {});
      return listed.sessions?.every((item) => item.sessionId !== redirectSessionId) ? listed : null;
    }, "redirect session cleanup", 10000);
    log("disallowed_redirect_ok", { errorCode: redirected.errorCode });
  });

  await phase("cleanup", async () => {
    const stopped = await mcp("browser.stop_all", {});
    assert(stopped.stopped, "stop_all failed", stopped);
    await waitFor(async () => {
      const listed = await mcp("browser.tabs.list", {});
      return Array.isArray(listed.sessions) && listed.sessions.length === 0 ? listed : null;
    }, "empty host session list", 10000);
    log("cleanup_ok", { stopped: stopped.stopped });
  });
  if (failures.length > 0) {
    log("live_qa_batch_complete", { passedSteps: results.filter((entry) => entry.step.endsWith("_ok")).length, failures });
    throw new Error(`live QA batch failures: ${failures.map((failure) => failure.phase).join(", ")}`);
  }
  log("live_qa_pass", { steps: results.length, failures: 0 });
} catch (error) {
  log("live_qa_fail", { message: error.message, detail: error.detail });
  process.exitCode = 1;
} finally {
  try {
    if (bridge) {
      bridge.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await bridge.close();
    }
  } catch {}
  try {
    if (fixtureServer) await fixtureServer.close();
  } catch {}
  try {
    if (uploadRoot) fs.rmSync(uploadRoot, { recursive: true, force: true });
  } catch {}
}

async function startFixture() {
  fixtureServer = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
}

async function mcp(name, args = {}) {
  const response = await handleMcpMessage(bridge, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = response?.result?.content?.[0]?.text;
  assert(typeof text === "string", `missing MCP text for ${name}`, { response });
  return JSON.parse(text);
}

async function phase(name, task) {
  try {
    return await task();
  } catch (error) {
    const failure = {
      phase: name,
      message: error?.message ?? String(error),
      ...(error?.detail ? { detail: error.detail } : {}),
    };
    failures.push(failure);
    log("phase_fail", failure);
    return null;
  }
}

async function waitFor(predicate, label, timeoutMs = 90000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function okResult(result, label) {
  assert(result && result.ok !== false, `${label} failed`, result);
  return result.result ?? result;
}

function statusOf(result) {
  return result?.result?.actionStatus ?? result?.result?.status ?? result?.actionStatus ?? result?.status;
}

function decisionOf(result) {
  return result?.decision ?? result?.result?.decision ?? {};
}

function reasonOf(result) {
  return result?.result?.reason ?? result?.reason;
}

function hasName(observation, expected) {
  const nodes = observation.nodes ?? observation.added ?? [];
  return nodes.some((node) => String(node.name ?? "").trim() === expected);
}

function page(path = "/") {
  return `http://127.0.0.1:${fixturePort}${path}`;
}

function log(step, detail = {}) {
  const entry = { step, ...detail };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

function materializeUploadFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-live-files-"));
  const fixtures = {
    "asset.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "asset.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    "asset.webp": Buffer.from("RIFF0000WEBP", "ascii"),
    "asset.gif": Buffer.from("GIF89a", "ascii"),
    "asset.mp4": Buffer.from([0, 0, 0, 16, ...Buffer.from("ftyp", "ascii")]),
    "asset.webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  };
  for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), bytes);
  return root;
}

function assert(condition, message, detail = {}) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}
