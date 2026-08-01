"""Trivial stage that proves the Node -> Python -> artifact loop works.

Exists so that when phase 2 puts a 3 GB model behind this interface, any
failure is the model's fault and not the plumbing's.
"""

from pathlib import Path

from _base import run_stage, write_json


def main(d: Path) -> dict:
    try:
        import torch
    except ImportError:
        return {"ok": False, "cuda": False, "device": None, "error": "torch not installed"}

    cuda = torch.cuda.is_available()
    device = torch.cuda.get_device_name(0) if cuda else None

    if cuda:
        # Touch the GPU for real — is_available() alone has lied before.
        x = torch.randn(512, 512, device="cuda")
        ok = bool(torch.isfinite(x @ x).all().item())
        del x
    else:
        ok = False

    return {
        "ok": ok,
        "cuda": cuda,
        "device": device,
        "torch": torch.__version__,
        "totalVramMb": int(torch.cuda.get_device_properties(0).total_memory / 1024**2) if cuda else 0,
    }


if __name__ == "__main__":
    d, out = run_stage("probe", main)
    write_json(d, "probe.json", out)
