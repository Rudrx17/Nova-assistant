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

// Speech Synthesis setup
let synth = window.speechSynthesis;
let speaking = false;
let speakQueue = "";
let selectedVoice = null;
let pitchControl = null;
let rateControl = null;
let voiceSelect = null;

// Config: Default input mode
let inputMode = 'hybrid'; // default mode
updateInputModeUI();
window.aura.sendCommand("MODE::HYBRID"); // ✅ Tell backend at startup

// Update UI and behavior based on input mode
function updateInputModeUI() {
  if (inputMode === 'wake') {
    micBtn.style.display = 'none';
  } else {
    micBtn.style.display = 'inline-block';
  }
}

// Handle dropdown change
if (modeSelect) {
  modeSelect.value = inputMode;
  modeSelect.addEventListener('change', () => {
    inputMode = modeSelect.value;
    updateInputModeUI();

    if (inputMode === 'mic') {
      window.aura.sendCommand("MODE::MIC");
    } else if (inputMode === 'wake') {
      window.aura.sendCommand("MODE::WAKE");
    } else {
      window.aura.sendCommand("MODE::HYBRID");
    }
  });
}

// Add message to chat
function addMsg(text, who = 'assistant') {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  chat.appendChild(div);

  setTimeout(() => {
    if (!chat) return;
    chat.scrollTo({
      top: chat.scrollHeight,
      behavior: 'smooth'
    });
  }, 10);
}

// Update last assistant message
function updateLastMsg(extra) {
  if (chat.lastChild && chat.lastChild.classList.contains('assistant')) {
    chat.lastChild.textContent += extra;
    setTimeout(() => {
      if (!chat) return;
      chat.scrollTo({ top: chat.scrollHeight, behavior: 'auto' });
    }, 0);
  }
}

// Speak text
function speakText(text) {
  if (!synth) return;
  speakQueue += text;
  if (!speaking) {
    speaking = true;
    const utter = new SpeechSynthesisUtterance(speakQueue);
    if (selectedVoice) utter.voice = selectedVoice;
    const pitch = pitchControl ? parseFloat(pitchControl.value) : 1;
    const rate = rateControl ? parseFloat(rateControl.value) : 1;
    utter.lang = selectedVoice ? selectedVoice.lang || 'en-US' : 'en-US';
    utter.rate = rate;
    utter.pitch = pitch;
    utter.onstart = () => {
      if (statusEl) { statusEl.className = 'status speaking'; statusEl.textContent = 'Speaking'; }
      try { window.aura.muteVoice(); } catch (e) {}
    };
    utter.onend = () => {
      speaking = false;
      speakQueue = "";
      if (statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
      try { window.aura.unmuteVoice(); } catch (e) {}
    };
    synth.speak(utter);
  }
}

// Send prompt to AI
async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;
  const requestId = Date.now().toString();

  addMsg(text, 'user');
  promptInput.value = '';
  addMsg('', 'assistant');

  window.aura.ask(text, requestId);
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// Initialize voice controls
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

  // Theme control
  if (themeSelect) {
    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      document.body.classList.toggle('light-theme', savedTheme === 'light');
      themeSelect.value = savedTheme;
    } else {
      // Default to dark if no preference saved
      document.body.classList.remove('light-theme'); // Explicitly ensure dark theme
      themeSelect.value = 'dark';
    }

    themeSelect.addEventListener('change', () => {
      const selectedTheme = themeSelect.value;
      document.body.classList.toggle('light-theme', selectedTheme === 'light');
      localStorage.setItem('theme', selectedTheme);
    });
  }
});

// AI streaming handlers
window.aura.onDelta(({ content }) => updateLastMsg(content));

// Function to handle system command suggestions from AI
function handleSystemCommandSuggestion(aiResponse, requestId) {
  const commandRegex = /Would you like me to (open notepad|open calculator|open paint|show desktop|lock computer)\?/i;
  const match = aiResponse.match(commandRegex);

  if (match && match[1]) {
    const command = match[1].toLowerCase();
    // Removed confirmation dialog
    window.aura.runSystemCommand(command, requestId);
    addMsg(`Executing: ${command}...`, 'assistant'); // Provide immediate feedback
  }
}

// Listen for system command responses
window.aura.onSystemCommandResponse(({ requestId, success, error, stdout, stderr }) => {
  if (success) {
    addMsg(`Command executed successfully!`, 'assistant');
    if (stdout) addMsg(`Output: ${stdout}`, 'assistant');
  } else {
    addMsg(`Command failed: ${error}`, 'assistant');
    if (stderr) addMsg(`Error details: ${stderr}`, 'assistant');
  }
});

window.aura.onEnd(() => {
  try {
    const last = chat.lastChild;
    if (last && last.classList.contains('assistant')) {
      const full = last.textContent || '';
      const requestId = Date.now().toString();
      window.aura.summarize(full, requestId);
      handleSystemCommandSuggestion(full, requestId); // Check for system command suggestions
    }
  } catch (e) {}
  if (!speaking && statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
});
window.aura.onSummary(({ summary }) => { if (summary) speakText(summary); });
window.aura.onError(({ error }) => updateLastMsg(`\n[Error: ${error}]`));

// Mic Support
let listening = false;
function bindMicControls() {
  micBtn.addEventListener('mousedown', () => {
    if (inputMode === 'wake') return;
    listening = true;
    micBtn.classList.add('active');
    try { window.aura.sendCommand("START"); } catch (e) {}
    if (statusEl) { statusEl.className = 'status listening'; statusEl.textContent = 'Listening'; }
  });

  micBtn.addEventListener('mouseup', () => {
    if (inputMode === 'wake') return;
    listening = false;
    micBtn.classList.remove('active');
    try { window.aura.sendCommand("STOP"); } catch (e) {}
    if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
  });

  micBtn.addEventListener('mouseleave', () => {
    if (listening && inputMode !== 'wake') {
      listening = false;
      micBtn.classList.remove('active');
      try { window.aura.sendCommand("STOP"); } catch (e) {}
      if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
    }
  });
}
bindMicControls();

// Receive transcript from Python
window.aura.onVoice((transcript) => {
  if (!transcript?.trim()) return;
  promptInput.value = transcript;
  if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
  sendPrompt();
});

// Handle Wake Word
window.aura.onWakeWord((word) => {
  if (inputMode === 'mic') return; // ignore in mic-only mode
  if (statusEl) {
    statusEl.className = 'status listening';
    statusEl.textContent = `Wake word detected: ${word}`;
  }
  try { window.aura.sendCommand("START"); } catch (e) {}
});

// Settings Panel
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.remove('hidden');
});

closeSettingsBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

// Window Controls
closeBtn.addEventListener('click', () => window.aura.closeWindow());
minBtn.addEventListener('click', () => window.aura.minimizeWindow());
