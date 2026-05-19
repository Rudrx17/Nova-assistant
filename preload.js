const { contextBridge, ipcRenderer } = require('electron');

let transcriptQueue = [];
let voiceHandler = null;

// Store listener references for cleanup (H3: prevent listener accumulation)
const _listeners = {
  transcript: null,
  delta: null,
  end: null,
  error: null,
  summary: null,
  systemCommand: null,
  screenshotTaken: null,
};

// Listen for transcripts from Python
_listeners.transcript = ipcRenderer.on('voice:transcript', (_e, text) => {
  if (voiceHandler) {
    voiceHandler(text);
  } else {
    transcriptQueue.push(text);
  }
});

// Listen for screenshot taken event
_listeners.screenshotTaken = ipcRenderer.on('voice:screenshot_taken', () => {
  // Forward to renderer if needed
});

contextBridge.exposeInMainWorld('nova', {
  // --- AI ---
  ask: (text, requestId) => ipcRenderer.send('ai:ask', { text, requestId }),
  askWithScreenshot: (text, requestId) => ipcRenderer.send('ai:askWithScreenshot', { text, requestId }),
  onDelta: (cb) => {
    _listeners.delta = ipcRenderer.on('ai:delta', (_e, data) => cb(data));
    // Return cleanup function
    return () => {
      if (_listeners.delta) {
        _listeners.delta = null;
      }
    };
  },
  onEnd: (cb) => {
    _listeners.end = ipcRenderer.on('ai:end', (_e, data) => cb(data));
    return () => { _listeners.end = null; };
  },
  onError: (cb) => {
    _listeners.error = ipcRenderer.on('ai:error', (_e, data) => cb(data));
    return () => { _listeners.error = null; };
  },

  // --- Window controls ---
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),

  // --- Voice events ---
  onVoice: (cb) => {
    voiceHandler = cb;
    while (transcriptQueue.length) cb(transcriptQueue.shift());
  },
  onWakeWordDetected: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('voice:wake_word_detected', handler);
    return () => ipcRenderer.removeListener('voice:wake_word_detected', handler);
  },
  onWakeWordAborted: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('voice:wake_word_aborted', handler);
    return () => ipcRenderer.removeListener('voice:wake_word_aborted', handler);
  },
  startVoice: () => ipcRenderer.send('voice:start'),
  stopVoice: () => ipcRenderer.send('voice:stop'),
  muteVoice: () => ipcRenderer.send('voice:mute'),
  unmuteVoice: () => ipcRenderer.send('voice:unmute'),

  // Generic command bridge
  sendCommand: (cmd) => ipcRenderer.send('voice:command', cmd),

  // --- Live audio level for waveform ---
  onAudioLevel: (cb) => {
    const handler = (_e, level) => cb(level);
    ipcRenderer.on('voice:audio_level', handler);
    return () => { ipcRenderer.removeListener('voice:audio_level', handler); };
  },

  // --- Summarization ---
  summarize: (fullText, requestId) =>
    ipcRenderer.send('ai:summarize', { text: fullText, requestId }),
  onSummary: (cb) => {
    _listeners.summary = ipcRenderer.on('ai:summary', (_e, data) => cb(data));
    return () => { _listeners.summary = null; };
  },

  // --- Screenshot Signaling (File-based) ---
  checkScreenshotSignal: () => ipcRenderer.invoke('voice:check_screenshot_signal'),
  clearScreenshotSignal: () => ipcRenderer.send('voice:clear_screenshot_signal'),

  // Screenshot Data
  getLastScreenshot: () => ipcRenderer.invoke('voice:get_last_screenshot'),

  // --- System Commands ---
  runSystemCommand: (command, requestId) => ipcRenderer.send('system:command', { command, requestId }),
  onSystemCommandResponse: (cb) => {
    _listeners.systemCommand = ipcRenderer.on('system:command:response', (_e, data) => cb(data));
    return () => { _listeners.systemCommand = null; };
  },

  // --- VS Code ---
  openVsCode: () => ipcRenderer.invoke('system:open_vscode'),

  // --- File Fix (Analyze & Fix) ---
  fixFileWithGemini: (fileName, requestId) =>
    ipcRenderer.send('file:fix', { fileName, requestId }),
  onFileFixDelta: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:fix:delta', handler);
    return () => { ipcRenderer.removeListener('file:fix:delta', handler); };
  },
  onFileFixEnd: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:fix:end', handler);
    return () => { ipcRenderer.removeListener('file:fix:end', handler); };
  },
  onFileFixError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:fix:error', handler);
    return () => { ipcRenderer.removeListener('file:fix:error', handler); };
  },

  // --- AI-Parsed App/Website Opening ---
  openWithAi: (text, requestId) =>
    ipcRenderer.send('app:open_with_ai', { text, requestId }),
  onAppOpening: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('app:opening', handler);
    return () => { ipcRenderer.removeListener('app:opening', handler); };
  },
  onAppOpenError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('app:open_error', handler);
    return () => { ipcRenderer.removeListener('app:open_error', handler); };
  },

  // --- File Editor ---
  openFolder: () => ipcRenderer.invoke('file:open_folder'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  naturalLanguageEdit: (text, requestId) =>
    ipcRenderer.send('file:nl_edit', { text, requestId }),
  editFileWithGemini: (path, instruction, requestId) =>
    ipcRenderer.send('file:edit', { path, instruction, requestId }),
  onFileEditDelta: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:edit:delta', handler);
    return () => { ipcRenderer.removeListener('file:edit:delta', handler); };
  },
  onFileEditEnd: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:edit:end', handler);
    return () => { ipcRenderer.removeListener('file:edit:end', handler); };
  },
  onFileEditError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('file:edit:error', handler);
    return () => { ipcRenderer.removeListener('file:edit:error', handler); };
  },

  // --- Cleanup (H3) ---
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('ai:delta');
    ipcRenderer.removeAllListeners('ai:end');
    ipcRenderer.removeAllListeners('ai:error');
    ipcRenderer.removeAllListeners('ai:summary');
    ipcRenderer.removeAllListeners('system:command:response');
    ipcRenderer.removeAllListeners('voice:audio_level');
    ipcRenderer.removeAllListeners('file:edit:delta');
    ipcRenderer.removeAllListeners('file:edit:end');
    ipcRenderer.removeAllListeners('file:edit:error');
    ipcRenderer.removeAllListeners('file:fix:delta');
    ipcRenderer.removeAllListeners('file:fix:end');
    ipcRenderer.removeAllListeners('file:fix:error');
    ipcRenderer.removeAllListeners('app:opening');
    ipcRenderer.removeAllListeners('app:open_error');
    _listeners.delta = null;
    _listeners.end = null;
    _listeners.error = null;
    _listeners.summary = null;
    _listeners.systemCommand = null;
  }
});
