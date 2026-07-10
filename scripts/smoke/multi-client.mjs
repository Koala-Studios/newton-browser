import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const tarball = path.resolve(`artifacts/browser-bridge-mcp-${version}.tgz`);
if (!fs.existsSync(tarball)) throw new Error("run pnpm pack:check first");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-multi-client with spaces "));

try {
  const installs = await Promise.all(["codex", "claude"].map(async (client) => {
    const directory = path.join(temp, `${client} install`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `${client}-packed-check`, private: true }));
    await run("npm", ["install", "--ignore-scripts", tarball], directory, true);
    return { client, directory, entry: path.join(directory, "node_modules", "browser-bridge-mcp", "dist", "index.js") };
  }));
  const results = await Promise.all(installs.map((install, index) => run(process.execPath, [
    path.join(root, "scripts", "smoke", "packed-stdio.mjs"),
    "--entry", install.entry,
    "--config-dir", path.join(install.directory, "config"),
    "--port", String(18641 + index),
  ], root, false)));
  if (results.some((result) => !result.includes('"ok":true'))) throw new Error("one packed client failed its browser task");
  process.stdout.write(`${JSON.stringify({ ok: true, concurrentClients: installs.map((item) => item.client), isolatedHosts: 2, packedArtifact: path.basename(tarball) })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function run(command, args, cwd, useShell) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && useShell });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
