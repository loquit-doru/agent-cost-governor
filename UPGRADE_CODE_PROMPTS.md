# Upgrade Code Prompts — Post-Hackathon Implementation

> Întrebări pregătite pentru a colecta cod de implementare de la colegi AI.
> Fiecare răspuns va fi analizat, polished, și notat aici pentru upgrade-ul mare.

---

## PROMPT 1: EWMA + Z-score + CUSUM Adaptive Baselines (Secțiunile 2.1 + 6.1)

### Context pentru AI:

Sunt TypeScript, Cloudflare Workers cu Durable Objects. Am un fișier `aiReasoning.ts` care face gray zone decisions. Loop detection-ul actual folosește **threshold-uri fixe**:
- safe: ≤5 requests/min
- gray: 6-10 requests/min  
- storm: >10 requests/min

Vreau să înlocuiesc threshold-urile fixe cu **adaptive baselines per agent** folosind EWMA + z-score + CUSUM.

### Codul meu actual (ce vreau să înlocuiesc):

```typescript
// Din check.ts — zona de decizie actuală (simplificat):
// loopData.count e numărul de requests identice într-o fereastră de 1 minut
if (loopData.count > 10) {
  // STORM — block direct
} else if (loopData.count >= 6) {
  // GRAY ZONE — AI decide (aiDecideGrayZone)
} else {
  // SAFE — allow
}
```

### Ce vreau:

Scrie-mi un **modul TypeScript complet** (`adaptiveBaseline.ts`) care:

1. **State per agent** (~100 bytes):
```typescript
interface AgentBaseline {
  // EWMA per metric
  ewma: {
    rpm: { mean: number; variance: number };     // requests per minute
    tokens: { mean: number; variance: number };   // tokens per minute (dacă avem)
    fanout: { mean: number; variance: number };   // fan-out ratio
    entropy: { mean: number; variance: number };  // entropy score
  };
  cusum: number;          // CUSUM accumulator pentru drift detection
  sampleCount: number;    // câte samples am văzut
  lastUpdated: number;    // timestamp
}
```

2. **Funcție `updateAndClassify()`** care:
   - Primește `currentRate` (requests/min actual)
   - Actualizează EWMA (α adaptiv: 0.15 pe warm-up → 0.05 pe agenți stabili)
   - Calculează z-score
   - Actualizează CUSUM pentru drift detection
   - Returnează zona: `'safe' | 'gray' | 'storm'`
   - Aplică **hard ceiling absolut** (ex: 50 req/min → storm instant, bypass z-score)

3. **Threshold-uri pe z-score**:
   - safe: z < 1.5σ
   - gray: 1.5σ ≤ z < 3.5σ
   - storm: z ≥ 3.5σ SAU `cusum > 5*std` SAU `currentRate > 8 * ewmaRate`

4. **Cold start** (sampleCount < 200):
   - Folosește percentile (p95 → gray, p99 → storm) din rolling buffer
   - Tranziție la EWMA complet la 500 samples

5. **Funcție `serializeState()` / `deserializeState()`** pentru DO storage (SQLite)

6. **Latency target**: <0.1ms, zero allocations pe hot path

### Constrângeri:
- TypeScript strict, zero dependențe externe
- Trebuie să fie **drop-in replacement** — returnează `'safe' | 'gray' | 'storm'` exact ca sistemul actual
- Va fi apelat din Durable Object la fiecare request
- Trebuie să funcționeze pe Cloudflare Workers (no Node.js APIs)

### Output așteptat:
Fișier complet `adaptiveBaseline.ts` cu:
- Interfețe TypeScript
- Clasa/funcțiile principale
- Unit test examples (minim 5 scenarii: cold start, normal operation, spike detection, drift detection, hard ceiling)
- Comentarii care explică fiecare decizie

---

## PROMPT 2: Decision Caching pe hash(features) (Secțiunea 2.5)

### Context pentru AI:

Am un sistem de governance care apelează **Workers AI (Llama 3.1 8B)** pentru decizii în gray zone. Latency: 200-500ms. Vreau să adaug **caching** pe decizii: dacă am mai văzut exact aceleași features → returnez decizia cached, skip LLM.

### Codul meu actual:

