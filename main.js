const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

require('dotenv').config();

// ===================== Global Error Handlers =====================
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  // Don't exit — let Electron handle the crash gracefully
});

// ===================== Env Validation =====================
function validateEnv() {
  const requiredVars = [
    { key: 'GROQ_API_KEY', name: 'Groq API Key', url: 'https://console.groq.com/keys' }
  ];

  let allValid = true;
  for (const { key, name, url } of requiredVars) {
    if (!process.env[key] || process.env[key].trim() === '') {
      console.error(`[FATAL] Missing required environment variable: ${key} (${name})`);
      console.error(`  Get it from: ${url}`);
      console.error(`  Then add it to your .env file: ${key}=your_key_here`);
      allValid = false;
    }
  }

  if (!allValid) {
    console.error('[FATAL] Cannot start without required environment variables.');
  }

  // Check .env file exists
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('[WARN] .env file not found at:', envPath);
    console.warn('  Create one with: GROQ_API_KEY=your_key_here');
  }

  return allValid;
}

const envValid = validateEnv();

// --- Groq (OpenAI-compatible) ---
const OpenAI = require('openai');
const groq = envValid ? new OpenAI({ apiKey: process.env.GROQ_API_KEY.trim(), baseURL: 'https://api.groq.com/openai/v1' }) : null;

let win;
let tray;
let pyProcess;
let voiceMuted = false;
let muteCounter = 0;  // Track nested muting to avoid premature unmute
let lastRequestTime = 0;
const COOLDOWN_MS = 2000;
let lastScreenshot = null;
let conversationHistory = [];

// File Editor state
let currentProjectPath = null;

// Chat history management — limit to prevent token overflow
const MAX_CHAT_TURNS = 20;
let chatTurnCount = 0;

// In-flight request tracking (H5: request deduplication)
const inFlightRequests = new Set();

// Python process restart state
let pyRestartCount = 0;
const PY_MAX_RESTARTS = 5;
const PY_RESTART_DELAY_MS = 3000;

// ===================== Window =====================
function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 380,
    minHeight: 560,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      experimentalFeatures: true
    }
  });

  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'microphone' || permission === 'media') {
      return callback(true);
    }
    callback(false);
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Notify renderer about env status
  win.webContents.on('did-finish-load', () => {
    if (!envValid) {
      win.webContents.send('ai:error', {
        requestId: 'startup',
        error: 'Missing GROQ_API_KEY. Check your .env file.'
      });
    }
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    const { bounds } = screen.getPrimaryDisplay();
    const x = Math.max(20, bounds.width - 460);
    const y = 60;
    win.setPosition(x, y);
    win.show();
    win.focus();
  }
}

// ===================== Python Process Management =====================
function startPythonProcess() {
  const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const pythonExecutable = fs.existsSync(venvPython)
    ? venvPython
    : (process.platform === 'win32' ? 'python.exe' : 'python');

  pyProcess = spawn(pythonExecutable, [path.join(__dirname, 'voice.py')], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderrBuffer = '';

  pyProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const msg = raw.trim();
      if (!msg) continue;
      if (msg.startsWith("TRANSCRIPT::")) {
        const transcript = msg.replace("TRANSCRIPT::", "").trim();
        if (!voiceMuted && win) win.webContents.send('voice:transcript', transcript);
      } else if (msg.startsWith("SCREENSHOT::")) {
        lastScreenshot = msg.replace("SCREENSHOT::", "").trim();
        if (win) win.webContents.send('voice:screenshot_taken');
      } else if (msg === "EVENT::WAKE_WORD_DETECTED") {
        if (win) win.webContents.send('voice:wake_word_detected');
      } else if (msg === "EVENT::WAKE_WORD_ABORTED") {
        if (win) win.webContents.send('voice:wake_word_aborted');
      } else if (msg.startsWith("ERROR::")) {
        const errorText = msg.replace("ERROR::", "").trim();
        console.error("[Python ERROR]", errorText);
        if (win) win.webContents.send('ai:error', { requestId: 'voice', error: errorText });
      } else if (msg.startsWith("LEVEL::")) {
        const level = parseFloat(msg.replace("LEVEL::", "").trim());
        if (!isNaN(level) && win) {
          win.webContents.send('voice:audio_level', level);
        }
      } else {
        console.log("[Python]", msg);
      }
    }
  });

  pyProcess.stderr.on('data', (data) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    const lines = chunk.split(/\r?\n/);
    for (const raw of lines) {
      const msg = raw.trim();
      if (!msg) continue;
      console.error("[Python ERR]", msg);
    }
  });

  pyProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);
    if (stderrBuffer) {
      console.error(`[Python STDERR on exit]:\n${stderrBuffer}`);
    }
    pyProcess = null;

    if (code === 0) {
      // Clean exit — reset restart counter
      pyRestartCount = 0;
      return;
    }

    // Auto-restart (H1: crash recovery) with exponential backoff
    if (pyRestartCount < PY_MAX_RESTARTS) {
      pyRestartCount++;
      const delay = PY_RESTART_DELAY_MS * Math.pow(1.5, pyRestartCount - 1);
      console.log(`[Python] Restarting in ${delay}ms (attempt ${pyRestartCount}/${PY_MAX_RESTARTS})...`);
      setTimeout(startPythonProcess, delay);
    } else {
      console.error('[Python] Max restart attempts reached. Giving up.');
      if (win) {
        win.webContents.send('ai:error', {
          requestId: 'voice',
          error: 'Voice system crashed repeatedly. Please restart the app.'
        });
      }
    }
  });

  pyProcess.on('error', (err) => {
    console.error('[Python] Failed to start process:', err.message);
    pyProcess = null;
  });
}

