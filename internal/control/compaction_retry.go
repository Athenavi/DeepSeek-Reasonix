package control

import (
	"context"
	"errors"
)

type compactionRetryKey struct{}
type compactionRetryTarget struct{ runID, epoch string }

// WithCompactionRetry requires admission against the current failed operation.
// It retries only context maintenance, never a user turn or tool execution.
func WithCompactionRetry(ctx context.Context, runID, epoch string) context.Context {
	return context.WithValue(ctx, compactionRetryKey{}, compactionRetryTarget{runID, epoch})
}

// Runtime state precedes controller admission in the established lock order.
// Validate the retry and acquire execution ownership at the same boundary;
// two windows cannot both admit a retry using a pre-admission snapshot.
func (c *Controller) lockCompactionAdmission(ctx context.Context) error {
	c.runtimeState.mu.Lock()
	c.mu.Lock()
	state := c.runtimeState.snapshot
	c.runtimeState.mu.Unlock()
	if target, ok := ctx.Value(compactionRetryKey{}).(compactionRetryTarget); ok {
		progress := state.ContextCompaction
		if progress == nil || !progress.Retryable || progress.Status == "running" || progress.RunID != target.runID || state.RuntimeEpoch != target.epoch || progress.RuntimeEpoch != target.epoch {
			c.mu.Unlock()
			return errors.New("context compaction target changed; refresh the session")
		}
	}
	return nil
}
