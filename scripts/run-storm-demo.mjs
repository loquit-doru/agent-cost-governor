import { spawn } from "node:child_process";

const GOVERNOR_URL = process.env.GOVERNOR_URL ?? "http://127.0.0.1:8787";
const HEALTH_URL = `${GOVERNOR_URL}/health`;

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnLogged(command, args, options = {}) {
  const useShell = process.platform === "win32";
  return spawn(command, args, {
    stdio: "inherit",
    shell: useShell,
    ...options,
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
      lastError = new Error(`Healthcheck returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for worker health at ${url}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });

  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
}

async function stopWorker(worker) {
  if (!worker?.pid) return;

  // Best-effort graceful stop first.
  try {
    worker.kill("SIGINT");
  } catch {
    // ignore
  }

  // Give it a moment to shut down.
  await sleep(750);

  if (worker.exitCode !== null) return;

  if (process.platform === "win32") {
    // SIG* signals are unreliable on Windows; ensure the process tree is terminated.
    const result = spawn("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((resolve) => result.on("exit", resolve));
    return;
  }

  try {
    worker.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "block" && mode !== "redeem" && mode !== "smoke") {
    console.error("Usage: node scripts/run-storm-demo.mjs <block|redeem|smoke>");
    process.exit(2);
  }

  const npm = getNpmCommand();
  const worker = spawnLogged(npm, ["run", "dev:worker"], {
    env: process.env,
  });

  try {
    await waitForHealth(HEALTH_URL);

    const runnerArgs = [
      "runner/dist/cli.js",
      "run",
      mode === "smoke" ? "examples/demo-task.json" : "examples/storm-task.json",
      "--governor",
      GOVERNOR_URL,
    ];

    if (mode === "block") {
      runnerArgs.push("--abort-on-402");
    } else {
      runnerArgs.push("--tx-hash", "0xstub");
    }

    const result = await runProcess(process.execPath, runnerArgs, { env: process.env });

    // Always stop the worker; runner exit code is authoritative.
    await stopWorker(worker);
    process.exit(result.code);
  } catch (error) {
    await stopWorker(worker);
    console.error(String(error));
    process.exit(1);
  }
}

await main();
