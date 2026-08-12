import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const owned = createOwnedRoot();
const configDirectory = path.join(owned.root, "Newton direct config with spaces");
fs.mkdirSync(configDirectory, { recursive: true });
const env = {
  ...process.env,
  NEWTON_BROWSER_CONFIG_DIR: configDirectory,
  NEWTON_BROWSER_PROFILE_STORE_DIR: path.join(configDirectory, "identities"),
};
const fixture = http.createServer((_request, response) => {
  response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Newton identity login</title><main>identity-login-ready</main>");
});

let cleanupConfirmed = false;
try {
  const origin = await listen(fixture);
  const setup = await runJson(args.entry, ["setup", "--browser", args.browser], env);
  if (setup?.configured !== true
    || setup?.browserFamily !== args.browser || setup?.identityCreated !== true
    || typeof setup?.identityId !== "string") throw new Error("direct_setup_failed");

  const login = spawn(process.execPath, [args.entry, "identity", "login", setup.identityId, "--origin", origin], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const loginResult = await awaitLogin(login, setup.identityId, args.browser);
  if (loginResult?.status !== "closed" || loginResult?.cleanupConfirmed !== true) {
    throw new Error("direct_setup_login_cleanup_failed");
  }

  const doctor = await runJson(args.entry, ["doctor", "--live"], env);
  if (doctor?.configured !== true || doctor?.runtimeVerified !== true
    || doctor?.cleanupConfirmed !== true || doctor?.browserFamily !== args.browser
    || doctor?.transport !== "private_cdp_pipe"
    || doctor?.containment !== "enabled_before_navigation") {
    throw new Error("direct_setup_doctor_failed");
  }
  cleanupConfirmed = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browserFamily: args.browser,
    setupConfigured: true,
    loginReady: true,
    loginCleanupConfirmed: true,
    liveDoctorVerified: true,
    residue: 0,
  })}\n`);
} finally {
  await close(fixture);
  if (cleanupConfirmed) removeOwnedRoot(owned);
}

function parseArgs(values) {
  let entry = path.resolve("apps/mcp-server/dist/index.js");
  let browser = "chrome";
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === "--entry" && value) entry = path.resolve(value);
    else if (name === "--browser" && (value === "chrome" || value === "edge")) browser = value;
    else throw new Error("direct_setup_smoke_invalid_arguments");
  }
  return Object.freeze({ entry, browser });
}

function runJson(entry, command, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...command], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      if (Buffer.concat(stdout).length + chunk.length <= 256 * 1024) stdout.push(Buffer.from(chunk));
      else child.kill();
    });
    child.stderr.on("data", (chunk) => { stderrBytes = Math.min(256 * 1024 + 1, stderrBytes + chunk.length); });
    child.once("error", () => reject(new Error("direct_setup_child_failed")));
    child.once("close", (code) => {
      if (code !== 0 || stderrBytes > 256 * 1024) { reject(new Error("direct_setup_child_failed")); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { reject(new Error("direct_setup_child_invalid_receipt")); }
    });
  });
}

function awaitLogin(child, identityId, browserFamily) {
  return new Promise((resolve, reject) => {
    const failLogin = (code) => { child.kill(); reject(new Error(code)); };
    let buffer = "";
    let ready = false;
    let finalReceipt = null;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 256 * 1024) { failLogin("direct_setup_login_output_overflow"); return; }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let receipt;
        try { receipt = JSON.parse(line); } catch { failLogin("direct_setup_login_invalid_receipt"); return; }
        if (!ready) {
          if (receipt?.status !== "ready" || receipt?.identityId !== identityId
            || receipt?.browserFamily !== browserFamily || receipt?.grantedOriginCount !== 1) {
            failLogin("direct_setup_login_not_ready"); return;
          }
          ready = true;
          child.stdin.end();
        } else finalReceipt = receipt;
      }
    });
    child.stderr.on("data", (chunk) => { stderrBytes = Math.min(256 * 1024 + 1, stderrBytes + chunk.length); });
    child.once("error", () => reject(new Error("direct_setup_login_failed")));
    child.once("close", (code) => {
      if (!ready || code !== 0 || stderrBytes > 256 * 1024) reject(new Error("direct_setup_login_failed"));
      else resolve(finalReceipt);
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("direct_setup_fixture_failed"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function createOwnedRoot() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-setup-live-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeOwnedRoot(ownedRoot) {
  const stat = fs.lstatSync(ownedRoot.root);
  const resolved = fs.realpathSync.native(ownedRoot.root);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== ownedRoot.root || path.dirname(resolved) !== ownedRoot.parent
    || !path.basename(resolved).startsWith("newton-direct-setup-live-")
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ownedRoot.dev || stat.ino !== ownedRoot.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink()
    || fs.readFileSync(marker, "utf8") !== ownedRoot.nonce) throw new Error("direct_setup_cleanup_refused");
  fs.rmSync(resolved, { recursive: true });
}
