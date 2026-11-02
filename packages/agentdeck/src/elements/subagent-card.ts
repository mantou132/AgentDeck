import { blockContainer } from '@mantou/tap-ui/lib/styles';
import type { ElicitationRequest, PermissionRequest } from '../agent/api';
import { i18n } from '../i18n';
import { openSubagent } from '../navigation';
import type { Subagent } from '../session/types';
import { getRuntime, sessionsStore } from '../state/store';
import { icons } from '../styles/icons';

/** Its current work is in progress; `requires_action` is blocked on the user. */
export const isSubagentActive = (subagent?: Subagent) =>
  subagent?.state?.state === 'running' || subagent?.state?.state === 'requires_action';

export const getSubagentTitle = (subagent?: Subagent) =>
  subagent?.title || subagent?.description || i18n.get('subagent.untitled');

export const getSubagentStatus = (subagent?: Subagent) => {
  const { state, stopReason } = subagent?.state ?? {};
  if (state === 'running') return i18n.get('subagent.running');
  if (state === 'requires_action') return i18n.get('subagent.requiresAction');
  if (state !== 'idle') return i18n.get('subagent.unknown');
  if (stopReason === 'end_turn') return i18n.get('subagent.finished');
  if (stopReason === 'cancelled') return i18n.get('subagent.cancelled');
  if (stopReason === 'error') return i18n.get('subagent.failed');
  return stopReason ? `${i18n.get('subagent.idle')} · ${stopReason}` : i18n.get('subagent.idle');
};

/** Labels a permission request or question that a subagent asked; empty for the session's own. */
export const getUserInputSource = ({ sessionId, childSessionId }: PermissionRequest | ElicitationRequest) =>
  childSessionId ? i18n.get('subagent.from', getSubagentTitle(getRuntime(sessionId).subagents?.[childSessionId])) : '';

/** A permission request or unanswered question of the subagent waits in its session. */
export const isSubagentWaiting = (sessionId: string, subagentId: string) => {
  const { permission, elicitations, subagents } = getRuntime(sessionId);
  return (
    subagents?.[subagentId]?.state?.state === 'requires_action' ||
    permission?.childSessionId === subagentId ||
    Boolean(elicitations?.some((item) => !item.response && item.request.childSessionId === subagentId))
  );
};

/** Subagent `subagentId` of session `sessionId`, where it was announced in a timeline. */
@customElement('deck-subagent-card')
@adoptedStyle(blockContainer)
@connectStore(sessionsStore)
export class DeckSubagentCardElement extends GemElement {
  @property sessionId = '';
  @property subagentId = '';

  @template()
  #render = () => {
    const subagent = getRuntime(this.sessionId).subagents?.[this.subagentId];
    const active = isSubagentActive(subagent);
    const failed = subagent?.state?.state === 'idle' && subagent.state.stopReason === 'error';
    const title = getSubagentTitle(subagent);
    return html`
      <button
        type="button"
        class="mb-4 flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-2xl border border-border bg-bg-light px-3.5 py-2.5 text-left text-text outline-none transition-colors active:bg-bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        title=${title}
        @click=${() => openSubagent(this.sessionId, this.subagentId)}
      >
        <tap-use
          class=${classMap({
            'size-4 shrink-0': true,
            'text-primary-strong': active,
            'text-negative': failed,
            'text-describe': !active && !failed,
          })}
          .element=${active ? icons.loading : failed ? icons.error : icons.sparkles}
        ></tap-use>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-semibold text-highlight">${title}</span>
          <span class="truncate text-xs text-describe">${getSubagentStatus(subagent)}</span>
        </span>
        <span
          v-if=${isSubagentWaiting(this.sessionId, this.subagentId)}
          class="inline-flex shrink-0 items-center gap-1 rounded-full bg-notice/10 px-2 py-0.5 text-xs font-semibold text-notice"
        >
          <span class="size-1.5 animate-pulse rounded-full bg-notice"></span>
          ${i18n.get('session.permission')}
        </span>
        <tap-use class="size-3.5 shrink-0 text-disabled" .element=${icons.right}></tap-use>
      </button>
    `;
  };
}
