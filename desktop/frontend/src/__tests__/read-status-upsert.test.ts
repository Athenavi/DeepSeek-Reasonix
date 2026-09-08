import { initialState, reducer } from "../lib/useController";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: got ${String(actual)}, want ${String(expected)}`);
}

const frame = (seq: number, state: string, extra: Record<string, unknown> = {}) => ({
  kind: "read_status" as const,
  turnId: "turn-1",
  readStatus: {
    readId: "ir-1", seq, path: "/w/a.go", state, active: true,
    covered: [[1, 10]] as [number, number][],
    ...extra,
  },
});

let s = reducer(initialState, { type: "event", e: frame(1, "needs_more") });
equal(Object.keys(s.readStatuses ?? {}).length, 1, "one logical read keeps one status entry");
s = reducer(s, { type: "event", e: frame(2, "needs_more") });
equal(Object.keys(s.readStatuses ?? {}).length, 1, "a later page upserts the same entry");
equal(s.readStatuses?.["ir-1"]?.seq, 2, "the newest sequence wins");

const stale = reducer(s, { type: "event", e: frame(1, "satisfied", { active: false }) });
equal(stale.readStatuses?.["ir-1"]?.state, "needs_more", "a re-ordered frame never moves a read backwards");

s = reducer(s, {
  type: "event",
  e: { kind: "read_status", turnId: "turn-1", readStatus: { readId: "ir-2", seq: 1, path: "/w/b.go", state: "needs_more", active: true } },
});
equal(Object.keys(s.readStatuses ?? {}).length, 2, "independent reads keep independent entries");

const next = reducer(s, { type: "event", e: { kind: "turn_started", turnId: "turn-2", status: "in_progress" } });
equal(next.readStatuses, undefined, "a new turn starts from no live read status");

// A hundred pages of one read still leave exactly one status entry.
let many = initialState;
for (let page = 1; page <= 100; page++) {
  many = reducer(many, { type: "event", e: frame(page, "needs_more", { covered: [[1, page * 10]] as [number, number][] }) });
}
equal(Object.keys(many.readStatuses ?? {}).length, 1, "a hundred pages still render one status");
equal(many.readStatuses?.["ir-1"]?.seq, 100, "the latest page wins");

console.log("read status upsert tests passed");
