/**
 * Expo app config (M2-prep — privacy manifest wiring).
 *
 * Loads app.json and injects `expo.ios.privacyManifests` from the committed
 * `PrivacyInfo.xcprivacy` (the SINGLE SOURCE OF TRUTH — edit the plist, not
 * this file). `withDefaultPlugins` → `withPrivacyInfo`
 * (@expo/prebuild-config) writes the merged manifest into the native ios/
 * project at prebuild/EAS-build time and registers it as a bundle resource.
 *
 * NOTE: without this, prebuild would NOT ship our manifest (the default
 * template only covers its own required-reason APIs — ours adds the
 * collected-data declarations the store forms must match).
 */

const fs = require('fs');
const path = require('path');
const plistModule = require('@expo/plist');
const plist = plistModule.default ?? plistModule; // CJS/ESM interop

const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));

// Parse the manifest ONCE here; the config plugins re-serialize + merge it
// into the native project (merging is additive across plugin layers).
//
// JSON round-trip: @expo/plist's parse returns NULL-PROTOTYPE objects, and
// SDK 57's @expo/config serializer (Serialize.js) calls
// val.hasOwnProperty(prop) — which throws `val.hasOwnProperty is not a
// function` on a null prototype, breaking every `expo config`/`expo install`/
// `eas build` invocation that evaluates this file. Round-tripping restores
// plain Object/Array prototypes; the manifest is JSON-safe by construction.
const privacyManifests = JSON.parse(
  JSON.stringify(
    plist.parse(fs.readFileSync(path.join(__dirname, 'PrivacyInfo.xcprivacy'), 'utf8'))
  )
);

module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    ios: {
      ...appJson.expo.ios,
      privacyManifests,
    },
  },
};
