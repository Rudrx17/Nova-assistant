// main.js
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

// --- Gemini (existing) ---
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- VOSK (offline STT) ---
let Vosk;
let Model;
let KaldiRecognizer;
let voskModel = null;
const MODEL_DIR = path.join(__dirname, 'models', 'vosk-model-small-en-us-0.15'); // change if needed

try {
  // lazy require; will throw if native module not installed
  Vosk = require('vosk');
  Model = Vosk.Model;
  KaldiRecognizer = Vosk.KaldiRecognizer;
} catch (e) {
  console.warn('Vosk module is not installed or failed to load. STT will not be available until you install vosk.', e?.message || e);
}

let win;
let tray;

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
      // allow getUserMedia
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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContentStream(text);
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) event.sender.send('ai:delta', { requestId, content: chunkText });
    }
    event.sender.send('ai:end', { requestId });
  } catch (err) {
    console.error('Gemini API Error:', err);
    event.sender.send('ai:error', { requestId, error: err.message || String(err) });
  }
});

// ---------- Vosk STT handler ----------
ipcMain.handle('stt:transcribe', async (event, arrayBuffer) => {
  // returns transcribed string
  // If mock mode, return mocked text
  if (process.env.MOCK_MODE === 'true') return 'this is a mocked transcription';

  // Ensure Vosk is available
  if (!Model || !KaldiRecognizer) {
    throw new Error('Vosk is not installed or failed to load. Install via `npm install vosk` and ensure native build tools are available.');
  }

  // Load model once
  if (!voskModel) {
    if (!fs.existsSync(MODEL_DIR)) {
      throw new Error(`Vosk model not found at ${MODEL_DIR}. Download a model and extract to this path.`);
    }
    try {
      voskModel = new Model(MODEL_DIR);
      console.log('Vosk model loaded from', MODEL_DIR);
    } catch (err) {
      console.error('Failed to load Vosk model:', err);
      throw err;
    }
  }

  try {
    // arrayBuffer arrives as an object convertible to Buffer
    const audioBuffer = Buffer.from(arrayBuffer);

    // Detect WAV header: if present, strip first 44 bytes (WAV header)
    let pcmBuffer = audioBuffer;
    const header = audioBuffer.slice(0, 4).toString('ascii');
    if (header === 'RIFF') {
      // assume standard WAV header 44 bytes
      pcmBuffer = audioBuffer.slice(44);
    }

    // Create recognizer (16000 Hz)
    const rec = new KaldiRecognizer(voskModel, 16000);
    // Vosk expects raw PCM16LE data
    const accepted = rec.acceptWaveform(pcmBuffer);
    let resultJson;
    if (accepted) {
      resultJson = rec.finalResult();
    } else {
      resultJson = rec.finalResult(); // use finalResult for completeness
    }

    // resultJson is a JSON string or object depending on version
    let text = '';
    if (typeof resultJson === 'string') {
      try {
        const parsed = JSON.parse(resultJson);
        text = parsed.text || '';
      } catch (e) {
        text = resultJson;
      }
    } else if (typeof resultJson === 'object') {
      text = resultJson.text || '';
    }

    return text;
  } catch (err) {
    console.error('Vosk transcription error:', err);
    throw err;
  }
});

// Optional: stop AI handler
ipcMain.on('ai:stop', (event, { requestId }) => {
  console.log(`Stopping AI request ${requestId}`);
  event.sender.send('ai:stopped', { requestId });
});