function stopPythonProcess() {
  if (!pyProcess) return;
  try {
    // M6: Graceful shutdown — send quit command first
    if (pyProcess.stdin && !pyProcess.stdin.destroyed) {
      pyProcess.stdin.write('STOP\n');
      pyProcess.stdin.end();
    }
    // Give it a moment, then force kill
    setTimeout(() => {
      if (pyProcess) {
        pyProcess.kill();
        pyProcess = null;
      }
    }, 500);
  } catch (e) {
    console.error('[Python] Error during shutdown:', e.message);
    if (pyProcess) {
      pyProcess.kill();
      pyProcess = null;
    }
  }
}

// ===================== App Lifecycle =====================
app.whenReady().then(() => {
  createWindow();
  startPythonProcess();

  const trayIconPath = path.join(__dirname, 'assets', 'tray.png');
  const trayIcon = fs.existsSync(trayIconPath) ? nativeImage.createFromPath(trayIconPath) : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.setToolTip('Nova Assistant');
  tray.on('click', toggleWindow);

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide', click: toggleWindow },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]));

  globalShortcut.register('Alt+Space', toggleWindow);
});

app.on('will-quit', () => {
  stopPythonProcess();
  globalShortcut.unregisterAll();
});

// Window control IPC
ipcMain.on('window:close', () => { if (win) win.close(); });
ipcMain.on('window:minimize', () => { if (win) win.minimize(); });

// ===================== Cooldown Helper =====================
function checkCooldown(event, requestId) {
  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    console.warn(`Request ${requestId} throttled due to cooldown.`);
    event.sender.send('ai:error', { requestId, error: 'Too many requests. Please wait a moment.' });
    return false;
  }
  lastRequestTime = now;
  return true;
}

// ===================== AI Request Handler =====================
async function handleAIRequest(event, { text, requestId }, withScreenshot) {
  if (!text) return;
  if (!requestId) {
    console.error('[AI] Missing requestId');
    return;
  }

  // H5: Request deduplication
  if (inFlightRequests.has(requestId)) {
    console.warn('[AI] Duplicate request ID: ' + requestId + ', ignoring.');
    return;
  }
  inFlightRequests.add(requestId);

  // Clean up from inFlight after completion
  const cleanup = () => { inFlightRequests.delete(requestId); };

  if (!checkCooldown(event, requestId)) {
    cleanup();
    return;
  }

  if (!groq) {
    event.sender.send('ai:error', { requestId, error: 'Groq API not configured. Set GROQ_API_KEY in .env' });
    cleanup();
    return;
  }

  if (withScreenshot && !lastScreenshot) {
    console.warn('[Electron] Missing screenshot for askWithScreenshot.');
    cleanup();
    return;
  }

  // Mock mode
  if (process.env.MOCK_MODE === 'true') {
    var fakeResponses = withScreenshot
      ? ['Mock: Screenshot received. What would you like to know?', 'Mock: This is a test response.']
      : ['Mock: Sure! Here\'s what I found.', 'Mock: This is a test AI response.', 'Mock: Imagine this is a real response.'];

    for (var i = 0; i < fakeResponses.length; i++) {
      await new Promise(function(r) { setTimeout(r, 450); });
      event.sender.send('ai:delta', { requestId, content: fakeResponses[i] + ' ' });
    }
    event.sender.send('ai:end', { requestId });
    cleanup();
    return;
  }

  try {
    voiceMuted = true;
    muteCounter++;
    if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) {
      pyProcess.stdin.write('MUTE\n');
    }

    // L4: Reset chat if it exceeds max turns
    if (chatTurnCount >= MAX_CHAT_TURNS) {
      conversationHistory = [];
      chatTurnCount = 0;
    }

    // Build messages array
    var messages = [
      { role: 'system', content: 'You are Nova, a helpful desktop assistant. You can help with coding, file edits, system commands, and general questions. Keep responses concise and helpful.' },
    ];

    // Add conversation history
    for (var h = 0; h < conversationHistory.length; h++) {
      messages.push(conversationHistory[h]);
    }

    // Add current user message
    var userContent = text;
    if (withScreenshot) {
      userContent = '[Screenshot taken] ' + text + ' (Note: The current AI model does not support image analysis. Respond based on the text question only.)';
      lastScreenshot = null;
    }
    messages.push({ role: 'user', content: userContent });

    var stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      stream: true,
    });

    var fullResponse = '';
    for await (var chunk of stream) {
      var content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullResponse += content;
        try {
          event.sender.send('ai:delta', { requestId, content: content });
        } catch (sendErr) {
          console.warn('[AI] Failed to send delta:', sendErr.message);
          break;
        }
      }
    }

    // Store in conversation history
    conversationHistory.push({ role: 'user', content: text });
    conversationHistory.push({ role: 'assistant', content: fullResponse });
    chatTurnCount++;

    // Trim history to max turns (prune oldest)
    if (conversationHistory.length > MAX_CHAT_TURNS * 2) {
      conversationHistory = conversationHistory.slice(-MAX_CHAT_TURNS * 2);
    }

    event.sender.send('ai:end', { requestId });
    setTimeout(function() {
      muteCounter = Math.max(0, muteCounter - 1);
      if (muteCounter === 0) {
        voiceMuted = false;
        if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) {
          pyProcess.stdin.write('UNMUTE\n');
        }
      }
    }, 250);
  } catch (err) {
    console.error('Groq API Error:', err);
    event.sender.send('ai:error', { requestId, error: err.message || String(err) });
    voiceMuted = false;
    muteCounter = 0;
    if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) {
      pyProcess.stdin.write('UNMUTE\n');
    }
  } finally {
    cleanup();
  }
}

