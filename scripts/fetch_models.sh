#!/usr/bin/env bash
# Downloads MI-GAN and exports the YOLO11 segmentation models into public/models/.
# Needs curl and uv (https://docs.astral.sh/uv/). Files that already exist are skipped.
#
#   npm run models                         # MI-GAN + the four YOLO models below
#   YOLO_MODELS="yolo11n-seg" npm run models
#
# A name ending in -320 is the same model exported for 320×320 input instead of 640×640:
# about 4× less work per frame, for slower devices such as an iPad, but it misses small phones.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${MODELS_DIR:-$PWD/public/models}"
mkdir -p "$OUT"

MIGAN_URL="https://huggingface.co/andraniksargsyan/migan/resolve/main/migan.onnx"
MIGAN_SHA="593eba0b7e04730f1b61c0a3cbca68d97d8d6a7ff5c6a44a7b9d7fcd880fc5ae"

if [ ! -f "$OUT/migan.onnx" ]; then
  echo "Downloading MI-GAN (about 30 MB)..."
  curl -L --fail -o "$OUT/migan.onnx" "$MIGAN_URL"
fi
echo "$MIGAN_SHA  $OUT/migan.onnx" | shasum -a 256 -c -

YOLO_MODELS="${YOLO_MODELS:-yolo11n-seg yolo11s-seg yolo11n-seg-320 yolo11s-seg-320}"
for model in $YOLO_MODELS; do
  if [ -f "$OUT/$model.onnx" ]; then
    echo "$model.onnx already present"
    continue
  fi
  base="$model"
  size=640
  if [[ "$model" =~ ^(.+)-([0-9]+)$ ]]; then
    base="${BASH_REMATCH[1]}"
    size="${BASH_REMATCH[2]}"
  fi
  if ! command -v uv >/dev/null; then
    echo "uv is not installed. Either install it, or run this yourself and copy the result to public/models/:" >&2
    echo "  pip install ultralytics onnx onnxslim onnxruntime" >&2
    echo "  yolo export model=$base.pt format=onnx imgsz=$size opset=17 simplify=True" >&2
    exit 1
  fi
  work="$(mktemp -d)"
  echo "Exporting $base at ${size}×${size} to ONNX..."
  (cd "$work" && uv run --python 3.12 --with ultralytics --with onnx --with onnxslim --with onnxruntime \
    yolo export "model=$base.pt" format=onnx "imgsz=$size" opset=17 simplify=True)
  cp "$work/$base.onnx" "$OUT/$model.onnx"
  rm -rf "$work"
done

ls -lh "$OUT"
