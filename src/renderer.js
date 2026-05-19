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

  stop() {
    if (this.synth) {
      this.synth.cancel();
    }
    this.speaking = false;
    this.queue = [];
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
  const commandRegex = /Would you like me to (open notepad|open calculator|open paint|show desktop|lock computer|open vs code|open vscode|open visual studio code|open youtube|open whatsapp|open chrome|open spotify)\?/i;
  const match = aiResponse.match(commandRegex);

  if (match && match[1]) {
    const command = match[1].toLowerCase();
    try {
      if (command.includes('vs code') || command.includes('vscode') || command.includes('visual studio')) {
        handleVsCodeCommand();
      } else {
        window.nova.runSystemCommand(command, requestId);
        addMsg(`Executing: ${command}...`, 'assistant');
      }
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

// These are replaced later by sendPromptWithFileEdit — but we're attaching a named
// handler so it can be properly removed
let _keydownHandler;
if (sendBtn) sendBtn.addEventListener('click', sendPrompt);
if (promptInput) {
  _keydownHandler = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  };
  promptInput.addEventListener('keydown', _keydownHandler);
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
  // Only remove the visual cue; if the user releases anywhere, we detect via document mouseup
  micBtn.addEventListener('mouseleave', () => {
    micBtn.classList.remove('listening');
  });

  // Detect mouse release anywhere — but ONLY if we started holding the mic
  // Use a flag scoped in the closure so only a mic-button mousedown arms it
  const onOutsideMouseUp = (e) => {
    // Only fire if the mic was pressed AND the click didn't start on the mic button
    // (mic button has its own mouseup handler that already fires)
    if (e.target !== micBtn && !micBtn.contains(e.target)) {
      handleStop();
    }
  };
  document.addEventListener('mouseup', onOutsideMouseUp);
}

bindMicControls();

// ===================== Basic System Commands (pre-AI interception) =====================
// These are matched BEFORE reaching the AI — saves API calls and ensures they actually execute
const SYSTEM_COMMANDS = [
  { keywords: ['notepad'], cmd: 'open notepad', label: 'Notepad', action: /^(open|launch|start)\b/i },
  { keywords: ['calculator', 'calc'], cmd: 'open calculator', label: 'Calculator', action: /^(open|launch|start)\b/i },
  { keywords: ['paint', 'mspaint'], cmd: 'open paint', label: 'Paint', action: /^(open|launch|start)\b/i },
  { keywords: ['desktop'], cmd: 'show desktop', label: 'Desktop', action: /^show\b/i },
  { keywords: ['lock computer', 'lock the computer', 'lock my computer', 'lock pc', 'lock the pc', 'lock my pc', 'lock screen', 'lock the screen'], cmd: 'lock computer', label: 'Computer lock', action: /^lock\b/i },
];

function isBasicSystemCommand(text) {
  const lower = text.toLowerCase().trim();
  for (let i = 0; i < SYSTEM_COMMANDS.length; i++) {
    const cmd = SYSTEM_COMMANDS[i];
    if (!cmd.action.test(lower)) continue;
    for (let j = 0; j < cmd.keywords.length; j++) {
      if (lower.indexOf(cmd.keywords[j]) >= 0) {
        return true;
      }
    }
  }
  return false;
}

function getSystemCommand(text) {
  const lower = text.toLowerCase().trim();
  for (let i = 0; i < SYSTEM_COMMANDS.length; i++) {
    const cmd = SYSTEM_COMMANDS[i];
    if (!cmd.action.test(lower)) continue;
    for (let j = 0; j < cmd.keywords.length; j++) {
      if (lower.indexOf(cmd.keywords[j]) >= 0) {
        return cmd;
      }
    }
  }
  return null;
}

function handleSystemCommand(cmdInfo) {
  addMsg('\u2699\uFE0F Executing: **' + cmdInfo.label + '**...', 'assistant');
  const requestId = Date.now().toString();
  window.nova.runSystemCommand(cmdInfo.cmd, requestId);
}

// ===================== App/Website Open Handler =====================
// Known apps/websites that can be opened directly
const APP_COMMANDS = [
  { keywords: ['youtube'], type: 'url', label: 'YouTube' },
  { keywords: ['whatsapp', 'whats app', 'whats-app'], type: 'app', cmd: 'open whatsapp', label: 'WhatsApp' },
  { keywords: ['chrome', 'google chrome', 'google-chrome'], type: 'app', cmd: 'open chrome', label: 'Chrome' },
  { keywords: ['spotify'], type: 'app', cmd: 'open spotify', label: 'Spotify' },
];

function isAppOpenIntent(text) {
  const lower = text.toLowerCase().trim();
  // Must start with open/launch/start/play
  const hasOpenAction = /^(open|launch|start|play)\b/i.test(lower);
  if (!hasOpenAction) return false;
  
  for (let i = 0; i < APP_COMMANDS.length; i++) {
    for (let j = 0; j < APP_COMMANDS[i].keywords.length; j++) {
      if (lower.indexOf(APP_COMMANDS[i].keywords[j]) >= 0) {
        return true;
      }
    }
  }
  return false;
}

function getAppCommand(text) {
  const lower = text.toLowerCase().trim();
  for (let i = 0; i < APP_COMMANDS.length; i++) {
    for (let j = 0; j < APP_COMMANDS[i].keywords.length; j++) {
      if (lower.indexOf(APP_COMMANDS[i].keywords[j]) >= 0) {
        return APP_COMMANDS[i];
      }
    }
  }
  return null;
}

function handleAppOpenCommand(appInfo) {
  const label = appInfo.label;
  addMsg('\ud83d\ude80 Opening **' + label + '**...', 'assistant');
  const requestId = Date.now().toString();
  window.nova.runSystemCommand(appInfo.cmd || ('open ' + label.toLowerCase()), requestId);
}

// ===================== AI-Parsed App/Website Opening (Hybrid) =====================
// Catch-all: anything starting with "open/launch/start/play" that wasn't caught by
// the instant whitelist above gets parsed by Groq to determine what to open
function isAiOpenIntent(text) {
  return /^(open|launch|start|play)\b/i.test(text.toLowerCase().trim());
}

// Store the original text so we can fall back to AI chat if Groq can't identify it
let pendingAiAppText = null;

function handleAiAppOpen(text) {
  pendingAiAppText = text;
  const requestId = Date.now().toString();
  window.nova.openWithAi(text, requestId);
}

// ===================== File Fix (Analyze & Fix) Intent =====================
const FIX_KEYWORDS = ['fix', 'analyze', 'debug', 'resolve', 'correct', 'repair', 'troubleshoot'];

// Patterns for structured fix commands
// fix filename.ext — fix all errors
// fix filename.ext: additional instruction
// fix errors in filename.ext
// analyze filename.ext
// debug filename.ext
function isFixIntent(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Structured: keyword filename.extension (with or without colon)
  // e.g., "fix test.py", "fix test.py: add error handling"
  if (/^(fix|analyze|debug|resolve|correct|repair|troubleshoot)\s+\S+\.\w{1,6}/i.test(trimmed)) {
    return true;
  }

  // Structured: keyword errors/bugs in filename.extension
  // e.g., "fix errors in test.py", "fix bugs in app.js"
  if (/^(fix|resolve|correct|repair|troubleshoot)\s+(errors|bugs|issues)\s+(in|for|of)\s+\S+\.\w{1,6}/i.test(trimmed)) {
    return true;
  }

  // Natural language: has fix keyword AND mentions a project file
  if (projectFiles && projectFiles.length > 0) {
    const hasFixAction = FIX_KEYWORDS.some(function(kw) { return lower.indexOf(kw) >= 0; });
    if (hasFixAction) {
      for (let i = 0; i < projectFiles.length; i++) {
        var file = projectFiles[i];
        var fileNameOnly = file.indexOf('/') >= 0 ? file.split('/').pop() : file;
        var nameNoExt = getBaseName(fileNameOnly);
        if (lower.indexOf(file.toLowerCase()) >= 0 ||
            lower.indexOf(fileNameOnly.toLowerCase()) >= 0 ||
            (nameNoExt.length > 1 && lower.indexOf(nameNoExt.toLowerCase()) >= 0)) {
          return true;
        }
      }
    }
  }

  return false;
}

function parseFixCommand(text) {
  const trimmed = text.trim();

  // Format 1: fix filename.ext: optional instruction
  var match = trimmed.match(/^(fix|analyze|debug|resolve|correct|repair|troubleshoot)\s+(\S+\.\w{1,6})\s*(?::\s*(.+))?$/i);
  if (match) {
    return { fileName: match[2].trim(), instruction: match[3] || 'fix all errors and bugs' };
  }

  // Format 2: fix errors in filename.ext
  match = trimmed.match(/^(fix|resolve|correct|repair|troubleshoot)\s+(errors|bugs|issues)\s+(in|for|of)\s+(\S+\.\w{1,6})/i);
  if (match) {
    return { fileName: match[4].trim(), instruction: 'fix all errors and bugs' };
  }

  // Format 3: analyze filename.ext for errors
  match = trimmed.match(/^(analyze)\s+(\S+\.\w{1,6})\s+(for|to find)\s+(errors|bugs|issues)/i);
  if (match) {
    return { fileName: match[2].trim(), instruction: 'analyze and fix all errors and bugs' };
  }

  // Format 4: Natural language fallback — find filename in text
  if (projectFiles && projectFiles.length > 0) {
    var lower = trimmed.toLowerCase();
    for (var i = 0; i < projectFiles.length; i++) {
      var file = projectFiles[i];
      var fileNameOnly = file.indexOf('/') >= 0 ? file.split('/').pop() : file;
      var nameNoExt = getBaseName(fileNameOnly);
      if (lower.indexOf(file.toLowerCase()) >= 0) {
        return { fileName: file, instruction: 'fix all errors and bugs' };
      }
      if (lower.indexOf(fileNameOnly.toLowerCase()) >= 0) {
        return { fileName: fileNameOnly, instruction: 'fix all errors and bugs' };
      }
      if (nameNoExt.length > 1 && lower.indexOf(nameNoExt.toLowerCase()) >= 0) {
        return { fileName: fileNameOnly, instruction: 'fix all errors and bugs' };
      }
    }
  }

  // Last resort: extract any filename.ext from the text
  match = trimmed.match(/\b(\S+\.\w{1,6})\b/);
  if (match) {
    return { fileName: match[1], instruction: 'fix all errors and bugs' };
  }

  return null;
}

function handleFixCommand(parsed) {
  addMsg('\ud83d\udd0d Analyzing **' + parsed.fileName + '** for errors...', 'assistant');
  var requestId = Date.now().toString();
  window.nova.fixFileWithGemini(parsed.fileName, requestId);
}

// ===================== VS Code Handler =====================
function isVsCodeIntent(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /open\s+(folder|project|directory|the).*(vs code|vscode|visual studio)/i,
    /open\s+.*(vs code|vscode|visual studio code)/i,
    /launch\s+.*(vs code|vscode|visual studio)/i,
    /start\s+.*(vs code|vscode|visual studio)/i,
  ];
  return patterns.some(function(p) { return p.test(lower); });
}

function handleVsCodeCommand() {
  addMsg('\ud83d\ude80 Launching VS Code' + (projectPath ? ' with **' + projectPath + '**...' : '...'), 'assistant');
  window.nova.openVsCode().then(function(result) {
    if (result.success) {
      updateLastMsg('\n\u2705 VS Code opened' + (result.folder ? ' with **' + result.folder + '**' : '') + '.');
    } else {
      updateLastMsg('\n\u274c ' + (result.error || 'Failed to open VS Code.'));
    }
  }).catch(function(err) {
    updateLastMsg('\n\u274c ' + (err.message || err));
  });
}

// ===================== File Fix (Analyze & Fix) =====================
if (window.nova?.onFileFixDelta) {
  const cleanup = window.nova.onFileFixDelta(({ content }) => updateLastMsg(content));
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onFileFixEnd) {
  const cleanup = window.nova.onFileFixEnd(({ path: filePath, fileName, size, hadIssues, success }) => {
    if (success) {
      if (hadIssues) {
        addMsg('\u2705 Errors fixed and saved to **' + fileName + '** (' + size + ' bytes)', 'assistant');
      } else {
        addMsg('\u2705 No errors found in **' + fileName + '** — file is clean!', 'assistant');
      }
    }
  });
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onFileFixError) {
  const cleanup = window.nova.onFileFixError(({ error }) => {
    updateLastMsg('\n\n[Error: ' + error + ']');
  });
  cleanupFunctions.push(cleanup);
}

// ===================== File Editor =====================
let projectPath = null;
let projectFiles = []; // list of file paths relative to project root

// Register file edit IPC listeners
if (window.nova?.onFileEditDelta) {
  const cleanup = window.nova.onFileEditDelta(({ content }) => updateLastMsg(content));
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onFileEditEnd) {
  const cleanup = window.nova.onFileEditEnd(({ path: filePath, fileName, size, created, success }) => {
    if (success) {
      const label = created ? '\u2728 File created' : '\u2705 File saved';
      addMsg(label + ': ' + fileName + ' (' + size + ' bytes)', 'assistant');
      // Add the new filename to project files list
      if (created && fileName && !projectFiles.includes(fileName)) {
        projectFiles.push(fileName);
      }
    }
  });
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onFileEditError) {
  const cleanup = window.nova.onFileEditError(({ error }) => {
    updateLastMsg('\n\n[Error: ' + error + ']');
  });
  cleanupFunctions.push(cleanup);
}

// --- File command detection ---
// Matches common file extensions to help detect filenames in natural language
const FILE_EXT_PATTERN = /\.(\w{1,6})\s*$/i;

// List of command keywords that trigger file editing
const EDIT_KEYWORDS = ['edit', 'change', 'modify', 'update', 'write', 'add', 'put', 'create', 'make', 'generate', 'build'];

function isFileEditCommand(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Format 1: keyword filename: instruction (e.g., "edit styles.css: add dark mode")
  // Also accept | and » as colon alternatives
  if (/^(edit|change|modify|update|write|add|put|create|make|generate|build)\s+(.+?)[:»|](.+)$/i.test(trimmed)) {
    return true;
  }

  // Format 2: write|add|put instruction to|in|into filename (e.g., "write a program to a.c.txt")
  // The filename should have a file extension
  if (/(write|add|put|create|make|generate|build)\s+.+\s+(to|in|into)\s+.+\.\w{1,6}\s*$/i.test(trimmed)) {
    return true;
  }

  // Format 3: edit|change|modify|update filename instruction (e.g., "edit styles.css add dark mode")
  // No colon — filename is detected by having a file extension
  if (/(edit|change|modify|update|write|add|put|create|make|generate|build)\s+.+\.\w{1,6}\s+.+/i.test(trimmed)) {
    return true;
  }

  return false;
}

function parseFileEditCommand(text) {
  const trimmed = text.trim();

  // Format 1: keyword filename: instruction (with :, |, or » separator)
  let match = trimmed.match(/^(edit|change|modify|update|write|add|put|create|make|generate|build)\s+(.+?)[:»|](.+)$/i);
  if (match) {
    return { action: 'edit', fileName: match[2].trim(), instruction: match[3].trim() };
  }

  // Format 2: write|add|put instruction to|in|into filename
  // Extract filename as the last word containing a file extension
  match = trimmed.match(/(write|add|put|create|make|generate|build)\s+(.+)\s+(to|in|into)\s+((\S+\.\w{1,6})\s*)$/i);
  if (match) {
    return { action: 'edit', fileName: match[4].trim(), instruction: match[2].trim() };
  }

  // Format 3: edit|change|modify|update filename instruction (no colon)
  // Extract filename as the text ending with a file extension
  match = trimmed.match(/^(edit|change|modify|update|write|add|put|create|make|generate|build)\s+(\S+\.\w{1,6})\s+(.+)$/i);
  if (match) {
    return { action: 'edit', fileName: match[2].trim(), instruction: match[3].trim() };
  }

  return null;
}

// --- Open Folder button (added to suggestions) ---
function openFolderPicker() {
  if (!window.nova?.openFolder) {
    addMsg('File editor not available.', 'assistant');
    return;
  }
  addMsg('Opening folder picker...', 'assistant');
  window.nova.openFolder().then((result) => {
    if (!result) {
      updateLastMsg('\nNo folder selected.');
      return;
    }
    projectPath = result.path;
    // Clear the placeholder
    updateLastMsg('\n');
    addMsg('\ud83d\udcc1 Opened: **' + result.path + '**', 'assistant');
    addMsg('```\n' + result.tree + '```', 'assistant');
    addMsg('You can now say: `edit filename: your instructions`', 'assistant');
    // Store file list for auto-detection
    if (result.files) {
      projectFiles = result.files;
    }
  }).catch((err) => {
    updateLastMsg('\nError: ' + (err.message || err));
  });
}

// Helper: detect if natural language text seems file-related
function getBaseName(name) {
  const parts = name.split('/');
  const file = parts[parts.length - 1] || name;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.substring(0, dot) : file;
}

function looksLikeFileRequest(text, files) {
  const lower = text.toLowerCase();

  // Check if any project filename is mentioned (full path, filename, or name without extension)
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileNameOnly = file.indexOf('/') >= 0 ? file.split('/').pop() : file;
    const nameNoExt = getBaseName(fileNameOnly);
    if (lower.indexOf(file.toLowerCase()) >= 0 ||
        lower.indexOf(fileNameOnly.toLowerCase()) >= 0 ||
        (nameNoExt.length > 1 && lower.indexOf(nameNoExt.toLowerCase()) >= 0)) {
      return true;
    }
  }

  // Check for coding-related keywords (need at least 2 to avoid false positives)
  const codeKeywords = ['write', 'program', 'function', 'code', 'file', 'script',
    'implement', 'create', 'add', 'change', 'update', 'edit', 'build', 'make',
    'class', 'method', 'app', 'project', 'compile', 'run'];
  let matchCount = 0;
  for (let j = 0; j < codeKeywords.length; j++) {
    if (lower.indexOf(codeKeywords[j]) >= 0) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }

  return false;
}

