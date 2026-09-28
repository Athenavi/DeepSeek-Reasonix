package main

import (
	"fmt"
	"strings"

	"reasonix/internal/config"
	"reasonix/internal/permission"
	"reasonix/internal/tool"
)

// AddPermissionRule appends a rule to the allow/ask/deny list.
func (a *App) AddPermissionRule(list, rule string) error {
	tools := tool.BuiltinContractEntries()
	if ctrl, ok := a.activeCtrl().(interface{ AllToolContractEntries() []tool.ContractEntry }); ok {
		tools = append(tools, ctrl.AllToolContractEntries()...)
	}
	if err := validateSavedPermissionRule(list, rule, tools); err != nil {
		return err
	}
	return a.applyConfigChange(func(c *config.Config) error { return c.AddPermissionRule(list, rule) })
}

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
