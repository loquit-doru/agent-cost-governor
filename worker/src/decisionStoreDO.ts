export type DecisionRecord = {
  decisionId: string;
  createdAtMs: number;
  expiresAtMs: number;
  actorId: string;
  policyId: string;
  action: string;
  taskHash?: string;
  stepHash?: string;
  contextHash?: string;
  price: string;
  chain: string;
  recipient: string;
};

type PutBody = { record: DecisionRecord };

export class DecisionStoreDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async getRecord(decisionId: string): Promise<DecisionRecord | null> {
    const record = (await this.state.storage.get<DecisionRecord>(`dec:${decisionId}`)) ?? null;
    if (!record) return null;

    if (Date.now() >= record.expiresAtMs) {
      await this.state.storage.delete(`dec:${decisionId}`);
      return null;
    }

    return record;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Internal DO API:
    // - PUT /decisions/:id { record }
    // - GET /decisions/:id
    // - DELETE /decisions/:id
    if (parts.length !== 2 || parts[0] !== 'decisions') {
      return new Response('not_found', { status: 404 });
    }

    const decisionId = parts[1]!;

    if (request.method === 'PUT') {
      const body = (await request.json().catch(() => null)) as PutBody | null;
      if (!body?.record || body.record.decisionId !== decisionId) {
        return new Response('invalid_request', { status: 400 });
      }

      await this.state.storage.put(`dec:${decisionId}`, body.record);
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET') {
      const record = await this.getRecord(decisionId);
      if (!record) return new Response('not_found', { status: 404 });
      return Response.json({ record }, { status: 200 });
    }

    if (request.method === 'DELETE') {
      await this.state.storage.delete(`dec:${decisionId}`);
      return new Response('ok', { status: 200 });
    }

    return new Response('method_not_allowed', { status: 405 });
  }
}
