package openai

import "reasonix/internal/provider"

// ReasoningForConfig is pure: capability discovery never reads credentials or
// performs I/O. It shares the adapter's endpoint and protocol predicates.
func ReasoningForConfig(cfg provider.Config) provider.ReasoningCapability {
	protocol, _ := cfg.Extra["reasoning_protocol"].(string)
	protocol = normalizeReasoningProtocol(protocol)
	if protocol == "none" {
		return provider.ReasoningOptions("")
	}
	var cap provider.ReasoningCapability
	switch {
	case usesKimiK3Contract(protocol, cfg.BaseURL, cfg.Model):
		return provider.ReasoningOptions("max", "low", "high", "max")
	case protocol == "glm" || (protocol == "" && (IsZhipu(cfg.BaseURL) || IsLongCat(cfg.BaseURL))):
		cap = provider.ReasoningOptions("enabled", "enabled", "disabled")
	case protocol == "" && IsMiniMax(cfg.BaseURL):
		cap = provider.ReasoningOptions("adaptive", "adaptive", "disabled")
	case protocol == "deepseek" || (protocol == "" && IsDeepSeek(cfg.BaseURL)):
		cap = provider.ReasoningOptions("high", "disabled", "high", "max")
		if cfg.Model == "deepseek-v4-flash" || cfg.Model == "deepseek-v4-pro" || IsOfficialDeepSeekVisionModel(cfg.Model) {
			cap = provider.ReasoningOptions("high", "disabled", "low", "high", "max")
		}
	case protocol == "" && IsOllamaCloud(cfg.BaseURL):
		cap = provider.ReasoningOptions("", "none", "low", "medium", "high", "max")
	case protocol == "openai" || (protocol == "" && IsMiMo(cfg.BaseURL)):
		cap = provider.ReasoningOptions("", "low", "medium", "high")
	default:
		cap = provider.ReasoningOptions("")
	}
	cap = provider.DeclaredReasoning(cfg, cap)
	if protocol == "glm" || (protocol == "" && (IsZhipu(cfg.BaseURL) || IsLongCat(cfg.BaseURL))) {
		cap = provider.RestrictReasoning(cap, "enabled", "disabled")
	}
	if protocol == "" && IsMiniMax(cfg.BaseURL) {
		cap = provider.RestrictReasoning(cap, "adaptive", "disabled")
	}
	if configuredThinkingType(cfg) == "disabled" {
		return provider.ReasoningOptions("disabled", "disabled")
	}
	return cap
}
func (c *client) ReasoningCapability() provider.ReasoningCapability { return c.reasoning.Clone() }
