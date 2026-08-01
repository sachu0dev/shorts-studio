import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSupportedPythonVersion,
  parseTorchProbe,
  hasNativeH264Decoder,
  parseVramMiB,
  rollup,
  type CheckResult,
} from "./systemCheck.js";

const r = (status: CheckResult["status"]): CheckResult => ({ name: "x", status, detail: "" });

test("rollup: error beats warn beats ok", () => {
  assert.equal(rollup([r("ok"), r("ok")]), "ok");
  assert.equal(rollup([r("ok"), r("warn")]), "warn");
  assert.equal(rollup([r("warn"), r("error")]), "error");
  assert.equal(rollup([]), "ok");
});

test("python version: accepts wheel-supported range, rejects 3.14", () => {
  assert.equal(isSupportedPythonVersion("Python 3.12.13"), true);
  assert.equal(isSupportedPythonVersion("Python 3.10.0"), true);
  // the actual trap on this machine — no cp314 wheels for torch
  assert.equal(isSupportedPythonVersion("Python 3.14.3"), false);
  assert.equal(isSupportedPythonVersion("Python 3.9.18"), false);
  assert.equal(isSupportedPythonVersion("Python 2.7.18"), false);
  assert.equal(isSupportedPythonVersion("not python at all"), false);
});

test("torch probe: CPU-only build is detected, not mistaken for success", () => {
  const gpu = parseTorchProbe("TORCH 2.13.0+cu130 True NVIDIA GeForce RTX 4050 Laptop GPU\n");
  assert.deepEqual(gpu, { version: "2.13.0+cu130", cuda: true, device: "NVIDIA GeForce RTX 4050 Laptop GPU" });

  const cpu = parseTorchProbe("TORCH 2.13.0+cpu False -\n");
  assert.equal(cpu?.cuda, false);

  // stderr noise (e.g. the numpy warning) must not be parsed as the probe line
  assert.equal(parseTorchProbe("UserWarning: Failed to initialize NumPy\n"), null);
});

test("h264 decoder: native decoder required, libopenh264 stub is not enough", () => {
  const full = " VFS..D h264                 H.264 / AVC\n V....D libopenh264          OpenH264 (codec h264)\n";
  assert.equal(hasNativeH264Decoder(full), true);

  // exactly what Fedora's ffmpeg-free reports — the stub alone must fail the check
  const fedora = " V....D libopenh264          OpenH264 (codec h264)\n V....D av1    AV1\n";
  assert.equal(hasNativeH264Decoder(fedora), false);
});

test("vram parse", () => {
  assert.equal(parseVramMiB("6141\n"), 6141);
  assert.equal(parseVramMiB(""), null);
});
