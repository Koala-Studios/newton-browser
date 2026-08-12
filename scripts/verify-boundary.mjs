import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const requiredFiles = [
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/driver/package.json",
  "packages/driver/src/driver.ts",
  "apps/mcp-server/package.json",
  "apps/mcp-server/src/index.ts",
  "apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts",
  "packages/driver/src/direct-session-runtime.ts",
  "skills/newton-browser/SKILL.md",
  "docs/DECISIONS.md",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`missing required file: ${file}`);
}

const packageChecks = [
  ["packages/core/package.json", "@newton-browser/core"],
  ["packages/driver/package.json", "@newton-browser/driver"],
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
const serverRecord = readJson("server.json");
if (hostPackage?.bin?.["newton-browser"] !== "./dist/index.js") {
  failures.push("apps/mcp-server/package.json: bin must point at compiled dist/index.js");
}
if (!hostPackage?.devDependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: missing @newton-browser/core build dependency");
}
if (hostPackage?.dependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: packed executable must bundle core instead of depending on the workspace package");
}
if (serverRecord?.name !== hostPackage?.mcpName) {
  failures.push("server.json: name must exactly match apps/mcp-server/package.json mcpName");
}
const repositoryOwner = hostPackage?.repository?.url?.match(/github\.com[/:]([^/]+)\//)?.[1];
if (!repositoryOwner || !hostPackage?.mcpName?.startsWith(`io.github.${repositoryOwner}/`)) {
  failures.push("apps/mcp-server/package.json: mcpName must preserve the canonical GitHub owner casing");
}

const hostSources = ["apps/mcp-server/src/mcp-server.ts", "apps/mcp-server/src/floor-gate.ts", "apps/mcp-server/src/browser-runtime/direct-browser-host.ts"]
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
].map((parts) => parts.join(""));
const identitySpecificQaFiles = new Set([
  "scripts/smoke/direct-real-sites-live.mjs",
  "test/direct-live-config.test.mjs",
  "test/evidence/qa-real-sites.json",
  "test/live-smoke-config.test.mjs",
]);
const blockedExact = ["shared" + ".mjs", "newton_browser_host_" + "policies", "browser_" + "bridge_host_policies"];
const retiredTransport = ["re", "mote"].join("");
const oldPathFragments = [
  ["packages/browser-", "bridge"].join(""),
  ["packages/browser-", "bridge-", "driver"].join(""),
  ["apps/browser-", "bridge-", "extension"].join(""),
  ["apps/browser-", "bridge-", "host"].join(""),
];
const removedArchitecturePaths = [
  "apps/extension",
  "apps/mcp-server/src/bridge.ts",
  "packages/driver/src/chrome-tabs-port.ts",
  "packages/driver/src/controller.ts",
  "scripts/build-extension.mjs",
  "scripts/build-extension-artifact.mjs",
  "apps/mcp-server/src/browser-runtime/cdp-websocket.ts",
];
for (const relative of removedArchitecturePaths) {
  if (fs.existsSync(path.join(root, relative))) failures.push(`${relative}: removed extension architecture path remains`);
}
const rootPackage = readJson("package.json");
for (const name of Object.keys(rootPackage?.scripts ?? {})) {
  const command = String(rootPackage.scripts[name]);
  if (/extension|build-extension|packed-stdio|current-tab|worker-restart/u.test(`${name} ${command}`)) {
    failures.push(`package.json: legacy extension script remains (${name})`);
  }
}

const mcpContractSource = readText("apps/mcp-server/src/mcp-contract.ts");
const mcpServerSource = readText("apps/mcp-server/src/mcp-server.ts");
for (const requiredTool of ["browser.sessions.list", "browser.session.finalize"]) {
  if (!mcpContractSource.includes(`"${requiredTool}"`) || !mcpServerSource.includes(`"${requiredTool}"`)) {
    failures.push(`direct-only public tool missing: ${requiredTool}`);
  }
}
for (const retiredTool of ["browser.tabs.list", "browser.tabs.finalize"]) {
  if (mcpContractSource.includes(retiredTool) || mcpServerSource.includes(retiredTool)) {
    failures.push(`retired public tool remains: ${retiredTool}`);
  }
}
if (/\btransport\s*:/u.test(mcpServerSource.slice(mcpServerSource.indexOf("export function toolList")))) {
  failures.push("public MCP tool schemas must not expose a transport selector");
}
if (!mcpContractSource.includes('NEWTON_BROWSER_CONTRACT_VERSION = "2.0"')) {
  failures.push("direct-only MCP contract must be version 2.0");
}

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
  const forbiddenTerms = identitySpecificQaFiles.has(relative)
    ? [...blockedTerms, ...blockedExact]
    : [...blockedTerms, ...identitySpecificTerms, ...blockedExact];
  for (const term of forbiddenTerms) {
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
