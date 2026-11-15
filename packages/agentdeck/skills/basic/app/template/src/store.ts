export type Item = { id: number; title: string; done: boolean };

export const store = createStore({
  items: [
    { id: 1, title: 'Read the template', done: true },
    { id: 2, title: 'Replace it with your app', done: false },
  ] as Item[],
});

export const toggleItem = (id: number) => {
  store({ items: store.items.map((item) => (item.id === id ? { ...item, done: !item.done } : item)) });
};

export const addItem = (title: string) => {
  store({ items: [...store.items, { id: Date.now(), title, done: false }] });
};
