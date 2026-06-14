import * as React from "react";
import { LineChart, User, Users } from "lucide-react";

import {
  compactNumber,
  heroPortraitUrl,
  TEAM_COLORS,
  TEAM_NAMES,
  type PlayerInfo,
} from "@/components/player-roster";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MatchSummary, SnapshotStat } from "@/wasm/boon";

type Mode = "team" | "player";
type LineMetricKey = "net_worth" | "player_damage" | "player_healing";

// Per-snapshot scalar metrics — comparable across players, so they sum to a
// team total (Team mode) or stand alone for one hero (Player mode).
const LINE_METRICS: {
  key: LineMetricKey;
  label: string;
  value: (s: SnapshotStat) => number;
}[] = [
  { key: "net_worth", label: "Souls", value: (s) => s.net_worth },
  { key: "player_damage", label: "Damage", value: (s) => s.player_damage },
  { key: "player_healing", label: "Healing", value: (s) => s.player_healing },
];

// Souls-by-source bands (Player mode), stacked bottom → top.
const SOUL_SOURCES: { key: keyof SnapshotStat; label: string; color: string }[] = [
  { key: "souls_lane", label: "Lane creeps", color: "#60a5fa" },
  { key: "souls_neutral", label: "Neutrals", color: "#34d399" },
  { key: "souls_players", label: "Players", color: "#f87171" },
  { key: "souls_boss", label: "Bosses", color: "#fbbf24" },
  { key: "souls_denies", label: "Denies", color: "#94a3b8" },
  { key: "souls_assists", label: "Assists", color: "#f472b6" },
  { key: "souls_treasure", label: "Treasure", color: "#c084fc" },
  { key: "souls_team_bonus", label: "Team bonus", color: "#2dd4bf" },
  { key: "souls_other", label: "Other", color: "#64748b" },
];

// Damage-by-source coarse categories (Player mode), stacked bottom → top.
// `damage_by_source` keys bands by Valve's category source_name; map the common
// ones to friendly labels/colors and fall back for anything else.
const DAMAGE_CATEGORIES: Record<string, { label: string; color: string }> = {
  Bullet: { label: "Weapon", color: "#fbbf24" },
  Ability: { label: "Ability", color: "#a78bfa" },
  Melee: { label: "Melee", color: "#f87171" },
  Misc: { label: "Misc", color: "#34d399" },
  UnknownAbility: { label: "Unknown", color: "#94a3b8" },
};
const DAMAGE_FALLBACK_COLORS = ["#60a5fa", "#f472b6", "#2dd4bf", "#c084fc", "#64748b"];
function damageBand(source: string, idx: number): { label: string; color: string } {
  return (
    DAMAGE_CATEGORIES[source] ?? {
      label: source,
      color: DAMAGE_FALLBACK_COLORS[idx % DAMAGE_FALLBACK_COLORS.length],
    }
  );
}

// The single-hero stacked breakdowns (vs the multi-select line metrics).
const BREAKDOWN_METRICS: { key: string; label: string }[] = [
  { key: "souls_source", label: "Soul Breakdown" },
  { key: "damage_source", label: "Damage by Source" },
];
const isBreakdown = (key: string) =>
  BREAKDOWN_METRICS.some((m) => m.key === key);

// Portrait-marker radius (px) for the single-hero line; team lines use dots.
const PT_R = 12;
const DOT_R = 4;

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function niceTimeStep(span: number): number {
  for (const m of [1, 2, 5, 10, 15, 20]) if (span / (m * 60) <= 7) return m * 60;
  return 30 * 60;
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 1 };
  const rough = v / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  return { max: Math.ceil(v / step) * step || step, step };
}

type LineSeries = {
  label: string;
  color: string;
  team: number;
  heroId?: number;
  points: { t: number; v: number }[];
};
type StackedPoint = { t: number; segs: { y0: number; y1: number }[]; total: number };
// One stacked-area band (a soul source or a damage category).
type StackBand = { key: string; label: string; color: string };
// One row in the hover readout. `heroId` (line series) drives the portrait swatch.
type HoverRow = { label: string; color: string; v: number; heroId?: number };
type Chart =
  | { kind: "lines"; series: LineSeries[]; marker: "portrait" | "dot"; times: number[] }
  | {
      kind: "stacked";
      stacked: StackedPoint[];
      bands: StackBand[];
      color: string;
      heroName: string;
      heroId: number;
      times: number[];
    }
  | { kind: "noHero"; message?: string }
  | null;

