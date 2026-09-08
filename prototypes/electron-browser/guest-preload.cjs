const { ipcRenderer } = require('electron');
// Runs in an isolated world. Exposes no host functions to the website.
for (const type of ['pointerdown', 'keydown', 'wheel', 'compositionstart']) {
  window.addEventListener(type, (event) => {
    if (event.isTrusted) ipcRenderer.send('prototype:human-input', { type });
  }, { capture: true, passive: true });
}
