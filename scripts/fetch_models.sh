#!/usr/bin/env bash
# Downloads MI-GAN and exports the YOLO11 segmentation models into public/models/.
# Needs curl and uv (https://docs.astral.sh/uv/). Files that already exist are skipped.
#
#   npm run models                         # MI-GAN + yolo11n-seg + yolo11s-seg
#   YOLO_MODELS="yolo11n-seg" npm run models
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

YOLO_MODELS="${YOLO_MODELS:-yolo11n-seg yolo11s-seg}"
for model in $YOLO_MODELS; do
  if [ -f "$OUT/$model.onnx" ]; then
    echo "$model.onnx already present"
    continue
  fi
  if ! command -v uv >/dev/null; then
    echo "uv is not installed. Either install it, or run this yourself and copy the result to public/models/:" >&2
    echo "  pip install ultralytics onnx onnxslim onnxruntime" >&2
    echo "  yolo export model=$model.pt format=onnx imgsz=640 opset=17 simplify=True" >&2
    exit 1
  fi
  work="$(mktemp -d)"
  echo "Exporting $model to ONNX..."
  (cd "$work" && uv run --python 3.12 --with ultralytics --with onnx --with onnxslim --with onnxruntime \
    yolo export "model=$model.pt" format=onnx imgsz=640 opset=17 simplify=True)
  cp "$work/$model.onnx" "$OUT/"
  rm -rf "$work"
done

ls -lh "$OUT"
