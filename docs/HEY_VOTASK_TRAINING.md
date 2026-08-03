# Training the "hey VoTask" wake-word model (Colab runbook)

This produces `hey_votask.onnx` for the on-device wake word. It **synthesizes** all the
training speech, so you record nothing. Budget ~2–3 hours on a free T4, mostly
unattended — the bulk is downloading, not GPU time.

> **Do not follow openWakeWord's own notebook.** As of 2026 it cannot run on Colab
> at all: it installs `tensorflow-cpu==2.8.1`, which has no wheel for Python 3.12
> (what Colab now ships), and pip hard-fails. Several of its data URLs are dead too.
> The cells below replace it. Paste them into a blank Colab notebook in order.
>
> **Status: not executed end-to-end by us.** Every individual fix below was verified
> against upstream source, live URLs, and PyPI wheel tags, but nobody has run the
> whole pipeline start to finish. Expect to debug a cell or two. Where a step is
> most likely to bite, there's a note saying so.

**Runtime → Change runtime type → GPU (T4)** before you start.

---

## Cell 1 — confirm the GPU and Python version

```python
!nvidia-smi -L
import sys; print("Python", sys.version)
```

Expect a T4 and Python 3.12.x. If there's no GPU, training still works but takes
many hours.

---

## Cell 2 — install, without TensorFlow

The key deviation from upstream. **TensorFlow is only needed for the TFLite export,
which we don't want** — we need ONNX. Dropping it removes the fatal wheel problem
and most of the dependency conflicts.

Note `--no-deps` on openwakeword itself, and that we install from **git, not PyPI**:
the released PyPI package still requires `tflite-runtime`, which has no cp312 wheel,
while `main` has migrated to `ai-edge-litert`. That migration was never released.

```python
# openWakeWord from git (PyPI 0.6.0 is too old to install on Py3.12)
!git clone -q https://github.com/dscripka/openWakeWord.git
!pip install -q -e ./openWakeWord --no-deps

# Deps by hand. NEVER use the [full] extra — it pins protobuf<4, onnx==1.14,
# datasets<3, torchmetrics<1 and will spend 20 minutes backtracking before failing.
!pip install -q \
    onnx onnxruntime \
    torch torchaudio torchinfo torchmetrics \
    speechbrain audiomentations torch-audiomentations \
    acoustics pronouncing mutagen soundfile librosa \
    datasets pyyaml tqdm scipy scikit-learn \
    ai-edge-litert speexdsp-ns

# Piper TTS, for synthesizing the positive samples
!pip install -q piper-phonemize-cross piper-tts
```

`piper-phonemize` now ships a cp312 wheel, so the old "install `-cross` first to
work around the missing 3.12 wheel" advice is obsolete — either package works.

---

## Cell 3 — piper-sample-generator, with a layout shim

openWakeWord's `train.py` does `sys.path.insert(0, piper_sample_generator_path)`
then `from generate_samples import generate_samples`. That needs a **top-level**
`generate_samples.py`. Upstream has since moved it into a `piper_sample_generator/`
package, so a fresh clone raises `ModuleNotFoundError: No module named 'piper'`.

Rather than pin to an old commit, this detects the layout and writes a shim:

```python
import os, pathlib, textwrap

!git clone -q https://github.com/rhasspy/piper-sample-generator.git

root = pathlib.Path("piper-sample-generator")
if not (root / "generate_samples.py").exists():
    inner = root / "piper_sample_generator" / "generate_samples.py"
    assert inner.exists(), f"can't find generate_samples.py; layout changed again: {list(root.iterdir())}"
    (root / "generate_samples.py").write_text(textwrap.dedent("""
        # Shim: train.py expects this module at the top level, upstream moved it
        # into a package. Re-export so both layouts work.
        from piper_sample_generator.generate_samples import *          # noqa: F401,F403
        from piper_sample_generator.generate_samples import generate_samples  # noqa: F401
    """))
    print("wrote top-level shim")
else:
    print("flat layout, no shim needed")

# The TTS voice checkpoint. Only the v1.0.0/v2.0.0 release tags carry assets —
# v3.x releases exist but are empty.
!wget -q -O piper-sample-generator/models/en_US-libritts_r-medium.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt
print("voice:", os.path.getsize("piper-sample-generator/models/en_US-libritts_r-medium.pt"), "bytes")
```

---

## Cell 4 — patch `torch_audiomentations`

It calls `torchaudio.set_audio_backend()`, removed in torchaudio ≥2.1, and
`torchaudio.info()`, whose signature changed. Both crash on import.

