package main

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

func TestRemoteCompactionBudgetRemainsOwnedByServer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parent, stop := context.WithCancel(t.Context())
		defer stop()
		a := &App{ctx: parent}
		ctx, cancel := remoteMaintenanceCommandContext(a, "/compact")
		defer cancel()
		time.Sleep(20 * time.Second)
		if ctx.Err() != nil {
			t.Fatal("generic command timeout cut off server compaction budget")
		}
		stop()
		if ctx.Err() != context.Canceled {
			t.Fatal("application shutdown did not cancel remote request")
		}
	})
}
