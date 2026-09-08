package tool

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

// ReadResultProtocolVersion is the host-only read-result contract. Additive
// fields keep the version; changing an existing field's meaning bumps it.
const ReadResultProtocolVersion = 1

// ReadIntent records why a read happened. It is decided by the host from the
// call's arguments, never inferred from free text.
type ReadIntent string

const (
	// ReadIntentInspect is a bounded preview: completing one page completes the
	// obligation, and remaining content is not an outstanding read debt.
	ReadIntentInspect ReadIntent = "inspect"
	// ReadIntentRange is an explicit window: it completes at the window's end
	// or at EOF.
	ReadIntentRange ReadIntent = "range"
	// ReadIntentFull promises whole-file coverage on one content version.
	ReadIntentFull ReadIntent = "full"
)

// ReadRange is a half-open interval [Start, End) over zero-based line indices,
// matching read_file's offset argument. Line N (1-based) is index N-1.
type ReadRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Empty reports whether the range covers no lines.
func (r ReadRange) Empty() bool { return r.End <= r.Start }

// Lines returns the number of lines covered.
func (r ReadRange) Lines() int {
	if r.Empty() {
		return 0
	}
	return r.End - r.Start
}

// ReadCutReason names why a delivery stopped short of the source's end.
type ReadCutReason string

const (
	ReadCutNone       ReadCutReason = ""
	ReadCutPageLimit  ReadCutReason = "page_limit"  // requested line limit reached
	ReadCutSafetyPage ReadCutReason = "safety_page" // local formatted-byte safety page
	ReadCutToolOutput ReadCutReason = "tool_output" // provider-visible byte budget
)

// ReadResultSource identifies the exact content a result delivered.
type ReadResultSource struct {
	WorkspaceID   string `json:"workspace_id,omitempty"`
	CanonicalPath string `json:"canonical_path"`
	// VersionToken binds the delivered lines to their content: identical lines
	// at the same path produce the same token, and any edit inside the window
	// changes it. It never covers lines the read did not deliver.
	VersionToken string `json:"version_token,omitempty"`
}

// ReadResultEnvelope is host-only metadata describing what a reader actually
// delivered to the model. It never enters a provider request, and the model
// sees only the result text and its line numbers.
type ReadResultEnvelope struct {
	ProtocolVersion int              `json:"protocol_version"`
	ReadID          string           `json:"read_id,omitempty"`
	ResultRef       string           `json:"result_ref,omitempty"`
	Source          ReadResultSource `json:"source"`
	Intent          ReadIntent       `json:"intent"`
	// RequestedRange is nil when the caller requested no explicit window.
	RequestedRange  *ReadRange  `json:"requested_range,omitempty"`
	DeliveredRanges []ReadRange `json:"delivered_ranges,omitempty"`
	HasMore         bool        `json:"has_more"`
	// EOF reports that the delivered window reaches the source's end.
	EOF        bool          `json:"eof"`
	NextCursor string        `json:"next_cursor,omitempty"`
	SourceCut  ReadCutReason `json:"source_cut_reason,omitempty"`
	// TransportCut names a provider-visible truncation on top of the source cut.
	TransportCut ReadCutReason `json:"transport_cut_reason,omitempty"`
}

// ReadWindow is the contiguous numbered window a reader rendered.
type ReadWindow struct {
	StartLine int
	Lines     []string
}

// Range returns the zero-based half-open interval the window covers.
func (w ReadWindow) Range() ReadRange {
	return ReadRange{Start: w.StartLine - 1, End: w.StartLine - 1 + len(w.Lines)}
}

// ParseReadWindow extracts the contiguous `   42→text` window from a reader's
// output. Non-contiguous or unnumbered output returns ok=false: callers must
// fail closed rather than stitch unrelated windows into one observation.
func ParseReadWindow(output string) (ReadWindow, bool) {
	var w ReadWindow
	for line := range strings.SplitSeq(output, "\n") {
		arrow := strings.Index(line, "→")
		if arrow <= 0 {
			continue
		}
		lineNo, err := strconv.Atoi(strings.TrimSpace(line[:arrow]))
		if err != nil || lineNo < 1 {
			continue
		}
		if len(w.Lines) == 0 {
			w.StartLine = lineNo
		} else if lineNo != w.StartLine+len(w.Lines) {
			return ReadWindow{}, false
		}
		w.Lines = append(w.Lines, line[arrow+len("→"):])
	}
	if len(w.Lines) == 0 {
		return ReadWindow{}, false
	}
	return w, true
}

// ReadTrailer is the paging state a reader appends to its own result text. The
// zero value means no trailer was present.
type ReadTrailer struct {
	NextOffset   int
	RequestedEnd int
	HasMore      bool
	LocalSafety  bool
}

