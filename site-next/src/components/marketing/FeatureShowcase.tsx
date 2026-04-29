import { useEffect, useRef, useState } from "react";

const TAB_DURATION = 8000;
const NUM_TABS = 4;

interface Tab {
  label: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  {
    label: "Loop Detection",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    label: "Budget Control",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
        <path d="M7 8h10M7 12h6" />
      </svg>
    ),
  },
  {
    label: "Signed Proof",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    label: "5 Integrations",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
];

export default function FeatureShowcase() {
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = null;
    setProgress(0);

    function tick(ts: number) {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const pct = Math.min(100, (elapsed / TAB_DURATION) * 100);
      setProgress(pct);
      if (pct < 100) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setActive((a) => (a + 1) % NUM_TABS);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  return (
    <section id="anim" className="pg-section">
      <div className="mx-auto max-w-6xl px-6">
        <p className="pg-eyebrow">In action</p>
        <h2 className="pg-h2 mt-3">Every agent decision, governed</h2>
        <p className="pg-subtitle">
          One call before each action — loop detection, budget enforcement,
          signed proof, and five SDK integrations.
        </p>

        {/* Tabs */}
        <div className="mt-9 flex flex-wrap gap-1">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              type="button"
              onClick={() => setActive(i)}
              className={`sc-tab ${i === active ? "active" : ""}`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Progress bar */}
        <div className="mt-2.5 h-0.5 overflow-hidden rounded-full bg-[var(--color-border)]">
          <div
            className="h-full bg-[var(--color-teal)] transition-[width] duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Panels */}
        <div className="mt-4">
          {active === 0 && <LoopDetectionPanel />}
          {active === 1 && <BudgetPanel />}
          {active === 2 && <SignedProofPanel />}
          {active === 3 && <IntegrationsPanel />}
        </div>
      </div>
    </section>
  );
}

/* ── Panel 0: Loop Detection ─────────────────────────────────────── */
type Zone = "safe" | "gray" | "storm";

interface LoopState {
  iter: number;
  zone: Zone;
  decision: "allow" | "block";
  label: string;
  bar: number;
  showPktL: boolean;
  pktLPos: number;
  showPktR: boolean;
  pktRPos: number;
  pktRRed: boolean;
  gateEval: boolean;
  resultBox: "" | "allow" | "block";
  resultText: string;
  resultLbl: string;
}

const initialLoop: LoopState = {
  iter: 0,
  zone: "safe",
  decision: "allow",
  label: "loading…",
  bar: 0,
  showPktL: false,
  pktLPos: 0,
  showPktR: false,
  pktRPos: 0,
  pktRRed: false,
  gateEval: false,
  resultBox: "",
  resultText: "—",
  resultLbl: "—",
};

const scenarios: Array<Pick<LoopState, "iter" | "zone" | "decision" | "label" | "bar">> = [
  {
    iter: 2,
    zone: "safe",
    decision: "allow",
    label: "iteration 2 · normal operation",
    bar: 18,
  },
  {
    iter: 8,
    zone: "gray",
    decision: "allow",
    label: "iteration 8 · AI evaluation",
    bar: 72,
  },
  {
    iter: 11,
    zone: "storm",
    decision: "block",
    label: "iteration 11 · loop detected",
    bar: 100,
  },
];

const barColors: Record<Zone, string> = {
  safe: "#4ade80",
  gray: "#fbbf24",
  storm: "#f87171",
};

function LoopDetectionPanel() {
  const [s, setS] = useState<LoopState>(initialLoop);

  useEffect(() => {
    let cancelled = false;
    let scenarioIdx = 0;
    let pktRaf: number | null = null;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const animPacket = (
      from: number,
      to: number,
      durationMs: number,
      onFrame: (pos: number) => void,
    ) =>
      new Promise<void>((resolve) => {
        const start = performance.now();
        const step = (now: number) => {
          if (cancelled) {
            resolve();
            return;
          }
          const t = Math.min((now - start) / durationMs, 1);
          const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          onFrame(from + (to - from) * ease);
          if (t < 1) pktRaf = requestAnimationFrame(step);
          else resolve();
        };
        pktRaf = requestAnimationFrame(step);
      });

    async function runOne() {
      const sc = scenarios[scenarioIdx % scenarios.length];

      // reset
      setS({
        ...initialLoop,
        label: sc.label,
        iter: sc.iter,
        zone: sc.zone,
        decision: sc.decision,
        bar: sc.bar,
      });
      await sleep(300);
      if (cancelled) return;

      // packet L → gate
      setS((p) => ({ ...p, showPktL: true, pktLPos: 0 }));
      await animPacket(0, 1, 600, (pos) =>
        setS((p) => ({ ...p, pktLPos: pos })),
      );
      if (cancelled) return;
      await sleep(100);
      setS((p) => ({ ...p, showPktL: false }));

      setS((p) => ({ ...p, gateEval: true }));
      await sleep(sc.zone === "gray" ? 700 : 400);
      if (cancelled) return;

      if (sc.decision === "allow") {
        setS((p) => ({ ...p, showPktR: true, pktRPos: 0, pktRRed: false }));
        await animPacket(0, 1, 600, (pos) =>
          setS((p) => ({ ...p, pktRPos: pos })),
        );
        if (cancelled) return;
        await sleep(100);
        setS((p) => ({
          ...p,
          showPktR: false,
          resultBox: "allow",
          resultText: "ALLOW",
          resultLbl: "proceed_token ✓",
        }));
      } else {
        setS((p) => ({
          ...p,
          showPktR: true,
          pktRRed: true,
          pktRPos: 0.3,
        }));
        await sleep(200);
        setS((p) => ({
          ...p,
          showPktR: false,
          pktRRed: false,
          resultBox: "block",
          resultText: "BLOCK",
          resultLbl: "429 loop_detected",
        }));
      }
      await sleep(2200);
      scenarioIdx++;
    }

    (async () => {
      while (!cancelled) {
        await runOne();
      }
    })();

    return () => {
      cancelled = true;
      if (pktRaf !== null) cancelAnimationFrame(pktRaf);
    };
  }, []);

  return (
    <div className="flow-wrap">
      <div className={`sc-pill ${s.zone}`}>
        <span className="sc-dot" />
        <span>{s.label}</span>
      </div>
      <div className="flow-diagram">
        <div className="fnode">
          <div className="fnode-box">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </div>
          <span className="fnode-lbl">agent</span>
        </div>
        <div className="fpipe">
          <div className="fpipe-track">
            <div
              className="fpkt"
              style={{
                transform: `translate(${(s.showPktL ? s.pktLPos : -0.5) * 100}%, -50%) scale(${s.showPktL ? 1 : 0})`,
                transition: s.showPktL ? "none" : "transform 0.1s",
              }}
            />
          </div>
          <span className="fpipe-lbl">POST /check</span>
        </div>
        <div className="fgate">
          <div className={`fgate-box ${s.gateEval ? "eval" : ""}`}>
            <div
              className={`fzone ${s.zone === "safe" && s.gateEval ? "active-safe" : ""}`}
            >
              <span className="fzone-dot" />
              safe · ≤5
            </div>
            <div
              className={`fzone ${s.zone === "gray" && s.gateEval ? "active-gray" : ""}`}
            >
              <span className="fzone-dot" />
              gray · 6–10
            </div>
            <div
              className={`fzone ${s.zone === "storm" && s.gateEval ? "active-storm" : ""}`}
            >
              <span className="fzone-dot" />
              storm · &gt;10
            </div>
          </div>
          <span className="fgate-iter">
            iter <strong>{s.iter || "—"}</strong>
          </span>
          <span className="fnode-lbl">ProceedGate</span>
        </div>
        <div className="fpipe fpipe-r">
          <div className="fpipe-track">
            <div
              className={`fpkt ${s.pktRRed ? "red" : ""}`}
              style={{
                transform: `translate(${(s.showPktR ? s.pktRPos : -0.5) * 100}%, -50%) scale(${s.showPktR ? 1 : 0})`,
                transition: s.showPktR ? "none" : "transform 0.1s",
              }}
            />
          </div>
        </div>
        <div className="fresult">
          <div className={`fresult-box ${s.resultBox}`}>{s.resultText}</div>
          <span className="fnode-lbl">{s.resultLbl}</span>
        </div>
      </div>

      <div className="iter-bar-wrap">
        <div className="iter-bar-track">
          <div
            className="iter-bar-fill"
            style={{
              width: `${s.bar}%`,
              background: barColors[s.zone],
            }}
          />
          <div className="iter-threshold" style={{ left: "45%" }} />
          <div className="iter-threshold" style={{ left: "90%" }} />
        </div>
        <div className="iter-bar-labels">
          <span>0</span>
          <span className="ibl-safe">safe</span>
          <span className="ibl-gray">gray</span>
          <span className="ibl-storm">storm</span>
          <span>11+</span>
        </div>
      </div>

      <StatRow
        items={[
          { color: "green", text: "≤5 iterations — allowed immediately" },
          { color: "yellow", text: "6–10 — gray zone (allowed, flagged)" },
          { color: "red", text: "≥11 — hard block, 429 returned" },
        ]}
      />
    </div>
  );
}

/* ── Panel 1: Budget ─────────────────────────────────────── */
const budgetSteps = [
  { spent: 0.42, pct: 16.8, step4: false },
  { spent: 0.83, pct: 33.2, step4: false },
  { spent: 1.24, pct: 49.6, step4: false },
  { spent: 1.65, pct: 66.0, step4: false },
  { spent: 2.07, pct: 82.8, step4: false },
  { spent: 2.5, pct: 100, step4: true },
];

function BudgetPanel() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % (budgetSteps.length + 2));
    }, 900);
    return () => window.clearInterval(id);
  }, []);

  const cycleIdx = idx >= budgetSteps.length ? 0 : idx;
  const s = budgetSteps[cycleIdx];

  const t = s.pct / 100;
  const r = Math.round(74 + (248 - 74) * t);
  const g = Math.round(222 + (113 - 222) * t);
  const b = Math.round(128 + (113 - 128) * t);
  const fillColor = `linear-gradient(90deg, #4ade80, rgb(${r},${g},${b}))`;

  return (
    <div className="flow-wrap">
      <div className="sc-pill gray">
        <span
          className="sc-dot"
          style={{
            background: "var(--color-teal)",
            boxShadow: "0 0 6px var(--color-teal)",
          }}
        />
        <span>session · active</span>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-tx-3)]">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              crypto-scraper
              <span className="rounded border border-[color-mix(in_srgb,var(--color-teal)_20%,transparent)] bg-[color-mix(in_srgb,var(--color-teal)_12%,transparent)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-bold text-[var(--color-teal)]">
                ACTIVE
              </span>
            </div>
            <div className="mt-0.5 font-[family-name:var(--font-mono)] text-xs text-[var(--color-tx-3)]">
              session_8f3a2c · 18 requests processed
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3.5">
          <div className="mb-2.5 flex justify-between text-xs text-[var(--color-tx-3)]">
            <span>Budget spent</span>
            <span className="font-[family-name:var(--font-mono)] font-semibold text-[var(--color-tx)]">
              ${s.spent.toFixed(2)} / $2.50
            </span>
          </div>
          <div className="relative h-2 overflow-visible rounded-full bg-[var(--color-border)]">
            <div
              className="h-full rounded-full transition-[width] duration-1000"
              style={{
                width: `${s.pct}%`,
                background: fillColor,
              }}
            />
            <div
              className="absolute -top-1 h-4 w-px bg-[var(--color-yellow)] opacity-60"
              style={{ left: "80%" }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px]">
            <span className="text-[var(--color-tx-3)]">$0</span>
            <span className="text-[var(--color-yellow)]">alert at $2.00</span>
            <span className="text-[var(--color-tx-3)]">$2.50 cap</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <BudgetStep dot="green" action="web_scrape" cost="+$0.042" status="ok" />
          <BudgetStep dot="green" action="search_api" cost="+$0.031" status="ok" />
          <BudgetStep
            dot="yellow"
            action="model_call"
            cost="+$0.018"
            status="warn"
          />
          <BudgetStep
            dot="red"
            action="web_scrape"
            cost="—"
            status="bad"
            faded={!s.step4}
          />
        </div>
      </div>

      <StatRow
        items={[
          { color: "teal", text: "Per-agent session budgets with hard USD caps" },
          { color: "yellow", text: "Webhook alerts before cap is hit" },
          { color: "red", text: "Zero overspend — blocked at exactly $2.50" },
        ]}
      />
    </div>
  );
}

