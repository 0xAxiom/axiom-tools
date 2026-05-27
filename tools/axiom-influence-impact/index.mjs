/**
 * axiom-influence-impact — attribution core.
 *
 * For a given token, compute which CT accounts move onchain volume when
 * they post about it. Method:
 *
 *   1. Fetch recent mentions of $TOKEN via Twitter API search.
 *   2. Fetch hourly OHLCV bars for the token's primary pool from
 *      GeckoTerminal (last 7d).
 *   3. For each tweet at time t, take the 2h window starting at
 *      floor(t / 3600) hours. The "post-window volume" is the sum of those
 *      two bars. Baseline = median hourly volume across the full 7d.
 *      Attributed delta = max(0, post_window - 2 * baseline).
 *   4. Aggregate per author.
 *
 * Caveats:
 *   - 2h windows can overlap if an author posts multiple times in the same
 *     hour bucket. We dedupe overlapping windows per-author by hour bucket.
 *   - Baseline uses median (not mean) to resist the very spikes we're
 *     trying to attribute.
 *   - Twitter recent-search returns ~7d on the free tier. 30d window would
 *     require Pro/Enterprise; for now we surface 7d only.
 *   - Attribution is correlational not causal — this is "who posted close
 *     to volume spikes" not "who caused them." But across enough samples
 *     consistent over-attribution is itself signal.
 */

import { execFileSync } from "node:child_process";

const TWITTER_API_PY = process.env.TWITTER_API_PY
  || "/Users/axiom/Github/axiom-public/agent-skills/scripts/twitter-api.py";

/**
 * @typedef {Object} OHLCVBar
 * @property {number} ts      Unix seconds, hour-aligned
 * @property {number} volume  USD volume in that hour
 *
 * @typedef {Object} Tweet
 * @property {string} id
 * @property {string} author
 * @property {string} text
 * @property {string} timestamp ISO string
 *
 * @typedef {Object} AuthorAggregate
 * @property {string} author
 * @property {number} posts
 * @property {number} total_attributed_usd
 * @property {number} avg_per_post
 * @property {string} last_seen        ISO
 * @property {string} sample_tweet_url
 */

// ─── data fetchers ────────────────────────────────────────────────────────────

