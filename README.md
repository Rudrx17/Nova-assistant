'''# Nova Assistant

**Nova Assistant** is a Windows AI-powered desktop assistant built with Electron.js. It can read the content displayed on your screen and answer questions about it in real-time. With a sleek, modern interface inspired by popular AI assistants, Nova turns your desktop into an intelligent, interactive workspace.

## Features

- **Screen Reading:** Captures and interprets content from your Windows screen.
- **AI-powered Queries:** Ask questions about any on-screen content and get intelligent, context-aware responses.
- **Sleek UI:** Clean, modern interface built with Electron.js.
- **Real-time Interaction:** Responds instantly to user queries.
- **Voice Activation:** Hold the mic button to start listening.

## Tech Stack

- **Framework:** Electron.js
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js
- **AI Integration:** Google Gemini API
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
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY
   ```

   - Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/).

7. **Run the application:**

   ```bash
   npm start
   ```
'''