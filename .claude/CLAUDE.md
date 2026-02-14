# Claude Configuration for Agent Cost Governor

## Project Overview
This is the Agent Cost Governor (branded as **ProceedGate**) - a cost control system for AI agents that blocks retry storms before they drain API budgets.

**Primary vertical**: Scraping agents (Apify, SerpAPI, Firecrawl)

**Live URLs**:
- Site: https://proceedgate.dev
- Scraping page: https://proceedgate.dev/scraping.html
- API: https://governor.proceedgate.dev

## Key Features
- **Loop detection**: Blocks >10 identical requests per minute
- **Cost saved tracking**: Shows users how much money they saved
- **Per-agent budgets**: Hard caps per user/agent
- **Webhook alerts**: Slack/Discord notifications on blocks

## Marketing Learnings (Jan 2026)
- Target audience: Devs running scraping agents
- Copy style: Dev-centric, not enterprise fluff
- Key pain: "Woke up to a $340 bill"
- Key value: "Avg user saves $847/week"
- SEO keywords: "retry storms in scraping", "scraping budget control", "Apify retry loop"

## Moat Strategy
- DATA MOAT > obfuscation (collect patterns, expose insights)
- "Too painful to replace" > "impossible to copy"
- Lock-in through dependency, not complicated code
- Weekly "You saved $X" emails for retention

## Available Skills
Skills are reusable playbooks that guide Claude through specific workflows:

- **[cost-governance.md](skills/cost-governance.md)** - Development across all packages

## Available Commands
Slash commands for quick actions:

- **/retrospective** - Analyze conversation, extract learnings, update skills

## How to Use

### Using Skills
Reference a skill to follow its workflow:
```
Use the cost-governance skill to help me add a new API endpoint
```

### Running Retrospectives
At the end of each session, run:
```
/retrospective
```
This continuously improves the skills based on what we learn.

## Project Conventions
- TypeScript monorepo with npm workspaces
- Cloudflare Workers for backend
- Node.js SDK for client integration
- Run `npm --workspaces run check` for all packages

## Key Packages
- `worker/` - Cloudflare Worker API (billing, check, loop detection)
- `sdk-node/` - Node.js SDK
- `mcp-server/` - MCP server for AI tools
- `runner/` - CLI task runner
- `site/` - Static site (Cloudflare Pages)

## Key Files
- `SPEC.md` - API specification
- `package.json` - Root workspace config
- `worker/wrangler.toml` - Worker config
- `worker/src/billingStoreDO.ts` - Durable Object with loop detection
- `site/scraping.html` - Main landing page for scraping vertical

## Current Status (Jan 2026)
- ✅ API live and working
- ✅ Loop detection implemented
- ✅ Cost saved tracking
- ✅ Scraping landing page optimized
- 🎯 Next: Marketing push (Reddit, X, HN)
