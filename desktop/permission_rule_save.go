package main

import (
	"fmt"
	"strings"

	"reasonix/internal/permission"
	"reasonix/internal/tool"
)

func validateSavedPermissionRule(list, raw string, tools []tool.ContractEntry) error {
	rule, ok := permission.ParseRule(raw)
	if !ok {
		return nil // AddPermissionRule reports malformed rules.
	}
	for _, candidate := range tools {
		if permission.RuleMatchesString(rule.Tool, candidate.Name, "") {
			return nil
		}
	}
	if rule.Subject == "" && !strings.ContainsAny(rule.Tool, "()") {
		if strings.EqualFold(strings.TrimSpace(list), "allow") {
			return fmt.Errorf("permission rule %q names no registered tool; if this is a shell command, use Bash(%s)", raw, rule.Tool)
		}
		return fmt.Errorf("permission rule %q names no registered tool; if this is a shell command, use Bash(%s:*)", raw, rule.Tool)
	}
	return fmt.Errorf("permission rule %q names no registered tool", raw)
}
