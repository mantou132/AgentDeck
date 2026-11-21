import { speak, stop } from 'tauri-plugin-tts-api';
import { speechLanguage } from '../i18n';

// Registered on mobile only, alongside speech recognition (see `speechSupported`).
export const speakText = (text: string) => speak({ text, language: speechLanguage(), queueMode: 'flush' });

export const stopSpeaking = stop;
