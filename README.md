'''# Aura Assistant

**Aura Assistant** is a Windows AI-powered desktop assistant built with Electron.js. It can read the content displayed on your screen and answer questions about it in real-time. With a sleek, modern interface inspired by popular AI assistants, Aura turns your desktop into an intelligent, interactive workspace.

## Features

- **Screen Reading:** Captures and interprets content from your Windows screen.
- **AI-powered Queries:** Ask questions about any on-screen content and get intelligent, context-aware responses.
- **Sleek UI:** Clean, modern interface built with Electron.js.
- **Real-time Interaction:** Responds instantly to user queries.
- **Voice Activation:** Uses a wake word ("Hey Aura") to start listening.

## Tech Stack

- **Framework:** Electron.js
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js
- **AI Integration:** Google Gemini API
- **Wake Word Engine:** Picovoice Porcupine
- **Speech-to-Text:** Google Speech Recognition

## Installation

1. **Prerequisites:**
   - [Node.js](https://nodejs.org/) (which includes npm)
   - [Python](https://www.python.org/)

2. **Clone the repository:**

   ```bash
   git clone https://github.com/your-username/aura-assistant.git
   cd aura-assistant
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
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY
   PICOVOICE_ACCESS_KEY=YOUR_PICOVOICE_ACCESS_KEY
   ```

   - Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/).
   - Get your Picovoice Access Key from the [Picovoice Console](https://console.picovoice.ai/).

7. **Create a new wake word file:**

   The included wake word file (`Hey-Aura_en_windows_v3_0_0.ppn`) might not be compatible with your system. You can create a new one for free using the [Picovoice Console](https://console.picovoice.ai/).

   - Go to the **Porcupine** page.
   - Select **Windows** as the platform.
   - Train a new wake word (e.g., "Hey Aura").
   - Download the `.ppn` file and replace the existing `Hey-Aura_en_windows_v3_0_0.ppn` file in the project root.

   **Note:** If you encounter a `Picovoice Error (code 00000136)`, it means the `.ppn` file is incompatible. Creating a new one should resolve this issue.

8. **Run the application:**

   ```bash
   npm start
   ```
'''