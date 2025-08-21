const chat = document.getElementById('chat');
const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const closeBtn = document.getElementById('closeBtn');
const minBtn = document.getElementById('minBtn');
const statusEl = document.getElementById('status');

// Speech Synthesis setup
let synth = window.speechSynthesis;
let speaking = false;
let speakQueue = "";
let selectedVoice = null;
let pitchControl = null;
let rateControl = null;
let voiceSelect = null;

// Add message to chat
function addMsg(text, who = 'assistant') {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  chat.appendChild(div);
  
  // Force layout recalc and ensure reliable scrolling
  setTimeout(() => {
    if (!chat) return;
    
    // Force layout recalculation
    const scrollHeight = chat.scrollHeight;
    const clientHeight = chat.clientHeight;
    
    // Only scroll if content exceeds container
    if (scrollHeight > clientHeight) {
      chat.scrollTo({
        top: scrollHeight,
        behavior: 'smooth'
      });
    }
  }, 10);
}

// Update last assistant message
function updateLastMsg(extra) {
  if (chat.lastChild && chat.lastChild.classList.contains('assistant')) {
    chat.lastChild.textContent += extra;
    
    // Auto-scroll during streaming too
    setTimeout(() => {
      if (!chat) return;
      const {scrollHeight, clientHeight, scrollTop} = chat;
      const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
      
      // Only scroll if within 200px of bottom
      if (distanceFromBottom < 200) {
        chat.scrollTo({
          top: scrollHeight,
          behavior: 'auto'
        });
      }
    }, 0);
  }
}

// Speak text
function speakText(text) {
  if (!synth) return;
  speakQueue += text;
  if (!speaking) {
    speaking = true;
  const utter = new SpeechSynthesisUtterance(speakQueue);
  // Apply selected voice / pitch / rate
  if (selectedVoice) utter.voice = selectedVoice;
  const pitch = pitchControl ? parseFloat(pitchControl.value) : 1;
  const rate = rateControl ? parseFloat(rateControl.value) : 1;
  utter.lang = selectedVoice ? selectedVoice.lang || 'en-US' : 'en-US';
  utter.rate = rate;
  utter.pitch = pitch;
    // Mute the voice input while assistant is speaking to avoid feedback loops
    utter.onstart = () => {
      if (statusEl) { statusEl.className = 'status speaking'; statusEl.textContent = 'Speaking'; }
      try { window.nova.muteVoice(); } catch (e) {}
    };
    utter.onend = () => {
      speaking = false;
      speakQueue = "";
      if (statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
      try { window.nova.unmuteVoice(); } catch (e) {}
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

// Initialize voice controls
window.addEventListener('DOMContentLoaded', () => {
  voiceSelect = document.getElementById('voiceSelect');
  pitchControl = document.getElementById('pitchRange');
  rateControl = document.getElementById('rateRange');
  if (synth && voiceSelect) {
    const populate = () => {
      const voices = synth.getVoices();
      voiceSelect.innerHTML = '';
      voices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
      });
      if (voices.length) {
        selectedVoice = voices[0];
        voiceSelect.value = 0;
      }
    };
    populate();
    synth.onvoiceschanged = populate;

    voiceSelect.addEventListener('change', () => {
      const voices = synth.getVoices();
      selectedVoice = voices[parseInt(voiceSelect.value, 10)];
    });
  }
});

// AI streaming handlers
window.nova.onDelta(({ requestId, content }) => {
  updateLastMsg(content);
});

// Create a short summary suitable for speech from the full assistant text
function summarizeForSpeech(fullText) {
  if (!fullText) return '';
  // Split into sentences
  const sentences = fullText.split(/(?<=[\.\?!])\s+/);
  if (sentences.length >= 2) {
    // Use first two sentences as concise summary
    return (sentences[0] + ' ' + sentences[1]).trim();
  }
  // Fallback: if single long paragraph, take first 120 chars
  if (fullText.length > 160) return fullText.slice(0, 160).trim() + '...';
  return fullText.trim();
}

window.nova.onEnd(() => {
  // Request a high-quality summarization from the main process, then speak it
  try {
    const last = chat.lastChild;
    if (last && last.classList.contains('assistant')) {
      const full = last.textContent || '';
      const requestId = Date.now().toString();
      window.nova.summarize(full, requestId);
    }
  } catch (e) {
    // ignore
  }
  if (!speaking && statusEl) { statusEl.className = 'status idle'; statusEl.textContent = 'Idle'; }
});

// Receive a summary from main and speak it
window.nova.onSummary(({ requestId, summary }) => {
  if (summary) speakText(summary);
});
window.nova.onError(({ error }) => {
  updateLastMsg(`\n[Error: ${error}]`);
});

// Mic Support via Python backend
let listening = false;

micBtn.addEventListener('mousedown', () => {
  listening = true;
  micBtn.classList.add('active');
  try { window.nova.startVoice(); } catch (e) {}
  if (statusEl) { statusEl.className = 'status listening'; statusEl.textContent = 'Listening'; }
});

micBtn.addEventListener('mouseup', () => {
  listening = false;
  micBtn.classList.remove('active');
  try { window.nova.stopVoice(); } catch (e) {}
  if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
});

// Ensure we stop recording if the pointer leaves the button while held
micBtn.addEventListener('mouseleave', () => {
  if (listening) {
    listening = false;
    micBtn.classList.remove('active');
    try { window.nova.stopVoice(); } catch (e) {}
  if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
  }
});

// Receive transcript from Python
window.nova.onVoice((transcript) => {
  if (!transcript?.trim()) return; // Ignore empty transcripts
  
  promptInput.value = transcript;
  if (statusEl) { statusEl.className = 'status thinking'; statusEl.textContent = 'Thinking'; }
  sendPrompt();
});

// Window Controls
closeBtn.addEventListener('click', () => window.nova.closeWindow());
minBtn.addEventListener('click', () => window.nova.minimizeWindow());
