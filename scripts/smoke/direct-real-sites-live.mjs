import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createDefaultDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/default-direct-host.ts";
import {
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  openProfileStore,
} from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const browser = discoverBrowserExecutable({ family, env: process.env });
if (!browser) fail("real_site_browser_unavailable");

const persistentIdentityId = process.env.NEWTON_BROWSER_REAL_SITE_IDENTITY_ID;
if (persistentIdentityId !== undefined && !/^nbi_[a-f0-9]{32}$/u.test(persistentIdentityId)) fail("real_site_identity_invalid");
const externalProfileStore = process.env.NEWTON_BROWSER_REAL_SITE_PROFILE_STORE;
if (persistentIdentityId && (!externalProfileStore || !path.isAbsolute(externalProfileStore))) fail("real_site_profile_store_required");

const owned = createOwnedRoot();
const configDirectory = path.join(owned.root, "config");
const ephemeralProfileStore = path.join(owned.root, "identities");
fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
const identityStore = openProfileStore(persistentIdentityId ? externalProfileStore : ephemeralProfileStore);
const identityBaseline = listNewtonIdentities(identityStore).map((identity) => identity.id).sort();
if (persistentIdentityId && !identityBaseline.includes(persistentIdentityId)) fail("real_site_identity_missing");

const receipts = [];
let host = null;
let requestId = 0;
let cleanupConfirmed = false;
let cleanupRetryCount = 0;
let terminalFailure = null;

