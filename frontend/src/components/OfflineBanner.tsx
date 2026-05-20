/**
 * OfflineBanner.tsx
 * - Shows blue "Syncing..." banner once when coming back online
 * - Disappears as soon as sync is complete
 * - No banner when offline
 * - Silent during background syncs
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface Props {
  online: boolean;
  isSyncing?: boolean;
  pendingCount?: number;
}

export default function OfflineBanner({ online, isSyncing, pendingCount }: Props) {
  const translateY = useRef(new Animated.Value(-60)).current;
  const [showSyncBanner, setShowSyncBanner] = useState(false);
  const prevOnline = useRef(online);

  // Detect coming back online — show banner
  useEffect(() => {
    if (!prevOnline.current && online) {
      setShowSyncBanner(true);
    }
    prevOnline.current = online;
  }, [online]);

  // Hide banner as soon as sync completes
  useEffect(() => {
    if (showSyncBanner && !isSyncing) {
      // Small delay so user sees "Synced!" briefly
      const timer = setTimeout(() => setShowSyncBanner(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showSyncBanner, isSyncing]);

  const visible = showSyncBanner && online;
  const message = isSyncing
    ? `Syncing${pendingCount ? ` ${pendingCount} item${pendingCount > 1 ? 's' : ''}` : ''}...`
    : '✓ Synced';

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: visible ? 0 : -60,
      useNativeDriver: true,
      friction: 8,
    }).start();
  }, [visible]);

  if (!visible) return null;

  return (
    <Animated.View style={[s.banner, { backgroundColor: isSyncing ? '#1565C0' : '#2E7D32', transform: [{ translateY }] }]}>
      <MaterialIcons name={isSyncing ? 'sync' : 'check-circle'} size={16} color="#fff" />
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