import { isTauri } from '@tauri-apps/api/core';
import {
  checkPermission,
  onError,
  onResult,
  requestPermission,
  startListening,
  stopListening,
} from 'tauri-plugin-stt-api';

// Mobile OS engines only (SFSpeechRecognizer / SpeechRecognizer); desktop has no plugin registered.
export const speechSupported = isTauri() && /Android|iPhone|iPad/i.test(navigator.userAgent);

export const ensureRecognitionPermission = async () => {
  let perm = await checkPermission();
  if (perm.microphone !== 'granted' || perm.speechRecognition !== 'granted') {
    perm = await requestPermission();
  }
  return perm.microphone === 'granted' && perm.speechRecognition === 'granted';
};

type RecognitionSessionOptions = {
  /** Text the transcript continues from. */
  base?: string;
  /** Whole transcript so far, including the segment still being recognized. */
  onTranscript: (text: string) => void;
  /** The session has already stopped itself. */
  onError: () => void;
};

// Chinese and Japanese, including their full-width punctuation, are written without spaces between words.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

const joinTranscript = (head: string, tail: string) => {
  if (!head) return tail;
  return UNSPACED.test(head.at(-1) ?? '') || UNSPACED.test(tail[0] ?? '') ? head + tail : `${head} ${tail}`;
};

/**
 * Starts recognizing and resolves to a function that stops it, settling once the engine has stopped.
 * The recognizer finalizes one segment at a time, so finished segments are joined in front of the current one.
 */
export const startRecognitionSession = async ({
  base = '',
  onTranscript,
  onError: onFailed,
}: RecognitionSessionOptions) => {
  let finished = base;
  let stopping: Promise<void> | undefined;
  const unlistenResult = await onResult((result) => {
    const text = joinTranscript(finished, result.transcript);
    if (result.isFinal) finished = text;
    onTranscript(text);
  });
  const unlistenError = await onError(() => {
    stop();
    onFailed();
  });
  const unlisten = () => {
    unlistenResult();
    unlistenError();
  };
  const stop = () => {
    if (!stopping) {
      unlisten();
      stopping = stopListening().catch(() => {
        // Recognition session may already have ended (e.g. after an error event).
      });
    }
    return stopping;
  };
  try {
    await startListening({ language: navigator.language, interimResults: true });
  } catch (error) {
    unlisten();
    throw error;
  }
  return stop;
};
