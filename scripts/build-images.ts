// Extract only the images the app references out of panorama/images/, write
// them as optimized WebP into public/, and prune everything stale.
//
// panorama/images/ is a full Source 2 Viewer dump (tens of MB, many subtrees we
// never touch). The app only ever serves a small subset, and it knows exactly
// which files — they're named in the generated manifests plus one hardcoded
// minimap list. This script reads that set, so it copies precisely what ships
// and nothing else.
//
// "The ones we need" = the union of:
//   - src/data/item-icons.json     values  (/items/<cat>/foo_psd.webp)
//   - src/data/hero-portraits.json values  (/heroes/foo_sm_psd.webp)
//   - src/data/ability-icons.json  values  (/hud/abilities/... , /upgrades/...)
//   - the two minimap layers map-view.tsx hardcodes
//
// Each *served* URL is .webp (our optimized output). Its panorama *source* is
// the same path with the extension swapped back to .png — that's the file
// Source 2 Viewer exported (foo.psd -> foo_psd.png). Minimap layers are served
// flat under /minimap/ but live in panorama under minimap/base/.
//
// Optimization (downscale to display resolution, then encode WebP):
//   minimap          -> native (primary backdrop, zoomable) — recompress only
//   everything else  -> 96px   (icons render at <=48px; 2x for retina)
//
// item icons drop ~23KB PNG -> ~1.5KB WebP (~15x); portraits ~23KB -> ~3KB;
// ability icons similar; the minimap ~536KB PNG -> ~225KB WebP.
//
// Requires `cwebp` (brew install webp).
//
// Run: bun run images
//   --dry-run    show what would be written/pruned, touch nothing
//   --no-prune   keep files we didn't produce in dirs we wrote into
//   --force      re-encode even when the WebP is newer than its source
//
// After a patch: re-export panorama/ on the Deadlock machine, `bun run sync`
// to refresh the manifests, then `bun run images`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PANORAMA = process.env.PANORAMA_DIR
  ? resolve(process.env.PANORAMA_DIR)
  : resolve(ROOT, "panorama/images");
const PUBLIC = resolve(ROOT, "public");

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PRUNE = process.argv.includes("--no-prune");
const FORCE = process.argv.includes("--force");

// Manifests whose *values* are served URLs. build-images mirrors each into a
// public/ WebP; the generators (build-{item,ability}-manifest, portraits) own
// the name->url mapping.
const MANIFESTS = [
  "src/data/item-icons.json",
  "src/data/hero-portraits.json",
  "src/data/ability-icons.json",
];

// Per-category encode settings, picked by the served URL's leading segment;
// anything without an explicit rule uses DEFAULT_RULE. width 0 => keep native
// resolution (no downscale).
const DEFAULT_RULE = { width: 96, quality: 82 };
const RULES: Record<string, { width: number; quality: number }> = {
  items: { width: 96, quality: 80 },
  heroes: { width: 96, quality: 82 },
  minimap: { width: 0, quality: 82 },
};

// Minimap layers aren't in any manifest — map-view.tsx hardcodes them. They're
// served flat under /minimap/ but exported under panorama minimap/base/.
const MINIMAP: { url: string; sourceRel: string }[] = [
  {
    url: "/minimap/minimap_midtown_mid_psd_dd4bcbf9.webp",
    sourceRel: "minimap/base/minimap_midtown_mid_psd_dd4bcbf9.png",
  },
  {
    url: "/minimap/minimap_midtown_mid_tunnels_psd.webp",
    sourceRel: "minimap/base/minimap_midtown_mid_tunnels_psd.png",
  },
];

