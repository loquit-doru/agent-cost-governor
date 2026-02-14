const BASE_URL = process.env.HACKATHON_BASE_URL ?? 'https://agent-cost-governor-hackathon.apiworkersdev.workers.dev';
const API_ADMIN_KEY = process.env.HACKATHON_API_ADMIN_KEY ?? '';
const WORKSPACE_ID = process.env.HACKATHON_WORKSPACE_ID ?? 'hackathon-demo';
const TX_HASH = process.env.HACKATHON_TX_HASH ?? '0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548';
const CREDITS = Number.parseInt(process.env.HACKATHON_CREDITS ?? '10', 10);

function assertEnv() {
  if (!API_ADMIN_KEY) {
    throw new Error('Missing HACKATHON_API_ADMIN_KEY');
  }
  if (!TX_HASH || !TX_HASH.startsWith('0x')) {
    throw new Error('Missing or invalid HACKATHON_TX_HASH');
  }
  if (!Number.isFinite(CREDITS) || CREDITS <= 0) {
    throw new Error('HACKATHON_CREDITS must be a positive integer');
  }
}

async function httpJson(method, path, body, headers = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { status: response.status, data, headers: response.headers };
}

async function main() {
  assertEnv();

  const create = await httpJson(
    'POST',
    '/v1/workspaces/create',
    { workspace_id: WORKSPACE_ID },
    { 'x-admin-key': API_ADMIN_KEY },
  );
  if (create.status !== 200 || !create.data?.api_key) {
    throw new Error(`Workspace create failed: ${create.status} ${JSON.stringify(create.data)}`);
  }

  const apiKey = String(create.data.api_key);
  const auth = { authorization: `Bearer ${apiKey}` };

  const balance = await httpJson(
    'GET',
    `/v1/billing/balance?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`,
    null,
    auth,
  );
  const currentCredits = Number(balance.data?.credits ?? 0);

  let billingRedeem = { data: { credits_total: currentCredits } };
  if (currentCredits < 1) {
    const quote = await httpJson('POST', '/v1/billing/quote', { workspace_id: WORKSPACE_ID, credits: CREDITS }, auth);
    if (quote.status !== 200 || !quote.data?.quote_id) {
      throw new Error(`Billing quote failed: ${quote.status} ${JSON.stringify(quote.data)}`);
    }

    billingRedeem = await httpJson(
      'POST',
      '/v1/billing/redeem',
      { quote_id: quote.data.quote_id, tx_hash: TX_HASH },
      auth,
    );
    if (billingRedeem.status !== 200 || billingRedeem.data?.ok !== true) {
      if (billingRedeem.status === 409) {
        throw new Error(
          `Billing redeem conflict: tx hash already used. Provide a fresh HACKATHON_TX_HASH or use a funded workspace via HACKATHON_WORKSPACE_ID.`,
        );
      }
      throw new Error(`Billing redeem failed: ${billingRedeem.status} ${JSON.stringify(billingRedeem.data)}`);
    }
  }

  const check = await httpJson(
    'POST',
    '/v1/governor/check',
    {
      policy_id: 'retry_friction_v1',
      action: 'tool_call',
      actor: { id: 'agent:hackathon', project: WORKSPACE_ID },
      context: {
        attempt_in_window: 4,
        window_seconds: 60,
        task_hash: 'sha256:hackathon-task',
        step_hash: 'sha256:hackathon-step',
        context_hash: 'sha256:hackathon-context',
      },
    },
    auth,
  );

  if (check.status !== 402 || !check.data?.decision_id) {
    throw new Error(`Expected 402 friction check, got: ${check.status} ${JSON.stringify(check.data)}`);
  }

  const governorRedeem = await httpJson(
    'POST',
    '/v1/governor/redeem',
    { decision_id: check.data.decision_id },
    { ...auth, 'x402-tx-hash': TX_HASH },
  );

  if (governorRedeem.status !== 200 || governorRedeem.data?.ok !== true || !governorRedeem.data?.proceed_token) {
    throw new Error(`Governor redeem failed: ${governorRedeem.status} ${JSON.stringify(governorRedeem.data)}`);
  }

  const paidChain = String(governorRedeem.data?.receipt?.paid_chain ?? '').toLowerCase();

  console.log(JSON.stringify({
    ok: true,
    base_url: BASE_URL,
    workspace_id: WORKSPACE_ID,
    tx_hash: TX_HASH,
    tx_explorer_bsc: `https://bscscan.com/tx/${TX_HASH}`,
    decision_id: governorRedeem.data.decision_id,
    paid_chain: paidChain,
    credits_total: billingRedeem.data?.credits_total,
    has_proceed_token: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
