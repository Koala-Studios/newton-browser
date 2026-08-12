import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("release and live suites use only the direct owned-browser runtime", () => {
  const packageJson = read("package.json");
  const release = read("scripts/release-check.mjs");
  const complete = read("scripts/release-complete-local.mjs");
  const suite = read("scripts/smoke/direct-live-suite.mjs");
  for (const [file, source] of [["package.json", packageJson], ["release-check", release], ["release-complete", complete], ["direct-suite", suite]]) {
    assert.doesNotMatch(source, /extension:|apps\/extension|build-extension|extension_legacy|NEWTON_BROWSER_RUNTIME_MODE/u, file);
  }
  assert.match(suite, /direct_runtime/u);
  assert.match(suite, /direct_origin_containment/u);
  assert.match(suite, /direct_input/u);
  assert.match(suite, /packed_direct_runtime/u);
  assert.match(complete, /eval:direct-live/u);
  assert.match(complete, /eval:real-sites/u);
});

test("shared live fixtures construct a direct host and clean it", () => {
  for (const file of [
    "test/fixtures/input-reliability/live-harness.mjs",
    "scripts/smoke/frame-target-churn-live.mjs",
    "scripts/smoke/origin-containment-live.mjs",
  ]) {
    const source = read(file);
    assert.match(source, /create(?:Default|Configured)DirectBrowserHost/u, file);
    assert.match(source, /await bridge\??\.stopAll|await bridge\.stopAll/u, file);
    assert.match(source, /await bridge\??\.close|await bridge\.close/u, file);
    assert.doesNotMatch(source, /extension|NEWTON_BROWSER_RUNTIME_MODE/u, file);
  }
  const containment = read("scripts/smoke/origin-containment-live.mjs");
  assert.match(containment, /errorCode === "direct_cleanup_uncertain"/u);
  assert.match(containment, /stopped = await mcp\("browser\.session\.stop"/u);
});

test("real-site QA covers four unauthenticated production sites and trusted masking on Shopify", () => {
  const source = read("scripts/smoke/direct-real-sites-live.mjs");
  assert.match(source, /origin: "https:\/\/www\.rfc-editor\.org"/u);
  assert.match(source, /if \(site\.url\) \{/u);
  assert.match(source, /en\.wikipedia\.org/u);
  assert.match(source, /mercatodibellina\.com/u);
  assert.match(source, /www\.w3\.org\/WAI/u);
  assert.match(source, /trusted_masked_png_in_memory/u);
  assert.match(source, /maskDisposition !== "mask_applied"/u);
  assert.doesNotMatch(source, /classifyMeta|classifyYouTube|login_required|authenticated_shell/u);
  assert.match(source, /const initialMode = await requireUsefulOrText\(sessionId, initial, site\.id/u);
});

test("authorized profile QA makes no authentication claim and always cleans its owned identity", () => {
  const sites = read("scripts/smoke/direct-real-sites-live.mjs");
  const profile = read("scripts/smoke/direct-profile-import-live.mjs");
  assert.match(sites, /operator_identity_read_only/u);
  assert.match(sites, /authenticatedSiteQaAttempted: false/u);
  assert.match(profile, /authenticationPreservationClaimed: false/u);
  assert.match(profile, /observedSiteResults\.length !== 4/u);
  assert.match(profile, /finally \{/u);
  assert.match(profile, /dispatchIdentityCommand\(\{ store \}, \["delete"/u);
  assert.match(profile, /cleanupConfirmed/u);
  assert.doesNotMatch(profile, /password|cookie|storage/iu);
});

test("live page-input QA avoids browser-reserved function shortcuts", () => {
  const source = read("scripts/smoke/input-reliability-live.mjs");
  assert.match(source, /\["F2"\]/u);
  assert.doesNotMatch(source, /\["F12"\]/u);
  assert.match(read("packages/driver/test/input-dispatcher.test.js"), /keyDescriptor\("F12"/u);
});