```typescript
// aiReasoning.ts — funcția care apelează LLM
export async function aiDecideGrayZone(
  env: Env | undefined,
  input: GrayZoneInput,  // { action, actor_id, count, avg_interval_ms, interval_cv, requests_per_sec, ... }
): Promise<GrayZoneDecision> {
  const heuristic = heuristicGrayZone(input);
  if (!env?.AI) return heuristic;

  try {
    const prompt = buildDecisionPrompt(input);
    const aiCall = env.AI.run(WORKERS_AI_MODEL, { ... });
    const result = await Promise.race([aiCall, timeout(300)]);
    // ... parse result
  } catch {
    return heuristic; // fallback
  }
}
```

### Ce vreau:

Scrie-mi un **modul `decisionCache.ts`** care:

1. **Hash features** deterministic:
   - Input: `GrayZoneInput` (action, count, interval_cv, requests_per_sec, cost_window_usd, backoff_detected)
   - Output: `string` hash (SHA-256 hex sau similar rapid)
   - **Bucketizare**: rotunjește `interval_cv` la 2 decimale, `requests_per_sec` la 1 decimală, `count` exact — ca decizii similare să matcheze cache-ul

2. **Cache storage** în Durable Object:
   - Key: `dcache:{hash}` 
   - Value: `{ decision: 'allow'|'block', reasoning: string, confidence: number, cachedAt: number }`
   - TTL: 5 minute (stale cache e periculos pe governance)
   - Max entries: 100 (LRU eviction)

3. **Wrapping function** `cachedAiDecideGrayZone()`:
   - Check cache → hit? return cached + `{ ai_decided: true, model: 'cached-llama-3.1-8b' }`
   - Miss? call original `aiDecideGrayZone()` → store result → return
   - Header `X-Proceedgate-Cache: hit|miss`

4. **Cache invalidation**:
   - Prune entries mai vechi de 5 min
   - Cleanup pe DO Alarm (zilnic) sau lazy la fiecare call

### Constrângeri:
- TypeScript strict, zero dependențe
- Hash FĂRĂ `crypto.subtle` (prea lent) — folosește o funcție rapidă (djb2, FNV-1a, sau similar)
- Trebuie să funcționeze pe Workers runtime
- Latency target: <1ms pentru cache check

### Output așteptat:
Fișier complet `decisionCache.ts` + exemplu de integrare în `aiDecideGrayZone()` existent + unit tests (cache hit, miss, expiry, LRU eviction)

---

## PROMPT 3: JWT Security Hardening — alg whitelist + jti blacklist (Secțiunea 6.2)

### Context pentru AI:

Am proceed_tokens semnate cu **ES256 (P-256 JWT)** pe Cloudflare Workers. Token-ul e proof că agentul are voie să procedeze.

### Codul meu actual de SEMNARE:

```typescript
// signing.ts
const jwt = await new SignJWT({
  pol: params.policyId,
  act: params.action,
  task: params.taskHash ?? '',
  step: params.stepHash ?? '',
  ctx: params.contextHash ?? '',
})
  .setProtectedHeader({ alg: 'ES256', kid })
  .setIssuer(params.origin)
  .setAudience('agent-cost-governor')
  .setSubject(params.actorId)
  .setJti(params.decisionId)
  .setIssuedAt(now)
  .setExpirationTime(exp)
  .sign(privateKey);
```

### Codul meu actual de VERIFICARE (redeem.ts, simplificat):

```typescript
// redeem.ts — verificare token
const { payload } = await jwtVerify(token, jwks, {
  issuer: expectedIssuer,
  audience: 'agent-cost-governor',
});
// verifică exp, sub, claims custom...
```

### Ce vreau (3 fix-uri de security):

**Fix 1: Algorithm whitelist**
- La verificare, forțează `algorithms: ['ES256']` — rejectează `none`, `HS256`, orice altceva
- Previne algorithm confusion attacks

**Fix 2: jti blacklist (single-use tokens)**
- După ce un token e redeemed, stochez `jti` într-un Set în DO
- La fiecare verify: check dacă `jti` a fost deja folosit → reject
- TTL automât: șterg jti-uri mai vechi de 5 min (token-ul oricum expiră la 30s)
- Max 500 entries (LRU)
- Storage: in-memory Map + persist pe DO storage periodic

