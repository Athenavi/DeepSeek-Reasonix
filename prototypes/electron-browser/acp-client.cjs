const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

class ACPClient {
  constructor(binary, options) {
    this.generation = randomUUID();
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    this.onRequest = options.onRequest; this.onUpdate = options.onUpdate;
    this.child = spawn(binary, ['acp', '--planner=off', '--workspace-only'], {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.child.stderr.on('data', options.onStderr);
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.fail(new Error('Reasonix process exited')); options.onExit?.({ code, signal }); resolve({ code, signal });
    }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (line.length > 8 * 1024 * 1024) { this.fail(new Error('ACP frame too large')); return; }
      let frame; try { frame = JSON.parse(line); } catch { this.fail(new Error('Invalid ACP JSON')); return; }
      if (frame.method && frame.id !== undefined) {
        Promise.resolve(this.onRequest(frame, this)).catch(() => this.reply(frame.id, { outcome: { outcome: 'cancelled' } }));
      } else if (frame.method) this.onUpdate(frame, this);
      else {
        const item = this.pending.get(frame.id); if (!item) return;
        this.pending.delete(frame.id); clearTimeout(item.timer);
        frame.error ? item.reject(new Error(frame.error.message)) : item.resolve(frame.result);
      }
    });
  }
  send(frame) {
    if (this.closed) throw new Error('Reasonix connection is closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  }
  call(method, params = {}, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ACP request timed out: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ method, params }); }
  reply(id, result) { if (!this.closed) this.send({ id, result }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timeout = new Promise((_, reject) => { this.closeTimer = setTimeout(() => reject(new Error('Reasonix did not exit after stdin EOF')), 15000); });
    try { return await Promise.race([this.exit, timeout]); } finally { clearTimeout(this.closeTimer); }
  }
}
module.exports = { ACPClient };
