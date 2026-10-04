import { speak, stop } from 'tauri-plugin-tts-api';

// Registered on mobile only, alongside speech recognition (see `speechSupported`).
export const speakText = (text: string) => speak({ text, language: navigator.language, queueMode: 'flush' });

export const stopSpeaking = stop;