// ===================== IPC Handlers =====================

// --- AI: Ask ---
ipcMain.on('ai:ask', async (event, { text, requestId }) => {
  await handleAIRequest(event, { text, requestId }, false);
});

// --- AI: Ask with Screenshot ---
ipcMain.on('ai:askWithScreenshot', async (event, { text, requestId }) => {
  console.log(`[Electron] ai:askWithScreenshot received.`);
  await handleAIRequest(event, { text, requestId }, true);
});

// --- AI: Stop ---
ipcMain.on('ai:stop', (event, { requestId }) => {
  console.log(`Stopping AI request ${requestId}`);
  inFlightRequests.delete(requestId);
  event.sender.send('ai:stopped', { requestId });
});

// --- AI: Summarize ---
ipcMain.on('ai:summarize', async (event, { text, requestId }) => {
  if (!text) return;

  var now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0, 2).join('.') });
    return;
  }
  lastRequestTime = now;

  if (process.env.MOCK_MODE === 'true') {
    var fakeSummary = 'Short summary: ' + (text.split('.').slice(0, 2).join('.').slice(0, 200) || text.slice(0, 120));
    event.sender.send('ai:summary', { requestId, summary: fakeSummary });
    return;
  }

  if (!groq) {
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0, 2).join('.') });
    return;
  }

  try {
    var result = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Summarize the following text concisely in 2-3 sentences.' },
        { role: 'user', content: text }
      ],
      stream: false,
    });
    var summary = (result.choices[0]?.message?.content || '').trim();
    if (!summary) {
      summary = text.split('.').slice(0, 2).join('.') || text.slice(0, 160);
    }
    event.sender.send('ai:summary', { requestId, summary: summary });
  } catch (err) {
    console.error('Summarize Error:', err);
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0, 2).join('.') });
  }
});

// --- Voice Controls ---
ipcMain.on('voice:start', () => {
  if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) pyProcess.stdin.write('START\n');
});
ipcMain.on('voice:stop', () => {
  if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) pyProcess.stdin.write('STOP\n');
});
ipcMain.on('voice:mute', () => {
  voiceMuted = true;
  if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) pyProcess.stdin.write('MUTE\n');
});
ipcMain.on('voice:unmute', () => {
  voiceMuted = false;
  if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) pyProcess.stdin.write('UNMUTE\n');
});

// --- Generic Command Handler (READ_SCREEN, etc.) ---
ipcMain.on('voice:command', async (_e, cmd) => {
  if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) {
    pyProcess.stdin.write(cmd + '\n');
    console.log('[Electron \u2192 Python]', cmd);
  }

  if (cmd === "READ_SCREEN") {
    console.log("[Electron] Attempting screen capture...");
    try {
      const timeoutMs = 10000;
      let timeoutHandle;

      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("desktopCapturer.getSources() timed out.")), timeoutMs);
      });

      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.size;

      const sourcesPromise = desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      });

      const sources = await Promise.race([sourcesPromise, timeoutPromise]);

      // C3: Clean up the timeout (won't reject after clearTimeout)
      clearTimeout(timeoutHandle);

      console.log("[Electron] desktopCapturer.getSources() returned.");

      const primaryScreenSource = sources.find(
        source => source.display_id === String(primaryDisplay.id)
      );

      if (primaryScreenSource) {
        console.log("[Electron] Primary screen source found. Capturing thumbnail...");
        const thumbnail = primaryScreenSource.thumbnail.toPNG();
        console.log("[Electron] Thumbnail captured. Converting to base64...");
        lastScreenshot = thumbnail.toString('base64');
        console.log(`[Electron] lastScreenshot set. Length: ${lastScreenshot.length}`);

        // H4: Clear any stale signal before writing a fresh one
        const signalFilePath = path.join(app.getPath('temp'), 'nova_screenshot_ready.json');
        if (fs.existsSync(signalFilePath)) {
          fs.unlinkSync(signalFilePath);
        }
        fs.writeFileSync(signalFilePath, JSON.stringify({ ready: true }));
        console.log("[Electron] Signal file written.");
      } else {
        console.error("[Electron] Primary screen source not found.");
      }
    } catch (error) {
      console.error("[Electron] Error capturing screen:", error);
      if (win) {
        win.webContents.send('ai:error', { requestId: 'screenshot', error: `Screen capture failed: ${error.message}` });
      }
    }
  }
});

