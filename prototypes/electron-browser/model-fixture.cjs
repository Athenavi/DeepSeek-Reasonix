// Deterministic HTTP model endpoint. Only model responses are scripted: the
// production ACP, boot, agent, permissions, MCP, session lease and WAL paths run.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
class ModelFixture {
  constructor(artifacts) { this.artifacts = artifacts; this.cases = new Map(); this.requests = []; this.calls = 0; }
  async start() {
    this.server = http.createServer(async (req, res) => {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'browser-fixture', object: 'model' }] })); return; }
      try {
        let body = ''; for await (const part of req) { body += part; if (body.length > 8 * 1024 * 1024) throw new Error('request too large'); }
        const input = JSON.parse(body); this.requests.push(input); this.calls++;
        const user = [...(input.messages || [])].reverse().find(message => message.role === 'user');
        const userText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
        const match = userText?.match(/LAB_CASE:([a-zA-Z0-9_-]+):([^\n]+)/);
        let message = { role: 'assistant', content: 'Browser task completed.' };
        if (match) {
          const [, caseId, text] = match;
          const step = this.cases.get(caseId) || 0; this.cases.set(caseId, step + 1);
          const allTools = (input.messages || []).filter(message => message.role === 'tool');
          const outputs = allTools.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
          const tokens = [...outputs.matchAll(/"documentToken"\s*:\s*"([^"]+)"/g)];
          const documentToken = tokens.at(-1)?.[1] || 'missing-token';
          const plans = [
            { action: 'inspect', capability_id: 'mcp-tool:browser/act' },
            { action: 'call', capability_id: 'mcp-tool:browser/snapshot', arguments: {} },
            { action: 'call', capability_id: 'mcp-tool:browser/act', arguments: { documentToken, operationId: caseId + '-fill', action: 'fill', selector: '#message', text } },
            { action: 'call', capability_id: 'mcp-tool:browser/snapshot', arguments: {} },
            { action: 'call', capability_id: 'mcp-tool:browser/act', arguments: { documentToken, operationId: caseId + '-save', action: 'click', selector: '#save' } }
          ];
          if (step < plans.length) message = { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'use_capability', arguments: JSON.stringify(plans[step]) } }] };
          else message.content = 'Browser task completed: ' + text;
        }
        fs.writeFileSync(path.join(this.artifacts, 'model-fixture-requests.json'), JSON.stringify(this.requests.map(r => ({ model: r.model, roles: r.messages?.map(m => m.role), tools: r.tools?.map(t => t.function?.name) })), null, 2));
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : { role: 'assistant', content: message.content };
          const frame = { id: randomUUID(), object: 'chat.completion.chunk', model: 'browser-fixture', choices: [{ index: 0, delta, finish_reason: null }] };
          res.write('data: ' + JSON.stringify(frame) + '\n\n');
          res.write('data: ' + JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'browser-fixture', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
        }
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }
  async close() { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
}
module.exports = { ModelFixture };
