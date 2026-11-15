import type { TemplateResult } from '@mantou/gem/lib/lit-html';
import { repeat } from '@mantou/gem/lib/repeat';

type SheetItem = { id: number; header: string; body: TemplateResult; open: boolean };

export const sheetStore = createStore({ sheets: [] as SheetItem[] });

let nextId = 0;

export type SheetOptions = { header?: string; body: TemplateResult };

/**
 * Opens a bottom sheet above every page and returns a function closing it.
 * Use this instead of Tap UI's `Sheet.open`, which renders `body` inside the sheet's shadow root
 * where Tailwind classes and Gem element styles don't apply.
 */
export const openSheet = ({ header = '', body }: SheetOptions) => {
  const id = nextId++;
  sheetStore({ sheets: [...sheetStore.sheets, { id, header, body, open: true }] });
  return () => closeSheet(id);
};

const closeSheet = (id: number) => {
  sheetStore({ sheets: sheetStore.sheets.map((sheet) => (sheet.id === id ? { ...sheet, open: false } : sheet)) });
  // Drop it once the close animation has played
  setTimeout(() => sheetStore({ sheets: sheetStore.sheets.filter((sheet) => sheet.id !== id) }), 500);
};

/** Renders the open sheets; mounted once at the end of `body` by `main.ts`. */
@customElement('app-sheet-host')
@connectStore(sheetStore)
export class AppSheetHostElement extends GemElement {
  @template()
  #render = () => html`
    ${repeat(
      sheetStore.sheets,
      (sheet) => sheet.id,
      (sheet) => html`
        <tap-sheet ?open=${sheet.open} mask-closable header=${sheet.header} @close=${() => closeSheet(sheet.id)}>
          ${sheet.body}
        </tap-sheet>
      `,
    )}
  `;
}
