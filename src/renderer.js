// ===================== DOM References =====================
const chat = document.getElementById('chat');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const closeBtn = document.getElementById('closeBtn');
const minBtn = document.getElementById('minBtn');
const statusEl = document.getElementById('status');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settings-panel');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const themeSelect = document.getElementById('themeSelect');
const readScreenBtn = document.getElementById('readScreenBtn');

const avatarEl = document.querySelector('.avatar');
const pulseEl = document.querySelector('.pulse');

// ===================== Avatar State =====================
function updateAvatarState(state) {
  if (!avatarEl || !pulseEl) return;

  avatarEl.classList.remove('listening', 'thinking', 'speaking');
  pulseEl.classList.remove('listening', 'thinking', 'speaking');

  if (state !== 'idle') {
    avatarEl.classList.add(state);
    pulseEl.classList.add(state);
  }
}

// ===================== Speech Synthesis (L3: encapsulated) =====================
const speechManager = {
  synth: window.speechSynthesis,
  speaking: false,
  queue: [],
  selectedVoice: null,
  pitch: 1,
  rate: 1,

  speak(text) {
    if (!this.synth || !text) return;

    // M3: Proper queue — push to array, process sequentially
    this.queue.push(text);
    if (!this.speaking) {
      this._processQueue();
    }
  },

  _processQueue() {
    if (this.queue.length === 0) {
      this.speaking = false;
      return;
    }

    this.speaking = true;
    const textToSpeak = this.queue.shift();
    const utter = new SpeechSynthesisUtterance(textToSpeak);
    if (this.selectedVoice) utter.voice = this.selectedVoice;
    utter.lang = this.selectedVoice?.lang || 'en-US';
    utter.rate = this.rate;
    utter.pitch = this.pitch;

    utter.onstart = () => {
      if (statusEl) { statusEl.className = 'status speaking'; statusEl.textContent = 'Speaking'; }
      updateAvatarState('speaking');
      try { window.nova.muteVoice(); } catch (e) { /* bridge not ready */ }
    };

    utter.onend = () => {
      if (statusEl && this.queue.length === 0) {
        statusEl.className = 'status idle';
        statusEl.textContent = 'Idle';
      }
      updateAvatarState(this.queue.length > 0 ? 'speaking' : 'idle');
      if (this.queue.length === 0) {
        try { window.nova.unmuteVoice(); } catch (e) { /* bridge not ready */ }
      }
      // Process next in queue
      this._processQueue();
    };

    utter.onerror = (e) => {
      console.error('Speech synthesis error:', e);
      this.speaking = false;
      this.queue = [];
      if (statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
      updateAvatarState('idle');
      try { window.nova.unmuteVoice(); } catch (e) { /* bridge not ready */ }
    };

    this.synth.speak(utter);
  },

  populateVoices(voiceSelectEl) {
    if (!this.synth || !voiceSelectEl) return;
    const voices = this.synth.getVoices();
    voiceSelectEl.innerHTML = '';
    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      voiceSelectEl.appendChild(opt);
    });
    if (voices.length) {
      this.selectedVoice = voices[0];
      voiceSelectEl.value = 0;
    }
  }
};

// ===================== Markdown Renderer =====================
function renderMarkdown(text) {
  if (!text) return '';

  let html = text.replace(/[&<>]/g, (t) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[t]
  );
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/^[ \t]*[\*\-]+[ \t]+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^[ \t]*\d+[.)][ \t]+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (m) => `<ol>${m}</ol>`);
  html = html.replace(/\n(?!<\/?(ul|ol|li)>)/g, '<br>');

  return html;
}

// ===================== Chat Helpers =====================
function addMsg(text, who = 'assistant') {
  if (!chat) return;
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = renderMarkdown(text);
  chat.appendChild(div);

  setTimeout(() => {
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
  }, 10);
}

function updateLastMsg(extra) {
  if (chat?.lastChild && chat.lastChild.classList.contains('assistant')) {
    chat.lastChild.innerHTML += renderMarkdown(extra);
    setTimeout(() => {
      chat.scrollTo({ top: chat.scrollHeight, behavior: 'auto' });
    }, 0);
  }
}

