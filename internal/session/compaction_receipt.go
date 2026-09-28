package session

import (
	"encoding/json"
	"reasonix/internal/event"
	"reasonix/internal/provider"
)

// Only the latest terminal receipt is retained in runtime checkpoints. History
// continues to own every display record, independently of the model projection.
func projectCompactionReceipt(projection *Projection, payload json.RawMessage) {
	var body struct {
		Type          string           `json:"type"`
		DisplayRecord provider.Message `json:"displayRecord"`
	}
	if json.Unmarshal(payload, &body) != nil || body.Type != "session-maintenance-v1" || body.DisplayRecord.Role != "compaction" {
		return
	}
	var op event.SessionOperationInfo
	if json.Unmarshal([]byte(body.DisplayRecord.Content), &op) != nil || op.ContextCompaction == nil {
		return
	}
	value := *op.ContextCompaction
	if value.RunID == "" || value.Status == "running" {
		return
	}
	if old := projection.ContextCompaction; old != nil && (old.StartedAt > value.StartedAt || old.RunID == value.RunID && old.Revision > value.Revision) {
		return
	}
	projection.ContextCompaction = &value
}
