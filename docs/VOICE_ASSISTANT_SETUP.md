# Voice assistant ("hey VoTask") — how it works & setup

The app has a hands-free voice assistant: a floating mic button (bottom-right) on
every page. Tap it (or say the wake word, once configured) and speak commands like:

- "Create a high priority task for Reddy to finish the logo by Friday"
- "Mark the logo task as done"
- "Show me overdue tasks" · "Open Reddy's tasks"
- "Assign this to Sameer" · "Set the payment task to high priority"
- "What needs my attention today?"

It's **conversational** — it asks follow-up questions ("Which logo task?") and
**confirms before changing anything** ("… shall I create it?"). Managers, admins,
and employees can all use it; every action goes through the normal task APIs, so
permissions and notifications are unchanged. English / Hindi / Telugu / code-mixed
all work (same transcription engine as the rest of the app).

## What works out of the box

**Nothing to configure for the core experience.** As long as the server has an AI
engine set (`OPENROUTER_API_KEY`, or Anthropic/OpenAI) — which this app already
uses — the voice assistant works today via the **tap-the-mic** button on web and
Android. Spoken replies use the browser's speech synthesis on web.

Two things are optional add-ons: the **"hey VoTask" wake word** and **native Android
text-to-speech**.

---

## Optional 1 — the "hey VoTask" wake word (free, openWakeWord)

Without this, you tap the mic. With it, saying **"hey VoTask"** opens the assistant
and starts listening (while the app is open — background/closed-app listening was
intentionally not built). It uses **openWakeWord** — free, open-source, on-device,
with no per-user cost — running in the browser / Android WebView via onnxruntime-web.

It needs three ONNX models in `client/public/wakeword/`:

| File | Status |
|---|---|
| `melspectrogram.onnx` — shared feature model | ✅ already committed |
| `embedding_model.onnx` — shared embedding model | ✅ already committed |
| `hey_votask.onnx` — your custom detector | ⬜ you train this |

The two shared models are already in the repo (Apache-2.0, ~2.4 MB), taken from the
[openWakeWord v0.5.1 release assets](https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1).
Note they are **not** browsable in the repo source tree — upstream ships them as
release assets / via `openwakeword.utils.download_models()`.

**Only remaining step — train `hey_votask.onnx`:**

👉 **Follow the step-by-step runbook: [HEY_VOTASK_TRAINING.md](HEY_VOTASK_TRAINING.md).**
It has the exact Colab cells with every crash we already hit pre-patched (the
`torchaudio.set_audio_backend` fix, the pronunciation variants, which steps to skip).
In short: run openWakeWord's [automatic training notebook](https://colab.research.google.com/github/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb)
(~1 hr, synthesizes its own speech), download `hey_votask.onnx` into
`client/public/wakeword/`, remove the placeholder `VITE_WAKEWORD_MODEL_PATH` line
from `client/.env`, and restart. `VITE_WAKEWORD_ENABLED=true` is already set.

Verified model contract (so you know what the exported model must match):
`melspectrogram` takes `[batch, samples]` → 32 mel bins; `embedding_model` takes
`[1, 76, 32, 1]` → 96-d vector; the wake-word model takes `[1, 16, 96]` → one score.
openWakeWord's training notebook produces exactly this shape by default.

Tuning & notes:
- Runs **on-device** — no audio leaves the device for detection.
- Listens only while the app is **open**; it pauses during an active conversation
  and re-arms afterwards (so it doesn't fight the command recorder for the mic).
- **Sensitivity:** adjust `VITE_WAKEWORD_THRESHOLD` (default `0.5`). Lower = more
  sensitive (more false triggers); higher = stricter. Expect to tune this on-device.
- **Offline / Android:** by default onnxruntime-web loads its WASM from a CDN. For
  fully offline use, copy the `onnxruntime-web/dist/*.wasm` files into
  `client/public/ort/` and set `VITE_ORT_WASM_PATH=/ort/`.
- Missing files / load error → it silently falls back to tap-the-mic.
- This browser port is new and benefits from real-device testing — if detection is
  flaky, tune the threshold first.

---

## Optional 2 — native text-to-speech on Android

On web, spoken replies use the browser. For nicer/reliable speech in the Android
app, install the Capacitor TTS plugin:

```bash
cd client
npm install @capacitor-community/text-to-speech
npx cap sync android
```

No config needed — the code already routes to it on native and to `speechSynthesis`
on web. Users can mute replies with the speaker icon in the assistant header.

---

## Permissions

- **Microphone:** already granted — `RECORD_AUDIO` is in the Android manifest
  (the app's other voice features use it), and the browser prompts on first use.

## Server side

The brain is `POST /api/assistant/command` — it turns each utterance into one
resolved action (create/status/assign/priority/due), a navigation target, an
answer, or a clarifying question, using the AI engine already configured for the
app. Usage is metered under the `voice_command` feature in the per-org usage stats.

## Troubleshooting

- **Mic button does nothing / "needs microphone access":** grant mic permission
  for the site/app and try again.
- **No spoken replies:** unmute via the speaker icon; on Android install the TTS
  plugin above; some browsers need a user interaction before speech works.
- **"Voice control needs an AI engine configured":** set `OPENROUTER_API_KEY` (or
  Anthropic/OpenAI) on the server.
- **Wake word never triggers:** confirm `hey_votask.onnx` (plus the two shared models)
  is in `client/public/wakeword/` and `VITE_WAKEWORD_ENABLED=true`, then restart the
  dev server / rebuild. Open the browser console: if you see no `[wakeword] score …`
  lines at all, the mic/plumbing isn't running (grant mic permission; it needs a user
  gesture first); if scores peak below the threshold, lower `VITE_WAKEWORD_THRESHOLD`.
  Full training + tuning steps: [HEY_VOTASK_TRAINING.md](HEY_VOTASK_TRAINING.md).
