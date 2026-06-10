import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.smarttask.app',
  appName: 'SmartTask',
  // Vite outputs the built web app here; Capacitor copies it into the native shell.
  webDir: 'dist',
}

export default config
