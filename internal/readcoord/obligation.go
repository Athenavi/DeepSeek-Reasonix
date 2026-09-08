package readcoord

import "reasonix/internal/tool"

// Scope identifies the file a read requirement targets.
type Scope struct {
	WorkspaceID   string
	CanonicalPath string
}

// State is the lifecycle position of one read requirement.
type State uint8

const (
	StateCreated State = iota
	StateFetching
	StateDelivered
	StateSatisfied
	StateNeedsMore
	StateNeedsScope
	StateStale
	StateBlocked
	StateCancelled
)

var stateNames = [...]string{
	StateCreated:    "created",
	StateFetching:   "fetching",
	StateDelivered:  "delivered",
	StateSatisfied:  "satisfied",
	StateNeedsMore:  "needs_more",
	StateNeedsScope: "needs_scope",
	StateStale:      "stale",
	StateBlocked:    "blocked",
	StateCancelled:  "cancelled",
}

func (s State) String() string {
	if int(s) < len(stateNames) {
		return stateNames[s]
	}
	return "unknown"
}

// Terminal reports whether the obligation can no longer be moved by a delivery.
func (s State) Terminal() bool { return s == StateSatisfied || s == StateCancelled }

// Requirement is what a read must cover to be satisfied.
type Requirement struct {
	Intent tool.ReadIntent
	// Ranges is the explicit coverage a range requirement must reach.
	Ranges []tool.ReadRange
	// WholeFile means the requirement covers the file's entire content at the
	// obligation's version: only a delivery that reached EOF satisfies it.
	WholeFile bool
}

// Block explains why an obligation stopped and what would resume it.
type Block struct {
	Code     string
	Detail   string
	Recovery string
}

// Obligation is one logical read requirement plus the coverage accumulated for
// it. Coverage is only ever accumulated within one content version.
type Obligation struct {
	Key         string
	Scope       Scope
	Requirement Requirement
	State       State
	// Version is the content version coverage belongs to. A delivery from a
	// different version resets coverage instead of extending it.
	Version string
	// Covered is the union of delivered ranges on Version, in normalized order.
	Covered []tool.ReadRange
	// SawEOF reports that some delivery on Version reached the file's end.
	SawEOF     bool
	Generation uint64
	Sequence   uint64
	Pages      int
	// Stagnant counts consecutive deliveries that added no new coverage.
	Stagnant int
	// Stop carries the reason for StateBlocked or StateNeedsScope.
	Stop *Block
}
