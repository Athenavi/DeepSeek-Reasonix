const $ = (s) => document.querySelector(s);
let state;
async function command(method, args = {}) {
  try { return await window.prototype.command(method, args); }
  catch (error) { $('#status').textContent = error.message; }
}
function render(next) {
  state = next;
  $('#status').textContent = next.status;
  $('#log').textContent = next.events.slice(-8).map(x => x.event).join('\n');
  $('#version').textContent = `Electron ${next.versions.electron}\nChromium ${next.versions.chrome}\nGo PID ${next.goPid}`;
  const tab = next.tabs.find(t => t.id === next.activeId);
  if (document.activeElement !== $('#url')) $('#url').value = tab?.url ?? '';
  $('#tabs').replaceChildren(...next.tabs.map(tab => {
    const button = document.createElement('button'); button.textContent = `${tab.id} · ${tab.title}`;
    button.className = tab.id === next.activeId ? 'active' : '';
    button.onclick = () => command('activate', { id: tab.id }); return button;
  }));
}
window.prototype.onState(render);
command('state').then(render);
$('#run').onclick = () => command('run', { id: state.activeId, delay: 700 });
$('#takeover').onclick = () => command('pause', { id: state.activeId });
$('#resume').onclick = () => command('run', { id: state.activeId });
$('#crash').onclick = () => command('crash', { id: state.activeId });
$('#metrics').onclick = async () => { const metrics = await command('metrics'); $('#status').textContent = `Electron 进程 RSS 合计：${metrics?.electronRssMiB} MiB（共享页可能重复计数）`; };
$('#toolbar').onsubmit = (event) => { event.preventDefault(); command('navigate', { id: state.activeId, url: $('#url').value }); };
for (const method of ['back', 'forward', 'reload', 'devtools']) $('#' + method).onclick = () => command(method, { id: state.activeId });
$('#new').onclick = () => command('new');
$('#zoom-out').onclick = () => command('zoom', { id: state.activeId, delta: -.1 });
$('#zoom-in').onclick = () => command('zoom', { id: state.activeId, delta: .1 });
let dragging = false;
$('#splitter').onpointerdown = (event) => { dragging = true; event.target.setPointerCapture(event.pointerId); };
$('#splitter').onpointermove = (event) => { if (dragging) $('aside').style.width = `${Math.max(200, Math.min(480, event.clientX))}px`; };
$('#splitter').onpointerup = () => { dragging = false; };
$('#splitter').onkeydown = (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') $('aside').style.width = `${Math.max(200, Math.min(480, $('aside').offsetWidth + (event.key === 'ArrowLeft' ? -20 : 20)))}px`; };
new ResizeObserver(() => {
  const { x, y, width, height } = $('#viewport').getBoundingClientRect();
  command('bounds', { x, y, width, height });
}).observe($('#viewport'));
