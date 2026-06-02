// Reads abilities.vdata, walks each top-level entry, and pulls
// `m_strShopIconLarge` out, mapping each ability name to the icon URL the
// public/items tree serves: `items/weapon/foo.psd` -> `/items/weapon/foo_psd.webp`
// (the optimized WebP that scripts/build-images.ts writes from the panorama PNG).
//
// Input:  $VDATA_DIR/abilities.vdata  (default scripts/.vdata, populated by
//         scripts/sync-game-data.sh; falls back to the repo-root copy).
// Output: src/data/item-icons.json
//
// Run via the sync script, or standalone: `bun run items`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { topLevelEntries, field, imageUrlFromPanorama } from "./lib/kv3";

const ROOT = resolve(import.meta.dir, "..");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/item-icons.json");

// Prefer the synced copy; fall back to a repo-root abilities.vdata so the
// generator still runs standalone without a sync.
const synced = resolve(VDATA_DIR, "abilities.vdata");
const INPUT = existsSync(synced) ? synced : resolve(ROOT, "abilities.vdata");

if (!existsSync(INPUT)) {
  console.error(
    `abilities.vdata not found. Run scripts/sync-game-data.sh first ` +
      `(looked in ${VDATA_DIR} and the repo root).`,
  );
  process.exit(1);
}

const text = await Bun.file(INPUT).text();

const out: Record<string, string> = {};
let count = 0;
for (const { name, body } of topLevelEntries(text)) {
  const icon = field(body, "m_strShopIconLarge");
  if (!icon) continue;
  const url = imageUrlFromPanorama(icon);
  if (!url) continue;
  out[name] = url;
  count++;
}

await Bun.write(OUTPUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${count} item icons -> ${OUTPUT} (from ${INPUT})`);
