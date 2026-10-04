import { Toast } from '@mantou/tap-ui/elements/toast';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { DuoyunWakeLockBaseElement } from 'duoyun-ui/elements/base/wake-lock';
import { i18n } from '../i18n';
import { followBottom } from '../lib/follow-bottom';
import { hapticImpact, hapticSelection, hapticWarning } from '../lib/haptics';
import { ensureRecognitionPermission, startRecognitionSession } from '../lib/speech-recognition';
import { speakText, stopSpeaking } from '../lib/speech-synthesis';
import { replySpeech } from '../session/voice-chat';
import { resolvePermission } from '../state/sessions';
import { agentdeckStore } from '../state/store';
import { icons } from '../styles/icons';
import type { ComposerInput } from './composer';

type VoiceEntry = { id: string; role: 'user' | 'agent'; text: string };

/**
 * Push-to-talk chat for the session in a sheet: sends transcripts as voice chat prompts and reads each reply's summary aloud.
 * Keeps the screen on while shown, since a locked phone suspends the webview and its Relay connection.
 */
@customElement('deck-voice-chat')
@connectStore(agentdeckStore)
export class DeckVoiceChatElement extends DuoyunWakeLockBaseElement {
  @property sessionId = '';
  @property submit?: (input: ComposerInput) => boolean | Promise<boolean>;
  @boolattribute ready: boolean;
  /** Whether the sheet is open; closing it stops recording and playback. */
  @boolattribute active: boolean;

  #state = createState({ entries: [] as VoiceEntry[], listening: false, transcript: '', outside: false });
  #listRef = createRef<HTMLElement>();
  #listContentRef = createRef<HTMLElement>();
  #pressed = false;
  #stopRecording?: () => void;
  // A voice chat prompt was accepted; its reply is read aloud once the turn ends.
  #awaiting = false;
  #turnStarted = false;

