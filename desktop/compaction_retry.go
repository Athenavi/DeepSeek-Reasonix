package main

import (
	"context"
	"errors"
	"reasonix/internal/control"
)

// RetryContextCompactionForTab retains the failed operation's identity through
// local admission or the existing remote session-fenced compact endpoint.
func (a *App) RetryContextCompactionForTab(tabID, runID, runtimeEpoch string) error {
	if runID == "" || runtimeEpoch == "" {
		return errors.New("context compaction identity missing")
	}
	if _, remote := a.remoteTabHostID(tabID); remote {
		return a.remoteTabPost(tabID, "/compact", map[string]any{"retryRunId": runID, "runtimeEpoch": runtimeEpoch})
	}
	tab, ctrl := a.tabAndCtrlByID(tabID)
	if a.tabIsReadOnly(tab) {
		return readOnlyChannelErr()
	}
	if ctrl == nil {
		return errors.New("session is not ready")
	}
	return ctrl.Compact(control.WithCompactionRetry(a.ctx, runID, runtimeEpoch), "")
}

// The server owns the single compaction budget and may finish an accepted save
// after that budget. Generic short command deadlines must not cancel it early.
func remoteMaintenanceCommandContext(a *App, path string) (context.Context, context.CancelFunc) {
	if path == "/compact" || path == "/summarize" {
		return context.WithCancel(a.bootContext())
	}
	return commandContext(a)
}
