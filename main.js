const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, desktopCapturer } = require('electron');
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
    { key: 'GEMINI_API_KEY', name: 'Gemini API Key', url: 'https://aistudio.google.com/' }
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
    console.warn('  Create one with: GEMINI_API_KEY=your_key_here');
  }

  return allValid;
}

const envValid = validateEnv();

// --- Gemini ---
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = envValid ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim()) : null;

let win;
let tray;
let pyProcess;
let voiceMuted = false;
let muteCounter = 0;  // Track nested muting to avoid premature unmute
let lastRequestTime = 0;
const COOLDOWN_MS = 2000;
let lastScreenshot = null;
let geminiChat = null;

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
        error: 'Missing GEMINI_API_KEY. Check your .env file.'
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
    console.warn(`[AI] Duplicate request ID: ${requestId}, ignoring.`);
    return;
  }
  inFlightRequests.add(requestId);

  // Clean up from inFlight after completion
  const cleanup = () => { inFlightRequests.delete(requestId); };

  if (!checkCooldown(event, requestId)) {
    cleanup();
    return;
  }

  if (!genAI) {
    event.sender.send('ai:error', { requestId, error: 'Gemini API not configured. Set GEMINI_API_KEY in .env' });
    cleanup();
    return;
  }

  if (withScreenshot && !lastScreenshot) {
    console.warn("[Electron] Missing screenshot for askWithScreenshot.");
    cleanup();
    return;
  }

  // Mock mode
  if (process.env.MOCK_MODE === 'true') {
    const fakeResponses = withScreenshot
      ? ["Sure! Here's what I found with the screenshot.", "This is a mock AI reply for testing with an image."]
      : ["Sure! Here's what I found.", "This is just a mock AI reply for testing.", "Imagine this is a real AI response coming from Gemini.", "I can answer your question once you connect the real API."];

    for (let i = 0; i < fakeResponses.length; i++) {
      await new Promise(r => setTimeout(r, 450));
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

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // L4: Reset chat if it exceeds max turns
    if (!geminiChat || chatTurnCount >= MAX_CHAT_TURNS) {
      geminiChat = model.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: "You are Nova, a helpful desktop assistant..." }]
          },
          {
            role: 'model',
            parts: [{ text: 'Understood. I will respond with the suggested phrasing for system commands.' }]
          },
        ],
      });
      chatTurnCount = 0;
    }

    const userParts = [{ text }];
    if (withScreenshot && lastScreenshot) {
      userParts.push({ inline_data: { mime_type: 'image/png', data: lastScreenshot } });
      lastScreenshot = null;
    }

    const result = await geminiChat.sendMessageStream(userParts);
    chatTurnCount++;

    for await (const chunk of result.stream) {
      if (chunk) {
        try {
          event.sender.send('ai:delta', { requestId, content: chunk.text() });
        } catch (sendErr) {
          // Renderer may have disconnected
          console.warn('[AI] Failed to send delta, renderer may be gone:', sendErr.message);
          break;
        }
      }
    }

    event.sender.send('ai:end', { requestId });
    setTimeout(() => {
      muteCounter = Math.max(0, muteCounter - 1);
      if (muteCounter === 0) {
        voiceMuted = false;
        if (pyProcess && pyProcess.stdin && !pyProcess.stdin.destroyed) {
          pyProcess.stdin.write('UNMUTE\n');
        }
      }
    }, 250);
  } catch (err) {
    console.error('Gemini API Error:', err);
    event.sender.send('ai:error', { requestId, error: err.message || String(err) });
    voiceMuted = false;
    muteCounter = 0;
    // Send UNMUTE to Python in case we sent MUTE before the error
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

  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0, 2).join('.') });
    return;
  }
  lastRequestTime = now;

  if (process.env.MOCK_MODE === 'true') {
    const fakeSummary = 'Short summary: ' + (text.split('.').slice(0, 2).join('.').slice(0, 200) || text.slice(0, 120));
    event.sender.send('ai:summary', { requestId, summary: fakeSummary });
    return;
  }

  if (!genAI) {
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0, 2).join('.') });
    return;
  }

  try {
    const prompt = `Summarize this:\n\n${text}`;
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContentStream(prompt);
    let collected = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) collected += chunkText;
    }
    const summary = collected.trim() || (text.split('.').slice(0, 2).join('.')) || text.slice(0, 160);
    event.sender.send('ai:summary', { requestId, summary });
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

// --- System Commands (H2: Use spawn/execFile instead of exec) ---
ipcMain.on('system:command', (event, { command, requestId }) => {
  const COMMAND_WHITELIST = {
    'open notepad': { cmd: 'notepad.exe', args: [] },
    'open calculator': { cmd: 'calc.exe', args: [] },
    'open paint': { cmd: 'mspaint.exe', args: [] },
    'show desktop': { cmd: 'explorer.exe', args: ['shell:::{3080F90D-D7AD-11D9-BD98-0000947B0257}'] },
    'lock computer': { cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] }
  };

  const entry = COMMAND_WHITELIST[command.toLowerCase()];

  if (entry) {
    console.log(`[System Command] Executing: ${entry.cmd} ${entry.args.join(' ')}`);
    const child = execFile(entry.cmd, entry.args, (error, stdout, stderr) => {
      if (error) {
        event.sender.send('system:command:response', { requestId, success: false, error: error.message });
        return;
      }
      event.sender.send('system:command:response', { requestId, success: true, stdout, stderr });
    });
    // Ensure child process doesn't keep app alive
    if (child) child.unref();
  } else {
    event.sender.send('system:command:response', { requestId, success: false, error: 'Command not whitelisted.' });
  }
});
