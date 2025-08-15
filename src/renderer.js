const chat = document.getElementById('chat');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const closeBtn = document.getElementById('closeBtn');
const minBtn = document.getElementById('minBtn');

// Speech Synthesis setup
let synth = window.speechSynthesis;
let speaking = false;
let speakQueue = "";

// Add message to chat
function addMsg(text, who = 'assistant') {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

// Update last assistant message
function updateLastMsg(extra) {
  if (chat.lastChild && chat.lastChild.classList.contains('assistant')) {
    chat.lastChild.textContent += extra;
  }
}

// Speak text
function speakText(text) {
  if (!synth) return;
  speakQueue += text;
  if (!speaking) {
    speaking = true;
    const utter = new SpeechSynthesisUtterance(speakQueue);
    utter.lang = 'en-US';
    utter.rate = 1;
    utter.pitch = 1;
    utter.onend = () => {
      speaking = false;
      speakQueue = "";
    };
    synth.speak(utter);
  }
}

// Send prompt to AI
async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;
  const requestId = Date.now().toString();

  addMsg(text, 'user');
  promptInput.value = '';
  addMsg('', 'assistant'); // prepare empty for streaming

  window.nova.ask(text, requestId);
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// AI streaming handlers
window.nova.onDelta(({ requestId, content }) => {
  updateLastMsg(content);
  speakText(content); // speak as it streams in
});
window.nova.onEnd(() => {});
window.nova.onError(({ error }) => {
  updateLastMsg(`\n[Error: ${error}]`);
});

// Mic Support (Speech-to-Text)
let recognition;
let listening = false;
if ('webkitSpeechRecognition' in window) {
  const WSR = window.webkitSpeechRecognition;
  recognition = new WSR();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    promptInput.value = transcript;
    sendPrompt();
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove('active');
  };

  micBtn.addEventListener('mousedown', () => {
    if (!listening) {
      listening = true;
      micBtn.classList.add('active');
      recognition.start();
    }
  });
  micBtn.addEventListener('mouseup', () => {
    if (listening) recognition.stop();
  });
  micBtn.addEventListener('mouseleave', () => {
    if (listening) recognition.stop();
  });
}

// Window Controls
closeBtn.addEventListener('click', () => window.nova.closeWindow());
minBtn.addEventListener('click', () => window.nova.minimizeWindow());
