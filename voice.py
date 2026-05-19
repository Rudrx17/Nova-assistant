import os, sys, threading, queue, time, logging, concurrent.futures

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("voice")


def check_dependencies():
    """Check for required Python packages and provide instructions if any are missing."""
    required_packages = {
        'numpy': 'numpy>=1.24.0',
        'sounddevice': 'sounddevice>=0.4.6',
        'speech_recognition': 'SpeechRecognition>=3.10.0',
    }
    all_ok = True
    for module_name, pip_name in required_packages.items():
        try:
            __import__(module_name)
        except ImportError:
            print(f"ERROR::Missing Python dependency: {module_name}", flush=True)
            print(f"Please install it by running: pip install {pip_name}", flush=True)
            all_ok = False

    # Pillow is optional but recommended for screenshot handling
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print("WARNING::Pillow (PIL) is not installed. Screenshot features may not work.", flush=True)
        print("Install it with: pip install Pillow>=9.0.0", flush=True)

    if not all_ok:
        sys.exit(1)


check_dependencies()

# Now import the modules for real
import numpy as np
import sounddevice as sd
import speech_recognition as sr
import openwakeword
from openwakeword.model import Model
import webrtcvad

# Initialize OpenWakeWord (using built-in hey_jarvis for now)
# Replace 'hey_jarvis_v0.1' with 'hey_nova.onnx' when your custom model is ready.
oww_model = Model(wakeword_models=["hey_jarvis_v0.1"], inference_framework="onnx")
vad = webrtcvad.Vad(3)

recognizer = sr.Recognizer()
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
RECOG_TIMEOUT = 20

MAX_SEGMENT_MS = 8000         # Max utterance length before auto-cut

# Shared thread pool for speech recognition (reused across calls)
_recognition_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="recognition"
)

# ---- runtime state (controlled by UI via stdin) ----
# Protected by _state_lock for thread-safe access
_state_lock = threading.Lock()
recording_enabled = True      # general gate for stream loop
muted = 0                     # counter: mute > 0 means muted, tracks nested MUTEs
mic_active = False            # true while user is pressing/using the mic
stop_requested = False        # set when UI sends STOP to break current capture

cmd_queue = queue.Queue()


# ----------------- command handling -----------------
def stdin_watcher(q):
    for line in sys.stdin:
        if line:
            q.put(line.strip().upper())


threading.Thread(target=stdin_watcher, args=(cmd_queue,), daemon=True).start()


def pump_commands_nonblock():
    """Process any pending commands quickly."""
    try:
        while True:
            cmd = cmd_queue.get_nowait()
            handle_command(cmd)
    except queue.Empty:
        pass


def handle_command(cmd):
    global recording_enabled, muted, mic_active, stop_requested
    logger.info(f"Processing command: {cmd}")

    with _state_lock:
        if cmd == "START":
            mic_active = True
            recording_enabled = True
            stop_requested = False
            print("CMD::START", flush=True)

        elif cmd == "STOP":
            mic_active = False
            recording_enabled = False
            stop_requested = True
            print("CMD::STOP", flush=True)

        elif cmd == "MUTE":
            muted += 1
            print("CMD::MUTE", flush=True)

        elif cmd == "UNMUTE":
            muted = max(0, muted - 1)
            print("CMD::UNMUTE", flush=True)

    if cmd == "READ_SCREEN":
        logger.info("READ_SCREEN command received. Handled by Electron, ignoring in Python.")


# ----------------- utils -----------------
def recognize_bytes(pcm_bytes: bytes) -> str | None:
    audio = sr.AudioData(pcm_bytes, SAMPLE_RATE, 2)

    future = _recognition_executor.submit(recognizer.recognize_google, audio)
    try:
        text = future.result(timeout=RECOG_TIMEOUT)
        return text.strip() if text else None
    except sr.UnknownValueError:
        logger.warning("Google Speech could not understand audio")
        print("ERROR::Voice could not understand audio. Please speak clearly.", flush=True)
        return None
    except sr.RequestError as e:
        logger.error(f"Google Speech API request failed: {e}")
        print(f"ERROR::Voice recognition service error. Check your network connection.", flush=True)
        return None
    except concurrent.futures.TimeoutError:
        logger.error("Speech recognition timed out")
        print("ERROR::Voice recognition timed out. Try again.", flush=True)
        return None
    except Exception as e:
        logger.error(f"Recognition error: {e}")
        print(f"ERROR::Voice recognition error: {e}", flush=True)
        return None


