import { createStore } from '@mantou/gem';

export type Category = '工作' | '生活' | '灵感';

export interface Task {
  id: string;
  title: string;
  category: Category;
  done: boolean;
  starred: boolean;
  createdAt: number;
}

export const STORAGE_KEY = 'flowday.tasks.v2';

const seedTasks: Task[] = [
  {
    id: 'welcome-1',
    title: '整理今天最重要的三件事',
    category: '工作',
    done: true,
    starred: false,
    createdAt: Date.now() - 3,
  },
  {
    id: 'welcome-2',
    title: '散步二十分钟',
    category: '生活',
    done: false,
    starred: false,
    createdAt: Date.now() - 2,
  },
  {
    id: 'welcome-3',
    title: '记录一个新想法',
    category: '灵感',
    done: false,
    starred: true,
    createdAt: Date.now() - 1,
  },
];

function loadTasks(): Task[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return seedTasks;
    const parsed = JSON.parse(value) as Task[];
    return Array.isArray(parsed) ? parsed : seedTasks;
  } catch {
    return seedTasks;
  }
}

export const taskStore = createStore({
  tasks: loadTasks(),
});

export function saveTasks(tasks: Task[]) {
  taskStore({ tasks });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function addTask(title: string, category: Category) {
  saveTasks([
    ...taskStore.tasks,
    {
      id: crypto.randomUUID(),
      title,
      category,
      done: false,
      starred: false,
      createdAt: Date.now(),
    },
  ]);
}

export function toggleTask(id: string) {
  saveTasks(taskStore.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
}

export function toggleStar(id: string) {
  saveTasks(taskStore.tasks.map((t) => (t.id === id ? { ...t, starred: !t.starred } : t)));
}

export function deleteTask(id: string) {
  saveTasks(taskStore.tasks.filter((t) => t.id !== id));
}
