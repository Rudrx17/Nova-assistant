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

recognizer = sr.Recognizer()
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
RECOG_TIMEOUT = 10

MAX_SEGMENT_MS = 8000         # Max utterance length before auto-cut
UTTERANCE_TIMEOUT_MS = 5000   # End listening after this much silence

# Shared thread pool for speech recognition (reused across calls)
_recognition_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="recognition"
)

# ---- runtime state (controlled by UI via stdin) ----
# Protected by _state_lock for thread-safe access
_state_lock = threading.Lock()
recording_enabled = True      # general gate for stream loop
muted = False
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
            muted = True
            print("CMD::MUTE", flush=True)

        elif cmd == "UNMUTE":
            muted = False
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
    Capture speech, VAD-chunk, and send to recognizer.
    Listens continuously until UTTERANCE_TIMEOUT_MS of silence is detected.
    """
    global stop_requested
    buffer = []
    frames_in_segment = 0
    last_speech_time = time.time()

    def end_segment(reason=""):
        nonlocal buffer, frames_in_segment
        if not buffer:
            return
        pcm = np.concatenate(buffer).tobytes()
        buffer = []
        frames_in_segment = 0

        def do_rec():
            logger.debug(f"Ending segment ({reason}), sending {len(pcm)} bytes to recognizer")
            recognized_text = recognize_bytes(pcm)
            with _state_lock:
                is_muted = muted
            if recognized_text and not is_muted:
                logger.info(f"Transcript: {recognized_text}")
                print(f"TRANSCRIPT::{recognized_text}", flush=True)

        threading.Thread(target=do_rec, daemon=True).start()

    # Throttle counter for audio level reporting (~90ms intervals)
    _level_frames = 0

    def audio_callback(indata, frames, t, status):
        nonlocal buffer, last_speech_time, _level_frames
        if status:
            logger.debug(f"Audio status: {status}")

        data = indata.copy().reshape(-1)
        for i in range(0, len(data), FRAME_SAMPLES):
            frame = data[i:i+FRAME_SAMPLES]
            if frame.size < FRAME_SAMPLES:
                continue
            frame_i16 = frame.astype(np.int16)

            # Push-to-talk: capture ALL audio frames (including silence between words)
            # Let Google Speech handle VAD internally
            buffer.append(frame_i16)
            last_speech_time = time.time()

            # Compute RMS energy for live waveform visualization
            energy = float(np.sqrt(np.mean(frame_i16.astype(np.float32) ** 2)))
            level = min(1.0, energy / 3000.0)

            # Send audio level to UI (~90ms intervals: every 3 frames at 30ms/frame)
            _level_frames += 1
            if _level_frames >= 3:
                _level_frames = 0
                print(f"LEVEL::{level:.3f}", flush=True)

            # Auto-cut for very long recordings
            if len(buffer) * FRAME_MS >= MAX_SEGMENT_MS:
                end_segment("max length reached")

    print("STATE::LISTENING", flush=True)
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16',
                        blocksize=FRAME_SAMPLES, callback=audio_callback):
        while True:
            pump_commands_nonblock()
            with _state_lock:
                should_stop = stop_requested
            if should_stop:
                logger.info("Stop requested; breaking capture")
                end_segment("stopped")  # Flush any remaining audio in buffer
                with _state_lock:
                    stop_requested = False
                break

            if time.time() - last_speech_time > UTTERANCE_TIMEOUT_MS / 1000:
                logger.info("Utterance timeout; breaking capture")
                break

            time.sleep(0.01)

    print("STATE::IDLE", flush=True)


# ----------------- main loop -----------------
if __name__ == "__main__":
    try:
        print("MODE::MIC", flush=True)
        while True:
            pump_commands_nonblock()

            with _state_lock:
                is_mic_active = mic_active

            if is_mic_active:
                stream_and_transcribe()
                with _state_lock:
                    mic_active = False
            else:
                time.sleep(0.05)

    except KeyboardInterrupt:
        logger.info("Shutting down by user request")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        print(f"ERROR::{e}", flush=True)
    finally:
        _recognition_executor.shutdown(wait=False)
        logger.info("Cleanup complete")
