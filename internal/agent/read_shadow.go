package agent

import (
	"log/slog"

	"reasonix/internal/readcoord"
	"reasonix/internal/tool"
)

// readShadowState is the host-only shadow of the read coordinator. It folds the
// same deliveries the legacy incomplete-read state sees and records where the
// obligation model would decide differently; it changes no request.
type readShadowState struct {
	enabled       bool
	coord         *readcoord.Coordinator
	observed      int
	disagreements int
	byState       map[readcoord.State]int
}

func newReadShadowState(enabled bool) readShadowState {
	s := readShadowState{enabled: enabled}
	if enabled {
		s.coord = readcoord.New()
		s.byState = map[readcoord.State]int{}
	}
	return s
}

// observeReadShadow folds one delivered envelope and compares the coordinator's
// verdict with the legacy incomplete-read state. The legacy model treats any
// file with content left as an outstanding read; the obligation model treats a
// bounded inspect page as finished, and that difference is what this measures.
func (a *Agent) observeReadShadow(env tool.ReadResultEnvelope) {
	if a == nil {
		return
	}
	s := &a.turn.readShadow
	if !s.enabled || s.coord == nil {
		return
	}
	tr, ok := s.coord.Observe(env)
	if !ok {
		return
	}
	s.observed++
	s.byState[tr.To]++
	outstanding := tr.To == readcoord.StateNeedsMore || tr.To == readcoord.StateNeedsScope || tr.To == readcoord.StateBlocked
	if legacy := a.turn.incompleteReads.hasPending(); legacy != outstanding {
		s.disagreements++
		slog.Debug("agent: read coordinator shadow disagreement",
			"read_id", env.ReadID, "path", env.Source.CanonicalPath,
			"coordinator", tr.To.String(), "legacy_pending", legacy)
	}
}
