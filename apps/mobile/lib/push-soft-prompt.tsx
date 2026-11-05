/**
 * Push soft-prompt (M1.5 item G) — the notification permission ask, moved
 * from sign-in (a cold first-run moment) to the value moment: the FIRST
 * completed chat run. One-screen pre-prompt explaining what the
 * notification is for; OS permission ask only if the user opts in;
 * denial/dismissal is non-blocking and once-per-install.
 *
 * Why an event, not a router screen: the completion happens deep inside the
 * chat screen's SSE event handler; an emitted "first run completed" event
 * lets the overlay (mounted once, at the root layout) handle prompting
 * without threading callbacks through navigation or the chat screen.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { useAuth } from './auth-context';
import { registerExpoPushTokenIfGranted } from './push';

/** SecureStore key: presence = the soft-prompt has been shown (settled). */
const PROMPT_SETTLED_KEY = 'digby.pushPromptSettled';

/** Emitted by the chat screen on every completed run (value moment). */
export const CHAT_RUN_COMPLETED_EVENT = 'digby.chatRunCompleted';

/**
 * Call when a chat run completes (SSE 'complete'). Idempotent for the
 * prompt's purposes — the overlay itself checks its once-per-install state.
 */
export function noteChatRunCompleted(): void {
  DeviceEventEmitter.emit(CHAT_RUN_COMPLETED_EVENT);
}

/** Read the once-per-install settled flag (async, SecureStore-backed). */
async function isPromptSettled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(PROMPT_SETTLED_KEY)) === '1';
  } catch {
    return true; // storage error = never prompt (best-effort, same as push)
  }
}

/** Persist the settled flag (either outcome). Best-effort. */
async function setPromptSettled(): Promise<void> {
  try {
    await SecureStore.setItemAsync(PROMPT_SETTLED_KEY, '1');
  } catch {
    /* ignore — worst case the prompt re-shows after a reinstall */
  }
}

/** Fire-and-forget the OS permission ask; returns whether it was granted. */
async function askNotificationPermission(): Promise<boolean> {
  try {
    const settings = await Notifications.requestPermissionsAsync();
    return !!settings.granted;
  } catch {
    return false;
  }
}

/**
 * The overlay layer — mount ONCE inside AuthProvider (root layout). Listens
 * for completed runs; on the first one (while signed in) shows the one-
 * screen pre-prompt. "Turn on" triggers the OS ask + silent registration;
 * "Not now" (or denial) settles the prompt forever. Never blocks chat.
 */
export function PushSoftPrompt(): React.JSX.Element {
  const { user, api } = useAuth();
  const [visible, setVisible] = useState(false);
  const settledRef = useRef(false);

  // Load once-per-install state at mount (before any run can complete).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settled = await isPromptSettled();
      // Never downgrade: a run may complete (and settle us) while this
      // async read is in flight — overwriting true with a stale false
      // would re-arm the prompt for the next run (review N1).
      if (!cancelled && !settledRef.current) settledRef.current = settled;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The value moment: first completed run while signed in.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(CHAT_RUN_COMPLETED_EVENT, () => {
      if (!user || settledRef.current) return; // signed out / already asked

      // Pre-`eas init` guard: without extra.eas.projectId the token call
      // below cannot register anything (getExpoPushTokenAsync rejects with
      // ERR_NOTIFICATIONS_NO_PROJECT_ID) — a prompt that collects the OS
      // consent and then does nothing. Skip WITHOUT settling, so the
      // prompt arms itself the first completed run after the owner's
      // `eas init` writes the id (no code change, no new build needed).
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (typeof projectId !== 'string' || !projectId) return;

      settledRef.current = true; // settled from THIS point on (both buttons)
      void setPromptSettled();
      setVisible(true);
    });
    return () => sub.remove();
  }, [user]);

  const close = useCallback(() => setVisible(false), []);

  const onTurnOn = useCallback(async () => {
    close();
    // The OS ask (Android 13+ POST_NOTIFICATIONS / iOS standard prompt),
    // then the same silent registration path used at sign-in.
    const granted = await askNotificationPermission();
    if (granted) void registerExpoPushTokenIfGranted(api);
  }, [api, close]);

  const onNotNow = useCallback(() => {
    close();
    // Denial is a non-blocking path: push stays off, chat fully functional.
  }, []);

  const body = useMemo(
    () => (
      <Text style={styles.body}>
        Runs can take a while. Turn on notifications and Digby will tell you
        when yours finishes — even if you leave the app. You can change this
        anytime in Settings.
      </Text>
    ),
    []
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Stay in the loop?</Text>
          {body}
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && styles.primaryBtnPressed,
            ]}
            onPress={onTurnOn}
            accessibilityRole="button"
            accessibilityLabel="Turn on notifications"
          >
            <Text style={styles.primaryBtnText}>Turn on</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
            onPress={onNotNow}
            accessibilityRole="button"
            accessibilityLabel="Not now"
          >
            <Text style={styles.secondaryBtnText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    gap: 16,
  },
  title: { fontSize: 18, fontWeight: '600', color: '#0F172A' },
  body: { fontSize: 14, lineHeight: 20, color: '#64748B' },
  primaryBtn: {
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnPressed: { backgroundColor: '#6D28D9' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondaryBtn: { paddingVertical: 8, alignItems: 'center' },
  secondaryBtnPressed: { opacity: 0.6 },
  secondaryBtnText: { color: '#7C3AED', fontSize: 15, fontWeight: '500' },
});