```python
import importlib.util, pathlib

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

Prints `changed: True` the first time. No kernel restart needed — the trainer runs
as a subprocess and re-imports the patched file.

---

## Cell 5 — training data

Three notes on what changed:

- **AudioSet is gone.** The notebook fetches `agkphysics/AudioSet .../bal_train09.tar`,
  which now returns **404** — that repo was reorganised to Parquet. We use FMA for
  background noise instead.
- The ACAV100M feature file is **~17 GB** and dominates the whole runtime. It is
  the single biggest reason this takes hours. Start this cell and go do something else.
- MIT RIRs and the validation features are both still live.

```python
import os, scipy.io.wavfile, numpy as np, datasets, tqdm

# --- room impulse responses (reverb augmentation) ---
os.makedirs("mit_rirs", exist_ok=True)
rir_ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses",
                               split="train", streaming=True)
for row in tqdm.tqdm(rir_ds, desc="RIRs"):
    name = row['audio']['path'].split('/')[-1]
    scipy.io.wavfile.write(f"mit_rirs/{name}", 16000,
                           (row['audio']['array'] * 32767).astype(np.int16))

# --- background noise: FMA (AudioSet's tar is 404) ---
os.makedirs("background_clips", exist_ok=True)
fma = datasets.load_dataset("rudraml/fma", name="small", split="train", streaming=True)
fma = iter(fma.cast_column("audio", datasets.Audio(sampling_rate=16000)))
for i in tqdm.tqdm(range(2000), desc="background"):
    row = next(fma)
    scipy.io.wavfile.write(f"background_clips/{i}.wav", 16000,
                           (row['audio']['array'] * 32767).astype(np.int16))

# --- precomputed negative features (the big one, ~17 GB) ---
!wget -q --show-progress https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy
!wget -q --show-progress https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy
```

---

## Cell 6 — the config

Written as Python then dumped to YAML, so you never hand-edit `custom_model.yml`.

**`target_phrase` is a list, and giving it pronunciation variants matters here.**
"VoTask" is a coined word, so Piper has no pronunciation for it and phonemises the
single token as one mumbled blob. Splitting it into two words makes the TTS stress
both syllables the way people actually say it, and the spelling variants cover the
vowel people land on. All variants still train one binary classifier.

**`custom_negative_phrases` is doing real work here, not left empty.** The phrases
below are what English speech engines substitute for "vo task" — and they are
sentences people genuinely say in a task manager. Training against them explicitly
is what stops the model firing when someone asks a colleague "what task is next?".
This mirrors the tiering in `client/src/voice/wakeSpeech.ts`, which solves the same
problem for the speech-recognition path.

```python
import yaml

config = {
    "model_name": "hey_votask",
    "target_phrase": ["hey vo task", "hey voh task", "hey vo tusk", "hey votask"],
    "custom_negative_phrases": [
        "what task", "no task", "go task", "the task", "which task",
        "photo task", "who asked", "vote", "boat", "hey there",
    ],

    # Sample counts. Upstream recommends >=20,000; 100,000+ is better but slower.
    # 20k is a reasonable first run — retrain with more if accuracy disappoints.
    "n_samples": 20000,
    "n_samples_val": 2000,

    "tts_batch_size": 50,
    "augmentation_batch_size": 16,
    "augmentation_rounds": 1,

    "piper_sample_generator_path": "./piper-sample-generator",
    "output_dir": "./my_custom_model",
    "rir_paths": ["./mit_rirs"],
    "background_paths": ["./background_clips"],
    "background_paths_duplication_rate": [1],
    "false_positive_validation_data_path": "./validation_set_features.npy",
    "feature_data_files": {
        "ACAV100M_sample": "./openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
    },
    "batch_n_per_class": {
        "ACAV100M_sample": 1024,
        "adversarial_negative": 50,
        "positive": 50,
    },

    "model_type": "dnn",
    "layer_size": 32,
    "steps": 50000,

    # These two are the real false-positive/recall knobs. There is no
    # `target_accuracy` / `false_activation_penalty` key, whatever blog posts say.
    "max_negative_weight": 1500,
    "target_false_positives_per_hour": 0.2,
}

with open("hey_votask.yaml", "w") as f:
    yaml.dump(config, f)
print(open("hey_votask.yaml").read())
```

---

## Cell 7 — generate the positive clips

```python
!python ./openWakeWord/openwakeword/train.py --training_config hey_votask.yaml --generate_clips
```

---

## Cell 8 — ⚠️ resample 22050 → 16000

**The step most likely to bite you, and it fails late.** Piper's libritts voice
outputs **22050 Hz**, but the augmentation and feature pipeline assumes **16000 Hz**.
Skip this and you get `Clip does not have the correct sample rate` — or worse, a
model that trains and never fires. This is upstream
[issue #296](https://github.com/dscripka/openWakeWord/issues/296), still open.

```python
import librosa, soundfile as sf, glob, tqdm, os

fixed = 0
for path in tqdm.tqdm(glob.glob("my_custom_model/**/*.wav", recursive=True), desc="resample"):
    y, sr = librosa.load(path, sr=None)
    if sr != 16000:
        sf.write(path, librosa.resample(y, orig_sr=sr, target_sr=16000), 16000)
        fixed += 1
