package main

import (
	"os"
	"testing"
)

func TestUpdateHandoffOwnerPIDWaitsForShellParentInHostMode(t *testing.T) {
	app := &App{}
	if got := app.updateHandoffOwnerPID(); got != os.Getpid() {
		t.Fatalf("Wails owner pid = %d, want %d", got, os.Getpid())
	}
	app.hostShell = &hostShellBridge{app: app}
	if got := app.updateHandoffOwnerPID(); got != os.Getppid() {
		t.Fatalf("host-mode owner pid = %d, want parent %d", got, os.Getppid())
	}
}
