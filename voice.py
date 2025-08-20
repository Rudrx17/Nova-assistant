import sys, threading, queue, time, logging, concurrent.futures
import numpy as np
import sounddevice as sd
import speech_recognition as sr
import webrtcvad
import warnings

# Suppress pkg_resources deprecation warnings from webrtcvad
warnings.filterwarnings("ignore", category=UserWarning)

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("voice")

recognizer = sr.Recognizer()
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
RECOG_TIMEOUT = 10

vad = webrtcvad.Vad(2)  # 0–3 (3 = most aggressive)
ENERGY_THRESHOLD = 500.0
MAX_SEGMENT_MS = 8000  # max utterance length
SILENCE_LIMIT_MS = 500  # how long silence ends speech (ms)

recording_enabled = True
muted = False
cmd_queue = queue.Queue()

def stdin_watcher(q):
    for line in sys.stdin:
        if line:
            q.put(line.strip().upper())
threading.Thread(target=stdin_watcher, args=(cmd_queue,), daemon=True).start()

def handle_command(cmd):
    global recording_enabled, muted
    logger.info(f"Processing command: {cmd}")
    if cmd == "START":
        recording_enabled = True
        print("CMD::START", flush=True)
    elif cmd == "STOP":
        recording_enabled = False
        print("CMD::STOP", flush=True)
    elif cmd == "MUTE":
        muted = True
        print("CMD::MUTE", flush=True)
    elif cmd == "UNMUTE":
        muted = False
        print("CMD::UNMUTE", flush=True)

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

def stream_and_transcribe():
    buffer = []
    silence_frames = 0
    in_speech = False
    frames_in_segment = 0

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
        nonlocal buffer, in_speech, silence_frames, frames_in_segment
        if status:
            logger.debug(f"Audio status: {status}")

        data = indata.copy().reshape(-1)
        for i in range(0, len(data), FRAME_SAMPLES):
            frame = data[i:i+FRAME_SAMPLES]
            if frame.size < FRAME_SAMPLES:
                continue
            frame_i16 = frame.astype(np.int16)
            energy = rms_energy(frame_i16)
            is_speech = energy >= ENERGY_THRESHOLD and vad.is_speech(frame_i16.tobytes(), SAMPLE_RATE)

            if is_speech:
                buffer.append(frame_i16)
                in_speech = True
                silence_frames = 0
                frames_in_segment += 1
                if frames_in_segment * FRAME_MS >= MAX_SEGMENT_MS:
                    end_segment("max length reached")
            elif in_speech:
                silence_frames += 1
                if silence_frames * FRAME_MS > SILENCE_LIMIT_MS:
                    end_segment("silence")
        return

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', blocksize=FRAME_SAMPLES, callback=audio_callback):
        logger.info("Listening for speech...")
        while True:
            try:
                while True:
                    cmd = cmd_queue.get_nowait()
                    handle_command(cmd)
            except queue.Empty:
                pass
            if not recording_enabled:
                time.sleep(0.2)
                continue
            time.sleep(0.01)

if __name__ == "__main__":
    try:
        stream_and_transcribe()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        print(f"ERROR::{e}", flush=True)
