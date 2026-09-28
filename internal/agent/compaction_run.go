package agent

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const compactionBudget = 5 * time.Minute

// SummaryError keeps the failure identity without changing the wire contract.
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
	var persistence *compactionPersistenceError
	if errors.As(err, &typed) || errors.As(err, &persistence) || errors.Is(err, context.Canceled) {
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
type compactionRun struct{ work context.Context }

func currentCompactionRun(ctx context.Context) *compactionRun {
	run, _ := ctx.Value(compactionRunKey{}).(*compactionRun)
	return run
}

// Every nested summary, replan, and chunk inherits the same deadline. The
// caller's ordinary answer context is not cancelled by this work budget.
func (a *Agent) beginCompactionRun(parent context.Context) (context.Context, func(error) error) {
	if parent == nil {
		parent = context.Background()
	}
	if run := currentCompactionRun(parent); run != nil {
		return run.work, func(err error) error { return err }
	}
	ctx, cancel := context.WithTimeoutCause(parent, compactionBudget, errSummaryBudget)
	run := &compactionRun{}
	ctx = context.WithValue(ctx, compactionRunKey{}, run)
	run.work = ctx
	return ctx, func(err error) error {
		defer cancel()
		return compactionError(ctx, err)
	}
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

func (e *compactionPersistenceError) Unwrap() error { return e.error }
