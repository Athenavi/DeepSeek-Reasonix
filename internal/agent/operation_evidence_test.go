package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/evidence"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// evidenceWriter is a stand-in writer whose declared target is fixed, so the
// tests exercise the host check rather than a built-in's own resolution.
type evidenceWriter struct {
	target tool.EvidenceTargetInfo
	err    error
}

func (evidenceWriter) Name() string            { return "write_file" }
func (evidenceWriter) Description() string     { return "fake writer" }
func (evidenceWriter) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (evidenceWriter) ReadOnly() bool          { return false }
func (evidenceWriter) Execute(context.Context, json.RawMessage) (string, error) {
	return "", nil
}

func (w evidenceWriter) DeclareEvidenceTarget(context.Context, json.RawMessage) (tool.EvidenceTargetInfo, error) {
	return w.target, w.err
}

type undeclaredWriter struct{}

func (undeclaredWriter) Name() string            { return "write_file" }
func (undeclaredWriter) Description() string     { return "writer without a declaration" }
func (undeclaredWriter) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (undeclaredWriter) ReadOnly() bool          { return false }
func (undeclaredWriter) Execute(context.Context, json.RawMessage) (string, error) {
	return "", nil
}

func newEvidenceAgent(t *testing.T, writer tool.Tool, gates bool) (*Agent, *evidence.Ledger) {
	t.Helper()
	reg := tool.NewRegistry()
	reg.Add(writer)
	a := New(&userInputCaptureProvider{}, reg, NewSession("system"), Options{ReadPipeline: ReadPipelineOptions{EvidenceGates: gates}}, event.Discard)
	ledger := evidence.NewLedger()
	a.task.ledger = ledger
	return a, ledger
}

func runEvidenceGate(a *Agent, path string) (toolOutcome, bool) {
	plan := &toolCallPlan{call: provider.ToolCall{Name: "write_file", Arguments: `{"path":"` + path + `"}`}}
	return a.applyEvidenceGates(context.Background(), plan)
}

func hashesFor(lines ...string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		out = append(out, hashLine(line))
	}
	return out
}

func TestEvidenceGateBlocksAnUnreadOverwrite(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("alpha", "beta"),
	}}
	a, _ := newEvidenceAgent(t, writer, true)

	out, blocked := runEvidenceGate(a, "/w/a.go")
	if !blocked || !out.blocked {
		t.Fatalf("an overwrite without evidence must be blocked: %+v (blocked=%v)", out, blocked)
	}
	if !strings.Contains(out.output, "evidence required") || !strings.Contains(out.output, "1-2") {
		t.Fatalf("block message must name the requirement and missing lines: %q", out.output)
	}
}

func TestEvidenceGateAllowsAfterTheModelSawTheContent(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("alpha", "beta"),
	}}
	a, ledger := newEvidenceAgent(t, writer, true)
	ledger.RecordTextObservation(evidence.TextObservation{
		Path: "/w/a.go", StartLine: 1, Snapshot: "ss2:1", LineHashes: hashesFor("alpha", "beta"),
	})

	if out, blocked := runEvidenceGate(a, "/w/a.go"); blocked {
		t.Fatalf("a full read must satisfy the requirement: %+v", out)
	}
}

func TestEvidenceGateRejectsStaleContent(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("alpha", "gamma"),
	}}
	a, ledger := newEvidenceAgent(t, writer, true)
	ledger.RecordTextObservation(evidence.TextObservation{
		Path: "/w/a.go", StartLine: 1, Snapshot: "ss2:1", LineHashes: hashesFor("alpha", "beta"),
	})

	if out, blocked := runEvidenceGate(a, "/w/a.go"); !blocked {
		t.Fatalf("changed content must not reuse the old observation: %+v", out)
	}
}

func TestEvidenceGateStitchesPagesOfOneSnapshot(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("a", "b", "c", "d"),
	}}
	a, ledger := newEvidenceAgent(t, writer, true)
	ledger.RecordTextObservation(evidence.TextObservation{Path: "/w/a.go", StartLine: 1, Snapshot: "ss2:1", LineHashes: hashesFor("a", "b")})
	ledger.RecordTextObservation(evidence.TextObservation{Path: "/w/a.go", StartLine: 3, Snapshot: "ss2:1", LineHashes: hashesFor("c", "d")})

	if out, blocked := runEvidenceGate(a, "/w/a.go"); blocked {
		t.Fatalf("two pages of one snapshot must prove the file: %+v", out)
	}
}

func TestEvidenceGateNeverStitchesAcrossSnapshots(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("a", "b", "c", "d"),
	}}
	a, ledger := newEvidenceAgent(t, writer, true)
	ledger.RecordTextObservation(evidence.TextObservation{Path: "/w/a.go", StartLine: 1, Snapshot: "ss2:1", LineHashes: hashesFor("a", "b")})
	ledger.RecordTextObservation(evidence.TextObservation{Path: "/w/a.go", StartLine: 3, Snapshot: "ss2:2", LineHashes: hashesFor("c", "d")})

	if out, blocked := runEvidenceGate(a, "/w/a.go"); !blocked {
		t.Fatalf("pages from different snapshots must not be combined: %+v", out)
	}
}

func TestEvidenceGateIgnoresSameBatchReads(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("alpha"),
	}}
	a, ledger := newEvidenceAgent(t, writer, true)
	boundary := ledger.ObservationBoundary()
	ledger.RecordTextObservation(evidence.TextObservation{
		Path: "/w/a.go", StartLine: 1, Snapshot: "ss2:1", LineHashes: hashesFor("alpha"),
	})
	ctx := withObservationBoundary(context.Background(), boundary)

	plan := &toolCallPlan{call: provider.ToolCall{Name: "write_file", Arguments: `{"path":"/w/a.go"}`}}
	if out, blocked := a.applyEvidenceGates(ctx, plan); !blocked {
		t.Fatalf("a read from the same batch must not count: %+v", out)
	}
}

func TestEvidenceGateAllowsCreatingANewFile(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{Path: "/w/new.go"}}
	a, _ := newEvidenceAgent(t, writer, true)
	if out, blocked := runEvidenceGate(a, "/w/new.go"); blocked {
		t.Fatalf("creating a new file needs no prior evidence: %+v", out)
	}
}

func TestEvidenceGateLeavesUndeclaredWritersAlone(t *testing.T) {
	a, _ := newEvidenceAgent(t, undeclaredWriter{}, true)
	if out, blocked := runEvidenceGate(a, "/w/a.go"); blocked {
		t.Fatalf("a writer without a declaration must keep the existing boundary: %+v", out)
	}
}

func TestEvidenceGateIsOffByDefault(t *testing.T) {
	writer := evidenceWriter{target: tool.EvidenceTargetInfo{
		Path: "/w/a.go", WholeFile: true, Hashes: hashesFor("alpha"),
	}}
	a, _ := newEvidenceAgent(t, writer, false)
	if out, blocked := runEvidenceGate(a, "/w/a.go"); blocked {
		t.Fatalf("the gate must stay off unless the run enabled it: %+v", out)
	}
}

func TestEvidenceGateReportsAnInvalidTarget(t *testing.T) {
	writer := evidenceWriter{err: errors.New("anchor not found")}
	a, _ := newEvidenceAgent(t, writer, true)
	out, blocked := runEvidenceGate(a, "/w/a.go")
	if !blocked || !strings.Contains(out.output, "anchor not found") {
		t.Fatalf("an invalid target must surface the writer's own error: %+v (blocked=%v)", out, blocked)
	}
}