**Fix 3: Request binding verification**  
- La semnare: adaugă `proof` claim = hash din `method + path + bodyHash`
- La redeem: recalculează hash-ul din request actual și compară cu `proof` claim
- Previne token rebinding (token valid folosit pe alt endpoint)

### Constrângeri:
- Folosesc `jose` library (npm) pentru JWT — deja importat
- Cloudflare Workers runtime (Web Crypto API, nu Node crypto)
- TypeScript strict
- Zero performance regression pe hot path

### Output așteptat:
- Diff/patch pentru `signing.ts` (adaugă `proof` claim)
- Diff/patch pentru `redeem.ts` (adaugă alg whitelist + jti check + proof verify)
- Modul `jtiBlacklist.ts` (in-memory + DO persist)
- Unit tests (replay attempt, algorithm confusion, rebinding attempt)

---

## PROMPT 4: Behavioral Fingerprint + Hash Signature (Secțiuni 2.4 + 5.1)

### Context pentru AI:

ProceedGate e un governance layer pentru AI agents. Vreau să colectez **behavioral fingerprints** per agent pentru cross-workspace intelligence, fără să stochez raw data (privacy-safe).

### Ce am acum în decision logs:
```typescript
// Stocat în DO per workspace
{
  ts: number,
  action: string,
  zone: 'safe' | 'gray' | 'storm',
  decision: 'allow' | 'block',
  count: number,
  // ... câmpuri simple
}
```

### Ce vreau:

Un modul **`behaviorFingerprint.ts`** care:

1. **Calculează un fingerprint per agent** din:
   - Tool/action sequence hash (ultimele 10 acțiuni → hash)
   - Retry distribution (histogram de intervale: [<100ms, 100-500ms, 500ms-2s, >2s])
   - Average call depth
   - Burst index (max requests în 10s / average)
   - Entropy profile (Shannon entropy peste acțiunile din window)
   - Fan-out ratio (unique actions / total requests)

2. **Output**: un obiect structurat + un hash compact (hex string, 32 chars)
```typescript
interface BehaviorFingerprint {
  toolSequenceHash: string;   // hash of last 10 actions
  retryDistribution: [number, number, number, number]; // histogram 4 buckets
  avgDepth: number;
  burstIndex: number;
  entropyProfile: number;     // Shannon entropy
  fanoutRatio: number;
  // computed
  fingerprintHash: string;    // compact hash of all above
}
```

3. **Funcție `updateFingerprint()`** — streaming update la fiecare request (nu batch)

4. **Funcție `compareFingerprints(a, b)`** — similarity score 0-1 (pentru clustering ulterior)

5. **Schema SQL** pentru decision log extins:
```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  workspace_id TEXT,
  agent_id TEXT,
  request_hash TEXT,
  features JSON,         -- structured heuristic factors
  zone TEXT,
  decision TEXT,
  heuristic_score REAL,
  llm_score REAL,
  confidence REAL,
  reason TEXT,
  fingerprint_hash TEXT, -- behavioral fingerprint
  cost_usd REAL,
  duration_ms INTEGER
);
CREATE INDEX idx_decisions_ts ON decisions(ts);
CREATE INDEX idx_decisions_zone ON decisions(zone);
CREATE INDEX idx_decisions_agent ON decisions(agent_id);
CREATE INDEX idx_decisions_fingerprint ON decisions(fingerprint_hash);
```

### Constrângeri:
- TypeScript strict, Cloudflare Workers (no Node.js crypto — use Web Crypto API for SHA-256)
- Streaming: O(1) memory per update
- Fingerprint hash trebuie să fie **deterministic** (same inputs → same hash)
- Privacy: zero raw prompts, zero PII

### Output așteptat:
Fișier complet `behaviorFingerprint.ts` + schema SQL + unit tests (fingerprint computation, comparison, streaming update)

---

## PROMPT 5: Privacy-Safe Cross-Workspace Intelligence (Secțiunea 5.1)

### Context pentru AI:

ProceedGate e un governance layer open-source. Vreau să construiesc un **data moat** prin cross-workspace intelligence — agregarea datelor de la toți userii face produsul mai bun pentru fiecare.