export function TimelineView({
  players,
  summary,
}: {
  players: PlayerInfo[];
  summary: MatchSummary;
}) {
  const [mode, setMode] = React.useState<Mode>("team");
  const [metricKey, setMetricKey] = React.useState<string>("net_worth");
  // Player mode is multi-select for the line metrics; the souls-by-source
  // breakdown uses the first selected hero (a composition is one hero at a time).
  const [selected, setSelected] = React.useState<Set<number>>(
    () => new Set(players[0] ? [players[0].hero_id] : []),
  );
  React.useEffect(() => {
    setSelected((prev) => {
      const valid = [...prev].filter((id) => players.some((p) => p.hero_id === id));
      if (valid.length === prev.size) return prev;
      return new Set(valid.length ? valid : players[0] ? [players[0].hero_id] : []);
    });
  }, [players]);
  const toggleHero = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const teamByHero = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const p of players) m.set(p.hero_id, p.team);
    return m;
  }, [players]);
  const snapshots = summary.snapshots;
  // Snapshot clock — the x-domain for the line metrics + souls breakdown.
  const snapTimes = React.useMemo(() => {
    const set = new Set<number>();
    for (const s of snapshots) set.add(s.time_s);
    return [...set].sort((a, b) => a - b);
  }, [snapshots]);

  const hasData = snapshots.length > 0;

  const teams = [3, 2].filter((t) => players.some((p) => p.team === t));

  const chart = React.useMemo<Chart>(() => {
    if (!hasData) return null;
    if (mode === "team") {
      const m =
        LINE_METRICS.find((x) => x.key === metricKey) ?? LINE_METRICS[0];
      const series: LineSeries[] = teams.map((team) => {
        const sums = new Map<number, number>();
        for (const s of snapshots) {
          if (teamByHero.get(s.hero_id) !== team) continue;
          sums.set(s.time_s, (sums.get(s.time_s) ?? 0) + m.value(s));
        }
        return {
          label: TEAM_NAMES[team] ?? `Team ${team}`,
          color: TEAM_COLORS[team] ?? "#888",
          team,
          points: snapTimes.map((t) => ({ t, v: sums.get(t) ?? 0 })),
        };
      });
      return { kind: "lines", series, marker: "dot", times: snapTimes };
    }
    const heroes = players.filter((p) => selected.has(p.hero_id));
    if (heroes.length === 0) return { kind: "noHero" };
    const snapsFor = (id: number) =>
      snapshots.filter((s) => s.hero_id === id).sort((a, b) => a.time_s - b.time_s);

    if (metricKey === "souls_source") {
      const hero = heroes[0]; // composition is one hero at a time
      const bands: StackBand[] = SOUL_SOURCES.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.color,
      }));
      const stacked: StackedPoint[] = snapsFor(hero.hero_id).map((s) => {
        let acc = 0;
        const segs = SOUL_SOURCES.map((src) => {
          const y0 = acc;
          acc += s[src.key];
          return { y0, y1: acc };
        });
        return { t: s.time_s, segs, total: acc };
      });
      return {
        kind: "stacked",
        stacked,
        bands,
        color: TEAM_COLORS[hero.team] ?? "#888",
        heroName: hero.hero_name,
        heroId: hero.hero_id,
        times: stacked.map((p) => p.t),
      };
    }

    if (metricKey === "damage_source") {
      const hero = heroes[0];
      const times = summary.damage_sample_times;
      // The dealer hero's per-category cumulative series; biggest contributor
      // at the bottom of the stack.
      const heroSeries = summary.damage_by_source
        .filter((d) => d.hero_id === hero.hero_id)
        .sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
      if (heroSeries.length === 0 || times.length === 0)
        return { kind: "noHero", message: "No damage breakdown for this hero." };
      const bands: StackBand[] = heroSeries.map((d, i) => ({
        key: d.source,
        ...damageBand(d.source, i),
      }));
      const stacked: StackedPoint[] = times.map((t, i) => {
        let acc = 0;
        const segs = heroSeries.map((d) => {
          const y0 = acc;
          acc += d.values[i] ?? 0;
          return { y0, y1: acc };
        });
        return { t, segs, total: acc };
      });
      return {
        kind: "stacked",
        stacked,
        bands,
        color: TEAM_COLORS[hero.team] ?? "#888",
        heroName: hero.hero_name,
        heroId: hero.hero_id,
        times,
      };
    }

    const m = LINE_METRICS.find((x) => x.key === metricKey) ?? LINE_METRICS[0];
    const series: LineSeries[] = heroes.map((p) => ({
      label: p.hero_name,
      color: TEAM_COLORS[p.team] ?? "#888",
      team: p.team,
      heroId: p.hero_id,
      points: snapsFor(p.hero_id).map((s) => ({ t: s.time_s, v: m.value(s) })),
    }));
    return { kind: "lines", series, marker: "portrait", times: snapTimes };
  }, [hasData, mode, metricKey, selected, snapshots, snapTimes, players, teamByHero, teams, summary]);

  // The active chart's x-domain. Line metrics + souls live on the snapshot
  // clock; damage-by-source has its own sample times. Fall back to snapshots.
  const domainTimes = React.useMemo(() => {
    const ts = chart && chart.kind !== "noHero" ? chart.times : snapTimes;
    return ts.length ? [...new Set(ts)].sort((a, b) => a - b) : snapTimes;
  }, [chart, snapTimes]);
  const tMin = domainTimes[0] ?? 0;
  const tMax = domainTimes[domainTimes.length - 1] ?? 0;

  const yMax = React.useMemo(() => {
    let hi = 0;
    if (chart?.kind === "lines") {
      for (const s of chart.series)
        for (const p of s.points) if (p.v > hi) hi = p.v;
    } else if (chart?.kind === "stacked") {
      for (const st of chart.stacked) if (st.total > hi) hi = st.total;
    }
    return hi;
  }, [chart]);

  // Measure the plot box for crisp pixel-space drawing.
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const plotRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [hoverT, setHoverT] = React.useState<number | null>(null);

  const M = { l: 52, r: 14, t: 10, b: 22 };
  const plotW = Math.max(0, box.w - M.l - M.r);
  const plotH = Math.max(0, box.h - M.t - M.b);
  const xSpan = Math.max(1, tMax - tMin);
  const { max: yTop, step: yStep } = niceMax(yMax);
  const px = (t: number) => M.l + ((t - tMin) / xSpan) * plotW;
  const py = (v: number) => M.t + (1 - v / yTop) * plotH;

  const xTicks: number[] = [];
  const xStep = niceTimeStep(xSpan);
  for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) xTicks.push(t);
  const yTicks: number[] = [];
  for (let v = 0; v <= yTop + 1e-6; v += yStep) yTicks.push(v);

  // Heavy chart body (lines/areas + markers), memoized so hover stays smooth.
  const body = React.useMemo(() => {
    if (!chart || chart.kind === "noHero") return null;
    if (chart.kind === "stacked") {
      const stacked = chart.stacked;
      return chart.bands.map((band, i) => {
        if (stacked.length === 0) return null;
        let d = "M" + `${px(stacked[0].t).toFixed(1)} ${py(stacked[0].segs[i].y1).toFixed(1)}`;
        for (let k = 1; k < stacked.length; k++)
          d += ` L${px(stacked[k].t).toFixed(1)} ${py(stacked[k].segs[i].y1).toFixed(1)}`;
        for (let k = stacked.length - 1; k >= 0; k--)
          d += ` L${px(stacked[k].t).toFixed(1)} ${py(stacked[k].segs[i].y0).toFixed(1)}`;
        d += " Z";
        return (
          <path
            key={band.key}
            d={d}
            fill={band.color}
            fillOpacity={0.8}
            stroke={band.color}
            strokeWidth={0.5}
          />
        );
      });
    }
    const lines: React.ReactNode[] = [];
    const marks: React.ReactNode[] = [];
    for (const s of chart.series) {
      if (s.points.length === 0) continue;
      const d = s.points
        .map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)} ${py(p.v).toFixed(1)}`)
        .join(" ");
      lines.push(
        <path
          key={`l-${s.team}-${s.heroId ?? "t"}`}
          d={d}
          fill="none"
          stroke={s.color}
          strokeWidth={2.25}
          strokeOpacity={0.85}
          strokeLinejoin="round"
        />,
      );
      const portrait =
        chart.marker === "portrait" && s.heroId != null
          ? heroPortraitUrl(s.heroId)
          : null;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        marks.push(
          <g
            key={`m-${s.team}-${s.heroId ?? "t"}-${i}`}
            transform={`translate(${px(p.t).toFixed(1)} ${py(p.v).toFixed(1)})`}
          >
            {portrait ? (
              <image
                href={portrait}
                x={-PT_R}
                y={-PT_R}
                width={PT_R * 2}
                height={PT_R * 2}
                clipPath="url(#timeline-pt-clip)"
                preserveAspectRatio="xMidYMid slice"
              />
            ) : (
              <circle r={DOT_R} fill={s.color} />
            )}
            <circle
              r={portrait ? PT_R : DOT_R}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
            />
          </g>,
        );
      }
    }
    return [...lines, ...marks];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, box.w, box.h, tMin, tMax, yTop]);

  const onMove = (e: React.PointerEvent) => {
    const el = plotRef.current;
    if (!el || !hasData || domainTimes.length === 0) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left - M.l) / (plotW || 1)));
    const t = tMin + frac * xSpan;
    let best = domainTimes[0];
    for (const st of domainTimes)
      if (Math.abs(st - t) < Math.abs(best - t)) best = st;
    setHoverT(best);
  };

  // Hover readout: per-series (lines) or per-source (stacked) value at hoverT.
  const hoverRows = React.useMemo(() => {
    if (hoverT == null || !chart) return [];
    if (chart.kind === "lines") {
      return chart.series
        .map((s) => {
          if (s.points.length === 0) return null;
          let best = s.points[0];
          for (const p of s.points)
            if (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
          return { label: s.label, color: s.color, v: best.v, heroId: s.heroId };
        })
        .filter((r): r is NonNullable<typeof r> => r != null)
        .sort((a, b) => b.v - a.v);
    }
    if (chart.kind === "stacked" && chart.stacked.length) {
      let best = chart.stacked[0];
      for (const st of chart.stacked)
        if (Math.abs(st.t - hoverT) < Math.abs(best.t - hoverT)) best = st;
      return chart.bands
        .map((band, i) => ({
          label: band.label,
          color: band.color,
          v: best.segs[i].y1 - best.segs[i].y0,
        }))
        .sort((a, b) => b.v - a.v) as HoverRow[];
    }
    return [];
  }, [hoverT, chart]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      {/* Controls. */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <Tabs
          value={mode}
          onValueChange={(v) => {
            const next = v as Mode;
            setMode(next);
            if (next === "team" && isBreakdown(metricKey))
              setMetricKey("net_worth");
          }}
        >
          <TabsList className="h-7">
            <TabsTrigger value="team" className="gap-1 px-2 text-xs">
              <Users className="size-3.5" aria-hidden />
              Team
            </TabsTrigger>
            <TabsTrigger value="player" className="gap-1 px-2 text-xs">
              <User className="size-3.5" aria-hidden />
              Player
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Tabs
          value={metricKey}
          onValueChange={(v) => {
            setMetricKey(v);
            // The breakdowns are single-player compositions: collapse a
            // multi-selection down to the first selected hero.
            if (isBreakdown(v))
              setSelected((prev) => {
                if (prev.size <= 1) return prev;
                const first = players.find((p) => prev.has(p.hero_id));
                return new Set(first ? [first.hero_id] : []);
              });
          }}
        >
          <TabsList className="h-7">
            {LINE_METRICS.map((m) => (
              <TabsTrigger key={m.key} value={m.key} className="px-2 text-xs">
                {m.label}
              </TabsTrigger>
            ))}
            {BREAKDOWN_METRICS.map((m) =>
              mode === "player" ? (
                <TabsTrigger key={m.key} value={m.key} className="px-2 text-xs">
                  {m.label}
                </TabsTrigger>
              ) : (
                // Always shown, but a single-player view — disabled in Team mode.
                <Tooltip key={m.key}>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="inline-flex">
                      <TabsTrigger
                        value={m.key}
                        disabled
                        className="px-2 text-xs"
                      >
                        {m.label}
                      </TabsTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Must select a player view</TooltipContent>
                </Tooltip>
              ),
            )}
          </TabsList>
        </Tabs>

        {mode === "player" && (
          // All heroes on one line, grouped by team, each group capped by its
          // team selector (a whole-team toggle for the multi-select metrics).
          <div className="ml-auto flex items-end gap-4">
            {teams.map((team) => {
              const teamPlayers = players.filter((p) => p.team === team);
              const single = isBreakdown(metricKey);
              const allOn = teamPlayers.every((p) => selected.has(p.hero_id));
              return (
                <div key={team} className="flex flex-col items-center gap-1">
                  {single ? (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: TEAM_COLORS[team] }}
                      />
                      {TEAM_NAMES[team]}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((prev) => {
                          const n = new Set(prev);
                          for (const p of teamPlayers)
                            allOn ? n.delete(p.hero_id) : n.add(p.hero_id);
                          return n;
                        })
                      }
                      className={cn(
                        "flex items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-colors hover:bg-accent/40",
                        allOn ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: TEAM_COLORS[team] }}
                      />
                      {TEAM_NAMES[team]}
                    </button>
                  )}
                  <div className="flex items-center gap-1">
                    {teamPlayers.map((p) => {
                      const on = selected.has(p.hero_id);
                      const portrait = heroPortraitUrl(p.hero_id);
                      return (
                        <Tooltip key={p.hero_id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() =>
                                single
                                  ? setSelected(new Set([p.hero_id]))
                                  : toggleHero(p.hero_id)
                              }
                              aria-label={p.hero_name}
                              aria-pressed={on}
                              className={cn(
                                "overflow-hidden rounded transition-opacity",
                                on ? "opacity-100" : "opacity-40 hover:opacity-80",
                              )}
                              style={
                                on
                                  ? { boxShadow: `0 0 0 2px ${TEAM_COLORS[p.team]}` }
                                  : undefined
                              }
                            >
                              {portrait ? (
                                <img
                                  src={portrait}
                                  alt={p.hero_name}
                                  className="size-8 object-cover"
                                />
                              ) : (
                                <div className="size-8 bg-muted" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{p.hero_name}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chart. */}
      <div
        ref={plotRef}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverT(null)}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card"
      >
        {hasData && chart?.kind !== "noHero" ? (
          <>
            <svg width={box.w} height={box.h} className="absolute inset-0">
              <defs>
                <clipPath id="timeline-pt-clip" clipPathUnits="userSpaceOnUse">
                  <circle cx={0} cy={0} r={PT_R} />
                </clipPath>
              </defs>
              {yTicks.map((v) => (
                <g key={`y-${v}`}>
                  <line
                    x1={M.l}
                    y1={py(v)}
                    x2={M.l + plotW}
                    y2={py(v)}
                    className="stroke-current text-border"
                    strokeWidth={1}
                  />
                  <text
                    x={M.l - 6}
                    y={py(v)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-current text-[10px] text-muted-foreground"
                  >
                    {compactNumber(v)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <g key={`x-${t}`}>
                  <line
                    x1={px(t)}
                    y1={M.t}
                    x2={px(t)}
                    y2={M.t + plotH}
                    className="stroke-current text-border/40"
                    strokeWidth={1}
                  />
                  <text
                    x={px(t)}
                    y={box.h - 6}
                    textAnchor="middle"
                    className="fill-current text-[10px] text-muted-foreground"
                  >
                    {clock(t)}
                  </text>
                </g>
              ))}
              {body}
              {hoverT != null && (
                <line
                  x1={px(hoverT)}
                  y1={M.t}
                  x2={px(hoverT)}
                  y2={M.t + plotH}
                  className="stroke-current text-foreground/40"
                  strokeWidth={1}
                />
              )}
            </svg>

            {hoverT != null && hoverRows.length > 0 && (
              <div
                className="pointer-events-none absolute top-2 z-10 w-40 rounded-md border border-border bg-background/90 p-1.5 text-[11px] shadow backdrop-blur"
                style={{ left: Math.min(box.w - 164, Math.max(4, px(hoverT) + 8)) }}
              >
                {/* Stacked souls-by-source: name the hero (the legend is gone). */}
                {chart?.kind === "stacked" &&
                  (() => {
                    const portrait = heroPortraitUrl(chart.heroId);
                    return (
                      <div className="mb-1 flex items-center gap-1.5 border-b border-border pb-1">
                        {portrait ? (
                          <img
                            src={portrait}
                            alt=""
                            className="size-5 flex-shrink-0 rounded-full object-cover"
                            style={{ boxShadow: `0 0 0 1.5px ${chart.color}` }}
                          />
                        ) : null}
                        <span className="truncate font-medium">
                          {chart.heroName}
                        </span>
                      </div>
                    );
                  })()}
                <div className="mb-1 tabular-nums text-muted-foreground">
                  {clock(hoverT)}
                </div>
                <div className="flex flex-col gap-0.5">
                  {hoverRows.map((r) => {
                    const portrait =
                      r.heroId != null ? heroPortraitUrl(r.heroId) : null;
                    return (
                      <div
                        key={r.label}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          {portrait ? (
                            <img
                              src={portrait}
                              alt=""
                              className="size-4 flex-shrink-0 rounded-full object-cover"
                              style={{ boxShadow: `0 0 0 1.5px ${r.color}` }}
                            />
                          ) : (
                            <span
                              className="size-2 flex-shrink-0 rounded-full"
                              style={{ backgroundColor: r.color }}
                            />
                          )}
                          <span className="truncate">{r.label}</span>
                        </span>
                        <span className="flex-shrink-0 tabular-nums">
                          {compactNumber(r.v)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : chart?.kind === "noHero" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {chart.message ?? "Select a hero above."}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <LineChart className="size-10 opacity-40" aria-hidden />
            <p className="text-sm">No post-match summary in this demo.</p>
            <p className="max-w-xs text-xs">
              The timeline reads the demo's end-of-match details, which incomplete
              recordings don't contain.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
