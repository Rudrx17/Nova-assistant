import os, sys, threading, queue, time, logging, concurrent.futures, struct
import warnings

# Suppress pkg_resources deprecation warnings from webrtcvad
warnings.filterwarnings("ignore", category=UserWarning)

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("voice")

def check_dependencies():
    """Checks for required Python packages and provides instructions if any are missing."""
    try:
        import numpy
        import sounddevice
        import speech_recognition
        import webrtcvad
        import pvporcupine
    except ImportError as e:
        module_name = e.name
        print(f"ERROR::Missing Python dependency: {module_name}", flush=True)
        print(f"Please install it by running: pip install {module_name}", flush=True)
        sys.exit(1)

check_dependencies()

# Now import the modules for real
import numpy as np
import sounddevice as sd
import speech_recognition as sr
import webrtcvad
import pvporcupine


recognizer = sr.Recognizer()
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
RECOG_TIMEOUT = 10

vad = webrtcvad.Vad(2)  # 0–3 (3 = most aggressive)
ENERGY_THRESHOLD = 300.0      # Initial value, will be adapted
MAX_SEGMENT_MS = 8000         # Max utterance length
SILENCE_LIMIT_MS = 2500       # How long silence ends speech (ms)
UTTERANCE_TIMEOUT_MS = 5000   # End listening after this much silence
NOISE_FLOOR_SAMPLES = 100     # Number of frames to avg for noise floor
NOISE_ADJUST_SPEED = 0.1      # How quickly to adapt to new noise levels

# ---- runtime state (controlled by UI via stdin) ----
recording_enabled = True      # general gate for stream loop
muted = False
input_mode = "HYBRID"         # WAKE | MIC | HYBRID  (default HYBRID)
mic_active = False            # true while user is pressing/using the mic
stop_requested = False        # set when UI sends STOP to break current capture
ambient_energy = ENERGY_THRESHOLD # Start with default

cmd_queue = queue.Queue()

# ---- Wake Word (Porcupine) ----
ACCESS_KEY = os.getenv("PICOVOICE_ACCESS_KEY", "").strip()
if not ACCESS_KEY:
    print("ERROR::PICOVOICE_ACCESS_KEY environment variable not set.", flush=True)
    print("Please get a free key from https://console.picovoice.ai/ and set it.", flush=True)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
KEYWORD_PATH = os.path.join(HERE, "Hey-Aura_en_windows_v3_0_0.ppn")

try:
    porcupine = pvporcupine.create(
        access_key=ACCESS_KEY,
        keyword_paths=[KEYWORD_PATH],
    )
except Exception as e:
    logger.error(f"Failed to init Porcupine. Check access key and .ppn path.\nKey set: {bool(ACCESS_KEY)}  Path exists: {os.path.exists(KEYWORD_PATH)}\n{e}")
    print(f"ERROR::Porcupine init failed: {e}", flush=True)
    sys.exit(1)


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
    global recording_enabled, muted, input_mode, mic_active, stop_requested
    logger.info(f"Processing command: {cmd}")

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

    if cmd.startswith("MODE::"):
        # MODE::MIC / MODE::WAKE / MODE::HYBRID
        mode = cmd.split("::", 1)[1].strip()
        if mode in ("MIC", "WAKE", "HYBRID"):
            input_mode = mode
            # reset any ongoing capture so mode switch takes effect immediately
            mic_active = False
            stop_requested = True
            recording_enabled = False
            print(f"MODE::{input_mode}", flush=True)
            logger.info(f"Switched mode to {input_mode}")
        else:
            logger.logger.warning(f"Unknown mode value: {mode}")

    elif cmd == "READ_SCREEN":
        logger.info("READ_SCREEN command received. Handled by Electron, ignoring in Python.")

# ----------------- utils -----------------
def rms_energy(frame_i16: np.ndarray) -> float:
    return float(np.sqrt(np.mean(frame_i16.astype(np.float32) ** 2)))

def recognize_bytes(pcm_bytes: bytes) -> str | None:
    audio = sr.AudioData(pcm_bytes, SAMPLE_RATE, 2)
    with concurrent.futures.ThreadPoolExecutor() as ex:
        fut = ex.submit(recognizer.recognize_google, audio)
        try:
            text = fut.strip() if text else None
        except sr.UnknownValueError:
            logger.warning("Google Speech could not understand audio")
            return None
        except sr.RequestError as e:
            logger.error(f"Google Speech API request failed: {e}")
            return None
        except Exception as e:
            logger.error(f"Recognition error: {e}")
            return None

# ----------------- utils -----------------
def rms_energy(frame_i16: np.ndarray) -> float:
    return float(np.sqrt(np.mean(frame_i16.astype(np.float32) ** 2)))

