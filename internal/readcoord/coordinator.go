package readcoord

import (
	"sort"
	"sync"

	"reasonix/internal/tool"
)

// Transition reports what one observation changed. Callers commit progress
// from it; nothing else mutates an obligation.
type Transition struct {
	Key        string
	Scope      Scope
	From, To   State
	Generation uint64
	Sequence   uint64
	// Added is the coverage this delivery contributed that was not already
	// known for the current version.
	Added []tool.ReadRange
	// Missing is what the requirement still lacks after the delivery.
	Missing  []tool.ReadRange
	Stale    bool
	Progress bool
	Stop     *Block
}

// Coordinator owns every obligation. It is safe for concurrent use, but the
// agent feeds it from the single mutation-ordered finalizer so decisions
// follow provider order.
type Coordinator struct {
	mu       sync.Mutex
	byKey    map[string]*Obligation
	sequence uint64
}

// New returns an empty coordinator.
func New() *Coordinator {
	return &Coordinator{byKey: map[string]*Obligation{}}
}

// Begin registers a requirement before its first call runs. Re-registering a
// key refreshes the requirement and keeps accumulated coverage.
func (c *Coordinator) Begin(key string, scope Scope, req Requirement) Obligation {
	c.mu.Lock()
	defer c.mu.Unlock()

	ob := c.byKey[key]
	if ob == nil {
		ob = &Obligation{Key: key, Scope: scope}
		c.byKey[key] = ob
	}
	ob.Scope = scope
	ob.Requirement = Requirement{Intent: req.Intent, Ranges: append([]tool.ReadRange(nil), req.Ranges...), WholeFile: req.WholeFile}
	// A new requirement revives a finished obligation: coverage stays valid
	// because it is scoped to one content version.
	if ob.State == StateCreated || ob.State.Terminal() {
		ob.State = StateFetching
	}
	return ob.clone()
}

