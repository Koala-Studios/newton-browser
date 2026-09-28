import fs from "node:fs";

/** The package's own version and Node engine, read once from the package manifest beside the build. */
export const PACKAGE_METADATA = packageMetadata();
export const NEWTON_BROWSER_VERSION = PACKAGE_METADATA.version;

function packageMetadata(): Readonly<{ version: string; nodeRange: string; nodeMajor: number }> {
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("invalid_package_version");
  }
  const engines = manifest?.engines;
  const nodeRange = engines && typeof engines === "object" && !Array.isArray(engines)
    ? (engines as Record<string, unknown>).node
    : undefined;
  const match = typeof nodeRange === "string" ? /^>=(\d+)\.0\.0$/u.exec(nodeRange) : null;
  const nodeMajor = match ? Number(match[1]) : Number.NaN;
  if (typeof nodeRange !== "string" || !match || !Number.isSafeInteger(nodeMajor) || nodeMajor < 1) throw new Error("invalid_package_node_engine");
  return Object.freeze({ version, nodeRange, nodeMajor });
}
