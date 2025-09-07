const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

require('dotenv').config();

// --- Gemini (existing) ---
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let win;
let tray;
let pyProcess;
let voiceMuted = false; // when true, ignore transcripts
let lastRequestTime = 0;
const COOLDOWN_MS = 2000; // 2 seconds

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

  // Approve microphone permission requests (Electron)
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'microphone' || permission === 'media') {
      return callback(true);
    }
    callback(false);
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
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

app.whenReady().then(() => {
  createWindow();

  // ---- Python Voice Process (prefer .venv) ----
  const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const pythonExecutable = fs.existsSync(venvPython)
    ? venvPython
    : (process.platform === 'win32' ? 'python.exe' : 'python');

  pyProcess = spawn(pythonExecutable, [path.join(__dirname, 'voice.py')]);

  pyProcess.stdout.on('data', (data) => {
    const text = data.toString();
    // Split into lines to avoid chunks that combine multiple messages (e.g. TRANSCRIPT:: + CMD::)
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const msg = raw.trim();
      if (!msg) continue;
      if (msg.startsWith("TRANSCRIPT::")) {
        const transcript = msg.replace("TRANSCRIPT::", "").trim();
        if (!voiceMuted && win) win.webContents.send('voice:transcript', transcript);
      } else if (msg.startsWith("WAKEWORD::")) {
        const word = msg.replace("WAKEWORD::", "").trim();
        if (win) win.webContents.send('voice:wakeword', word);
      } else {
        console.log("[Python]", msg);
      }
    }
  });

  pyProcess.stderr.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const msg = raw.trim();
      if (!msg) continue;
      console.error("[Python ERR]", msg);
    }
  });

  pyProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);
  });

  const trayIconPath = path.join(__dirname, 'assets', 'tray.png');
  const trayIcon = fs.existsSync(trayIconPath) ? nativeImage.createFromPath(trayIconPath) : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.setToolTip('Aura Assistant');
  tray.on('click', toggleWindow);

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide', click: toggleWindow },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]));

  globalShortcut.register('Alt+Space', toggleWindow);
});

app.on('will-quit', () => {
  if (pyProcess) pyProcess.kill();
  globalShortcut.unregisterAll();
});

// Window control IPC
ipcMain.on('window:close', () => { if (win) win.close(); });
ipcMain.on('window:minimize', () => { if (win) win.minimize(); });

// ---------- Gemini streaming (ai:ask) ----------
ipcMain.on('ai:ask', async (event, { text, requestId }) => {
  if (!text) return;

  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    console.warn("Request throttled due to cooldown.");
    event.sender.send('ai:error', { requestId, error: 'Too many requests. Please wait a moment.' });
    return;
  }
  lastRequestTime = now;

  // Mock mode
  if (process.env.MOCK_MODE === 'true') {
    const fakeResponses = [
      "Sure! Here's what I found.",
      "This is just a mock AI reply for testing.",
      "Imagine this is a real AI response coming from Gemini.",
      "I can answer your question once you connect the real API."
    ];
    for (let i = 0; i < fakeResponses.length; i++) {
      await new Promise(r => setTimeout(r, 450));
      event.sender.send('ai:delta', { requestId, content: fakeResponses[i] + ' ' });
    }
    event.sender.send('ai:end', { requestId });
    return;
  }

  // Real Gemini streaming
  try {
    // Mute voice transcripts while assistant speaks to avoid feedback loop
    voiceMuted = true;
    if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('MUTE\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const chatHistory = [
      {
        role: 'user',
        parts: [{ text: "You are Aura, a helpful desktop assistant. You can open applications like Notepad, Calculator, and Paint. You can also show the desktop and lock the computer. When asked to perform these actions, respond with 'Would you like me to [action]?' For example, if asked to open Notepad, respond with 'Would you like me to open Notepad?'" }]
      },
      {
        role: 'model',
        parts: [{ text: 'Understood. I will respond with the suggested phrasing for system commands.' }]
      },
      {
        role: 'user',
        parts: [{ text: text }] // User's current message
      }
    ];

    const result = await model.generateContent({
      contents: chatHistory
    });

    const response = result.response;
    const stream = response.text(); // Get the streamed text directly

    for await (const chunk of stream) { // Iterate over the streamed text
      if (chunk) event.sender.send('ai:delta', { requestId, content: chunk });
    }

    event.sender.send('ai:end', { requestId }); // This line was missing
    // Unmute after a short delay so TTS finishes
    setTimeout(() => {
      voiceMuted = false;
      if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('UNMUTE\n');
    }, 250);
  } catch (err) {
    console.error('Gemini API Error:', err);
    event.sender.send('ai:error', { requestId, error: err.message || String(err) });
    voiceMuted = false;
  }
});

