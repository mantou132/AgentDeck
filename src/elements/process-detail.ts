import { icons } from '@mantou/tap-ui/lib/icons';

import { getToolStatusLabel, i18n } from '../i18n';
import { markdownExtensions, markdownStyle } from '../lib/markdown';
import { getToolCommand, getToolStatus, type ProcessGroup } from '../session/timeline';

const style = css`
  :scope { display: block; }
  summary::-webkit-details-marker { display: none; }
`;

@customElement('deck-process-detail')
@adoptedStyle(style)
export class DeckProcessDetailElement extends GemElement {
  @property group?: ProcessGroup;

  @template()
  #render = () => {
    const { group } = this;
    if (!group?.items.length) {
      return html`<div class="py-10 text-center text-sm text-describe">${i18n.get('timeline.noProcess')}</div>`;
    }

    return html`
      <ol class="m-0 list-none p-0">
        ${group.items.map((item, index) => {
          const isThought = item.type === 'thought';
          const status = isThought
            ? group.pending && item.pending
              ? 'in_progress'
              : 'completed'
            : getToolStatus(item.data, group.pending);
          const isPending = status === 'pending' || status === 'in_progress';
          const hasDetail = isThought ? Boolean(item.text) : item.data.rawInput !== undefined;
          const heading = html`
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5">
                <span class="font-medium text-describe">${isThought ? i18n.get('timeline.thought') : i18n.get('timeline.toolCall')}</span>
                <span class=${classMap({
                  'text-describe': !isPending && status !== 'failed',
                  'text-primary-strong': isPending,
                  'text-negative': status === 'failed',
                })}>${getToolStatusLabel(status)}</span>
              </span>
              <span v-if=${!isThought} class="mt-1.5 block whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-text">${!isThought ? getToolCommand(item.data) : ''}</span>
            </span>
            <tap-use
              v-if=${hasDetail}
              class="mt-1 size-3.5 shrink-0 text-disabled transition-transform group-open/step:rotate-90"
              .element=${icons.right}
            ></tap-use>
          `;
          return html`
            <li class="flex gap-3">
              <div class="flex w-5 shrink-0 flex-col items-center">
                <tap-use
                  class=${classMap({
                    'mt-0.5 size-4 shrink-0': true,
                    'text-describe': !isPending && status !== 'failed',
                    'text-primary-strong': isPending,
                    'text-negative': status === 'failed',
                  })}
                  .element=${isPending ? icons.loading : status === 'failed' ? icons.error : isThought ? icons.schedule : icons.tune}
                ></tap-use>
                <span v-if=${index < group.items.length - 1} class="my-2 w-px flex-1 bg-border"></span>
              </div>
              <div class="min-w-0 flex-1 pb-6">
                ${
                  hasDetail
                    ? html`
                  <details class="group/step" ?open=${status === 'in_progress'}>
                    <summary class="flex min-h-11 cursor-pointer list-none items-start gap-3 outline-none select-none group-open/step:min-h-0">${heading}</summary>
                    <div class="pt-1.5">
                      ${
                        isThought
                          ? html`
                        <gem-bind-marked
                          class="text-base leading-relaxed text-text"
                          ?streaming=${isPending}
                          .mdStyle=${markdownStyle}
                          .extensions=${markdownExtensions}
                        >${item.text}</gem-bind-marked>
                      `
                          : html`
                        <p class="mt-0 mb-2 text-xs text-describe">${i18n.get('timeline.inputParams')}</p>
                        <pre class="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-bg p-3.5 font-mono text-sm leading-relaxed text-text">${JSON.stringify(item.data.rawInput, null, 2)}</pre>
                      `
                      }
                    </div>
                  </details>
                `
                    : html`<div class="flex min-h-11 items-start gap-3">${heading}</div>`
                }
              </div>
            </li>
          `;
        })}
      </ol>
    `;
  };
}
