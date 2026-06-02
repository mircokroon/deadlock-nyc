#!/usr/bin/env bash
set -euo pipefail

# Sync Deadlock game data and regenerate the JSON manifests deadlock-nyc ships.
#
# What it does:
#   1) Sparse-clones SteamDatabase/GameTracking-Deadlock (scripts dir only)
#   2) Copies abilities.vdata + heroes.vdata into scripts/.vdata/ (gitignored)
#   3) Runs the bun generators:
#        - build-item-manifest.ts  -> src/data/item-icons.json
#        - build-item-names.ts     -> src/data/item-names.json
#        - build-item-stats.ts     -> src/data/item-stats.json
#        - build-hero-portraits.ts -> src/data/hero-portraits.json
#        - build-ability-icons.ts  -> src/data/ability-icons.json
#
# This refreshes the *data* (item/hero names + icon paths). It does NOT fetch
# images or the modifier enum — those require the game install + Source 2 Viewer
# and are documented as manual steps in scripts/README.md. Display names for
# heroes/abilities live in the `boon` crate; bump it to refresh those.
#
# Environment:
#   DEADLOCK_REF=<ref>   optional: branch/tag/commit to pin (recommended, so the
#                        synced data matches the build your images were extracted
#                        from and the boon-proto version you parse against).

REPO_URL="https://github.com/SteamDatabase/GameTracking-Deadlock.git"
VDATA_SUBDIR="game/citadel/pak01_dir/scripts"
VDATA_FILES=(abilities.vdata heroes.vdata)
# Item display names live in the localization tree, not the scripts dir.
LOC_SUBDIR="game/citadel/resource/localization/citadel_gc_mod_names"
LOC_FILES=(citadel_gc_mod_names_english.txt)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
VDATA_DIR="$SCRIPT_DIR/.vdata"

DEADLOCK_REF="${DEADLOCK_REF:-}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

need_cmd git
need_cmd bun

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
REPO_DIR="$TMP_DIR/deadlock"

clone_repo() {
  echo "Cloning GameTracking-Deadlock${DEADLOCK_REF:+ @ $DEADLOCK_REF}..."
  if git clone --filter=blob:none --no-checkout "$REPO_URL" "$REPO_DIR" >/dev/null 2>&1; then
    :
  else
    git clone --no-checkout "$REPO_URL" "$REPO_DIR"
  fi

  cd "$REPO_DIR"
  git sparse-checkout init --cone >/dev/null 2>&1 || true
  git sparse-checkout set "$VDATA_SUBDIR" "$LOC_SUBDIR" >/dev/null 2>&1 || true

  if [[ -n "$DEADLOCK_REF" ]]; then
    git checkout -f "$DEADLOCK_REF" >/dev/null 2>&1 || die "Failed to checkout DEADLOCK_REF=$DEADLOCK_REF"
  else
    git checkout -f >/dev/null 2>&1 || die "Failed to checkout repo"
  fi
}

copy_vdata() {
  mkdir -p "$VDATA_DIR"
  for file in "${VDATA_FILES[@]}"; do
    local src="$REPO_DIR/$VDATA_SUBDIR/$file"
    [[ -f "$src" ]] || die "Missing vdata file upstream: $src"
    cp -f "$src" "$VDATA_DIR/"
    echo "  copied $file"
  done
  for file in "${LOC_FILES[@]}"; do
    local src="$REPO_DIR/$LOC_SUBDIR/$file"
    [[ -f "$src" ]] || die "Missing localization file upstream: $src"
    cp -f "$src" "$VDATA_DIR/"
    echo "  copied $file"
  done
}

generate() {
  cd "$ROOT_DIR"
  echo "Generating manifests..."
  VDATA_DIR="$VDATA_DIR" bun run scripts/build-item-manifest.ts
  VDATA_DIR="$VDATA_DIR" bun run scripts/build-item-names.ts
  VDATA_DIR="$VDATA_DIR" bun run scripts/build-item-stats.ts
  VDATA_DIR="$VDATA_DIR" bun run scripts/build-hero-portraits.ts
  VDATA_DIR="$VDATA_DIR" bun run scripts/build-ability-icons.ts
}

main() {
  clone_repo
  copy_vdata
  generate
  cat <<'EOF'

Done. Regenerated src/data/item-icons.json, src/data/item-names.json,
src/data/item-stats.json, src/data/hero-portraits.json and
src/data/ability-icons.json.

Follow-up steps (these can't be pulled from GameTracking):
  - Images: re-export the panorama image tree with Source 2 Viewer on the
    Deadlock machine at the same game build into panorama/, then run
    `bun run images` to optimize the referenced subset into public/ as WebP.
  - Display names: bump the `boon` crate (its sync-name-tables.sh owns the
    hero/ability id->name tables), then `bun run wasm`.
  - Modifiers: verify the stat-type ids in wasm/src/lib.rs against a schema
    dump — see scripts/README.md and scripts/check-modifier-values.ts.
EOF
}

main "$@"
