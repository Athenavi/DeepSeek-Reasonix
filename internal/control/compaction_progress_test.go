package control

import (
	"context"
	"errors"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/event"
)

func TestCompactionSnapshotRejectsLateRunningAndOtherEpoch(t *testing.T) {
	prior := &event.ContextCompactionState{RunID: "first", Revision: 4, Status: "failed", StartedAt: 10, RuntimeEpoch: "epoch"}
	state := event.RuntimeStateSnapshot{RuntimeEpoch: "epoch", ContextCompaction: prior}
	for _, value := range []event.ContextCompactionState{
		{RunID: "first", Revision: 5, Status: "running", RuntimeEpoch: "epoch"},
		{RunID: "older", Revision: 99, Status: "running", StartedAt: 9, RuntimeEpoch: "epoch"},
		{RunID: "other", Revision: 99, Status: "running", StartedAt: 20, RuntimeEpoch: "other"},
	} {
		applyCompactionRuntimeState(&state, event.Event{ContextCompaction: &value})
		if state.ContextCompaction != prior {
			t.Fatalf("stale event replaced terminal: %+v", value)
		}
	}
}

func TestCompactionRetryAdmitsOnlyCurrentIdleFailure(t *testing.T) {
	exec := agent.New(nil, nil, maintenanceFixtureSession(), agent.Options{ContextWindow: 32000}, event.Discard)
	c := newOwnedTestController(t, Options{Executor: exec, Sink: event.Discard})
	if err := c.Compact(t.Context(), ""); err == nil {
		t.Fatal("fixture expected provider failure")
	}
	state := c.RuntimeStateSnapshot()
	failed := state.ContextCompaction
	if failed == nil || !failed.Retryable || failed.Status != "failed" {
		t.Fatalf("failure=%+v", failed)
	}
	if _, _, err := c.beginMaintenance(WithCompactionRetry(t.Context(), failed.RunID, "old-epoch"), "compact"); err == nil {
		t.Fatal("stale epoch admitted")
	}
	ctx := WithCompactionRetry(t.Context(), failed.RunID, state.RuntimeEpoch)
	op, work, err := c.beginMaintenance(ctx, "compact")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.beginMaintenance(ctx, "compact"); !errors.Is(err, ErrMaintenanceBusy) {
		t.Fatalf("duplicate=%v", err)
	}
	// A previously accepted follow-up must remain queued: retry completion is
	// not authorization to restart the interrupted task or its tools.
	c.mu.Lock()
	c.turns.pending = append(c.turns.pending, queuedTurn{})
	c.mu.Unlock()
	// Execute only maintenance; no user turn or task continuation is admitted.
	if err := c.executeMaintenance(op, work, func(ctx context.Context) error { return exec.CompactNow(ctx, "") }); err == nil {
		t.Fatal("retry fixture expected failure")
	}
	if c.RuntimeStateSnapshot().Running {
		t.Fatal("retry resumed a user turn")
	}
	c.mu.Lock()
	pending := len(c.turns.pending)
	c.turns.pending = nil
	c.mu.Unlock()
	if pending != 1 {
		t.Fatalf("retry dispatched queued continuation: pending=%d", pending)
	}
	if _, _, err := c.beginMaintenance(ctx, "compact"); err == nil {
		t.Fatal("old retry reused after completion")
	}
}
