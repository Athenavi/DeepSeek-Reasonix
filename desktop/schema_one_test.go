package main

import (
	"testing"

	"reasonix/internal/agent"
)

// isolateDesktopUserDirsSchemaOne pins a test to the schema-1 session writer:
// it exercises recovery-copy mechanics that only that path has.
func isolateDesktopUserDirsSchemaOne(t *testing.T) {
	t.Helper()
	t.Setenv(agent.SessionLogSchemaEnv, "v1")
	isolateDesktopUserDirs(t)
}
