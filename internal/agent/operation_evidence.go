package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"reasonix/internal/evidence"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// evidenceCheck is the host's verdict on whether a writer has the
// model-visible evidence its own declaration requires. It never grants
// permission: authorization, sandbox, uniqueness, and atomic replace stay
// independent.
type evidenceCheck struct {
	Satisfied bool
	// Supported is false when the writer cannot declare what it replaces; the
	// caller then keeps the existing boundary rather than assuming safety.
	Supported bool
	Path      string
	Missing   []tool.ReadRange
	Reason    string
	Recovery  string
}

// maxEvidenceReadPages bounds how much the host will read to prove a whole-file
// overwrite. Beyond it the check reports unsupported instead of scanning a huge
// file on every write.
const maxEvidenceReadPages = 16

// checkOperationEvidence asks the real writer what it is about to replace and
// verifies that the model has seen that exact content in this turn, before the
// batch boundary.
func (a *Agent) checkOperationEvidence(ctx context.Context, call provider.ToolCall, target tool.Tool, boundary uint64) evidenceCheck {
	if a == nil || a.task.ledger == nil || target == nil {
		return evidenceCheck{}
	}
	if target.ReadOnly() {
		return evidenceCheck{Satisfied: true, Supported: true}
	}
	declarer, ok := target.(tool.EvidenceDeclarer)
	if !ok {
		return evidenceCheck{}
	}
	info, err := declarer.DeclareEvidenceTarget(ctx, json.RawMessage(call.Arguments))
	if err != nil {
		return evidenceCheck{Supported: true, Reason: "target_invalid", Recovery: err.Error()}
	}
	if info.Path == "" {
		return evidenceCheck{Satisfied: true, Supported: true}
	}
	check := evidenceCheck{Supported: true, Path: info.Path}
	if info.WholeFile && len(info.Ranges) == 0 && len(info.Hashes) > 0 {
		info.Ranges = []tool.ReadRange{{Start: 0, End: len(info.Hashes)}}
	}
	if len(info.Ranges) == 0 && !info.WholeFile {
		// The writer creates a new file: there is no prior content to have seen.
		check.Satisfied = true
		return check
	}
	if info.WholeFile && len(info.Hashes) == 0 {
		hashes, ok := a.currentFileHashes(ctx, info.Path)
		if !ok {
			check.Reason = "whole_file_unverifiable"
			check.Recovery = fmt.Sprintf("the current content of %s could not be verified; read it first with read_file", info.Path)
			return check
		}
		info.Hashes = hashes
		info.Ranges = []tool.ReadRange{{Start: 0, End: len(hashes)}}
	}

	observations := a.eligibleObservations(info.Path, boundary)
	if len(observations) == 0 {
		check.Reason = "no_eligible_read"
		check.Missing = info.Ranges
		check.Recovery = fmt.Sprintf("read %s in a previous provider round, then retry; reads from the same batch do not count", info.Path)
		return check
	}
	if satisfied, missing := evidenceCoversTarget(observations, info); satisfied {
		check.Satisfied = true
		return check
	} else {
		check.Missing = missing
	}
	check.Reason = "stale_or_partial_evidence"
	check.Recovery = fmt.Sprintf("re-read the missing lines of %s, then retry", info.Path)
	return check
}

// eligibleObservations returns the model-visible windows for path recorded
// after the last write to it and before the frozen batch boundary.
func (a *Agent) eligibleObservations(path string, boundary uint64) []evidence.TextObservation {
	canonical := filepath.Clean(path)
	writeIndex, hasWrite := a.task.ledger.LatestSuccessfulWriteIndex([]string{path})
	var writeSequence uint64
	if hasWrite {
		writeSequence, _ = a.task.ledger.ReceiptSequence(writeIndex)
	}
	var out []evidence.TextObservation
	for _, o := range a.task.ledger.TextObservations() {
		if filepath.Clean(o.Path) != canonical || o.Sequence <= writeSequence || o.Sequence > boundary {
			continue
		}
		out = append(out, o)
	}
	return out
}

// evidenceCoversTarget reports whether the observations prove the exact
// current content the writer is about to replace. Windows from different
// snapshots are never stitched together.
func evidenceCoversTarget(observations []evidence.TextObservation, target tool.EvidenceTargetInfo) (bool, []tool.ReadRange) {
	if len(target.Hashes) == 0 {
		return false, target.Ranges
	}
	for _, window := range stitchBySnapshot(observations) {
		offset, matches := findHashSequence(window.hashes, target.Hashes)
		if matches != 1 {
			continue
		}
		start := window.startLine - 1 + offset
		covered := tool.ReadRange{Start: start, End: start + len(target.Hashes)}
		if rangesWithin(target.Ranges, covered) {
			return true, nil
		}
	}
	return false, target.Ranges
}

type hashWindow struct {
	startLine int
	hashes    []string
}

