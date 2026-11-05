/**
 * Mobile app configuration.
 *
 * API_BASE_URL: the Digby backend origin. The web app reaches it via the
 * Next.js `/api` proxy; native apps talk to the Express API directly
 * (backend/src/app.ts mounts everything under /api, default port 4000).
 *
 * Local development: point at your dev backend (e.g. http://localhost:4000 —
 * use the LAN IP for a device, or adb reverse tcp:4000 tcp:4000 on Android).
 */

import Constants from 'expo-constants';

const fromManifest =
  Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;

export const API_BASE_URL: string =
  fromManifest ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://digby.ai';
