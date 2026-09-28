package eventwire

import (
	"encoding/json"
	"reasonix/internal/event"
	"testing"
)

func TestCompactionWireStateIsOptionalAndDetached(t *testing.T) {
	state := &event.ContextCompactionState{RunID: "run", RuntimeEpoch: "epoch", Revision: 3, Status: "failed", Phase: "waiting_response", ErrorCode: "summary_budget_exceeded", Applied: true}
	wire := ToWire(event.Event{Kind: event.ContextCompactionProgress, ContextCompaction: state})
	state.Status = "running"
	if wire.ContextCompaction.Status != "failed" {
		t.Fatal("wire shares mutable progress")
	}
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var restored Event
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Kind != "context_compaction_progress" || !restored.ContextCompaction.Applied {
		t.Fatalf("wire=%s", data)
	}
	legacy := ToWire(event.Event{Kind: event.CompactionStarted})
	if legacy.ContextCompaction != nil {
		t.Fatal("legacy event invented a deadline")
	}
}
