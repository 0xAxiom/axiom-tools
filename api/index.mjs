/**
 * Root index — lists every endpoint the project hosts. Helpful for humans
 * landing on https://axiom-tools.vercel.app/ in a browser.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export default function handler(req, res) {
  const dir = path.join(process.cwd(), ".well-known/ai-tool");
  let tools = [];
  try {
    tools = readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const m = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        return {
          slug:        path.basename(f, ".json"),
          name:        m.name,
          description: m.description,
          pricing:     m.pricing,
          endpoint:    `/api/${path.basename(f, ".json")}`,
          manifest:    `/.well-known/ai-tool/${path.basename(f, ".json")}.json`,
        };
      });
  } catch (e) {
    return res.status(500).json({ error: "could not enumerate manifests", detail: e.message });
  }

  res.status(200).json({
    service: "axiom-tools",
    description: "Paid agent endpoints (ERC-8257) for the AXIOM ecosystem.",
    passContract: "0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82",
    passContractName: "AXIOM Tool Pass",
    bypassHint: "Send `x-pass-holder: <wallet>` header — onchain balanceOf(wallet) >= 1 skips x402.",
    tools,
  });
}
