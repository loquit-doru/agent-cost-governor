# AI Build Log (OpenClaw Edition)

This file documents how AI tools were used during build.

## Tools Used
- GitHub Copilot (GPT-5.3-Codex)
- Claude Code / Cursor (optional, if used)

## Scope of AI Assistance
- Architecture and checklists for judge-ready submission flow.
- Competition mode docs and reproducible runbook.
- OpenClaw skill scaffolding and multi-agent role definitions.
- Smart contract baseline for onchain stake gating.
- Validation scripts for real tx proof flow.

## Human Decisions
- Final chain target selection (`BSC` for current proof run).
- Recipient and tx proof strategy used in demo environment.
- Security posture decisions (no stub in competition mode).
- Final wording for submission narrative and social strategy.

## Reproducibility Notes
- Final proof command: `npm run demo:hackathon:proof`.
- Includes non-stub tx flow and returns `decision_id` + `proceed_token` evidence.

## Future Iterations
- Add richer autonomous policy update logic for stake thresholds.
- Add explicit human-in-loop flow for sensitive execution classes.
- Expand to opBNB and additional chains with policy-aware routing.
