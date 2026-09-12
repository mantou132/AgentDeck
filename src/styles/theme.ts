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
  codeFont: 'var(--font-mono)',
  displayFont: 'var(--font-display)',
  primaryStrongColor: 'var(--color-primary-strong)',
  primarySoftColor: 'var(--color-primary-soft)',
  floatShadow: 'var(--shadow-float)',
});
