/**
 * Push notifications (M1 — roadmap §3.2 item 2; M1.5 item G timing split).
 *
 * Registration here is SILENT — this module NEVER asks for permission. If the
 * permission is already granted (the user accepted the soft-prompt in
 * push-soft-prompt.tsx after their first completed run, or granted it in OS
 * settings), the Expo Push token is (re)registered with the backend after
 * sign-in via @digby/api's push namespace. The permission ASK lives in the
 * soft-prompt layer, which fires at the value moment. Notification taps
 * deep-link digby://chat/<id> through expo-router. The backend fires on chat
 * run completion — the wake signal for a backgrounded app (§3.2 item 3: iOS
 * suspends the app seconds after backgrounding; push carries the "run
 * finished" signal, the REST transcript is the resync source).
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import type { DigbyApiClient } from '@digby/api';
import { fetchPush } from '@digby/api';

/** How the app presents pushes while foregrounded. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** The token we last handed the backend THIS session (dedup across calls). */
let lastRegisteredToken: string | null = null;

/**
 * Silent registration: register the Expo Push token with the backend ONLY
 * when notification permission is already granted — this never prompts.
 * Returns when done (or when push is unavailable); every failure is
 * swallowed — push is best-effort and never blocks the app.
 *
 * Split out of the hook (M1.5 item G) so the soft-prompt layer can run the
 * exact same path right after the user accepts the pre-prompt.
 */
export async function registerExpoPushTokenIfGranted(client: DigbyApiClient): Promise<void> {
  try {
    // No ask here: granted = already consented; anything else stays silent.
    const settings = await Notifications.getPermissionsAsync();
    if (!settings.granted) return;

    // EAS project attribution (M1.5 item C): read the projectId the owner
    // commits to app.json (expo.extra.eas.projectId, written by `eas init`)
    // instead of passing undefined and hoping the manifest default resolves.
    // Pre-EAS (no project yet) this stays undefined; the token call then
    // fails softly below and push stays off — same best-effort path as a
    // denied permission.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const token = (
      await Notifications.getExpoPushTokenAsync(
        typeof projectId === 'string' && projectId ? { projectId } : {}
      )
    ).data;
    if (!token || token === lastRegisteredToken) return; // nothing new to send
    lastRegisteredToken = token;

    const push = fetchPush(client);
    await push.register({
      token,
      provider: 'expo',
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
  } catch {
    // Push is best-effort: registration failure never blocks the app.
  }
}

/** Extract the chatId a push carries (data payload, both platforms). */
function chatIdFromNotification(n: Notifications.Notification): string | undefined {
  const data = n.request?.content?.data as { chatId?: string } | undefined;
  return typeof data?.chatId === 'string' ? data?.chatId : undefined;
}

/**
 * Wire push for the signed-in session: SILENT token registration (only when
 * permission is already granted — see registerExpoPushTokenIfGranted) plus
 * the tap→deep-link listener. Returns a cleanup fn. Safe on any platform —
 * a denied permission or an unsupported device leaves push off (chat still
 * works; only the background wake signal is missing).
 */
export function usePushRegistration(client: DigbyApiClient | undefined, signedIn: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!client || !signedIn) return;

    // Silent re-registration on launch/re-sign-in (no-ops when permission
    // was never granted, or when the backend already has this token).
    void registerExpoPushTokenIfGranted(client);

    // Tap → deep link (digby://chat/<id>). Cold-start taps arrive as the
    // initial notification; foreground/background taps as the response listener.
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const chatId = chatIdFromNotification(response.notification);
      if (chatId) router.push(`/chat/${chatId}`);
    });
    return () => {
      sub.remove();
    };
  }, [client, signedIn, router]);
}
