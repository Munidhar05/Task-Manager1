# Training the "hey BTM" wake-word model (Colab runbook)

This produces `hey_btm.onnx` for the on-device wake word. It's the **one remaining
step** — the detector code and the two shared models are already in the repo. You
run this in Google Colab (free); it **synthesizes** all the training speech, so you
record nothing. Budget ~1 hour, mostly unattended.

> Every crash we hit last time is pre-patched below. Follow the cells in order and
> don't skip the patch cell.

---

## 0. Open the notebook + pick a GPU

1. Open openWakeWord's automatic training notebook:
   <https://colab.research.google.com/github/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb>
2. **Runtime → Change runtime type → GPU** (T4 is fine). Training on CPU is painfully slow.
3. Run the notebook top-to-bottom, but apply the edits in the steps below.

---

## 1. Run the install cell(s) as-is

Run Step 1 (the `pip install` + data-download cells). Let them finish. **Ignore**
any dependency-resolver warnings — they don't matter here.

---

## 2. ⚠️ Patch cell — INSERT this and run it BEFORE any `import` of the training code

The notebook's pinned `torch-audiomentations==0.11.0` calls
`torchaudio.set_audio_backend(...)`, which was **removed in torchaudio ≥ 2.1** (what
Colab now ships). Without this patch, Steps 1/2/3 all crash on import with:

```
AttributeError: module 'torchaudio' has no attribute 'set_audio_backend'
```

Add a **new code cell** right after the installs and run it:

```python
# --- FIX: torch-audiomentations 0.11.0 calls a torchaudio API removed in >=2.1 ---
import importlib.util, re, pathlib
spec = importlib.util.find_spec("torch_audiomentations")
io_path = pathlib.Path(spec.submodule_search_locations[0]) / "utils" / "io.py"
src = io_path.read_text()
patched = src.replace(
    "torchaudio.set_audio_backend(",
    'getattr(torchaudio, "set_audio_backend", lambda *a, **k: None)(',
)
io_path.write_text(patched)
print("patched:", io_path, "| changed:", src != patched)
```

It prints `changed: True` the first time. (No kernel restart needed — the trainer
runs as a subprocess and re-imports the patched file.)

---

## 3. Set the target phrase + model name

In the notebook's **config cell** (the one that builds the training `config` dict /
YAML), set the phrase to **pronunciation variants** and name the model. Piper's TTS
mispronounces the bare initialism "BTM", so giving it spelled-out variants makes the
synthetic data much better:

```python
config["target_phrase"] = ["hey btm", "hey bee tee em", "hey b t m"]
config["model_name"]    = "hey_btm"
```

Leave the other defaults (sample counts, steps) unless you want a longer run. Run this cell.

> "hey BTM" is a **short** phrase, so it has a naturally higher false-accept rate.
> That's expected — we handle it with threshold tuning in Step 7, not here.

---

## 4. Generate clips + train

Run the training step (the cell that calls `train.py` with `--generate_clips
--augment_clips --train_model`, or the notebook's equivalent "run all training"
cell). This is the ~1 hour part:

- generates synthetic "hey btm" clips (positives) + negatives/background,
- augments them (reverb, noise),
- trains the classifier and **exports ONNX**.

The finished model lands at:

```
./my_custom_model/hey_btm.onnx
```

---

## 5. ⛔ SKIP Step 4 of the notebook (ONNX → TFLite)

We only need the **ONNX** file. The notebook's TFLite-conversion cell errors with
`No module named 'onnx'` and is **irrelevant** to this app — do not run it.

---

## 6. Download the model + drop it in the repo

1. In Colab's file browser (📁 left sidebar), open `my_custom_model/`, download
   **`hey_btm.onnx`**.
2. Put it here in the repo:
   ```
   client/public/wakeword/hey_btm.onnx
   ```
3. In **`client/.env`**, point the wake word at it (replace the placeholder line):
   ```diff
   - VITE_WAKEWORD_MODEL_PATH=/wakeword/hey_jarvis_v0.1.onnx
   ```
   Deleting that line is enough — the code defaults to `/wakeword/hey_btm.onnx`.
   Keep `VITE_WAKEWORD_ENABLED=true`.
4. For production builds, mirror it in **`client/.env.production`** if that file sets
   a model path.
5. Restart the Vite dev server (env changes need a restart), or rebuild for Android.

The model contract the export must match (openWakeWord's default output — it will):
`melspectrogram [batch, samples] → 32 mel bins`, `embedding [1,76,32,1] → 96-d`,
`wakeword [1,16,96] → 1 score`.

---

## 7. Tune the threshold on a real device

Say **"hey BTM"** with the app open. Because we ship `VITE_WAKEWORD_DEBUG=true`, the
browser console logs every scored frame:

```
[wakeword] score 0.412
[wakeword] score 0.884 *** WAKE ***
```

- Watch the peak score when you say the phrase vs. when you're just talking.
- Set the threshold just **below** your reliable "hey BTM" peaks and **above** the
  chatter noise floor. Two ways:
  - **Live, no rebuild:** `localStorage.setItem('wakeword_threshold','0.6')` in the
    console, then reload.
  - **Committed:** set `VITE_WAKEWORD_THRESHOLD=0.6` in `client/.env`.
- Start around **0.5**; a short phrase like this often needs **0.6–0.7** to avoid
  false triggers. If it never fires, lower it and check the peak scores.
- Once tuned, set `VITE_WAKEWORD_DEBUG=false` (or remove it) to quiet the console.

---

## Troubleshooting

- **Colab import crash `set_audio_backend`** → you skipped the Step 2 patch cell, or
  ran an import before it. Run the patch cell, then re-run from there.
- **Piper says "B-T-M" weirdly / poor positives** → confirm the `target_phrase`
  variants in Step 3; more variants = more robust synthetic data.
- **Model loads but never fires** → open the console: no `[wakeword] score` lines at
  all means the mic/plumbing isn't running (grant mic permission; needs a user
  gesture first). Scores that peak below your threshold → lower the threshold.
- **Wrong tensor shape error on load** → you exported something other than the
  default `[1,16,96]→1` model (e.g. ran the TFLite path). Re-export the ONNX from
  Step 4's `--train_model` output.
- **Offline / Android** → self-host the ONNX runtime: copy
  `node_modules/onnxruntime-web/dist/*.wasm` into `client/public/ort/` and set
  `VITE_ORT_WASM_PATH=/ort/` (otherwise it loads WASM from a CDN and needs network).

See also [VOICE_ASSISTANT_SETUP.md](VOICE_ASSISTANT_SETUP.md) for how the wake word
fits into the overall voice assistant.
