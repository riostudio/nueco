/**
 * Placeholder shapes shown while a screen's real content is still being read or fetched.
 *
 * WHY THESE INSTEAD OF A SPINNER
 * A centred spinner says "something is happening" and nothing else: the screen is blank, then it
 * jumps to a full list, and the eye has to re-find its place. Skeletons keep the page's shape
 * present the whole time, so when the data lands nothing moves - the grey blocks are simply
 * replaced by the text that was always going to be there.
 *
 * The pulse is deliberately slow and low-contrast. A fast shimmer reads as urgency, and this app
 * is used by people for whom a screen that hurries them is the reason they close it.
 *
 * Honours the OS "reduce motion" setting: when it's on, the blocks are drawn at a steady mid
 * opacity with no animation at all.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, View, StyleSheet, AccessibilityInfo, type ViewStyle, type StyleProp } from 'react-native';
import { C } from '../theme';

type BlockProps = {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

/** One grey block. Compose these into a shape that matches whatever it's standing in for. */
export function SkeletonBlock({ width = '100%', height = 12, radius = 6, style }: BlockProps) {
  const pulse = useRef(new Animated.Value(0.5)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(on => { if (!cancelled) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { cancelled = true; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(0.55);
      return;
    }
    // 1100ms each way: slow enough to read as breathing rather than blinking.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 1100, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 1100, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  return (
    <Animated.View
      // Decorative: a screen reader should announce the loading state once (see the containers
      // below), not read out every grey rectangle on the page.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: radius, backgroundColor: C.border, opacity: pulse },
        style,
      ]}
    />
  );
}

/** Stand-in for one note card: title, two lines of preview, and a thumbnail beside them. */
export function NoteCardSkeleton({ withThumb = false }: { withThumb?: boolean }) {
  return (
    <View style={s.card}>
      <SkeletonBlock width="55%" height={18} style={{ marginBottom: 12 }} />
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <SkeletonBlock height={13} style={{ marginBottom: 8 }} />
          <SkeletonBlock width="80%" height={13} />
        </View>
        {withThumb ? <SkeletonBlock width={52} height={52} radius={8} /> : null}
      </View>
      <SkeletonBlock width="30%" height={11} style={{ marginTop: 14, alignSelf: 'flex-end' }} />
    </View>
  );
}

/** Stand-in for one day's group on the Events tab: a date heading and a card under it. */
export function EventCardSkeleton() {
  return (
    <View style={{ marginBottom: 18 }}>
      <SkeletonBlock width="35%" height={14} style={{ marginBottom: 10, marginLeft: 4 }} />
      <View style={s.card}>
        <SkeletonBlock width="60%" height={16} style={{ marginBottom: 10 }} />
        <SkeletonBlock width="45%" height={12} />
      </View>
    </View>
  );
}

/** Stand-in for a Daily Brew row: the 32px icon slot, then a line or two of text. */
export function BrewRowSkeleton({ lines = 1, circle = false }: { lines?: number; circle?: boolean }) {
  return (
    <View style={s.brewRow}>
      <SkeletonBlock width={32} height={32} radius={circle ? 16 : 8} />
      <View style={{ flex: 1, gap: 6 }}>
        <SkeletonBlock height={13} />
        {lines > 1 ? <SkeletonBlock width="70%" height={13} /> : null}
      </View>
    </View>
  );
}

/**
 * Full-screen list placeholder. `count` should roughly fill the viewport - too few and the page
 * still visibly grows when the real data lands, which is the jump these exist to prevent.
 */
export function ListSkeleton({
  count = 4,
  variant = 'note',
  label = 'Loading',
}: {
  count?: number;
  variant?: 'note' | 'event';
  label?: string;
}) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={s.list}>
      {Array.from({ length: count }, (_, i) =>
        variant === 'event'
          ? <EventCardSkeleton key={i} />
          // Alternating thumbnails so the placeholder reads like a real library rather than a
          // repeating pattern, which is what makes a skeleton look like a loading graphic.
          : <NoteCardSkeleton key={i} withThumb={i % 2 === 1} />,
      )}
    </View>
  );
}

const s = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 8 },
  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16, marginBottom: 12,
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  brewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingHorizontal: 8 },
});