// ParseReadTrailer reads the reader's own paging trailer. It is the reader's
// format, not a third party's, so the reader owns both sides of it.
func ParseReadTrailer(output string) ReadTrailer {
	const safetyPrefix = "\n[read_file local safety page; next_offset="
	if start := strings.LastIndex(output, safetyPrefix); start >= 0 && strings.HasSuffix(output, "]\n") {
		fields := strings.TrimSuffix(output[start+len(safetyPrefix):], "]\n")
		parts := strings.Fields(fields)
		if len(parts) == 2 {
			next, nextErr := strconv.Atoi(parts[0])
			end, endErr := strconv.Atoi(strings.TrimPrefix(parts[1], "requested_end="))
			if nextErr == nil && endErr == nil && next >= 0 && end >= next {
				return ReadTrailer{NextOffset: next, RequestedEnd: end, HasMore: true, LocalSafety: true}
			}
		}
	}
	const prefix = "\n[more lines below; pass offset="
	start := strings.LastIndex(output, prefix)
	if start < 0 || !strings.HasSuffix(output, "]\n") {
		return ReadTrailer{}
	}
	value := output[start+len(prefix):]
	if end := strings.IndexAny(value, " ]\r\n"); end >= 0 {
		value = value[:end]
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 {
		return ReadTrailer{}
	}
	return ReadTrailer{NextOffset: n, HasMore: true}
}

// ReadWindowVersionToken binds canonicalPath and the window's delivered lines
// to one content version.
func ReadWindowVersionToken(canonicalPath string, w ReadWindow) string {
	h := sha256.New()
	h.Write([]byte("reasonix/read-window/v1\x00"))
	h.Write([]byte(canonicalPath))
	h.Write([]byte{0})
	h.Write([]byte(strconv.Itoa(w.StartLine)))
	for _, line := range w.Lines {
		h.Write([]byte{0})
		h.Write([]byte(line))
	}
	return "rw1:" + hex.EncodeToString(h.Sum(nil))
}

// ClipTo narrows the envelope to the numbered lines actually present in the
// provider-visible text, recording the transport cut. Callers pass the raw
// result unchanged when nothing was truncated.
func (e ReadResultEnvelope) ClipTo(visible string) ReadResultEnvelope {
	w, ok := ParseReadWindow(visible)
	if !ok {
		e.DeliveredRanges = nil
		e.HasMore = true
		e.EOF = false
		e.TransportCut = ReadCutToolOutput
		return e
	}
	visibleRange := w.Range()
	covered := len(e.DeliveredRanges) > 0
	for _, r := range e.DeliveredRanges {
		if r.Start < visibleRange.Start || r.End > visibleRange.End {
			covered = false
			break
		}
	}
	if covered {
		return e
	}
	var kept []ReadRange
	for _, r := range e.DeliveredRanges {
		if start, end := max(r.Start, visibleRange.Start), min(r.End, visibleRange.End); start < end {
			kept = append(kept, ReadRange{Start: start, End: end})
		}
	}
	e.DeliveredRanges = kept
	e.HasMore = true
	e.EOF = false
	e.TransportCut = ReadCutToolOutput
	e.NextCursor = EncodeReadCursor(ReadCursor{
		Path:      e.Source.CanonicalPath,
		Version:   e.Source.VersionToken,
		NextStart: visibleRange.End,
	})
	return e
}

// ReadCursor is a host-issued continuation reference. It is opaque to callers,
// bound to one canonical path and content version, and validated on decode, so
// a cursor cannot be replayed against another file, version, or session.
type ReadCursor struct {
	Path      string `json:"path"`
	Version   string `json:"version"`
	NextStart int    `json:"next_start"`
}

const readCursorPrefix = "rc1:"

// EncodeReadCursor renders a cursor as an opaque token.
func EncodeReadCursor(c ReadCursor) string {
	if c.Path == "" || c.Version == "" || c.NextStart < 0 {
		return ""
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return readCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeReadCursor parses a token produced by EncodeReadCursor.
func DecodeReadCursor(token string) (ReadCursor, bool) {
	rest, ok := strings.CutPrefix(token, readCursorPrefix)
	if !ok {
		return ReadCursor{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil {
		return ReadCursor{}, false
	}
	var c ReadCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return ReadCursor{}, false
	}
	if c.Path == "" || c.Version == "" || c.NextStart < 0 {
		return ReadCursor{}, false
	}
	return c, true
}

// Matches reports whether the cursor still belongs to this envelope: same
// canonical path, same content version, and a start inside the delivered range.
func (c ReadCursor) Matches(e ReadResultEnvelope) bool {
	if c.Path != e.Source.CanonicalPath || c.Version != e.Source.VersionToken {
		return false
	}
	if len(e.DeliveredRanges) == 0 {
		return false
	}
	last := e.DeliveredRanges[len(e.DeliveredRanges)-1]
	return c.NextStart >= last.Start && c.NextStart <= last.End
}

// ReadEnvelopeProvider is an optional reader capability that reports what it
// delivered. output is the reader's own result text; the host clips the
// returned envelope to the provider-visible bytes before using it.
type ReadEnvelopeProvider interface {
	ReadEnvelope(args json.RawMessage, output string) (ReadResultEnvelope, bool)
}
