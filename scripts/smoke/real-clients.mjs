import { spawn } from "node:child_process";

import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixture = await startFixtureServers({ port: 18251, crossOriginPort: 18252 });
const task = (label) => `Authorized read-only Browser Bridge release QA for ${label}. Use only the browser tools from browser-bridge-qa. Call browser.status once for diagnostics, then ALWAYS call browser.session.start for an owned_group session at exact origin ${fixture.origin}, even if status initially reports extension_disconnected; session.start owns the bounded cold-discovery wait. Observe the page, verify the marker fixture-ready, finalize the session with close, and return exactly ${label}_CLIENT_OK. Do not stop after status, do not use shell/filesystem/web search, and do not use any other browser implementation.`;

try {
  const settled = await Promise.allSettled([
    run("codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-c", 'mcp_servers.browser-bridge-qa.default_tools_approval_mode="approve"', "-C", process.cwd(), task("CODEX")]),
    run("claude", ["--print", "--permission-mode", "auto", task("CLAUDE")]),
  ]);
  const [codex, claude] = settled.map((result) => result.status === "fulfilled" ? result.value : { stdout: "", stderr: result.reason?.message ?? String(result.reason) });
  const failures = [];
  if (!codex.stdout.includes("CODEX_CLIENT_OK")) failures.push({ client: "codex", stdout: codex.stdout, stderr: codex.stderr });
  if (!claude.stdout.includes("CLAUDE_CLIENT_OK")) failures.push({ client: "claude", stdout: claude.stdout, stderr: claude.stderr });
  if (failures.length > 0) throw new Error(`Real-client batch failures:\n${JSON.stringify(failures, null, 2)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, concurrent: true, clients: ["codex", "claude"], fixture: fixture.origin })}\n`);
} finally {
  await fixture.close();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} real-client task timed out`)); }, 180_000);
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
