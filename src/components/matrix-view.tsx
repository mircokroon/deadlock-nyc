import * as React from "react";
import { ArrowLeftRight, Grid3x3 } from "lucide-react";

import {
  compactNumber,
  heroPortraitUrl,
  TEAM_COLORS,
  TEAM_NAMES,
  type PlayerInfo,
} from "@/components/player-roster";
import { cn } from "@/lib/utils";
import type { MatchSummary } from "@/wasm/boon";

// Heroes are laid out team 3 then team 2 (matching the Timeline view).
const TEAM_ORDER = [3, 2];

// Fixed grid tracks (px) outside the flexible damage cells: the left portrait
// column and the right per-row total column. The cell columns/rows take the
// remaining space as 1fr so the grid always fills the panel.
const LABEL_COL = 36;
const TOTAL_COL = 44;

// Damage heat: transparent → red, sqrt-scaled so small numbers stay visible.
function heat(v: number, max: number): string {
  if (v <= 0 || max <= 0) return "transparent";
  const t = Math.min(1, Math.sqrt(v / max));
  return `rgba(239, 68, 68, ${(0.06 + t * 0.74).toFixed(3)})`;
}

/** Hero-vs-hero damage grid from the post-match damage matrix. Only the
 * cross-team block is shown at once (intra-team has no friendly fire): rows are
 * the attacking team, columns the team they damaged. The flip button swaps
 * which team attacks. */
