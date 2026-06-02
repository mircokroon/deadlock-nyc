import * as React from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  FileUp,
  Info,
  Loader2,
  Pause,
  Play,
} from "lucide-react";

import { DemoInfoDialog } from "@/components/demo-info-dialog";
import { EventLog } from "@/components/event-log";
import {
  MapView,
  type AbilityEvent,
  type AbilitySlot,
  type AbilityUpgradeEvent,
  type ChatEvent,
  type HeroAbilities,
  type ItemEvent,
  type KillEvent,
  type KillMarker,
  type CampStateEvent,
  type NeutralCamp,
  type NeutralCampState,
  type ObjectiveEvent,
  type ObjectiveHealthEvent,
  type ObjectiveInfo,
  type ObjectiveMarker,
  type ObjectiveState,
  type PauseInterval,
  type PlayerPosition,
  type PositionFrame,
} from "@/components/map-view";
import { PlaybackConfig } from "@/components/playback-config";
import { PlayerDetail } from "@/components/player-detail";
import {
  PlayerRoster,
  TEAM_COLORS,
  type HeroItems,
  type PlayerInfo,
} from "@/components/player-roster";
import { Timeline } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { parseDemo } from "@/wasm/boon";

const SAMPLE_EVERY_TICKS = 8;
const TICKS_PER_SECOND = 64;
const KILL_MARKER_TICKS = 10 * TICKS_PER_SECOND; // 10 seconds at 64 t/s = 640
// Skip-back / skip-forward step for the ± buttons flanking play (10s at 64 t/s).
const STEP_TICKS = 640;
// Objectives are rare and significant, so their map markers linger longer.
const OBJECTIVE_MARKER_TICKS = 20 * TICKS_PER_SECOND;
// Gold accent for neutral objectives (Mid-Boss) with no owning team.
const NEUTRAL_OBJECTIVE_COLOR = "#c9a227";

type State =
  | { kind: "idle" }
  | {
      kind: "parsing";
      name: string;
      progress?: { tick: number; total: number };
    }
  | {
      kind: "done";
      name: string;
      header: unknown;
      frames: PositionFrame[];
      itemEvents: ItemEvent[];
      killEvents: KillEvent[];
      abilityEvents: AbilityEvent[];
      abilitySlots: HeroAbilities[];
      abilityUpgradeEvents: AbilityUpgradeEvent[];
      objectiveEvents: ObjectiveEvent[];
      objectives: ObjectiveInfo[];
      objectiveHealth: ObjectiveHealthEvent[];
      neutralCamps: NeutralCamp[];
      campStateEvents: CampStateEvent[];
      chatEvents: ChatEvent[];
      pauseIntervals: PauseInterval[];
      regulationTicks: number | null;
      players: PlayerInfo[];
      winner: number | null;
    }
  | { kind: "error"; message: string };

