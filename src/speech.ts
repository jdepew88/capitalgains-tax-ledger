// Browser speech recognition, where available (Safari on iPhone, Chrome, Edge). Feature-detected;
// the transcript box always works with the keyboard and the iPhone keyboard's own dictation key.

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type Ctor = new () => RecognitionLike;

function getCtor(): Ctor | null {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = () => getCtor() !== null && window.isSecureContext;

export function explainSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone or speech recognition permission was blocked. On iPhone: Settings › Safari › Microphone (Allow), and Settings › Screen Time › Content & Privacy › Allowed Apps must include Siri & Dictation. You can still type, or use the keyboard’s microphone key.";
    case "no-speech":
      return "No speech was heard. Tap the microphone and try again, a little closer to the phone.";
    case "audio-capture":
      return "No microphone was found. You can type instead.";
    case "network":
      return "Speech recognition needs an internet connection. You can type instead.";
    case "aborted":
      return "";
    default:
      return `Speech recognition stopped (${code}). You can type instead.`;
  }
}

export interface Listening {
  stop(): void;
}

/** Starts listening. `onText` receives the full text heard so far (final + interim). */
export function listen(handlers: {
  onText: (text: string, final: boolean) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): Listening | null {
  const C = getCtor();
  if (!C) return null;
  const rec = new C();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += (finalText ? " " : "") + r[0].transcript.trim();
      else interim += r[0].transcript;
    }
    handlers.onText((finalText + (interim ? " " + interim.trim() : "")).trim(), !interim);
  };
  rec.onerror = (e) => {
    const msg = explainSpeechError(e.error);
    if (msg) handlers.onError(msg);
  };
  rec.onend = () => handlers.onEnd();
  try {
    rec.start();
  } catch {
    handlers.onError("Speech recognition couldn’t start. You can type instead.");
    return null;
  }
  return { stop: () => rec.stop() };
}