// --- Screenshot Signaling ---
ipcMain.handle('voice:check_screenshot_signal', () => {
  const signalFilePath = path.join(app.getPath('temp'), 'nova_screenshot_ready.json');
  return fs.existsSync(signalFilePath);
});

ipcMain.on('voice:clear_screenshot_signal', () => {
  const signalFilePath = path.join(app.getPath('temp'), 'nova_screenshot_ready.json');
  if (fs.existsSync(signalFilePath)) {
    fs.unlinkSync(signalFilePath);
    console.log("[Electron] Screenshot signal file cleared.");
  }
});

// ===================== File Editor (Direct Gemini Calls) =====================

// Recursively build a file tree string from a directory
function buildFileTree(dirPath, prefix = '') {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let result = '';
  for (const entry of entries) {
    // Skip hidden files/folders and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '__pycache__') continue;
    if (entry.isDirectory()) {
      result += `${prefix}${entry.name}/\n`;
      try {
        result += buildFileTree(path.join(dirPath, entry.name), prefix + '  ');
      } catch (e) {
        result += `${prefix}  [error: ${e.message}]\n`;
      }
    } else {
      const stats = fs.statSync(path.join(dirPath, entry.name));
      const kb = (stats.size / 1024).toFixed(1);
      result += `${prefix}${entry.name} (${kb}KB)\n`;
    }
  }
  return result;
}

// --- FILE: Open Folder ---
ipcMain.handle('file:open_folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select a project folder'
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  currentProjectPath = result.filePaths[0];
  console.log(`[FileEditor] Opened folder: ${currentProjectPath}`);

  try {
    const tree = buildFileTree(currentProjectPath);
    // Also return a flat list of all file paths (relative to project root)
    const files = [];
    function collectFiles(dirPath, relPrefix) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '__pycache__') continue;
        const relPath = relPrefix ? relPrefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          collectFiles(path.join(dirPath, entry.name), relPath);
        } else {
          files.push(relPath);
        }
      }
    }
    collectFiles(currentProjectPath, '');
    return { path: currentProjectPath, tree, files };
  } catch (err) {
    console.error('[FileEditor] Error reading folder:', err.message);
    return { path: currentProjectPath, tree: `Error: ${err.message}`, files: [] };
  }
});