print(f"resampled {fixed} clips to 16 kHz")

# Stale feature arrays must go or they'll be reused at the wrong rate.
for npy in glob.glob("my_custom_model/**/*.npy", recursive=True):
    os.remove(npy)
    print("removed stale", npy)
```

---

## Cell 9 — augment, then train

```python
!python ./openWakeWord/openwakeword/train.py --training_config hey_votask.yaml --augment_clips
```

```python
!python ./openWakeWord/openwakeword/train.py --training_config hey_votask.yaml --train_model
```

**Do not pass `--convert_to_tflite`.** It needs the TensorFlow stack we deliberately
skipped, and we only want ONNX.

---

## Cell 10 — verify the exported model matches what the app expects

Worth 10 seconds here rather than discovering a shape mismatch in the browser. The
detector in [`client/src/voice/wakeword.ts`](../client/src/voice/wakeword.ts) feeds
16 stacked 96-d embeddings and reads one score:

```python
import onnxruntime as ort, numpy as np

sess = ort.InferenceSession("my_custom_model/hey_votask.onnx")
i, o = sess.get_inputs()[0], sess.get_outputs()[0]
print("input :", i.name, i.shape)    # expect [1, 16, 96]
print("output:", o.name, o.shape)    # expect [1, 1]

score = sess.run(None, {i.name: np.zeros((1, 16, 96), dtype=np.float32)})[0]
print("score on silence:", float(score.ravel()[0]), "(should be near 0)")
```

If the input isn't `[1,16,96]`, something exported the wrong graph — re-run Cell 9's
`--train_model` and make sure you didn't run a TFLite path.

```python
from google.colab import files
files.download("my_custom_model/hey_votask.onnx")
```

---

## Install it in the app

1. Put the file at `client/public/wakeword/hey_votask.onnx`.
2. In `client/.env`, **delete** the placeholder line — the code already defaults to
   `/wakeword/hey_votask.onnx`:
   ```diff
   - VITE_WAKEWORD_MODEL_PATH=/wakeword/hey_jarvis_v0.1.onnx
   - VITE_WAKEWORD_PHRASE=hey jarvis
   ```
3. Set `VITE_WAKEWORD_MODE=onnx` to force the on-device path everywhere (leave it
   `auto` if you still want desktop browsers using Web Speech).
4. Restart Vite — env changes need a restart — or rebuild for Android.

## Tune the threshold on a real device

With `VITE_WAKEWORD_DEBUG=true` the console logs every scored frame:

```
[wakeword] score 0.412
[wakeword] score 0.884 *** WAKE ***
```

Say "hey VoTask" a few times, then talk normally for a minute. Set the threshold below
your reliable wake peaks and above the chatter floor. Live, without a rebuild:
`localStorage.setItem('wakeword_threshold','0.6')` then reload. Once settled, commit
it as `VITE_WAKEWORD_THRESHOLD` and turn `VITE_WAKEWORD_DEBUG` off.

Start at **0.5**. "hey VoTask" is short, so it has a naturally higher false-accept rate
and often wants **0.6–0.7**. The current placeholder needs 0.2 only because the
generic "hey jarvis" model scores weakly — a purpose-trained model should peak much
higher, so if you still need 0.2 after training, the model is weak and wants more
samples.

## Before shipping commercially

openWakeWord's **pretrained** models are CC-BY-NC-SA 4.0 and cannot be used
commercially — that's why `hey_jarvis_v0.1.onnx` is a dev placeholder only, and it
must not ship. Your own trained model should be yours, but `melspectrogram.onnx` and
`embedding_model.onnx` are upstream's frozen feature extractor and every custom model
depends on them at inference. We could not get a definitive license answer for those
two files. **Confirm it before a paid release.**

---

## Troubleshooting

- **`ModuleNotFoundError: No module named 'piper'`** → Cell 3's shim didn't apply, or
  the layout changed again. Check what's actually in `piper-sample-generator/`.
- **`AttributeError: module 'torchaudio' has no attribute 'set_audio_backend'`** →
  Cell 4 didn't run, or an import beat it. Run it and re-run from there.
- **`Clip does not have the correct sample rate`** → Cell 8. Also delete the stale
  `.npy` features, which that cell does.
- **404 downloading AudioSet** → expected; we use FMA instead. Don't re-add it.
- **pip backtracking forever** → you used the `[full]` extra. Don't.
- **Colab disconnects mid-run** → free tier idles out. Keep the tab foregrounded;
  the 17 GB download is the long pole.
- **Model loads but never fires** → no `[wakeword] score` lines at all means the mic
  isn't running (grant permission; a user gesture is required before the AudioContext
  starts). Scores peaking below threshold → lower it.

See also [VOICE_ASSISTANT_SETUP.md](VOICE_ASSISTANT_SETUP.md).
