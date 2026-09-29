import { isTauri } from '@tauri-apps/api/core';
import {
  checkPermission,
  onError,
  onResult,
  type RecognitionResult,
  requestPermission,
  type SttError,
  startListening,
  stopListening,
} from 'tauri-plugin-stt-api';

export type { RecognitionResult, SttError };

// Mobile OS engines only (SFSpeechRecognizer / SpeechRecognizer); desktop has no plugin registered.
export const voiceSupported = isTauri() && /Android|iPhone|iPad/i.test(navigator.userAgent);

export const ensureVoicePermission = async () => {
  let perm = await checkPermission();
  if (perm.microphone !== 'granted' || perm.speechRecognition !== 'granted') {
    perm = await requestPermission();
  }
  return perm.microphone === 'granted' && perm.speechRecognition === 'granted';
};

export const listenVoiceResult = onResult;
export const listenVoiceError = onError;

export const startVoiceListening = () => startListening({ language: navigator.language, interimResults: true });

export const stopVoiceListening = stopListening;
