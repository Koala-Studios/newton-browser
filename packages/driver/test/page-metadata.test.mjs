import test from "node:test";
import assert from "node:assert/strict";
import { PageDirectory } from "../src/page-directory.ts";

function directory() {
  const value = new PageDirectory("epoch");
  value.registerRoute("root-route");
  return value;
}

function navigateRoot(value, pageId, loaderId, url) {
  value.navigate(pageId, {
    frameId: `${pageId}:root`,
    route: "root-route",
    loaderId,
    ...(url === undefined ? {} : { url }),
  });
  return value.stamp(pageId);
}

function inventoryEntry(value, pageId) {
  return value.inventory().find((entry) => entry.pageId === pageId);
}

test("inventory exposes selected, opener, URL, and bounded title metadata without selecting a popup", () => {
  const value = directory();
  const parentStamp = (value.addPage("parent"), navigateRoot(value, "parent", "parent-1", "https://parent.example/"));
  value.describe(parentStamp, { title: "Parent" });
  value.addPage("popup", "parent");
  const popupStamp = navigateRoot(value, "popup", "popup-1", "https://popup.example/child");
  value.describe(popupStamp, { title: "Popup" });

  assert.deepEqual(value.inventory(), [
    {
      pageId: "parent",
      frameId: "parent:root",
      documentGeneration: 1,
      selected: true,
      title: "Parent",
      url: "https://parent.example/",
    },
    {
      pageId: "popup",
      frameId: "popup:root",
      documentGeneration: 2,
      selected: false,
      title: "Popup",
      url: "https://popup.example/child",
      openerPageId: "parent",
    },
  ]);
});

test("uninitialized pages are omitted from inventory rather than poisoning it", () => {
  const value = directory();
  value.addPage("parent");
  value.addPage("uninitialized", "parent");
  assert.deepEqual(value.inventory(), []);

  navigateRoot(value, "parent", "parent-1", "https://parent.example/");
  assert.deepEqual(value.inventory().map((entry) => entry.pageId), ["parent"]);
});

test("root navigation clears stale title and URL metadata", () => {
  const value = directory();
  value.addPage("p1");
  const first = navigateRoot(value, "p1", "loader-1", "https://old.example/page");
  value.describe(first, { title: "Old title" });

  navigateRoot(value, "p1", "loader-2");
  const entry = inventoryEntry(value, "p1");
  assert.equal(entry?.title, undefined);
  assert.equal(entry?.url, undefined);
});

test('an unsupported location update cannot retain a misleading previous URL',()=>{
  const value=directory();value.addPage('p1');const stamp=navigateRoot(value,'p1','loader','https://old.example/');
  value.describe(stamp,{url:'chrome-error://chromewebdata/'});assert.equal(inventoryEntry(value,'p1').url,undefined);
});

test("child-frame navigation cannot overwrite root page metadata", () => {
  const value = directory();
  value.registerRoute("child-route");
  value.addPage("p1");
  const rootStamp = navigateRoot(value, "p1", "root-1", "https://root.example/page");
  value.describe(rootStamp, { title: "Root title" });

  value.navigate("p1", {
    frameId: "child",
    parentId: "p1:root",
    route: "child-route",
    loaderId: "child-1",
    url: "https://child.example/frame",
  });

  assert.deepEqual(inventoryEntry(value, "p1"), {
    pageId: "p1",
    frameId: "p1:root",
    documentGeneration: 1,
    selected: true,
    title: "Root title",
    url: "https://root.example/page",
  });
});

test("stale describe stamps cannot overwrite newer root document metadata", () => {
  const value = directory();
  value.addPage("p1");
  const oldStamp = navigateRoot(value, "p1", "loader-1", "https://old.example/page");
  value.describe(oldStamp, { title: "Old title" });
  navigateRoot(value, "p1", "loader-2", "https://new.example/page");

  assert.throws(() => value.describe(oldStamp, { title: "Stale title", url: "https://stale.example/" }), /stale_target/);
  assert.deepEqual(inventoryEntry(value, "p1"), {
    pageId: "p1",
    frameId: "p1:root",
    documentGeneration: 2,
    selected: true,
    url: "https://new.example/page",
  });
});

test("titles are bounded and redacted, while credential and non-HTTP URLs are not exposed", () => {
  const value = directory();
  value.addPage("p1");
  const stamp = navigateRoot(value, "p1", "loader-1", "https://user:password@example.com/private");
  value.describe(stamp, {
    title: `Bearer abcdefghijklmnopqrstuvwxyz token=secret ${"x".repeat(400)}`,
    url: "file:///private/secret.txt",
  });

  const entry = inventoryEntry(value, "p1");
  assert.equal(entry?.url, undefined);
  assert.equal(entry?.title?.length, 256);
  assert.ok(entry?.title?.includes("[REDACTED]"));
  assert.equal(entry?.title?.includes("secret"), false);
});

test("removing a page invalidates its refs without corrupting another page", () => {
  const value = directory();
  value.addPage("p1");
  value.addPage("p2");
  const p1Stamp = navigateRoot(value, "p1", "p1-1", "https://p1.example/");
  const p2Stamp = navigateRoot(value, "p2", "p2-1", "https://p2.example/");
  const p1Binding = value.binding(p1Stamp, 1);
  const p2Binding = value.binding(p2Stamp, 2);
  const snapshot = value.publish([p1Binding, p2Binding]);

  value.removePage("p1");
  assert.throws(() => value.resolve(snapshot.refs[0], "p1"), /stale_target/);
  assert.deepEqual(value.resolve(snapshot.refs[1], "p2"), p2Binding);
  assert.deepEqual(value.inventory().map((entry) => entry.pageId), ["p2"]);
  assert.equal(inventoryEntry(value, "p2")?.selected, true);
});
