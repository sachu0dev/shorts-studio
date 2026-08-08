import path from "node:path";
import { run } from "./download.js";

const WORKER_PYTHON = process.env.WORKER_PYTHON || "./worker/.venv/bin/python";

/**
 * Invokes `$WORKER_PYTHON worker/stages/<name>.py --job <dir>`.
 * Every Python media stage from phase 2 on goes through here, so the readable
 * error is written once rather than in each stage.
 */
export async function runPythonStage(
  name: string,
  jobDir: string,
  onLine: (line: string) => void,
  extraArgs: string[] = []
): Promise<void> {
  const script = path.resolve("worker", "stages", `${name}.py`);
  const python = path.resolve(WORKER_PYTHON);
  const tail: string[] = [];

  const capture = (l: string) => {
    tail.push(l);
    if (tail.length > 20) tail.shift();
    onLine(l);
  };

  // Emit a heartbeat every 15s so the UI shows the stage is still alive
  // during long silent Python runs (e.g. scene detection on 50min videos).
  const start = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    onLine(`⏳ ${name} still running (${elapsed}s elapsed)…`);
  }, 15_000);

  try {
    await run(python, [script, "--job", jobDir, ...extraArgs], capture);
  } catch (e: any) {
    const detail = tail.length ? `\n  ${tail.join("\n  ")}` : "";
    throw new Error(`python stage "${name}" failed (${python}): ${e?.message || e}${detail}`);
  } finally {
    clearInterval(heartbeat);
  }
}
