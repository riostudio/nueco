// Single source of truth for color. Previously this file also exported a `colors` object with
// differently-named keys (e.g. `textPrimary` vs `C.text`) that nothing actually imported - screens
// each kept their own local `const C = {...}` instead, and those copies drifted (some had `danger`,
// some `error`; some had `surfaceHi`, some didn't). This is the one to import from now.
export const C = {
  primary: '#0A5443',
  primaryFg: '#FFFFFF',
  primaryLight: '#1D9E75',
  secondary: '#0F6E56',
  secondaryFg: '#FFFFFF',
  // Pale fill for a selected/active state (e.g. a segmented control), paired with `secondary` as
  // the text/icon color on top of it - distinct from `primary`'s solid-fill CTA treatment.
  secondaryTint: '#B3EFDC',
  // Lighter accent for a border/outline on top of `secondaryTint` - visible against the pale fill
  // without the harder contrast of full-strength `secondary`.
  secondaryLight: '#34B292',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  surfaceHi: '#FFF8E1',
  cardBg: '#FFFFFF',
  text: '#121212',
  textMain: '#121212',
  textSec: '#37474F',
  border: '#E0E0E0',
  borderDark: '#E0E0E0',
  borderSub: '#78909C',
  divider: '#F0F0F0',
  icon: '#546E7A',
  placeholder: '#9E9E9E',
  inactiveTab: '#757575',
  success: '#2E7D32',
  error: '#C62828',
  danger: '#C62828', // alias - some screens used this name for the same color
  warning: '#F9A825',
  overlay: 'rgba(0, 0, 0, 0.7)',
};

// Corner-radius scale. Previously nonexistent - card/button roundedness was a different literal
// number in every screen's StyleSheet. `pill` is deliberately >= half of any real button height,
// so `borderRadius: radius.pill` always yields a full stadium shape regardless of the box's height.
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

// Border weights used by the shared primitives (src/components/ui.tsx). Card/box borders had
// drifted between 1.5 and 2 across near-identical components; this is the one place that decides.
export const borderWidth = {
  regular: 1.5,
  thick: 2,
};

export const typography = {
  h1: { fontSize: 34, lineHeight: 42, fontWeight: '700' as const },
  h2: { fontSize: 28, lineHeight: 36, fontWeight: '700' as const },
  h3: { fontSize: 24, lineHeight: 32, fontWeight: '600' as const },
  bodyLarge: { fontSize: 22, lineHeight: 32, fontWeight: '400' as const },
  bodyRegular: { fontSize: 20, lineHeight: 30, fontWeight: '400' as const },
  button: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const },
  caption: { fontSize: 18, lineHeight: 26, fontWeight: '500' as const },
};

export const spacing = {
  xs: 8,
  sm: 16,
  md: 24,
  lg: 32,
  xl: 48,
};

export const TAG_COLORS = [
  { name: 'Red', value: '#C62828' },
  { name: 'Blue', value: '#1565C0' },
  { name: 'Green', value: '#2E7D32' },
  { name: 'Orange', value: '#E65100' },
  { name: 'Purple', value: '#6A1B9A' },
  { name: 'Teal', value: '#00695C' },
];
