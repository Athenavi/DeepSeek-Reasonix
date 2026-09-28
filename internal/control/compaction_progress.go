package control

import (
	"context"
	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/provider"
)

// Progress bypasses the durable turn ledger; only the terminal receipt writes
// a provider-excluded display row. Manual operations persist their own terminal.
func (s *turnEventSink) publishCompactionProgress(e event.Event) error {
	if e.ContextCompaction == nil {
		return nil
	}
	state := *e.ContextCompaction
	runtime := s.c.RuntimeStateSnapshot()
	state.TurnID, state.RuntimeEpoch = runtime.TurnID, runtime.RuntimeEpoch
	e.ContextCompaction = &state
	if state.Status != "running" && state.ParentOperationID == "" {
		op := &event.SessionOperationInfo{OperationID: state.RunID, OperationRevision: state.Revision, RuntimeEpoch: state.RuntimeEpoch,
			Kind: "context_compaction", Trigger: state.Trigger, Activity: state.Phase, Status: state.Status,
			ErrorCode: state.ErrorCode, Applied: state.Applied, ContextCompaction: &state}
		if state.Applied && s.c.executor != nil {
			op.Summary = s.c.executor.LastCompactionSummary()
		}
		if err := s.c.persistMaintenanceOperation(event.Event{Kind: event.SessionOperation, SessionOperation: op}); err != nil {
			state.Status, state.ErrorCode, state.Retryable = "recovery_required", "save_failed", false
			// Keep the runtime truthful even when its terminal history receipt
			// cannot be made durable. The existing ledger failure owns recovery.
			_ = s.publishOutsideTurn(s.c.turnEventLedger(), e)
			return err
		}
	}
	return s.publishOutsideTurn(s.c.turnEventLedger(), e)
}

func applyCompactionRuntimeState(next *event.RuntimeStateSnapshot, e event.Event) {
	if e.ContextCompaction == nil {
		return
	}
	value := *e.ContextCompaction
	prior := next.ContextCompaction
	if value.RuntimeEpoch != "" && next.RuntimeEpoch != "" && value.RuntimeEpoch != next.RuntimeEpoch {
		return
	}
	if prior != nil {
		if prior.RunID == value.RunID && (value.Revision <= prior.Revision || prior.Status != "running" && value.Status == "running") {
			return
		}
		if prior.RunID != value.RunID && value.StartedAt < prior.StartedAt {
			return
		}
	}
	next.ContextCompaction = &value
}

func compactionSaving(state *event.ContextCompactionState) bool {
	return state != nil && state.Status == "running" && state.Phase == "saving"
}

func restoreCompactionRuntimeState(next *event.RuntimeStateSnapshot, saved *event.ContextCompactionState) {
	if next.ContextCompaction == nil && saved != nil && saved.Status != "running" {
		value := *saved
		value.RuntimeEpoch = next.RuntimeEpoch
		next.ContextCompaction = &value
	}
}

func (c *Controller) withCompactionTransportObservation(ctx context.Context) context.Context {
	ctx = agent.WithCompactionCancellationGrace(ctx, c.cancellationGrace())
	return provider.WithAdditionalRequestObserver(ctx, func(value provider.RequestObservation) {
		c.recordProviderRequest("", value)
	})
}

func applyRuntimeCancellation(next *event.RuntimeStateSnapshot, maintenance *event.MaintenanceState) {
	next.Cancellable = next.Phase == "executing" || next.Phase == "cancelling" || next.PendingPrompt
	if maintenance != nil && (maintenance.Activity == "finalizing" || maintenance.Activity == "recovery_required") {
		next.Cancellable = false
	}
	if compactionSaving(next.ContextCompaction) || next.ContextCompaction != nil && next.ContextCompaction.Status == "recovery_required" {
		next.Cancellable = false
	}
}
