import { commitTranscriptWindowRange } from "../lib/transcriptWindowRange";
import { commitTranscriptWindowGeometry } from "../lib/transcriptWindowGeometry";
import assert from "node:assert/strict";
function ok(condition: unknown, label: string) { assert.ok(condition, label); console.log(`PASS ${label}`); }
const backing = Array.from({ length: 100 }, (_, index) => ({ key: `block:${index}`, index, start: index * 100, end: (index + 1) * 100, size: 100 }));
const lazyPrefix = new Proxy(new Array<(typeof backing)[number]>(100), {
  get: (target, key, receiver) => typeof key === "string" && /^\d+$/.test(key) ? backing[Number(key)] : Reflect.get(target, key, receiver),
});
const geometryInput = { candidate: backing.slice(5, 20), measurements: lazyPrefix, retainedIndexes: new Set<number>(),
  structureRevision: "prefix", scrollTop: 500, clientHeight: 800, scrollMargin: 0, totalSize: 10_000,
  maxItems: 38, direction: "forward" as const, gestureActive: true, residentCount: 2, forceFull: false };
const snapshot = commitTranscriptWindowGeometry(geometryInput);
ok(snapshot.mode === "windowed" && snapshot.prefix.items.length === 100 && snapshot.prefix.items[50].start === 5000,
  "lazy TanStack prefix is concretely materialized before geometry ownership");
backing[50].start = 4990;
ok(snapshot.prefix.items[50].start === 5000, "third-party cache mutation cannot alter a committed prefix snapshot");
const invalid = commitTranscriptWindowGeometry({ ...geometryInput, previous: snapshot });
ok(invalid.mode === "full" && invalid.prefix === snapshot.prefix,
  "invalid prefix enters covered full presentation using the immutable trusted geometry");
backing[50].start = 5000;
const previousRange = {
  structureRevision: "stable",
  scrollTop: 100,
  scrollMargin: 0,
  totalSize: 20_000,
  items: [{ index: 0, start: 50, end: 900 }],
  source: "candidate" as const,
  covered: true,
};
const staleCandidate = [{ index: 50, start: 5_000, end: 5_800 }];
const measurements = Array.from({ length: 200 }, (_, index) => ({ index, start: index * 100, end: (index + 1) * 100 }));
const shrunkBudget = commitTranscriptWindowRange({
  candidate: measurements.slice(0, 38), measurements, retainedIndexes: new Set([0]),
  previous: { ...previousRange, items: measurements.slice(0, 38) },
  structureRevision: "stable", scrollTop: 100, clientHeight: 200,
  scrollMargin: 0, totalSize: 20_000, maxItems: 5, direction: "forward", gestureActive: true,
});
ok(shrunkBudget.covered && shrunkBudget.items.length <= 5,
  "resident growth prunes stale overscan before judging total mount budget");
const retained = commitTranscriptWindowRange({
  candidate: staleCandidate,
  measurements,
  retainedIndexes: new Set(),
  previous: previousRange,
  structureRevision: "stable",
  scrollTop: 180,
  clientHeight: 600,
  scrollMargin: 0,
  totalSize: 20_000,
  maxItems: 8,
  direction: "forward",
  gestureActive: true,
});
ok(retained.items === previousRange.items, "a stale late range cannot replace native viewport coverage");
const measuredCandidate = [{ index: 0, start: 40, end: 940 }];
const measurementOnly = commitTranscriptWindowRange({
  candidate: measuredCandidate,
  measurements,
  retainedIndexes: new Set(),
  previous: previousRange,
  structureRevision: "stable",
  scrollTop: 100,
  clientHeight: 600,
  scrollMargin: 0,
  totalSize: 20_120,
  maxItems: 8,
  direction: "forward",
  gestureActive: true,
});
ok(measurementOnly.items === previousRange.items, "a measurement-only range commit stays frozen during native ownership");
ok(measurementOnly.totalSize === previousRange.totalSize, "a retained range keeps its matching extent snapshot");
const released = commitTranscriptWindowRange({
  candidate: measuredCandidate,
  measurements,
  retainedIndexes: new Set(),
  previous: measurementOnly,
  structureRevision: "stable",
  scrollTop: 100,
  clientHeight: 600,
  scrollMargin: 0,
  totalSize: 20_120,
  maxItems: 8,
  direction: "forward",
  gestureActive: false,
});
ok(released.items !== previousRange.items, "gesture release commits the latest covering measurements");
ok(released.totalSize === 20_120, "gesture release commits range and extent atomically");
const reconstructed = commitTranscriptWindowRange({
  candidate: staleCandidate,
  measurements,
  retainedIndexes: new Set([80]),
  structureRevision: "stable",
  scrollTop: 1_200,
  clientHeight: 600,
  scrollMargin: 0,
  totalSize: 20_000,
  maxItems: 8,
  direction: "forward",
  gestureActive: true,
});
ok(reconstructed.source === "reconstructed", "an uncovered native jump reconstructs from the prefix-size ledger");
ok(reconstructed.items.some((item) => item.start <= 1_200 && item.end >= 1_300), "the reconstructed range covers the native viewport");
ok(reconstructed.items.some((item) => item.index === 80), "reconstruction retains protected blocks");
const unavailable = commitTranscriptWindowRange({
  candidate: [],
  measurements: [],
  retainedIndexes: new Set(),
  structureRevision: "unavailable",
  scrollTop: 1_200,
  clientHeight: 600,
  scrollMargin: 0,
  totalSize: 20_000,
  maxItems: 36,
  direction: "forward",
  gestureActive: true,
});
ok(!unavailable.covered && unavailable.source === "unavailable" && unavailable.items.length === 0,
  "an unavailable ledger fails closed instead of painting an uncovered candidate");

const largeMeasurements = Array.from({ length: 10_000 }, (_, index) => ({ index, start: index * 96, end: (index + 1) * 96 }));
const rangeStartedAt = performance.now();
const largeRange = commitTranscriptWindowRange({
  candidate: [{ index: 2, start: 192, end: 288 }],
  measurements: largeMeasurements,
  retainedIndexes: new Set([9_999]),
  structureRevision: "10k",
  scrollTop: 720_000,
  clientHeight: 800,
  scrollMargin: 0,
  totalSize: 960_000,
  maxItems: 38,
  direction: "forward",
  gestureActive: true,
});
const rangeElapsedMs = performance.now() - rangeStartedAt;
ok(rangeElapsedMs < 1_000, `10,000-turn range reconstruction completes within 1s (${rangeElapsedMs.toFixed(1)}ms)`);
ok(largeRange.source === "reconstructed" && largeRange.items.length <= 40, "10,000-turn reconstruction keeps a bounded mounted range");
ok(largeRange.items.some((item) => item.start <= 720_000 && item.end >= 720_096), "10,000-turn reconstruction covers the authoritative viewport");
ok(largeRange.items.some((item) => item.index === 9_999), "10,000-turn reconstruction preserves protected block identity");