def recognize_bytes(pcm_bytes: bytes) -> str | None:
    audio = sr.AudioData(pcm_bytes, SAMPLE_RATE, 2)
    with concurrent.futures.ThreadPoolExecutor() as ex:
        fut = ex.submit(recognizer.recognize_google, audio)
        try:
            text = fut.result(timeout=RECOG_TIMEOUT)
            return text.strip() if text else None
        except sr.UnknownValueError:
            logger.warning("Google Speech could not understand audio")
            return None
        except sr.RequestError as e:
            logger.error(f"Google Speech API request failed: {e}")
            return None
        except Exception as e:
            logger.error(f"Recognition error: {e}")
            return None

# ----------------- wake word -----------------
def listen_for_wake_word():
    """Block until wake word is detected, or mode changes away from WAKE/HYBRID."""
    print("STATE::WAITING_WAKE", flush=True)
    with sd.RawInputStream(samplerate=porcupine.sample_rate,
                           blocksize=porcupine.frame_length,
                           channels=1,
                           dtype='int16') as wake_audio:
        logger.info("Wake word engine running...")
        while True:
            pump_commands_nonblock()
            if input_mode == "MIC":    # mode switched, stop waiting
                logger.info("Leaving wake wait (mode switched to MIC)")
                return
            pcm = wake_audio.read(porcupine.frame_length)[0]
            pcm = struct.unpack_from("h" * porcupine.frame_length, pcm)
            keyword_index = porcupine.process(pcm)
            if keyword_index >= 0:
                print("WAKEWORD::Hey Aura", flush=True)
                return  # exit when detected

# ----------------- transcription -----------------
def stream_and_transcribe():
    """
    Capture speech, VAD-chunk, and send to recognizer.
    Listens continuously until UTTERANCE_TIMEOUT_MS of silence is detected.
    """
    global stop_requested, ambient_energy
    buffer = []
    silence_frames = 0
    in_speech = False
    frames_in_segment = 0
    noise_samples = []
    last_speech_time = time.time()

    def end_segment(reason=""):
        nonlocal buffer, in_speech, silence_frames, frames_in_segment
        if not buffer:
            return
        pcm = np.concatenate(buffer).tobytes()
        buffer = []
        in_speech = False
        silence_frames = 0
        frames_in_segment = 0

        def do_rec():
            logger.debug(f"Ending segment ({reason}), sending {len(pcm)} bytes to recognizer")
            text = recognize_bytes(pcm)
            if text and not muted:
                logger.info(f"Transcript: {text}")
                print(f"TRANSCRIPT::{text}", flush=True)
        threading.Thread(target=do_rec, daemon=True).start()

    def audio_callback(indata, frames, t, status):
        nonlocal buffer, in_speech, silence_frames, frames_in_segment, noise_samples, last_speech_time
        global ambient_energy
        if status:
            logger.debug(f"Audio status: {status}")

        data = indata.copy().reshape(-1)
        for i in range(0, len(data), FRAME_SAMPLES):
            frame = data[i:i+FRAME_SAMPLES]
            if frame.size < FRAME_SAMPLES:
                continue
            frame_i16 = frame.astype(np.int16)
            energy = rms_energy(frame_i16)
            
            speech_threshold = ambient_energy * 1.2
            is_speech = energy > speech_threshold and vad.is_speech(frame_i16.tobytes(), SAMPLE_RATE)

            if is_speech:
                last_speech_time = time.time()
                buffer.append(frame_i16)
                in_speech = True
                silence_frames = 0
                frames_in_segment += 1
                if frames_in_segment * FRAME_MS >= MAX_SEGMENT_MS:
                    end_segment("max length reached")
            else:
                noise_samples.append(energy)
                if len(noise_samples) >= NOISE_FLOOR_SAMPLES:
                    new_noise_floor = np.mean(noise_samples)
                    ambient_energy = (ambient_energy * (1 - NOISE_ADJUST_SPEED)) + (new_noise_floor * NOISE_ADJUST_SPEED)
                    noise_samples = []
                    logger.debug(f"Ambient energy updated to: {ambient_energy:.2f}")

                if in_speech:
                    silence_frames += 1
                    if silence_frames * FRAME_MS > SILENCE_LIMIT_MS:
                        end_segment("silence")

    print("STATE::LISTENING", flush=True)
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16',
                        blocksize=FRAME_SAMPLES, callback=audio_callback):
        while True:
            pump_commands_nonblock()
            if stop_requested:
                logger.info("Stop requested; breaking capture")
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
        print("MODE::HYBRID", flush=True)  # default
        while True:
            pump_commands_nonblock()

            if input_mode == "WAKE":
                listen_for_wake_word()
                stream_and_transcribe()

            elif input_mode == "MIC":
                if mic_active:
                    stream_and_transcribe()
                    mic_active = False
                else:
                    time.sleep(0.05)

            else:  # HYBRID
                if mic_active:
                    stream_and_transcribe()
                    mic_active = False
                else:
                    listen_for_wake_word()
                    stream_and_transcribe()

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        print(f"ERROR::{e}", flush=True)
