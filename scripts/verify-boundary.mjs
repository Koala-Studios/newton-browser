import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const requiredFiles = [
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/driver/package.json",
  "packages/driver/src/driver.js",
  "apps/extension/package.json",
  "apps/extension/manifest.json",
  "apps/mcp-server/package.json",
  "apps/mcp-server/src/index.ts",
  "scripts/build-extension.mjs",
  "skills/newton-browser/SKILL.md",
  "docs/DECISIONS.md",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`missing required file: ${file}`);
}

const packageChecks = [
  ["packages/core/package.json", "@newton-browser/core"],
  ["packages/driver/package.json", "@newton-browser/driver"],
  ["apps/extension/package.json", "@newton-browser/extension"],
  ["apps/mcp-server/package.json", "newton-browser"],
];
for (const [file, name] of packageChecks) {
  const value = readJson(file);
  if (!value) continue;
  if (value.name !== name) failures.push(`${file}: expected package name ${name}`);
  if (value.engines?.node !== ">=20.0.0") failures.push(`${file}: expected Node >=20.0.0`);
  if (!Array.isArray(value.files) || value.files.length === 0) failures.push(`${file}: missing files allowlist`);
}

const corePackage = readJson("packages/core/package.json");
if (corePackage?.exports?.["."]?.import !== "./dist/index.js") {
  failures.push("packages/core/package.json: public import must point at compiled dist/index.js");
}
const hostPackage = readJson("apps/mcp-server/package.json");
if (hostPackage?.bin?.["newton-browser"] !== "./dist/index.js") {
  failures.push("apps/mcp-server/package.json: bin must point at compiled dist/index.js");
}
if (!hostPackage?.devDependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: missing @newton-browser/core build dependency");
}
if (hostPackage?.dependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: packed executable must bundle core instead of depending on the workspace package");
}

const hostSources = ["apps/mcp-server/src/mcp-server.ts", "apps/mcp-server/src/bridge.ts", "apps/mcp-server/src/floor-gate.ts"]
  .map(readText).join("\n");
if (!hostSources.includes('from "@newton-browser/core"')) {
  failures.push("MCP server must import @newton-browser/core by package name");
}
if (/\.\.\/\.\.\/\.\.\/packages\//.test(hostSources)) {
  failures.push("MCP server contains a cross-package relative source escape");
}
const compiledHost = readText("apps/mcp-server/dist/index.js");
if (compiledHost.includes("@newton-browser/core")) {
  failures.push("compiled MCP bin still imports the workspace core package");
}

const blockedTerms = [
  ["shi", "re"],
  ["her", "mes"],
  ["com", "panion"],
  ["doc", "ket"],
].map((parts) => parts.join(""));
const identitySpecificTerms = [
  ["fr", "ank"],
  ["shop", "ify"],
  ["klavi", "yo"],
  ["face", "book"],
  ["ads ", "manager"],
  ["meta ", "ads"],
  ["standalone ", "browser bridge"],
  ["oper", "ator"],
].map((parts) => parts.join(""));
const blockedExact = ["shared" + ".mjs", "newton_browser_host_" + "policies", "browser_" + "bridge_host_policies"];
const retiredTransport = ["re", "mote"].join("");
const oldPathFragments = [
  ["packages/browser-", "bridge"].join(""),
  ["packages/browser-", "bridge-", "driver"].join(""),
  ["apps/browser-", "bridge-", "extension"].join(""),
  ["apps/browser-", "bridge-", "host"].join(""),
];

for (const file of walk(root)) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const normalized = relative.toLowerCase();
  for (const term of blockedTerms) {
    if (normalized.includes(term)) failures.push(`${relative}: forbidden path term`);
  }
  for (const fragment of oldPathFragments) {
    if (normalized.includes(fragment)) failures.push(`${relative}: extraction-era path remains`);
  }
  if (!isTextFile(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  const lower = text.toLowerCase();
  for (const term of [...blockedTerms, ...identitySpecificTerms, ...blockedExact]) {
    if (lower.includes(term)) failures.push(`${relative}: forbidden standalone-boundary term`);
  }
  for (const fragment of oldPathFragments) {
    if (lower.includes(fragment)) failures.push(`${relative}: extraction-era path remains`);
  }
  if (lower.includes(`"${retiredTransport}"`) && lower.includes("browser_control_transports")) {
    failures.push(`${relative}: retired transport enum remains`);
  }
  if (/"bin"\s*:\s*\{[^}]*\.\/src\/[^"']+\.ts/is.test(text)) {
    failures.push(`${relative}: raw TypeScript package bin remains`);
  }
}

if (failures.length) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}
console.log("newton browser standalone boundary ok");

function readJson(relative) {
  try {
    return JSON.parse(readText(relative));
  } catch (error) {
    failures.push(`${relative}: invalid JSON (${error.message})`);
    return null;
  }
}

function readText(relative) {
  const file = path.join(root, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage", "artifacts"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else yield absolute;
  }
}

function isTextFile(file) {
  return /\.(?:css|html|js|json|md|mjs|ts|yaml|yml)$/.test(file) || /(?:^|\\|\/)\.gitignore$/.test(file);
}
