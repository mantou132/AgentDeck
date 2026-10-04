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

/**
 * Starts recognizing and resolves to a function that stops it. The recognizer finalizes one segment at a time,
 * so finished segments are joined in front of the current one.
 */
export const startRecognitionSession = async ({
  base = '',
  onTranscript,
  onError: onFailed,
}: RecognitionSessionOptions) => {
  let finished = base;
  let stopped = false;
  const unlistenResult = await onResult((result) => {
    const text = finished ? `${finished} ${result.transcript}` : result.transcript;
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
    if (stopped) return;
    stopped = true;
    unlisten();
    stopListening().catch(() => {
      // Recognition session may already have ended (e.g. after an error event).
    });
  };
  try {
    await startListening({ language: navigator.language, interimResults: true });
  } catch (error) {
    unlisten();
    throw error;
  }
  return stop;
};
