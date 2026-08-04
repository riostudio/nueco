/**
 * Live waveform for the note editor's voice capture.
 *
 * Driven by the recorder's real metering values, not a canned animation - the whole point is to
 * prove the app is actually hearing you. A looping fake animation looks identical whether the mic
 * is working or muted, which is exactly the uncertainty a first-time voice user has.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { C } from '../theme';

const BAR_COUNT = 27;
// ~16fps. Fast enough to track speech rhythm, slow enough that polling getStatus() and setting
// state doesn't compete with the recorder itself for the JS thread.
const SAMPLE_MS = 60;

// expo-audio reports metering in dBFS: roughly -160 (silence) to 0 (clipping). Speech mostly
// lives in the top ~50dB, so anything below FLOOR is treated as silence rather than letting the
// long quiet tail flatten the visible range.
const DB_FLOOR = -50;

function levelFromDb(db: number | undefined): number {
  if (db == null || !Number.isFinite(db)) return 0;
  if (db <= DB_FLOOR) return 0;
  const norm = (db - DB_FLOOR) / (0 - DB_FLOOR); // 0..1
  // Slight curve so ordinary speech sits mid-height instead of hugging the floor.
  return Math.min(1, Math.max(0, Math.pow(norm, 0.65)));
}

export function RecordingWaveform({ getMetering }: { getMetering: () => number | undefined }) {
  // Newest sample at the end; the row renders right-to-left so bars appear to flow out of the mic.
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const id = setInterval(() => {
      const next = levelFromDb(getMetering());
      setLevels(prev => [...prev.slice(1), next]);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [getMetering, fade]);

  return (
    <Animated.View style={[s.row, { opacity: fade }]} pointerEvents="none">
      {levels.map((lvl, i) => (
        <View
          key={i}
          style={[
            s.bar,
            {
              // Never fully collapse - a row of invisible bars reads as "broken", whereas a row of
              // small dots reads as "listening, nothing said yet".
              height: 3 + lvl * 25,
              opacity: 0.35 + lvl * 0.65,
            },
          ]}
        />
      ))}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: 30,
  },
  bar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: C.secondary,
  },
});