### Arhitectura mea:
- 1 Durable Object per workspace
- Cloudflare D1 ca analytics DB central
- Durable Object are decision logs locale

### Ce vreau:

Un modul **`crossIntelligence.ts`** care:

1. **Export zilnic anonim din DO → D1**:
   - Anonimizează: `workspace_id` → SHA-256 hash, strip all PII
   - Agregează: per oră, per zone, per fingerprint cluster
   - Differential privacy: adaugă zgomot Laplace (ε=1.0) la contoare

2. **Schema D1 pentru agregate**:
```sql
CREATE TABLE global_patterns (
  id TEXT PRIMARY KEY,
  date TEXT,              -- YYYY-MM-DD
  hour INTEGER,           -- 0-23
  workspace_hash TEXT,     -- SHA-256 of workspace_id
  fingerprint_cluster TEXT,-- cluster ID
  zone TEXT,
  count_noisy INTEGER,    -- count + Laplace noise
  avg_burst_index REAL,
  avg_entropy REAL,
  cost_saved_usd REAL
);
```

3. **Global anomaly detection**:
   - Query D1: dacă ≥5 workspace-uri diferite au același `fingerprint_cluster` în ultimele 3 ore → alert
   - Returnează: `{ anomalyDetected: boolean, affectedWorkspaces: number, clusterHash: string }`

4. **k-anonymity check**: nu exporta rows unde count < 5 (previne re-identificare)

5. **Funcție `exportDailyAggregate()`** — rulată din DO Alarm
6. **Funcție `checkGlobalAnomalies()`** — rulată periodic sau la request

### Constrângeri:
- TypeScript strict, Cloudflare Workers + D1
- Differential privacy cu Laplace noise (ε=1.0)
- k-anonymity (k≥5)
- Zero PII, zero raw prompts
- Trebuie să funcționeze cu D1 SQL syntax (SQLite-based)

### Output așteptat:
Fișier complet `crossIntelligence.ts` + D1 migration SQL + unit tests + exemplu de integrare în DO Alarm

---

## LOG DE RĂSPUNSURI

| Prompt | Sursa AI | Data | Calitate (1-5) | Status | Notițe |
|--------|----------|------|-----------------|--------|--------|
| 1. EWMA+CUSUM | ChatGPT + Claude | 2026-02-18 | 4/5 | ✅ analizat | Fuziune R1+R2: structură funcțională + math din R1, interfață `CurrentMetrics` + deserialize try/catch + `getStateSnapshot()` din R2. Vezi detalii mai jos. |
| 2. Decision Cache | ChatGPT + Claude | 2026-02-18 | 4.5/5 | ✅ analizat | R1 aproape integral. R2 are 3 buguri (BigInt lent, actor_id în hash, reasoning mutation). Adoptăm doar toLowerCase + cleanupExpired din R2. |
| 3. JWT Security | ChatGPT + Claude | 2026-02-18 | 4/5 | ✅ analizat | R2 câștigă (SHA-256 proof, per-DO blacklist, naming). Din R1 luăm `nowFn` testabil + serialize clean. |
| 4. Fingerprint | ChatGPT + Claude | 2026-02-18 | 3.5/5 | ✅ analizat | R1 câștigă clar. R2 are 3 buguri fatale (async/sync mismatch, Jaccard pe caractere hex, actionFreq leak). Din R2 luăm doar circular buffer seqIndex + intervalMs param. |
| 5. Cross-Intel | ChatGPT + Claude | 2026-02-18 | 4.5/5 | ✅ analizat | R1 câștigă decisiv. R2 are bug SQL fatal (coloană `ts` inexistentă), `getHours()` local în loc de UTC, `any[]` params. Din R2 luăm doar `CHECK` constraint în schema. |

---

## SOLUȚIE FINALĂ PROMPT 1: adaptiveBaseline.ts

### Decizie: fuziune R1 (funcțional/matematic) + R2 (API/robustețe)