// Observe folds one delivered envelope into its obligation. ok=false means the
// envelope carried no identity or the obligation was already terminal, so a
// cancelled or satisfied read is never resurrected by a late delivery.
func (c *Coordinator) Observe(env tool.ReadResultEnvelope) (Transition, bool) {
	if env.ReadID == "" || env.Source.CanonicalPath == "" {
		return Transition{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	ob := c.byKey[env.ReadID]
	if ob == nil {
		ob = &Obligation{
			Key:         env.ReadID,
			Scope:       Scope{WorkspaceID: env.Source.WorkspaceID, CanonicalPath: env.Source.CanonicalPath},
			Requirement: requirementFor(env),
		}
		c.byKey[ob.Key] = ob
	}
	if ob.State.Terminal() {
		return Transition{}, false
	}

	c.sequence++
	ob.Sequence = c.sequence
	tr := Transition{Key: ob.Key, Scope: ob.Scope, From: ob.State, Sequence: c.sequence}

	// Fragments of two content versions must never be stitched into one
	// coverage claim, so a version change discards what was accumulated.
	if ob.Version != "" && env.Source.Snapshot != "" && env.Source.Snapshot != ob.Version {
		ob.Covered = nil
		ob.SawEOF = false
		ob.SourceEnd = nil
		ob.Generation++
		tr.Stale = true
	}
	if env.Source.Snapshot != "" {
		ob.Version = env.Source.Snapshot
	}
	ob.SawEOF = ob.SawEOF || env.EOF
	if env.SourceEnd != nil {
		end := *env.SourceEnd
		ob.SourceEnd = &end
	}
	// A delivery supersedes an earlier stop reason: whatever blocked the read
	// no longer explains its state.
	ob.Stop = nil
	before := ob.Covered
	ob.Covered = Normalize(append(append([]tool.ReadRange(nil), ob.Covered...), env.DeliveredRanges...))
	tr.Added = Subtract(ob.Covered, before)
	tr.Progress = len(tr.Added) > 0
	ob.Pages++
	if tr.Progress {
		ob.Stagnant = 0
	} else {
		ob.Stagnant++
	}

	ob.State = evaluate(ob, env)
	tr.To = ob.State
	tr.Generation = ob.Generation
	tr.Missing = missingFor(ob)
	tr.Stop = ob.Stop
	return tr, true
}

// Fail records a read that could not deliver at all.
func (c *Coordinator) Fail(key string, block Block) (Transition, bool) {
	return c.stop(key, StateBlocked, block)
}

// Narrow records that the requirement cannot be met within the current budget.
// Only a local requirement may narrow; a whole-file requirement reports
// needs_scope instead of silently downgrading.
func (c *Coordinator) Narrow(key string, block Block) (Transition, bool) {
	return c.stop(key, StateNeedsScope, block)
}

func (c *Coordinator) stop(key string, state State, block Block) (Transition, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	ob := c.byKey[key]
	if ob == nil || ob.State.Terminal() {
		return Transition{}, false
	}
	c.sequence++
	ob.Sequence = c.sequence
	tr := Transition{Key: key, Scope: ob.Scope, From: ob.State, To: state, Sequence: c.sequence, Generation: ob.Generation}
	ob.State = state
	ob.Stop = &block
	tr.Stop = ob.Stop
	tr.Missing = missingFor(ob)
	return tr, true
}

// Cancel marks an obligation cancelled. Its state is terminal, so a later
// delivery for the same key is ignored.
func (c *Coordinator) Cancel(key string) (Transition, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	ob := c.byKey[key]
	if ob == nil || ob.State.Terminal() {
		return Transition{}, false
	}
	c.sequence++
	ob.Sequence = c.sequence
	tr := Transition{Key: key, Scope: ob.Scope, From: ob.State, To: StateCancelled, Sequence: c.sequence, Generation: ob.Generation}
	ob.State = StateCancelled
	return tr, true
}

// Get returns a copy of one obligation.
func (c *Coordinator) Get(key string) (Obligation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	ob, ok := c.byKey[key]
	if !ok {
		return Obligation{}, false
	}
	return ob.clone(), true
}

// Snapshot returns every obligation ordered by key.
func (c *Coordinator) Snapshot() []Obligation {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Obligation, 0, len(c.byKey))
	for _, ob := range c.byKey {
		out = append(out, ob.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func requirementFor(env tool.ReadResultEnvelope) Requirement {
	switch env.Intent {
	case tool.ReadIntentFull:
		return Requirement{Intent: tool.ReadIntentFull, WholeFile: true}
	case tool.ReadIntentRange:
		var ranges []tool.ReadRange
		if env.RequestedRange != nil {
			ranges = []tool.ReadRange{*env.RequestedRange}
		} else {
			ranges = append(ranges, env.DeliveredRanges...)
		}
		return Requirement{Intent: tool.ReadIntentRange, Ranges: Normalize(ranges)}
	default:
		return Requirement{Intent: tool.ReadIntentInspect}
	}
}

func evaluate(ob *Obligation, env tool.ReadResultEnvelope) State {
	switch ob.Requirement.Intent {
	case tool.ReadIntentInspect:
		// One bounded page completes an inspect requirement; content left in
		// the file is not an outstanding debt.
		return StateSatisfied
	case tool.ReadIntentRange:
		if len(ob.Requirement.Ranges) == 0 || Covers(ob.Covered, ob.Requirement.Ranges) {
			return StateSatisfied
		}
		// Reaching EOF satisfies a range only when the reader vouched for where
		// the source ends and that end is inside the requested window.
		if ob.SawEOF && ob.SourceEnd != nil && *ob.SourceEnd <= maxRangeEnd(ob.Requirement.Ranges) {
			return StateSatisfied
		}
		return StateNeedsMore
	case tool.ReadIntentFull:
		return evaluateWholeFile(ob, env)
	default:
		return StateDelivered
	}
}

func evaluateWholeFile(ob *Obligation, _ tool.ReadResultEnvelope) State {
	// A whole-file read is only proven by a trustworthy source end plus
	// contiguous coverage from line 0 on one version.
	if !ob.SawEOF || ob.SourceEnd == nil {
		return StateNeedsMore
	}
	if *ob.SourceEnd == 0 {
		return StateSatisfied
	}
	if len(ob.Covered) == 1 && ob.Covered[0].Start == 0 && ob.Covered[0].End >= *ob.SourceEnd {
		return StateSatisfied
	}
	return StateNeedsMore
}

func maxRangeEnd(ranges []tool.ReadRange) int {
	end := 0
	for _, r := range ranges {
		end = max(end, r.End)
	}
	return end
}

func missingFor(ob *Obligation) []tool.ReadRange {
	switch ob.Requirement.Intent {
	case tool.ReadIntentRange:
		return Subtract(ob.Requirement.Ranges, ob.Covered)
	case tool.ReadIntentFull:
		if len(ob.Covered) == 0 {
			return nil
		}
		return Subtract([]tool.ReadRange{{Start: 0, End: ob.Covered[len(ob.Covered)-1].End}}, ob.Covered)
	default:
		return nil
	}
}
