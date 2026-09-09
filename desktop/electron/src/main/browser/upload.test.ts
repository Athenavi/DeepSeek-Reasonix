import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { FakePage } from "./fakeGuestViews.js";
import { REGISTRY_KEY } from "./snapshot.js";
import { uploadFiles } from "./upload.js";

test("upload keeps the original snapshot node when another file input takes its CSS position", async () => {
  const dom = new JSDOM('<input type="file" id="upload">', { runScripts: "outside-only" });
  try {
    dom.window.eval(`window[${JSON.stringify(REGISTRY_KEY)}] = { docId: 'doc', snapshotId: 'snap', refs: new Map([['e1', document.querySelector('input')]]) };`);
    const page = new FakePage(1);
    let replaced = false;
    page.debugger.respond = (method, params) => {
      if (method === "Runtime.enable") {
        if (replaced) dom.window.document.querySelector("input")!.outerHTML = '<input type="file" id="upload">';
        page.debugger.emit("Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: false } } });
      }
      if (method === "Runtime.evaluate") {
        const node = dom.window.eval((params as { expression: string }).expression);
        return { result: node ? { objectId: "original-input" } : { subtype: "null" } };
      }
      return {};
    };
    const located = { ref: "e1", snapshotId: "snap", tag: "input", type: "file", path: "html > body:nth-child(2) > input:nth-child(1)", frame: page.mainFrame, binding: { prefix: "", frameTreeNodeId: 100, docId: "doc" }, isMainFrame: true };
    assert.deepEqual(await uploadFiles(page, located, ["/tmp/file"], () => {}, () => {}), { executed: true });
    page.debugger.commands.length = 0;
    replaced = true;
    const result = await uploadFiles(page, located, ["/tmp/file"], () => {}, () => {});
    assert.equal(result.executed, false);
    assert.equal(page.debugger.commands.some((command) => command.method === "DOM.setFileInputFiles"), false);
  } finally {
    dom.window.close();
  }
});