// Intercept file edit commands in sendPrompt
async function sendPromptWithFileEdit() {
  const text = (promptInput?.value || '').trim();
  if (!text || !promptInput) {
    return;
  }

  // Interrupt TTS if currently speaking
  if (speechManager.speaking) {
    speechManager.stop();
  }

  // Check for basic system commands FIRST (notepad, calculator, paint, show desktop, lock computer)
  if (isBasicSystemCommand(text)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    const sysCmd = getSystemCommand(text);
    if (sysCmd) {
      handleSystemCommand(sysCmd);
    } else {
      const requestId = Date.now().toString();
      try { window.nova.ask(text, requestId); } catch (e) {
        updateLastMsg('\\n[Error: ' + (e?.message || e) + ']');
      }
    }
    return;
  }

  // Check for VS Code intent (before file edit or AI)
  if (isVsCodeIntent(text)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    handleVsCodeCommand();
    return;
  }

  // Check for other app/website open intent (YouTube, WhatsApp, Chrome, Spotify)
  if (isAppOpenIntent(text)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    const appInfo = getAppCommand(text);
    if (appInfo) {
      handleAppOpenCommand(appInfo);
    } else {
      // Fallback to normal AI
      const requestId = Date.now().toString();
      try { window.nova.ask(text, requestId); } catch (e) {
        updateLastMsg('\\n[Error: ' + (e?.message || e) + ']');
      }
    }
    return;
  }

  // Check for AI-parsed app/website opening (catch-all — handles anything that starts with "open/launch/start/play")
  // This runs INSTEAD of sending to AI chat, so "open Twitter" actually opens Twitter
  // instead of getting text instructions back. Uses 1 Groq API call.
  if (isAiOpenIntent(text)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    handleAiAppOpen(text);
    return;
  }

  // Check for file fix/analyze intent (fix test.py, analyze app.js, etc.)
  if (projectPath && isFixIntent(text)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    const parsed = parseFixCommand(text);
    if (parsed) {
      handleFixCommand(parsed);
      return;
    }
  }

  // Check if this is a file edit command
  if (isFileEditCommand(text)) {
    if (!projectPath) {
      addMsg(text, 'user');
      promptInput.value = '';
      addMsg('', 'assistant');
      updateLastMsg('Please open a folder first using the **Open Folder** button.');
      return;
    }

    const parsed = parseFileEditCommand(text);
    if (parsed && parsed.action === 'edit') {
      const requestId = Date.now().toString();
      addMsg(text, 'user');
      promptInput.value = '';
      addMsg('', 'assistant');

      window.nova.editFileWithGemini(parsed.fileName, parsed.instruction, requestId);
      return;
    }
  }

  // Natural Language Fallback: detect if text seems file-related without pattern matching
  if (projectPath && projectFiles.length > 0 && looksLikeFileRequest(text, projectFiles)) {
    addMsg(text, 'user');
    promptInput.value = '';
    addMsg('', 'assistant');
    const requestId = Date.now().toString();
    window.nova.naturalLanguageEdit(text, requestId);
    return;
  }

  // Normal send logic
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
    updateLastMsg('\n[Error: ' + (e?.message || e) + ']');
  }
}

