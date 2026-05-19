/**
 * OfflineBanner.tsx
 * Shows a banner when the user is offline or syncing
 *
 * Usage:
 *   <OfflineBanner online={online} isSyncing={isSyncing} pendingCount={pendingCount} />
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface Props {
  online: boolean;
  isSyncing?: boolean;
  pendingCount?: number;
}

export default function OfflineBanner({ online, isSyncing, pendingCount }: Props) {
  const translateY = useRef(new Animated.Value(-60)).current;
  const visible = !online || isSyncing;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: visible ? 0 : -60,
      useNativeDriver: true,
      friction: 8,
    }).start();
  }, [visible]);

  if (!visible && !isSyncing) return null;

  const bgColor = isSyncing ? '#1565C0' : '#C62828';
  const icon = isSyncing ? 'sync' : 'wifi-off';
  const message = isSyncing
    ? `Syncing${pendingCount ? ` ${pendingCount} item${pendingCount > 1 ? 's' : ''}` : ''}...`
    : `Offline${pendingCount ? ` · ${pendingCount} change${pendingCount > 1 ? 's' : ''} pending` : ' · Changes will sync when reconnected'}`;

  return (
    <Animated.View style={[s.banner, { backgroundColor: bgColor, transform: [{ translateY }] }]}>
      <MaterialIcons name={icon} size={16} color="#fff" />
      <Text style={s.text}>{message}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 8,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 6,
  },
});
