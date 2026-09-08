//go:build live

package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

type liveReadBudgetKey struct{}

// The HTTP boundary counts every upstream attempt, including adapter retries.
// Unknown usage retains a conservative full-window reservation. Nothing here
// stores or logs Authorization, request bodies, or source text.
type liveReadBudget struct {
	mu               sync.Mutex
	requests, tokens int
	cancel           context.CancelFunc
}

const liveReadRequestReservation = 128_000

func (b *liveReadBudget) admit() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.requests < 600 && b.tokens+liveReadRequestReservation <= 3_000_000
}

func (b *liveReadBudget) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	if b.requests >= 600 || b.tokens+liveReadRequestReservation > 3_000_000 {
		b.mu.Unlock()
		b.cancel()
		http.Error(w, "live suite resource ceiling", http.StatusForbidden)
		return
	}
	b.requests++
	b.tokens += liveReadRequestReservation
	b.mu.Unlock()
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.deepseek.com/chat/completions", io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "request creation failed", 500)
		return
	}
	upstream.Header.Set("Authorization", r.Header.Get("Authorization"))
	upstream.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 150 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(upstream)
	if err != nil {
		http.Error(w, "upstream request failed", 502)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == 401 || response.StatusCode == 403 {
			b.cancel()
		}
		http.Error(w, "upstream rejected live test request", response.StatusCode)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	used := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if bytes.HasPrefix(line, []byte("data:")) {
			var frame struct {
				Usage *struct {
					Prompt     int `json:"prompt_tokens"`
					Completion int `json:"completion_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal(bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:"))), &frame) == nil && frame.Usage != nil {
				used = max(used, frame.Usage.Prompt+frame.Usage.Completion)
			}
		}
		if _, err := w.Write(append(bytes.Clone(line), '\n')); err != nil {
			return
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	if scanner.Err() == nil && used > 0 {
		b.mu.Lock()
		b.tokens += used - liveReadRequestReservation
		b.mu.Unlock()
	}
}
