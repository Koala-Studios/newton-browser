import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProfileSourceClosureVerifier } from "../../apps/mcp-server/src/browser-runtime/profile-closure.ts";
import { dispatchIdentityCommand } from "../../apps/mcp-server/src/browser-runtime/identity-cli.ts";
import { openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";

const family = process.env.NEWTON_BROWSER_QA_PROFILE_BROWSER;
const sourceRoot = process.env.NEWTON_BROWSER_QA_PROFILE_ROOT;
const profileDirectory = process.env.NEWTON_BROWSER_QA_PROFILE_DIRECTORY;
let owned = null;
let storePath = null;
let store = null;
let identityId = null;
let imported = false;
let qaPassed = false;
let identityRemoved = false;
let failureCode = null;
let cleanupConfirmed = false;
let observedSiteResults = [];

try {
  if ((family !== "chrome" && family !== "edge") || !sourceRoot || !path.isAbsolute(sourceRoot)
    || !profileDirectory || profileDirectory.length > 256 || profileDirectory.includes("\0")) {
    fail("profile_import_authorization_missing");
  }
  owned = createOwnedRoot();
  storePath = path.join(owned.root, "identities");
  store = openProfileStore(storePath);
  const importedIdentity = dispatchIdentityCommand({
    store,
    sourceClosureVerifier: createProfileSourceClosureVerifier({ browserFamily: family }),
  }, ["import", "--browser", family, "--user-data-root", sourceRoot, "--profile-directory", profileDirectory]);
  if (!importedIdentity || Array.isArray(importedIdentity) || !("id" in importedIdentity)
    || typeof importedIdentity.id !== "string" || !/^nbi_[a-f0-9]{32}$/u.test(importedIdentity.id)
    || !("source" in importedIdentity) || importedIdentity.source !== "opaque_import") {
    fail("profile_import_receipt_invalid");
  }
  identityId = importedIdentity.id;
  imported = true;

  const child = await runRealSites({
    ...process.env,
    NEWTON_BROWSER_QA_BROWSER: family,
    NEWTON_BROWSER_REAL_SITE_IDENTITY_ID: identityId,
    NEWTON_BROWSER_REAL_SITE_PROFILE_STORE: storePath,
  });
  observedSiteResults = safeSiteResults(child.receipt?.sites);
  if (child.code !== 0 || child.receipt?.ok !== true || child.receipt?.persistentIdentityRequested !== true
    || child.receipt?.persistentIdentityQa !== true || child.receipt?.authenticationPreservationClaimed !== false
    || observedSiteResults.length !== 7 || observedSiteResults.some((site) => site.status !== "passed")) {
    fail("profile_import_read_only_qa_failed");
  }
  qaPassed = true;

  dispatchIdentityCommand({ store }, ["delete", "--id", identityId]);
  identityRemoved = true;
  removeOwnedRoot(owned);
  cleanupConfirmed = true;
} catch (error) {
  failureCode = safeCode(error);
  process.exitCode = 1;
} finally {
  if (store && identityId && !identityRemoved) {
    try {
      dispatchIdentityCommand({ store }, ["delete", "--id", identityId]);
      identityRemoved = true;
    } catch {
      failureCode = "profile_import_cleanup_failed";
    }
  }
  if (owned && (!identityId || identityRemoved) && fs.existsSync(owned.root)) {
    try {
      removeOwnedRoot(owned);
      cleanupConfirmed = true;
    } catch {
      failureCode = "profile_import_cleanup_failed";
    }
  }
  const ok = failureCode === null && imported && qaPassed && identityRemoved && cleanupConfirmed;
  process.stdout.write(`${JSON.stringify(ok ? {
    ok: true,
    browserFamily: family,
    importedOpaqueIdentity: true,
    publicReadOnlyQa: true,
    authenticationPreservationClaimed: false,
    identityRemoved: true,
    opaqueByteCopyPerformed: true,
    sourceMutationAttempted: false,
    sourceContentsParsedOrLogged: false,
    cleanupConfirmed: true,
    siteCount: observedSiteResults.length,
  } : {
    ok: false,
    browserFamily: family,
    errorCode: failureCode ?? "profile_import_live_failed",
    importedOpaqueIdentity: imported,
    publicReadOnlyQa: qaPassed,
    authenticationPreservationClaimed: false,
    identityRemoved: imported ? identityRemoved : true,
    cleanupConfirmed,
    observedSiteResults,
  })}\n`);
  if (!ok) process.exitCode = 1;
}

function runRealSites(env) {
  return new Promise((resolve, reject) => {
    let stdoutTail = "";
    const child = spawn(process.execPath, [path.resolve("scripts/smoke/direct-real-sites-live.mjs")], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => { stdoutTail = `${stdoutTail}${chunk}`.slice(-64 * 1024); });
    child.once("error", reject);
    child.once("close", (code) => {
      const lines = stdoutTail.trim().split(/\r?\n/u).reverse();
      let receipt = null;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") { receipt = parsed; break; }
        } catch {}
      }
      resolve({ code: code ?? 1, receipt });
    });
  });
}

function createOwnedRoot() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-profile-import-live-")));
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
  if (resolved !== ownedRoot.root || path.dirname(resolved) !== ownedRoot.parent
    || !/^newton-profile-import-live-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ownedRoot.dev || stat.ino !== ownedRoot.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== ownedRoot.nonce) {
    fail("profile_import_cleanup_refused");
  }
  fs.rmSync(resolved, { recursive: true });
}

function safeCode(error) {
  const value = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "profile_import_live_failed";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : "profile_import_live_failed";
}

function safeSiteResults(sites) {
  if (!Array.isArray(sites)) return [];
  const allowedIds = new Set([
    "rfc_editor",
    "wikipedia",
    "youtube_public",
    "reddit_public",
    "mercato_storefront",
    "w3c_accessibility",
    "meta_ads_public",
  ]);
  return sites.flatMap((site) => {
    if (!allowedIds.has(site?.id) || (site?.status !== "passed" && site?.status !== "failed")) return [];
    const errorCode = typeof site.errorCode === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(site.errorCode)
      ? site.errorCode
      : undefined;
    const productCode = typeof site.productCode === "string" && /^[a-z][a-z0-9_]{0,59}$/u.test(site.productCode)
      ? site.productCode
      : undefined;
    return [{ id: site.id, status: site.status, ...(errorCode ? { errorCode } : {}), ...(productCode ? { productCode } : {}) }];
  });
}

function fail(code) { throw Object.assign(new Error(code), { code }); }
