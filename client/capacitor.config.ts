import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.smarttask.app',
  appName: 'SmartTask',
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
}

export default config
