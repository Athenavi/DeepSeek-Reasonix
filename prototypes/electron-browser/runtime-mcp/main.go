// This adapter exposes the Electron host's bounded browser contract to the
// production Reasonix ACP process through the official MCP SDK. Interactive
// confirmation requires the opt-in Reasonix ACP elicitation extension.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--prepare-live" {
		if err := prepareLive(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	endpoint, err := url.Parse(os.Getenv("BROWSER_LAB_ENDPOINT"))
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || os.Getenv("BROWSER_LAB_TOKEN") == "" {
		fmt.Fprintln(os.Stderr, "browser host endpoint and token are required")
		os.Exit(1)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "reasonix-browser-lab", Version: "0.2.0"}, nil)
	for _, name := range []string{"snapshot", "act"} {
		properties := map[string]any{}
		required := []string{}
		if name == "act" {
			properties = map[string]any{
				"documentToken": map[string]any{"type": "string", "description": "Token from the most recent snapshot; invalid after user takeover or navigation."},
				"operationId":   map[string]any{"type": "string", "description": "Unique action ID. Reusing an ID never repeats a write."},
				"action":        map[string]any{"type": "string", "enum": []string{"fill", "click"}},
				"selector":      map[string]any{"type": "string", "enum": []string{"#message", "#save"}},
				"text":          map[string]any{"type": "string", "maxLength": 2000},
			}
			required = []string{"documentToken", "operationId", "action", "selector"}
		}
		server.AddTool(&mcp.Tool{Name: name,
			Description: map[string]string{"snapshot": "Read the task's bound local browser page. Always read before acting. Returns documentToken and current form state.", "act": "Apply one approved edit to the task's local browser page. This tool cannot operate on login pages or external websites."}[name],
			InputSchema: map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false},
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: name == "snapshot"},
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if req.Params.Name == "act" {
				signer := hmac.New(sha256.New, []byte(os.Getenv("BROWSER_LAB_TOKEN")))
				signer.Write(req.Params.Arguments)
				binding := hex.EncodeToString(signer.Sum(nil))
				if len(req.Params.InputResponses) == 0 {
					return &mcp.CallToolResult{RequestState: binding, InputRequests: mcp.InputRequestMap{"confirm": &mcp.ElicitParams{Mode: "form",
						Message:         "确认本次浏览器操作：" + string(req.Params.Arguments),
						RequestedSchema: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
					}}}, nil
				}
				decision, ok := req.Params.InputResponses["confirm"].(*mcp.ElicitResult)
				if !ok || decision.Action != "accept" || !hmac.Equal([]byte(binding), []byte(req.Params.RequestState)) {
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: `{"executed":false,"reason":"user declined or cancelled"}`}}}, nil
				}
			}
			body, _ := json.Marshal(map[string]any{"method": req.Params.Name, "args": req.Params.Arguments})
			r, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
			if err != nil {
				return nil, err
			}
			r.Header.Set("Authorization", "Bearer "+os.Getenv("BROWSER_LAB_TOKEN"))
			r.Header.Set("Content-Type", "application/json")
			client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}}
			defer client.CloseIdleConnections()
			response, err := client.Do(r)
			if err != nil {
				return nil, fmt.Errorf("browser host unavailable: %w", err)
			}
			defer response.Body.Close()
			data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			if err != nil {
				return nil, err
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}, IsError: response.StatusCode != http.StatusOK}, nil
		})
	}
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
