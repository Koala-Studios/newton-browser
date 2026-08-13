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
  "scripts/release-three-pass.mjs",
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
  if (value.engines?.node !== ">=24.0.0") failures.push(`${file}: expected Node >=24.0.0`);
  if (!Array.isArray(value.files) || value.files.length === 0) failures.push(`${file}: missing files allowlist`);
}

const corePackage = readJson("packages/core/package.json");
if (corePackage?.private !== true) failures.push("packages/core/package.json: internal package must remain private");
if (corePackage?.exports?.["."]?.import !== "./dist/index.js") {
  failures.push("packages/core/package.json: public import must point at compiled dist/index.js");
}
const hostPackage = readJson("apps/mcp-server/package.json");
const driverPackage = readJson("packages/driver/package.json");
const rootPackage = readJson("package.json");
if (driverPackage?.private !== true) failures.push("packages/driver/package.json: internal package must remain private");
if (rootPackage?.version !== hostPackage?.version) failures.push("workspace and shipped MCP versions diverge");
if (hostPackage?.bin?.["newton-browser"] !== "./dist/index.js") {
  failures.push("apps/mcp-server/package.json: bin must point at compiled dist/index.js");
}
if (!hostPackage?.devDependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: missing @newton-browser/core build dependency");
}
if (hostPackage?.dependencies?.["@newton-browser/core"]) {
  failures.push("apps/mcp-server/package.json: packed executable must bundle core instead of depending on the workspace package");
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
  ".github/workflows/pages.yml",
  "apps/extension",
  "apps/mcp-server/src/bridge.ts",
  "packages/driver/src/chrome-tabs-port.ts",
  "packages/driver/src/controller.ts",
  "scripts/build-extension.mjs",
  "scripts/build-extension-artifact.mjs",
  "apps/mcp-server/src/browser-runtime/cdp-websocket.ts",
  "apps/mcp-server/src/mcp-frame-parser.ts",
  "apps/mcp-server/src/persistent-mcp.ts",
  "packages/driver/src/direct-page-effects-port.ts",
  "packages/driver/src/session-transaction.ts",
  "packages/core/dist/version-skew.js",
  "packages/core/dist/version-skew.d.ts",
  "packages/driver/dist/direct-page-effects-port.js",
  "packages/driver/dist/direct-page-effects-port.d.ts",
  "packages/driver/dist/session-transaction.js",
  "packages/driver/dist/session-transaction.d.ts",
  "site",
];
for (const relative of removedArchitecturePaths) {
  if (fs.existsSync(path.join(root, relative))) failures.push(`${relative}: removed architecture or publication path remains`);
}
validateFlatCompiledOutput("packages/core/src", "packages/core/dist", { declarationOnly: new Set() });
validateFlatCompiledOutput("packages/driver/src", "packages/driver/dist", { declarationOnly: new Set(["types"]) });
validateExactFlatOutput("apps/mcp-server/dist", new Set(["browser-guardian.js", "index.js"]));
if (fs.existsSync(path.join(root, "server.json")) || hostPackage?.mcpName !== undefined) {
  failures.push("public MCP registry metadata requires separate publication approval");
}
for (const name of Object.keys(rootPackage?.scripts ?? {})) {
  const command = String(rootPackage.scripts[name]);
  if (/extension|build-extension|packed-stdio|current-tab|worker-restart/u.test(`${name} ${command}`)) {
    failures.push(`package.json: legacy extension script remains (${name})`);
  }
}
for (const alias of ["eval:live", "release:complete-local"]) {
  if (rootPackage?.scripts?.[alias] !== undefined) failures.push(`package.json: redundant command alias remains (${alias})`);
}
if (readText("apps/mcp-server/src/cli.ts").includes("config print")) {
  failures.push("CLI retains the removed config print alias");
}

