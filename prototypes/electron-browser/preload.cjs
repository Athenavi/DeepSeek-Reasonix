const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('prototype', {
  command: (method, args = {}) => ipcRenderer.invoke('prototype:command', { method, args }),
  onState: (callback) => ipcRenderer.on('prototype:state', (_event, state) => callback(state))
});
