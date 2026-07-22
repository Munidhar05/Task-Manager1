import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.smarttask.app',
  // Launcher label. The Play Store LISTING title is set in Play Console and is
  // not read from here — this only names the icon on the device.
  appName: 'VoTask',
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
  // Native Google Sign-In (@codetrix-studio/capacitor-google-auth). Uncomment and
  // set serverClientId to your WEB OAuth client id (the same value as the backend's
  // GOOGLE_CLIENT_ID) once the plugin is installed. See docs/GOOGLE_SIGNIN_SETUP.md.
  // plugins: {
  //   GoogleAuth: {
  //     scopes: ['profile', 'email'],
  //     serverClientId: 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
  //     forceCodeForRefreshToken: false,
  //   },
  // },
}

export default config
