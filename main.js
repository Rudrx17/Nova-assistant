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

  // ---- Python Voice Process (use .venv interpreter) ----
  pyProcess = spawn(
    path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
    [path.join(__dirname, 'voice.py')]
  );

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
  if (pyProcess) pyProcess.kill();
  globalShortcut.unregisterAll();
});

// Window control IPC
ipcMain.on('window:close', () => { if (win) win.close(); });
ipcMain.on('window:minimize', () => { if (win) win.minimize(); });

// ---------- Gemini streaming (ai:ask) ----------
ipcMain.on('ai:ask', async (event, { text, requestId }) => {
  if (!text) return;

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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContentStream(text);
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) event.sender.send('ai:delta', { requestId, content: chunkText });
    }
    event.sender.send('ai:end', { requestId });
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

  // Mock summarization
  if (process.env.MOCK_MODE === 'true') {
    const fakeSummary = 'Short summary: ' + (text.split('.').slice(0,2).join('.').slice(0,200) || text.slice(0,120));
    event.sender.send('ai:summary', { requestId, summary: fakeSummary });
    return;
  }

  try {
    const prompt = `Summarize the following assistant response into two concise sentences suitable for speaking aloud:\n\n${text}`;
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContentStream(prompt);
    let collected = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) collected += chunkText;
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
