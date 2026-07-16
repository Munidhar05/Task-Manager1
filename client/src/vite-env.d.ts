/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the backend API (empty in dev; hosted URL for the Android build). */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
