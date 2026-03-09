export const colors = {
  primary: '#D84315',
  primaryForeground: '#FFFFFF',
  secondary: '#1565C0',
  secondaryForeground: '#FFFFFF',
  background: '#FDFBF7',
  surface: '#FFFFFF',
  surfaceHighlight: '#FFF8E1',
  textPrimary: '#121212',
  textSecondary: '#37474F',
  border: '#121212',
  borderSubtle: '#78909C',
  success: '#2E7D32',
  error: '#C62828',
  warning: '#F9A825',
  overlay: 'rgba(0, 0, 0, 0.7)',
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

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
