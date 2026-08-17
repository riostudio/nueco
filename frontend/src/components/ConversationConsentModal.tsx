import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { C, radius } from '../theme';
import { Button } from './index';
import { appendConsentRecord } from '../audio/consentLog';

const FIRST_RUN_KEY = 'conversation_first_run_seen';

/**
 * Per-session attestation prompt for conversation mode (plan/11).
 *
 * - Fires BEFORE the microphone opens and blocks until answered - no backdrop dismiss.
 * - A question, not a checkbox or a legal warning: "Does everyone here know you're recording?"
 * - "Not yet" offers two paths (start single-voice instead, or go back) rather than just
 *   cancelling, and never nags.
 * - The answer is logged locally with a timestamp - never sent anywhere.
 * - First session ever: a one-time explanation of how conversation capture works (and what it
 *   can't do) appears above the question. The question itself asks every session.
 */
export function ConversationConsentModal({
  visible,
  announcementEnabled,
  onStartConversation,
  onStartSingleVoice,
  onCancel,
}: {
  visible: boolean;
  /** Whether the audible "Recording started for note-taking" announcement will play; recorded
   * as the consent log's announcementPlayed so the log reflects reality, not intent. */
  announcementEnabled: boolean;
  /** User confirmed everyone knows - start the conversation-mode capture. */
  onStartConversation: () => void;
  /** User picked single-voice mode instead of conversation capture. */
  onStartSingleVoice: () => void;
  /** User backed out entirely. */
  onCancel: () => void;
}) {
  const [declined, setDeclined] = useState(false);
  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    if (!visible) return;
    AsyncStorage.getItem(FIRST_RUN_KEY)
      .then(v => { if (v !== '1') setFirstRun(true); })
      .catch(() => {});
  }, [visible]);

  const dismissFirstRun = () => {
    if (!firstRun) return;
    setFirstRun(false);
    AsyncStorage.setItem(FIRST_RUN_KEY, '1').catch(() => {});
  };

  const log = (choice: 'confirmed' | 'declined') =>
    appendConsentRecord({ attestedAt: Date.now(), choice, announcementPlayed: choice === 'confirmed' && announcementEnabled });

  const handleConfirm = () => {
    log('confirmed');
    setDeclined(false);
    dismissFirstRun();
    onStartConversation();
  };

  const handleDecline = () => {
    log('declined');
    setDeclined(true);
  };

  const handleSingleVoice = () => {
    setDeclined(false);
    dismissFirstRun();
    onStartSingleVoice();
  };

  const handleCancel = () => {
    setDeclined(false);
    dismissFirstRun();
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Blocking by design: no backdrop dismiss, no hardware-back dismiss (plan/11).
      onRequestClose={() => {}}
    >
      <View style={s.backdrop} pointerEvents="box-none">
        <View style={s.card}>
          <MaterialIcons name="record-voice-over" size={28} color={C.primary} />
          <Text style={s.question}>
            {declined
              ? 'No worries. What would you like to do instead?'
              : 'Does everyone here know you are recording?'}
          </Text>
          {!declined && firstRun && (
            <View style={s.firstRun}>
              <Text style={s.firstRunTitle}>How conversation capture works</Text>
              <Text style={s.firstRunLine}>- Works best when people take turns speaking.</Text>
              <Text style={s.firstRunLine}>
                - Passages where voices overlap get marked, not guessed - you can tap them to
                listen back.
              </Text>
              <Text style={s.firstRunLine}>
                - The audio is kept so you can check it, then deleted within 24 hours.
              </Text>
              {announcementEnabled && (
                <Text style={s.firstRunLine}>
                  - A short announcement will play out loud when recording starts.
                </Text>
              )}
            </View>
          )}
          {!declined && !firstRun && (
            <Text style={s.subtext}>
              Works best when people take turns. Passages where voices overlap get marked so you
              can check the audio yourself.
            </Text>
          )}

          {!declined ? (
            <View style={s.actions}>
              <Button
                testID="consent-confirm-btn"
                variant="cta"
                label="Yes, start recording"
                onPress={handleConfirm}
              />
              <Button
                testID="consent-decline-btn"
                variant="outline"
                label="Not yet"
                onPress={handleDecline}
              />
            </View>
          ) : (
            <View style={s.actions}>
              <Button
                testID="consent-single-voice-btn"
                variant="cta"
                label="Record just my voice"
                onPress={handleSingleVoice}
              />
              <Button
                testID="consent-cancel-btn"
                variant="outline"
                label="Go back"
                onPress={handleCancel}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: C.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: C.surface,
    borderRadius: radius.lg,
    padding: 24,
    width: '100%',
    maxWidth: 420,
    alignItems: 'stretch',
    gap: 12,
  },
  question: {
    fontSize: 20,
    fontWeight: '700',
    color: C.text,
    lineHeight: 27,
  },
  subtext: {
    fontSize: 14,
    color: C.textSec,
    lineHeight: 20,
  },
  firstRun: {
    backgroundColor: C.secondaryTint,
    borderRadius: radius.md,
    padding: 12,
    gap: 6,
  },
  firstRunTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: C.text,
  },
  firstRunLine: {
    fontSize: 13,
    color: C.textSec,
    lineHeight: 18,
  },
  actions: {
    gap: 10,
    marginTop: 6,
  },
});
