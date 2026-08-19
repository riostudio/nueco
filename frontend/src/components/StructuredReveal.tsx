import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { REVEAL_DURATION_MS } from '../revealSpec';
import { parseStructuredHtml } from '../structuredHtmlPreview';
import { C } from '../theme';

/**
 * The shared before->after reveal transition (plan: SHARED SPEC - reveal transition). Onboarding
 * (A3) and the regular-capture editor reveal (A5) both use this component so the two surfaces -
 * and iOS and Android - stay on identical timing by construction.
 *
 * One Animated.timing drives everything: the raw content fades out over the first half, the
 * structured version fades in over the second. Same duration, same easing, same driver on every
 * platform - no platform-default curves anywhere in the path.
 */

const HALF = 0.5;

export function StructuredReveal({
  before,
  structuredHtml,
  revealing,
  onComplete,
}: {
  before: React.ReactNode;
  structuredHtml: string | null;
  revealing: boolean;
  onComplete?: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const [swapped, setSwapped] = useState(false);
  const completeFired = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!revealing || !structuredHtml) return;
    progress.setValue(0);
    setSwapped(false);
    completeFired.current = false;
    // Layout swaps at the midpoint while both sides are at opacity zero, so the height change
    // between raw and structured content is invisible.
    const sub = progress.addListener(({ value }) => {
      if (value >= HALF) setSwapped(s => (s ? s : true));
    });
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: REVEAL_DURATION_MS,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished && !completeFired.current) {
        completeFired.current = true;
        onCompleteRef.current?.();
      }
    });
    return () => {
      progress.removeListener(sub);
      anim.stop();
    };
  }, [revealing, structuredHtml, progress]);

  const beforeOpacity = progress.interpolate({
    inputRange: [0, HALF - 0.05],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const afterOpacity = progress.interpolate({
    inputRange: [HALF + 0.05, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const afterRise = progress.interpolate({
    inputRange: [HALF, 1],
    outputRange: [10, 0],
    extrapolate: 'clamp',
  });

  if (!swapped || !structuredHtml) {
    return <Animated.View style={{ opacity: beforeOpacity }}>{before}</Animated.View>;
  }
  return (
    <Animated.View style={{ opacity: afterOpacity, transform: [{ translateY: afterRise }] }}>
      <StructuredPreview html={structuredHtml} />
    </Animated.View>
  );
}

/** Native render of the structured note - same card treatment as the raw preview it replaces. */
export function StructuredPreview({ html }: { html: string }) {
  const blocks = parseStructuredHtml(html);
  let numberedIndex = 0;
  let prevKind = '';
  return (
    <View style={s.card}>
      {blocks.map((block, i) => {
        if (block.kind === 'numbered') {
          if (prevKind !== 'numbered') numberedIndex = 0;
          numberedIndex += 1;
        }
        prevKind = block.kind;
        switch (block.kind) {
          case 'heading':
            return <Text key={i} style={s.heading}>{block.text}</Text>;
          case 'bullet':
            return (
              <View key={i} style={s.row}>
                <Text style={s.bulletMark}>{'•'}</Text>
                <Text style={s.item}>{block.text}</Text>
              </View>
            );
          case 'numbered':
            return (
              <View key={i} style={s.row}>
                <Text style={s.bulletMark}>{`${numberedIndex}.`}</Text>
                <Text style={s.item}>{block.text}</Text>
              </View>
            );
          default:
            return <Text key={i} style={s.paragraph}>{block.text}</Text>;
        }
      })}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16, gap: 6,
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  heading: { fontSize: 15, fontWeight: '700', color: C.text, lineHeight: 21, marginTop: 4 },
  paragraph: { fontSize: 15, color: C.textSec, lineHeight: 23 },
  row: { flexDirection: 'row', gap: 8 },
  bulletMark: { fontSize: 15, color: C.textSec, lineHeight: 23, minWidth: 14 },
  item: { flex: 1, fontSize: 15, color: C.textSec, lineHeight: 23 },
});
