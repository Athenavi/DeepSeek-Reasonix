package agent

import (
	"context"
	"encoding/json"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// envelopeReader is a stand-in reader that reports a fixed delivery, so the
// wiring under test is the host's identity stamping and transport clipping.
type envelopeReader struct{ env tool.ReadResultEnvelope }

func (envelopeReader) Name() string                                             { return "read_file" }
func (envelopeReader) Description() string                                      { return "fake reader" }
func (envelopeReader) Schema() json.RawMessage                                  { return json.RawMessage(`{"type":"object"}`) }
func (envelopeReader) ReadOnly() bool                                           { return true }
func (envelopeReader) Execute(context.Context, json.RawMessage) (string, error) { return "", nil }
func (r envelopeReader) ReadEnvelope(json.RawMessage, string) (tool.ReadResultEnvelope, bool) {
	return r.env, true
}

type plainReader struct{}

func (plainReader) Name() string                                             { return "read_file" }
func (plainReader) Description() string                                      { return "plain reader" }
func (plainReader) Schema() json.RawMessage                                  { return json.RawMessage(`{"type":"object"}`) }
func (plainReader) ReadOnly() bool                                           { return true }
func (plainReader) Execute(context.Context, json.RawMessage) (string, error) { return "", nil }

func newEnvelopeTestAgent(t *testing.T, reader tool.Tool) (*Agent, *Session) {
	t.Helper()
	reg := tool.NewRegistry()
	reg.Add(reader)
	sess := NewSession("system")
	return New(&userInputCaptureProvider{}, reg, sess, Options{WorkspaceID: "ws-1"}, event.Discard), sess
}

func storedEnvelope(t *testing.T, sess *Session) tool.ReadResultEnvelope {
	t.Helper()
	stored := sess.Snapshot()
	if len(stored) == 0 {
		t.Fatal("no stored messages")
	}
	last := stored[len(stored)-1]
	if len(last.ReadResult) == 0 {
		t.Fatal("tool message carries no read envelope")
	}
	var env tool.ReadResultEnvelope
	if err := json.Unmarshal(last.ReadResult, &env); err != nil {
		t.Fatalf("envelope is not valid JSON: %v", err)
	}
	return env
}

func TestStoreBatchToolResultStampsReaderEnvelope(t *testing.T) {
	reader := envelopeReader{env: tool.ReadResultEnvelope{
		ProtocolVersion: tool.ReadResultProtocolVersion,
		Source:          tool.ReadResultSource{CanonicalPath: "/w/a.go", VersionToken: "rw1:abc"},
		Intent:          tool.ReadIntentInspect,
		DeliveredRanges: []tool.ReadRange{{Start: 0, End: 2}},
		EOF:             true,
	}}
	a, sess := newEnvelopeTestAgent(t, reader)
	a.storeBatchToolResult(provider.ToolCall{ID: "c1", Name: "read_file", Arguments: `{"path":"a.go"}`}, toolOutcome{output: "  1→a\n  2→b\n"})

	env := storedEnvelope(t, sess)
	if env.ReadID == "" || env.ResultRef == "" {
		t.Fatalf("host must stamp read identity: %+v", env)
	}
	if env.Source.WorkspaceID != "ws-1" {
		t.Fatalf("WorkspaceID = %q, want ws-1", env.Source.WorkspaceID)
	}
	if env.ProtocolVersion != tool.ReadResultProtocolVersion || env.TransportCut != tool.ReadCutNone {
		t.Fatalf("untruncated delivery must stay uncut: %+v", env)
	}
}

func TestStoreBatchToolResultClipsEnvelopeToVisibleBytes(t *testing.T) {
	reader := envelopeReader{env: tool.ReadResultEnvelope{
		ProtocolVersion: tool.ReadResultProtocolVersion,
		Source:          tool.ReadResultSource{CanonicalPath: "/w/a.go", VersionToken: "rw1:abc"},
		DeliveredRanges: []tool.ReadRange{{Start: 0, End: 2}},
		EOF:             true,
	}}
	a, sess := newEnvelopeTestAgent(t, reader)
	a.storeBatchToolResult(
		provider.ToolCall{ID: "c1", Name: "read_file", Arguments: `{"path":"a.go"}`},
		toolOutcome{output: "  1→a\n", rawOutput: "  1→a\n  2→b\n", truncated: true},
	)

	env := storedEnvelope(t, sess)
	if env.TransportCut != tool.ReadCutToolOutput {
		t.Fatalf("TransportCut = %q, want %q", env.TransportCut, tool.ReadCutToolOutput)
	}
	if got := env.DeliveredRanges; len(got) != 1 || got[0] != (tool.ReadRange{Start: 0, End: 1}) {
		t.Fatalf("DeliveredRanges = %+v, want only the visible line", got)
	}
	if !env.HasMore || env.EOF {
		t.Fatalf("clipped delivery must be resumable: has_more=%v eof=%v", env.HasMore, env.EOF)
	}
}

func TestStoreBatchToolResultOmitsEnvelopeForPlainReaders(t *testing.T) {
	a, sess := newEnvelopeTestAgent(t, plainReader{})
	a.storeBatchToolResult(provider.ToolCall{ID: "c1", Name: "read_file", Arguments: `{"path":"a.go"}`}, toolOutcome{output: "  1→a\n"})

	stored := sess.Snapshot()
	if len(stored) == 0 {
		t.Fatal("no stored messages")
	}
	if len(stored[len(stored)-1].ReadResult) != 0 {
		t.Fatal("a reader that cannot describe its delivery must not get a fabricated envelope")
	}
}
