package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/BurntSushi/toml"
	"reasonix/internal/config"
)

// prepareLive reads the configured default provider using production credential
// resolution, then creates a private isolated experiment home. It never prints
// credentials or provider URLs and never edits the user's active Reasonix home.
func prepareLive(dest string) error {
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("destination must be absolute")
	}
	if _, err := os.Stat(filepath.Join(dest, "config.toml")); err == nil {
		return fmt.Errorf("experiment config already exists")
	}
	cfg, err := config.LoadForRoot(os.TempDir())
	if err != nil {
		return fmt.Errorf("cannot load configured provider")
	}
	entry, ok := cfg.ResolveModel(cfg.DefaultModel)
	if !ok {
		return fmt.Errorf("default provider is unavailable")
	}
	entry.ResolveAPIKeyForRoot(os.TempDir())
	key := entry.APIKey()
	if entry.RequiresAPIKey() && key == "" {
		return fmt.Errorf("default provider credential is unavailable")
	}
	entry.Name = "browser-live"
	entry.APIKeyEnv = "BROWSER_LAB_PROVIDER_KEY"
	entry.ModelsURL = ""
	entry.BalanceURL = ""
	entry.Models = nil
	entry.Default = ""
	if err := os.MkdirAll(dest, 0700); err != nil {
		return err
	}
	secret := []byte("BROWSER_LAB_PROVIDER_KEY=" + strconv.Quote(key) + "\n")
	if err := os.WriteFile(filepath.Join(dest, ".env"), secret, 0600); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dest, "config.toml"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	settings := map[string]any{
		"config_version": 5, "default_model": "browser-live", "providers": []config.ProviderEntry{*entry},
		"agent":       map[string]any{"task_cost_budget": 0.5, "task_time_budget_minutes": 3},
		"permissions": map[string]any{"mode": "ask", "ask": []string{"mcp__browser__act"}, "deny": []string{"bash", "write_file", "edit_file", "task"}},
		"tools":       map[string]any{"enabled": []string{"use_capability"}},
		"network":     map[string]any{"proxy_mode": cfg.Network.ProxyMode, "proxy_url": cfg.Network.ProxyURL},
	}
	if err := toml.NewEncoder(f).Encode(settings); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"prepared": true, "kind": entry.Kind, "model": entry.Model})
}
