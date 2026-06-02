// Reads abilities.vdata and maps each shop item ability name to its category
// and soul cost, for the per-category investment totals (gun / vitality /
// spirit) shown on the player's Items line.
//
// Category comes from m_eItemSlotType; the soul cost is NOT in the vdata, so it
// is derived from the item's tier (m_iItemTier) via the TIER_COST table below.
// Those tier prices are the one thing that can't be synced from game files —
// re-verify them after a shop economy patch.
//
// Input:  $VDATA_DIR/abilities.vdata  (default scripts/.vdata; repo-root fallback)
// Output: src/data/item-stats.json   ({ "<item_name>": { cat, cost } })
//
// Run via the sync script, or standalone: `bun run item-stats`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { topLevelEntries, field } from "./lib/kv3";

const ROOT = resolve(import.meta.dir, "..");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/item-stats.json");

const synced = resolve(VDATA_DIR, "abilities.vdata");
const INPUT = existsSync(synced) ? synced : resolve(ROOT, "abilities.vdata");

if (!existsSync(INPUT)) {
  console.error(
    `abilities.vdata not found. Run scripts/sync-game-data.sh first ` +
      `(looked in ${VDATA_DIR} and the repo root).`,
  );
  process.exit(1);
}

// m_eItemSlotType -> our category slug.
const CATEGORY: Record<string, "weapon" | "vitality" | "spirit"> = {
  EItemSlotType_WeaponMod: "weapon",
  EItemSlotType_Armor: "vitality",
  EItemSlotType_Tech: "spirit",
};

// Soul cost by m_iItemTier. Not present in the vdata — hardcoded game economy
// constants (top two tiers both 6400). Re-verify after a shop price patch.
const TIER_COST: Record<string, number> = {
  EModTier_1: 800,
  EModTier_2: 1600,
  EModTier_3: 3200,
  EModTier_4: 6400,
  EModTier_5: 6400,
};

const text = await Bun.file(INPUT).text();

type ItemStat = { cat: "weapon" | "vitality" | "spirit"; cost: number };
const out: Record<string, ItemStat> = {};
let count = 0;
for (const { name, body } of topLevelEntries(text)) {
  if (field(body, "m_eAbilityType") !== "EAbilityType_Item") continue;
  const slot = field(body, "m_eItemSlotType");
  const cat = slot ? CATEGORY[slot] : undefined;
  if (!cat) continue; // skip EItemSlotType_Invalid / unset
  const tier = field(body, "m_iItemTier");
  const cost = tier ? TIER_COST[tier] : undefined;
  if (cost == null) continue; // skip items without a known tier
  out[name] = { cat, cost };
  count++;
}

// Stable, sorted output for clean diffs.
const sorted: Record<string, ItemStat> = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];

await Bun.write(OUTPUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${count} item stats -> ${OUTPUT} (from ${INPUT})`);
