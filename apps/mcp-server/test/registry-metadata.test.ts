import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("registry name matches npm metadata and canonical GitHub owner casing", () => {
  const packageJson = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8"));
  const serverJson = JSON.parse(fs.readFileSync("server.json", "utf8"));
  const owner = packageJson.repository.url.match(/github\.com[/:]([^/]+)\//)?.[1];

  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0].version, packageJson.version);
  assert.ok(owner, "package repository must identify a GitHub owner");
  assert.ok(
    packageJson.mcpName.startsWith(`io.github.${owner}/`),
    "mcpName must preserve GitHub's canonical owner casing for Registry authorization",
  );
});
