import test from "node:test";
import assert from "node:assert/strict";
import { CommandContext } from "../src/command-context.ts";
import { PageExecutor } from "../src/page-executor.ts";

// Audit D27: busy pages (ads, many frames/popups) degrade observations instead of faulting the session.
test("frame and popup limits degrade the view instead of permanently faulting the session", async () => {
  let emit;
  const connection = { epoch: "epoch", claimGeneration: 1, rootTargetId: "root", ownsBrowser: true, signal: new AbortController().signal,
    wire: {
      async send(method, params) {
        if (method === "Target.attachToTarget") {
          if (params.targetId !== "root") throw new Error("target closed");
          return { sessionId: "root-route" };
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "l1", url: "https://example.test/" } } };
        if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Busy" }, backendDOMNodeId: 1, childIds: ["2"] },
          { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Buy" }, backendDOMNodeId: 2 }] };
        return {};
      },
      onEvent(listener) { emit = listener; return () => {}; },
    } };
  const executor = new PageExecutor(connection);
  await executor.start();
  for (let index = 0; index < 140; index++) emit({ method: "Page.frameAttached", sessionId: "root-route", params: { frameId: `ad${index}` } });
  for (let index = 0; index < 40; index++) emit({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: `popup${index}` } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const context = new CommandContext(5000);
  try {
    const view = await executor.observe(context, executor.bindPage(), 8192);
    assert.equal(view.state, "incomplete");
    assert.deepEqual(view.nodes.map(node => node.name), ["Buy"]);
  } finally { context.dispose(); }
  assert.equal(executor.pendingFrames.size, 128, "the oldest pending frames are dropped at the cap");
});
