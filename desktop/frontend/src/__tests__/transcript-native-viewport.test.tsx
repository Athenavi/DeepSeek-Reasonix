import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { useNativeViewportSnapshot } from "../lib/useTranscriptNativeViewport";

const dom = new JSDOM('<div id="root"></div><div id="scroller"></div>');
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const element = document.getElementById("scroller")!;
Object.defineProperties(element, {
  clientHeight: { value: 600, configurable: true },
  scrollHeight: { value: 20000, configurable: true },
});
const kernel = { generation: 1 };
let observedTop = -1;
function Probe() {
  observedTop = useNativeViewportSnapshot(element, kernel).scrollTop;
  return <span>{observedTop}</span>;
}
const root = createRoot(document.getElementById("root")!);
await act(async () => root.render(<Probe />));
await act(async () => {
  element.scrollTop = 100;
  element.dispatchEvent(new dom.window.Event("scroll"));
});
assert.equal(observedTop, 100, "initial surface observes native scroll");
kernel.generation++;
await act(async () => {
  element.scrollTop = 500;
  element.dispatchEvent(new dom.window.Event("scroll"));
});
assert.equal(observedTop, 100, "obsolete generation cannot publish a viewport update");
await act(async () => root.render(<Probe />));
await act(async () => {
  element.scrollTop = 10000;
  element.dispatchEvent(new dom.window.Event("scroll"));
});
assert.equal(observedTop, 10000, "replacement surface observes native scroll with the same kernel and DOM");
await act(async () => root.unmount());
dom.window.close();
console.log("PASS: native viewport subscription follows surface replacement");
