"""Print the inputs, outputs, opset and op histogram of an ONNX model.

Usage:
    uv run --python 3.12 --with onnx python scripts/inspect_onnx.py public/models/migan_pipeline_v2.onnx
"""
import sys
from collections import Counter

import onnx

ELEM = onnx.TensorProto.DataType.Name


def dims(vi):
    t = vi.type.tensor_type
    shape = [d.dim_param or d.dim_value for d in t.shape.dim]
    return f"{ELEM(t.elem_type):8s} {shape}"


def main(path: str) -> None:
    model = onnx.load(path, load_external_data=False)
    g = model.graph
    init = {i.name for i in g.initializer}
    print(f"== {path}")
    print("ir_version", model.ir_version, "| opsets", [(o.domain or "ai.onnx", o.version) for o in model.opset_import])
    print("producer", model.producer_name, model.producer_version)
    print("inputs:")
    for i in g.input:
        if i.name not in init:
            print(f"  {i.name:20s} {dims(i)}")
    print("outputs:")
    for o in g.output:
        print(f"  {o.name:20s} {dims(o)}")
    ops = Counter(n.op_type for n in g.node)
    print(f"nodes: {len(g.node)}")
    print("ops:", ", ".join(f"{k}×{v}" for k, v in ops.most_common()))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        main(p)
