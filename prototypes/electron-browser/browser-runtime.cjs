const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { ACPClient } = require('./acp-client.cjs');

function atomicJSON(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}

class BrowserRuntime {
  constructor(options) {
    Object.assign(this, options);
    this.home = process.env.PROTOTYPE_RUNTIME_HOME || path.join(this.profile, 'reasonix-home');
    this.workspace = path.join(this.profile, 'task-workspace');
    fs.mkdirSync(this.home, { recursive: true }); fs.mkdirSync(this.workspace, { recursive: true });
    this.filename = path.join(this.profile, 'runtime-state.json');
    this.saved = fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename)) : { version: 1, operations: {} };
    if (this.saved.version !== 1) throw new Error('Unsupported browser runtime state version');
    this.phase = 'disconnected'; this.approvals = new Map(); this.updates = []; this.documents = new Map();
    this.faults = {}; this.sessionId = this.saved.sessionId; this.tabId = options.tabId;
  }
  snapshotState() {
    return { phase: this.phase, sessionId: this.sessionId, tabId: this.tabId,
      reasonixPid: this.client?.child.pid, generation: this.client?.generation, error: this.error,
      approvals: [...this.approvals.values()].map(({ id, generation, params }) => ({ id, generation, ...params })),
      updates: this.updates.slice(-100), operationCount: Object.keys(this.saved.operations).length,
      modelKind: process.env.PROTOTYPE_MODEL_FIXTURE === '1' ? 'scripted-provider' : 'configured-live-provider' };
  }
  publish(event, details = {}) { this.emit('runtime-' + event, details); }
  persist() { atomicJSON(this.filename, this.saved); }
  async initialize() {
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const supplied = Buffer.from(req.headers.authorization || '');
        const expected = Buffer.from('Bearer ' + this.scopeToken);
        if (req.method !== 'POST' || req.url !== '/browser' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          res.writeHead(403); res.end('{"error":"untrusted browser caller"}'); return;
        }
        let data = ''; for await (const part of req) { data += part; if (data.length > 16384) throw new Error('Browser request too large'); }
        const input = JSON.parse(data);
        const output = input.method === 'snapshot' ? await this.readPage() : input.method === 'act' ? await this.act(input.args, req) : (() => { throw new Error('Unknown browser method'); })();
        if (!res.destroyed) res.end(JSON.stringify(output));
      } catch (error) { if (!res.destroyed) { res.writeHead(409); res.end(JSON.stringify({ error: error.message, executed: error.executionUnknown ? null : false })); } }
    });
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${this.server.address().port}/browser`;
    if (process.env.PROTOTYPE_MODEL_FIXTURE === '1') {
      const { ModelFixture } = require('./model-fixture.cjs');
      this.modelFixture = new ModelFixture(this.artifacts);
      const address = await this.modelFixture.start();
      fs.writeFileSync(path.join(this.home, 'config.toml'), `config_version = 5\ndefault_model = "browser-fixture"\n[agent]\ntask_time_budget_minutes = 2\n[permissions]\nmode = "ask"\nask = ["mcp__browser__act"]\ndeny = ["bash", "write_file", "edit_file", "task"]\n[tools]\nenabled = ["use_capability"]\n[[providers]]\nname = "browser-fixture"\nkind = "openai"\nmodel = "browser-fixture"\nbase_url = "${address}/v1"\ncontext_window = 128000\n`, { mode: 0o600 });
    }
    await this.connect();
  }
  async connect() {
    if (this.client && !this.client.closed) throw new Error('Reasonix is already connected');
    this.phase = 'connecting'; this.scopeToken = randomBytes(32).toString('hex'); this.publish('connecting');
    const client = new ACPClient(path.join(this.root, 'bin', 'reasonix' + (process.platform === 'win32' ? '.exe' : '')), {
      cwd: this.workspace, env: { ...process.env, REASONIX_HOME: this.home, REASONIX_STATE_HOME: this.home, REASONIX_CACHE_HOME: path.join(this.home, 'cache') },
      onStderr: data => fs.appendFileSync(path.join(this.artifacts, 'reasonix-stderr.log'), data),
      onRequest: (frame, owner) => this.receivePermission(frame, owner),
      onUpdate: (frame, owner) => { if (owner !== this.client) return; this.updates.push(frame); if (this.updates.length > 400) this.updates.shift(); this.publish('update'); },
      onExit: () => { if (client !== this.client) return; this.revoke('Reasonix 进程退出'); this.phase = 'disconnected'; this.publish('disconnected'); }
    });
    this.client = client;
    try {
      const initialized = await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'reasonix-browser-lab', version: '0.2.0' },
        clientCapabilities: { _meta: { 'reasonix.io': { mcpInteraction: { supported: true, schemaVersion: 1 } } } } });
      if (!initialized.agentCapabilities?._meta?.['reasonix.io']?.mcpInteraction?.supported) throw new Error('Reasonix does not support MCP interaction forwarding; rebuild the runtime');
      const params = { cwd: this.workspace, mcpServers: [{ name: 'browser', command: path.join(this.root, 'bin', 'browser-mcp' + (process.platform === 'win32' ? '.exe' : '')), args: [],
        env: [{ name: 'BROWSER_LAB_ENDPOINT', value: this.endpoint }, { name: 'BROWSER_LAB_TOKEN', value: this.scopeToken }] }] };
      if (this.sessionId) {
        await client.call('session/load', { ...params, sessionId: this.sessionId }); this.phase = 'restored-paused';
      } else {
        const result = await client.call('session/new', params); this.sessionId = result.sessionId; this.saved.sessionId = this.sessionId;
        this.saved.browser = { id: this.tabId, kind: 'local-fixture' }; this.persist(); this.phase = 'ready';
      }
      this.error = undefined; this.publish('connected', { sessionId: this.sessionId, restored: this.phase === 'restored-paused' });
    } catch (error) { this.error = error.message; this.phase = 'error'; this.publish('error'); throw error; }
  }
  receivePermission(frame, owner) {
    const interaction = frame.method === '_reasonix.io/mcp/request_interaction';
    if (!interaction && frame.method !== 'session/request_permission') { owner.send({ id: frame.id, error: { code: -32601, message: 'Unsupported client method' } }); return; }
    const cancelled = interaction ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } };
    if (owner !== this.client || !this.turn || frame.params.sessionId !== this.sessionId) { owner.reply(frame.id, cancelled); return; }
    let params = frame.params;
    if (interaction) {
      if (params.server !== 'browser' || params.mode !== 'form' || Object.keys(params.requestedSchema?.properties || {}).length) { owner.reply(frame.id, cancelled); return; }
      params = { ...params, source: 'mcp-elicitation', toolCall: { title: 'browser act · 本次操作确认', rawInput: params.message },
        options: [{ optionId: 'accept', kind: 'allow_once' }, { optionId: 'decline', kind: 'reject_once' }] };
    }
    this.approvals.set(String(frame.id), { id: frame.id, generation: owner.generation, turn: this.turn, params, interaction });
    this.phase = 'approval'; this.publish('approval-requested', { sessionId: this.sessionId, id: frame.id });
  }
  approve(id, generation, optionId) {
    const pending = this.approvals.get(String(id));
    if (!pending || pending.generation !== generation || generation !== this.client?.generation || pending.turn !== this.turn || !this.owns(pending.turn)) throw new Error('Approval is stale or belongs to another runtime');
    if (!pending.params.options.some(option => option.optionId === optionId && ['allow_once', 'reject_once'].includes(option.kind))) throw new Error('Choose a current one-time approval option');
    this.approvals.delete(String(id)); this.phase = 'running';
    this.client.reply(pending.id, pending.interaction ? { action: optionId, content: {} } : { outcome: { outcome: 'selected', optionId } }); this.publish('approval-resolved', { id, optionId });
  }
  owns(turn) {
    const tab = this.tabs.get(turn.tabId);
    return this.turn === turn && this.client?.generation === turn.generation && !this.client.closed && tab && tab.epoch === turn.epoch && tab.mode === 'agent' && !tab.view.webContents.isDestroyed();
  }
  revoke(reason) {
    const turn = this.turn; this.turn = undefined; this.documents.clear();
    for (const pending of this.approvals.values()) this.client?.reply(pending.id, pending.interaction ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } });
    this.approvals.clear();
    if (turn) {
      const tab = this.tabs.get(turn.tabId); if (tab) { tab.epoch++; tab.mode = 'human'; }
      if (this.client && !this.client.closed) this.client.notify('session/cancel', { sessionId: this.sessionId });
      this.phase = 'paused'; this.publish('revoked', { reason });
    }
  }
  onPause(tab, reason) { if (this.turn?.tabId === tab.id) this.revoke(reason); }
  async run(text) {
    if (this.pendingTurn) throw new Error('Wait for the previous task turn to stop');
    if (!this.client || this.client.closed) throw new Error('Reconnect Reasonix before continuing');
    const tab = this.tabs.get(this.tabId); if (!tab) throw new Error('Task browser tab is closed');
    if (new URL(tab.view.webContents.getURL()).origin !== this.origin) throw new Error('Return to the local task page before continuing');
    tab.mode = 'agent';
    const turn = { tabId: this.tabId, epoch: ++tab.epoch, generation: this.client.generation, id: randomUUID() };
    this.turn = turn; this.phase = 'running'; this.error = undefined; this.documents.clear(); this.publish('turn-started');
    const prompt = `Browser integration task. Use only browser MCP tools through use_capability. Read mcp-server:browser if discovery is needed, then inspect and call mcp-tool:browser/snapshot and mcp-tool:browser/act. Each act needs a fresh snapshot documentToken and a unique operationId. The browser is bound to this session; never use bash or another browser. User task: ${text}`;
    this.pendingTurn = this.client.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, 180000);
    try {
      const result = await this.pendingTurn;
      if (this.owns(turn)) this.phase = 'completed';
      this.publish('turn-finished', { stopReason: result.stopReason }); return result;
    } catch (error) { this.error = error.message; this.revoke('任务失败'); this.publish('turn-error'); throw error; }
    finally {
      if (this.turn === turn) { this.turn = undefined; tab.mode = 'human'; this.documents.clear(); }
      this.pendingTurn = undefined; this.publish('turn-released');
    }
  }
  async readPage() {
    const turn = this.turn;
    if (!turn || !this.owns(turn)) throw new Error('Browser task is paused; wait for explicit user continuation');
    const wc = this.tabs.get(turn.tabId).view.webContents;
    if (new URL(wc.getURL()).origin !== this.origin) throw new Error('External and authentication pages are outside agent scope');
    const page = await wc.executeJavaScript(`({timeOrigin:performance.timeOrigin,title:document.title,message:document.querySelector('#message')?.value,saved:document.querySelector('#saved')?.textContent,body:document.body.innerText.slice(0,5000)})`);
    if (!this.owns(turn)) throw new Error('Snapshot invalidated by user takeover');
    const documentToken = randomUUID(); this.documents.set(documentToken, { turn, timeOrigin: page.timeOrigin });
    this.publish('snapshot', { tabId: turn.tabId }); return { documentToken, ...page };
  }
  async act(args, request) {
    const document = this.documents.get(args?.documentToken);
    if (!document || !this.owns(document.turn)) throw new Error('Document token is stale; user continuation and a fresh snapshot are required');
    if (typeof args.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.operationId)) throw new Error('A unique operationId is required');
    if (!(args.action === 'fill' && args.selector === '#message') && !(args.action === 'click' && args.selector === '#save')) throw new Error('Unsupported local fixture action');
    if (args.action === 'fill' && (typeof args.text !== 'string' || args.text.length > 2000)) throw new Error('Text must be at most 2000 characters');
    if (this.saved.operations[args.operationId]) throw new Error('Operation ID already recorded; repeating an unknown write is forbidden');
    const wc = this.tabs.get(document.turn.tabId).view.webContents;
    if (new URL(wc.getURL()).origin !== this.origin) throw new Error('Only the local fixture may be modified');
    if (this.faults.beforeAction) { this.faults.beforeActionReached?.(args); await this.faults.beforeAction; }
    if (!this.owns(document.turn) || request?.aborted) throw new Error('Action cancelled before dispatch');
    const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    this.saved.operations[args.operationId] = { status: 'unknown', digest, turnId: document.turn.id, action: args.action };
    this.persist(); // Reserve durably BEFORE any side effect. Never automatically retry an unknown outcome.
    try {
    const result = await wc.executeJavaScript(`(() => {
      if (performance.timeOrigin !== ${JSON.stringify(document.timeOrigin)}) return {executed:false,reason:'document replaced'};
      const args = ${JSON.stringify(args)};
      const element = document.querySelector(args.selector);
      if (!element) return {executed:false,reason:'element missing'};
      if (args.action === 'fill') { element.value=args.text; element.dispatchEvent(new Event('input',{bubbles:true})); }
      else element.click();
      return {executed:true,message:document.querySelector('#message').value,saved:document.querySelector('#saved').textContent};
    })()`);
    if (this.faults.afterAction) { this.faults.afterActionReached?.(args); await this.faults.afterAction; }
    this.saved.operations[args.operationId].status = result.executed ? 'committed' : 'not-executed'; this.persist();
    this.publish('action', { operationId: args.operationId, action: args.action, executed: result.executed });
    return result;
    } catch (error) { error.executionUnknown = true; throw error; }
  }
  async restart() {
    this.revoke('重启任务运行时'); await this.pendingTurn?.catch(() => {});
    if (this.client && !this.client.closed) await this.client.close();
    await this.connect(); return this.snapshotState();
  }
  async close() {
    this.revoke('应用关闭');
    if (this.client) await this.client.close();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    if (this.modelFixture) await this.modelFixture.close();
  }
}
module.exports = { BrowserRuntime, atomicJSON };
