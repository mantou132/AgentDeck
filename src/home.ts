import { icons } from '@mantou/tap-ui/lib/icons';
import { contentsContainer } from '@mantou/tap-ui/lib/styles';
import { theme } from '@mantou/tap-ui/lib/theme';
import { taskListStyle } from './starred';
import type { Category, Task } from './task';
import { addTask, deleteTask, taskStore, toggleStar, toggleTask } from './task';

type Filter = 'all' | 'active' | 'completed';

const categoryOptions: Category[] = ['工作', '生活', '灵感'];
const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '待办', value: 'active' },
  { label: '完成', value: 'completed' },
];

const style = css`
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75em;
    margin-block-end: 1em;
    padding: 0.8em 0.9em;
    border: 0.5px solid ${theme.borderColor};
    border-radius: ${theme.normalRound};
    background: ${theme.backgroundColor};
  }
  .summary-copy {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
  }
  .summary-copy span {
    color: ${theme.describeColor};
    font-size: 0.85em;
  }
  .summary-copy strong {
    color: ${theme.highlightColor};
    font-size: 1.1em;
  }
  .composer {
    display: flex;
    align-items: center;
    gap: 0.5em;
    margin-block-end: 1em;
    padding: 0.4em;
    border: 0.5px solid ${theme.borderColor};
    border-radius: ${theme.normalRound};
    background: ${theme.backgroundColor};
  }
  .task-input {
    width: 0;
    flex: 1 1 auto;
  }
  .category-select {
    height: 2.4em;
    flex: 0 0 auto;
    border: 0.5px solid ${theme.borderColor};
    border-radius: ${theme.smallRound};
    background: transparent;
    color: ${theme.textColor};
  }
  .add-button {
    flex: 0 0 auto;
  }
  .filter-row {
    margin-block-end: 1em;
  }
`;

@customElement('flowday-home')
@adoptedStyle(contentsContainer)
@adoptedStyle(taskListStyle)
@adoptedStyle(style)
@connectStore(taskStore)
export class FlowdayHomeElement extends GemElement {
  #state = createState({ draft: '', category: '工作' as Category, filter: 'all' as Filter });

  #onAdd = () => {
    const title = this.#state.draft.trim();
    if (!title) return;
    addTask(title, this.#state.category);
    this.#state({ draft: '', filter: 'all' });
  };

  #onInputChange = ({ detail }: CustomEvent<string>) => this.#state({ draft: detail });

  #onInputKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') this.#onAdd();
  };

  @template()
  #render = () => {
    const { draft, category, filter } = this.#state;
    const tasks = taskStore.tasks;
    const completed = tasks.filter((t) => t.done).length;
    const remaining = tasks.length - completed;
    const visible = tasks
      .filter((t) => {
        if (filter === 'active') return !t.done;
        if (filter === 'completed') return t.done;
        return true;
      })
      .sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
    const summary = remaining
      ? `还有 ${remaining} 件，按自己的节奏来。`
      : tasks.length
        ? '今天的任务都完成了。'
        : '从一件小事开始今天。';

    return html`
      <tap-page>
        <tap-navbar slot="header" title="今日"></tap-navbar>
        <tap-content>
          <div class="summary">
            <div class="summary-copy">
              <span>今日进度</span>
              <strong>${completed} / ${tasks.length}</strong>
            </div>
            <tap-tag small color=${tasks.length && completed === tasks.length ? 'positive' : 'default'}
              >${summary}</tap-tag
            >
          </div>

          <div class="composer">
            <tap-input
              class="task-input"
              placeholder="添加一件要做的事"
              clearable
              .value=${draft}
              @change=${this.#onInputChange}
              @keydown=${this.#onInputKeydown}
            ></tap-input>
            <select class="category-select" aria-label="任务分类" @change=${({ target }: Event) =>
              this.#state({ category: (target as HTMLSelectElement).value as Category })}>
              ${categoryOptions.map((c) => html`<option value=${c} selected=${c === category}>${c}</option>`)}
            </select>
            <tap-button class="add-button" square color="normal" aria-label="添加任务" .icon=${icons.add}
              @click=${this.#onAdd}
            ></tap-button>
          </div>

          <div class="filter-row">
            <tap-segmented
              .options=${filterOptions}
              .value=${filter}
              @change=${({ detail }: CustomEvent<Filter>) => this.#state({ filter: detail })}
            ></tap-segmented>
          </div>

          <div class="task-list">
            ${visible.length
              ? visible.map((task) => this.#renderTask(task))
              : html`
                  <div class="empty">
                    <tap-use .element=${icons.info}></tap-use>
                    <p>${filter === 'completed' ? '还没有已完成的任务' : '这里暂时没有任务'}</p>
                  </div>
                `}
          </div>
        </tap-content>
      </tap-page>
    `;
  };

  #renderTask = (task: Task) => html`
    <div class=${task.done ? 'task done' : 'task'}>
      <tap-checkbox
        aria-label=${task.done ? '标记为待完成' : '标记为已完成'}
        .checked=${task.done}
        @change=${() => toggleTask(task.id)}
      ></tap-checkbox>
      <div class="task-copy">
        <div class="task-title">${task.title}</div>
        <tap-tag small>${task.category}</tap-tag>
      </div>
      <tap-button
        class="star-button"
        square
        borderless
        aria-label=${task.starred ? '取消收藏' : '收藏'}
        .icon=${icons.star}
        @click=${() => toggleStar(task.id)}
      ></tap-button>
      <tap-button
        class="delete-button"
        square
        borderless
        color="danger"
        aria-label="删除任务"
        .icon=${icons.delete}
        @click=${() => deleteTask(task.id)}
      ></tap-button>
    </div>
  `;
}
