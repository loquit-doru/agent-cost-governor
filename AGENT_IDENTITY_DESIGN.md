# Feature #2 — Agent Identity & Per-Agent Reputation

**Status**: Design / Pre-implementation  
**Priority**: High (competitive differentiator — no competitor does this)  
**Estimated scope**: ~300 lines new code, ~80 lines modified

---

## Problem Statement

Astăzi, reputația în ProceedGate este per **workspace** (`actor.project`).  
Un agent anume (`actor.id`) nu are identitate proprie — doar un log entry.

**Consecința**: Un workspace cu 5 agenți diferiți e tratat uniform.  
Un agent bun nu beneficiază de mai multă libertate.  
Un agent rău care face furtuni nu e penalizat separat de ceilalți.

---

## Goal

Fiecare `actor.id` devine o entitate de primă clasă:
- Are un **profil persistent** (când a apărut prima dată, câte plăți a făcut etc.)
- Are o **reputație proprie** (scor de trust independent de workspace)
- Poate fi **listat/clasificat** de operatorul platformei
- Poartă contextul cu el **cross-workspace** (dacă același agent ID apare în două proiecte)

---

## Scope Decizii

| Aspect | Decizie |
|--------|---------|
| Trust agent vs trust workspace | Ambele, independent. Agent-level NU suprascrie workspace-level — funcționează în paralel |
| Cross-workspace reputație | DA — `agent_id` e global, nu scoped to workspace |
| `actor.wallet` (ERC-8004) | DA, câmp opțional în schema (pentru viitor) |
| Agent listing public | NU — endpoint privat (autentificat per workspace sau admin) |
| Impact pe decizia de allow/block | Faza 1: reputație colectată dar NU influențează thresholds. Faza 2: multiplier separat per agent |

---

## Data Model

### AgentProfile (nou)

```typescript
interface AgentProfile {
  agent_id: string;
  first_seen_ms: number;
  last_seen_ms: number;
  total_payments_usdc: number;   // sumă totală plătită on-chain
  payment_count: number;
  workspace_ids: string[];       // max 50, cele mai recente (deduped)
  wallet_address?: string;       // opțional, din actor.wallet
}
```

Stocat la cheia: `agent:{agentId}:profile`

### AgentReputationState (reutilizăm ReputationState existent)

Tipul `ReputationState` din `reputationScoring.ts` e refolosit neschimbat.

Stocat la cheia: `agent:{agentId}:rep`

---

## Storage Keys (în BillingStoreDO)

```
agent:{agentId}:profile  →  AgentProfile
agent:{agentId}:rep      →  ReputationState (JSON, serializat identic cu rep:{workspaceId})
```

Exemplu concret:
```
agent:my-scraper-v2:profile  →  { agent_id: "my-scraper-v2", first_seen_ms: ..., ... }
agent:my-scraper-v2:rep      →  { compliance_window: [...], ... }
```

---

## API Endpoints (noi)

### În BillingStoreDO (`fetch()` handler)

```
GET  /agents/:id/profile      →  AgentProfile (404 dacă nu există)
POST /agents/:id/profile      →  Upsert: create sau update last_seen, workspace_ids, payments
GET  /agents/:id/reputation   →  ReputationScore (ca la /workspaces/:id/reputation)
POST /agents/:id/reputation   →  recordOutcome (identic cu workspace version)
GET  /agents                  →  ListAgentsResponse (paginat, 20/pagină)
```

### Liste response shape:
```typescript
interface ListAgentsResponse {
  agents: Array<{
    agent_id: string;
    tier: 'trusted' | 'normal' | 'untrusted';
    score: number;
    last_seen_ms: number;
    workspace_count: number;
  }>;
  total: number;
  has_more: boolean;
}
```

### HTTP Routes (în worker/src/routes/)

```
GET  /v1/agents/:id            →  { profile, reputation } (req: API key din workspace)
GET  /v1/agents/:id/history    →  lista de decizii ale agentului (din log)
```

---

## Integration Points

### 1. `check.ts` — fire-and-forget paralel (faza 1)

La fiecare `/v1/governor/check` success (linia ~636), pe lângă:
```typescript
stub.fetch(doUrl(`/workspaces/${workspaceId}/reputation`), { ... })
```