  get #pending() {
    return agentdeckStore.pendingSessionIds.includes(this.sessionId);
  }

  get #permission() {
    return agentdeckStore.permissionsBySession[this.sessionId];
  }

  #say = async (text: string) => {
    try {
      await speakText(text);
    } catch {
      Toast.open('error', i18n.get('voiceChat.speakFailed'));
    }
  };

  #addEntry = (role: VoiceEntry['role'], text: string) => {
    this.#state({ entries: [...this.#state.entries, { id: crypto.randomUUID(), role, text }] });
  };

  #startTalk = async (event: PointerEvent) => {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (!this.ready || this.#pending) {
      hapticWarning();
      this.#say(i18n.get(this.ready ? 'voiceChat.busy' : 'voiceChat.notReady'));
      return;
    }
    this.#pressed = true;
    stopSpeaking().catch(() => {});
    try {
      if (!(await ensureRecognitionPermission())) {
        Toast.open('warning', i18n.get('speechRecognition.permissionDenied'));
        return;
      }
      // Permission prompt may outlast the press.
      if (!this.#pressed) return;
      this.#state({ transcript: '' });
      // Vibrate before the audio session starts; iOS suppresses haptics while recording.
      await hapticImpact('medium');
      this.#stopRecording = await startRecognitionSession({
        onTranscript: (transcript) => this.#state({ transcript }),
        onError: () => {
          // Recognizers end with an error when nothing was said; only a lost transcript is worth reporting.
          if (this.#state.transcript.trim()) Toast.open('error', i18n.get('speechRecognition.failed'));
          this.#state({ listening: false });
        },
      });
      this.#state({ listening: true });
      // Released while starting: nothing was recognized yet, so there is nothing to send.
      if (!this.#pressed) this.#finishTalk(false);
    } catch {
      Toast.open('error', i18n.get('speechRecognition.unavailable'));
    }
  };

  // Sliding off the button cancels, like letting go outside it.
  #moveTalk = (event: PointerEvent) => {
    if (!this.#pressed) return;
    const { left, right, top, bottom } = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const outside = event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
    if (outside === this.#state.outside) return;
    hapticSelection();
    this.#state({ outside });
  };

  #stopListening = () => {
    if (!this.#state.listening) return;
    this.#stopRecording?.();
    this.#state({ listening: false });
  };

  #finishTalk = async (send: boolean) => {
    this.#pressed = false;
    this.#state({ outside: false });
    if (!this.#state.listening) return;
    this.#stopListening();
    const text = this.#state.transcript.trim();
    this.#state({ transcript: '' });
    if (!send || !text) return;
    this.#addEntry('user', text);
    this.#awaiting = true;
    this.#turnStarted = false;
    const accepted = await this.submit?.({ text, attachments: [], voiceChat: true });
    if (!accepted) {
      this.#awaiting = false;
      this.#addEntry('agent', i18n.get('voiceChat.sendFailed'));
      this.#say(i18n.get('voiceChat.sendFailed'));
    }
  };

  #readReply = () => {
    const messages = agentdeckStore.messagesBySession[this.sessionId] ?? [];
    const turnStart = messages.findLastIndex((message) => 'role' in message && message.role === 'user');
    const reply = messages
      .slice(turnStart + 1)
      .findLast((message) => 'role' in message && message.role === 'agent' && message.text.trim());
    const text =
      (reply && 'role' in reply && replySpeech(reply.text)) ||
      agentdeckStore.errorsBySession[this.sessionId] ||
      i18n.get('voiceChat.noReply');
    this.#addEntry('agent', text);
    this.#say(text);
  };

  // A new session first runs as `pending-session` and is then promoted to its real ID while still running,
  // so only the end of a turn under the final ID counts.
  @effect((i) => [i.sessionId, i.#pending])
  #watchTurn = () => {
    if (!this.#awaiting) return;
    if (this.#pending) {
      this.#turnStarted = true;
    } else if (this.#turnStarted && this.sessionId !== 'pending-session') {
      this.#awaiting = false;
      this.#readReply();
    }
  };

  @effect((i) => [i.#permission])
  #announcePermission = () => {
    const request = this.#permission;
    if (!this.active || !request) return;
    this.#say(
      getStringFromTemplate(
        i18n.get('voiceChat.permission', request.toolCall?.title || i18n.get('permission.toolCall')),
      ),
    );
  };

  @effect((i) => [i.#listRef.value, i.#listContentRef.value])
  #followList = () => followBottom(this.#listRef.value, this.#listContentRef.value)?.disconnect;

  @effect((i) => [i.active])
  #stopOnClose = () => {
    if (this.active) return;
    this.#finishTalk(false);
    stopSpeaking().catch(() => {});
  };

  @unmounted()
  #cleanup = () => {
    this.#stopListening();
    stopSpeaking().catch(() => {});
  };

  @template()
  #render = () => {
    const { entries, listening, transcript, outside } = this.#state;
    const pending = this.#pending;
    const permission = this.#permission;
    return html`
      <div class="flex h-full flex-col gap-3">
        <div ${this.#listRef} class="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div ${this.#listContentRef} class="flex min-h-full flex-col gap-2.5 py-2">
            <p v-if=${!entries.length && !listening} class="m-auto max-w-[260px] text-center text-sm leading-relaxed text-describe">
              ${i18n.get('voiceChat.empty')}
            </p>
            ${entries.map(
              (entry) => html`
                <div
                  class=${classMap({
                    'max-w-[86%] select-text rounded-[19px] px-4 py-2.5 text-base leading-[1.6] whitespace-pre-wrap break-words': true,
                    'self-end rounded-br-[5px] bg-primary-soft text-highlight': entry.role === 'user',
                    'self-start rounded-bl-[5px] bg-bg-light text-text': entry.role === 'agent',
                  })}
                >
                  ${entry.text}
                </div>
              `,
            )}
            <div
              v-if=${listening}
              class="max-w-[86%] self-end rounded-[19px] rounded-br-[5px] bg-primary-soft/60 px-4 py-2.5 text-base leading-[1.6] text-describe ${outside ? 'line-through opacity-60' : ''}"
            >
              ${transcript || '…'}
            </div>
            <div v-if=${pending && !listening} class="flex items-center gap-1.5 self-start px-1 text-sm text-describe">
              <tap-use class="size-4 text-primary" .element=${icons.loading}></tap-use>
              ${i18n.get('voiceChat.working')}
            </div>
          </div>
        </div>
        <deck-permission-request
          v-if=${!!permission}
          .request=${permission}
          @resolve=${(event: CustomEvent<string | null>) => resolvePermission(this.sessionId, event.detail)}
        ></deck-permission-request>
        <button
          type="button"
          class=${classMap({
            'flex h-12 w-full shrink-0 cursor-pointer touch-none select-none items-center justify-center gap-2 rounded-xl border-0 text-sm font-semibold transition-transform [-webkit-touch-callout:none]': true,
            'scale-[0.985] bg-primary-strong text-white': listening && !outside,
            'bg-negative text-white': listening && outside,
            'bg-primary text-white': !listening && this.ready && !pending,
            'bg-border text-disabled': !listening && (!this.ready || pending),
          })}
          aria-label=${i18n.get('voiceChat.hold')}
          @pointerdown=${this.#startTalk}
          @pointermove=${this.#moveTalk}
          @pointerup=${() => this.#finishTalk(!this.#state.outside)}
          @pointercancel=${() => this.#finishTalk(false)}
          @contextmenu=${(event: Event) => event.preventDefault()}
        >
          <tap-use class="size-[18px]" .element=${icons.mic}></tap-use>
          ${listening ? i18n.get(outside ? 'voiceChat.releaseCancel' : 'voiceChat.release') : pending ? i18n.get('voiceChat.working') : i18n.get('voiceChat.hold')}
        </button>
      </div>
    `;
  };
}
