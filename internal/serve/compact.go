package serve

import (
	"encoding/json"
	"io"
	"net/http"
	"reasonix/internal/control"
	"strings"
)

func (s *Server) compact(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Instructions string `json:"instructions"`
		RetryRunID   string `json:"retryRunId,omitempty"`
		RuntimeEpoch string `json:"runtimeEpoch,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if body.RetryRunID != "" {
		ctx = control.WithCompactionRetry(ctx, body.RetryRunID, body.RuntimeEpoch)
	}
	if err := s.ctl().Compact(ctx, strings.TrimSpace(body.Instructions)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
