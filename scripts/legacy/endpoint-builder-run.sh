#!/bin/bash
# launchd wrapper for endpoint-builder.mjs. Sources env, fixes PATH,
# pulls latest main, runs the builder, logs output.
#
# Installed via ~/Library/LaunchAgents/com.axiom.endpoint-builder.plist
# Fires 3x/day (10:00 / 14:00 / 19:00 PT).

set -uo pipefail

REPO=$HOME/Github/0xAxiom/axiom-tools

# Source the env once. Wallet env carries: BASE_RPC_URL, VERCEL_TOKEN,
# ETHERSCAN_API_KEY, OPENSEA_API_KEY, plus the NET_PRIVATE_KEY that signs
# any future ERC-8257 registration tx.
# shellcheck disable=SC1090
source "$HOME/.axiom/wallet.env"

# PATH: launchd ships with /usr/bin and /bin only. We need node, claude,
# vercel, gh, foundry, openclaw.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.foundry/bin:$HOME/.npm-global/bin:$PATH"

cd "$REPO" || exit 1

# Pull latest in case Melted (or a prior fire) pushed something.
git pull --rebase origin main 2>&1 | tail -5

# Run.
node scripts/endpoint-builder.mjs
