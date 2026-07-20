import { defineConfig, loadEnv, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// The wake word costs ~9 MB of the bundle: the ONNX runtime WASM (~26 MB raw,
// ~6 MB compressed) plus three models. All of it is dead weight in a build where
// VITE_WAKEWORD_ENABLED isn't 'true' — the detector's gate is false, so the code
// can never run and the browser never fetches any of it.
//
// It also must not ship as-is: hey_jarvis_v0.1.onnx is openWakeWord's PRETRAINED
// placeholder, licensed CC-BY-NC-SA (non-commercial), and a Play Store release is
// commercial distribution. It stands in until hey_btm.onnx is trained.
//
// The dynamic `await import('onnxruntime-web')` in voice/wakeword.ts is not enough
// to keep the runtime out: a dynamic import defers WHEN a chunk is fetched, not
// WHETHER it is built. So when the feature is off, stub the module out and drop
// the models from the output.
function dropWakeWordAssets(enabled: boolean): Plugin {
  return {
    name: 'drop-wake-word-assets',
    apply: 'build',
    // 'pre' matters: without it Vite's own resolver claims the specifier first
    // and the runtime gets bundled anyway. Matches subpath imports too
    // (onnxruntime-web/webgpu etc.), since any of them pulls in the WASM.
    enforce: 'pre',
    resolveId(source) {
      if (!enabled && /^onnxruntime-web(\/|$)/.test(source)) return '\0empty-onnxruntime'
      return null
    },
    load(id) {
      if (id === '\0empty-onnxruntime') return 'export default {}'
      return null
    },
    // Anything under public/ is copied verbatim, so the models need removing
    // after the fact rather than filtering on the way in.
    closeBundle() {
      if (enabled) return
      const dir = path.resolve(__dirname, 'dist/wakeword')
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        console.log('[wakeword] disabled — omitted models and ONNX runtime from the build')
      }
    },
  }
}

// The dev server proxies /api to the Express backend on :4000
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_')
  const wakeWord = env.VITE_WAKEWORD_ENABLED === 'true'
  return {
    plugins: [react(), dropWakeWordAssets(wakeWord)],
    server: {
      port: 3000,
      host: true,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://localhost:8001',
          changeOrigin: true,
          ws: true, // forward the /api/meetings/live WebSocket upgrade to the backend
        },
      },
    },
  }
})
