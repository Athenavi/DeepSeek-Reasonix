package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	"reasonix/internal/browser"
	"reasonix/internal/remote/sftpfs"
	"reasonix/internal/remote/sshtest"
)

// brokerFakeExecutor answers from fixed fields and records the session each
// call arrived with (the HTTP handler restores it into the context).
type brokerFakeExecutor struct {
	mu         sync.Mutex
	tabs       []browser.Tab
	screenshot browser.Screenshot
	downloads  []browser.Download
	sessions   []string
}

func (e *brokerFakeExecutor) note(ctx context.Context) {
	e.mu.Lock()
	e.sessions = append(e.sessions, browser.SessionFromContext(ctx))
	e.mu.Unlock()
}

func (e *brokerFakeExecutor) lastSession() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.sessions) == 0 {
		return ""
	}
	return e.sessions[len(e.sessions)-1]
}

func (e *brokerFakeExecutor) Tabs(ctx context.Context) ([]browser.Tab, error) {
	e.note(ctx)
	return e.tabs, nil
}
func (e *brokerFakeExecutor) Open(ctx context.Context, req browser.OpenRequest) (browser.Tab, error) {
	e.note(ctx)
	return browser.Tab{ID: "tab-new", URL: req.URL}, nil
}
func (e *brokerFakeExecutor) Navigate(ctx context.Context, req browser.NavigateRequest) (browser.Tab, error) {
	e.note(ctx)
	return browser.Tab{ID: req.TabID, URL: req.URL}, nil
}
func (e *brokerFakeExecutor) Snapshot(ctx context.Context, _ browser.SnapshotRequest) (browser.Snapshot, error) {
	e.note(ctx)
	return browser.Snapshot{DocumentToken: "doc-1"}, nil
}
func (e *brokerFakeExecutor) Screenshot(ctx context.Context, _ browser.ScreenshotRequest) (browser.Screenshot, error) {
	e.note(ctx)
	return e.screenshot, nil
}
func (e *brokerFakeExecutor) Act(ctx context.Context, _ browser.ActRequest) (browser.ActResult, error) {
	e.note(ctx)
	return browser.ActResult{Executed: true, Outcome: browser.OutcomeExecuted}, nil
}
func (e *brokerFakeExecutor) Downloads(ctx context.Context, _ browser.DownloadsRequest) ([]browser.Download, error) {
	e.note(ctx)
	return e.downloads, nil
}
func (e *brokerFakeExecutor) Close(ctx context.Context, _ string) error {
	e.note(ctx)
	return nil
}

// brokerTestRig is a running broker with fake resolution, liveness and relay.
type brokerTestRig struct {
	broker  *browserBroker
	baseURL string
	gen     *managedHost
	// current flips liveness; guarded by mu for the -race runs.
	mu      sync.Mutex
	live    bool
	conn    sftpConn
	relays  []relayCall
	relayTo string
}

type relayCall struct {
	workspace string
	localPath string
}

func newBrokerTestRig(t *testing.T, resolve browserSessionResolver) *brokerTestRig {
	t.Helper()
	rig := &brokerTestRig{live: true, gen: &managedHost{}}
	rig.broker = newBrowserBroker(
		resolve,
		func(string, *managedHost) bool { rig.mu.Lock(); defer rig.mu.Unlock(); return rig.live },
		func(string, *managedHost) sftpConn { return rig.conn },
	)
	rig.broker.newRelay = func(sftpConn) FileRelay { return rig }
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rig.broker.ln = ln
	rig.broker.port = ln.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: rig.broker}
	rig.broker.server = server
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { rig.broker.close() })
	rig.baseURL = fmt.Sprintf("http://127.0.0.1:%d", rig.broker.port)
	return rig
}

// Stage implements FileRelay over the rig, recording the call.
func (r *brokerTestRig) Stage(_ context.Context, workspace, localPath string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.relays = append(r.relays, relayCall{workspace: workspace, localPath: localPath})
	if r.relayTo == "" {
		return "", fmt.Errorf("relay unavailable")
	}
	return r.relayTo + filepath.Base(localPath), nil
}

func (r *brokerTestRig) setLive(live bool) {
	r.mu.Lock()
	r.live = live
	r.mu.Unlock()
}

func (r *brokerTestRig) relayCalls() []relayCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]relayCall(nil), r.relays...)
}

func brokerTabsCall(t *testing.T, baseURL, token, session string) (int, []browser.Tab) {
	t.Helper()
	exec := browser.NewHTTPExecutor(baseURL, token, nil)
	tabs, err := exec.Tabs(browser.WithSession(context.Background(), session))
	if err != nil {
		return statusOfBrokerError(t, baseURL, token, session), nil
	}
	return http.StatusOK, tabs
}

