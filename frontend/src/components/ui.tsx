/**
 * Shared visual primitives for the reskin (design/reskin branch). Before this, every screen
 * hand-rolled its own TouchableOpacity + StyleSheet for buttons/cards, which is how the app ended
 * up with e.g. two near-identical "bordered card" styles at different border widths. These three
 * components are the one place that decides what a button/card/segmented-control looks like -
 * screens compose them instead of re-declaring the look.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { C, radius, borderWidth } from '../theme';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

// ---- Button ----
// 'cta'    - solid pill, bold white label (Voice input, New event, Get Started).
// 'outline'- pill outline, primary-colored border/label, transparent fill (a lower-emphasis CTA
//            alongside a 'cta' one, e.g. "Login" next to "Get Started").
// 'box'    - outlined bordered box, icon + label (Pin/Image/Share, Schedule event/Link event).
// 'toolbar'- icon + label, no border/fill - for lower-emphasis actions that shouldn't compete
//            with the boxed ones on the same screen.
type ButtonVariant = 'cta' | 'outline' | 'box' | 'toolbar';
type ButtonLayout = 'row' | 'stack'; // 'box' only: icon-beside-label vs icon-above-label
type ButtonTone = 'default' | 'danger';

export function Button({
  label,
  icon,
  onPress,
  variant = 'box',
  layout = 'row',
  tone = 'default',
  active = false,
  disabled = false,
  loading = false,
  style,
  testID,
}: {
  label: string;
  /** Optional - 'cta'/'outline' buttons are often text-only (e.g. a form submit button). */
  icon?: IconName;
  onPress: () => void;
  variant?: ButtonVariant;
  layout?: ButtonLayout;
  tone?: ButtonTone;
  /** Toggled-on state for a box/toolbar button (e.g. Pin once pinned) - tints icon/label/border
   * with `primary` regardless of `tone`. */
  active?: boolean;
  disabled?: boolean;
  /** 'cta'/'outline' only - swaps icon+label for a spinner and implies disabled (a submitting
   * form button). */
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const toneColor = active ? C.primary : tone === 'danger' ? C.error : C.text;
  const toneBorder = active ? C.primary : tone === 'danger' ? C.error : C.border;

  if (variant === 'cta') {
    // `tone="danger"` on a cta gives a solid red fill (e.g. an active voice recording) instead of
    // the default solid primary fill - same shape, different state.
    const ctaBg = tone === 'danger' ? C.error : C.primary;
    return (
      <TouchableOpacity
        testID={testID}
        disabled={disabled || loading}
        onPress={onPress}
        activeOpacity={0.85}
        style={[s.cta, { backgroundColor: ctaBg }, (disabled || loading) && s.disabled, style]}
      >
        {loading ? (
          <ActivityIndicator color={C.primaryFg} size="small" />
        ) : (
          <>
            {icon && <MaterialIcons name={icon} size={22} color={C.primaryFg} />}
            <Text style={s.ctaLabel}>{label}</Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  if (variant === 'outline') {
    return (
      <TouchableOpacity
        testID={testID}
        disabled={disabled || loading}
        onPress={onPress}
        activeOpacity={0.7}
        style={[s.cta, s.outline, (disabled || loading) && s.disabled, style]}
      >
        {loading ? (
          <ActivityIndicator color={C.primary} size="small" />
        ) : (
          <>
            {icon && <MaterialIcons name={icon} size={22} color={C.primary} />}
            <Text style={[s.ctaLabel, s.outlineLabel]}>{label}</Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  if (variant === 'toolbar') {
    return (
      <TouchableOpacity
        testID={testID}
        disabled={disabled}
        onPress={onPress}
        style={[s.toolbarBtn, disabled && s.disabled, style]}
      >
        {icon && <MaterialIcons name={icon} size={22} color={toneColor} />}
        <Text style={[s.toolbarLabel, { color: toneColor }]}>{label}</Text>
      </TouchableOpacity>
    );
  }

  // variant === 'box'
  return (
    <TouchableOpacity
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={[
        s.box,
        layout === 'row' ? s.boxRow : s.boxStack,
        { borderColor: toneBorder },
        disabled && s.disabled,
        style,
      ]}
    >
      {icon && <MaterialIcons name={icon} size={20} color={toneColor} />}
      <Text style={[s.boxLabel, { color: toneColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ---- Card ----
// Bordered rounded container for list rows (note cards, event cards). `flat` drops the border for
// contexts that already sit inside a bordered parent.
export function Card({
  children,
  style,
  flat = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  flat?: boolean;
}) {
  return <View style={[s.card, flat && s.cardFlat, style]}>{children}</View>;
}

// ---- SegmentedControl ----
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { label: string; value: T; testID?: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.segmented, style]}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            testID={opt.testID}
            onPress={() => onChange(opt.value)}
            style={[s.segment, selected && s.segmentSelected]}
          >
            <Text style={[s.segmentLabel, selected && s.segmentLabelSelected]}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ---- Badge ----
// Small filled pill for a short label riding on a card (event time, a count). `tone` picks the
// fill/text pair; 'accent' is the default (matches the segmented control's selected-state blue).
export function Badge({
  label,
  tone = 'accent',
  style,
}: {
  label: string;
  tone?: 'accent' | 'success' | 'neutral';
  style?: StyleProp<ViewStyle>;
}) {
  const palette = {
    accent: { bg: C.secondaryTint, fg: C.secondary },
    success: { bg: C.success, fg: C.primaryFg },
    neutral: { bg: C.surfaceHi, fg: C.textSec },
  }[tone];
  return (
    <View style={[s.badge, { backgroundColor: palette.bg }, style]}>
      <Text style={[s.badgeLabel, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  disabled: { opacity: 0.5 },

  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: C.primary,
  },
  ctaLabel: { fontSize: 16, fontWeight: '700', color: C.primaryFg },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: borderWidth.thick,
    borderColor: C.primary,
  },
  outlineLabel: { color: C.primary },

  toolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  toolbarLabel: { fontSize: 13, fontWeight: '600' },

  box: {
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    backgroundColor: C.surface,
  },
  boxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  boxStack: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  boxLabel: { fontSize: 14, fontWeight: '600' },

  card: {
    borderWidth: borderWidth.regular,
    borderColor: C.borderSub,
    borderRadius: radius.md,
    backgroundColor: C.cardBg,
  },
  cardFlat: { borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent' },

  segmented: {
    flexDirection: 'row',
    gap: 12,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: borderWidth.regular,
    borderColor: C.border,
    borderRadius: radius.md,
    backgroundColor: C.surface,
  },
  segmentSelected: { backgroundColor: C.secondaryTint, borderColor: C.secondaryTint },
  segmentLabel: { fontSize: 14, fontWeight: '600', color: C.text },
  segmentLabelSelected: { color: C.secondary },

  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeLabel: { fontSize: 13, fontWeight: '700' },
});
