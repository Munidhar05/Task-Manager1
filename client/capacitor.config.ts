import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.smarttask.app',
  appName: 'Befach Task Manager',
  // Vite outputs the built web app here; Capacitor copies it into the native shell.
  webDir: 'dist',
  server: {
    // Serve the app over http://localhost (not the default https) so it can call
    // a plain-http backend without the WebView blocking it as "mixed content".
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    // Belt-and-suspenders: allow http requests from the WebView.
    allowMixedContent: true,
  },
  // Voice assistant spoken replies on Android use @capacitor-community/text-to-speech.
  // Install it and run `npx cap sync android` to enable native TTS:
  //   npm install @capacitor-community/text-to-speech
  // (No config needed; the web build falls back to speechSynthesis. See
  // docs/VOICE_ASSISTANT_SETUP.md.)
  //
  // Native Google Sign-In (@codetrix-studio/capacitor-google-auth). serverClientId
  // MUST be your WEB OAuth client id (same value as the backend's GOOGLE_CLIENT_ID);
  // it is read from VITE_GOOGLE_CLIENT_ID so nothing is hardcoded. To finish Android:
  //   npm install @codetrix-studio/capacitor-google-auth && npx cap sync android
  // and add your Android OAuth client (package io.smarttask.app + signing SHA-1) in
  // Google Cloud, listing that Android client id in the backend's GOOGLE_CLIENT_IDS_EXTRA.
  // See docs/GOOGLE_SIGNIN_SETUP.md.
  plugins: {
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: process.env.VITE_GOOGLE_CLIENT_ID || '',
      forceCodeForRefreshToken: false,
    },
  },
}

export default config
