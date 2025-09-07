const { contextBridge, ipcRenderer } = require('electron');

let transcriptQueue = [];
let wakeWordQueue = [];
let voiceHandler = null;
let wakeHandler = null;

// Listen for transcripts from Python
ipcRenderer.on('voice:transcript', (_e, text) => {
  if (voiceHandler) {
    voiceHandler(text);
  } else {
    transcriptQueue.push(text);
  }
});

// Listen for wake word events
ipcRenderer.on('voice:wakeword', (_e, word) => {
  if (wakeHandler) {
    wakeHandler(word);
  } else {
    wakeWordQueue.push(word);
  }
});

contextBridge.exposeInMainWorld('aura', {
  // --- AI ---
  ask: (text, requestId) => ipcRenderer.send('ai:ask', { text, requestId }),
  askWithScreenshot: (text, requestId) => ipcRenderer.send('ai:askWithScreenshot', { text, requestId }),
  onDelta: (cb) => ipcRenderer.on('ai:delta', (_e, data) => cb(data)),
  onEnd: (cb) => ipcRenderer.on('ai:end', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('ai:error', (_e, data) => cb(data)),

  // --- Window controls ---
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),

  // --- Voice events ---
  onVoice: (cb) => {
    voiceHandler = cb;
    while (transcriptQueue.length) cb(transcriptQueue.shift());
  },
  startVoice: () => ipcRenderer.send('voice:start'),
  stopVoice: () => ipcRenderer.send('voice:stop'),
  muteVoice: () => ipcRenderer.send('voice:mute'),
  unmuteVoice: () => ipcRenderer.send('voice:unmute'),

  // 🔥 Generic command bridge (START / STOP / MUTE / UNMUTE / MODE::XXX)
  sendCommand: (cmd) => ipcRenderer.send('voice:command', cmd),

  // --- Summarization ---
  summarize: (fullText, requestId) =>
    ipcRenderer.send('ai:summarize', { text: fullText, requestId }),
  onSummary: (cb) =>
    ipcRenderer.on('ai:summary', (_e, data) => cb(data)),

  // --- Wake word ---
  onWakeWord: (cb) => {
    wakeHandler = cb;
    while (wakeWordQueue.length) cb(wakeWordQueue.shift());
  },

  // --- Screenshot Signaling (File-based) ---
  checkScreenshotSignal: () => ipcRenderer.invoke('voice:check_screenshot_signal'),
  clearScreenshotSignal: () => ipcRenderer.send('voice:clear_screenshot_signal'),

  // 🔥 NEW: Screenshot Data
  getLastScreenshot: () => ipcRenderer.invoke('voice:get_last_screenshot'),

  // --- System Commands ---
  runSystemCommand: (command, requestId) => ipcRenderer.send('system:command', { command, requestId }),
  onSystemCommandResponse: (cb) => ipcRenderer.on('system:command:response', (_e, data) => cb(data))
});
