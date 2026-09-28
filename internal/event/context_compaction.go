package event

// ContextCompactionState is content-free host progress, never model input.
// Times are Unix milliseconds so reconnecting clients can render local clocks.
type ContextCompactionState struct {
	RunID             string `json:"runId"`
	ParentOperationID string `json:"parentOperationId,omitempty"`
	TurnID            string `json:"turnId,omitempty"`
	RuntimeEpoch      string `json:"runtimeEpoch,omitempty"`
	Revision          uint64 `json:"revision"`
	Trigger           string `json:"trigger"`
	Phase             string `json:"phase"`
	Status            string `json:"status"`
	StartedAt         int64  `json:"startedAt"`
	DeadlineAt        int64  `json:"deadlineAt"`
	ObservedAt        int64  `json:"observedAt"`
	LastOutputAt      int64  `json:"lastOutputAt,omitempty"`
	Requests          int    `json:"requests,omitempty"`
	CompletedParts    int    `json:"completedParts,omitempty"`
	TotalParts        int    `json:"totalParts,omitempty"`
	ErrorCode         string `json:"errorCode,omitempty"`
	Applied           bool   `json:"applied,omitempty"`
	Retryable         bool   `json:"retryable,omitempty"`
}