export function MatrixView({
  players,
  summary,
}: {
  players: PlayerInfo[];
  summary: MatchSummary;
}) {
  const [flipped, setFlipped] = React.useState(false);

  const { get, dealtToTeam, takenFromTeam, max } = React.useMemo(() => {
    const lut = new Map<string, number>();
    let hi = 0;
    for (const d of summary.damage_matrix) {
      lut.set(`${d.dealer_hero}:${d.target_hero}`, d.damage);
      if (d.dealer_hero !== d.target_hero && d.damage > hi) hi = d.damage;
    }
    return {
      get: (dealer: number, target: number) =>
        lut.get(`${dealer}:${target}`) ?? 0,
      // Damage a dealer did to a whole set of targets.
      dealtToTeam: (dealer: number, targets: PlayerInfo[]) =>
        targets.reduce((s, t) => s + (lut.get(`${dealer}:${t.hero_id}`) ?? 0), 0),
      // Damage a target took from a whole set of dealers.
      takenFromTeam: (target: number, dealers: PlayerInfo[]) =>
        dealers.reduce((s, d) => s + (lut.get(`${d.hero_id}:${target}`) ?? 0), 0),
      max: hi,
    };
  }, [summary]);

  const attackTeam = flipped ? TEAM_ORDER[1] : TEAM_ORDER[0];
  const victimTeam = flipped ? TEAM_ORDER[0] : TEAM_ORDER[1];

  const attackers = React.useMemo(
    () => players.filter((p) => p.team === attackTeam),
    [players, attackTeam],
  );
  const victims = React.useMemo(
    () => players.filter((p) => p.team === victimTeam),
    [players, victimTeam],
  );

  const [hover, setHover] = React.useState<{ d: number; t: number } | null>(
    null,
  );

  const hasData =
    summary.damage_matrix.length > 0 &&
    attackers.length > 0 &&
    victims.length > 0;
  if (!hasData) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <Grid3x3 className="size-10 opacity-40" aria-hidden />
        <p className="text-sm">No damage matrix in this demo.</p>
        <p className="max-w-xs text-xs">
          The matrix reads the demo's end-of-match details, which incomplete
          recordings don't contain.
        </p>
      </div>
    );
  }

  const attackColor = TEAM_COLORS[attackTeam] ?? "#888";
  const victimColor = TEAM_COLORS[victimTeam] ?? "#888";
  const attackName = TEAM_NAMES[attackTeam] ?? `Team ${attackTeam}`;
  const victimName = TEAM_NAMES[victimTeam] ?? `Team ${victimTeam}`;

  const hoverDealer = hover && attackers.find((p) => p.hero_id === hover.d);
  const hoverTarget = hover && victims.find((p) => p.hero_id === hover.t);

  const headerPortrait = (p: PlayerInfo, axis: "row" | "col") => {
    const url = heroPortraitUrl(p.hero_id);
    const lit =
      hover != null &&
      (axis === "row" ? hover.d === p.hero_id : hover.t === p.hero_id);
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center p-0.5 transition-opacity",
          hover != null && !lit && "opacity-50",
        )}
        title={p.hero_name}
      >
        <span
          className="overflow-hidden rounded"
          style={{ boxShadow: `0 0 0 1.5px ${TEAM_COLORS[p.team] ?? "#888"}` }}
        >
          {url ? (
            <img src={url} alt={p.hero_name} className="size-7 object-cover" />
          ) : (
            <span className="block size-7 bg-muted" />
          )}
        </span>
      </div>
    );
  };

  const m = victims.length;
  const rows = attackers.length;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      {/* Header: matchup + flip button, with a hover readout in the middle. */}
      <div className="flex flex-shrink-0 items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium" style={{ color: attackColor }}>
            {attackName}
          </span>
          <ArrowLeftRight className="size-3 text-muted-foreground" aria-hidden />
          <span className="font-medium" style={{ color: victimColor }}>
            {victimName}
          </span>
        </div>

        <div className="flex h-5 min-w-0 flex-1 items-center text-xs text-muted-foreground">
          {hoverDealer && hoverTarget ? (
            <span className="flex items-center gap-1.5 truncate">
              <span className="font-medium text-foreground">
                {hoverDealer.hero_name}
              </span>
              <span aria-hidden>→</span>
              <span className="font-medium text-foreground">
                {hoverTarget.hero_name}
              </span>
              <span className="tabular-nums">
                {compactNumber(get(hoverDealer.hero_id, hoverTarget.hero_id))}{" "}
                damage
              </span>
            </span>
          ) : (
            <span className="truncate">Rows attack, columns receive.</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          title="Swap attacking and receiving teams"
        >
          <ArrowLeftRight className="size-3.5" aria-hidden />
          Flip
        </button>
      </div>

      {/* Grid — fills the panel: cell rows/cols are 1fr so they stretch to fit
          both axes (no scroll, no wasted margins), and the browser reflows it
          on resize natively. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card p-2">
        <div
          className="grid h-full w-full select-none gap-px text-[10px]"
          style={{
            gridTemplateColumns: `${LABEL_COL}px repeat(${m}, minmax(0, 1fr)) ${TOTAL_COL}px`,
            gridTemplateRows: `auto repeat(${rows}, minmax(0, 1fr)) auto`,
          }}
          onPointerLeave={() => setHover(null)}
        >
          {/* Header row: corner + victim portraits + Dealt label. */}
          <div />
          {victims.map((p) => (
            <div key={`h-${p.hero_id}`}>{headerPortrait(p, "col")}</div>
          ))}
          <div className="flex items-center justify-center text-[10px] font-medium text-muted-foreground">
            Dealt
          </div>

          {/* Attacker rows. */}
          {attackers.map((dealer) => (
            <React.Fragment key={`r-${dealer.hero_id}`}>
              <div>{headerPortrait(dealer, "row")}</div>
              {victims.map((target) => {
                const v = get(dealer.hero_id, target.hero_id);
                const lit =
                  hover != null &&
                  hover.d === dealer.hero_id &&
                  hover.t === target.hero_id;
                const onAxis =
                  hover != null &&
                  (hover.d === dealer.hero_id || hover.t === target.hero_id);
                return (
                  <div
                    key={`c-${dealer.hero_id}-${target.hero_id}`}
                    onPointerEnter={() =>
                      setHover({ d: dealer.hero_id, t: target.hero_id })
                    }
                    className={cn(
                      "flex min-w-0 items-center justify-center tabular-nums text-foreground/90 transition-[box-shadow]",
                      hover != null && !onAxis && "opacity-60",
                      lit && "ring-1 ring-inset ring-foreground/60",
                    )}
                    style={{ backgroundColor: heat(v, max) }}
                  >
                    {v > 0 ? compactNumber(v) : ""}
                  </div>
                );
              })}
              {/* Row total: damage this attacker dealt to the victim team. */}
              <div className="flex items-center justify-center font-medium tabular-nums text-muted-foreground">
                {compactNumber(dealtToTeam(dealer.hero_id, victims))}
              </div>
            </React.Fragment>
          ))}

          {/* Footer row: Taken totals (damage each victim received). */}
          <div className="flex items-center justify-center text-[10px] font-medium text-muted-foreground">
            Taken
          </div>
          {victims.map((p) => (
            <div
              key={`t-${p.hero_id}`}
              className="flex items-center justify-center font-medium tabular-nums text-muted-foreground"
            >
              {compactNumber(takenFromTeam(p.hero_id, attackers))}
            </div>
          ))}
          <div />
        </div>
      </div>
    </div>
  );
}
