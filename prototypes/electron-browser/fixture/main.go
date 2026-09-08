// Browser fixture and deterministic Go planner. No production agent or credentials.
package main

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

//go:embed page.html
var page string

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, page)
	})
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	mux.HandleFunc("/auth", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Fixture sign-in</title><style>body{font:20px system-ui;padding:40px}button{font:inherit;padding:12px}</style><h1>本地登录测试</h1><p>这是合成登录，不连接第三方账号。</p><form action="/auth/callback" method="post"><button id="authorize">确认测试登录</button></form>`)
	})
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "fixture_session", Value: "synthetic", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<script>opener.postMessage({type:'fixture-login'},location.origin);window.close()</script>`)
	})
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		c, err := r.Cookie("fixture_session")
		json.NewEncoder(w).Encode(map[string]bool{"authenticated": err == nil && c.Value == "synthetic"})
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="fixture-result.csv"`)
		fmt.Fprint(w, "name,result\nprototype,passed\n")
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener)
	encoder := json.NewEncoder(os.Stdout)
	encoder.Encode(map[string]any{"id": 0, "result": map[string]any{"origin": "http://" + listener.Addr().String(), "pid": os.Getpid()}})
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
			Text   string `json:"text"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		if request.Method != "plan" {
			encoder.Encode(map[string]any{"id": request.ID, "error": "unsupported method"})
			continue
		}
		encoder.Encode(map[string]any{"id": request.ID, "result": map[string]any{"source": "deterministic-go-fixture", "steps": []map[string]string{
			{"action": "fill", "selector": "#message", "text": request.Text},
			{"action": "click", "selector": "#save"},
		}}})
	}
	server.Close()
}
