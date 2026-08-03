# Wake-word model files ("hey VoTask" — openWakeWord)

The wake word needs three ONNX models in this folder:

| File | Status | What it is |
|---|---|---|
| `melspectrogram.onnx` | ✅ **included** | shared audio feature model |
| `embedding_model.onnx` | ✅ **included** | shared speech embedding model |
| `hey_votask.onnx` | ⬜ **you train this** | the custom "hey VoTask" detector |

The two shared models are committed here (Apache-2.0, ~2.4 MB total). They were
pulled from the openWakeWord release assets:
<https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/>

## Remaining step — train `hey_votask.onnx`

Use openWakeWord's automatic training notebook (it synthesizes the training speech
for you — no recording needed). Open it straight in Colab:

<https://colab.research.google.com/github/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb>

Set the target phrase to **`hey vo task`** — spelled as two words, so the
text-to-speech that generates the training clips stresses it the way people say it.
A single token (`heyvotask`) tends to synthesize as one mumbled word and trains a
weaker model. Run the notebook, download the exported **ONNX** model, rename it to
`hey_votask.onnx`, and drop it in this folder.

Then set `VITE_WAKEWORD_ENABLED=true` in `client/.env` (and in
`client/.env.production` for a shipped build) and rebuild the client.

### Do not ship `hey_jarvis_v0.1.onnx`

`hey_jarvis_v0.1.onnx` is still in this folder as a way to smoke-test the ONNX
pipeline end to end. It must not reach a release build, for two reasons: it fires on
"hey Jarvis" and can never fire on "hey VoTask", and openWakeWord's pre-trained
models are not licensed for commercial distribution. `vite.config.ts` already drops
this whole folder from the bundle unless `VITE_WAKEWORD_ENABLED=true`, so the guard
is: don't enable the wake word for production until `hey_votask.onnx` exists.

## Until then

The speech-recognition path (`client/src/voice/wakeSpeech.ts`) handles "hey VoTask"
today with no model at all — it matches the phrase in the browser's transcript,
including the ways engines mishear a coined word (`wotask`, `vote ask`, `photo
task`, `who task`, …). It needs network and is Chrome / Android-WebView only, which
is exactly why the on-device model is still worth training.

Full details: `docs/VOICE_ASSISTANT_SETUP.md`.
