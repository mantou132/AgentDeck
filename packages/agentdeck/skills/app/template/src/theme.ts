import { extendTheme } from '@mantou/tap-ui/lib/theme';

import './tailwind.css';

// Tap UI reads these; the values come from the Tailwind theme so both stay in sync
extendTheme({
  colorScheme: 'light dark',
  primaryColor: 'var(--color-primary)',
  highlightColor: 'var(--color-highlight)',
  textColor: 'var(--color-text)',
  describeColor: 'var(--color-describe)',
  backgroundColor: 'var(--color-bg)',
  lightBackgroundColor: 'var(--color-bg-light)',
  borderColor: 'var(--color-border)',
});