// Optional: stop AI handler
ipcMain.on('ai:stop', (event, { requestId }) => {
  console.log(`Stopping AI request ${requestId}`);
  event.sender.send('ai:stopped', { requestId });
});

// Summarization handler: creates a short spoken summary from full assistant text
ipcMain.on('ai:summarize', async (event, { text, requestId }) => {
  if (!text) return;

  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    console.warn("Summarize request throttled due to cooldown.");
    // Don't send an error for this, just fail silently or send a fallback
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0,2).join('.') });
    return;
  }
  lastRequestTime = now;

  // Mock summarization
  if (process.env.MOCK_MODE === 'true') {
    const fakeSummary = 'Short summary: ' + (text.split('.').slice(0,2).join('.').slice(0,200) || text.slice(0,120));
    event.sender.send('ai:summary', { requestId, summary: fakeSummary });
    return;
  }

  try {
    const prompt = `Summarize the following assistant response into two concise sentences suitable for speaking aloud:\n\n${text}`;
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContentStream(prompt);
    let collected = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) event.sender.send('ai:delta', { requestId, content: chunkText });
    }
    const summary = collected.trim() || (text.split('.').slice(0,2).join('.')) || text.slice(0,160);
    event.sender.send('ai:summary', { requestId, summary });
  } catch (err) {
    console.error('Summarize Error:', err);
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0,2).join('.') });
  }
});

// Voice control handlers forwarded to Python helper via stdin
ipcMain.on('voice:start', () => {
  if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('START\n');
});
ipcMain.on('voice:stop', () => {
  if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('STOP\n');
});
ipcMain.on('voice:mute', () => {
  voiceMuted = true;
  if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('MUTE\n');
});
ipcMain.on('voice:unmute', () => {
  voiceMuted = false;
  if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('UNMUTE\n');
});

// Generic command handler (MODE::XXX, START, STOP, etc.)
ipcMain.on('voice:command', (_e, cmd) => {
  if (pyProcess && pyProcess.stdin) {
    pyProcess.stdin.write(cmd + '\n');
    console.log('[Electron → Python]', cmd);
  }
});

// System command handler
ipcMain.on('system:command', (event, { command, requestId }) => {
  const COMMAND_WHITELIST = {
    'open notepad': 'start notepad.exe',
    'open calculator': 'start calc.exe',
    'open paint': 'start mspaint.exe',
    'show desktop': 'explorer.exe shell:::{3080F90D-D7AD-11D9-BD98-0000947B0257}',
    'lock computer': 'rundll32.exe user32.dll,LockWorkStation'
  };

  const cmdToExecute = COMMAND_WHITELIST[command.toLowerCase()];

  if (cmdToExecute) {
    console.log(`[System Command] Executing: ${cmdToExecute}`);
    require('child_process').exec(cmdToExecute, (error, stdout, stderr) => {
      if (error) {
        console.error(`[System Command] Error executing ${command}: ${error.message}`);
        event.sender.send('system:command:response', { requestId, success: false, error: error.message });
        return;
      }
      if (stderr) {
        console.warn(`[System Command] Stderr for ${command}: ${stderr}`);
      }
      console.log(`[System Command] Successfully executed: ${command}`);
      event.sender.send('system:command:response', { requestId, success: true, stdout: stdout, stderr: stderr });
    });
  } else {
    console.warn(`[System Command] Attempted to execute unwhitelisted command: ${command}`);
    event.sender.send('system:command:response', { requestId, success: false, error: 'Command not whitelisted.' });
  }
});