function BudgetStep({
  dot,
  action,
  cost,
  status,
  faded,
}: {
  dot: "green" | "yellow" | "red";
  action: string;
  cost: string;
  status: "ok" | "warn" | "bad";
  faded?: boolean;
}) {
  const statusColor =
    status === "ok"
      ? "text-[var(--color-green)]"
      : status === "warn"
        ? "text-[var(--color-yellow)]"
        : "text-[var(--color-red)]";
  const statusText =
    status === "ok" ? "✓ allowed" : status === "warn" ? "⚡ friction" : "✕ cap reached";
  const dotBg =
    dot === "green"
      ? "bg-[var(--color-green)]"
      : dot === "yellow"
        ? "bg-[var(--color-yellow)]"
        : "bg-[var(--color-red)]";

  return (
    <div
      className="grid grid-cols-[16px_1fr_auto_auto] items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs transition-opacity duration-700"
      style={{ opacity: faded ? 0.3 : 1 }}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotBg}`} />
      <span className="font-[family-name:var(--font-mono)] text-[var(--color-tx-2)]">
        {action}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[var(--color-tx-3)]">
        {cost}
      </span>
      <span className={`font-[family-name:var(--font-mono)] text-[11px] font-semibold ${statusColor}`}>
        {statusText}
      </span>
    </div>
  );
}

/* ── Panel 2: Signed Proof ─────────────────────────────────── */
const tokenSegments = [
  "eyJzdWIi…",
  "eyJzdWIiOiJzY3JhcGVyLTEi…",
  "eyJzdWIiOiJz…",
];

function SignedProofPanel() {
  const [tokenIdx, setTokenIdx] = useState(0);
  const [pulseFade, setPulseFade] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        setPulseFade(true);
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        setTokenIdx((i) => (i + 1) % tokenSegments.length);
        setPulseFade(false);
        await new Promise((r) => setTimeout(r, 1800));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flow-wrap">
      <div className="sc-pill safe">
        <span className="sc-dot" />
        <span>ES256 · proceed_token issued</span>
      </div>
      <div className="flex flex-col gap-3">
        <div className="grid items-start gap-3 md:grid-cols-[1fr_auto_1fr]">
          {/* Request */}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3.5">
            <div className="mb-2.5 font-[family-name:var(--font-mono)] text-[10px] font-bold uppercase tracking-wider text-[var(--color-tx-3)]">
              Request
            </div>
            <TokenLine k="action" v='"tool_call"' />
            <TokenLine k="agent_id" v='"scraper-1"' />
            <TokenLine k="task_hash" v='"sha256:aHR…"' dim />
            <TokenLine k="attempt" v="3" />
          </div>

          {/* Arrow */}
          <div className="flex flex-col items-center gap-1.5 pt-8 max-md:hidden">
            <div className="h-7 w-px bg-[var(--color-border)]" />
            <div className="text-center text-[10px] leading-tight text-[var(--color-tx-3)]">
              ProceedGate
              <br />
              evaluates
            </div>
            <div className="text-base text-[var(--color-teal)]">→</div>
          </div>

          {/* Result */}
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-green)_25%,transparent)] bg-[var(--color-bg)] px-4 py-3.5">
            <div className="mb-2.5 font-[family-name:var(--font-mono)] text-[10px] font-bold uppercase tracking-wider text-[var(--color-green)]">
              ✓ allowed · token issued
            </div>
            <div className="mb-2.5 break-all font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--color-tx-3)]">
              eyJhbGciOiJFUzI1NiJ9.
              <span
                className="text-[var(--color-teal)] transition-opacity"
                style={{ opacity: pulseFade ? 0.4 : 1 }}
              >
                {tokenSegments[tokenIdx]}
              </span>
            </div>
            <TokenLine k="sub" v='"scraper-1"' />
            <TokenLine k="task" v='"sha256:aHR…"' dim />
            <TokenLine k="step" v='"tool_call"' />
            <TokenLine k="exp" v="45s TTL" tone="yellow" />
            <TokenLine k="alg" v="ES256 ✓" tone="green" />
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--color-teal)_15%,transparent)] bg-[color-mix(in_srgb,var(--color-teal)_6%,transparent)] px-3.5 py-2.5">
          <span className="whitespace-nowrap rounded border border-[color-mix(in_srgb,var(--color-teal)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-teal)_10%,transparent)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--color-teal)]">
            JWKS endpoint
          </span>
          <span className="text-xs text-[var(--color-tx-3)]">
            → verifiable by any service, offline, no round-trip
          </span>
        </div>
      </div>

      <StatRow
        items={[
          { color: "green", text: "ES256 signed — cannot be forged" },
          { color: "teal", text: "45s TTL — tight anti-replay window" },
          { color: "yellow", text: "JWKS verifiable — any downstream service" },
        ]}
      />
    </div>
  );
}

function TokenLine({
  k,
  v,
  dim,
  tone,
}: {
  k: string;
  v: string;
  dim?: boolean;
  tone?: "yellow" | "green";
}) {
  const valColor =
    tone === "yellow"
      ? "text-[var(--color-yellow)]"
      : tone === "green"
        ? "text-[var(--color-green)]"
        : dim
          ? "text-[var(--color-tx-3)] text-[11px]"
          : "text-[var(--color-tx-2)]";
  return (
    <div className="flex gap-1.5 py-0.5 font-[family-name:var(--font-mono)] text-xs">
      <span className="text-[var(--color-teal)]">{k}</span>
      <span className="text-[var(--color-tx-3)]">:</span>
      <span className={valColor}>{v}</span>
    </div>
  );
}

/* ── Panel 3: 5 Integrations ─────────────────────────────── */
const sdks = [
  {
    name: "@proceedgate/node",
    sub: "TypeScript · any framework",
    color: "#4ade80",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#4ade80"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    name: "@proceedgate/langchain",
    sub: "Callback · Tool · Executor",
    color: "#2dd4bf",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8M12 8v8" />
      </svg>
    ),
  },
  {
    name: "@proceedgate/vercel-ai",
    sub: "Middleware · gatedTool",
    color: "#fbbf24",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fbbf24"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    name: "proceedgate-crewai",
    sub: "Python · BudgetAwareCrew",
    color: "#f87171",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#f87171"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    name: "@proceedgate/mcp-server",
    sub: "Claude Code · Cursor",
    color: "#a78bfa",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#a78bfa"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6M9 12h6M9 15h4" />
      </svg>
    ),
  },
];

function IntegrationsPanel() {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveIdx((i) => (i + 1) % sdks.length);
    }, 900);
    return () => window.clearInterval(id);
  }, []);

  const top = sdks.slice(0, 3);
  const bottom = sdks.slice(3);

  return (
    <div className="flow-wrap">
      <div className="sc-pill safe">
        <span
          className="sc-dot"
          style={{
            background: "var(--color-teal)",
            boxShadow: "0 0 6px var(--color-teal)",
          }}
        />
        <span>5 integrations · drop-in</span>
      </div>
      <div className="flex flex-col">
        <div className="flex flex-wrap justify-center gap-3">
          {top.map((sdk, i) => (
            <Sdk key={sdk.name} sdk={sdk} active={i === activeIdx} />
          ))}
        </div>
        <div className="my-3.5 flex items-center justify-center">
          <div className="eco-line" />
          <div className="eco-gate-box">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect width="20" height="20" rx="5" fill="#2dd4bf" />
              <path
                d="M6 10l3 3 5-6"
                stroke="#09090b"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>ProceedGate</span>
          </div>
          <div className="eco-line" />
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {bottom.map((sdk, i) => (
            <Sdk
              key={sdk.name}
              sdk={sdk}
              active={i + top.length === activeIdx}
            />
          ))}
        </div>
      </div>
      <StatRow
        items={[
          { color: "teal", text: "TypeScript + Python covered" },
          { color: "green", text: "Drop-in — no agent rewrite needed" },
          { color: "yellow", text: "MCP: works inside Claude Code natively" },
        ]}
      />
    </div>
  );
}

function Sdk({
  sdk,
  active,
}: {
  sdk: (typeof sdks)[number];
  active: boolean;
}) {
  return (
    <div className={`eco-sdk ${active ? "active" : ""}`}>
      <div
        className="eco-sdk-icon"
        style={{
          background: `color-mix(in srgb, ${sdk.color} 8%, transparent)`,
          borderColor: `color-mix(in srgb, ${sdk.color} 20%, transparent)`,
        }}
      >
        {sdk.icon}
      </div>
      <div className="eco-sdk-name">{sdk.name}</div>
      <div className="eco-sdk-sub">{sdk.sub}</div>
    </div>
  );
}

/* ── Stat row ────────────────────────────────────────────── */
function StatRow({
  items,
}: {
  items: { color: "green" | "yellow" | "red" | "teal"; text: string }[];
}) {
  return (
    <div className="mt-5 flex flex-wrap gap-4 border-t border-[var(--color-border)] pt-4">
      {items.map((it, i) => {
        const bg =
          it.color === "green"
            ? "bg-[var(--color-green)]"
            : it.color === "yellow"
              ? "bg-[var(--color-yellow)]"
              : it.color === "red"
                ? "bg-[var(--color-red)]"
                : "bg-[var(--color-teal)]";
        return (
          <span
            key={i}
            className="flex items-center gap-1.5 text-xs text-[var(--color-tx-3)]"
          >
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${bg}`} />
            {it.text}
          </span>
        );
      })}
    </div>
  );
}