**Din R1 (păstrăm):**
- `Float64Array` pentru cold buffer — zero GC, fix 2KB
- Funcții pure (`createBaseline()` + `updateAndClassify(state, rate, now)`) — nu clasă
- EWMA variance corectă: `(1-α)(V + α·δ²)` cu `delta = current - oldMean` (Welford-EWMA)
- `EPS = 1e-9` pentru safe `Math.sqrt(variance + EPS)`
- Cold start `< 20 → default safe`
- `arr.sort()` pe `Float64Array` (max 256)
- Serialize cu `Array.from(Float64Array)` pentru JSON compat
- CUSUM `k = 0.5 * std` — standard din literature
- α: 0.15 warm-up → 0.05 stabil (2 trepte, simplu)

**Din R2 (adoptăm):**
- `CurrentMetrics` interface cu câmpuri opționale (`rpm` obligatoriu, `tokensPerMin?`, `fanoutRatio?`, `entropy?`)
- `deserialize()` cu try/catch + fallback la baseline gol — nu crashuiește pe date corupte
- `getStateSnapshot()` care exclude bufferul din loguri — bun pentru debugging
- Exemplul concret de integrare DO (copy-paste ready)

**Din R2 (RESPINGEM — buguri):**
- ❌ `new Array(512).fill(2.0)` — pre-fill corupe percentilele cold start
- ❌ EWMA variance cu `error = current - newMean` — subestimează varianta
- ❌ `.slice()` + `[...rates].sort()` pe hot path — alocări dinamice
- ❌ `...initial` spread în constructor — poate suprascrie constante

### Schema finală a funcției:
```typescript
// Funcții pure (nu clasă)
createBaseline(now: number): AgentBaseline
updateAndClassify(state: AgentBaseline, metrics: CurrentMetrics, now: number): Zone
serializeState(state: AgentBaseline): string
deserializeState(raw: string): AgentBaseline  // cu try/catch
getStateSnapshot(state: AgentBaseline): object // fără buffer
```

### Constante finale:
- `HARD_CEILING = 50`
- `WARMUP_ALPHA = 0.15`, `STABLE_ALPHA = 0.05`
- `WARMUP_SAMPLES = 200`, `FULL_EWMA_SAMPLES = 500`
- `COLD_BUFFER_SIZE = 256` (Float64Array)
- `Z_SAFE = 1.5`, `Z_STORM = 3.5`, `CUSUM_H = 5`
- Storm: `z ≥ 3.5` SAU `cusum > 5σ` SAU `rate > 8× mean`

---

## SOLUȚIE FINALĂ PROMPT 2: decisionCache.ts

### Decizie: R1 aproape integral + 2 detalii din R2

**Din R1 (păstrăm tot):**
- FNV-1a 32-bit cu numere (fără BigInt) — suficient la 100 entries, 10-100× mai rapid
- String concatenation pentru normalizare (`action + '|' + count + '|' + ...`)
- `nowFn` injectabil în constructor — testare deterministă
- `hashGrayZoneInput()` exportat separat — composable
- `cachedAiDecideGrayZone(cache, input, aiCall)` cu callback — decuplat
- Fără `actor_id` în hash — cache per-comportament, nu per-actor
- LRU via Map insertion order + delete/re-set

**Din R2 (adoptăm doar):**
- `action.toLowerCase()` în normalizare
- Naming `cleanupExpired()` în loc de `prune()`

**Din R2 (RESPINGEM):**
- ❌ BigInt FNV-1a 64-bit — 10-100× mai lent, overkill la 100 entries
- ❌ `actor_id` în hash — anulează utilitatea cache-ului cross-agent
- ❌ `[key: string]: any` pe interface — sparge TypeScript strict
- ❌ `reasoning + ' (from cache)'` — mută datele originale
- ❌ `Date.now()` hardcodat — netestabil
- ❌ `JSON.stringify` cu sorted keys — mai lent decât concatenare

### Constante finale:
- `MAX_ENTRIES = 100` (LRU)
- `TTL_MS = 5 * 60 * 1000` (5 minute)
- Hash: FNV-1a 32-bit, hex output
- Bucketizare: `interval_cv.toFixed(2)`, `requests_per_sec.toFixed(1)`, `count` exact
- `action.toLowerCase()` înainte de hash

---

## SOLUȚIE FINALĂ PROMPT 3: JWT Security Hardening

### Decizie: R2 arhitectura + securitate, R1 testabilitate

