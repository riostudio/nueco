/**
 * FeedbackToast.tsx
 * One-time "Enjoying Nueco?" bottom toast (see src/feedbackToast.ts for the trigger logic and
 * app/(tabs)/index.tsx for where this is shown). Presentational + its own animation/auto-dismiss
 * timer, structurally similar to OfflineBanner.tsx but bottom-anchored and interactive.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { C } from '../theme';

const AUTO_DISMISS_MS = 7000;

interface Props {
  visible: boolean;
  onThumbsUp: () => void;
  onThumbsDown: () => void;
  onDismiss: () => void;
  /** False for the retry showing - stays up until the user acts instead of auto-hiding. */
  autoDismiss?: boolean;
}

export default function FeedbackToast({ visible, onThumbsUp, onThumbsDown, onDismiss, autoDismiss = true }: Props) {
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: visible ? 0 : 80, useNativeDriver: true, friction: 8 }),
      Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 220, useNativeDriver: true }),
    ]).start();

    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (visible && autoDismiss) {
      dismissTimer.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    }
    return () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoDismiss]);

  if (!visible) return null;

  return (
    <Animated.View
      testID="feedback-toast"
      style={[s.toast, { transform: [{ translateY }], opacity }]}
    >
      <TouchableOpacity testID="feedback-toast-dismiss" onPress={onDismiss} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <MaterialIcons name="close" size={18} color={C.textSec} />
      </TouchableOpacity>
      <Text style={s.message}>Enjoying Nueco so far?</Text>
      <View style={s.actions}>
        <TouchableOpacity testID="feedback-thumbs-up" style={s.actionBtn} onPress={onThumbsUp} activeOpacity={0.7}>
          <MaterialIcons name="thumb-up" size={22} color={C.success} />
        </TouchableOpacity>
        <TouchableOpacity testID="feedback-thumbs-down" style={s.actionBtn} onPress={onThumbsDown} activeOpacity={0.7}>
          <MaterialIcons name="thumb-down" size={22} color={C.error} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 100,
    backgroundColor: C.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: C.borderSub,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  closeBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    padding: 4,
  },
  message: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
    marginRight: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
