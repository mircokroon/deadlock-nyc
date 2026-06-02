import * as React from "react";

import { AbilityIcon } from "@/components/ability-icon";
import {
  OBJECTIVE_ICONS,
  URN_COLOR,
  type AbilityEvent,
  type ChatEvent,
  type KillEvent,
  type ObjectiveEvent,
  type ObjectiveKind,
} from "@/components/map-view";
import {
  heroPortraitUrl,
  TEAM_COLORS,
  type PlayerInfo,
} from "@/components/player-roster";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type EventTab = "kills" | "abilities" | "objectives" | "chat";

// Neutral (gold) accent for non-team objectives like the Mid-Boss.
const NEUTRAL_COLOR = "#c9a227";

// Per-kind label + verb for the objectives feed (icons are shared via
// OBJECTIVE_ICONS in map-view).
const OBJECTIVE_META: Record<ObjectiveKind, { label: string; verb: string }> = {
  guardian: { label: "Guardian", verb: "destroyed" },
  walker: { label: "Walker", verb: "destroyed" },
  base_guardian: { label: "Base Guardian", verb: "destroyed" },
  shrine: { label: "Shrine", verb: "destroyed" },
  patron: { label: "Patron", verb: "destroyed" },
  mid_boss: { label: "Mid-Boss", verb: "killed" },
  urn: { label: "Urn", verb: "spawns" },
  objective: { label: "Objective", verb: "destroyed" },
};

