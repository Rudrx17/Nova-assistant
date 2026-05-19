'''# Nova Assistant

**Nova Assistant** is a Windows AI-powered desktop assistant built with Electron.js. It can read the content displayed on your screen, edit files, fix code, open apps/websites, and answer questions — all through voice or text commands.

## Features

- **Screen Reading:** Captures and interprets content from your Windows screen.
- **AI-powered Queries:** Ask questions and get intelligent, context-aware responses.
- **File Editing:** Edit any file in your project — say or type `edit main.c: add a function`.
- **Analyze & Fix:** Detect and fix errors in your code — `fix test.py`, `analyze app.js`, `debug main.c`.
- **App & Website Opening:** Open apps via voice — "open YouTube", "open WhatsApp", "open Chrome", "open Spotify".
- **VS Code Integration:** Open folders directly in VS Code — "open folder in VS Code".
- **Sleek UI:** Clean, modern interface with dark/light themes, opacity control, and live audio waveform.
- **Voice Input:** Hold the mic button to speak commands — hands-free interaction.
- **System Commands:** "open notepad", "open calculator", "open paint", "show desktop", "lock computer".

## Tech Stack

- **Framework:** Electron.js
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js
- **AI Integration:** Groq API (OpenAI-compatible) — uses `llama-3.3-70b-versatile` with ~7,000 free requests/day
- **Speech-to-Text:** Google Speech Recognition

## Installation

1. **Prerequisites:**
   - [Node.js](https://nodejs.org/) (which includes npm)
   - [Python](https://www.python.org/)

2. **Clone the repository:**

   ```bash
   git clone https://github.com/your-username/nova-assistant.git
   cd nova-assistant
   ```

3. **Install JavaScript dependencies:**

   ```bash
   npm install
   ```

4. **Set up Python virtual environment:**

   Create and activate a virtual environment:

   ```bash
   # Create the virtual environment
   python -m venv .venv

   # Activate the virtual environment (Windows)
   .venv\Scripts\activate
   ```

5. **Install Python dependencies:**

   With your virtual environment activated, install the required packages:

   ```bash
   pip install -r requirements.txt
   ```

6. **Set up environment variables:**

   Create a file named `.env` in the root of the project and add the following:

   ```
   GROQ_API_KEY=YOUR_GROQ_API_KEY
   ```

   - Get your free Groq API key from [console.groq.com/keys](https://console.groq.com/keys).
   - Free tier includes ~7,000 requests/day on `llama-3.3-70b-versatile`.

7. **Run the application:**

   ```bash
   npm start
   ```

## Usage

### Basic Commands

| Say or type... | What happens |
|---------------|-------------|
| `Hello, who are you?` | Normal AI chat response |
| `What's on my screen?` | Takes a screenshot and asks about it |
| `open notepad` | Opens Notepad |
| `open calculator` | Opens Calculator |
| `lock computer` | Locks your PC |

### File Editing (Open a folder first)

1. Click the **Open Folder** button and select a project folder
2. Then say or type:

| Command | Example |
|---------|---------|
| `edit filename: instruction` | `edit test.py: add a greeting function` |
| `write [content] to filename` | `write a C program to hello.c` |
| `change filename: instruction` | `change styles.css: make the background blue` |

### Analyze & Fix Code

| Command | Example |
|---------|---------|
| `fix filename.ext` | `fix test.py` |
| `analyze filename.ext` | `analyze app.js` |
| `debug filename.ext` | `debug main.c` |
| `fix errors in filename.ext` | `fix errors in index.html` |

Nova reads the file, identifies issues, explains them, and writes the fixed code back.

### Open Apps & Websites

| Command | What opens |
|---------|-----------|
| `open YouTube` | `youtube.com` in your browser |
| `open WhatsApp` | WhatsApp desktop app (or web fallback) |
| `open Chrome` | Google Chrome |
| `open Spotify` | Spotify desktop app (or web fallback) |
| `open folder in VS Code` | VS Code with the current project folder |

### Voice Input

- **Hold** the mic button to start recording
- **Release** to send the transcript to AI
- Results are displayed in chat and spoken aloud via TTS

## Project Structure

```
nova-assistant/
├── main.js              # Electron main process (AI, IPC, system commands)
├── preload.js           # Context bridge (safe IPC for renderer)
├── voice.py             # Python voice capture & STT process
├── requirements.txt     # Python dependencies
├── package.json         # Node.js dependencies
├── src/
│   ├── index.html       # UI layout
│   ├── styles.css       # UI styling (dark/light themes)
│   └── renderer.js      # UI logic (chat, voice, file editing)
└── .env                 # API keys (not tracked in git)
```

## API Limits

| Provider | Model | Free tier | Cost if exceeded |
|----------|-------|-----------|-----------------|
| **Groq** | `llama-3.3-70b-versatile` | ~7,000 requests/day | Very low ($0.59/M tokens) |

Each file edit, chat message, or analysis uses **1 API request**.
