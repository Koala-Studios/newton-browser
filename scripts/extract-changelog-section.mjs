import fs from "node:fs";

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) throw new Error("expected a release tag such as v0.4.0");
const version = tag.slice(1);
const changelog = fs.readFileSync("CHANGELOG.md", "utf8").replaceAll("\r\n", "\n");
const heading = new RegExp(`^## \\[${escapeRegex(version)}\\](?: - .*)?$`, "m");
const match = heading.exec(changelog);
if (!match || match.index === undefined) throw new Error(`CHANGELOG.md has no section for ${version}`);
const start = match.index;
const next = changelog.indexOf("\n## ", start + match[0].length);
process.stdout.write(`${changelog.slice(start, next < 0 ? undefined : next).trim()}\n`);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