export function EventLog({
  killEvents,
  abilityEvents,
  objectiveEvents,
  chatEvents,
  players,
  currentTick,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  killEvents: KillEvent[];
  abilityEvents: AbilityEvent[];
  objectiveEvents: ObjectiveEvent[];
  chatEvents: ChatEvent[];
  players: PlayerInfo[];
  currentTick: number;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  const [tab, setTab] = React.useState<EventTab>("kills");
  // Hero focus filters, kept per-tab. Empty set => show everyone; otherwise
  // only events involving a selected hero are shown.
  const [killFilter, setKillFilter] = React.useState<Set<number>>(new Set());
  const [abilityFilter, setAbilityFilter] = React.useState<Set<number>>(
    new Set(),
  );

  const heroById = React.useMemo(() => {
    const m = new Map<number, PlayerInfo>();
    for (const p of players) m.set(p.hero_id, p);
    return m;
  }, [players]);

  // Events up to the current tick, hero-filtered, newest first.
  const visibleKills = React.useMemo(() => {
    let out = killEvents.filter((e) => e.tick <= currentTick);
    if (killFilter.size > 0) {
      out = out.filter(
        (e) =>
          killFilter.has(e.attacker_hero_id) ||
          killFilter.has(e.victim_hero_id),
      );
    }
    return out.reverse();
  }, [killEvents, currentTick, killFilter]);

  const visibleAbilities = React.useMemo(() => {
    let out = abilityEvents.filter((e) => e.tick <= currentTick);
    if (abilityFilter.size > 0) {
      out = out.filter((e) => abilityFilter.has(e.hero_id));
    }
    return out.reverse();
  }, [abilityEvents, currentTick, abilityFilter]);

  const visibleObjectives = React.useMemo(
    () => objectiveEvents.filter((e) => e.tick <= currentTick).reverse(),
    [objectiveEvents, currentTick],
  );

  const visibleChat = React.useMemo(
    () => chatEvents.filter((e) => e.tick <= currentTick).reverse(),
    [chatEvents, currentTick],
  );

  const toggle = (
    setFilter: React.Dispatch<React.SetStateAction<Set<number>>>,
    heroId: number,
  ) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(heroId)) next.delete(heroId);
      else next.add(heroId);
      return next;
    });
  };

  return (
    <div className="flex w-72 flex-shrink-0 flex-col gap-2 sm:w-80">
      <Tabs value={tab} onValueChange={(v) => setTab(v as EventTab)}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="kills" className="px-1 text-xs">
            Kills
          </TabsTrigger>
          <TabsTrigger value="abilities" className="px-1 text-xs">
            Abilities
          </TabsTrigger>
          <TabsTrigger value="objectives" className="px-1 text-xs">
            Objectives
          </TabsTrigger>
          <TabsTrigger value="chat" className="px-1 text-xs">
            Chat
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {(tab === "kills" || tab === "abilities") && (
        <HeroFilter
          players={players}
          selected={tab === "kills" ? killFilter : abilityFilter}
          onToggle={(id) =>
            toggle(tab === "kills" ? setKillFilter : setAbilityFilter, id)
          }
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card">
        {tab === "kills" ? (
          <KillList
            events={visibleKills}
            heroById={heroById}
            formatTick={formatTick}
            onSeek={onSeek}
            onSelectPlayer={onSelectPlayer}
          />
        ) : tab === "abilities" ? (
          <AbilityList
            events={visibleAbilities}
            heroById={heroById}
            formatTick={formatTick}
            onSeek={onSeek}
            onSelectPlayer={onSelectPlayer}
          />
        ) : tab === "objectives" ? (
          <ObjectiveList
            events={visibleObjectives}
            heroById={heroById}
            formatTick={formatTick}
            onSeek={onSeek}
            onSelectPlayer={onSelectPlayer}
          />
        ) : (
          <ChatList
            events={visibleChat}
            heroById={heroById}
            formatTick={formatTick}
            onSeek={onSeek}
            onSelectPlayer={onSelectPlayer}
          />
        )}
      </div>
    </div>
  );
}

// Two rows of hero portraits (one per team). Click to focus the feed on that
// hero; with nothing selected the feed shows everyone.
function HeroFilter({
  players,
  selected,
  onToggle,
}: {
  players: PlayerInfo[];
  selected: Set<number>;
  onToggle: (heroId: number) => void;
}) {
  const active = selected.size > 0;
  return (
    <div className="flex flex-col gap-1">
      {[3, 2].map((team) => (
        <div key={team} className="flex gap-1">
          {players
            .filter((p) => p.team === team)
            .map((p) => {
              const isSel = selected.has(p.hero_id);
              const url = heroPortraitUrl(p.hero_id);
              return (
                <button
                  key={p.hero_id}
                  type="button"
                  onClick={() => onToggle(p.hero_id)}
                  title={p.hero_name}
                  aria-pressed={isSel}
                  className={cn(
                    "relative aspect-square min-w-0 flex-1 cursor-pointer overflow-hidden rounded bg-muted transition-opacity",
                    active && !isSel
                      ? "opacity-30 hover:opacity-70"
                      : "opacity-100",
                  )}
                  style={
                    isSel
                      ? { boxShadow: `inset 0 0 0 2px ${TEAM_COLORS[team]}` }
                      : undefined
                  }
                >
                  {url ? (
                    <img
                      src={url}
                      alt={p.hero_name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

function EmptyFeed({ message }: { message: string }) {
  return (
    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}

// Shared clickable row scaffold: click seeks; name buttons also open the player.
function EventRow({
  tick,
  formatTick,
  onSeek,
  children,
}: {
  tick: number;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSeek(tick)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSeek(tick);
          }
        }}
        title="Jump to this moment"
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
      >
        <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          [{formatTick(tick)}]
        </span>
        {children}
      </div>
    </li>
  );
}

function KillList({
  events,
  heroById,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  events: KillEvent[];
  heroById: Map<number, PlayerInfo>;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  if (events.length === 0) return <EmptyFeed message="No kills yet." />;
  return (
    <ul className="divide-y divide-border text-xs">
      {events.map((e, i) => {
        const attacker = heroById.get(e.attacker_hero_id);
        const victim = heroById.get(e.victim_hero_id);
        return (
          <EventRow
            key={`${e.tick}-${i}`}
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
          >
            <HeroChip
              hero={attacker}
              fallback="?"
              onSelect={
                attacker
                  ? () => onSelectPlayer(attacker.hero_id, e.tick)
                  : undefined
              }
            />
            <span className="text-muted-foreground">killed</span>
            <HeroChip
              hero={victim}
              fallback="?"
              onSelect={
                victim ? () => onSelectPlayer(victim.hero_id, e.tick) : undefined
              }
            />
          </EventRow>
        );
      })}
    </ul>
  );
}

function AbilityList({
  events,
  heroById,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  events: AbilityEvent[];
  heroById: Map<number, PlayerInfo>;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  if (events.length === 0) return <EmptyFeed message="No abilities yet." />;
  return (
    <ul className="divide-y divide-border text-xs">
      {events.map((e, i) => {
        const hero = heroById.get(e.hero_id);
        return (
          <EventRow
            key={`${e.tick}-${i}`}
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
          >
            <HeroChip
              hero={hero}
              fallback="?"
              onSelect={
                hero ? () => onSelectPlayer(hero.hero_id, e.tick) : undefined
              }
            />
            <AbilityIcon name={e.ability_name} size={18} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {prettifyAbility(e.ability_name)}
            </span>
          </EventRow>
        );
      })}
    </ul>
  );
}

function ObjectiveList({
  events,
  heroById,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  events: ObjectiveEvent[];
  heroById: Map<number, PlayerInfo>;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  if (events.length === 0) return <EmptyFeed message="No objectives yet." />;
  return (
    <ul className="divide-y divide-border text-xs">
      {events.map((e, i) => {
        const meta = OBJECTIVE_META[e.kind] ?? OBJECTIVE_META.objective;
        const Icon = OBJECTIVE_ICONS[e.kind] ?? OBJECTIVE_ICONS.objective;
        const color =
          e.kind === "urn" ? URN_COLOR : (TEAM_COLORS[e.team] ?? NEUTRAL_COLOR);
        const killer =
          e.killer_hero_id > 0 ? heroById.get(e.killer_hero_id) : undefined;
        return (
          <EventRow
            key={`${e.tick}-${i}`}
            tick={e.tick}
            formatTick={formatTick}
            onSeek={onSeek}
          >
            <Icon
              className="size-[18px] flex-shrink-0"
              style={{ color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium" style={{ color }}>
                {meta.label}
              </span>{" "}
              <span className="text-muted-foreground">{meta.verb}</span>
            </span>
            {killer ? (
              <HeroChip
                hero={killer}
                fallback="?"
                onSelect={() => onSelectPlayer(killer.hero_id, e.tick)}
              />
            ) : null}
          </EventRow>
        );
      })}
    </ul>
  );
}

function ChatList({
  events,
  heroById,
  formatTick,
  onSeek,
  onSelectPlayer,
}: {
  events: ChatEvent[];
  heroById: Map<number, PlayerInfo>;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onSelectPlayer: (heroId: number, tick: number) => void;
}) {
  if (events.length === 0) return <EmptyFeed message="No chat yet." />;
  return (
    <ul className="divide-y divide-border text-xs">
      {events.map((e, i) => {
        const hero = e.hero_id > 0 ? heroById.get(e.hero_id) : undefined;
        const color = hero ? TEAM_COLORS[hero.team] : undefined;
        // Team chat gets a faint background in the sender's team color; all-chat
        // keeps the regular background.
        const bg = !e.all_chat && color ? `${color}2e` : undefined;
        return (
          <li key={`${e.tick}-${i}`}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSeek(e.tick)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSeek(e.tick);
                }
              }}
              title="Jump to this moment"
              style={bg ? { backgroundColor: bg } : undefined}
              className="flex w-full cursor-pointer gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
            >
              <span className="mt-px flex-shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                [{formatTick(e.tick)}]
              </span>
              <span className="min-w-0 flex-1 break-words">
                {hero ? (
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onSelectPlayer(hero.hero_id, e.tick);
                    }}
                    title={`Open ${hero.hero_name}`}
                    className="cursor-pointer font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                    style={color ? { color } : undefined}
                  >
                    {hero.hero_name}
                  </button>
                ) : (
                  <span className="font-medium text-muted-foreground">
                    Unknown
                  </span>
                )}
                <span className="text-muted-foreground">: </span>
                <span className="text-foreground">{e.text}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function prettifyAbility(name: string): string {
  return name
    .replace(/^citadel_ability_/, "")
    .replace(/^ability_/, "")
    .replace(/^citadel_/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function HeroChip({
  hero,
  fallback,
  onSelect,
}: {
  hero: PlayerInfo | undefined;
  fallback: string;
  onSelect?: () => void;
}) {
  const url = hero ? heroPortraitUrl(hero.hero_id) : null;
  const color = hero ? TEAM_COLORS[hero.team] : undefined;
  const inner = (
    <>
      {url ? (
        <img
          src={url}
          alt=""
          width={18}
          height={18}
          loading="lazy"
          className="size-[18px] flex-shrink-0 rounded object-contain"
        />
      ) : (
        <span className="size-[18px] flex-shrink-0 rounded bg-muted" />
      )}
      <span
        className="truncate font-medium"
        style={color ? { color } : undefined}
      >
        {hero?.hero_name || fallback}
      </span>
    </>
  );

  if (!hero || !onSelect) {
    return <span className="flex min-w-0 items-center gap-1">{inner}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`Open ${hero.hero_name}`}
      className="flex min-w-0 cursor-pointer items-center gap-1 rounded hover:underline focus-visible:underline focus-visible:outline-none"
    >
      {inner}
    </button>
  );
}
