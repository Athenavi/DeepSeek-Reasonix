package browser

import (
	"context"
	"time"
)

// HTTP contract shared by the client in httpexec.go and the handler in
// httpserve.go: POST <endpoint>/v1/browser/<method> with a JSON body that
// mirrors the request struct, a JSON reply that mirrors the result struct,
// and a 409 carrying {"error": code, "message": text} for every sentinel.
const (
	httpRoutePrefix = "/v1/browser/"
	httpHealthRoute = httpRoutePrefix + "health"

	// SessionHeader carries the calling session's ID so a broker serving
	// several sessions over one token can route each call to its own task.
	SessionHeader = "X-Reasonix-Browser-Session"

	httpMaxRequestBytes  = 1 << 20
	httpMaxResponseBytes = 32 << 20
)

// Wire error codes carried in a 409 body; each maps onto one sentinel.
const (
	wireStaleReference = "stale_reference"
	wireTakenOver      = "taken_over"
	wireNoGrant        = "no_grant"
	wireUnknownOutcome = "unknown_outcome"
)

var wireErrorCodes = map[string]error{
	wireStaleReference: ErrStaleReference,
	wireTakenOver:      ErrTakenOver,
	wireNoGrant:        ErrNoGrant,
	wireUnknownOutcome: ErrUnknownOutcome,
}

type sessionKey struct{}

// WithSession scopes ctx to one session ID; the HTTP client sends it as
// SessionHeader and the HTTP handler restores it for the served Executor.
func WithSession(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, sessionKey{}, id)
}

// SessionFromContext returns the session ID set by WithSession, or "".
func SessionFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(sessionKey{}).(string)
	return id
}

type wireError struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type wireTab struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Title     string `json:"title,omitempty"`
	Loading   bool   `json:"loading,omitempty"`
	Temporary bool   `json:"temporary,omitempty"`
}

func toWireTab(t Tab) wireTab {
	return wireTab{ID: t.ID, URL: t.URL, Title: t.Title, Loading: t.Loading, Temporary: t.Temporary}
}

func (t wireTab) tab() Tab {
	return Tab{ID: t.ID, URL: t.URL, Title: t.Title, Loading: t.Loading, Temporary: t.Temporary}
}

type wireTabs struct {
	Tabs []wireTab `json:"tabs"`
}

type wireOpenRequest struct {
	URL       string `json:"url"`
	Temporary bool   `json:"temporary,omitempty"`
}

type wireNavigateRequest struct {
	TabID  string `json:"tabId"`
	URL    string `json:"url,omitempty"`
	Action string `json:"action"`
}

type wireSnapshotRequest struct {
	TabID    string `json:"tabId"`
	Selector string `json:"selector,omitempty"`
}

type wireSnapshot struct {
	DocumentToken string `json:"documentToken"`
	URL           string `json:"url"`
	Title         string `json:"title,omitempty"`
	Tree          string `json:"tree"`
	Refs          int    `json:"refs"`
}

type wireScreenshotRequest struct {
	TabID    string `json:"tabId"`
	Ref      string `json:"ref,omitempty"`
	FullPage bool   `json:"fullPage,omitempty"`
}

type wireScreenshot struct {
	Path   string `json:"path"`
	MIME   string `json:"mime,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

type wireActRequest struct {
	OperationID   string   `json:"operationId"`
	TabID         string   `json:"tabId"`
	DocumentToken string   `json:"documentToken,omitempty"`
	Action        string   `json:"action"`
	Ref           string   `json:"ref,omitempty"`
	Text          string   `json:"text,omitempty"`
	Keys          string   `json:"keys,omitempty"`
	Options       []string `json:"options,omitempty"`
	Files         []string `json:"files,omitempty"`
	Submit        bool     `json:"submit,omitempty"`
	DeltaX        int      `json:"deltaX,omitempty"`
	DeltaY        int      `json:"deltaY,omitempty"`
}

func toWireAct(req ActRequest) wireActRequest {
	return wireActRequest{
		OperationID: req.OperationID, TabID: req.TabID, DocumentToken: req.DocumentToken,
		Action: req.Action, Ref: req.Ref, Text: req.Text, Keys: req.Keys,
		Options: req.Options, Files: req.Files, Submit: req.Submit, DeltaX: req.DeltaX, DeltaY: req.DeltaY,
	}
}

func (w wireActRequest) request() ActRequest {
	return ActRequest{
		OperationID: w.OperationID, TabID: w.TabID, DocumentToken: w.DocumentToken,
		Action: w.Action, Ref: w.Ref, Text: w.Text, Keys: w.Keys,
		Options: w.Options, Files: w.Files, Submit: w.Submit, DeltaX: w.DeltaX, DeltaY: w.DeltaY,
	}
}

type wireActResult struct {
	Executed      bool   `json:"executed"`
	Reason        string `json:"reason,omitempty"`
	DocumentToken string `json:"documentToken,omitempty"`
	Outcome       string `json:"outcome,omitempty"`
}

type wireDownloadsRequest struct {
	TabID     string `json:"tabId"`
	WaitForMs int64  `json:"waitForMs,omitempty"`
}

func (w wireDownloadsRequest) request() DownloadsRequest {
	return DownloadsRequest{TabID: w.TabID, WaitFor: time.Duration(w.WaitForMs) * time.Millisecond}
}

type wireDownload struct {
	ID    string `json:"id"`
	URL   string `json:"url,omitempty"`
	Path  string `json:"path,omitempty"`
	State string `json:"state,omitempty"`
	Bytes int64  `json:"bytes,omitempty"`
}

type wireDownloads struct {
	Downloads []wireDownload `json:"downloads"`
}

type wireCloseRequest struct {
	TabID string `json:"tabId"`
}