Se adaugă în **paralel** (fără await, fără a bloca răspunsul):
```typescript
// Update agent profile
stub.fetch(doUrl(`/agents/${agentId}/profile`), {
  method: 'POST',
  body: JSON.stringify({
    last_seen_ms: Date.now(),
    workspace_id: workspaceId,
    wallet_address: parsed.data.actor.wallet,
  }),
});

// Record agent reputation (same outcome as workspace)
stub.fetch(doUrl(`/agents/${agentId}/reputation`), {
  method: 'POST',
  body: JSON.stringify({
    blocked: false,
    zone: loopData.zone,
    backoff_detected: false,
  }),
});
```

De asemenea la **block** (storm sau gray zone):
```typescript
stub.fetch(doUrl(`/agents/${agentId}/reputation`), {
  method: 'POST',
  body: JSON.stringify({
    blocked: true,
    reason: 'storm',  // sau 'gray_blocked'
    zone: loopData.zone,
  }),
});
```

### 2. `schemas.ts` — adăugare `actor.wallet` opțional

```typescript
actor: z.object({
  id: z.string().min(1).max(200),
  project: z.string().min(0).max(200).optional(),
  wallet: z.string().max(100).optional(), // ERC-8004 agent wallet, optional
})
```

### 3. `billingStoreDO.ts` — bloc nou `/agents` handler

Adăugat după blocul `/workspaces/:id/reputation`, un nou bloc:

```
// ====================================================================
// Agent Identity & Reputation
// ====================================================================
if (parts[0] === 'agents') { ... }
```

---

## Faze de implementare

### Faza 1 — Colectare (nu influențează decizii)
- ✅ Storage keys definite
- ✅ DO endpoints `/agents/:id/profile`, `/agents/:id/reputation`, `GET /agents`
- ✅ `check.ts` fire-and-forget updates
- ✅ `schemas.ts` + `actor.wallet`
- ✅ HTTP route `GET /v1/agents/:id` (autentificat)

### Faza 2 — Influență decizii (după validare date)
- `check.ts`: fetch agent reputation la început (ca workspace-ul)
- Combina `agentTrustScore` + `workspaceTrustScore` → multiplier final
- Formula (sugestie): `finalMultiplier = workspaceMultiplier * (0.7 + 0.3 * agentNorm)`
  - unde `agentNorm = agentScore / 100` (0-1)
  - Dacă agentul e trusted (≥80) → ușor mai permisiv per agent
  - Dacă agentul e untrusted (<50) → contribuie negativ

---

## Edge Cases

| Caz | Handling |
|-----|---------|
| `actor.id` lipsă (nu ar trebui, e required în schema) | Schema Zod blochează upstream |
| Agent nou (niciun profil) | `createReputationState()` + profil gol creat la primul request |
| `workspace_ids` overflow (agent apare în 1000 workspaces) | Keep last 50, deduped |
| Același `agent_id` în DO-uri diferite | `BillingStoreDO` e singleton per `idFromName('billing')` — nu e problemă |
| DO stub disponibil? | Reutilizăm `stub` existent din check.ts, fără DO nou |

---

## Non-goals (acest feature NU face)

- Nu creează un token/JWT per agent
- Nu verifică on-chain că `actor.wallet` deține ceva
- Nu expune agent-level data în răspunsul de check (nu e în responseBody)
- Nu înlocuiește autentificarea per workspace
- Nu migrează date istorice (agenții existenți încep cu profil gol)

---

## Checklist de implementare (când e gata)

- [ ] `worker/src/lib/schemas.ts` — adaugă `actor.wallet` optional
- [ ] `worker/src/billingStoreDO.ts` — bloc `/agents` handler (~200 linii)
  - [ ] `GET /agents/:id/profile`
  - [ ] `POST /agents/:id/profile` (upsert)
  - [ ] `GET /agents/:id/reputation`
  - [ ] `POST /agents/:id/reputation`
  - [ ] `GET /agents` (list, 20/pagină)
- [ ] `worker/src/routes/check.ts` — fire-and-forget agent updates (~40 linii)
  - [ ] La success: profile upsert + reputation record
  - [ ] La storm block: agent reputation record (blocked=true)
  - [ ] La gray block: agent reputation record (blocked=true)
- [ ] `worker/src/routes/` — fișier nou `agents.ts` cu 2 endpoints HTTP
  - [ ] `GET /v1/agents/:id`
  - [ ] Autentificare: workspace API key (nu trebuie să fie din same workspace)
- [ ] `worker/src/index.ts` — mount `agents` router
- [ ] `npm --workspaces run check` — zero erori TypeScript
- [ ] `requests.http` — exemple pentru noile endpoints
- [ ] README.md — secțiune Agent Identity