// --- FILE: Read file content ---
ipcMain.handle('file:read', async (_event, filePath) => {
  try {
    // Resolve relative paths against currentProjectPath
    const basePath = currentProjectPath || '';
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);
    // Path traversal protection: ensure resolved path is inside the project folder
    const absolutePath = path.resolve(basePath, resolvedPath);
    if (currentProjectPath && !absolutePath.startsWith(path.resolve(currentProjectPath))) {
      return { error: 'Access denied: file is outside the project folder.' };
    }
    if (!fs.existsSync(resolvedPath)) {
      return { error: `File not found: ${filePath}` };
    }
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return { content, path: resolvedPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- FILE: Natural Language Edit (no regex parsing needed) ---
ipcMain.on('file:nl_edit', async (event, { text, requestId }) => {
  if (!groq) {
    event.sender.send('file:edit:error', { requestId, error: 'Groq API not configured.' });
    return;
  }

  if (inFlightRequests.has(requestId)) {
    console.warn('[FileNL] Duplicate request: ' + requestId);
    return;
  }
  inFlightRequests.add(requestId);
  var cleanup = function() { inFlightRequests.delete(requestId); };

  try {
    // Get list of files in the project
    var files = [];
    function collect(dir, prefix) {
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.venv' || e.name === '__pycache__') continue;
        var r = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) { collect(path.join(dir, e.name), r); }
        else { files.push(r); }
      }
    }
    if (currentProjectPath) collect(currentProjectPath, '');

    event.sender.send('file:edit:delta', { requestId, content: '\ud83e\udde0 Understanding your request...\n\n' });

    var targetFile = null;

    if (files.length === 1) {
      targetFile = files[0];
    } else if (files.length > 1) {
      var list = files.map(function(f, i) { return (i + 1) + '. ' + f; }).join('\n');
      var pickPrompt = 'Given these files in the project:\n' + list + '\n\nThe user said: "' + text + '"\n\nWhich file should be edited or created? If creating new, suggest a filename. Reply with ONLY the filename. No explanation.';
      var pickResult = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: pickPrompt }],
        stream: false,
      });
      var picked = (pickResult.choices[0]?.message?.content || '').trim();
      if (files.indexOf(picked) >= 0 || picked.indexOf('.') >= 0 || picked.indexOf('/') >= 0) {
        targetFile = picked;
      }
    }

    // Fallback: look for a filename directly in the user's text
    if (!targetFile) {
      var match = text.match(/\b(\S+\.\w{1,6})\b/);
      if (match) targetFile = match[1];
    }

    if (!targetFile) {
      event.sender.send('file:edit:delta', { requestId, content: '\n\nI could not determine which file to edit. Please mention the filename in your request.' });
      event.sender.send('file:edit:end', { requestId, success: false });
      cleanup();
      return;
    }

    // Resolve and edit the file
    var basePath = currentProjectPath || '';
    var resolvedPath = path.isAbsolute(targetFile) ? targetFile : path.join(basePath, targetFile);
    var absolutePath = path.resolve(basePath, resolvedPath);
    if (currentProjectPath && !absolutePath.startsWith(path.resolve(currentProjectPath))) {
      event.sender.send('file:edit:error', { requestId, error: 'Access denied.' });
      cleanup();
      return;
    }

    var ext = path.extname(resolvedPath).slice(1);
    var fileName = path.basename(resolvedPath);
    var isNewFile = !fs.existsSync(resolvedPath);

    var fileContent = '';
    if (isNewFile) {
      event.sender.send('file:edit:delta', { requestId, content: '\u2728 Creating new file **' + targetFile + '**...\n\n' });
    } else {
      fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      event.sender.send('file:edit:delta', { requestId, content: '\ud83d\udcdd Editing **' + fileName + '**...\n\n' });
    }

    var currentLabel = isNewFile ? '(new file - no content yet)' : '';
    var availableFiles = files.map(function(f) { return '- ' + f; }).join('\n');
    var prompt = 'You are a code editor. Given a file ' + (isNewFile ? 'to create' : '') + ' and an instruction, return ONLY the complete new file content. Do not include any explanations, markdown code blocks, or extra text - just the raw file content.\n\nFile: ' + fileName + '\nExtension: .' + ext + '\nAvailable project files:\n' + availableFiles + '\n' + (currentLabel ? 'Status: ' + currentLabel : 'Current content:\n```\n' + fileContent + '\n```') + '\n\nUser request: ' + text + '\n\nNew content:';

    var stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    var newContent = '';
    for await (var chunk of stream) {
      var t = chunk.choices[0]?.delta?.content || '';
      if (t) {
        newContent += t;
        try { event.sender.send('file:edit:delta', { requestId, content: t }); }
        catch (sendErr) { console.warn('[FileNL] Send failed:', sendErr.message); break; }
      }
    }

    newContent = newContent.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

    var dirPath = path.dirname(resolvedPath);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    fs.writeFileSync(resolvedPath, newContent, 'utf-8');
    console.log('[FileNL] Written ' + newContent.length + ' bytes to ' + fileName + (isNewFile ? ' (created)' : ''));

    event.sender.send('file:edit:end', {
      requestId: requestId, path: resolvedPath, fileName: fileName,
      size: newContent.length, created: isNewFile, success: true
    });
  } catch (err) {
    console.error('[FileNL] Error:', err);
    event.sender.send('file:edit:error', { requestId, error: err.message || String(err) });
  } finally {
    cleanup();
  }
});