interface Job {
  /** served URL, e.g. /items/weapon/foo_psd.webp */
  url: string;
  /** absolute path of the panorama source PNG */
  source: string;
  /** absolute path of the public WebP to write */
  dest: string;
  /** leading path segment (items, heroes, minimap, hud, upgrades, …) */
  category: string;
}

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function haveCwebp(): Promise<boolean> {
  try {
    const p = Bun.spawn(["cwebp", "-version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

function readManifestUrls(file: string): string[] {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) die(`manifest not found: ${path} (run \`bun run sync\` first)`);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return [...new Set(Object.values(data))];
}

// Served URL (/items/weapon/foo_psd.webp) -> source PNG + dest WebP. The source
// is the same relative path with the trailing .webp swapped back to the .png
// Source 2 Viewer exported.
function jobFromUrl(url: string): Job {
  const rel = url.replace(/^\//, ""); // items/weapon/foo_psd.webp
  return {
    url,
    source: join(PANORAMA, rel.replace(/\.webp$/, ".png")),
    dest: join(PUBLIC, rel),
    category: rel.split("/")[0],
  };
}

function buildJobs(): Job[] {
  const urls = new Set<string>();
  for (const m of MANIFESTS) for (const u of readManifestUrls(m)) urls.add(u);
  for (const m of MINIMAP) urls.add(m.url);

  const sources = new Map(MINIMAP.map((m) => [m.url, join(PANORAMA, m.sourceRel)]));
  const jobs = [...urls].map((url) => {
    const job = jobFromUrl(url);
    // Minimap layers override the default source (they live under base/).
    if (sources.has(url)) return { ...job, source: sources.get(url)! };
    return job;
  });
  // Stable order for readable logs / deterministic runs.
  jobs.sort((a, b) => a.url.localeCompare(b.url));
  return jobs;
}

async function encode(job: Job): Promise<number> {
  const rule = RULES[job.category] ?? DEFAULT_RULE;
  const args = ["-quiet", "-q", String(rule.quality)];
  if (rule.width > 0) args.push("-resize", String(rule.width), "0");
  args.push(job.source, "-o", job.dest);

  mkdirSync(dirname(job.dest), { recursive: true });
  const p = Bun.spawn(["cwebp", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    die(`cwebp failed for ${job.source}\n${err.trim()}`);
  }
  return statSync(job.dest).size;
}

// Newer-than-source check so re-runs are cheap; --force overrides.
function needsEncode(job: Job): boolean {
  if (FORCE || !existsSync(job.dest)) return true;
  return statSync(job.source).mtimeMs > statSync(job.dest).mtimeMs;
}

// Guarantee `dir` is a real directory we can safely write into and prune. If
// it's a symlink (legacy whole-dump serving), unlink it — that removes only the
// link, never the dump it points at — and recreate it empty. Returns true if a
// symlink was replaced.
function ensureRealDir(dir: string): boolean {
  let wasSymlink = false;
  try {
    wasSymlink = lstatSync(dir).isSymbolicLink();
  } catch {
    /* doesn't exist yet */
  }
  if (DRY_RUN) return wasSymlink;
  if (wasSymlink) unlinkSync(dir);
  mkdirSync(dir, { recursive: true });
  return wasSymlink;
}

// Direct files in `dir` (non-recursive). Pruning is per-directory, so we only
// ever touch dirs we actually wrote into and never recurse into siblings.
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(dir, e.name));
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function categoryOf(absDir: string): string {
  return relative(PUBLIC, absDir).split(sep)[0];
}

async function main() {
  if (!(await haveCwebp())) {
    die("`cwebp` not found on PATH. Install it with `brew install webp`.");
  }
  if (!existsSync(PANORAMA)) {
    die(`panorama dir not found: ${PANORAMA}\nExport images there with Source 2 Viewer, or set PANORAMA_DIR.`);
  }

  let jobs = buildJobs();

  // A few manifest entries can point at images the dump doesn't carry as a
  // raster (e.g. *.svg icons cwebp can't read). Warn and skip them rather than
  // aborting — they'll fall back to a placeholder in the UI.
  const missing = jobs.filter((j) => !existsSync(j.source));
  if (missing.length) {
    console.warn(`Skipping ${missing.length} referenced image(s) absent from ${relative(ROOT, PANORAMA)}:`);
    for (const j of missing.slice(0, 10)) console.warn(`  ${relative(PANORAMA, j.source)}  (for ${j.url})`);
    if (missing.length > 10) console.warn(`  …and ${missing.length - 10} more`);
    jobs = jobs.filter((j) => existsSync(j.source));
  }

  const byCat = (c: string) => jobs.filter((j) => j.category === c).length;
  console.log(
    `${DRY_RUN ? "[dry-run] " : ""}Optimizing ${jobs.length} images ` +
      `(${byCat("items")} items, ${byCat("heroes")} heroes, ` +
      `${byCat("hud") + byCat("upgrades")} abilities, ${byCat("minimap")} minimap) ` +
      `from ${relative(ROOT, PANORAMA)} -> ${relative(ROOT, PUBLIC)}`,
  );

  // Replace legacy whole-dump symlinks with real dirs before writing/pruning.
  // Scoped to the top-level dirs we actually write into this run.
  const fresh = new Set<string>();
  for (const cat of new Set(jobs.map((j) => j.category))) {
    if (ensureRealDir(join(PUBLIC, cat))) fresh.add(cat);
  }
  if (fresh.size) {
    console.log(
      `  ${DRY_RUN ? "would replace" : "replaced"} symlink(s) with real dirs: ` +
        `${[...fresh].join(", ")} (source dump left untouched)`,
    );
  }

  let written = 0;
  let skipped = 0;
  let totalOut = 0;
  let totalIn = 0;
  const produced = new Set<string>();
  const writtenDirs = new Set<string>();

  for (const job of jobs) {
    produced.add(resolve(job.dest));
    writtenDirs.add(resolve(dirname(job.dest)));
    totalIn += statSync(job.source).size;
    if (!needsEncode(job)) {
      skipped++;
      if (existsSync(job.dest)) totalOut += statSync(job.dest).size;
      continue;
    }
    if (DRY_RUN) {
      written++;
      continue;
    }
    totalOut += await encode(job);
    written++;
  }

  console.log(
    `  encoded ${written}, skipped ${skipped} (up to date)` +
      (DRY_RUN ? "" : `  ·  ${fmtKB(totalIn)} PNG -> ${fmtKB(totalOut)} WebP`),
  );

  // Prune: in each directory we wrote into, drop any file we didn't produce
  // (old full-size PNGs, renamed/unused icons). Scoped to written dirs only, so
  // hand-authored files outside them (public/hud/golden_idol.png, teams/*.svg)
  // are never touched.
  if (!NO_PRUNE) {
    let prunedCount = 0;
    let prunedBytes = 0;
    for (const dir of writtenDirs) {
      // Under --dry-run a legacy symlink is still on disk; walking it would list
      // the source dump, not stale public files. The real run already replaced
      // it with an empty dir, so there's nothing to prune there.
      if (DRY_RUN && fresh.has(categoryOf(dir))) continue;
      for (const file of filesIn(dir)) {
        if (produced.has(resolve(file))) continue;
        prunedBytes += statSync(file).size;
        prunedCount++;
        if (DRY_RUN) console.log(`  [dry-run] would prune ${relative(PUBLIC, file)}`);
        else unlinkSync(file);
      }
    }
    if (prunedCount) {
      console.log(`  ${DRY_RUN ? "would prune" : "pruned"} ${prunedCount} stale file(s), freeing ${fmtKB(prunedBytes)}`);
    }
  }

  console.log(DRY_RUN ? "Dry run complete — nothing written." : "Done.");
}

main();