**Din R2 (păstrăm — critice):**
- SHA-256 (`crypto.subtle`) pentru proof binding — OBLIGATORIU, nu FNV-1a (security ≠ performance)
- `JtiBlacklist` per-DO instance cu `DurableObjectState` — nu singleton global
- `isBlacklisted()` + `markAsUsed()` — naming semantic
- `tokenExpiry` din payload JWT ca TTL — expiră exact cu token-ul
- `load()` din storage la init DO — restore after hibernation
- `persist()` debounced (30s) — nu scrie la fiecare request
- `cleanupOld()` pentru Alarm — lifecycle complet

**Din R1 (adoptăm):**
- `nowFn` injectabil în constructor — testare deterministă
- `serialize()`/`deserialize()` cu `[...entries()]` — curat
- `buildProof()` exportat separat — reusable din signing + redeem

**RESPINGEM din R1:**
- ❌ FNV-1a pentru proof — FATAL: 32-bit, coliziuni triviale brute-force, nu e security hash
- ❌ Singleton global `const jtiBlacklist` — pierde state la DO hibernation
- ❌ LRU refresh pe `has()` — nonsens pe blacklist

**RESPINGEM din R2:**
- ❌ `isBlacklisted` async cu Map sync — overhead inutil, facem sync
- ❌ `await request.clone().arrayBuffer()` — contradictoriu cu DigestStream
- ❌ `pathname + search` variabil — doar pathname pentru consistență

### Arhitectura finală:
```typescript
// Proof: SHA-256 (crypto.subtle) — security function
async buildProof(method: string, path: string, bodyHash: string): Promise<string>

// Blacklist: per-DO, sync lookup, testabil
class JtiBlacklist {
  constructor(ctx: DurableObjectState, nowFn?: () => number)
  isBlacklisted(jti: string): boolean        // SYNC, nu async
  markAsUsed(jti: string, tokenExpiry: number): void  // sync add
  async persist(): Promise<void>              // debounced write
  async load(): Promise<void>                 // restore from storage
  cleanupExpired(): void
}

// Verify: 3 checks
jwtVerify(token, jwks, { algorithms: ['ES256'] })  // Fix 1
jtiBlacklist.isBlacklisted(payload.jti)              // Fix 2
buildProof() === payload.proof                       // Fix 3
```

### Constante finale:
- `MAX_ENTRIES = 500` (blacklist)
- TTL: din `payload.exp`, max 5 min
- Proof: SHA-256 hex (crypto.subtle)
- Persist: la 30s interval, nu per-request
- Algorithms whitelist: `['ES256']` exclusiv

---

## SOLUȚIE FINALĂ PROMPT 4: behaviorFingerprint.ts

### Decizie: R1 aproape integral + 2 idei din R2

**Din R1 (păstrăm):**
- Funcții pure (`createFingerprintState()` + `updateFingerprint(state, params)`) — consistent cu Prompt 1
- SHA-256 via Web Crypto pentru action hash + sequence hash + fingerprint hash
- `actionWindow` cu `actionCounts` Map decrementat corect la remove
- `shannonEntropy()` funcție pură separată
- `compareFingerprints()` cu weighted scoring (ponderări sumă=1.0)
- `numericSimilarity(x,y) = 1/(1+|x-y|)` — simplu, bounded 0-1
- Action hash-uit înainte de stocare (zero raw data)

**Din R2 (adoptăm doar):**
- Circular buffer cu `seqIndex` pentru action window — O(1) real, fără `.shift()` reallocation
- `intervalMs` ca parametru explicit în loc de calcul intern din timestamps

**RESPINGEM din R1 (fix necesar):**
- ⚠️ `recentTimestamps` unbounded — trebuie capped (MAX_RECENT_TS = 200 ca R2)
- ⚠️ `burstIndex` formula inconsistentă — refactor cu window_count / (avg_rate * window_seconds)

**RESPINGEM din R2 (buguri fatale):**
- ❌ `computeCompactHash` async dar `computeFingerprint()` sync — returnează Promise ca string
- ❌ `updateFingerprint` sync dar SHA-256 e async — tip greșit
- ❌ Jaccard pe `new Set(toolSequenceHash)` = set de caractere hex (0-f) — mereu ~1.0, complet greșit
- ❌ `actionFreq` crește nelimitat — memory leak pe long-running agents
- ❌ `.filter()` pe `recentTs` la burst — alocări pe hot path