// Replace sendPrompt in all event listeners
if (sendBtn) {
  sendBtn.removeEventListener('click', sendPrompt);
  sendBtn.addEventListener('click', sendPromptWithFileEdit);
}
if (promptInput && _keydownHandler) {
  // Remove old handler by reference (now a named function stored in _keydownHandler)
  promptInput.removeEventListener('keydown', _keydownHandler);
  
  _keydownHandler = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPromptWithFileEdit();
    }
  };
  promptInput.addEventListener('keydown', _keydownHandler);
}

// ===================== Open Folder Button =====================
const openFolderBtn = document.getElementById('openFolderBtn');
if (openFolderBtn) {
  openFolderBtn.addEventListener('click', () => {
    // If no project is open, open the picker
    if (!projectPath) {
      openFolderPicker();
    } else {
      // Show current folder path and file tree again
      addMsg('\ud83d\udcc1 Current folder: **' + projectPath + '**', 'assistant');
      addMsg('Say `edit filename: your instruction` to edit a file.', 'assistant');
    }
  });
}

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
    // Use sendPromptWithFileEdit so voice can trigger file edits, NL edits, and VS Code too
    sendPromptWithFileEdit();
  });
}

// ===================== AI App Open Handlers (Hybrid) =====================
if (window.nova?.onAppOpening) {
  const cleanup = window.nova.onAppOpening(({ text: status }) => {
    if (status) updateLastMsg(status);
  });
  cleanupFunctions.push(cleanup);
}

if (window.nova?.onAppOpenError) {
  const cleanup = window.nova.onAppOpenError(({ error }) => {
    // Fall back to normal AI chat if Groq couldn't identify the app
    if (pendingAiAppText) {
      updateLastMsg('\n\n[Could not identify — trying AI chat...]');
      var fallbackId = Date.now().toString();
      try { window.nova.ask(pendingAiAppText, fallbackId); } catch (e) {
        updateLastMsg('\n[Error: ' + (e?.message || e) + ']');
      }
      pendingAiAppText = null;
    } else {
      updateLastMsg('\n\n[Error: ' + error + ']');
    }
  });
  cleanupFunctions.push(cleanup);
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
