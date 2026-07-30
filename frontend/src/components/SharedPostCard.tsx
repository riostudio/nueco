/**
 * A rich card for a post shared into Nueco from a social app (Instagram, Facebook,
 * TikTok, …). Shows the thumbnail (image or generated video frame), the post header/caption,
 * and a platform badge; tapping the card opens the original post. Rendered in the editor above
 * the note body. Presentation (brand color + icon + host) is re-derived from the URL, so nothing
 * beyond {platform,label,url,title,kind,thumbnail} needs to be persisted.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { C } from '../theme';
import { detectSocialSource, hostOf, type SourcePost } from '../share/socialSource';

interface Props {
  source: SourcePost;
  onOpen: () => void;
  onRemove: () => void;
  style?: StyleProp<ViewStyle>; // override the card's outer margins (e.g. when nested in the input box)
}

export function SharedPostCard({ source, onOpen, onRemove, style }: Props) {
  const brand = detectSocialSource(source.url);
  const brandColor = brand?.brandColor ?? C.secondary;
  const icon = (brand?.icon ?? 'link-variant') as keyof typeof MaterialCommunityIcons.glyphMap;
  const label = source.label || brand?.label || 'Shared post';
  const host = hostOf(source.url);
  const header = source.title?.trim() || label;

  // Local data-uri thumbnail, else a remote poster (e.g. YouTube). Fall back to the brand
  // placeholder if the remote image can't load (offline / removed).
  const [imgFailed, setImgFailed] = React.useState(false);
  const thumbUri = !imgFailed ? source.thumbnail || source.thumbUrl : undefined;

  return (
    <TouchableOpacity
      testID="shared-post-card"
      style={[s.card, style]}
      activeOpacity={0.85}
      onPress={onOpen}
    >
      {/* Thumbnail (image / video frame) or a brand-colored placeholder */}
      <View style={[s.thumbWrap, { backgroundColor: brandColor + '22' }]}>
        {thumbUri ? (
          <Image source={{ uri: thumbUri }} style={s.thumb} resizeMode="cover" onError={() => setImgFailed(true)} />
        ) : (
          <MaterialCommunityIcons name={icon} size={30} color={brandColor} />
        )}
        {source.kind === 'video' && (
          <View style={s.playOverlay}>
            <MaterialIcons name="play-circle-filled" size={30} color="#FFFFFF" />
          </View>
        )}
      </View>

      {/* Header + platform + host */}
      <View style={s.body}>
        <View style={s.badgeRow}>
          <MaterialCommunityIcons name={icon} size={16} color={brandColor} />
          <Text style={[s.badgeText, { color: brandColor }]} numberOfLines={1}>{label}</Text>
        </View>
        <Text style={s.header} numberOfLines={2}>{header}</Text>
        <View style={s.hostRow}>
          <MaterialIcons name="open-in-new" size={13} color={C.borderSub} />
          <Text style={s.host} numberOfLines={1}>{host || source.url}</Text>
        </View>
      </View>

      {/* Remove the card from the note */}
      <TouchableOpacity
        testID="remove-shared-post-btn"
        style={s.removeBtn}
        onPress={onRemove}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <MaterialIcons name="close" size={18} color={C.borderSub} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSub + '55',
    marginHorizontal: 20,
    marginTop: 16,
    overflow: 'hidden',
  },
  thumbWrap: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    ...StyleSheet.absoluteFillObject,
    width: undefined,
    height: undefined,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000033',
  },
  body: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    paddingRight: 34, // clear of the remove button
    justifyContent: 'center',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 3,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  header: {
    fontSize: 15,
    fontWeight: '600',
    color: C.text,
    lineHeight: 20,
  },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  host: {
    flex: 1,
    fontSize: 12,
    color: C.borderSub,
  },
  removeBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bg + 'CC',
  },
});
