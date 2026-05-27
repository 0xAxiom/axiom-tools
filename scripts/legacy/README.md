# endpoint-builder — retired 2026-05-27

These scripts were the original parallel build pipeline for axiom-tools, driven by
the `com.axiom.endpoint-builder` launchd agent (10/14/19 PT daily). They scaffolded
new x402 endpoints into this repo and deployed them as standalone Vercel projects
under `axiom-tools-hazel.vercel.app/api/<slug>`.

Superseded by the **`axiom-tools-build` cron** in `~/.openclaw/cron/jobs.json`, which
builds canonical ERC-8257 v0.2 tools into `~/Github/axiom/website/api/tools/` (the
clawbots.org Astro+Vercel project) and registers each on-chain at the ToolRegistry
`0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1` on Base. That cron resolves the
ERC-8257 registry registration TODO that this script never wired up (see line 11
of the moved `endpoint-builder.mjs`).

The launchd plist was unloaded on 2026-05-27 and renamed to
`com.axiom.endpoint-builder.plist.disabled-20260527` in `~/Library/LaunchAgents/`.
Reloadable if ever needed via `launchctl load`.

Keep these files for git history / reference. Don't run them.
