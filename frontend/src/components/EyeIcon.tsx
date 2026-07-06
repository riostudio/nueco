/**
 * SVG eye / eye-off icon for password show-hide toggles. Stroke-based (Feather-style),
 * rendered via react-native-svg so it stays crisp at any size and matches the app's other
 * SVG chrome (e.g. RadialProgress). `off` shows the struck-through "hidden" variant.
 */
import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';

export function EyeIcon({
  off = false,
  size = 24,
  color = '#78909C',
  strokeWidth = 2,
}: {
  off?: boolean;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {off ? (
        <>
          <Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <Path d="M1 1l22 22" />
        </>
      ) : (
        <>
          <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <Circle cx={12} cy={12} r={3} />
        </>
      )}
    </Svg>
  );
}
