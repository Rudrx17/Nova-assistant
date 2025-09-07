const chat = document.getElementById('chat');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const closeBtn = document.getElementById('closeBtn');
const minBtn = document.getElementById('minBtn');
const statusEl = document.getElementById('status');
const modeSelect = document.getElementById('modeSelect');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settings-panel');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const themeSelect = document.getElementById('themeSelect');
const readScreenBtn = document.getElementById('readScreenBtn');

const avatarEl = document.querySelector('.avatar');
const pulseEl = document.querySelector('.pulse');

// Helper function to update avatar/pulse classes
function updateAvatarState(state) {
  if (!avatarEl || !pulseEl) return;

  avatarEl.classList.remove('listening', 'thinking', 'speaking');
  pulseEl.classList.remove('listening', 'thinking', 'speaking');

  if (state !== 'idle') {
    avatarEl.classList.add(state);
    pulseEl.classList.add(state);
  }
}

// Speech Synthesis setup
let synth = window.speechSynthesis;
let speaking = false;
let speakQueue = "";
let selectedVoice = null;
let pitchControl = null;
let rateControl = null;
let voiceSelect = null;
let screenshotPending = false;

// Config: Default input mode
let inputMode = 'hybrid';
updateInputModeUI();
try { window.aura.sendCommand("MODE::HYBRID"); } catch (e) {}

function updateInputModeUI() {
  if (!micBtn) return;
  if (inputMode === 'wake') {
    micBtn.style.display = 'none';
  } else {
    micBtn.style.display = 'inline-block';
  }
}

if (modeSelect) {
  modeSelect.value = inputMode;
  modeSelect.addEventListener('change', () => {
    inputMode = modeSelect.value;
    updateInputModeUI();

    try {
      if (inputMode === 'mic') {
        window.aura.sendCommand("MODE::MIC");
      } else if (inputMode === 'wake') {
        window.aura.sendCommand("MODE::WAKE");
      } else {
        window.aura.sendCommand("MODE::HYBRID");
      }
    } catch (e) {}
  });
}

// --- Markdown renderer ---
function renderMarkdown(text) {
  if (!text) return "";

  let html = text.replace(/[&<>]/g, t => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[t]));
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");
  html = html.replace(/^[ \t]*[\*\-\+][ \t]+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, m => `<ul>${m}</ul>`);
  html = html.replace(/^[ \t]*\d+[.)][ \t]+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, m => `<ol>${m}</ol>`);
  html = html.replace(/\n(?!<\/?(ul|ol|li)>)/g, "<br>");

  return html;
}

// --- Chat helpers ---
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

