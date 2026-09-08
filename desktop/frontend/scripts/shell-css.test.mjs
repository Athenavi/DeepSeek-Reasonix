import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteDragRegions, shellFromEnv } from "./shell-css.mjs";

test("wails build keeps the custom property byte-for-byte", () => {
  const css = ".tabbar{--wails-draggable:drag}.tabbar *{--wails-draggable: no-drag}";
  assert.equal(rewriteDragRegions(css, "wails"), css);
});

test("electron build rewrites every drag declaration", () => {
  const css = ".tabbar{--wails-draggable:drag}.tabbar *{--wails-draggable: no-drag}/* --wails-draggable marks */";
  assert.equal(
    rewriteDragRegions(css, "electron"),
    ".tabbar{-webkit-app-region:drag}.tabbar *{-webkit-app-region: no-drag}/* --wails-draggable marks */",
  );
});

test("shell selection is explicit", () => {
  assert.equal(shellFromEnv({}), "wails");
  assert.equal(shellFromEnv({ REASONIX_SHELL: "electron" }), "electron");
  assert.throws(() => shellFromEnv({ REASONIX_SHELL: "tauri" }));
});
