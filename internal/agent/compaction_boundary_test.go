package agent

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"testing/synctest"
	"time"

	"reasonix/internal/event"
)

type cancellingSummaryRecorder struct {
	cancel context.CancelFunc
	calls  int
	t      *testing.T
}

func (*cancellingSummaryRecorder) CheckpointSession(context.Context, SessionCheckpointBoundary) error {
	return nil
}
func (r *cancellingSummaryRecorder) RecordSessionModelContext(ctx context.Context, _ SessionModelContextCommit) (SessionModelContextCommitResult, error) {
	r.calls++
	r.cancel()
	if ctx.Err() != nil {
		r.t.Fatal("accepted save inherited generation cancellation")
	}
	return SessionModelContextCommitResult{Accepted: true, Durable: true}, nil
}

func TestCompactionCancellationOnEitherSideOfCommit(t *testing.T) {
	for _, before := range []bool{true, false} {
		t.Run(map[bool]string{true: "before", false: "after"}[before], func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			recorder := &cancellingSummaryRecorder{cancel: cancel, t: t}
			var last event.ContextCompactionState
			sess := foldableSessionOverForce(8)
			original := sess.Snapshot()
			a := New(&fakeProvider{reply: "durable summary"}, nil, sess, Options{ContextWindow: 32000, SessionCheckpointer: recorder}, event.FuncSink(func(e event.Event) {
				if e.ContextCompaction == nil {
					return
				}
				last = *e.ContextCompaction
				if before && last.Phase == "saving" {
					cancel()
				}
			}))
			err := a.CompactNow(ctx, "")
			if before && !errors.Is(err, context.Canceled) {
				t.Fatalf("error=%v", err)
			}
			if before && (recorder.calls != 0 || last.Applied) {
				t.Fatal("cancelled candidate was installed")
			}
			if !before && (recorder.calls != 1 || !last.Applied || a.sess.checkpointState != "applied") {
				t.Fatalf("accepted save did not finish: %+v", last)
			}
			if !reflect.DeepEqual(original, sess.Snapshot()) {
				t.Fatal("canonical transcript changed")
			}
		})
	}
}

func TestCompactionPartialCommitThenBudgetFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var last event.ContextCompactionState
		a := New(&fakeProvider{reply: "first durable summary"}, nil, foldableSessionOverForce(8), Options{ContextWindow: 32000}, event.FuncSink(func(e event.Event) {
			if e.ContextCompaction != nil {
				last = *e.ContextCompaction
			}
		}))
		ctx, finish := a.beginCompactionRun(t.Context(), CompactionTriggerManual)
		if err := a.CompactNow(ctx, ""); err != nil {
			t.Fatal(err)
		}
		version := a.currentProjectionVersion()
		time.Sleep(4 * time.Minute)
		a.svc.prov = &slowSummaryProvider{}
		_, _, err := a.runSummaryRequest(ctx, a.summaryRequest(a.ModelHistorySnapshot(), ""))
		if err = finish(err); !errors.Is(err, errSummaryBudget) {
			t.Fatalf("error=%v", err)
		}
		if !last.Applied || last.Status != "failed" || last.Requests != 2 || a.currentProjectionVersion() != version {
			t.Fatalf("partial outcome=%+v", last)
		}
		revision := last.Revision
		compactionOutput(ctx, 100)
		publishCompactionOutput(ctx)
		if last.Revision != revision {
			t.Fatal("late output changed terminal state")
		}
	})
}

func TestCompactionQueuedStopNeverIssuesRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p := &slowSummaryProvider{}
		a := New(p, nil, foldableSessionOverForce(8), Options{ContextWindow: 32000}, event.Discard)
		a.sess.compactionRunMu.Lock()
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() { done <- a.CompactNow(ctx, "") }()
		synctest.Wait()
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		a.sess.compactionRunMu.Unlock()
		if p.calls != 0 {
			t.Fatal("cancelled queue entry started a request")
		}
	})
}

func TestBudgetRetainsOwnershipUntilIgnoredCancellationSettles(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p := &lateSummaryProvider{started: make(chan struct{}), release: make(chan struct{})}
		var last event.ContextCompactionState
		a := New(p, nil, foldableSessionOverForce(8), Options{ContextWindow: 32000}, event.FuncSink(func(e event.Event) {
			if e.ContextCompaction != nil {
				last = *e.ContextCompaction
			}
		}))
		done := make(chan error, 1)
		go func() { done <- a.CompactNow(WithCompactionCancellationGrace(t.Context(), time.Second), "") }()
		<-p.started
		time.Sleep(compactionBudget + time.Second)
		synctest.Wait()
		if last.Status != "recovery_required" {
			t.Fatalf("state=%+v", last)
		}
		select {
		case <-done:
			t.Fatal("execution ownership released while worker still running")
		default:
		}
		close(p.release)
		if err := <-done; !errors.Is(err, errSummaryBudget) {
			t.Fatal(err)
		}
		if a.currentProjectionVersion() != 0 || last.Status != "failed" {
			t.Fatalf("late result installed: %+v", last)
		}
	})
}
