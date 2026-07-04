/**
 * A small determinate radial (circular) progress indicator — used for attachment
 * upload progress in the editor. `progress` is 0..1.
 */
import React from 'react';
import Svg, { Circle } from 'react-native-svg';
import { C } from '../theme';

export function RadialProgress({
  progress,
  size = 26,
  strokeWidth = 3,
  color = C.primary,
  trackColor = C.borderSub,
}: {
  progress: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
}) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress || 0));
  const center = size / 2;
  return (
    <Svg width={size} height={size}>
      <Circle cx={center} cy={center} r={r} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
      <Circle
        cx={center}
        cy={center}
        r={r}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );
}
