import { spawn } from "node:child_process";
import fs from "node:fs";

const [outputFile, command, ...args] = process.argv.slice(2);
if (!outputFile || !command || !/^\/tmp\/newton-linux-chrome-live\.[A-Za-z0-9]{6}\/raw-logs\/[a-z0-9-]+\.log$/u.test(outputFile)) {
  throw new Error("bounded_command_invalid_arguments");
}

const CAP = 64 * 1024;
let tail = Buffer.alloc(0);
const append = (chunk) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  tail = bytes.length >= CAP
    ? bytes.subarray(bytes.length - CAP)
    : Buffer.concat([tail, bytes]).subarray(Math.max(0, tail.length + bytes.length - CAP));
};

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", append);
child.stderr.on("data", append);
child.once("error", (error) => {
  append(Buffer.from(`\ncommand_spawn_${safeCode(error)}\n`));
});
const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
fs.writeFileSync(outputFile, tail, { flag: "wx", mode: 0o600 });
if (result.signal) process.exitCode = 1;
else process.exitCode = Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : 1;

function safeCode(error) {
  const value = error && typeof error === "object" && typeof error.code === "string" ? error.code : "failed";
  return /^[A-Z0-9_]{1,40}$/iu.test(value) ? value.toLowerCase() : "failed";
}
