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

  try {
    await run(python, [script, "--job", jobDir, ...extraArgs], capture);
  } catch (e: any) {
    // A bare "exited with code 1" is useless three phases from now.
    const detail = tail.length ? `\n  ${tail.join("\n  ")}` : "";
    throw new Error(`python stage "${name}" failed (${python}): ${e?.message || e}${detail}`);
  }
}
