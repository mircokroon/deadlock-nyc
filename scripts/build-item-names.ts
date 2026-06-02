// Reads citadel_gc_mod_names_english.txt (Valve KeyValues) and maps each item
// ability name to its localized display name:
//   upgrade_extra_charge   -> "Extra Charge"
//   upgrade_soaring_spirit -> "Improved Spirit"   (note: NOT title-cased slug)
//
// These are the names the in-game shop shows; many differ from the raw slug,
// so we can't derive them by prettifying — they come from localization.
//
// Input:  $VDATA_DIR/citadel_gc_mod_names_english.txt  (default scripts/.vdata)
// Output: src/data/item-names.json
//
// Run via the sync script, or standalone: `bun run item-names`

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const VDATA_DIR = process.env.VDATA_DIR
  ? resolve(process.env.VDATA_DIR)
  : resolve(ROOT, "scripts/.vdata");
const OUTPUT = resolve(ROOT, "src/data/item-names.json");

const INPUT = resolve(VDATA_DIR, "citadel_gc_mod_names_english.txt");
if (!existsSync(INPUT)) {
  console.error(
    `citadel_gc_mod_names_english.txt not found in ${VDATA_DIR}. ` +
      `Run scripts/sync-game-data.sh first.`,
  );
  process.exit(1);
}

const text = await Bun.file(INPUT).text();

// KeyValues pairs: `"key"  "value"`. We want item entries only, so skip the
// structural `Language`/`Tokens` keys and the `_search` alias of each item
// (the file lists every item twice — once for display, once for search).
const PAIR = /^\s*"([^"]+)"\s+"([^"]*)"/;
const out: Record<string, string> = {};
let count = 0;
for (const line of text.split("\n")) {
  const m = line.match(PAIR);
  if (!m) continue;
  const key = m[1];
  if (key.toLowerCase() === "language") continue;
  if (key.endsWith("_search")) continue;
  out[key] = m[2];
  count++;
}

const sorted: Record<string, string> = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];

await Bun.write(OUTPUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${count} item names -> ${OUTPUT} (from ${INPUT})`);
