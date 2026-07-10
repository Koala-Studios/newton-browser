import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixture = await startFixtureServers({ port: 18251, crossOriginPort: 18252 });
const browserTarget = process.env.BROWSER_BRIDGE_QA_OWNER === "chrome" ? "chrome" : "edge";
const requestedClients = String(process.env.BROWSER_BRIDGE_REAL_CLIENTS ?? "codex,claude").split(",").map((value) => value.trim().toLowerCase()).filter((value) => ["codex", "claude"].includes(value));
if (requestedClients.length === 0) throw new Error("BROWSER_BRIDGE_REAL_CLIENTS must include codex or claude");
const tarball = path.resolve("artifacts/browser-bridge-mcp-0.1.0.tgz");
const transcriptPath = path.resolve(`artifacts/real-client-transcripts-${browserTarget}-${requestedClients.join("-")}.json`);
const mcpConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-real-clients-")), "mcp.json");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const mcpServer = {
  command: npxCommand,
  args: ["--yes", "--package", tarball, "browser-bridge-mcp"],
  env: { BROWSER_BRIDGE_BROWSER: browserTarget, BROWSER_BRIDGE_AUTH_MODE: "local_trust" },
};
fs.writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: { "browser-bridge-qa": mcpServer } }, null, 2)}\n`);
const task = (label) => `Authorized deterministic Browser Bridge release QA for ${label}. Use only the browser tools from browser-bridge-qa. Call browser.status once, then ALWAYS start an owned_group session at exact origin ${fixture.origin}, even if status initially reports extension_disconnected. In that session: observe and extract the fixture-ready marker; fill Search records with exact value ${label.toLowerCase()}-needle; click Run fixture search and verify exact visible text search-result:${label.toLowerCase()}-needle; take a full-page screenshot with delivery=image and confirm you received visible non-empty image metadata/content; then finalize the session with close. Return exactly three lines: ${label}_CLIENT_OK, ${label}_SEARCH_RESULT=search-result:${label.toLowerCase()}-needle, ${label}_SCREENSHOT_OK. Do not use shell, filesystem, web search, or any other browser implementation.`;

try {
  const jobs = [];
  if (requestedClients.includes("codex")) jobs.push({ client: "codex", promise: run("codex", [
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "-c", `mcp_servers.browser-bridge-qa.command=${JSON.stringify(mcpServer.command)}`,
      "-c", `mcp_servers.browser-bridge-qa.args=${JSON.stringify(mcpServer.args)}`,
      "-c", `mcp_servers.browser-bridge-qa.env.BROWSER_BRIDGE_BROWSER=${JSON.stringify(browserTarget)}`,
      "-c", 'mcp_servers.browser-bridge-qa.env.BROWSER_BRIDGE_AUTH_MODE="local_trust"',
      "-c", 'mcp_servers.browser-bridge-qa.default_tools_approval_mode="approve"',
      "-C", process.cwd(), task("CODEX"),
    ]) });
  if (requestedClients.includes("claude")) jobs.push({ client: "claude", promise: run("claude", [
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--print",
    "--dangerously-skip-permissions",
    "--allowedTools", [
      "mcp__browser-bridge-qa__browser_status",
      "mcp__browser-bridge-qa__browser_session_start",
      "mcp__browser-bridge-qa__browser_observe",
      "mcp__browser-bridge-qa__browser_act",
      "mcp__browser-bridge-qa__browser_screenshot",
      "mcp__browser-bridge-qa__browser_tabs_finalize",
    ].join(","),
    "--verbose",
    "--output-format", "stream-json",
    task("CLAUDE"),
  ]) });
  const settled = await Promise.allSettled(jobs.map((job) => job.promise));
  const outputs = Object.fromEntries(settled.map((result, index) => [
    jobs[index].client,
    result.status === "fulfilled" ? result.value : { stdout: "", stderr: result.reason?.message ?? String(result.reason) },
  ]));
  const failures = [];
  for (const client of requestedClients) {
    const label = client.toUpperCase();
    const value = outputs[client];
    for (const marker of [`${label}_CLIENT_OK`, `${label}_SEARCH_RESULT=search-result:${label.toLowerCase()}-needle`, `${label}_SCREENSHOT_OK`]) {
      if (!value.stdout.includes(marker)) failures.push({ client: label.toLowerCase(), missing: marker, stdout: value.stdout, stderr: value.stderr });
    }
  }
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ browserTarget, fixture: fixture.origin, clients: outputs }, null, 2)}\n`);
  if (failures.length > 0) throw new Error(`Real-client batch failures:\n${JSON.stringify(failures, null, 2)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, concurrent: requestedClients.length > 1, clients: requestedClients, browserTarget, fixture: fixture.origin, transcriptPath })}\n`);
} finally {
  await fixture.close();
  fs.rmSync(path.dirname(mcpConfigPath), { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} real-client task timed out`)); }, Number(process.env.BROWSER_BRIDGE_REAL_CLIENT_TIMEOUT_MS ?? 300_000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
