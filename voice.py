import sounddevice as sd
import numpy as np
import speech_recognition as sr

recognizer = sr.Recognizer()

# Settings
samplerate = 16000  # Hz
duration = 5        # seconds per recording

while True:
    print("Listening...", flush=True)
    try:
        # Record from microphone using sounddevice
        audio_data = sd.rec(int(duration * samplerate), samplerate=samplerate, channels=1, dtype='int16')
        sd.wait()

        # Convert NumPy array -> AudioData for speech_recognition
        audio_bytes = audio_data.tobytes()
        audio = sr.AudioData(audio_bytes, samplerate, 2)

        # Recognize speech
        text = recognizer.recognize_google(audio)
        print(f"TRANSCRIPT::{text}", flush=True)

    except sr.UnknownValueError:
        print("TRANSCRIPT::[Unrecognized speech]", flush=True)
    except Exception as e:
        print(f"ERROR::{e}", flush=True)
