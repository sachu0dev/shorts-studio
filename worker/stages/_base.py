"""Shared harness for Python media stages.

Handles the four things every stage needs and none should re-implement:
argument parsing, atomic artifact IO, timing + peak-VRAM reporting, and the
mandatory GPU teardown. On a 6 GB card the teardown is not optional — one
stage that leaks its model makes the next stage OOM.
"""

import argparse
import gc
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

SCHEMA_VERSION = 1


def job_dir() -> Path:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True, help="job directory (storage/<jobId>)")
    args, _unknown = p.parse_known_args()
    d = Path(args.job)
    if not d.is_dir():
        raise SystemExit(f"job dir does not exist: {d}")
    return d


def read_json(d: Path, rel: str) -> Optional[Any]:
    f = d / rel
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text())
    except json.JSONDecodeError:
        return None  # corrupt reads as missing, same rule as the Node store


def write_json(d: Path, rel: str, obj: Any) -> None:
    f = d / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_name(f"{f.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(obj, indent=2))
    tmp.replace(f)  # atomic within the same filesystem


def _torch():
    try:
        import torch

        return torch
    except ImportError:
        return None


class _VramSampler(threading.Thread):
    """Samples DEVICE-WIDE VRAM use.

    `torch.cuda.max_memory_allocated()` only sees torch's own allocator, so it
    misses CTranslate2 (faster-whisper) entirely — it under-reported a large-v3
    run as 731 MiB. `mem_get_info` reports the whole device, which is the number
    the 6 GB ceiling is actually about.
    """

    def __init__(self, torch, interval: float = 0.25):
        super().__init__(daemon=True)
        self._torch = torch
        self._interval = interval
        self._stop_event = threading.Event()
        self.peak_mb = 0

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                free, total = self._torch.cuda.mem_get_info()
                self.peak_mb = max(self.peak_mb, (total - free) // 1024**2)
            except Exception:  # noqa: BLE001 - sampling must never kill the stage
                return
            self._stop_event.wait(self._interval)

    def stop(self) -> int:
        self._stop_event.set()
        self.join(timeout=2)
        return self.peak_mb


def run_stage(name: str, fn: Callable[[Path], dict]) -> tuple:
    """Runs fn(job_dir), returning (job_dir, artifact).

    The artifact always carries schemaVersion, peakVramMb and ms. GPU memory is
    released in a finally block so a raising stage still cleans up.
    """
    d = job_dir()
    torch = _torch()
    cuda = bool(torch and torch.cuda.is_available())

    sampler = None
    if cuda:
        torch.cuda.reset_peak_memory_stats()
        sampler = _VramSampler(torch)
        sampler.start()

    t0 = time.perf_counter()
    try:
        out = fn(d)
        peak = sampler.stop() if sampler else 0
        out.setdefault("schemaVersion", SCHEMA_VERSION)
        out["peakVramMb"] = peak
        out["peakVramTorchMb"] = int(torch.cuda.max_memory_allocated() / 1024**2) if cuda else 0
        out["ms"] = int((time.perf_counter() - t0) * 1000)
        print(f"[{name}] ok in {out['ms']}ms, peak VRAM {peak} MiB (device-wide)", flush=True)
        return d, out
    finally:
        if sampler:
            sampler.stop()
        gc.collect()
        if cuda:
            torch.cuda.empty_cache()
