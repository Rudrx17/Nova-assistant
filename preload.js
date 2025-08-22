const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nova', {
  ask: (text, requestId) => ipcRenderer.send('ai:ask', { text, requestId }),
  onDelta: (cb) => ipcRenderer.on('ai:delta', (_e, data) => cb(data)),
  onEnd: (cb) => ipcRenderer.on('ai:end', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('ai:error', (_e, data) => cb(data)),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  onVoice: (cb) => ipcRenderer.on('voice:transcript', (_e, text) => cb(text)),
  // Voice controls for push-to-talk and muting microphone during assistant speech
  startVoice: () => ipcRenderer.send('voice:start'),
  stopVoice: () => ipcRenderer.send('voice:stop'),
  muteVoice: () => ipcRenderer.send('voice:mute'),
  unmuteVoice: () => ipcRenderer.send('voice:unmute'),

  // Summarization helper: request a short spoken summary of a full assistant response
  summarize: (fullText, requestId) => ipcRenderer.send('ai:summarize', { text: fullText, requestId }),
  onSummary: (cb) => ipcRenderer.on('ai:summary', (_e, data) => cb(data)),

  // Wake word event listener
  onWakeWord: (cb) => ipcRenderer.on('voice:wakeword', (_e, word) => cb(word))
});