export async function fetchOhlcv(poolId, hours = 168) {
  // GeckoTerminal hourly OHLCV. Format: [ts, o, h, l, c, vol_usd].
  // Free tier rate-limits aggressively; retry on 429 with backoff.
  const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolId}/ohlcv/hour?aggregate=1&limit=${hours}&currency=usd`;
  let lastErr;
  for (const wait of [0, 15_000, 30_000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      const list = data?.data?.attributes?.ohlcv_list ?? [];
      return list.map(([ts, _o, _h, _l, _c, v]) => ({ ts: Number(ts), volume: Number(v) || 0 }));
    }
    lastErr = new Error(`GT ${r.status} for ${poolId}`);
    if (r.status !== 429) throw lastErr;
  }
  throw lastErr;
}

/**
 * Spawn twitter-api.py search. Returns a list of tweets parsed from its
 * stdout format (one tweet per 3 lines: header, body, blank line).
 */
export function fetchTweets(query, count = 100) {
  const out = execFileSync("python3", [TWITTER_API_PY, "search", query, String(count)], {
    encoding: "utf8",
    timeout: 30_000,
  });

  const tweets = [];
  // Header line format: "@author [id] iso-timestamp"
  const headerRe = /^@(\S+)\s+\[(\d+)\]\s+(\S+)\s*$/;
  const lines = out.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const [, author, id, ts] = m;
    // Body: subsequent indented lines until blank or next header
    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (headerRe.test(l)) break;
      if (l.startsWith("  ")) bodyLines.push(l.trim());
      else if (l.startsWith("https://")) break; // permalink — skip
    }
    tweets.push({
      id,
      author,
      text: bodyLines.join(" "),
      timestamp: ts,
    });
  }
  return tweets;
}

// ─── attribution ──────────────────────────────────────────────────────────────

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {Tweet[]} tweets
 * @param {OHLCVBar[]} bars  Sorted newest-first or oldest-first; we index by ts.
 * @returns {{ baseline: number, leaderboard: AuthorAggregate[] }}
 */
export function attribute(tweets, bars) {
  // Build hour-bucketed bar lookup.
  const byTs = new Map();
  for (const b of bars) byTs.set(b.ts, b.volume);

  const allVols = bars.map(b => b.volume).filter(v => Number.isFinite(v));
  const baseline = median(allVols);

  // Per-author aggregation. Dedup overlapping 2h windows by hour bucket.
  const authors = new Map(); // author → { posts, total, last_seen, sample_url, seenBuckets:Set }

  for (const t of tweets) {
    const tweetTs = Math.floor(new Date(t.timestamp).getTime() / 1000);
    if (!Number.isFinite(tweetTs)) continue;
    const hourBucket = tweetTs - (tweetTs % 3600);

    const v1 = byTs.get(hourBucket) ?? 0;
    const v2 = byTs.get(hourBucket + 3600) ?? 0;
    const windowVolume = v1 + v2;
    const expected = 2 * baseline;
    const attributed = Math.max(0, windowVolume - expected);

    let entry = authors.get(t.author);
    if (!entry) {
      entry = {
        author: t.author,
        posts: 0,
        total_attributed_usd: 0,
        last_seen: t.timestamp,
        sample_tweet_url: `https://x.com/${t.author}/status/${t.id}`,
        _seen: new Set(),
      };
      authors.set(t.author, entry);
    }

    entry.posts += 1;
    if (!entry._seen.has(hourBucket)) {
      entry.total_attributed_usd += attributed;
      entry._seen.add(hourBucket);
    }
    if (new Date(t.timestamp) > new Date(entry.last_seen)) {
      entry.last_seen = t.timestamp;
      entry.sample_tweet_url = `https://x.com/${t.author}/status/${t.id}`;
    }
  }

  const leaderboard = [...authors.values()].map(({ _seen, ...rest }) => ({
    ...rest,
    avg_per_post: rest.posts ? Math.round((rest.total_attributed_usd / rest.posts) * 100) / 100 : 0,
    total_attributed_usd: Math.round(rest.total_attributed_usd * 100) / 100,
  }));
  leaderboard.sort((a, b) => b.total_attributed_usd - a.total_attributed_usd);

  return { baseline_hourly_usd: Math.round(baseline * 100) / 100, leaderboard };
}

// ─── top-level driver ─────────────────────────────────────────────────────────

/**
 * @param {{ symbol: string, contract: string, geckoterminalPool: string|null, searchTerms: string[] }} token
 * @param {{ days?: number }} opts
 */
export async function computeForToken(token, opts = {}) {
  const days = opts.days ?? 7;
  const hours = days * 24;

  if (!token.geckoterminalPool) {
    return {
      token: token.symbol,
      contract: token.contract,
      window: `${days}d`,
      computedAt: new Date().toISOString(),
      error: "no pool wired in known-tokens.json — add geckoterminalPool",
      leaderboard: [],
    };
  }

  const bars = await fetchOhlcv(token.geckoterminalPool, hours);

  // De-dup tweets across multiple search terms.
  const seenIds = new Set();
  const allTweets = [];
  for (const term of token.searchTerms) {
    const ts = fetchTweets(term, 100);
    for (const t of ts) {
      if (seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      allTweets.push(t);
    }
  }

  // Filter to tweets within the window.
  const cutoff = Date.now() - days * 86400_000;
  const inWindow = allTweets.filter(t => new Date(t.timestamp).getTime() >= cutoff);

  const { baseline_hourly_usd, leaderboard } = attribute(inWindow, bars);

  return {
    token: token.symbol,
    contract: token.contract,
    pool: token.geckoterminalPool,
    window: `${days}d`,
    computedAt: new Date().toISOString(),
    sampleSize: {
      tweets: inWindow.length,
      bars: bars.length,
    },
    baseline_hourly_usd,
    leaderboard: leaderboard.slice(0, 50),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const symbol = process.argv[2] ?? "AXIOM";
  const tokens = JSON.parse(readFileSync(new URL("./known-tokens.json", import.meta.url), "utf8")).tokens;
  const t = tokens[symbol];
  if (!t) { console.error(`unknown token: ${symbol}. Known:`, Object.keys(tokens).join(", ")); process.exit(1); }
  const out = await computeForToken(t);
  console.log(JSON.stringify(out, null, 2));
}
