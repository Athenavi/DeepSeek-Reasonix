package agent

import (
	"context"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/readcoord"
	"reasonix/internal/tool"
)

func newShadowTestAgent(t *testing.T, enabled bool) (*Agent, *Session) {
	t.Helper()
	reg := tool.NewRegistry()
	reg.Add(envelopeReader{env: tool.ReadResultEnvelope{
		ProtocolVersion: tool.ReadResultProtocolVersion,
		Source:          tool.ReadResultSource{CanonicalPath: "/w/a.go", Snapshot: "ss2:v1"},
		Intent:          tool.ReadIntentInspect,
		DeliveredRanges: []tool.ReadRange{{Start: 0, End: 2000}},
		HasMore:         true,
	}})
	sess := NewSession("system")
	a := New(&userInputCaptureProvider{}, reg, sess, Options{}, event.Discard)
	a.reads.tasks = newReadTasks("test-session", 1)
	a.turn.readShadow = newReadShadowState(enabled)
	return a, sess
}

func observeOneRead(a *Agent) {
	a.storeBatchToolResult(context.Background(),
		provider.ToolCall{ID: "c1", Name: "read_file", Arguments: `{"path":"a.go"}`},
		toolOutcome{output: "   1→a\n"},
	)
}

func TestReadShadowIsInertUnlessEnabled(t *testing.T) {
	a, _ := newShadowTestAgent(t, false)
	observeOneRead(a)
	if a.turn.readShadow.observed != 0 || a.turn.readShadow.coord != nil {
		t.Fatalf("disabled shadow must stay inert: %+v", a.turn.readShadow)
	}
}

func TestReadShadowRecordsTheCoordinatorVerdict(t *testing.T) {
	a, _ := newShadowTestAgent(t, true)
	observeOneRead(a)
	s := a.turn.readShadow
	if s.observed != 1 || s.byState[readcoord.StateSatisfied] != 1 {
		t.Fatalf("shadow = %+v, want one satisfied observation", s)
	}
	if s.disagreements != 0 {
		t.Fatalf("legacy has no pending read, so there is no disagreement: %+v", s)
	}
}

func TestReadShadowRecordsLegacyDisagreement(t *testing.T) {
	a, _ := newShadowTestAgent(t, true)
	a.turn.incompleteReads.addEntryLocked(&incompleteRead{key: "k", path: "/w/a.go"})
	observeOneRead(a)
	s := a.turn.readShadow
	if s.observed != 1 || s.disagreements != 1 {
		t.Fatalf("shadow = %+v, want one observation and one disagreement", s)
	}
}

func TestReadShadowDoesNotChangeStoredContent(t *testing.T) {
	a, sess := newShadowTestAgent(t, true)
	observeOneRead(a)
	stored := sess.Snapshot()
	if len(stored) == 0 || stored[len(stored)-1].Content != "   1→a\n" {
		t.Fatalf("shadow must not rewrite the provider-visible result: %+v", stored)
	}
}