// --- FILE: Analyze & Fix file (find errors, fix them, save) ---
ipcMain.on('file:fix', async (event, { fileName, requestId }) => {
  if (!groq) {
    event.sender.send('file:fix:error', { requestId, error: 'Groq API not configured.' });
    return;
  }

  // H5: Request deduplication
  if (inFlightRequests.has(requestId)) {
    console.warn('[FileFix] Duplicate request: ' + requestId);
    return;
  }
  inFlightRequests.add(requestId);
  var cleanup = function() { inFlightRequests.delete(requestId); };

  if (!checkCooldown(event, requestId)) {
    cleanup();
    return;
  }

  try {
    // Resolve file path
    var basePath = currentProjectPath || '';
    var resolvedPath = path.isAbsolute(fileName) ? fileName : path.join(basePath, fileName);
    var absolutePath = path.resolve(basePath, resolvedPath);
    if (currentProjectPath && !absolutePath.startsWith(path.resolve(currentProjectPath))) {
      event.sender.send('file:fix:error', { requestId, error: 'Access denied: file is outside the project folder.' });
      cleanup();
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      event.sender.send('file:fix:error', { requestId, error: 'File not found: ' + fileName });
      cleanup();
      return;
    }

    var fileContent = fs.readFileSync(resolvedPath, 'utf-8');
    var ext = path.extname(resolvedPath).slice(1);
    var fileBaseName = path.basename(resolvedPath);

    event.sender.send('file:fix:delta', { requestId, content: '\ud83d\udd0d Analyzing **' + fileBaseName + '** for errors...\n\n' });

    var prompt = 'You are a code reviewer and fixer. I will give you a file with code. Your job:\n\n' +
      '1. **Find all errors, bugs, and issues** in the code (syntax errors, logical errors, runtime errors, security issues, etc.)\n' +
      '2. **Explain each issue** clearly — what line, what\'s wrong, and how to fix it\n' +
      '3. **Return the COMPLETE corrected code** at the end in a markdown code block\n\n' +
      'Format your response EXACTLY like this:\n' +
      '---\n' +
      '### Issues Found\n' +
      '- **[Line X]** Description of error...\n' +
      '- **[Line Y]** Description of error...\n' +
      '\n' +
      '### Fixed Code\n' +
      '```\n' +
      '[COMPLETE FIXED FILE CONTENT HERE]\n' +
      '```\n' +
      '---\n\n' +
      'File: ' + fileBaseName + '\n' +
      'Extension: .' + ext + '\n' +
      'Current content:\n```\n' + fileContent + '\n```\n' +
      '\nIf no errors are found, explain that and return the original code unchanged.';

    var stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    var fullResponse = '';
    for await (var chunk of stream) {
      var t = chunk.choices[0]?.delta?.content || '';
      if (t) {
        fullResponse += t;
        try { event.sender.send('file:fix:delta', { requestId, content: t }); }
        catch (sendErr) { console.warn('[FileFix] Send failed:', sendErr.message); break; }
      }
    }

    // Extract the fixed code from the last code block
    var fixedContent = null;
    var codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
    var match;
    var lastMatch = null;
    while ((match = codeBlockRegex.exec(fullResponse)) !== null) {
      lastMatch = match[1].trim();
    }
    if (lastMatch) {
      fixedContent = lastMatch;
    }

    if (fixedContent && fixedContent !== fileContent.trim()) {
      var dirPath = path.dirname(resolvedPath);
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(resolvedPath, fixedContent, 'utf-8');
      console.log('[FileFix] Fixed and saved ' + fileBaseName + ' (' + fixedContent.length + ' bytes)');

      event.sender.send('file:fix:end', {
        requestId: requestId, path: resolvedPath, fileName: fileBaseName,
        size: fixedContent.length, hadIssues: true, success: true
      });
    } else if (fixedContent && fixedContent === fileContent.trim()) {
      event.sender.send('file:fix:end', {
        requestId: requestId, path: resolvedPath, fileName: fileBaseName,
        size: fixedContent.length, hadIssues: false, success: true
      });
    } else {
      event.sender.send('file:fix:delta', { requestId, content: '\n\n[Note: Could not extract code block. Saving original file unchanged.]' });
      event.sender.send('file:fix:end', {
        requestId: requestId, path: resolvedPath, fileName: fileBaseName,
        size: fileContent.length, hadIssues: false, success: true
      });
    }
  } catch (err) {
    console.error('[FileFix] Error:', err);
    event.sender.send('file:fix:error', { requestId, error: err.message || String(err) });
  } finally {
    cleanup();
  }
});

// --- FILE: Edit file via Direct Gemini Call ---
ipcMain.on('file:edit', async (event, { path: filePath, instruction, requestId }) => {
  if (!groq) {
    event.sender.send('file:edit:error', { requestId, error: 'Groq API not configured.' });
    return;
  }

  // H5: Request deduplication
  if (inFlightRequests.has(requestId)) {
    console.warn('[FileEdit] Duplicate request: ' + requestId);
    return;
  }
  inFlightRequests.add(requestId);
  var cleanup = function() { inFlightRequests.delete(requestId); };

  if (!checkCooldown(event, requestId)) {
    cleanup();
    return;
  }

  try {
    // Resolve file path
    var basePath = currentProjectPath || '';
    var resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);
    var absolutePath = path.resolve(basePath, resolvedPath);
    if (currentProjectPath && !absolutePath.startsWith(path.resolve(currentProjectPath))) {
      event.sender.send('file:edit:error', { requestId, error: 'Access denied: file is outside the project folder.' });
      cleanup();
      return;
    }

    var ext = path.extname(resolvedPath).slice(1);
    var fileName = path.basename(resolvedPath);
    var isNewFile = !fs.existsSync(resolvedPath);

    var fileContent = '';
    if (isNewFile) {
      event.sender.send('file:edit:delta', { requestId, content: '📝 Creating new file **' + fileName + '**...\n\n' });
    } else {
      fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      event.sender.send('file:edit:delta', { requestId, content: '📝 Editing **' + fileName + '**...\n\n' });
    }

    var currentLabel = isNewFile ? '(new file — no content yet)' : '';
    var prompt = 'You are a code editor. Given a file' + (isNewFile ? ' to create' : '') + ' and an instruction, return ONLY the complete new file content. Do not include any explanations, markdown code blocks, or extra text — just the raw file content.\n\nFile: ' + fileName + '\nExtension: .' + ext + '\n' + (currentLabel ? 'Status: ' + currentLabel : 'Current content:\n```\n' + fileContent + '\n```') + '\n\nInstruction: ' + instruction + '\n\nNew content:';

    var stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    var newContent = '';
    for await (var chunk of stream) {
      var content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        newContent += content;
        try {
          event.sender.send('file:edit:delta', { requestId, content: content });
        } catch (sendErr) {
          console.warn('[FileEdit] Failed to send delta:', sendErr.message);
          break;
        }
      }
    }

    newContent = newContent.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

    var dirPath = path.dirname(resolvedPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf-8');
    console.log('[FileEdit] Written ' + newContent.length + ' bytes to ' + fileName + (isNewFile ? ' (created)' : ''));

    event.sender.send('file:edit:end', {
      requestId: requestId,
      path: resolvedPath,
      fileName: fileName,
      size: newContent.length,
      created: isNewFile,
      success: true
    });
  } catch (err) {
    console.error('[FileEdit] Error:', err);
    event.sender.send('file:edit:error', { requestId, error: err.message || String(err) });
  } finally {
    cleanup();
  }
});

