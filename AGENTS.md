# AGENTS.md

AI agents and new engineers: the onboarding documentation for this repository lives in
**[`docs/AGENTS.md`](docs/AGENTS.md)** — repo map, the golden rules (data contract, single-writer
discipline, preservation semantics, atomic writes, secrets policy, deploy pitfalls), a worked
end-to-end feature example, UI style guardrails, build/test/deploy commands, and a gotcha
catalogue.

Deep dives beside it:

- [`docs/FEATURES.md`](docs/FEATURES.md) — every feature and where its code lives
- [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) — every file, writer, lock and lifecycle
- [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md) — briefs, report enrichment, models, queues
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — Jira/Bitbucket, the HTTP API, config chain
- [`docs/RUNTIME.md`](docs/RUNTIME.md) — containers, agents, queues, schedulers, runbook
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the component-level overview

Non-negotiables, in one breath: `src/types.ts` is the data contract (mirror changes into
`jira-intern/prompts/intern-prompt.md`); one `data.json` writer at a time (locks); failed lookups
carry prior data forward, never write empty; all dump writes are atomic and keep `data.js` in
sync; no secrets ever enter this public repo (stage by name, leak-scan before committing);
`npm run build` and `npm test` must pass; deploy with `bash start-jira-board.sh`.
