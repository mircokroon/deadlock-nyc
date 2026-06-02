// Verify the modifier stat-type ids hardcoded in wasm/src/lib.rs against the
// game's EModifierValue enum.
//
// The demo stores each stat-viewer modifier's type as an integer (`m_eValType`)
// whose meaning comes from the EModifierValue schema enum — NOT from anything in
// GameTracking-Deadlock. So this can't be auto-synced like the icon manifests;
// instead, on a machine with Deadlock + Source 2 Viewer, dump the EModifierValue
// enum to a text file and point this script at it. It reports, for each stat the
// app sums, whether lib.rs's id still names the stat we think it does.
//
// Producing the dump (Deadlock machine):
//   Source 2 Viewer can export schema enums; or use a source2gen dump. Any
//   format works as long as it contains lines like `MODIFIER_VALUE_FOO = 31`.
//   Save it as scripts/.vdata/EModifierValue.txt (or pass a path / set
//   MODIFIER_SCHEMA).
//
// Run: bun run scripts/check-modifier-values.ts [path-to-dump]

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// Mirror of the (id -> stat bucket) mapping in wasm/src/lib.rs. lib.rs is the
// source of truth; this table only exists so we can flag drift. `hints` are
// substrings we expect in the EModifierValue name for that bucket.
const TRACKED = [
  { bucket: "bonus_health", id: 31, hints: ["BONUS_HEALTH", "MAX_HEALTH", "HEALTH"] },
  { bucket: "spirit_power", id: 51, hints: ["TECH_POWER", "SPIRIT_POWER", "TECH"] },
  { bucket: "fire_rate", id: 79, hints: ["FIRE_RATE", "ATTACK_SPEED", "ROF"] },
  { bucket: "weapon_damage", id: 18, hints: ["WEAPON_DAMAGE", "BULLET_DAMAGE", "BASEATTACK"] },
  { bucket: "cooldown_reduction", id: 109, hints: ["COOLDOWN", "CDR"] },
  { bucket: "ammo", id: 172, hints: ["AMMO", "CLIP", "MAGAZINE"] },
] as const;

const dumpPath = resolve(
  process.argv[2] ??
    process.env.MODIFIER_SCHEMA ??
    resolve(ROOT, "scripts/.vdata/EModifierValue.txt"),
);

if (!existsSync(dumpPath)) {
  console.log(
    `No EModifierValue dump found at ${dumpPath}.\n\n` +
      `This is an optional check that needs a schema dump from a machine with\n` +
      `Deadlock + Source 2 Viewer. See the header of this file for how to make\n` +
      `one. The ids currently trusted in wasm/src/lib.rs are:\n` +
      TRACKED.map((t) => `  ${t.id}\t-> ${t.bucket}`).join("\n"),
  );
  process.exit(0);
}

const text = await Bun.file(dumpPath).text();

// name -> int and int -> name, from any line like `MODIFIER_VALUE_FOO = 31`.
const nameToId = new Map<string, number>();
const idToName = new Map<number, string>();
for (const m of text.matchAll(/(MODIFIER_VALUE_[A-Z0-9_]+)\s*=\s*(\d+)/g)) {
  const name = m[1];
  const id = Number(m[2]);
  nameToId.set(name, id);
  if (!idToName.has(id)) idToName.set(id, name);
}

if (nameToId.size === 0) {
  console.error(
    `No "MODIFIER_VALUE_* = <int>" entries parsed from ${dumpPath}. ` +
      `Is it really an EModifierValue dump?`,
  );
  process.exit(2);
}

console.log(`Parsed ${nameToId.size} EModifierValue entries from ${dumpPath}\n`);

let problems = 0;
for (const t of TRACKED) {
  const nameAtId = idToName.get(t.id);
  const matchesHint =
    !!nameAtId && t.hints.some((h) => nameAtId.includes(h));
  const status = matchesHint ? "OK  " : "WARN";
  if (!matchesHint) problems++;

  console.log(
    `[${status}] ${t.bucket.padEnd(20)} lib.rs id ${String(t.id).padStart(3)} ` +
      `-> dump: ${nameAtId ?? "(no entry at this id!)"}`,
  );

  // Show where the expected stat actually lives now, so a remap is obvious.
  const candidates = [...nameToId.entries()].filter(([n]) =>
    t.hints.some((h) => n.includes(h)),
  );
  if (!matchesHint && candidates.length) {
    for (const [n, id] of candidates) {
      console.log(`        candidate: ${n} = ${id}`);
    }
  }
}

if (problems) {
  console.error(
    `\n${problems} stat id(s) no longer match the expected EModifierValue ` +
      `name. Update the constants in wasm/src/lib.rs (and the TRACKED table ` +
      `here), then rebuild with \`bun run wasm\`.`,
  );
  process.exit(1);
}
console.log("\nAll tracked modifier ids still match. No changes needed.");
