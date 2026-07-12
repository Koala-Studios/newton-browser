import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("release workflow reconciles partial releases and publishes the verified tarball", () => {
  const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /git checkout --detach "\$release_tag"/);
  assert.match(workflow, /gh release view "\$RELEASE_TAG"/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"[\s\S]+--clobber/);
  assert.match(
    workflow,
    /npm publish "\.\/artifacts\/newton-browser-\$\{version\}\.tgz" --access public --provenance/,
  );
});