// ===================== System Command Suggestion =====================
function handleSystemCommandSuggestion(aiResponse, requestId) {
  const commandRegex = /Would you like me to (open notepad|open calculator|open paint|show desktop|lock computer)\?/i;
  const match = aiResponse.match(commandRegex);

  if (match && match[1]) {
    const command = match[1].toLowerCase();
    try {
      window.nova.runSystemCommand(command, requestId);
      addMsg(`Executing: ${command}...`, 'assistant');
    } catch (e) {
      addMsg(`Command failed to start: ${e?.message || e}`, 'assistant');
    }
  }
}

// ===================== Cleanup Registry (declared early for TDZ safety) =====================
const cleanupFunctions = [];

// ===================== Live Waveform Visualizer =====================
let waveformShow = null;
let waveformHide = null;

const waveformContainer = document.getElementById('waveformContainer');
const waveformCanvas = document.getElementById('waveformCanvas');

if (waveformCanvas) {
  const ctx = waveformCanvas.getContext('2d');
  const BAR_COUNT = 32;
  const barLevels = new Float32Array(BAR_COUNT);
  const barTargets = new Float32Array(BAR_COUNT);
  let animFrame = null;
  let waveformActive = false;

  // Size canvas to container
  function resizeCanvas() {
    const rect = waveformContainer.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = 56;
    if (waveformCanvas.width !== w || waveformCanvas.height !== h) {
      waveformCanvas.width = w;
      waveformCanvas.height = h;
    }
  }

  function drawWaveform() {
    if (!ctx || !waveformActive) {
      animFrame = null;
      return;
    }

    const w = waveformCanvas.width;
    const h = waveformCanvas.height;
    const gap = 3;
    const barW = (w - gap * (BAR_COUNT + 1)) / BAR_COUNT;

    // Smooth bars toward targets with momentum
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = (i + Math.floor(Math.random() * 2)) % BAR_COUNT;
      if (barTargets[idx] > barLevels[idx]) {
        barLevels[idx] += (barTargets[idx] - barLevels[idx]) * 0.35;
      } else {
        barLevels[idx] += (barTargets[idx] - barLevels[idx]) * 0.08;
      }
      if (barLevels[idx] < 0.005) barLevels[idx] = 0;
    }

    ctx.clearRect(0, 0, w, h);

    const colors = [
      { stop: 0.0, color: [75, 163, 255] },
      { stop: 0.5, color: [120, 80, 255] },
      { stop: 0.8, color: [200, 60, 240] },
      { stop: 1.0, color: [255, 80, 120] },
    ];

    function getBarColor(t) {
      const clamped = Math.max(0, Math.min(1, t));
      for (let i = 0; i < colors.length - 1; i++) {
        if (clamped >= colors[i].stop && clamped <= colors[i + 1].stop) {
          const local = (clamped - colors[i].stop) / (colors[i + 1].stop - colors[i].stop);
          const [r1, g1, b1] = colors[i].color;
          const [r2, g2, b2] = colors[i + 1].color;
          return `rgb(${Math.round(r1 + (r2 - r1) * local)}, ${Math.round(g1 + (g2 - g1) * local)}, ${Math.round(b1 + (b2 - b1) * local)})`;
        }
      }
      return 'rgb(75, 163, 255)';
    }

    for (let i = 0; i < BAR_COUNT; i++) {
      const barH = Math.max(2, barLevels[i] * h * 0.85);
      const x = gap + i * (barW + gap);
      const y = h - barH;

      ctx.fillStyle = getBarColor(barLevels[i]);

      const radius = Math.min(3, barW / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + barW - radius, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
      ctx.lineTo(x + barW, h);
      ctx.lineTo(x, h);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(75, 163, 255, 0.08)');
    gradient.addColorStop(1, 'rgba(75, 163, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    animFrame = requestAnimationFrame(drawWaveform);
  }

  // Handle incoming audio levels from Python
  if (window.nova?.onAudioLevel) {
    const levelCleanup = window.nova.onAudioLevel((level) => {
      for (let i = 0; i < BAR_COUNT; i++) {
        const variation = 0.7 + Math.random() * 0.6;
        barTargets[i] = Math.min(1, level * variation);
      }
      if (!animFrame && waveformActive) {
        animFrame = requestAnimationFrame(drawWaveform);
      }
    });
    cleanupFunctions.push(levelCleanup);
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  waveformShow = () => {
    resizeCanvas();
    waveformActive = true;
    waveformContainer.classList.add('active');
    barLevels.fill(0);
    barTargets.fill(0);
    if (!animFrame) {
      animFrame = requestAnimationFrame(drawWaveform);
    }
  };

  waveformHide = () => {
    waveformActive = false;
    waveformContainer.classList.remove('active');
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    if (ctx) ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  };
}

// ===================== Prompt Handling =====================
let screenshotPending = false;

async function sendPrompt() {
  const text = (promptInput?.value || '').trim();
  if (!text || !promptInput) return;
  const requestId = Date.now().toString();

  addMsg(text, 'user');
  promptInput.value = '';
  addMsg('', 'assistant');

  try {
    if (screenshotPending) {
      window.nova.askWithScreenshot(text, requestId);
      screenshotPending = false;
    } else {
      window.nova.ask(text, requestId);
    }
  } catch (e) {
    updateLastMsg(`\n[Error: ${e?.message || e}]`);
  }
}

if (sendBtn) sendBtn.addEventListener('click', sendPrompt);
if (promptInput) {
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
}

// ===================== Mic Controls (L2: scoped) =====================
function bindMicControls() {
  if (!micBtn) return;

  // L2: listening is now scoped inside this closure
  let listening = false;

  micBtn.addEventListener('mousedown', () => {
    listening = true;
    micBtn.classList.add('listening');
    try { window.nova.sendCommand('START'); } catch (e) { /* bridge not ready */ }
    if (statusEl) { statusEl.className = 'status listening'; statusEl.textContent = 'Listening'; }
    updateAvatarState('listening');
    // Show live waveform
    if (typeof waveformShow === 'function') waveformShow();
  });

  // FIX: Use document-level mouseup to detect release even if cursor leaves the button
  const handleStop = () => {
    if (!listening) return;
    listening = false;
    micBtn.classList.remove('listening');
    try { window.nova.sendCommand('STOP'); } catch (e) { /* bridge not ready */ }
    if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
    updateAvatarState('thinking');
    // Hide live waveform
    if (typeof waveformHide === 'function') waveformHide();
  };

  micBtn.addEventListener('mouseup', handleStop);

  // FIX: Don't send STOP on mouseleave — user may still be holding the button
  // Only remove the visual cue; if the user releases anywhere, document mouseup fires
  micBtn.addEventListener('mouseleave', () => {
    micBtn.classList.remove('listening');
  });

  // FIX: Detect mouse release anywhere on the page (Discord-style hold-to-talk)
  document.addEventListener('mouseup', handleStop);
}

bindMicControls();

// ===================== Read Screen Button =====================
if (readScreenBtn) {
  readScreenBtn.addEventListener('click', () => {
    try { window.nova.sendCommand('READ_SCREEN'); } catch (e) { /* bridge not ready */ }
    addMsg('Taking screenshot...', 'assistant');
    screenshotPending = true;

    const pollInterval = setInterval(async () => {
      try {
        const isReady = await window.nova.checkScreenshotSignal();
        if (isReady) {
          clearInterval(pollInterval);
          if (screenshotPending) {
            addMsg('Screenshot taken. What would you like to ask about it?', 'assistant');
            promptInput?.focus();
            try { window.nova.clearScreenshotSignal(); } catch (e) { /* bridge not ready */ }
          }
        }
      } catch (e) {
        clearInterval(pollInterval);
        addMsg('Error while checking screenshot signal.', 'assistant');
      }
    }, 500);
  });
}

// ===================== Voice Transcript Handler =====================
if (window.nova?.onVoice) {
  window.nova.onVoice((transcript) => {
    if (!transcript?.trim() || !promptInput) return;
    promptInput.value = transcript;
    if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
    updateAvatarState('thinking');
    sendPrompt();
  });
}

// ===================== AI Streaming Handlers (H3: with cleanup) =====================

if (window.nova?.onDelta) {
  const cleanup = window.nova.onDelta(({ content }) => updateLastMsg(content));
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onEnd) {
  const cleanup = window.nova.onEnd(() => {
    try {
      const last = chat?.lastChild;
      if (last && last.classList.contains('assistant')) {
        const full = last.textContent || '';
        const requestId = Date.now().toString();
        window.nova.summarize(full, requestId);
        handleSystemCommandSuggestion(full, requestId);
      }
    } catch (e) { /* ignore */ }
    if (!speechManager.speaking && statusEl) {
      statusEl.className = 'status idle';
      statusEl.textContent = 'Idle';
    }
    if (!speechManager.speaking) updateAvatarState('idle');
  });
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onSummary) {
  const cleanup = window.nova.onSummary(({ summary }) => {
    if (summary) speechManager.speak(summary);
  });
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onError) {
  const cleanup = window.nova.onError(({ error }) => updateLastMsg(`\n[Error: ${error}]`));
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onSystemCommandResponse) {
  const cleanup = window.nova.onSystemCommandResponse(
    ({ requestId, success, error, stdout, stderr }) => {
      if (success) {
        addMsg('Command executed successfully!', 'assistant');
        if (stdout) addMsg(`Output: ${stdout}`, 'assistant');
      } else {
        addMsg(`Command failed: ${error}`, 'assistant');
        if (stderr) addMsg(`Error details: ${stderr}`, 'assistant');
      }
    }
  );
  cleanupFunctions.push(cleanup);
}

// ===================== UI Init =====================
window.addEventListener('DOMContentLoaded', () => {
  const voiceSelect = document.getElementById('voiceSelect');
  const pitchControl = document.getElementById('pitchRange');
  const rateControl = document.getElementById('rateRange');

  // Speech synthesis setup
  if (speechManager.synth && voiceSelect) {
    speechManager.populateVoices(voiceSelect);
    speechManager.synth.onvoiceschanged = () => speechManager.populateVoices(voiceSelect);

    voiceSelect.addEventListener('change', () => {
      const voices = speechManager.synth.getVoices();
      speechManager.selectedVoice = voices[parseInt(voiceSelect.value, 10)];
    });
  }

  if (pitchControl) {
    pitchControl.addEventListener('input', () => {
      speechManager.pitch = parseFloat(pitchControl.value);
    });
  }

  if (rateControl) {
    rateControl.addEventListener('input', () => {
      speechManager.rate = parseFloat(rateControl.value);
    });
  }

  // Theme
  if (themeSelect) {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      document.body.classList.toggle('light-theme', savedTheme === 'light');
      themeSelect.value = savedTheme;
    } else {
      document.body.classList.remove('light-theme');
      themeSelect.value = 'dark';
    }

    themeSelect.addEventListener('change', () => {
      const selectedTheme = themeSelect.value;
      document.body.classList.toggle('light-theme', selectedTheme === 'light');
      localStorage.setItem('theme', selectedTheme);
    });
  }

  // Opacity
  const opacityRange = document.getElementById('opacityRange');
  if (opacityRange) {
    const savedOpacity = localStorage.getItem('uiOpacity');
    document.body.style.opacity = savedOpacity ?? 1;
    opacityRange.value = savedOpacity ?? 1;

    opacityRange.addEventListener('input', () => {
      const selectedOpacity = opacityRange.value;
      document.body.style.opacity = selectedOpacity;
      localStorage.setItem('uiOpacity', selectedOpacity);
    });
  }
});

// ===================== Settings Panel =====================
if (settingsBtn && settingsPanel && closeSettingsBtn) {
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });
}

// ===================== Cleanup on Window Close (H3) =====================
window.addEventListener('beforeunload', () => {
  // Invoke all stored cleanup functions to remove IPC listeners
  for (const cleanup of cleanupFunctions) {
    try { cleanup(); } catch (e) { /* ignore cleanup errors */ }
  }
  // Also remove all listeners via preload bridge
  try { window.nova.removeAllListeners(); } catch (e) { /* bridge not ready */ }
});

// ===================== Window Controls =====================
if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    try { window.nova.closeWindow(); } catch (e) { /* bridge not ready */ }
  });
}
if (minBtn) {
  minBtn.addEventListener('click', () => {
    try { window.nova.minimizeWindow(); } catch (e) { /* bridge not ready */ }
  });
}
