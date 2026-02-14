# Technical Notes

## Architecture
- Worker API (Cloudflare Workers + Hono) for check/redeem/billing
- Durable Objects for decision records and billing state
- Runner and SDK integration for enforcement in real agent loops
- OpenClaw competition mode assets for autonomous multi-agent flow

## Core flow
1. Client calls `/v1/governor/check`
2. If allowed: gets `proceed_token`
3. If friction required: receives `402` + x402 headers + `decision_id`
4. Client redeems with tx hash via `/v1/governor/redeem`
5. Worker verifies payment context and returns short-lived `proceed_token`

## Reproducible setup
1. Install dependencies
2. Run workspace checks
3. Run smoke/demo scripts
4. Run hackathon proof script

## Commands
- `npm --workspaces run check`
- `npm --prefix . --workspace worker run test`
- `npm run smoke`
- `npm run demo:hackathon:proof`

## Onchain proof artifacts
- Contract: `0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`
- Deploy tx: `0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`
- Governor proof tx: `0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548`
- Address index file: see `bsc.address`

## Security notes
- Competition flow is configured with `ALLOW_STUB_TX=false`
- API auth mode: workspace keys
- Signing uses ES256 key material from secrets
