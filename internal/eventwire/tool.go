package eventwire

import "reasonix/internal/event"

func toWireTool(in event.Tool) *Tool {
	wt := &Tool{
		ID: in.ID, Name: in.Name, Args: in.Args,
		ResolvedName: in.ResolvedName, CapabilityID: in.CapabilityID,
		Output: in.Output, Err: in.Err,
		ReadOnly: in.ReadOnly, Truncated: in.Truncated,
		DurationMs: in.DurationMs, Partial: in.Partial,
		StartedAt: in.StartedAt, EndedAt: in.EndedAt,
		ArgChars: in.ArgChars, Refreshed: in.Refreshed,
		ParentID: in.ParentID, AttemptID: in.AttemptID,
		Diff: in.Diff, Added: in.Added, Removed: in.Removed,
		SubagentRef: in.SubagentRef, SubagentStatus: in.SubagentStatus,
		SubagentErrorCode: in.SubagentErrorCode, SubagentRetryable: in.SubagentRetryable,
	}
	if in.Profile != nil {
		wt.Profile = &Profile{Model: in.Profile.Model, Effort: in.Profile.Effort}
	}
	if in.Execution != nil {
		wt.Execution = toWireShellExecution(in.Execution)
	}
	return wt
}
