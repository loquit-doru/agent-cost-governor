# OpenClaw Integration Guide

ProceedGate ships as an OpenClaw skill. This guide sets up OpenClaw with the `onchain-cost-governor` skill so an AI agent can autonomously gate expensive actions through the ProceedGate API with onchain verification on BNB Chain.

## Prerequisites

- Node.js ≥ 22
- Git
- An LLM API key (Anthropic recommended)

## 1. Install OpenClaw

```bash
npm install -g openclaw@latest
```

Verify:

```bash
openclaw --version
```

## 2. Run onboarding

```bash
openclaw onboard --install-daemon
```

The wizard guides you through:
- Gateway setup (WebSocket control plane on `ws://127.0.0.1:18789`)
- LLM provider authentication (Anthropic Pro/Max recommended)
- Channel pairing (optional: WhatsApp, Telegram, Slack, Discord)

## 3. Configure ProceedGate skill

Copy the example config:

```bash
cp openclaw/openclaw.json.example ~/.openclaw/openclaw.json
```

Or merge into your existing `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "onchain-cost-governor": {
        "enabled": true,
        "env": {
          "GOVERNOR_API_URL": "https://governor.proceedgate.dev"
        }
      }
    },
    "load": {
      "extraDirs": ["./skills"]
    }
  }
}
```

## 4. Register the workspace skill

OpenClaw loads skills from `<workspace>/skills/`. Point your agent workspace to this repo:

```bash
# Option A: Set workspace to this repo's openclaw/ directory
# In ~/.openclaw/openclaw.json:
# "agent": { "workspace": "/path/to/agent-cost-governor/openclaw" }

# Option B: Symlink the skill into your existing workspace
ln -s /path/to/agent-cost-governor/skills/onchain-cost-governor ~/.openclaw/workspace/skills/onchain-cost-governor
```

The skill will be detected automatically (skill watcher is enabled by default).

## 5. Verify skill is loaded

Start the gateway and check:

```bash
openclaw gateway --port 18789 --verbose
```

In another terminal, talk to the agent:

```bash
openclaw agent --message "What skills do you have?"
```

The agent should list `onchain-cost-governor` among its available skills.

## 6. Test cost governance

Ask the agent to gate an action:

```bash
openclaw agent --message "Check if agent:demo-bot-1 is allowed to make an expensive API call costing $5"
```

The agent will use the skill to call `POST /v1/governor/check` and return the decision.

## Key files

| File | Purpose |
|------|---------|
| `skills/onchain-cost-governor/SKILL.md` | OpenClaw skill definition (AgentSkills format) |
| `skills/onchain-cost-governor/example.mjs` | Viem-based onchain approval check |
| `openclaw/SOUL.md` | Agent identity and safety policies |
| `openclaw/AGENTS.md` | Agent instructions and multi-agent coordination |
| `openclaw/openclaw.json.example` | Configuration template |

## Multi-agent setup

ProceedGate supports multi-agent coordination via OpenClaw sessions:

1. **Coordinator agent** — receives tasks, estimates costs
2. **Governor agent** (ProceedGate) — gates actions via the API
3. **Executor agent** — runs approved actions only

See `openclaw/AGENTS.md` for the full multi-agent protocol.

## Channel integration (optional)

Route cost governance to messaging channels:

```json
{
  "channels": {
    "discord": { "token": "YOUR_BOT_TOKEN" },
    "telegram": { "botToken": "YOUR_BOT_TOKEN" }
  }
}
```

The agent can then receive cost governance requests via Discord/Telegram and respond with allow/block decisions.

## Docs

- [OpenClaw docs](https://docs.openclaw.ai/)
- [Skills reference](https://docs.openclaw.ai/tools/skills)
- [Multi-agent sessions](https://docs.openclaw.ai/concepts/session-tool)
- [ProceedGate API spec](SPEC.md)
