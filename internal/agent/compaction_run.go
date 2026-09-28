package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"reasonix/internal/event"
	"reasonix/internal/provider"
)

const compactionBudget = 5 * time.Minute

// SummaryError preserves the provider/cancellation cause while exposing a stable
// host error code. It never classifies persistence failures as provider failures.
type SummaryError struct {
	Code  string
	Cause error
}

func (e *SummaryError) Error() string { return fmt.Sprintf("%s: %v", e.Code, e.Cause) }
func (e *SummaryError) Unwrap() error { return e.Cause }

var errSummaryEmpty = errors.New("summarizer returned empty output")
var errSummaryBudget = &SummaryError{Code: "summary_budget_exceeded", Cause: context.DeadlineExceeded}

func summaryError(err error) error {
	if err == nil {
		return nil
	}
	var typed *SummaryError
	if errors.As(err, &typed) {
		return err
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	code := "summary_provider_error"
	switch {
	case errors.Is(err, errSummaryEmpty):
		code = "summary_empty"
	case errors.Is(err, errSummaryOutputTruncated):
		code = "summary_output_truncated"
	case errors.Is(err, errCheckpointRejected):
		code = "summary_no_reduction"
	case errors.Is(err, errCompressStaleContext):
		code = "summary_context_changed"
	}
	return &SummaryError{Code: code, Cause: err}
}

type compactionRunKey struct{}
type compactionParentKey struct{}
type compactionGraceKey struct{}

var compactionRunSequence atomic.Uint64

// WithCompactionParent associates shared agent progress with a manual operation.
func WithCompactionParent(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, compactionParentKey{}, id)
}

// WithCompactionCancellationGrace shares the controller's existing worker grace.
func WithCompactionCancellationGrace(ctx context.Context, grace time.Duration) context.Context {
	return context.WithValue(ctx, compactionGraceKey{}, grace)
}

type compactionRun struct {
	mu        sync.Mutex
	publishMu sync.Mutex
	state     event.ContextCompactionState
	agent     *Agent
	before    uint64
	captured  bool
	active    bool
	dirty     bool
	wake      chan struct{}
	work      context.Context
	failure   error
}

func currentCompactionRun(ctx context.Context) *compactionRun {
	run, _ := ctx.Value(compactionRunKey{}).(*compactionRun)
	return run
}

// beginCompactionRun is shared by every entry point. Nested requests inherit
// the original deadline, including fragment summaries and overflow replans.
func (a *Agent) beginCompactionRun(parent context.Context, trigger string) (context.Context, func(error) error) {
	if parent == nil {
		parent = context.Background()
	}
	if run := currentCompactionRun(parent); run != nil {
		if trigger == CompactionTriggerOverflow {
			run.mu.Lock()
			run.state.Trigger = trigger
			run.mu.Unlock()
		}
		return run.work, func(err error) error { return err }
	}
	now := time.Now()
	ctx, cancel := context.WithTimeoutCause(parent, compactionBudget, errSummaryBudget)
	deadline, _ := ctx.Deadline()
	parentID, _ := parent.Value(compactionParentKey{}).(string)
	r := &compactionRun{agent: a, wake: make(chan struct{}, 1), state: event.ContextCompactionState{
		RunID: fmt.Sprintf("compact-%d-%d", now.UnixNano(), compactionRunSequence.Add(1)), ParentOperationID: parentID,
		Trigger: trigger, Phase: "preparing", Status: "running", StartedAt: now.UnixMilli(), DeadlineAt: deadline.UnixMilli(),
	}}
	ctx = context.WithValue(ctx, compactionRunKey{}, r)
	r.work = ctx
	return ctx, func(err error) error {
		if !r.active {
			cancel()
			return err
		}
		err = compactionError(ctx, err)
		r.mu.Lock()
		failure := r.failure
		r.mu.Unlock()
		terminalErr := summaryError(err)
		if terminalErr == nil {
			terminalErr = failure
		}
		r.mu.Lock()
		r.state.Status = "completed"
		r.state.Applied = r.captured && a.currentProjectionVersion() > r.before
		if terminalErr != nil {
			r.state.Status = "failed"
			r.state.Retryable = true
			var typed *SummaryError
			if errors.As(terminalErr, &typed) {
				r.state.ErrorCode = typed.Code
			}
			if errors.Is(terminalErr, context.Canceled) {
				r.state.Status = "cancelled"
			}
			var persistence *compactionPersistenceError
			if errors.As(terminalErr, &persistence) {
				r.state.Status = "recovery_required"
				r.state.ErrorCode = "save_failed"
				r.state.Retryable = false
			}
		}
		r.mu.Unlock()
		if publishErr := r.publish(); publishErr != nil {
			err = &compactionPersistenceError{publishErr}
			r.mu.Lock()
			r.state.Status, r.state.ErrorCode, r.state.Retryable = "recovery_required", "save_failed", false
			r.mu.Unlock()
		}
		cancel()
		if r.active {
			slog.Info("context compaction finished", "run_id", r.state.RunID, "trigger", r.state.Trigger,
				"status", r.state.Status, "error_code", r.state.ErrorCode, "applied", r.state.Applied,
				"elapsed_ms", time.Since(now).Milliseconds(), "requests", r.state.Requests,
				"last_output_at", r.state.LastOutputAt, "completed_parts", r.state.CompletedParts)
		}
		return err
	}
}