// --- AI-Parsed App/Website Opening (Hybrid) ---
// Uses Groq to determine what app or website to open, then executes it
ipcMain.on('app:open_with_ai', async (event, { text, requestId }) => {
  if (!groq) {
    event.sender.send('app:open_error', { requestId, error: 'Groq API not configured.' });
    return;
  }

  if (inFlightRequests.has(requestId)) {
    console.warn('[AppOpen] Duplicate request: ' + requestId);
    return;
  }
  inFlightRequests.add(requestId);
  var cleanup = function () { inFlightRequests.delete(requestId); };

  if (!checkCooldown(event, requestId)) {
    cleanup();
    return;
  }

  event.sender.send('app:opening', { requestId, text: '\ud83d\udd0d Identifying...' });

  try {
    var result = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You identify what app or website a user wants to open. Respond ONLY with a valid JSON object, no markdown, no explanation, no code block.\n\nPossible types:\n- "url": a website — provide the full URL\n- "app": a desktop application — provide the exe name and a fallback URL\n- "settings": a Windows settings URI — provide the URI path\n- "unknown": cannot determine what to open\n\nExamples:\nUser: "open twitter"\n{"type":"url","name":"Twitter","url":"https://twitter.com"}\n\nUser: "open telegram"\n{"type":"app","name":"Telegram","exe":"Telegram.exe","fallbackUrl":"https://web.telegram.org"}\n\nUser: "open discord"\n{"type":"app","name":"Discord","exe":"Discord.exe","fallbackUrl":"https://discord.com/app"}\n\nUser: "open gmail"\n{"type":"url","name":"Gmail","url":"https://mail.google.com"}\n\nUser: "open reddit"\n{"type":"url","name":"Reddit","url":"https://reddit.com"}\n\nUser: "play lofi music"\n{"type":"url","name":"YouTube lofi","url":"https://www.youtube.com/results?search_query=lofi+music"}\n\nUser: "open settings"\n{"type":"settings","name":"Settings","uri":"ms-settings:"}\n\nUser: "open calculator"\n{"type":"app","name":"Calculator","exe":"calc.exe","fallbackUrl":"https://www.google.com/search?q=calculator"}\n\nIf you are not sure: {"type":"unknown","name":"","error":"Could not determine what to open"}'
        },
        { role: 'user', content: text }
      ],
      stream: false,
    });

    var rawContent = (result.choices[0]?.message?.content || '').trim();
    // Remove any accidental markdown code block wrappers
    rawContent = rawContent.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    var parsed = JSON.parse(rawContent);

    if (parsed.type === 'url' && parsed.url) {
      event.sender.send('app:opening', { requestId, text: '\ud83c\udf10 Opening **' + (parsed.name || 'website') + '** in browser...' });
      openUrl(parsed.url, event, requestId);
    } else if (parsed.type === 'app' && parsed.exe) {
      event.sender.send('app:opening', { requestId, text: '\ud83d\ude80 Opening **' + (parsed.name || 'app') + '**...' });
      openAppWithFallback(parsed.name || parsed.exe, parsed.exe, parsed.fallbackUrl || '', event, requestId);
    } else if (parsed.type === 'settings' && parsed.uri) {
      event.sender.send('app:opening', { requestId, text: '\u2699\uFE0F Opening **' + (parsed.name || 'Settings') + '**...' });
      execFile('cmd.exe', ['/c', 'start', '', parsed.uri], { shell: true }, function (error) {
        if (error) {
          event.sender.send('system:command:response', { requestId, success: false, error: error.message });
          return;
        }
        event.sender.send('system:command:response', { requestId, success: true, stdout: 'Opened ' + (parsed.name || parsed.uri) });
      });
    } else {
      // Unknown — fall back to normal AI chat
      event.sender.send('app:open_error', { requestId, error: parsed.error || 'Could not identify app/website' });
    }
  } catch (err) {
    console.error('[AppOpen] Error:', err);
    event.sender.send('app:open_error', { requestId, error: err.message || String(err) });
  } finally {
    cleanup();
  }
});

// --- VS Code path detection ---
function findVsCodePath() {
  // Common install paths for VS Code on Windows
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft VS Code', 'Code.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'code.cmd'; // fallback — rely on PATH
}

// --- URL opener (uses default browser on Windows) ---
function openUrl(url, event, requestId) {
  const child = execFile('cmd.exe', ['/c', 'start', '', url], { shell: true }, (error) => {
    if (error) {
      console.error('[System] Failed to open URL ' + url + ': ' + error.message);
      event.sender.send('system:command:response', { requestId, success: false, error: error.message });
      return;
    }
    event.sender.send('system:command:response', { requestId, success: true, stdout: 'Opened ' + url });
  });
  if (child) child.unref();
}

