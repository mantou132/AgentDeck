/**
 * Script setting `--safe-area-inset-*` in edge-to-edge preview pages. Frames are cross-origin and cannot
 * read the App's insets (inline styles from the edge-to-edge plugin), so the current values are baked in.
 */
export const getSafeAreaScript = () => {
  const insets = Object.fromEntries(
    ['top', 'right', 'bottom', 'left'].map((side) => {
      const name = `--safe-area-inset-${side}`;
      return [name, document.documentElement.style.getPropertyValue(name) || '0px'];
    }),
  );
  return `for (const [name, value] of Object.entries(${JSON.stringify(insets)})) document.documentElement.style.setProperty(name, value);`;
};
