import { spawnSync } from "node:child_process";
import net from "node:net";

for (const command of ["lint", "typecheck", "test", "build", "extension:artifact", "pack:check", "smoke:quick", "smoke:matrix", "smoke:chaos", "smoke:multi-client", "smoke:clean-user"]) {
  const executable = process.env.npm_execpath ? process.execPath : "pnpm";
  const args = process.env.npm_execpath ? [process.env.npm_execpath, command] : [command];
  const timeout = command === "smoke:chaos" ? 420_000 : 300_000;
  const result = spawnSync(executable, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`release stage ${command} failed (${result.status})`);
}
const occupied = [];
for (let port = 17321; port <= 17340; port += 1) if (await canConnect(port)) occupied.push(port);
if (occupied.length) throw new Error(`orphan Browser Bridge host ports remain: ${occupied.join(", ")}`);
process.stdout.write(`${JSON.stringify({ ok: true, stages: 11, orphanHostPorts: 0 })}\n`);

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(150, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