// statusOfBrokerError re-issues the call raw to read the status code the
// executor mapped into an error.
func statusOfBrokerError(t *testing.T, baseURL, token, session string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/browser/tabs", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if session != "" {
		req.Header.Set(browser.SessionHeader, session)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func sessionResolver(exec browser.Executor, workspace string, allowed map[string]bool) browserSessionResolver {
	return func(hostID, sessionPath string) (browserSessionResolution, error) {
		if !allowed[sessionPath] {
			return browserSessionResolution{}, fmt.Errorf("%w: no desktop tab serves session %s", browser.ErrNoGrant, sessionPath)
		}
		return browserSessionResolution{exec: exec, workspace: workspace}, nil
	}
}

func TestBrowserBrokerRoundTripRoutesSession(t *testing.T) {
	exec := &brokerFakeExecutor{tabs: []browser.Tab{{ID: "b1", URL: "https://example.test"}}}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/sessions/a.jsonl": true}))
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	status, tabs := brokerTabsCall(t, rig.baseURL, token, "/sessions/a.jsonl")
	if status != http.StatusOK || len(tabs) != 1 || tabs[0].ID != "b1" {
		t.Fatalf("status=%d tabs=%+v", status, tabs)
	}
	if got := exec.lastSession(); got != "/sessions/a.jsonl" {
		t.Fatalf("executor saw session %q", got)
	}
}

func TestBrowserBrokerTokenRotationRevokesOldGeneration(t *testing.T) {
	exec := &brokerFakeExecutor{}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	oldToken, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	newGen := &managedHost{}
	newToken, _, err := rig.broker.register("host-1", newGen)
	if err != nil {
		t.Fatal(err)
	}
	if oldToken == newToken {
		t.Fatal("token rotation reused the old token")
	}
	if status := statusOfBrokerError(t, rig.baseURL, oldToken, "/s"); status != http.StatusUnauthorized {
		t.Fatalf("old generation token = %d, want 401", status)
	}
	if status := statusOfBrokerError(t, rig.baseURL, newToken, "/s"); status != http.StatusOK {
		t.Fatalf("new generation token = %d, want 200", status)
	}
}

func TestBrowserBrokerRejectsDeadGeneration(t *testing.T) {
	exec := &brokerFakeExecutor{}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	rig.setLive(false)
	if status := statusOfBrokerError(t, rig.baseURL, token, "/s"); status != http.StatusUnauthorized {
		t.Fatalf("dead generation = %d, want 401", status)
	}
	rig.setLive(true)
	if status := statusOfBrokerError(t, rig.baseURL, token, "/s"); status != http.StatusOK {
		t.Fatalf("live generation = %d, want 200", status)
	}
	rig.broker.revokeHost("host-1")
	if status := statusOfBrokerError(t, rig.baseURL, token, "/s"); status != http.StatusUnauthorized {
		t.Fatalf("revoked host = %d, want 401", status)
	}
}

func TestBrowserBrokerRejectsForeignAndMissingSessions(t *testing.T) {
	exec := &brokerFakeExecutor{}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/sessions/a.jsonl": true}))
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range []string{"/sessions/other.jsonl", ""} {
		status := statusOfBrokerError(t, rig.baseURL, token, session)
		if status != http.StatusConflict {
			t.Fatalf("session %q = %d, want 409 no_grant", session, status)
		}
	}
	if len(exec.sessions) != 0 {
		t.Fatalf("executor saw %d calls from rejected sessions", len(exec.sessions))
	}
}

func TestBrowserBrokerRejectsBadToken(t *testing.T) {
	rig := newBrokerTestRig(t, sessionResolver(&brokerFakeExecutor{}, "/ws", map[string]bool{"/s": true}))
	if _, _, err := rig.broker.register("host-1", rig.gen); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "wrong"} {
		if status := statusOfBrokerError(t, rig.baseURL, token, "/s"); status != http.StatusUnauthorized {
			t.Fatalf("token %q = %d, want 401", token, status)
		}
	}
	req, err := http.NewRequest(http.MethodGet, rig.baseURL+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("healthz = %d, want 204", resp.StatusCode)
	}
}

func TestBrowserBrokerScreenshotRelaysCapture(t *testing.T) {
	exec := &brokerFakeExecutor{screenshot: browser.Screenshot{Path: "/tmp/reasonix-browser/tab-1/shot.png", MIME: "image/png", Width: 10, Height: 10}}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	rig.conn = fakeSFTPConn{}
	rig.relayTo = "/remote/scratch/"
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	httpExec := browser.NewHTTPExecutor(rig.baseURL, token, nil)
	shot, err := httpExec.Screenshot(browser.WithSession(context.Background(), "/s"), browser.ScreenshotRequest{TabID: "tab-1"})
	if err != nil {
		t.Fatal(err)
	}
	if shot.Path != "/remote/scratch/shot.png" {
		t.Fatalf("screenshot path = %q, want the relayed remote path", shot.Path)
	}
	calls := rig.relayCalls()
	if len(calls) != 1 || calls[0].workspace != "/ws" || calls[0].localPath != "/tmp/reasonix-browser/tab-1/shot.png" {
		t.Fatalf("relay calls = %+v", calls)
	}
}

