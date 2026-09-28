package main

import (
	"os"
	"strings"
	"testing"

	"reasonix/internal/config"
	"reasonix/internal/tool"
)

func TestAddPermissionRuleRejectsBareShellCommandBeforeSaving(t *testing.T) {
	t.Setenv("REASONIX_HOME", t.TempDir())
	if err := (&App{}).AddPermissionRule("deny", "rm"); err == nil || !strings.Contains(err.Error(), "Bash(rm:*)") {
		t.Fatalf("AddPermissionRule(deny, rm) = %v, want a Bash rule suggestion", err)
	}
	if _, err := os.Stat(config.UserConfigPath()); !os.IsNotExist(err) {
		t.Fatalf("rejected rule wrote config: stat error = %v", err)
	}
}

func TestValidateSavedPermissionRuleUsesRegisteredTools(t *testing.T) {
	registered := []tool.ContractEntry{{Name: "bash"}, {Name: "write_file"}, {Name: "plugin_custom"}}
	for _, tc := range []struct {
		list, rule, suggestion string
	}{
		{"deny", "rm", "Bash(rm:*)"},
		{"ask", "git reset", "Bash(git reset:*)"},
		{"allow", "git branch", "Bash(git branch)"},
	} {
		err := validateSavedPermissionRule(tc.list, tc.rule, registered)
		if err == nil || !strings.Contains(err.Error(), tc.suggestion) {
			t.Errorf("%s %q: got %v, want %q suggestion", tc.list, tc.rule, err, tc.suggestion)
		}
	}
	for _, rule := range []string{"Bash(rm:*)", "Edit(src/**)", "plugin_custom"} {
		if err := validateSavedPermissionRule("deny", rule, registered); err != nil {
			t.Errorf("registered rule %q: %v", rule, err)
		}
	}
	if err := validateSavedPermissionRule("deny", "Bash(rm:*)", tool.BuiltinContractEntries()); err != nil {
		t.Errorf("desktop built-in Bash rule: %v", err)
	}
}
