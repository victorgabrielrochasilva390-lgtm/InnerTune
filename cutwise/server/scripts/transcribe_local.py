"""Free offline transcription with word timestamps using faster-whisper.

usage: transcribe_local.py <audio.wav> <model> [language]
Prints JSON {"language": ..., "words": [{"text","start","end","probability"}]} to stdout.
Progress lines "PROGRESS <seconds>" are written to stderr.
"""
import json
import sys

from faster_whisper import WhisperModel


def main():
    audio, model_name = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    model = WhisperModel(model_name, device="auto", compute_type="int8")
    segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=False)
    words = []
    for seg in segments:
        print(f"PROGRESS {seg.end:.2f}", file=sys.stderr, flush=True)
        for w in seg.words or []:
            words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "probability": round(w.probability, 3)})
    json.dump({"language": info.language, "words": words}, sys.stdout)


if __name__ == "__main__":
    main()