try {
  host = createDefaultDirectBrowserHost({
    ...process.env,
    NEWTON_BROWSER_BROWSER: family,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: browser.path,
    NEWTON_BROWSER_CONFIG_DIR: configDirectory,
    NEWTON_BROWSER_PROFILE_STORE_DIR: persistentIdentityId ? externalProfileStore : ephemeralProfileStore,
  });

  receipts.push(await recordSite("rfc_editor", () => runReadSite({
    id: "rfc_editor",
    origin: "https://www.rfc-editor.org",
    readySelector: "body",
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("wikipedia", () => runReadSite({
    id: "wikipedia",
    origin: "https://en.wikipedia.org",
    url: "https://en.wikipedia.org/wiki/Web_browser",
    readySelector: "main, #firstHeading",
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("youtube_public", () => runReadSite({
    id: "youtube_public",
    origin: "https://www.youtube.com",
    url: "https://www.youtube.com/",
    readySelector: "ytd-app, main, #content",
    titleOptional: true,
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("reddit_public", () => runReadSite({
    id: "reddit_public",
    origin: "https://www.redditinc.com",
    url: "https://www.redditinc.com/",
    readySelector: "body",
    titleOptional: true,
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("mercato_storefront", () => runSearchSite({
    id: "mercato_storefront",
    origin: "https://mercatodibellina.com",
    url: "https://mercatodibellina.com/search",
    documentReadySelector: "main, #MainContent",
    readySelector: 'form[action*="/search"] input[name="q"]',
    searchPattern: /search|cerca/i,
    value: "pasta",
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("w3c_accessibility", () => runReadSite({
    id: "w3c_accessibility",
    origin: "https://www.w3.org",
    url: "https://www.w3.org/WAI/",
    readySelector: "main, body",
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));
  receipts.push(await recordSite("meta_ads_public", () => runReadSite({
    id: "meta_ads_public",
    origin: "https://www.facebook.com",
    url: "https://www.facebook.com/business/ads",
    readySelector: "body",
    titleOptional: true,
    ...(persistentIdentityId ? { identityId: persistentIdentityId } : {}),
  })));

  if (host.listSessions().length !== 0) fail("real_site_session_residue");
  await host.close();
  host = null;
  const finalIdentities = listNewtonIdentities(identityStore).map((identity) => identity.id).sort();
  if (JSON.stringify(finalIdentities) !== JSON.stringify(identityBaseline)) fail("real_site_identity_residue");
  if (!persistentIdentityId && finalIdentities.length !== 0) fail("real_site_ephemeral_identity_residue");
  if (persistentIdentityId && inspectNewtonIdentityLease(identityStore, persistentIdentityId) !== "available") {
    fail("real_site_identity_lease_residue");
  }
  cleanupConfirmed = true;
  removeOwnedRoot(owned);
  const ok = receipts.every((receipt) => receipt.status === "passed");
  process.stdout.write(`${JSON.stringify({
    ok,
    browserFamily: family,
    sites: receipts,
    persistentIdentityRequested: Boolean(persistentIdentityId),
    persistentIdentityQa: Boolean(persistentIdentityId),
    authenticationPreservationClaimed: false,
    remainingSessions: 0,
    identitySetUnchanged: true,
    identityLeaseReleased: true,
    ephemeralIdentityResidue: 0,
    cleanupConfirmed: true,
    cleanupRetryCount,
  })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  terminalFailure = error;
  process.exitCode = 1;
} finally {
  if (host) {
    try { await host.close(); cleanupConfirmed = true; } catch {
      terminalFailure = Object.assign(new Error("real_site_cleanup_uncertain"), { code: "real_site_cleanup_uncertain" });
      process.exitCode = 1;
    }
  }
  if (!host && !cleanupConfirmed) cleanupConfirmed = true;
  if (cleanupConfirmed && fs.existsSync(owned.root)) {
    try { removeOwnedRoot(owned); } catch {
      terminalFailure = Object.assign(new Error("real_site_cleanup_refused"), { code: "real_site_cleanup_refused" });
      process.exitCode = 1;
    }
  }
}

if (terminalFailure) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    browserFamily: family,
    errorCode: safeCode(terminalFailure),
    completedSiteCount: receipts.length,
    sites: receipts,
    cleanupConfirmed,
    temporaryRootRemoved: !fs.existsSync(owned.root),
  })}\n`);
}

async function recordSite(id, task) {
  try {
    const receipt = Object.freeze({ status: "passed", ...(await task()) });
    process.stdout.write(`${JSON.stringify({ step: `real_site_${id}_passed` })}\n`);
    return receipt;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ step: `real_site_${id}_failed` })}\n`);
    return Object.freeze({ id, status: "failed", errorCode: safeCode(error), ...(safeProductCode(error) ? { productCode: safeProductCode(error) } : {}) });
  }
}

async function runSearchSite(site) {
  return withSession(site, async (sessionId) => {
    if (site.url) {
      requireCompleted(await call("browser.act", { sessionId, action: { kind: "navigate", url: site.url } }), `real_site_${site.id}_navigate_failed`);
      if (site.readySelector) await waitForSiteSelector(sessionId, site.id, site.readySelector);
    }
    let initial = await observe(sessionId);
    const initialMode = await requireUsefulOrText(sessionId, initial, `${site.id}_initial`);
    let search = initial.nodes.find((node) => typeof node.ref === "string"
      && (node.role === "searchbox" || node.role === "textbox")
      && site.searchPattern.test(String(node.name ?? node.placeholder ?? "")));
    if (!search) {
      const opener = initial.nodes.find((node) => typeof node.ref === "string"
        && (node.role === "button" || node.role === "link")
        && site.searchPattern.test(String(node.name ?? "")));
      if (opener) {
        requireCompleted(await call("browser.act", { sessionId, action: { kind: "click", ref: opener.ref } }), `real_site_${site.id}_search_open_failed`);
        initial = await observe(sessionId);
        search = initial.nodes.find((node) => typeof node.ref === "string"
          && (node.role === "searchbox" || node.role === "textbox")
          && site.searchPattern.test(String(node.name ?? node.placeholder ?? "")));
        if (!search) {
          const textInputs = initial.nodes.filter((node) => typeof node.ref === "string"
            && (node.role === "searchbox" || node.role === "textbox"));
          if (textInputs.length === 1) search = textInputs[0];
        }
      }
    }
    const searchTarget = site.id === "mercato_storefront"
        ? { selector: 'form[action*="/search"] input[name="q"]' }
        : search ? { ref: search.ref } : null;
    if (!searchTarget) fail(`real_site_${site.id}_search_missing`);
    const maskedScreenshot = site.id === "mercato_storefront"
      ? await screenshotInMemory(sessionId, site.id, [search?.ref ? { ref: search.ref } : { selector: 'form[action*="/search"] input[name="q"]' }])
      : null;
    const fillAction = { kind: "fill", ...searchTarget, value: site.value };
    let fillResult = await call("browser.act", { sessionId, action: fillAction });
    if (retryableFreshTargetFailure(fillResult)) {
      await observe(sessionId);
      fillResult = await call("browser.act", { sessionId, action: fillAction });
    }
    requireCompleted(fillResult, `real_site_${site.id}_fill_failed`);
    const afterFill = await observe(sessionId);
    const submitButtons = afterFill.nodes.filter((node) => typeof node.ref === "string" && node.role === "button" && /search|cerca/i.test(String(node.name ?? "")));
    const submissionMode = submitButtons.length === 1 ? "observed_submit_button" : "same_origin_query_navigation";
    if (submitButtons.length === 1) {
      requireCompleted(await call("browser.act", { sessionId, action: { kind: "click", ref: submitButtons[0].ref } }), `real_site_${site.id}_submit_failed`);
    } else {
      requireCompleted(await call("browser.act", { sessionId, action: { kind: "navigate", url: `${site.origin}/search?q=${encodeURIComponent(site.value)}` } }), `real_site_${site.id}_submit_failed`);
    }
    const afterSearch = await observe(sessionId);
    const postActionMode = await requireUsefulOrText(sessionId, afterSearch, `${site.id}_post_search`);
    const screenshot = maskedScreenshot ?? await screenshotInMemory(sessionId, site.id);
    return Object.freeze({ id: site.id, mode: site.identityId ? "operator_identity_read_only" : "public_ephemeral", initialUseful: true, initialObservationMode: initialMode, typedSearch: true, submittedSearch: true, submissionMode, postActionUseful: true, postActionObservationMode: postActionMode, screenshot, trustedMaskVerified: site.id === "mercato_storefront", networkCategory: countCategory(await boundedNetworkCount(sessionId, site.id)) });
  });
}

async function runReadSite(site) {
  return withSession(site, async (sessionId) => {
    if (site.url) {
      requireCompleted(await call("browser.act", { sessionId, action: { kind: "navigate", url: site.url } }), `real_site_${site.id}_navigate_failed`);
    }
    if (site.readySelector) await waitForSiteSelector(sessionId, site.id, site.readySelector);
    const initial = await observe(sessionId);
    const initialMode = await requireUsefulOrText(sessionId, initial, site.id, site.titleOptional === true);
    requireCompleted(await call("browser.act", { sessionId, action: { kind: "scroll", y: 900 } }), `real_site_${site.id}_scroll_failed`);
    const afterScroll = await observe(sessionId, "diff");
    const postActionMode = await requireUsefulOrText(sessionId, afterScroll, site.id, site.titleOptional === true);
    const screenshot = await screenshotInMemory(sessionId, site.id);
    return Object.freeze({ id: site.id, mode: site.identityId ? "operator_identity_read_only" : "public_ephemeral", initialUseful: true, initialObservationMode: initialMode, scrolled: true, postActionUseful: true, postActionObservationMode: postActionMode, screenshot, networkCategory: countCategory(await boundedNetworkCount(sessionId, site.id)) });
  });
}

async function withSession(site, task) {
  const start = await call("browser.session.start", { origin: site.origin, browser: family, ...(site.identityId ? { identityId: site.identityId } : {}) });
  requireCompleted(start, `real_site_${site.id}_start_failed`);
  const sessionId = start.value.sessionId;
  if (typeof sessionId !== "string") fail(`real_site_${site.id}_session_missing`);
  try {
    const ready = await call("browser.act", {
      sessionId,
      action: { kind: "wait_for", waitFor: { selector: site.documentReadySelector ?? "body", state: "attached", timeoutMs: 30_000 } },
    });
    requireVerifiedAction(ready, `real_site_${site.id}_document_not_ready`);
    return await task(sessionId);
  }
  finally { await stopSession(sessionId, site.id); }
}

async function stopSession(sessionId, id) {
  const first = await call("browser.session.stop", { sessionId });
  if (first.envelope?.isError !== true && first.value?.ok !== false) return;
  if (closedResultCode(first.value) !== "direct_cleanup_uncertain") {
    requireCompleted(first, `real_site_${id}_stop_failed`);
  }
  cleanupRetryCount += 1;
  requireCompleted(await call("browser.session.stop", { sessionId }), `real_site_${id}_stop_failed`);
}

async function waitForSiteSelector(sessionId, id, selector) {
  requireVerifiedAction(await call("browser.act", {
    sessionId,
    action: { kind: "wait_for", waitFor: { selector, state: "attached", timeoutMs: 30_000 } },
  }), `real_site_${id}_readiness_failed`);
}

async function observe(sessionId, mode = "full") {
  const result = await call("browser.observe", { sessionId, format: "json", mode, maxNodes: 240, includeInteractive: true });
  requireCompleted(result, "real_site_observe_failed");
  const payload = result.value?.result;
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  const surface = [title, ...nodes.flatMap((node) => [node?.role, node?.name, node?.value, node?.description, node?.placeholder])]
    .filter((value) => typeof value === "string")
    .join("\n");
  requireNormalBrowserSurface(surface);
  return Object.freeze({ nodes, nodeCount: nodes.length, titlePresent: title.length > 0, interactiveCount: nodes.filter((node) => typeof node?.ref === "string").length });
}

function requireUseful(observation, id, titleOptional = false) {
  if (!titleOptional && !observation.titlePresent) fail(`real_site_${id}_title_missing`);
  if (observation.nodeCount === 0) fail(`real_site_${id}_nodes_zero`);
  if (observation.nodeCount < 3) fail(`real_site_${id}_nodes_few`);
  if (observation.interactiveCount < 1) fail(`real_site_${id}_interactive_zero`);
}

async function requireUsefulOrText(sessionId, observation, id, titleOptional = false) {
  if ((titleOptional || observation.titlePresent) && observation.nodeCount >= 3 && observation.interactiveCount >= 1) return "accessibility";
  const result = await call("browser.observe", { sessionId, format: "json", mode: "text", maxChars: 20_000 });
  requireCompleted(result, `real_site_${id}_text_observe_failed`);
  const payload = result.value?.result;
  const text = typeof payload?.text === "string" ? payload.text : "";
  requireNormalBrowserSurface(text);
  const chars = typeof payload?.chars === "number" ? payload.chars : text.length;
  if (!Number.isSafeInteger(chars) || chars < 200) {
    fail(`real_site_${id}_text_too_short`);
  }
  return "text";
}

function requireNormalBrowserSurface(value) {
  if (/ERR_BLOCKED_BY_CLIENT|This page has been blocked by Chrome|This site can.t be reached|Connection failed \(-111\)/iu.test(value)) {
    fail("real_site_browser_error_surface");
  }
  if (/\b(?:radio_button_(?:checked|unchecked)|material-icons|material-symbols-(?:outlined|rounded|sharp))\b/iu.test(value)) {
    fail("real_site_resource_rendering_corrupt");
  }
}

async function screenshotInMemory(sessionId, id, sensitiveZones) {
  const response = await rawCall("browser.screenshot", { sessionId, format: "jpeg", quality: 50, region: { x: 0, y: 0, width: 1024, height: 768 }, ...(sensitiveZones ? { sensitiveZones } : {}) });
  if (response?.result?.isError === true) {
    const text = response.result.content?.find((entry) => entry?.type === "text")?.text;
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    const error = Object.assign(new Error(`real_site_${id}_screenshot_failed`), {
      code: `real_site_${id}_screenshot_failed`,
      productCode: closedResultCode(value),
    });
    throw error;
  }
  const image = response?.result?.content?.find((entry) => entry?.type === "image");
  if (!image || typeof image.data !== "string" || image.data.length < 128) fail(`real_site_${id}_screenshot_missing`);
  const text = response?.result?.content?.find((entry) => entry?.type === "text")?.text;
  let metadata;
  try { metadata = JSON.parse(text); } catch { fail(`real_site_${id}_screenshot_metadata_invalid`); }
  if (sensitiveZones && (metadata?.maskDisposition !== "mask_applied" || metadata?.format !== "png" || image.mimeType !== "image/png")) {
    fail(`real_site_${id}_trusted_mask_missing`);
  }
  return sensitiveZones ? "trusted_masked_png_in_memory" : "captured_in_memory_not_persisted";
}

async function boundedNetworkCount(sessionId, id) {
  const result = await call("browser.network", { sessionId, limit: 80 });
  requireCompleted(result, `real_site_${id}_network_failed`);
  const records = Array.isArray(result.value?.result?.entries) ? result.value.result.entries : [];
  return records.length;
}

function countCategory(count) { return count === 0 ? "zero" : count <= 10 ? "one_to_ten" : count <= 40 ? "eleven_to_forty" : "forty_one_plus"; }

async function call(name, args) {
  const response = await rawCall(name, args);
  const envelope = response?.result;
  const text = envelope?.content?.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") fail("real_site_mcp_result_invalid");
  let value;
  try { value = JSON.parse(text); } catch { fail("real_site_mcp_result_invalid"); }
  return Object.freeze({ envelope, value });
}

async function rawCall(name, args) {
  if (!host) fail("real_site_host_unavailable");
  return handleMcpMessage(host, { jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args, _meta: modernMcpMeta() } });
}

function modernMcpMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
}

function requireCompleted(result, code) {
  if (result.envelope?.isError === true || result.value?.ok === false) {
    const error = Object.assign(new Error(code), { code, productCode: closedResultCode(result.value) });
    throw error;
  }
}
function requireVerifiedAction(result, code) {
  requireCompleted(result, code);
  if (result.value?.status !== "verified") {
    const error = Object.assign(new Error(code), { code, productCode: closedResultCode(result.value) });
    throw error;
  }
}
function retryableFreshTargetFailure(result) {
  if (result.value?.retrySafe !== true) return false;
  return new Set(["stale_target", "target_moved", "not_found"]).has(closedResultCode(result.value));
}
function closedResultCode(value) {
  for (const candidate of [value?.errorCode, value?.reason, value?.status]) {
    if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,59}$/u.test(candidate)) return candidate;
  }
  return "unknown";
}
function safeCode(error) { const candidate = error && typeof error === "object" && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "real_site_qa_failed"; return /^[a-z][a-z0-9_]{0,79}$/u.test(candidate) ? candidate : "real_site_qa_failed"; }
function safeProductCode(error) { const candidate = error && typeof error === "object" && typeof error.productCode === "string" ? error.productCode : ""; return /^[a-z][a-z0-9_]{0,59}$/u.test(candidate) ? candidate : ""; }
function fail(code) { throw Object.assign(new Error(code), { code }); }

function createOwnedRoot() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-real-sites-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeOwnedRoot(ownedRoot) {
  const resolved = fs.realpathSync.native(ownedRoot.root);
  const stat = fs.lstatSync(resolved);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== ownedRoot.root || path.dirname(resolved) !== ownedRoot.parent || !/^newton-real-sites-[^/\\]+$/u.test(path.basename(resolved)) || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ownedRoot.dev || stat.ino !== ownedRoot.ino || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== ownedRoot.nonce) throw new Error("real_site_cleanup_refused");
  fs.rmSync(resolved, { recursive: true });
}