// --- Speech synthesis ---
function speakText(text) {
  if (!synth || !text) return;
  speakQueue += text;
  if (!speaking) {
    speaking = true;
    const utter = new SpeechSynthesisUtterance(speakQueue);
    if (selectedVoice) utter.voice = selectedVoice;
    utter.lang = selectedVoice?.lang || 'en-US';
    utter.rate = rateControl ? parseFloat(rateControl.value) : 1;
    utter.pitch = pitchControl ? parseFloat(pitchControl.value) : 1;

    utter.onstart = () => {
      if (statusEl) { statusEl.className = 'status speaking'; statusEl.textContent = 'Speaking'; }
      updateAvatarState('speaking');
      try { window.aura.muteVoice(); } catch (e) {}
    };
    utter.onend = () => {
      speaking = false;
      speakQueue = "";
      if (statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
      updateAvatarState('idle');
      try { window.aura.unmuteVoice(); } catch (e) {}
    };
    synth.speak(utter);
  }
}

// --- Prompt handling ---
async function sendPrompt() {
  const text = (promptInput?.value || '').trim();
  if (!text || !promptInput) return;
  const requestId = Date.now().toString();

  addMsg(text, 'user');
  promptInput.value = '';
  addMsg('', 'assistant');

  try {
    if (screenshotPending) {
      window.aura.askWithScreenshot(text, requestId);
      screenshotPending = false;
    } else {
      window.aura.ask(text, requestId);
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

// --- UI init ---
window.addEventListener('DOMContentLoaded', () => {
  voiceSelect = document.getElementById('voiceSelect');
  pitchControl = document.getElementById('pitchRange');
  rateControl = document.getElementById('rateRange');

  if (synth && voiceSelect) {
    const populate = () => {
      const voices = synth.getVoices();
      voiceSelect.innerHTML = '';
      voices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
      });
      if (voices.length) {
        selectedVoice = voices[0];
        voiceSelect.value = 0;
      }
    };
    populate();
    synth.onvoiceschanged = populate;

    voiceSelect.addEventListener('change', () => {
      const voices = synth.getVoices();
      selectedVoice = voices[parseInt(voiceSelect.value, 10)];
    });
  }

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

// --- AI streaming handlers ---
if (window.aura?.onDelta) {
  window.aura.onDelta(({ content }) => updateLastMsg(content));
}
if (window.aura?.onEnd) {
  window.aura.onEnd(() => {
    try {
      const last = chat?.lastChild;
      if (last && last.classList.contains('assistant')) {
        const full = last.textContent || '';
        const requestId = Date.now().toString();
        window.aura.summarize(full, requestId);
        handleSystemCommandSuggestion(full, requestId);
      }
    } catch (e) {}
    if (!speaking && statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
    if (!speaking) updateAvatarState('idle');
  });
}
if (window.aura?.onSummary) {
  window.aura.onSummary(({ summary }) => { if (summary) speakText(summary); });
}
if (window.aura?.onError) {
  window.aura.onError(({ error }) => updateLastMsg(`\n[Error: ${error}]`));
}

// --- System command suggestion ---
function handleSystemCommandSuggestion(aiResponse, requestId) {
  const commandRegex = /Would you like me to (open notepad|open calculator|open paint|show desktop|lock computer)\?/i;
  const match = aiResponse.match(commandRegex);

  if (match && match[1]) {
    const command = match[1].toLowerCase();
    try {
      window.aura.runSystemCommand(command, requestId);
      addMsg(`Executing: ${command}...`, 'assistant');
    } catch (e) {
      addMsg(`Command failed to start: ${e?.message || e}`, 'assistant');
    }
  }
}

if (window.aura?.onSystemCommandResponse) {
  window.aura.onSystemCommandResponse(({ requestId, success, error, stdout, stderr }) => {
    if (success) {
      addMsg(`Command executed successfully!`, 'assistant');
      if (stdout) addMsg(`Output: ${stdout}`, 'assistant');
    } else {
      addMsg(`Command failed: ${error}`, 'assistant');
      if (stderr) addMsg(`Error details: ${stderr}`, 'assistant');
    }
  });
}

// --- Read Screen button ---
if (readScreenBtn) {
  readScreenBtn.addEventListener('click', () => {
    try { window.aura.sendCommand("READ_SCREEN"); } catch (e) {}
    addMsg("Taking screenshot...", 'assistant');
    screenshotPending = true;

    const pollInterval = setInterval(async () => {
      try {
        const isReady = await window.aura.checkScreenshotSignal();
        if (isReady) {
          clearInterval(pollInterval);
          if (screenshotPending) {
            addMsg("Screenshot taken. What would you like to ask about it?", 'assistant');
            promptInput?.focus();
            try { window.aura.clearScreenshotSignal(); } catch (e) {}

            
          }
        }
      } catch (e) {
        clearInterval(pollInterval);
        addMsg("Error while checking screenshot signal.", 'assistant');
      }
    }, 500);
  });
}

// --- Mic controls ---
let listening = false;
function bindMicControls() {
  if (!micBtn) return;

  micBtn.addEventListener('mousedown', () => {
    if (inputMode === 'wake') return;
    listening = true;
    micBtn.classList.add('listening');
    try { window.aura.sendCommand("START"); } catch (e) {}
    if (statusEl) { statusEl.className = 'status listening'; statusEl.textContent = 'Listening'; }
    updateAvatarState('listening');
  });

  micBtn.addEventListener('mouseup', () => {
    if (inputMode === 'wake') return;
    listening = false;
    micBtn.classList.remove('listening');
    try { window.aura.sendCommand("STOP"); } catch (e) {}
    if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
    updateAvatarState('thinking');
  });

  micBtn.addEventListener('mouseleave', () => {
    if (listening && inputMode !== 'wake') {
      listening = false;
      micBtn.classList.remove('listening');
      try { window.aura.sendCommand("STOP"); } catch (e) {}
      if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
      updateAvatarState('thinking');
    }
  });
}
bindMicControls();

// --- Voice transcript ---
if (window.aura?.onVoice) {
  window.aura.onVoice((transcript) => {
    if (!transcript?.trim() || !promptInput) return;
    promptInput.value = transcript;
    if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
    updateAvatarState('thinking');
    sendPrompt();
  });
}

// --- Wake word ---
if (window.aura?.onWakeWord) {
  window.aura.onWakeWord((word) => {
    if (inputMode === 'mic') return;
    if (statusEl) {
      statusEl.className = 'status listening';
      statusEl.textContent = `Wake word detected: ${word}`;
    }
    updateAvatarState('listening');
    try { window.aura.sendCommand("START"); } catch (e) {}
  });
}

// --- Settings panel ---
if (settingsBtn && settingsPanel && closeSettingsBtn) {
  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('hidden');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });
}

// --- Window controls ---
if (closeBtn) closeBtn.addEventListener('click', () => { try { window.aura.closeWindow(); } catch (e) {} });
if (minBtn) minBtn.addEventListener('click', () => { try { window.aura.minimizeWindow(); } catch (e) {} });
