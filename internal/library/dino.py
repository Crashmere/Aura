"""Private batched DINOv2 feature extraction and incremental candidate retrieval."""

import contextlib
import gc
import json
from pathlib import Path
import select
import sys

import numpy as np
from PIL import Image
import torch

MODEL = "dinov2-vits14-224-v1"
runtime = Path(sys.argv[1])
sys.path.insert(0, str(runtime / "dinov2-main"))
from dinov2.hub.backbones import dinov2_vits14

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
model = dinov2_vits14(pretrained=False).eval()
model.load_state_dict(torch.load(runtime / "dinov2_vits14_pretrain.pth", map_location="cpu", weights_only=True))
device = "cuda" if sys.argv[2] != "cpu" and torch.cuda.is_available() else "cpu"
startup_note = ""
try:
    model.to(device)
except RuntimeError as error:
    startup_note = str(error)[:500]
    device = "cpu"
    model.to(device)
cached = {}
keys = []
positions = {}
matrix = np.empty((1024,384), dtype=np.float32)


def remove_vector(key):
    index = positions.pop(key, None)
    if index is None:
        return
    last = keys.pop()
    if index < len(keys):
        keys[index] = last
        matrix[index] = matrix[len(keys)]
        positions[last] = index
    cached.pop(key, None)


def store_vector(key, stamp, vector):
    global matrix
    index = positions.get(key)
    if index is None:
        index = len(keys)
        if index == len(matrix):
            larger = np.empty((max(1024,len(matrix)*2),384),dtype=np.float32)
            larger[:index] = matrix[:index]
            matrix = larger
        positions[key] = index
        keys.append(key)
    matrix[index] = vector
    cached[key] = stamp
mean = np.array([.485, .456, .406], dtype=np.float32)
std = np.array([.229, .224, .225], dtype=np.float32)


def preprocess(path):
    with Image.open(path) as opened:
        im = opened.convert("RGB")
        ratio = 256 / min(im.size)
        im = im.resize((round(im.width * ratio), round(im.height * ratio)), Image.Resampling.BICUBIC)
        left, top = (im.width - 224) // 2, (im.height - 224) // 2
        im = im.crop((left, top, left + 224, top + 224))
        pixels = (np.asarray(im, dtype=np.float32) / 255 - mean) / std
        return torch.from_numpy(np.ascontiguousarray(pixels.transpose(2, 0, 1)))


def infer(tensors):
    global device, model
    note = ""
    batch = None
    try:
        batch = torch.stack(tensors).to(device)
        amp = torch.autocast("cuda", dtype=torch.float16) if device == "cuda" else contextlib.nullcontext()
        with torch.inference_mode(), amp:
            features = torch.nn.functional.normalize(model(batch).float(), dim=1).cpu().numpy()
    except RuntimeError as error:
        if device != "cuda":
            raise
        note = str(error)[:500]
        device = "cpu"
        model.to(device)
        del batch
        torch.cuda.empty_cache()
        with torch.inference_mode():
            features = torch.nn.functional.normalize(model(torch.stack(tensors)).float(), dim=1).numpy()
    return features, note


def process(request):
    records = Path(request["records"])
    if request.get("reset"):
        cached.clear()
        keys.clear()
        positions.clear()
    for item in request["catalog"]:
        key, stamp = item["hash"], item["thumbnail"]
        if not stamp:
            remove_vector(key)
            continue
        if cached.get(key) == stamp:
            continue
        remove_vector(key)
        try:
            record = json.loads((records / f"{key}-dino-vits14-224-v1.json").read_text())
            vector = np.asarray(record["vector"], dtype=np.float32)
            if record["model"] == MODEL and record["thumbnail"] == stamp and vector.shape == (384,) and np.isfinite(vector).all():
                store_vector(key, stamp, vector)
        except (OSError, ValueError, KeyError):
            pass
    outputs, tensors, items = [], [], []
    for item in request["items"]:
        try:
            tensors.append(preprocess(item["path"]))
            items.append(item)
        except Exception as error:
            outputs.append({"hash": item["hash"], "error": str(error)[:500]})
    note = startup_note
    if items:
        features, fallback_note = infer(tensors)
        note = fallback_note or note
        for item, vector in zip(items, features):
            store_vector(item["hash"], item["thumbnail"], vector)
        # CPU scores reuse normalized vectors; retrieval does not run the model again.
        scores = features @ matrix[:len(keys)].T
        for item, vector, row in zip(items, features, scores):
            row[positions[item["hash"]]] = -2
            count = min(20, len(keys))
            best = np.argpartition(-row, count - 1)[:count]
            best = sorted(best, key=lambda index: (-float(row[index]), keys[index]))
            matches = [{"hash": keys[index], "score": float(row[index])} for index in best if row[index] >= .7]
            outputs.append({"hash": item["hash"], "vector": vector.tolist(), "matches": matches})
    return {"items": outputs, "engine": "NVIDIA GPU" if device == "cuda" else "CPU", "note": note}


while select.select([sys.stdin], [], [], 30)[0]:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        result = process(json.loads(line))
    except Exception as error:
        result = {"error": str(error)[:1000]}
    print(json.dumps(result, allow_nan=False, separators=(",", ":")), flush=True)
    gc.collect()
