import { Toast } from '@mantou/tap-ui/elements/toast';
import { getStringFromTemplate } from '@mantou/tap-ui/lib/utils';
import { DuoyunWakeLockBaseElement } from 'duoyun-ui/elements/base/wake-lock';
import type { ElicitationResponse } from '../agent/api';
import { i18n } from '../i18n';
import { followBottom } from '../lib/follow-bottom';
import { hapticImpact, hapticSelection, hapticWarning } from '../lib/haptics';
import { ensureRecognitionPermission, startRecognitionSession } from '../lib/speech-recognition';
import { speakText, stopSpeaking } from '../lib/speech-synthesis';
import { getElicitationQuestions } from '../session/elicitation';
import { replySpeech } from '../session/voice-chat';
import { agentdeckStore } from '../state/store';
import { answerElicitation, resolvePermission } from '../state/user-input';
import { icons } from '../styles/icons';
import type { ComposerInput } from './composer';

type VoiceEntry = { id: string; role: 'user' | 'agent'; text: string };
type PressZone = 'talk' | 'trim' | 'cancel';

// The trim band is `RULER_GAP` above the button and as wide as it. Below the band keeps talking, above it cancels.
// The ticks are drawn above the band (`pb-[68px]`) so the finger doesn't cover them, under a 24px fade that covers
// the transcript.
const RULER_GAP = 12;
const RULER_HEIGHT = 56;
// One tick per undo unit, matching the `w-3` tick slots.
const TICK_SPACING = 12;
const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value));

