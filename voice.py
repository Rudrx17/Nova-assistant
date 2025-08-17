import sys
import threading
import queue
import time

import sounddevice as sd
import numpy as np
import speech_recognition as sr


recognizer = sr.Recognizer()

# Settings
samplerate = 16000  # Hz
duration = 4        # seconds per recording (shorter for snappier UX)

# Control flags
recording_enabled = True
muted = False

cmd_queue = queue.Queue()


def stdin_watcher(q):
    # Read simple commands from stdin (START/STOP/MUTE/UNMUTE)
    for line in sys.stdin:
        if not line:
            continue
        q.put(line.strip().upper())


threading.Thread(target=stdin_watcher, args=(cmd_queue,), daemon=True).start()


def handle_command(cmd):
    global recording_enabled, muted
    if cmd == 'START':
        recording_enabled = True
        print('CMD::START', flush=True)
    elif cmd == 'STOP':
        recording_enabled = False
        print('CMD::STOP', flush=True)
    elif cmd == 'MUTE':
        muted = True
        print('CMD::MUTE', flush=True)
    elif cmd == 'UNMUTE':
        muted = False
        print('CMD::UNMUTE', flush=True)


def safe_sleep(seconds):
    try:
        time.sleep(seconds)
    except KeyboardInterrupt:
        pass


def record_and_transcribe():
    try:
        audio_data = sd.rec(int(duration * samplerate), samplerate=samplerate, channels=1, dtype='int16')
        sd.wait()

        audio_bytes = audio_data.tobytes()
        audio = sr.AudioData(audio_bytes, samplerate, 2)

        text = recognizer.recognize_google(audio)
        return text
    except sr.UnknownValueError:
        return None
    except Exception as e:
        print(f"ERROR::{e}", flush=True)
        return None


while True:
    # Process incoming commands
    try:
        while True:
            cmd = cmd_queue.get_nowait()
            handle_command(cmd)
    except queue.Empty:
        pass

    if not recording_enabled:
        # Idle short while waiting for START
        safe_sleep(0.2)
        continue

    # Perform a recording window
    text = record_and_transcribe()
    if text:
        if not muted:
            print(f"TRANSCRIPT::{text}", flush=True)
    else:
        # Only print unrecognized if not muted to avoid noise
        if not muted:
            print("TRANSCRIPT::[Unrecognized speech]", flush=True)

