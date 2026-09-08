package agent

import (
	"encoding/json"

	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// readResultEnvelopeFor builds the host-only envelope for one reader result:
// the reader supplies what it delivered, and the host adds call identity and
// clips the envelope to the provider-visible bytes. ok=false means the tool
// cannot describe its delivery, so the message carries no envelope rather than
// a fabricated one.
func (a *Agent) readResultEnvelopeFor(call provider.ToolCall, o toolOutcome) (tool.ReadResultEnvelope, bool) {
	if a == nil || a.svc.tools == nil {
		return tool.ReadResultEnvelope{}, false
	}
	resolved, _, ambiguous := a.svc.tools.ResolveCall(call.Name)
	if resolved == nil || len(ambiguous) > 0 {
		return tool.ReadResultEnvelope{}, false
	}
	reader, ok := resolved.(tool.ReadEnvelopeProvider)
	if !ok {
		return tool.ReadResultEnvelope{}, false
	}
	raw := o.rawOutput
	if raw == "" {
		raw = o.output
	}
	env, ok := reader.ReadEnvelope(json.RawMessage(call.Arguments), raw)
	if !ok {
		return tool.ReadResultEnvelope{}, false
	}
	if o.rawOutput != "" && o.rawOutput != o.output {
		env = env.ClipTo(o.output)
	}
	env.ResultRef = toolResultRef(call.ID, raw)
	env.ReadID = incompleteReadID(call.ID, env.ResultRef, env.Source.CanonicalPath)
	env.Source.WorkspaceID = a.workspaceID
	return env, true
}