func TestBrowserBrokerScreenshotWithoutConnectionFails(t *testing.T) {
	exec := &brokerFakeExecutor{screenshot: browser.Screenshot{Path: "/tmp/shot.png"}}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	httpExec := browser.NewHTTPExecutor(rig.baseURL, token, nil)
	if _, err := httpExec.Screenshot(browser.WithSession(context.Background(), "/s"), browser.ScreenshotRequest{TabID: "t"}); err == nil {
		t.Fatal("screenshot without a live connection succeeded")
	}
	if calls := rig.relayCalls(); len(calls) != 0 {
		t.Fatalf("relay ran without a connection: %+v", calls)
	}
}

func TestBrowserBrokerDownloadsRelayEachPath(t *testing.T) {
	exec := &brokerFakeExecutor{downloads: []browser.Download{
		{ID: "d1", Path: "/tmp/dl/a.zip"},
		{ID: "d2", Path: ""},
	}}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	rig.conn = fakeSFTPConn{}
	rig.relayTo = "/remote/scratch/"
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	httpExec := browser.NewHTTPExecutor(rig.baseURL, token, nil)
	downloads, err := httpExec.Downloads(browser.WithSession(context.Background(), "/s"), browser.DownloadsRequest{TabID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if len(downloads) != 2 || downloads[0].Path != "/remote/scratch/a.zip" || downloads[1].Path != "" {
		t.Fatalf("downloads = %+v", downloads)
	}
	if calls := rig.relayCalls(); len(calls) != 1 {
		t.Fatalf("relay calls = %+v, want exactly the non-empty path", calls)
	}
}

// fakeSFTPConn satisfies sftpConn without a server; Stage never reaches it in
// rig-based tests because newRelay is faked.
type fakeSFTPConn struct{}

func (fakeSFTPConn) SFTP() (*sftpfs.FS, error) { return nil, fmt.Errorf("no sftp") }

func TestBrowserBrokerConcurrentRotation(t *testing.T) {
	exec := &brokerFakeExecutor{tabs: []browser.Tab{{ID: "b1"}}}
	rig := newBrokerTestRig(t, sessionResolver(exec, "/ws", map[string]bool{"/s": true}))
	token, _, err := rig.broker.register("host-1", rig.gen)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				_, _, _ = rig.broker.register("host-1", &managedHost{})
			}
		}()
	}
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				_, _ = brokerTabsCall(t, rig.baseURL, token, "/s")
			}
		}()
	}
	wg.Wait()
	// After the dust settles only the last minted token authenticates.
	if status := statusOfBrokerError(t, rig.baseURL, token, "/s"); status != http.StatusUnauthorized {
		t.Fatalf("superseded token = %d, want 401", status)
	}
}

func TestSFTPFileRelayRoundTrip(t *testing.T) {
	root := t.TempDir()
	server := sshtest.Start(t, sshtest.Options{Password: "pw", SFTPRoot: root})
	cl, err := ssh.Dial("tcp", server.Addr, &ssh.ClientConfig{
		User:            "u",
		Auth:            []ssh.AuthMethod{ssh.Password("pw")},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	fs, err := sftpfs.New(cl)
	if err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(local, []byte("png-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	remotePath, err := (sftpFileRelay{conn: sftpFSConn{fs: fs}}).Stage(context.Background(), "/work space", local)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(remotePath)
	if err != nil {
		t.Fatalf("relayed file unreadable at %q: %v", remotePath, err)
	}
	if string(data) != "png-bytes" {
		t.Fatalf("relayed content = %q", data)
	}
	if !strings.Contains(remotePath, "browser-relay") {
		t.Fatalf("remote path %q is outside the relay scratch area", remotePath)
	}
	info, err := os.Stat(remotePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("relayed file mode = %v, want 0600", info.Mode().Perm())
	}
}

type sftpFSConn struct{ fs *sftpfs.FS }

func (c sftpFSConn) SFTP() (*sftpfs.FS, error) { return c.fs, nil }

func TestSFTPFileRelayRejectsOddFiles(t *testing.T) {
	dir := t.TempDir()
	relay := sftpFileRelay{conn: sftpFSConn{}}
	if _, err := relay.Stage(context.Background(), "/ws", filepath.Join(dir, "missing.png")); err == nil {
		t.Fatal("missing file staged")
	}
	if _, err := relay.Stage(context.Background(), "/ws", dir); err == nil {
		t.Fatal("directory staged")
	}
}

func TestRelayFileNameSanitizes(t *testing.T) {
	name := relayFileName("/tmp/x/evil.png")
	if strings.Contains(name, "/") || !strings.HasSuffix(name, "-evil.png") {
		t.Fatalf("relayFileName = %q", name)
	}
	if relayFileName("/tmp/x/evil.png") == relayFileName("/tmp/x/evil.png") {
		t.Fatal("relayFileName must be unique per call")
	}
}