const mcpContractSource = readText("apps/mcp-server/src/mcp-contract.ts");
const mcpServerSource = readText("apps/mcp-server/src/mcp-server.ts");
for (const requiredTool of ["browser.sessions.list", "browser.session.stop"]) {
  if (!mcpContractSource.includes(`"${requiredTool}"`) || !mcpServerSource.includes(`"${requiredTool}"`)) {
    failures.push(`direct-only public tool missing: ${requiredTool}`);
  }
}
if (/\btransport\s*:/u.test(mcpServerSource.slice(mcpServerSource.indexOf("export function toolList")))) {
  failures.push("public MCP tool schemas must not expose a transport selector");
}
if (!mcpServerSource.includes('method === "server/discover"') || mcpServerSource.includes('method === "initialize"')) {
  failures.push("MCP server must implement only modern stateless discovery");
}
const modernStdioSource = readText("apps/mcp-server/src/modern-mcp-stdio.ts");
if (/protocolError\(null/u.test(modernStdioSource) || modernStdioSource.includes("id: JsonRpcId | null")) {
  failures.push("modern MCP errors retain legacy null request IDs");
}
if (readText("scripts/measure-agent-cost.mjs").includes("AGENT_OUTPUT_TOKEN_COUNTER")
  || readText("scripts/evals/token-budget.mjs").includes("utf8_byte_upper_bound")) {
  failures.push("agent-cost gate retains a tokenizer override or heuristic fallback");
}
if (readText("apps/mcp-server/src/floor-gate.ts").includes("loadHostPolicies")) {
  failures.push("command floor reloads process-global host policy");
}
const unsupportedVersionBlock = mcpServerSource.slice(
  mcpServerSource.indexOf('if (requested !== MODERN_MCP_PROTOCOL_VERSION)'),
  mcpServerSource.indexOf('if (!isObject(metadata["io.modelcontextprotocol/clientCapabilities"]))'),
);
if (unsupportedVersionBlock.includes("errorCode")) {
  failures.push("unsupported-version error data exceeds the modern MCP schema");
}
for (const retired of ["browser.session.finalize", "hostInstanceId", "instanceLabel", "syntheticTabId", "ownsTab", "ownsBrowser", "pageEffectsPort"]) {
  if (hostSources.includes(retired) || mcpServerSource.includes(retired)) failures.push(`production host retains retired contract: ${retired}`);
}
for (const retired of ["loadDirectBrowserConfig", "writeDirectBrowserConfig", "NEWTON_BROWSER_IDENTITY_ID"]) {
  if (hostSources.includes(retired) || readText("apps/mcp-server/src/config.ts").includes(retired)) {
    failures.push(`production host retains implicit identity configuration: ${retired}`);
  }
}
for (const retired of ["additionalArgs", "chromiumAdditionalArgs"]) {
  if (hostSources.includes(retired)
    || readText("apps/mcp-server/src/browser-runtime/chromium-process.ts").includes(retired)
    || readText("apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts").includes(retired)
    || readText("apps/mcp-server/src/browser-runtime/configured-direct-host.ts").includes(retired)) {
    failures.push(`production browser launch retains arbitrary switch injection: ${retired}`);
  }
}
const chromiumSource = readText("apps/mcp-server/src/browser-runtime/chromium-process.ts");
if (chromiumSource.includes("browser-guardian.ts") || chromiumSource.includes("--experimental-strip-types")) {
  failures.push("production browser launch retains a raw-TypeScript guardian fallback");
}
const publicDecisionSource = mcpServerSource.slice(
  mcpServerSource.indexOf("function publicDecision"),
  mcpServerSource.indexOf("function strongestDecision"),
);
if (/\breasons\s*:/u.test(publicDecisionSource)) {
  failures.push("public decisions must expose one bounded reason, not an internal reasons array");
}
if (mcpServerSource.includes("redactBrowserResult(result) ?? result")) {
  failures.push("MCP redaction boundary contains a raw-result fallback");
}
if (readText("packages/core/src/action-json-schema.ts").includes('value: { type: "string" }')) {
  failures.push("public action values must have an explicit length bound");
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

function validateFlatCompiledOutput(sourceRelative, outputRelative, { declarationOnly }) {
  const source = path.join(root, sourceRelative);
  const output = path.join(root, outputRelative);
  if (!fs.existsSync(output)) return;
  const expected = new Set();
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const base = entry.name.slice(0, -3);
    expected.add(`${base}.d.ts`);
    if (!declarationOnly.has(base)) expected.add(`${base}.js`);
  }
  validateExactFlatOutput(outputRelative, expected);
}

function validateExactFlatOutput(outputRelative, expected) {
  const output = path.join(root, outputRelative);
  if (!fs.existsSync(output)) return;
  const actual = fs.readdirSync(output, { withFileTypes: true });
  for (const entry of actual) {
    if (!entry.isFile() || !expected.has(entry.name)) {
      failures.push(`${outputRelative}/${entry.name}: stale or unexpected compiled output`);
    }
  }
  for (const name of expected) {
    if (!actual.some((entry) => entry.isFile() && entry.name === name)) {
      failures.push(`${outputRelative}/${name}: compiled output missing`);
    }
  }
}
