import {
  type SetMenuItemsOptions,
  clearMenuItems as tauriClearMenuItems,
  setMenuItems as tauriSetMenuItems,
} from 'tauri-plugin-selection-menu-api';

export const setSelectionMenuItems = async (options: SetMenuItemsOptions) => {
  try {
    await tauriSetMenuItems(options);
  } catch (err) {
    console.error(err);
  }
};

export const clearSelectionMenuItems = async () => {
  try {
    await tauriClearMenuItems();
  } catch (err) {
    console.error(err);
  }
};