// Undo units are words (the segmenter also splits CJK into words), each carrying the spaces and punctuation after it.
const splitUnits = (text: string) => {
  const units: string[] = [];
  for (const { segment, isWordLike } of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (isWordLike || !units.length) units.push(segment);
    else units[units.length - 1] += segment;
  }
  return units;
};

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

  #state = createState({
    entries: [] as VoiceEntry[],
    listening: false,
    /** Recognition is running; while held it can also have stopped on an error or been dropped while starting. */
    recording: false,
    starting: false,
    transcript: '',
    zone: 'talk' as PressZone,
    removed: 0,
    /** Ruler x of the transcript end, set once the finger leaves the button; each tick to its left undoes one more unit. */
    anchor: undefined as number | undefined,
  });
  #listRef = createRef<HTMLElement>();
  #follow?: ReturnType<typeof followBottom>;
  #listContentRef = createRef<HTMLElement>();
  #pressed = false;
  #releasePress?: () => void;
  #stopRecording?: () => Promise<void>;
  // The last recognition stop; starting again or vibrating has to wait for the audio session to end.
  #stopping = Promise.resolve();
  // Current recognition session, cleared once it should stop; a session that is still starting then drops itself.
  #session?: symbol;
  // Transcript split once recognition stops, for trimming.
  #units: string[] = [];
  // A voice chat prompt was accepted; its reply is read aloud once the turn ends.
  #awaiting = false;
  #turnStarted = false;

  get #pending() {
    return agentdeckStore.pendingSessionIds.includes(this.sessionId);
  }

  get #permission() {
    return agentdeckStore.permissionsBySession[this.sessionId];
  }

  get #elicitation() {
    return agentdeckStore.elicitationsBySession[this.sessionId]?.find((elicitation) => !elicitation.response);
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
    const button = event.currentTarget as HTMLElement;
    button.setPointerCapture(event.pointerId);
    if (!this.ready || this.#pending) {
      hapticWarning();
      this.#say(i18n.get(this.ready ? 'voiceChat.busy' : 'voiceChat.notReady'));
      return;
    }
    // Another finger while one is already holding.
    if (this.#pressed) return;
    this.#pressed = true;
    this.#units = [];
    this.#trackPress(button, event.pointerId);
    stopSpeaking().catch(() => {});
    try {
      if (!(await ensureRecognitionPermission())) {
        Toast.open('warning', i18n.get('speechRecognition.permissionDenied'));
        return;
      }
    } catch {
      Toast.open('error', i18n.get('speechRecognition.unavailable'));
      return;
    }
    // Permission prompt may outlast the press.
    if (!this.#pressed) return;
    // Released or slid off while starting: nothing was recognized yet, so there is nothing to send.
    if (await this.#record('')) this.#state({ listening: true });
  };

  /** Recognizes on top of `base`; resolves to whether the session is still wanted once started. */
  #record = async (base: string) => {
    const session = Symbol();
    this.#session = session;
    this.#state({ starting: true });
    this.#state({ transcript: base });
    try {
      await this.#stopping;
      // Vibrate before the audio session starts; iOS suppresses haptics while recording.
      await hapticImpact('medium');
      const stop = await startRecognitionSession({
        base,
        onTranscript: (transcript) => {
          if (this.#session === session) this.#state({ transcript });
        },
        // Recognizers end with an error when nothing was said; what was recognized stays for sending.
        onError: () => {
          if (this.#session !== session) return;
          this.#stopListening();
          this.#stopping.then(hapticWarning);
        },
      });
      if (this.#session !== session) {
        this.#stopping = stop();
        return false;
      }
      this.#stopRecording = stop;
      this.#state({ recording: true });
      return true;
    } catch {
      Toast.open('error', i18n.get('speechRecognition.unavailable'));
      return false;
    } finally {
      this.#state({ starting: false });
    }
  };

  get #keptText() {
    const { transcript, removed } = this.#state;
    return removed ? this.#units.slice(0, -removed).join('') : transcript;
  }

  // Leaving the button stops recognition and shows the trim ruler; sliding beyond it cancels,
  // and coming back to the button keeps recording after what is left.
  // The sheet's drag gesture captures the pointer once it moves vertically, so the press is tracked on window
  // ahead of it and its moves are kept from the sheet.
  #trackPress = (button: HTMLElement, pointerId: number) => {
    const locate = ({ clientX, clientY }: PointerEvent) => {
      const { left, top, width } = button.getBoundingClientRect();
      const y = top - clientY;
      const zone: PressZone = y <= RULER_GAP ? 'talk' : y <= RULER_GAP + RULER_HEIGHT ? 'trim' : 'cancel';
      return { zone, x: clamp(0, clientX - left, width) };
    };
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== pointerId) return;
        event.stopPropagation();
        const { zone, x } = locate(event);
        let { anchor, removed } = this.#state;
        // A session still starting has already been dropped by leaving; it can be resumed on the next return.
        const resume = zone === 'talk' && anchor !== undefined && this.#state.listening && !this.#state.starting;
        if (resume) {
          this.#record(this.#keptText.trim());
          anchor = undefined;
          removed = 0;
        }
        if (zone !== 'talk' && anchor === undefined) {
          this.#stopListening();
          anchor = x;
          // Keep the transcript in view above the ruler while trimming.
          this.#follow?.resume();
        }
        if (anchor !== undefined && zone === 'trim') {
          // Entering the band again continues from the current cut; sliding past either end drags the ruler along.
          if (this.#state.zone !== 'trim') anchor = x + removed * TICK_SPACING;
          anchor = clamp(x, anchor, x + this.#units.length * TICK_SPACING);
          removed = Math.round((anchor - x) / TICK_SPACING);
        }
        if (zone === this.#state.zone && removed === this.#state.removed && anchor === this.#state.anchor) return;
        // Recording vibrates itself when resuming; leaving has to wait for recognition to stop.
        if (!resume && (zone !== this.#state.zone || removed !== this.#state.removed))
          this.#stopping.then(hapticSelection);
        this.#state({ zone, removed, anchor });
      },
      options,
    );
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      this.#finishTalk(event.type === 'pointerup' && locate(event).zone !== 'cancel');
    };
    addEventListener('pointerup', end, options);
    addEventListener('pointercancel', end, options);
    this.#releasePress = () => controller.abort();
  };

  #stopListening = () => {
    this.#session = undefined;
    if (this.#stopRecording) this.#stopping = this.#stopRecording();
    this.#stopRecording = undefined;
    this.#state({ recording: false });
    this.#units = splitUnits(this.#state.transcript);
  };

  #finishTalk = async (send: boolean) => {
    this.#pressed = false;
    this.#releasePress?.();
    const { listening } = this.#state;
    this.#stopListening();
    const text = this.#keptText.trim();
    this.#state({ listening: false, transcript: '', zone: 'talk', removed: 0, anchor: undefined });
    if (!listening || !send || !text) return;
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

  // Only the number of questions is read; options are picked on screen.
  @effect((i) => [i.#elicitation?.request])
  #announceElicitation = () => {
    const request = this.#elicitation?.request;
    if (!this.active || !request) return;
    this.#say(getStringFromTemplate(i18n.get('voiceChat.question', String(getElicitationQuestions(request).length))));
  };

  @effect((i) => [i.#listRef.value, i.#listContentRef.value])
  #followList = () => {
    this.#follow = followBottom(this.#listRef.value, this.#listContentRef.value);
    return this.#follow?.disconnect;
  };

  @effect((i) => [i.active])
  #stopOnClose = () => {
    if (this.active) return;
    this.#finishTalk(false);
    stopSpeaking().catch(() => {});
  };

  @unmounted()
  #cleanup = () => {
    this.#releasePress?.();
    this.#stopListening();
    stopSpeaking().catch(() => {});
  };

  #renderRuler = (anchor: number) => {
    const { zone, removed } = this.#state;
    const count = this.#units.length;
    // Ticks run from the transcript start on the left to its end at `anchor`.
    const offset = anchor - count * TICK_SPACING - TICK_SPACING / 2;
    return html`
      <div
        class="pointer-events-none absolute inset-x-0 bottom-full overflow-hidden bg-linear-to-b from-transparent to-bg to-[24px] pt-6 pb-[68px]"
      >
        <div
          class=${classMap({ 'flex h-10 items-end': true, 'opacity-40': zone === 'cancel' })}
          style=${styleMap({ transform: `translateX(${offset}px)` })}
        >
          ${Array.from({ length: count + 1 }, (_, slot) => {
            const index = count - slot;
            return html`
              <div class="flex w-3 shrink-0 justify-center">
                <div
                  class=${classMap({
                    'w-px': true,
                    'h-7 bg-text': index === removed,
                    'h-3 bg-text': index > removed,
                    'h-3 bg-disabled': index < removed,
                  })}
                ></div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  };

  #renderTranscript = () => {
    const { removed } = this.#state;
    if (!removed) return this.#keptText || '…';
    return html`<span class="text-text">${this.#keptText}</span><span class="text-disabled"
      >${this.#units.slice(-removed).join('')}</span
    >`;
  };

  @template()
  #render = () => {
    const { entries, listening, recording, starting, zone, anchor } = this.#state;
    const pending = this.#pending;
    const permission = this.#permission;
    const elicitation = this.#elicitation;
    return html`
      <div class="flex h-full flex-col gap-3">
        <div ${this.#listRef} class="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div
            ${this.#listContentRef}
            class=${classMap({
              'flex min-h-full flex-col gap-2.5 pt-2': true,
              // The ruler overlay covers the list bottom; following the bottom lifts the transcript above it.
              'pb-2': anchor === undefined,
              'pb-32': anchor !== undefined,
            })}
          >
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
              class="max-w-[86%] self-end rounded-[19px] rounded-br-[5px] bg-primary-soft/60 px-4 py-2.5 text-base leading-[1.6] text-describe ${zone === 'cancel' ? 'line-through opacity-60' : ''}"
            >
              ${this.#renderTranscript()}
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
        <deck-elicitation
          v-if=${!!elicitation}
          class="max-h-[45dvh] shrink-0 overflow-y-auto overscroll-y-contain"
          .elicitation=${elicitation}
          @respond=${(event: CustomEvent<ElicitationResponse>) =>
            elicitation && answerElicitation(elicitation.request, event.detail)}
        ></deck-elicitation>
        <div class="relative shrink-0">
          ${listening && anchor !== undefined ? this.#renderRuler(anchor) : ''}
          <button
            type="button"
            class=${classMap({
              'flex h-12 w-full cursor-pointer touch-none select-none items-center justify-center gap-2 rounded-xl border-0 text-sm font-semibold transition-transform [-webkit-touch-callout:none]': true,
              'scale-[0.985] bg-primary-strong text-white': listening && zone !== 'cancel',
              'bg-negative text-white': listening && zone === 'cancel',
              'bg-primary text-white': !listening && this.ready && !pending,
              'bg-border text-disabled': !listening && (!this.ready || pending),
            })}
            aria-label=${i18n.get('voiceChat.hold')}
            @pointerdown=${this.#startTalk}
            @contextmenu=${(event: Event) => event.preventDefault()}
          >
            <tap-use class="size-[18px]" .element=${icons.mic}></tap-use>
            ${listening ? i18n.get(zone === 'cancel' ? 'voiceChat.releaseCancel' : zone === 'trim' ? 'voiceChat.releaseTrim' : recording || starting ? 'voiceChat.release' : 'voiceChat.paused') : pending ? i18n.get('voiceChat.working') : i18n.get('voiceChat.hold')}
          </button>
        </div>
      </div>
    `;
  };
}