def check_google_speech_connectivity():
    """Quick connectivity check for Google Speech Recognition API."""
    try:
        import urllib.request
        import urllib.error
        req = urllib.request.Request(
            "https://www.google.com/",
            method="HEAD",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        urllib.request.urlopen(req, timeout=3)
        logger.info("Google Speech connectivity check: OK")
        return True
    except Exception as e:
        logger.warning(f"Google Speech connectivity check failed: {e}")
        print("WARNING::Google Speech API may not be reachable. Voice recognition may fail.", flush=True)
        return False


# Run connectivity check at startup (non-blocking, best-effort)
threading.Thread(target=check_google_speech_connectivity, daemon=True).start()


# ----------------- transcription -----------------
def stream_and_transcribe():
    """
    Capture speech, run OpenWakeWord for wake word detection,
    then use VAD and send to recognizer.
    """
    global stop_requested, mic_active
    buffer = []
    frames_in_segment = 0

    # VAD silence tracking
    silence_frames = 0
    MAX_SILENCE_FRAMES = 50  # 1.5 seconds at 30ms/frame
    speech_detected_in_segment = False

    def end_segment(reason="", transcribe=True):
        nonlocal buffer, frames_in_segment, silence_frames, speech_detected_in_segment
        global mic_active
        if not buffer:
            return
        pcm = np.concatenate(buffer).tobytes()
        buffer = []
        frames_in_segment = 0
        silence_frames = 0
        speech_detected_in_segment = False
        
        with _state_lock:
            mic_active = False
        
        # Reset wake word model to avoid double-triggering from the same audio hangover
        oww_model.reset()

        if transcribe:
            def do_rec():
                logger.debug(f"Ending segment ({reason}), sending {len(pcm)} bytes to recognizer")
                recognized_text = recognize_bytes(pcm)
                with _state_lock:
                    is_muted = muted > 0
                if recognized_text and not is_muted:
                    logger.info(f"Transcript: {recognized_text}")
                    print(f"TRANSCRIPT::{recognized_text}", flush=True)

            threading.Thread(target=do_rec, daemon=True).start()
        else:
            logger.debug(f"Segment aborted ({reason})")

    _level_frames = 0

    def audio_callback(indata, frames, t, status):
        nonlocal buffer, _level_frames, silence_frames, speech_detected_in_segment
        global mic_active
        if status:
            logger.debug(f"Audio status: {status}")

        data = indata.copy().reshape(-1)
        
        with _state_lock:
            is_active = mic_active

        for i in range(0, len(data), FRAME_SAMPLES):
            frame = data[i:i+FRAME_SAMPLES]
            if frame.size < FRAME_SAMPLES:
                continue
            frame_i16 = frame.astype(np.int16)

            if not is_active:
                # STATE A: Wait for Wake Word
                prediction = oww_model.predict(frame_i16)
                # We're using hey_jarvis_v0.1 for now, change to hey_nova when trained.
                if prediction.get('hey_jarvis_v0.1', 0) > 0.5:
                    print("EVENT::WAKE_WORD_DETECTED", flush=True)
                    speech_detected_in_segment = False
                    with _state_lock:
                        mic_active = True
                        is_active = True
            else:
                # STATE B: Active Recording
                buffer.append(frame_i16)

                # VAD silence detection
                is_speech = vad.is_speech(frame_i16.tobytes(), SAMPLE_RATE)
                if is_speech:
                    silence_frames = 0
                    speech_detected_in_segment = True
                else:
                    silence_frames += 1

                # Send audio level to UI
                energy = float(np.sqrt(np.mean(frame_i16.astype(np.float32) ** 2)))
                level = min(1.0, energy / 3000.0)
                _level_frames += 1
                if _level_frames >= 3:
                    _level_frames = 0
                    print(f"LEVEL::{level:.3f}", flush=True)

                if silence_frames > MAX_SILENCE_FRAMES:
                    if speech_detected_in_segment:
                        end_segment("silence_detected", transcribe=True)
                    elif len(buffer) > 100: # Abort after 3s if no speech was ever detected
                        print("EVENT::WAKE_WORD_ABORTED", flush=True)
                        end_segment("abort_no_speech", transcribe=False)
                    break

                if len(buffer) * FRAME_MS >= MAX_SEGMENT_MS:
                    end_segment("max_length_reached", transcribe=True)
                    break

    print("STATE::LISTENING", flush=True)
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16',
                        blocksize=FRAME_SAMPLES, callback=audio_callback):
        while True:
            pump_commands_nonblock()
            with _state_lock:
                should_stop = stop_requested
            if should_stop:
                logger.info("Stop requested; breaking capture")
                end_segment("stopped")
                with _state_lock:
                    stop_requested = False
            time.sleep(0.01)

# ----------------- main loop -----------------
if __name__ == "__main__":
    try:
        print("MODE::MIC", flush=True)
        # Start continuous stream
        stream_and_transcribe()
    except KeyboardInterrupt:
        logger.info("Shutting down by user request")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        print(f"ERROR::{e}", flush=True)
    finally:
        _recognition_executor.shutdown(wait=False)
        logger.info("Cleanup complete")
