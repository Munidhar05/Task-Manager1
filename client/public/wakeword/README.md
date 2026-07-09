# Wake-word model files ("hey BTM" — openWakeWord)

The wake word needs three ONNX models in this folder:

| File | Status | What it is |
|---|---|---|
| `melspectrogram.onnx` | ✅ **included** | shared audio feature model |
| `embedding_model.onnx` | ✅ **included** | shared speech embedding model |
| `hey_btm.onnx` | ⬜ **you train this** | the custom "hey BTM" detector |

The two shared models are committed here (Apache-2.0, ~2.4 MB total). They were
pulled from the openWakeWord release assets:
<https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/>

## Remaining step — train `hey_btm.onnx`

Use openWakeWord's automatic training notebook (it synthesizes the training speech
for you — no recording needed). Open it straight in Colab:

<https://colab.research.google.com/github/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb>

Set the target phrase to **`hey btm`**, run the notebook, download the exported
**ONNX** model, rename it to `hey_btm.onnx`, and drop it in this folder.

Then enable it in `client/.env`:

```
VITE_WAKEWORD_ENABLED=true
```

Rebuild the client. Until then the voice assistant works via the tap-the-mic
button. Full details: `docs/VOICE_ASSISTANT_SETUP.md`.
