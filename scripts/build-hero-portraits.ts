// Reads heroes.vdata and maps each hero's numeric m_HeroID to the small
// portrait URL the public/heroes tree serves, taken from m_strIconImageSmall:
//   hero 1  -> /heroes/inferno_sm_psd.png
//   hero 3  -> /heroes/hornet_sm_png.png
//
// The slug is read straight from the vdata's image reference rather than
// hardcoded, so it always matches assets re-extracted from the same game
// build. Heroes without an m_HeroID > 0 or a small portrait (hero_base,
// not-yet-shipped slots) are skipped.
//
// Input:  $VDATA_DIR/heroes.vdata  (default scripts/.vdata)
// Output: src/data/hero-portraits.json
//
// Run via the sync script, or standalone: `bun run portraits`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { topLevelEntries, field, imageUrlFromPanorama } from "./lib/kv3";

const ROOT = resolve(import.meta.dir, "..");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/hero-portraits.json");

const INPUT = resolve(VDATA_DIR, "heroes.vdata");
if (!existsSync(INPUT)) {
  console.error(
    `heroes.vdata not found in ${VDATA_DIR}. Run scripts/sync-game-data.sh first.`,
  );
  process.exit(1);
}

const text = await Bun.file(INPUT).text();

// hero_id -> portrait URL. Keyed by string id to round-trip cleanly as JSON.
const out: Record<string, string> = {};
let count = 0;
for (const { name, body } of topLevelEntries(text)) {
  if (!name.startsWith("hero_")) continue;
  const idRaw = field(body, "m_HeroID");
  const id = idRaw ? parseInt(idRaw, 10) : 0;
  if (!id || id <= 0) continue;

  const icon = field(body, "m_strIconImageSmall");
  if (!icon) continue;
  const url = imageUrlFromPanorama(icon);
  if (!url) continue;

  out[String(id)] = url;
  count++;
}

// Emit sorted by numeric id for a stable, reviewable diff.
const sorted: Record<string, string> = {};
for (const k of Object.keys(out).sort((a, b) => Number(a) - Number(b))) {
  sorted[k] = out[k];
}

await Bun.write(OUTPUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${count} hero portraits -> ${OUTPUT} (from ${INPUT})`);
