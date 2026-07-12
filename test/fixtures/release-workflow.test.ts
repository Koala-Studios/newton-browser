import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("release workflow reconciles partial releases and publishes the verified tarball", () => {
  const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /gh release view "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME"[\s\S]+--clobber/);
  assert.match(
    workflow,
    /npm publish "artifacts\/newton-browser-\$\{version\}\.tgz" --access public --provenance/,
  );
});