### Arhitectura finală:
```typescript
// Funcții pure (nu clasă)
createFingerprintState(): FingerprintState
async updateFingerprint(state: FingerprintState, params: {
  action: string;
  intervalMs: number;  // din R2
  depth: number;
  timestamp: number;
}): Promise<BehaviorFingerprint>
compareFingerprints(a, b): number  // 0-1 weighted
```

### Constante finale:
- `ACTION_WINDOW_SIZE = 10` (circular buffer cu seqIndex)
- `BURST_WINDOW_MS = 10_000`
- `MAX_RECENT_TS = 200` (cap pe burst array)
- Histogram: 4 bucketuri [<100ms, 100-500ms, 500-2000ms, >2000ms]
- Fingerprint hash: SHA-256 slice 32 chars (128-bit)
- Compare weights: 0.25 sequence + 0.2 histogram + 0.15 depth + 0.15 burst + 0.15 entropy + 0.1 fanout

---

## SOLUȚIE FINALĂ PROMPT 5: crossIntelligence.ts

### Decizie: R1 aproape integral + 1 detaliu din R2

**Din R1 (păstrăm tot):**
- Funcții pure (`exportDailyAggregate(d1, workspaceId, decisions)`) — nu clasă
- `D1Database` interface definit local — self-contained, fără import extern
- `LocalDecisionAggregate` tipat strict (zone union type, campos expliciți)
- Laplace corect: `scale = 1/ε`, inverse transform, `Math.max(0, Math.round(...))`
- Anomaly query cu `(date > ? OR (date = ? AND hour >= ?))` — tranziție de zi corectă
- `checkGlobalAnomalies()` fără parametru cluster — scanează toate, returnează top 1
- `getUTCHours()` — corect pe Workers
- Mock D1 cu `_store` array — testabil fără framework
- k-anonymity la export: `count < K_ANONYMITY → skip`
- ID deterministic SHA-256 → `INSERT OR REPLACE` idempotent
- DO Alarm integration cu reschedule + clear buffer

**Din R2 (adoptăm doar):**
- `CHECK (hour >= 0 AND hour <= 23)` constraint în schema SQL

**RESPINGEM din R2:**
- ❌ Clasă cu `private env: Env` — tip nedefinit în modul
- ❌ `checkGlobalAnomalies(cluster)` cere cluster ca param — inutilă ca detector global
- ❌ Query `WHERE ts >= ?` — coloana `ts` nu există în tabel (are `date` + `hour`). SQL INVALID.
- ❌ `getHours()` local în loc de `getUTCHours()` — bug pe timezone
- ❌ `any[]` pentru localLogs — pierde type safety
- ❌ `laplaceNoise()` private dar testat — contradicție
- ❌ Unit tests cu mock incorect + assert fragil

### Arhitectura finală:
```typescript
// Funcții pure
exportDailyAggregate(d1: D1Database, workspaceId: string, decisions: LocalDecisionAggregate[]): Promise<void>
checkGlobalAnomalies(d1: D1Database): Promise<GlobalAnomalyResult>

// Utilitare interne
sha256Hex(input: string): Promise<string>
addLaplaceNoise(count: number, epsilon: number): number
toDateHour(ts: number): { date: string; hour: number }
```

### Constante finale:
- `EPSILON = 1.0` (Laplace privacy budget)
- `K_ANONYMITY = 5` (minim entries per export)
- Anomaly threshold: ≥5 workspace-uri distincte pe același cluster în 3h
- Schema: `CHECK (hour >= 0 AND hour <= 23)` din R2
- UTC peste tot (`getUTCHours()`, `toISOString()`)

---

## PLAN DE INTEGRARE (post-hackathon)

### Ordinea implementării:
1. **JWT Security** (Prompt 3) — cel mai mic, cel mai important, zero risc de régresie
2. **EWMA + CUSUM** (Prompt 1) — fundamentul, schimbă core detection
3. **Decision Cache** (Prompt 2) — depinde de noul baseline system
4. **Fingerprint** (Prompt 4) — extend decision logs
5. **Cross-Intelligence** (Prompt 5) — depinde de fingerprint + D1 setup

### Estimare totală: 2-3 săptămâni