// stitchBySnapshot joins windows that share a content snapshot into the largest
// contiguous windows they can prove. Observations without a snapshot stay on
// their own: the host cannot vouch that they describe the same content version.
func stitchBySnapshot(observations []evidence.TextObservation) []hashWindow {
	bySnapshot := map[string][]evidence.TextObservation{}
	var singles []hashWindow
	for _, o := range observations {
		if o.Snapshot == "" {
			singles = append(singles, hashWindow{startLine: o.StartLine, hashes: o.LineHashes})
			continue
		}
		bySnapshot[o.Snapshot] = append(bySnapshot[o.Snapshot], o)
	}
	out := singles
	for _, group := range bySnapshot {
		slices.SortFunc(group, func(a, b evidence.TextObservation) int { return a.StartLine - b.StartLine })
		merged := hashWindow{startLine: group[0].StartLine, hashes: append([]string(nil), group[0].LineHashes...)}
		for _, o := range group[1:] {
			end := merged.startLine + len(merged.hashes)
			if o.StartLine > end {
				out = append(out, merged)
				merged = hashWindow{startLine: o.StartLine, hashes: append([]string(nil), o.LineHashes...)}
				continue
			}
			if o.StartLine+len(o.LineHashes) <= end {
				continue
			}
			overlap := end - o.StartLine
			merged.hashes = append(merged.hashes, o.LineHashes[overlap:]...)
		}
		out = append(out, merged)
	}
	return out
}

func rangesWithin(required []tool.ReadRange, covered tool.ReadRange) bool {
	for _, r := range required {
		if r.Empty() {
			continue
		}
		if r.Start < covered.Start || r.End > covered.End {
			return false
		}
	}
	return true
}

// currentFileHashes reads the file through the real reader so encoding, overlay
// routing, and line decoding match what a model would have seen. It is bounded
// and reports false rather than scanning an unbounded file.
func (a *Agent) currentFileHashes(ctx context.Context, path string) ([]string, bool) {
	reader, ok := a.svc.tools.Get("read_file")
	if !ok {
		return nil, false
	}
	var hashes []string
	offset := 0
	for range maxEvidenceReadPages {
		args, err := json.Marshal(map[string]any{"path": path, "offset": offset, "limit": readEvidencePageLines})
		if err != nil {
			return nil, false
		}
		out, err := reader.Execute(ctx, args)
		if err != nil {
			return nil, false
		}
		window, ok := tool.ParseReadWindow(out)
		if !ok {
			return nil, false
		}
		for _, line := range window.Lines {
			hashes = append(hashes, hashLine(line))
		}
		trailer := tool.ParseReadTrailer(out)
		if !trailer.HasMore {
			return hashes, true
		}
		if trailer.NextOffset <= offset {
			return nil, false
		}
		offset = trailer.NextOffset
	}
	return nil, false
}

const readEvidencePageLines = 2000

func hashLine(line string) string {
	sum := sha256.Sum256([]byte(line))
	return hex.EncodeToString(sum[:])
}

// describeEvidence renders a bounded, actionable summary for the blocked tool
// result; it never includes source text.
func describeEvidence(check evidenceCheck, toolName string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "blocked: [evidence required] %s targets %s, but the model has not seen its current content", toolName, check.Path)
	if len(check.Missing) > 0 {
		b.WriteString(" (missing lines ")
		for i, r := range check.Missing {
			if i > 0 {
				b.WriteString(", ")
			}
			fmt.Fprintf(&b, "%d-%d", r.Start+1, r.End)
		}
		b.WriteString(")")
	}
	if check.Recovery != "" {
		b.WriteString("; " + check.Recovery)
	}
	return b.String()
}

// applyEvidenceGates blocks a writer whose own declaration says it would
// replace content the model has not seen this turn. It is off unless the run
// enabled it, and it never replaces authorization, sandbox, or uniqueness.
func (a *Agent) applyEvidenceGates(ctx context.Context, plan *toolCallPlan) (toolOutcome, bool) {
	if a == nil || !a.reads.gates || a.task.ledger == nil || a.svc.tools == nil {
		return toolOutcome{}, false
	}
	resolved, _, ambiguous := a.svc.tools.ResolveCall(plan.call.Name)
	if resolved == nil || len(ambiguous) > 0 {
		return toolOutcome{}, false
	}
	boundary := observationBoundary(ctx, a.task.ledger.ObservationBoundary())
	check := a.checkOperationEvidence(ctx, plan.call, resolved, boundary)
	if a.turn.evidenceBlocked == nil {
		a.turn.evidenceBlocked = map[string]struct{}{}
	}
	switch {
	case check.Satisfied:
		return toolOutcome{}, false
	case !check.Supported:
		// A writer that cannot declare its target is never granted a pass. While
		// another writer is blocked for missing evidence, it must not become the
		// way around that block.
		if len(a.turn.evidenceBlocked) == 0 || resolved.ReadOnly() {
			return toolOutcome{}, false
		}
		msg := fmt.Sprintf("blocked: [evidence required] %s cannot declare which files it changes while a read-evidence requirement is outstanding (%s); use the exact file tool for those paths",
			plan.call.Name, strings.Join(sortedPaths(a.turn.evidenceBlocked), ", "))
		return toolOutcome{output: msg, blocked: true, errMsg: firstLine(msg)}, true
	}
	a.turn.evidenceBlocked[check.Path] = struct{}{}
	msg := describeEvidence(check, plan.call.Name)
	return toolOutcome{output: msg, blocked: true, errMsg: firstLine(msg)}, true
}

func sortedPaths(paths map[string]struct{}) []string {
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	slices.Sort(out)
	return out
}
