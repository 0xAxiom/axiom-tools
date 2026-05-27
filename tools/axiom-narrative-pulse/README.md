# axiom-narrative-pulse

Decision-grade narrative map for crypto + AI, exposed as a paid agent endpoint.

Same engine as the [aeon-narrative-tracker](https://github.com/0xAxiom/axiom-public/tree/main/agent-skills/skills/aeon-narrative-tracker) skill: phase labels, velocity arrows, named drivers, explicit position calls. The skill is great for humans in chat; this endpoint is for agents that want to ingest it programmatically and react.

## Why this exists

Most "narrative trackers" are vibes-aggregators — they tell you what's loud without telling you what to do about it. This one outputs **position calls** (FRONT-RUN / RIDE / FADE / WATCH / IGNORE) keyed to phase transitions, not raw mindshare. Agents can route trades, posts, or content priorities off the position field directly.

## Pricing

| Caller | Cost |
|--------|------|
| AXIOM Tool Pass holder (`x-pass-holder` + onchain `balanceOf ≥ 1`) | Free |
| Everyone else | x402: $0.01 USDC on Base per call |

## Routes

| Path | What |
|------|------|
| `GET /api/axiom-narrative-pulse` | Latest snapshot (full map) |
| `GET /api/axiom-narrative-pulse?position=FRONT-RUN` | Filter by position call |
| `GET /api/axiom-narrative-pulse?phase=Emerging` | Filter by phase |
| `GET /api/axiom-narrative-pulse?narrative=agentic-tool-registries` | Single narrative |
| `GET /.well-known/ai-tool/axiom-narrative-pulse.json` | ERC-8257 manifest |
| `GET /health` | Liveness |

## Sample response

```json
{
  "generatedAt": "2026-05-27T03:00:00.000Z",
  "stalenessHours": 0,
  "window": "last 72h",
  "transitions": {
    "new": ["agentic-tool-registries — ERC-8257 deployments + first paid agent endpoints"],
    "promoted": ["bankr-club-rotation — Rising → Peak"]
  },
  "reflexivity": [
    { "narrative": "agentic-tool-registries", "evidence": "@CodinCowboy max-minted AXIOM Tool Pass within 90min of the announce" }
  ],
  "narratives": [
    {
      "slug": "agentic-tool-registries",
      "mindshare": 2,
      "velocity": "↑↑",
      "phase": "Emerging",
      "position": "FRONT-RUN",
      "drivers": ["@CodinCowboy", "@opensea", "@AxiomBot"],
      "thesis": "ERC-8257 + tool-sdk shipping; first paid agent endpoints starting to hit Base.",
      "bearCase": "Agent-to-agent demand stays tiny; humans prefer free APIs over $0.01/call paywalls."
    }
  ]
}
```

## Architecture

```
┌───────────────────────┐      ┌────────────────────┐
│ refresh-snapshot.mjs  │ ───▶ │ snapshot.json      │
│ (cron, daily)         │      │ (committed to repo)│
└───────────────────────┘      └────────────────────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │ server.mjs   │ ──▶ agents
                                │ (fast reads) │
                                └──────────────┘
```

- **Snapshot model**, not live-on-request. Narrative phase doesn't shift hour-to-hour; spending 30-60s per request on web searches would blow the x402 latency budget.
- Snapshot regenerates daily via `refresh-snapshot.mjs`, which spawns the aeon-narrative-tracker skill in Claude Code `--print` mode and validates output shape before overwriting.
- Server only reads + filters + reports staleness.

## Local test

```bash
node tools/axiom-narrative-pulse/server.mjs
# → http://localhost:3458

curl http://localhost:3458/api/axiom-narrative-pulse | jq .narratives[0]
curl 'http://localhost:3458/api/axiom-narrative-pulse?position=FRONT-RUN' | jq
curl http://localhost:3458/.well-known/ai-tool/axiom-narrative-pulse.json
```

## Manual snapshot refresh

```bash
node tools/axiom-narrative-pulse/refresh-snapshot.mjs
```

Cron wires this in via the axiom-tools `endpoint-builder` lane.