func (r *compactionRun) publish() error {
	r.publishMu.Lock()
	defer r.publishMu.Unlock()
	r.mu.Lock()
	if !r.active {
		r.mu.Unlock()
		return nil
	}
	r.state.Revision++
	r.state.ObservedAt = time.Now().UnixMilli()
	snapshot := r.state
	r.dirty = false
	r.mu.Unlock()
	return event.EmitChecked(r.agent.svc.sink, event.Event{Kind: event.ContextCompactionProgress, ContextCompaction: &snapshot})
}

func publishCompactionOutput(ctx context.Context) {
	if r := currentCompactionRun(ctx); r != nil {
		r.mu.Lock()
		dirty := r.dirty
		r.mu.Unlock()
		if dirty {
			_ = r.publish() // Transient display update; finalization checks durability.
		}
	}
}

func compactionPhase(ctx context.Context, phase string) {
	if r := currentCompactionRun(ctx); r != nil {
		r.mu.Lock()
		if r.state.Status != "running" {
			r.mu.Unlock()
			return
		}
		r.active = true
		r.state.Phase = phase
		if phase == "waiting_response" {
			r.state.Requests++
		}
		r.mu.Unlock()
		_ = r.publish() // Phase updates do not persist a terminal receipt.
	}
}

func compactionOutput(ctx context.Context, _ int) {
	if r := currentCompactionRun(ctx); r != nil {
		r.mu.Lock()
		if r.state.Status != "running" {
			r.mu.Unlock()
			return
		}
		first := r.state.Phase != "generating"
		r.state.Phase = "generating"
		r.state.LastOutputAt = time.Now().UnixMilli()
		r.dirty = true
		r.mu.Unlock()
		if first {
			select {
			case r.wake <- struct{}{}:
			default:
			}
		}
	}
}

func compactionFailure(ctx context.Context, err error) error {
	err = compactionError(ctx, err)
	if r := currentCompactionRun(ctx); r != nil {
		r.mu.Lock()
		r.failure = err
		r.mu.Unlock()
	}
	return err
}

func compactionError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var persistence *compactionPersistenceError
	if errors.As(err, &persistence) {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return ctx.Err()
	}
	if errors.Is(context.Cause(ctx), errSummaryBudget) {
		if errors.Is(err, ErrCompactionRequired) {
			return fmt.Errorf("%w: %w", ErrCompactionRequired, errSummaryBudget)
		}
		return errSummaryBudget
	}
	return summaryError(err)
}

type compactionPersistenceError struct{ error }

func drainSummaryStream(ctx context.Context, cancel context.CancelFunc, ch <-chan provider.Chunk) {
	cancel()
	grace, _ := ctx.Value(compactionGraceKey{}).(time.Duration)
	if grace <= 0 {
		grace = 15 * time.Second
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timer.C:
			compactionWorkerRecovery(ctx)
		}
	}
}

func compactionWorkerRecovery(ctx context.Context) {
	if r := currentCompactionRun(ctx); r != nil {
		r.mu.Lock()
		r.state.Status, r.state.ErrorCode = "recovery_required", "cancel_timeout"
		r.state.Applied = r.captured && r.agent.currentProjectionVersion() > r.before
		r.mu.Unlock()
		_ = r.publish() // Retain worker ownership even if the recovery notification fails.
	}
}

func captureCompactionBaseline(ctx context.Context) {
	if r := currentCompactionRun(ctx); r != nil && !r.captured {
		r.before = r.agent.currentProjectionVersion()
		r.captured = true
	}
}

func observeSummaryRequest(ctx context.Context) (context.Context, func()) {
	started := time.Now()
	var tools atomic.Int64
	observed := provider.WithAuxiliaryOutputObserver(ctx, func(value provider.AuxiliaryProgress) {
		tools.Add(int64(value.ToolCalls))
		if value.OutputBytes > 0 {
			compactionOutput(ctx, value.OutputBytes)
		}
	})
	return observed, func() {
		slog.Debug("summary request finished", "elapsed_ms", time.Since(started).Milliseconds(), "tool_call_chunks", tools.Load())
	}
}