// --- Try launching an app; if not found, open URL fallback ---
function openAppWithFallback(appName, exeName, fallbackUrl, event, requestId) {
  const child = execFile(exeName, [], { shell: true }, (error) => {
    if (error) {
      console.log('[System] ' + appName + ' not found (' + error.message + '), opening web version...');
      openUrl(fallbackUrl, event, requestId);
    } else {
      event.sender.send('system:command:response', { requestId, success: true, stdout: 'Opened ' + appName });
    }
  });
  if (child) child.unref();
}

// --- System Commands (H2: Use spawn/execFile instead of exec) ---
const COMMAND_WHITELIST = {
  'open notepad': { type: 'exe', cmd: 'notepad.exe', args: [] },
  'open calculator': { type: 'exe', cmd: 'calc.exe', args: [] },
  'open paint': { type: 'exe', cmd: 'mspaint.exe', args: [] },
  'show desktop': { type: 'exe', cmd: 'explorer.exe', args: ['shell:::{3080F90D-D7AD-11D9-BD98-0000947B0257}'] },
  'lock computer': { type: 'exe', cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  
  // Always open in browser
  'open youtube': { type: 'url', url: 'https://youtube.com' },
  'play youtube': { type: 'url', url: 'https://youtube.com' },
  
  // Apps with desktop app + web fallback
  'open whatsapp': { type: 'app', exe: 'WhatsApp.exe', url: 'https://web.whatsapp.com' },
  'open chrome': { type: 'exe', cmd: 'chrome.exe', args: [] },
  'open spotify': { type: 'app', exe: 'Spotify.exe', url: 'https://open.spotify.com' },
  'play spotify': { type: 'app', exe: 'Spotify.exe', url: 'https://open.spotify.com' },
};

ipcMain.on('system:command', (event, { command, requestId }) => {
  const cmdLower = command.toLowerCase();

  // Check for VS Code commands first
  if (cmdLower.includes('vs code') || cmdLower.includes('vscode') || cmdLower.includes('visual studio')) {
    openVsCode(event, requestId);
    return;
  }

  const entry = COMMAND_WHITELIST[cmdLower];

  if (!entry) {
    event.sender.send('system:command:response', { requestId, success: false, error: 'Command not whitelisted.' });
    return;
  }

  const type = entry.type || 'exe';

  if (type === 'url') {
    openUrl(entry.url, event, requestId);
  } else if (type === 'app') {
    openAppWithFallback(cmdLower, entry.exe, entry.url, event, requestId);
  } else {
    // exe — original behavior
    console.log('[System Command] Executing: ' + entry.cmd + ' ' + (entry.args || []).join(' '));
    const child = execFile(entry.cmd, entry.args || [], (error, stdout, stderr) => {
      if (error) {
        event.sender.send('system:command:response', { requestId, success: false, error: error.message });
        return;
      }
      event.sender.send('system:command:response', { requestId, success: true, stdout, stderr });
    });
    if (child) child.unref();
  }
});

// --- Open VS Code with current project folder ---
ipcMain.handle('system:open_vscode', async () => {
  return new Promise((resolve) => {
    const folderPath = currentProjectPath || '';
    const vscodePath = findVsCodePath();
    console.log('[VS Code] Opening folder: "' + folderPath + '" with ' + vscodePath);
    const args = folderPath ? [folderPath] : [];
    
    if (fs.existsSync(vscodePath)) {
      const child = execFile(vscodePath, args, (error) => {
        if (error) {
          console.error('[VS Code] Error launching: ' + error.message);
          resolve({ success: false, error: error.message });
          return;
        }
        resolve({ success: true, folder: folderPath });
      });
      if (child) child.unref();
    } else {
      // Try via PATH
      const child = execFile('code.cmd', args, { shell: true }, (error) => {
        if (error) {
          console.error('[VS Code] Error launching via PATH: ' + error.message);
          resolve({ success: false, error: 'VS Code not found. Install VS Code or add it to PATH.' });
          return;
        }
        resolve({ success: true, folder: folderPath });
      });
      if (child) child.unref();
    }
  });
});

function openVsCode(event, requestId) {
  const folderPath = currentProjectPath || '';
  const vscodePath = findVsCodePath();
  
  const notify = (success, msg) => {
    if (success) {
      event.sender.send('system:command:response', { requestId, success: true, stdout: 'VS Code opened' + (folderPath ? ' with ' + folderPath : '') });
    } else {
      event.sender.send('system:command:response', { requestId, success: false, error: msg });
    }
  };

  const args = folderPath ? [folderPath] : [];
  
  if (fs.existsSync(vscodePath)) {
    const child = execFile(vscodePath, args, (error) => {
      if (error) notify(false, error.message);
      else notify(true, '');
    });
    if (child) child.unref();
  } else {
    const child = execFile('code.cmd', args, { shell: true }, (error) => {
      if (error) notify(false, 'VS Code not found. Install VS Code or add it to PATH.');
      else notify(true, '');
    });
    if (child) child.unref();
  }
}
