const panel = document.createElement('section');
panel.hidden = true;
panel.innerHTML = '<h2>Reasonix 真实任务链路</h2><p id="runtime-phase"></p><textarea id="runtime-prompt" aria-label="任务内容" rows="3" style="width:100%">将“Reasonix 真实 Agent 已接入”填写到右侧输入框并保存一次。</textarea><button id="runtime-run" class="primary">运行真实任务</button><button id="runtime-stop">接管并停止任务</button><button id="runtime-restart">重连并恢复任务</button><button id="github-login">GitHub 登录验证</button><div id="runtime-approvals"></div><pre id="runtime-output" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px"></pre>';
document.querySelector('aside').prepend(panel);
const $runtime = selector => panel.querySelector(selector);
function runtimeCommand(method, args) { return window.prototype.command(method, args).catch(error => { $runtime('#runtime-phase').textContent = error.message; }); }
$runtime('#runtime-run').onclick = () => runtimeCommand('runtime-run', { text: $runtime('#runtime-prompt').value });
$runtime('#runtime-stop').onclick = () => runtimeCommand('runtime-stop');
$runtime('#runtime-restart').onclick = () => runtimeCommand('runtime-restart');
$runtime('#github-login').onclick = () => runtimeCommand('github-login');
const phaseLabels = { connecting: '连接中', ready: '可运行', running: '任务进行中', approval: '等待你的审批', paused: '已接管，等待明确继续', completed: '本轮结束', 'restored-paused': '历史已恢复，等待明确继续', disconnected: '运行时已断开', error: '连接失败' };
let approvalKey = '';
function showRuntime(state) {
  const runtime = state.runtime; panel.hidden = !runtime;
  if (!runtime) return;
  $runtime('#runtime-phase').textContent = `${phaseLabels[runtime.phase] || runtime.phase} · ${runtime.modelKind === 'scripted-provider' ? '可控模型响应' : '真实模型'}${runtime.error ? '\n' + runtime.error : ''}`;
  $runtime('#runtime-run').disabled = ['connecting', 'running', 'approval', 'disconnected', 'error'].includes(runtime.phase);
  const nextKey = JSON.stringify(runtime.approvals);
  if (nextKey !== approvalKey) {
    approvalKey = nextKey; const nodes = [];
    for (const approval of runtime.approvals) {
      const container = document.createElement('div'); const title = document.createElement('p');
      title.textContent = approval.toolCall.title || '工具审批'; container.append(title);
      const input = document.createElement('pre'); input.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px'; input.textContent = JSON.stringify(approval.toolCall.rawInput, null, 2); container.append(input);
      for (const option of approval.options.filter(x => ['allow_once', 'reject_once'].includes(x.kind))) {
        const button = document.createElement('button'); button.textContent = option.kind === 'allow_once' ? '仅允许这一次' : '拒绝这一次';
        button.dataset.approval = String(approval.id); button.dataset.kind = option.kind;
        button.onclick = () => runtimeCommand('runtime-approve', { id: approval.id, generation: approval.generation, optionId: option.optionId }); container.append(button);
      }
      nodes.push(container);
    }
    $runtime('#runtime-approvals').replaceChildren(...nodes);
  }
  $runtime('#runtime-output').textContent = runtime.updates.filter(x => x.method === 'session/update').map(x => x.params?.update).filter(Boolean).slice(-12).map(x => x.content?.text || x.title || x.status || x.sessionUpdate).join('\n');
}
window.prototype.onState(showRuntime);
window.prototype.command('state').then(showRuntime);
