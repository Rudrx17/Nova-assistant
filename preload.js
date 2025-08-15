const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nova', {
  ask: (text, requestId) => ipcRenderer.send('ai:ask', { text, requestId }),
  onDelta: (cb) => ipcRenderer.on('ai:delta', (_e, data) => cb(data)),
  onEnd: (cb) => ipcRenderer.on('ai:end', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('ai:error', (_e, data) => cb(data)),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize')
});
