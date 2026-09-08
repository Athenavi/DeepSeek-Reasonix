package config

import "testing"

func TestUnknownDeepSeekVisionOverride(t *testing.T) {
	model := "deepseek-v4.1-flash-expires-on-0910"
	enabled := true
	e := ProviderEntry{Kind: "openai", BaseURL: "https://api.deepseek.com", Model: model}
	r := NewModelCapabilityResolver()
	if got := r.Resolve(&e); !got.ImageInputEnableAllowed || got.State != CapabilityUnknown {
		t.Fatalf("unknown model should permit manual declaration: %+v", got)
	}
	e.ModelOverrides = map[string]ProviderModelOverride{model: {Vision: &enabled}}
	if got := r.Resolve(&e); !got.ImageInputEnableAllowed || got.State != CapabilitySupported {
		t.Fatalf("override rejected: %+v", got)
	}
	e.Name = "deepseek-test"
	e.Model = ""
	e.Models = []string{"DeepSeek-V4.1-Flash-Expires-On-0910", model}
	cfg := Config{Providers: []ProviderEntry{e}}
	resolved, ok := cfg.ResolveModel(e.Name + "/" + model)
	if !ok || resolved.Model != model || !EffectiveVision(resolved) {
		t.Fatalf("lowercase model and its vision override did not resolve: %+v", resolved)
	}
}
