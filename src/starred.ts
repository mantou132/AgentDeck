import { icons } from "@mantou/tap-ui/lib/icons";
import { contentsContainer } from "@mantou/tap-ui/lib/styles";
import { theme } from "@mantou/tap-ui/lib/theme";
import { taskStore, toggleStar } from "./task";

export const taskListStyle = css`
  .task-list {
    display: flex;
    flex-direction: column;
    gap: 0.75em;
  }

  .task {
    display: flex;
    align-items: center;
    gap: 0.75em;
    padding: 0.8em 0.75em;
    border: 0.5px solid ${theme.borderColor};
    border-radius: ${theme.normalRound};
    background: ${theme.backgroundColor};
  }

  .task.done .task-title {
    color: ${theme.describeColor};
    text-decoration: line-through;
  }

  .task-copy {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
  }

  .task-title {
    font-weight: 600;
    color: ${theme.highlightColor};
    overflow-wrap: anywhere;
  }

  .star-button::part(button),
  .delete-button::part(button) {
    min-width: 0;
    height: 100%;
    padding: 0;
  }

  .empty {
    display: grid;
    min-height: 160px;
    place-items: center;
    align-content: center;
    gap: 0.75em;
    color: ${theme.describeColor};
    text-align: center;
  }

  .empty tap-use {
    width: 28px;
    height: 28px;
  }

  .empty p {
    margin: 0;
    font-size: 0.875em;
  }
`;

@customElement("flowday-starred")
@adoptedStyle(contentsContainer)
@adoptedStyle(taskListStyle)
@connectStore(taskStore)
export class FlowdayStarredElement extends GemElement {
  @template()
  #render = () => {
    const starred = taskStore.tasks
      .filter((t) => t.starred)
      .sort((a, b) => b.createdAt - a.createdAt);

    return html`
      <tap-page>
        <tap-navbar slot="header" title="收藏"></tap-navbar>
        <tap-content>
          <div class="task-list">
            ${
              starred.length
                ? starred.map(
                    (task) => html`
                      <div class=${task.done ? "task done" : "task"}>
                        <div class="task-copy">
                          <div class="task-title">${task.title}</div>
                          <tap-tag small>${task.category}</tap-tag>
                        </div>
                        <tap-button
                          class="star-button"
                          square
                          borderless
                          aria-label="取消收藏"
                          .icon=${icons.star}
                          @click=${() => toggleStar(task.id)}
                        ></tap-button>
                      </div>
                    `,
                  )
                : html`
                    <div class="empty">
                      <tap-use .element=${icons.star}></tap-use>
                      <p>还没有收藏的任务</p>
                    </div>
                  `
            }
          </div>
        </tap-content>
      </tap-page>
    `;
  };
}
