import { spawn } from "node:child_process";

const DEFAULT_PORT = 8800 + Math.floor(Math.random() * 1000);
const PORT = Number.parseInt(process.env.BILLING_DEMO_PORT ?? String(DEFAULT_PORT), 10);
const GOVERNOR_URL = process.env.GOVERNOR_URL ?? `http://127.0.0.1:${PORT}`;
const HEALTH_URL = `${GOVERNOR_URL}/health`;

const WORKSPACE_ID = process.env.BILLING_WORKSPACE_ID ?? "demo-ws";
const CREDITS = Number.parseInt(process.env.BILLING_CREDITS ?? "10", 10);

const AUTH_MODE = (process.env.BILLING_DEMO_AUTH_MODE ?? "workspace").trim().toLowerCase();
const ADMIN_KEY = process.env.BILLING_DEMO_ADMIN_KEY ?? "dev-admin-key";
const SHARED_KEY = process.env.BILLING_DEMO_API_KEY ?? "";

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

  try {
    worker.kill("SIGINT");
  } catch {
    // ignore
  }

  await sleep(750);
  if (worker.exitCode !== null) return;

  if (process.platform === "win32") {
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

async function httpJson(method, path, body, extraHeaders = {}) {
  const url = `${GOVERNOR_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const err = json?.error ? String(json.error) : `http_${res.status}`;
    const details = json ? JSON.stringify(json) : text;
    throw new Error(`[HTTP ${res.status}] ${method} ${path}: ${err}${details ? `\n${details}` : ""}`);
  }

  return json;
}

async function httpGetJson(path, extraHeaders = {}) {
  const url = `${GOVERNOR_URL}${path}`;
  const res = await fetch(url, { method: "GET", headers: { ...extraHeaders } });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ? String(json.error) : `http_${res.status}`;
    throw new Error(`[HTTP ${res.status}] GET ${path}: ${err}`);
  }
  return json;
}

function printJson(label, obj) {
  console.log(`${label} ${JSON.stringify(obj)}`);
}

async function main() {
  if (!Number.isFinite(PORT) || PORT <= 0) {
    console.error("Invalid BILLING_DEMO_PORT");
    process.exit(2);
  }

  if (!Number.isFinite(CREDITS) || CREDITS <= 0) {
    console.error("Invalid BILLING_CREDITS");
    process.exit(2);
  }

  const npm = getNpmCommand();
  const workerEnv = {
    ...process.env,
  };

  console.log(`[BILLING] starting worker url=${GOVERNOR_URL}`);
  const worker = spawnLogged(
    npm,
    [
      "--workspace",
      "worker",
      "run",
      "dev",
      "--",
      "--env",
      "billing",
      "--local",
      "--port",
      String(PORT),
    ],
    {
    env: workerEnv,
    },
  );

  try {
    await waitForHealth(HEALTH_URL);
    console.log("[BILLING] worker healthy");

    let authHeaders = {};
    if (AUTH_MODE === "shared") {
      if (!SHARED_KEY) throw new Error("Missing BILLING_DEMO_API_KEY for AUTH_MODE=shared");
      authHeaders = { authorization: `Bearer ${SHARED_KEY}` };
    } else if (AUTH_MODE === "workspace") {
      const created = await httpJson(
        "POST",
        "/v1/workspaces/create",
        { workspace_id: WORKSPACE_ID },
        { "x-admin-key": ADMIN_KEY },
      );
      const apiKey = created?.api_key ? String(created.api_key) : "";
      if (!apiKey) throw new Error("Workspace create response missing api_key");
      authHeaders = { authorization: `Bearer ${apiKey}` };
      printJson("[BILLING][WORKSPACE]", { workspace_id: created?.workspace_id, api_key_prefix: apiKey.slice(0, 6) });
    } else if (AUTH_MODE !== "off") {
      throw new Error(`Invalid BILLING_DEMO_AUTH_MODE=${AUTH_MODE} (expected off|shared|workspace)`);
    }

    const quote = await httpJson(
      "POST",
      "/v1/billing/quote",
      {
      workspace_id: WORKSPACE_ID,
      credits: CREDITS,
      },
      authHeaders,
    );
    printJson("[BILLING][QUOTE]", quote);

    const quoteId = quote?.quote_id ? String(quote.quote_id) : "";
    if (!quoteId) throw new Error("Quote response missing quote_id");

    const redeem = await httpJson(
      "POST",
      "/v1/billing/redeem",
      {
        quote_id: quoteId,
        tx_hash: `0xstub:${quoteId}`,
      },
      authHeaders,
    );
    printJson("[BILLING][REDEEM]", redeem);

    const balance1 = await httpGetJson(`/v1/billing/balance?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`, authHeaders);
    printJson("[BILLING][BALANCE]", balance1);

    const check = await httpJson(
      "POST",
      "/v1/governor/check",
      {
        policy_id: "retry_friction_v1",
        action: "model_call",
        actor: { id: "demo-actor", project: WORKSPACE_ID },
        context: {
          attempt_in_window: 1,
          window_seconds: 600,
          task_hash: "t1",
          step_hash: "s1",
          context_hash: "c1",
        },
      },
      authHeaders,
    );
    printJson("[BILLING][CHECK]", { allowed: check?.allowed, decision_id: check?.decision_id });

    const balance2 = await httpGetJson(`/v1/billing/balance?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`, authHeaders);
    printJson("[BILLING][BALANCE_AFTER]", balance2);

    console.log("[BILLING] ok");

    await stopWorker(worker);
    process.exit(0);
  } catch (error) {
    await stopWorker(worker);
    console.error(String(error));
    process.exit(1);
  }
}

await main();