export function UploadZone() {
  const [state, setState] = React.useState<State>({ kind: "idle" });

  async function handleFile(file: File) {
    setState({ kind: "parsing", name: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseDemo(bytes, SAMPLE_EVERY_TICKS, (tick, total) => {
        setState((s) =>
          s.kind === "parsing"
            ? { kind: "parsing", name: s.name, progress: { tick, total } }
            : s,
        );
      });
      setState({
        kind: "done",
        name: file.name,
        header: parsed.header,
        frames: parsed.positions.frames,
        itemEvents: parsed.positions.item_events,
        killEvents: parsed.positions.kill_events,
        abilityEvents: parsed.positions.ability_events,
        abilitySlots: parsed.positions.ability_slots,
        abilityUpgradeEvents: parsed.positions.ability_upgrade_events,
        objectiveEvents: parsed.positions.objective_events,
        objectives: parsed.positions.objectives,
        objectiveHealth: parsed.positions.objective_health,
        neutralCamps: parsed.positions.neutral_camps,
        campStateEvents: parsed.positions.camp_state_events,
        chatEvents: parsed.positions.chat_events,
        pauseIntervals: parsed.positions.pause_intervals,
        regulationTicks: parsed.positions.regulation_ticks,
        players: parsed.players,
        winner: parsed.winner,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (state.kind === "done") {
    return (
      <DemoView
        name={state.name}
        frames={state.frames}
        itemEvents={state.itemEvents}
        killEvents={state.killEvents}
        abilityEvents={state.abilityEvents}
        abilitySlots={state.abilitySlots}
        abilityUpgradeEvents={state.abilityUpgradeEvents}
        objectiveEvents={state.objectiveEvents}
        objectives={state.objectives}
        objectiveHealth={state.objectiveHealth}
        neutralCamps={state.neutralCamps}
        campStateEvents={state.campStateEvents}
        chatEvents={state.chatEvents}
        pauseIntervals={state.pauseIntervals}
        regulationTicks={state.regulationTicks}
        players={state.players}
        winner={state.winner}
      />
    );
  }

  return <IdleView state={state} onFile={handleFile} />;
}

function IdleView({
  state,
  onFile,
}: {
  state: Extract<State, { kind: "idle" | "parsing" | "error" }>;
  onFile: (f: File) => void;
}) {
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const parsing = state.kind === "parsing";
  const prog = state.kind === "parsing" ? state.progress : undefined;
  const pct =
    prog && prog.total > 0
      ? Math.min(100, (prog.tick / prog.total) * 100)
      : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-4">
      <div className="text-center">
        <h1 className="text-3xl font-medium tracking-tight">
          Deadlock demo viewer
        </h1>
        <p className="mt-2 text-muted-foreground">
          Drop a <code className="font-mono text-sm">.dem</code> file to parse it in your browser.
        </p>
      </div>

      <div className="w-full max-w-2xl">
        <div
          role="button"
          tabIndex={parsing ? -1 : 0}
          aria-disabled={parsing}
          onClick={() => !parsing && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (parsing) return;
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            if (parsing) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (parsing) return;
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) onFile(file);
          }}
          className={cn(
            "flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-card p-10 text-card-foreground transition-colors",
            parsing
              ? "cursor-progress opacity-90"
              : "cursor-pointer hover:border-primary hover:bg-accent/20",
            dragging && "border-primary bg-accent/30",
          )}
        >
          {parsing ? (
            <Loader2 className="size-10 animate-spin text-primary" />
          ) : (
            <FileUp className="size-10 text-primary" />
          )}
          <div className="w-full max-w-sm text-center">
            <p className="text-base font-medium">
              {parsing
                ? `Parsing ${state.name}…`
                : "Drop a .dem file or click to upload"}
            </p>
            {parsing ? (
              <>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary",
                      pct != null
                        ? "transition-[width] duration-200 ease-out"
                        : "w-1/3 animate-pulse",
                    )}
                    style={pct != null ? { width: `${pct}%` } : undefined}
                  />
                </div>
                <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {prog
                    ? `tick ${prog.tick.toLocaleString()}` +
                      (prog.total > 0
                        ? ` / ${prog.total.toLocaleString()}`
                        : "")
                    : "starting…"}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Parsed entirely in your browser — nothing is uploaded.
              </p>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".dem"
            className="hidden"
            disabled={parsing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {state.kind === "error" && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {state.message}
          </p>
        )}
      </div>
    </div>
  );
}

function formatClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0
    ? `${sign}${h}:${pad(m)}:${pad(sec)}`
    : `${sign}${m}:${pad(sec)}`;
}

function DemoView({
  name,
  frames,
  itemEvents,
  killEvents,
  abilityEvents,
  abilitySlots,
  abilityUpgradeEvents,
  objectiveEvents,
  objectives,
  objectiveHealth,
  neutralCamps,
  campStateEvents,
  chatEvents,
  pauseIntervals,
  regulationTicks,
  players,
  winner,
}: {
  name: string;
  frames: PositionFrame[];
  itemEvents: ItemEvent[];
  killEvents: KillEvent[];
  abilityEvents: AbilityEvent[];
  abilitySlots: HeroAbilities[];
  abilityUpgradeEvents: AbilityUpgradeEvent[];
  objectiveEvents: ObjectiveEvent[];
  objectives: ObjectiveInfo[];
  objectiveHealth: ObjectiveHealthEvent[];
  neutralCamps: NeutralCamp[];
  campStateEvents: CampStateEvent[];
  chatEvents: ChatEvent[];
  pauseIntervals: PauseInterval[];
  regulationTicks: number | null;
  players: PlayerInfo[];
  winner: number | null;
}) {
  const [index, setIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  // Configurable via the playback-settings popover.
  const [playbackSpeed, setPlaybackSpeed] = React.useState(1);
  const [stepTicks, setStepTicks] = React.useState(STEP_TICKS);
  const [selectedHeroId, setSelectedHeroId] = React.useState<number | null>(
    null,
  );
  const safeIndex = Math.min(index, Math.max(0, frames.length - 1));
  const frame = frames[safeIndex];

  const selectedPlayer =
    selectedHeroId != null
      ? players.find((p) => p.hero_id === selectedHeroId)
      : undefined;

  const statsByHero = React.useMemo(() => {
    const m = new Map<number, PlayerPosition>();
    if (frame) for (const p of frame.players) m.set(p.hero_id, p);
    return m;
  }, [frame]);

  // Replay item events up to the current tick to reconstruct each hero's
  // current inventory. Cheap — typically a few hundred events total.
  const itemsByHero = React.useMemo(() => {
    const m = new Map<number, HeroItems>();
    const tick = frame?.tick ?? 0;
    for (const e of itemEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      let cur = m.get(e.hero_id);
      if (!cur) {
        cur = { items: [] };
        m.set(e.hero_id, cur);
      }
      if (e.change === "purchased" || e.change === "upgraded") {
        if (!cur.items.some((it) => it.ability_id === e.ability_id)) {
          cur.items.push({
            ability_id: e.ability_id,
            ability_name: e.ability_name,
          });
        }
      } else if (e.change === "sold") {
        cur.items = cur.items.filter(
          (it) => it.ability_id !== e.ability_id,
        );
      }
    }
    return m;
  }, [itemEvents, frame]);

  // Each hero's signature abilities are constant for the match.
  const abilitiesByHero = React.useMemo(() => {
    const m = new Map<number, AbilitySlot[]>();
    for (const h of abilitySlots) m.set(h.hero_id, h.abilities);
    return m;
  }, [abilitySlots]);

  // Replay sparse upgrade events up to the current tick to get each ability's
  // level now (same approach as items — abilities only change a few times).
  const abilityLevelsByHero = React.useMemo(() => {
    const m = new Map<number, Map<number, number>>();
    const tick = frame?.tick ?? 0;
    for (const e of abilityUpgradeEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      let cur = m.get(e.hero_id);
      if (!cur) {
        cur = new Map();
        m.set(e.hero_id, cur);
      }
      cur.set(e.ability_id, e.level); // increasing — latest ≤ tick wins
    }
    return m;
  }, [abilityUpgradeEvents, frame]);

  const firstTick = frames[0]?.tick ?? 0;
  const lastTick = frames[frames.length - 1]?.tick ?? 0;
  const totalTicks = Math.max(0, lastTick - firstTick);
  const currentTick = frame ? frame.tick - firstTick : 0;
  const regulationClock =
    regulationTicks != null
      ? formatClock(regulationTicks / TICKS_PER_SECOND)
      : null;

  const teamByHero = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const p of players) m.set(p.hero_id, p.team);
    return m;
  }, [players]);

  // Show a kill marker at the victim's location for KILL_MARKER_TICKS
  // (10s) after each kill, colored by the victim's team.
  const killMarkers: KillMarker[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const out: KillMarker[] = [];
    for (const e of killEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      if (tick - e.tick > KILL_MARKER_TICKS) continue;
      const team = teamByHero.get(e.victim_hero_id) ?? 0;
      out.push({ x: e.x, y: e.y, color: TEAM_COLORS[team] ?? "#888" });
    }
    return out;
  }, [killEvents, frame, teamByHero]);

  // Diamond markers for recently-destroyed objectives, colored by the owning
  // (losing) team. The Mid-Boss spawn has no position, so it's feed-only.
  const objectiveMarkers: ObjectiveMarker[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const out: ObjectiveMarker[] = [];
    for (const e of objectiveEvents) {
      if (e.tick > tick) break; // events are tick-ordered
      if (tick - e.tick > OBJECTIVE_MARKER_TICKS) continue;
      if (e.x == null || e.y == null) continue;
      // The urn has a live marker (frame.urns), so skip its transient diamond.
      if (e.kind === "urn") continue;
      out.push({
        x: e.x,
        y: e.y,
        color: TEAM_COLORS[e.team] ?? NEUTRAL_OBJECTIVE_COLOR,
        kind: e.kind,
      });
    }
    return out;
  }, [objectiveEvents, frame]);

  // Reconstruct each live objective at the current tick: alive between its
  // spawn and death, with health replayed from the sparse samples (≤ tick).
  const objectiveStates: ObjectiveState[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const hpById = new Map<number, { health: number; max: number }>();
    for (const e of objectiveHealth) {
      if (e.tick > tick) break; // tick-ordered
      hpById.set(e.id, { health: e.health, max: e.max_health });
    }
    const out: ObjectiveState[] = [];
    for (const o of objectives) {
      if (tick < o.spawn_tick) continue;
      if (o.death_tick != null && tick >= o.death_tick) continue;
      const hp = hpById.get(o.id);
      out.push({
        kind: o.kind,
        x: o.x,
        y: o.y,
        health: hp?.health ?? o.max_health,
        max_health: hp?.max ?? o.max_health,
        color: TEAM_COLORS[o.team] ?? NEUTRAL_OBJECTIVE_COLOR,
      });
    }
    return out;
  }, [objectives, objectiveHealth, frame]);

  // Reconstruct each neutral camp's up/down state at the current tick from the
  // sparse transitions (latest event ≤ tick; default down until first spawn).
  const campStates: NeutralCampState[] = React.useMemo(() => {
    const tick = frame?.tick ?? 0;
    const upById = new Map<number, boolean>();
    for (const e of campStateEvents) {
      if (e.tick > tick) break; // tick-ordered
      upById.set(e.camp_id, e.up);
    }
    return neutralCamps.map((c) => ({
      x: c.x,
      y: c.y,
      size: c.size,
      up: upById.get(c.id) ?? false,
    }));
  }, [neutralCamps, campStateEvents, frame]);

  React.useEffect(() => {
    if (!playing) return;
    if (safeIndex >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const cur = frames[safeIndex];
    const next = frames[safeIndex + 1];
    const ms =
      (((next.tick - cur.tick) / TICKS_PER_SECOND) * 1000) / playbackSpeed;
    const t = window.setTimeout(() => setIndex(safeIndex + 1), Math.max(0, ms));
    return () => window.clearTimeout(t);
  }, [playing, safeIndex, frames, playbackSpeed]);

  function togglePlay() {
    if (safeIndex >= frames.length - 1) {
      setIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }

  function seekManually(next: number) {
    setPlaying(false);
    setIndex(next);
  }

  function seekToTick(tick: number) {
    if (frames.length === 0) return;
    let idx = frames.findIndex((f) => f.tick >= tick);
    if (idx < 0) idx = frames.length - 1;
    seekManually(idx);
  }

  // Jump forward/back by a fixed number of ticks relative to the current frame.
  function seekByTicks(delta: number) {
    const base = frames[safeIndex]?.tick ?? firstTick;
    seekToTick(base + delta);
  }

  // Keyboard shortcuts from anywhere on the page (except while typing in a
  // field): Space toggles playback; ←/→ skip back/forward by the configured
  // step. Refs keep the listener stable while always using the latest values.
  const togglePlayRef = React.useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  const skipRef = React.useRef<(dir: number) => void>(() => {});
  skipRef.current = (dir) => seekByTicks(dir * stepTicks);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault(); // stop page scroll and button re-activation
        togglePlayRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skipRef.current(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skipRef.current(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click the current tick in the map header to type an exact tick to jump to.
  const [editingTick, setEditingTick] = React.useState(false);
  const [tickDraft, setTickDraft] = React.useState("");

  function commitTick() {
    setEditingTick(false);
    const v = parseInt(tickDraft, 10);
    if (Number.isNaN(v)) return;
    const clamped = Math.max(0, Math.min(totalTicks, v));
    seekToTick(firstTick + clamped);
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 p-4">
      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-4">
        {selectedPlayer ? (
          <PlayerDetail
            player={selectedPlayer}
            stats={statsByHero.get(selectedPlayer.hero_id)}
            items={itemsByHero.get(selectedPlayer.hero_id)}
            abilities={abilitiesByHero.get(selectedPlayer.hero_id)}
            abilityLevels={abilityLevelsByHero.get(selectedPlayer.hero_id)}
            onBack={() => setSelectedHeroId(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-shrink-0 flex-col gap-2">
            <PlayerRoster
              roster={players}
              stats={statsByHero}
              team={3}
              align="left"
              winner={winner}
              onSelect={setSelectedHeroId}
            />
            <PlayerRoster
              roster={players}
              stats={statsByHero}
              team={2}
              align="left"
              winner={winner}
              onSelect={setSelectedHeroId}
            />
          </div>
        )}
        <MapView
          frame={frame}
          className="h-full"
          meta={
            <>
              tick{" "}
              {editingTick ? (
                <input
                  type="number"
                  autoFocus
                  min={0}
                  max={totalTicks}
                  value={tickDraft}
                  onChange={(e) => setTickDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={commitTick}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTick();
                    else if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditingTick(false);
                    }
                  }}
                  className="w-20 rounded border border-border bg-background px-1 py-0 text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="Jump to tick"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTickDraft(String(currentTick));
                    setEditingTick(true);
                  }}
                  title="Jump to tick"
                  className="tabular-nums underline-offset-2 hover:text-foreground hover:underline"
                >
                  {currentTick.toLocaleString()}
                </button>
              )}{" "}
              / <span className="tabular-nums">{totalTicks.toLocaleString()}</span>
              {" · "}
              <span className="tabular-nums">
                {formatClock((frame?.reg_ticks ?? 0) / TICKS_PER_SECOND)}
              </span>{" "}
              regulation
            </>
          }
          killMarkers={killMarkers}
          objectiveMarkers={objectiveMarkers}
          objectiveStates={objectiveStates}
          campStates={campStates}
          onSelectPlayer={setSelectedHeroId}
        />
        <EventLog
          killEvents={killEvents}
          abilityEvents={abilityEvents}
          objectiveEvents={objectiveEvents}
          chatEvents={chatEvents}
          players={players}
          currentTick={frame?.tick ?? 0}
          formatTick={(tick) =>
            formatClock((tick - firstTick) / TICKS_PER_SECOND)
          }
          onSeek={seekToTick}
          onSelectPlayer={(heroId, tick) => {
            seekToTick(tick);
            setSelectedHeroId(heroId);
          }}
        />
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => seekByTicks(-stepTicks)}
              aria-label={`Back ${stepTicks} ticks`}
              disabled={frames.length < 2}
              className="size-7"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Back {stepTicks / TICKS_PER_SECOND}s ({stepTicks} ticks)
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="icon"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              disabled={frames.length < 2}
              className="size-7"
            >
              {playing ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-medium">{playing ? "Pause" : "Play"}</span>
            <span className="text-muted-foreground"> — Space</span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => seekByTicks(stepTicks)}
              aria-label={`Forward ${stepTicks} ticks`}
              disabled={frames.length < 2}
              className="size-7"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Forward {stepTicks / TICKS_PER_SECOND}s ({stepTicks} ticks)
          </TooltipContent>
        </Tooltip>
        <div className="flex-1">
          <Timeline
            index={safeIndex}
            frames={frames}
            onSeek={seekManually}
            pauseIntervals={pauseIntervals}
          />
        </div>
        <PlaybackConfig
          speed={playbackSpeed}
          onSpeedChange={setPlaybackSpeed}
          stepTicks={stepTicks}
          onStepChange={setStepTicks}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setInfoOpen(true)}
              aria-label="Demo info"
              className="size-7"
            >
              <Info className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Demo info</TooltipContent>
        </Tooltip>
      </div>

      <DemoInfoDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        name={name}
        totalTicks={totalTicks}
        regulationClock={regulationClock}
        winner={winner}
      />
    </div>
  );
}
