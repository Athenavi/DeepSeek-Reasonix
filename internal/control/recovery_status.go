package control

import (
	"reasonix/internal/event"
	"reasonix/internal/provider"
)

func (c *Controller) applyToolRecoveryTurnStatus(done *event.Event) {
	if c == nil || c.executor == nil {
		return
	}
	if len(c.executor.PendingToolRecovery()) > 0 {
		done.Recovery = &event.RecoveryStatus{State: "recovery_required", Reason: "tool_effect_unconfirmed", RequiresUserDecision: true}
		return
	}
	if c.executor.SilentToolRecovery() {
		done.Recovery = &event.RecoveryStatus{State: "recovery_required", Reason: "silent_interruption"}
	}
}

func (c *Controller) applyLedgerRecoveryFacts(r *provider.InterruptedTurnRecovery) {
	if c == nil || r == nil {
		return
	}
	e := c.ledgerTailEvidence()
	if e == nil {
		return
	}
	r.Cause = "runtime_restart"
	r.TurnID = e.turnID
	if len(r.ToolCalls) == 0 && len(r.CompletedTools) == 0 && !r.DroppedPartialText && !r.DroppedPartialReasoning {
		r.SilentInterruption = true
	}
}
