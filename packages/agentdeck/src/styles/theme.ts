import { extendTheme } from '@mantou/tap-ui/lib/theme';

import './icons';
import './tailwind.css';

export const agentDeckTheme = extendTheme({
  colorScheme: 'light dark',
  primaryColor: 'var(--color-primary)',
  highlightColor: 'var(--color-highlight)',
  textColor: 'var(--color-text)',
  describeColor: 'var(--color-describe)',
  backgroundColor: 'var(--color-bg)',
  lightBackgroundColor: 'var(--color-bg-light)',
  hoverBackgroundColor: 'var(--color-bg-hover)',
  borderColor: 'var(--color-border)',
  disabledColor: 'var(--color-disabled)',
  controlShadow: 'var(--shadow-card)',
  informativeColor: 'var(--color-informative)',
  neutralColor: 'var(--color-neutral)',
  positiveColor: 'var(--color-positive)',
  noticeColor: 'var(--color-notice)',
  negativeColor: 'var(--color-negative)',
  focusColor: 'var(--color-focus)',
  normalRound: 'var(--radius-xl)',
  smallRound: 'var(--radius-sm)',
  font: 'var(--font-sans)',
  borderWidth: 'var(--default-border-width)',
  fontSizeXs: 'var(--text-xs)',
  fontSizeSm: 'var(--text-sm)',
  fontSizeBase: 'var(--text-base)',
  fontSizeLg: 'var(--text-lg)',
  codeFont: 'var(--font-mono)',
  displayFont: 'var(--font-display)',
  primaryStrongColor: 'var(--color-primary-strong)',
  primarySoftColor: 'var(--color-primary-soft)',
  floatShadow: 'var(--shadow-float)',
  primaryShadow: 'var(--shadow-primary)',
});

/** Common layout for `tap-page` inside a Sheet (`Sheet.open({ hasStack: true })`). */
export const sheetPageStyle = css`
  :scope {
    color: ${agentDeckTheme.textColor};
    font-family: ${agentDeckTheme.font};
    line-height: 1.5;
  }
  tap-page,
  tap-navbar {
    background: ${agentDeckTheme.backgroundColor};
  }
  tap-navbar {
    border: 0;
    margin-inline: 10px;
  }
  .page-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 10px 20px calc(20px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }
`;

/** Common `tap-cell-group` & `tap-cell` card styling inside a Sheet. */
export const sheetCellGroupStyle = css`
  tap-cell-group {
    margin: 0;
  }
  tap-cell {
    padding-block: 8px;
    line-height: 1.3;
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  /* Round the rows, not the group, which also holds the heading and footer */
  tap-cell:first-of-type {
    border-start-start-radius: ${agentDeckTheme.normalRound};
    border-start-end-radius: ${agentDeckTheme.normalRound};
  }
  tap-cell:last-of-type {
    border-end-start-radius: ${agentDeckTheme.normalRound};
    border-end-end-radius: ${agentDeckTheme.normalRound};
  }
  .choices tap-cell {
    cursor: pointer;
    &:active {
      background: ${agentDeckTheme.hoverBackgroundColor};
    }
  }
  .check {
    display: block;
    width: 1.25em;
    color: ${agentDeckTheme.primaryColor};
  }
`;
