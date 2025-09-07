const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, desktopCapturer } = require('electron');
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
let lastScreenshot = null;
let geminiChat = null;

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
      } else if (msg.startsWith("SCREENSHOT::")) {
        lastScreenshot = msg.replace("SCREENSHOT::", "").trim();
        if (win) win.webContents.send('voice:screenshot_taken');
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

  try {
    voiceMuted = true;
    if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('MUTE\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    if (!geminiChat) {
      geminiChat = model.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: "You are Aura, a helpful desktop assistant..." }]
          },
          {
            role: 'model',
            parts: [{ text: 'Understood. I will respond with the suggested phrasing for system commands.' }]
          },
        ],
      });
    }

    const userParts = [{ text }];
    if (lastScreenshot) {
      userParts.push({ inline_data: { mime_type: 'image/png', data: lastScreenshot } });
      lastScreenshot = null;
    }

    const result = await geminiChat.sendMessageStream(userParts);

    for await (const chunk of result.stream) {
      if (chunk) event.sender.send('ai:delta', { requestId, content: chunk.text() });
    }

    event.sender.send('ai:end', { requestId });
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

// Summarization handler
ipcMain.on('ai:summarize', async (event, { text, requestId }) => {
  if (!text) return;

  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    event.sender.send('ai:summary', { requestId, summary: text.split('.').slice(0,2).join('.') });
    return;
  }
  lastRequestTime = now;

  if (process.env.MOCK_MODE === 'true') {
    const fakeSummary = 'Short summary: ' + (text.split('.').slice(0,2).join('.').slice(0,200) || text.slice(0,120));
    event.sender.send('ai:summary', { requestId, summary: fakeSummary });
    return;
  }

  try {
    const prompt = `Summarize this:\n\n${text}`;
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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

// ---------- Gemini streaming (ai:askWithScreenshot) ----------
ipcMain.on('ai:askWithScreenshot', async (event, { text, requestId }) => {
  console.log(`[Electron] ai:askWithScreenshot received.`);
  if (!text || !lastScreenshot) {
    console.warn("[Electron] Missing text or screenshot.");
    return;
  }

  const now = Date.now();
  if (now - lastRequestTime < COOLDOWN_MS) {
    event.sender.send('ai:error', { requestId, error: 'Too many requests. Please wait a moment.' });
    return;
  }
  lastRequestTime = now;

  if (process.env.MOCK_MODE === 'true') {
    const fakeResponses = [
      "Sure! Here's what I found with the screenshot.",
      "This is a mock AI reply for testing with an image."
    ];
    for (let i = 0; i < fakeResponses.length; i++) {
      await new Promise(r => setTimeout(r, 450));
      event.sender.send('ai:delta', { requestId, content: fakeResponses[i] + ' ' });
    }
    event.sender.send('ai:end', { requestId });
    return;
  }

  try {
    voiceMuted = true;
    if (pyProcess && pyProcess.stdin) pyProcess.stdin.write('MUTE\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    if (!geminiChat) {
      geminiChat = model.startChat({ history: [] });
    }

    const userParts = [
      { text },
      { inline_data: { mime_type: 'image/png', data: lastScreenshot } }
    ];
    lastScreenshot = null;

    const result = await geminiChat.sendMessageStream(userParts);

    for await (const chunk of result.stream) {
      if (chunk) event.sender.send('ai:delta', { requestId, content: chunk.text() });
    }

    event.sender.send('ai:end', { requestId });
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

// Voice control handlers
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

// Generic command handler (READ_SCREEN fixed for high resolution)
ipcMain.on('voice:command', async (_e, cmd) => {
  if (pyProcess && pyProcess.stdin) {
    pyProcess.stdin.write(cmd + '\n');
    console.log('[Electron → Python]', cmd);
  }

  if (cmd === "READ_SCREEN") {
    console.log("[Electron] Attempting screen capture...");
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("desktopCapturer.getSources() timed out.")), 10000)
      );

      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.size;

      const sourcesPromise = desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }  // 🔥 full resolution
      });

      const sources = await Promise.race([sourcesPromise, timeoutPromise]);

      console.log("[Electron] desktopCapturer.getSources() returned.");

      const primaryScreenSource = sources.find(
        source => source.display_id === String(primaryDisplay.id)
      );

      if (primaryScreenSource) {
        console.log("[Electron] Primary screen source found. Capturing thumbnail...");
        const thumbnail = primaryScreenSource.thumbnail.toPNG(); // full res
        console.log("[Electron] Thumbnail captured. Converting to base64...");
        lastScreenshot = thumbnail.toString('base64');
        console.log(`[Electron] lastScreenshot set. Length: ${lastScreenshot.length}`);
        fs.writeFileSync(
          path.join(app.getPath('temp'), 'aura_screenshot_ready.json'),
          JSON.stringify({ ready: true })
        );
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

// Notify renderer that screenshot has been taken (via file polling)
ipcMain.handle('voice:check_screenshot_signal', () => {
  const signalFilePath = path.join(app.getPath('temp'), 'aura_screenshot_ready.json');
  return fs.existsSync(signalFilePath);
});

ipcMain.on('voice:clear_screenshot_signal', () => {
  const signalFilePath = path.join(app.getPath('temp'), 'aura_screenshot_ready.json');
  if (fs.existsSync(signalFilePath)) {
    fs.unlinkSync(signalFilePath);
    console.log("[Electron] Screenshot signal file cleared.");
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
        event.sender.send('system:command:response', { requestId, success: false, error: error.message });
        return;
      }
      event.sender.send('system:command:response', { requestId, success: true, stdout, stderr });
    });
  } else {
    event.sender.send('system:command:response', { requestId, success: false, error: 'Command not whitelisted.' });
  }
});
