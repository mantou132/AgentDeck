import { speechLanguage } from 'src/i18n';
import { speak, stop } from 'tauri-plugin-tts-api';

// Registered on mobile only, alongside speech recognition (see `isMobileApp`).
export const speakText = (text: string) => speak({ text, language: speechLanguage(), queueMode: 'flush' });

export const stopSpeaking = stop;
