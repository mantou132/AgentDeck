// Voice chat prompts carry `voiceChat: true`; the daemon appends this marker, which its app system prompt explains.
// History replays it as part of the user message, so the timeline strips it.
const VOICE_MARKER = '<agentdeck-voice-chat/>';

export const stripVoiceChatMarker = (text: string) =>
  text.includes(VOICE_MARKER) ? text.replace(VOICE_MARKER, '').trim() : text;

// An HTML comment, so other clients showing this session hide it too.
const speechCommentPattern = /<!--\s*agentdeck-speech\b([\s\S]*?)-->/g;

const MAX_FALLBACK_LENGTH = 200;

/** Plain text to read aloud for an agent reply: its `agentdeck-speech` comment, else the start of the reply without Markdown. */
export const replySpeech = (markdown: string) => {
  const spoken = [...markdown.matchAll(speechCommentPattern)].at(-1)?.[1].trim();
  if (spoken) return spoken;
  const plain = markdown
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > MAX_FALLBACK_LENGTH ? `${plain.slice(0, MAX_FALLBACK_LENGTH)}…` : plain;
};
