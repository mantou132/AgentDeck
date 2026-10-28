import type { Emitter } from '@mantou/gem/lib/decorators';
import { displayPath } from 'agentdeck/lib/path';
import { icons } from 'agentdeck/styles/icons';
import type { SessionRecord } from '../../shared/agent-session-store';
import { t } from '../../shared/i18n';

@customElement('agent-session-list')
export class AgentSessionListElement extends GemElement {
  @boolattribute compact: boolean;
  /** Persisted sessions plus at most one in-memory draft. */
  @property sessions: SessionRecord[] = [];
  @property sessionKey: string | null = null;
  @property home = '';
  @property loadingIds: string[] = [];
  /** Local session key being deleted. */
  @property deleting: string | null = null;

  /** Detail: local session key. */
  @emitter select: Emitter<string>;
  @emitter create: Emitter;
  /** Detail: local session key. */
  @emitter remove: Emitter<string>;

  @template()
  #content = () => {
    const { compact, sessions, sessionKey, home, loadingIds, deleting } = this;
    const sessionOptions = sessions.length
      ? sessions.map((session) => {
          const title = session.title || t('devtoolsPanelNewSession');
          const cwd = displayPath(session.cwd || '', home);
          return {
            label: html`
              <agent-session-option-label
                .sessionAgent=${session.agent}
                .sessionTitle=${title}
              ></agent-session-option-label>
            `,
            description: cwd || undefined,
            value: session.key,
          };
        })
      : [{ label: t('devtoolsPanelNoSessions'), value: '' }];

    return html`
      <aside
        class=${
          compact
            ? 'flex shrink-0 flex-col border-b border-border bg-bg-light/30'
            : 'flex w-64 shrink-0 flex-col border-r border-border bg-bg-light/30'
        }
      >
        <header
          class=${
            compact ? 'bg-bg px-3 py-2.5' : 'flex items-center justify-between gap-2 border-b border-border px-3 py-2.5'
          }
        >
          <div class="flex w-full items-center justify-between gap-2">
            <dy-picker
              v-if=${compact}
              class="min-w-0 flex-1 font-semibold"
              borderless
              fit
              .options=${sessionOptions}
              .value=${sessionKey}
              placeholder=${t('devtoolsPanelNoSessions')}
              @change=${(e: CustomEvent<string>) => this.select(e.detail)}
              aria-label=${t('devtoolsPanelSessions')}
            ></dy-picker>
            <span v-else class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
            <div class="flex items-center gap-1">
              <dy-button
                v-if=${compact && !!sessionKey && !loadingIds.includes(sessionKey) && deleting !== sessionKey}
                small
                square
                color="cancel"
                .icon=${icons.delete}
                title=${t('devtoolsPanelDelete')}
                @click=${() => sessionKey && this.remove(sessionKey)}
              ></dy-button>
              <dy-button small .icon=${icons.add} @click=${() => this.create()}>
                ${t('devtoolsPanelNew')}
              </dy-button>
            </div>
          </div>
        </header>
        <ul v-if=${!compact} class="m-0 flex-1 list-none overflow-auto p-0">
          <li v-if=${!sessions.length} class="px-3 py-4 text-center text-xs text-describe">
            ${t('devtoolsPanelNoSessions')}
          </li>
          ${sessions.map(
            (session) => html`
              <agent-session-item
                .session=${session}
                .home=${home}
                ?active=${session.key === sessionKey}
                ?loading=${loadingIds.includes(session.key)}
                ?deleting=${deleting === session.key}
                @select=${() => this.select(session.key)}
                @delete=${() => this.remove(session.key)}
              ></agent-session-item>
            `,
          )}
        </ul>
      </aside>
    `;
  };
}
