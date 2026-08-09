import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { startFixtureServers } from "./fixtures/server.mjs";

test("containment fixture counts destination application effects separately from read-only resources", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  fixture.containment.reset();
  const resource = await fetch(`${fixture.crossOrigin}/origin-containment/resource/pixel.svg`);
  assert.equal(resource.status, 200);
  assert.equal((await resource.text()).includes("<svg"), true);
  assert.deepEqual(fixture.containment.snapshot(), {
    destinationApplicationRequests: 0,
    destinationResourceRequests: 1,
    entries: [{
      sequence: 1,
      originRole: "destination",
      method: "GET",
      pathname: "/origin-containment/resource/pixel.svg",
      kind: "resource",
    }],
  });

  const mutation = await fetch(`${fixture.crossOrigin}/origin-containment/application/mutation`, {
    method: "POST",
    body: "fixture=1",
  });
  assert.equal(mutation.status, 204);
  const counted = fixture.containment.snapshot();
  assert.equal(counted.destinationApplicationRequests, 1);
  assert.equal(counted.destinationResourceRequests, 1);
  assert.equal(counted.entries.at(-1).method, "POST");
});

test("redirect destination count remains zero until a client follows the redirect", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  fixture.containment.reset();
  const paused = await fetch(`${fixture.origin}/origin-containment/redirect-to-destination`, { redirect: "manual" });
  assert.equal(paused.status, 302);
  assert.equal(paused.headers.get("location"), `${fixture.crossOrigin}/origin-containment/application/redirect.html`);
  assert.equal(fixture.containment.snapshot().destinationApplicationRequests, 0);

  const followed = await fetch(paused.headers.get("location"));
  assert.equal(followed.status, 200);
  assert.equal(fixture.containment.snapshot().destinationApplicationRequests, 1);

  fixture.containment.reset();
  assert.deepEqual(fixture.containment.snapshot(), {
    destinationApplicationRequests: 0,
    destinationResourceRequests: 0,
    entries: [],
  });
});

test("destination WebSocket upgrades are counted as application requests", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  await websocketUpgrade(`${fixture.crossOrigin}/origin-containment/application/connection`);
  const snapshot = fixture.containment.snapshot();
  assert.equal(snapshot.destinationApplicationRequests, 1);
  assert.deepEqual(snapshot.entries[0], {
    sequence: 1,
    originRole: "destination",
    method: "GET",
    pathname: "/origin-containment/application/connection",
    kind: "application",
  });
});

test("primary containment page exposes every preventive path deterministically", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  const response = await fetch(`${fixture.origin}/origin-containment/primary.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const id of [
    "cross-fetch",
    "cross-beacon",
    "cross-popup",
    "cross-frame",
    "cross-worker",
    "cross-websocket",
    "cross-eventsource",
    "cross-form",
    "cross-image",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
});

function websocketUpgrade(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: { Connection: "Upgrade", Upgrade: "websocket" } });
    request.on("response", (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve();
    });
    request.once("error", reject);
    request.end();
  });
}
