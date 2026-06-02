use std::collections::{HashMap, HashSet};

use boon::Serializer;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct DemoParser {
    inner: boon::Parser,
}

const PAWN_CLASS: &str = "CCitadelPlayerPawn";
const CONTROLLER_CLASS: &str = "CCitadelPlayerController";
const GAMERULES_CLASS: &str = "CCitadelGameRulesProxy";

/// Networked classes of the destructible objectives, used to label
/// `k_EUserMsg_BossKilled` events for the objectives feed. The killed entity is
/// already despawned by the time the message arrives, so we keep a rolling
/// index→class cache; the class name is the stable signal (the message's
/// `entity_killed_class` enum can drift between patches). Verified empirically
/// against demos — see `objective_kind`.
const OBJ_CLASSES: &[&str] = &[
    "CNPC_TrooperBoss",              // Guardian (tier 1)
    "CNPC_Boss_Tier2",               // Walker (tier 2)
    "CNPC_BarrackBoss",              // Base Guardian
    "CCitadel_Destroyable_Building", // Shrine
    "CNPC_Boss_Tier3",               // Patron (final)
    "CNPC_MidBoss",                  // Mid-Boss (neutral)
];

/// Lane creeps (the marching troopers), plotted live on the minimap.
const TROOPER_CLASS: &str = "CNPC_Trooper";

/// Pack one alive trooper into an i32 so frames hold a flat number array rather
/// than ~30 objects each (there are ~18k frames). Layout: bits 11–20 = qx,
/// bits 1–10 = qy (world coord quantized to 32 units over the ±16384 range,
/// ~1px on the minimap), bit 0 = team (0 → team 2, 1 → team 3). The frontend
/// reverses this. Precision loss is invisible for the small dots.
fn pack_trooper(x: f32, y: f32, team: i64) -> i32 {
    let qx = (((x + 16384.0) / 32.0).round() as i32).clamp(0, 1023);
    let qy = (((y + 16384.0) / 32.0).round() as i32).clamp(0, 1023);
    let t = if team == 3 { 1 } else { 0 };
    (qx << 11) | (qy << 1) | t
}

/// Neutral jungle creeps. There is no camp entity in the demo, so camps are
/// derived by clustering these creeps' spawn positions (see player_positions).
const NEUTRAL_CLASS: &str = "CNPC_TrooperNeutral";

/// The Urn pickup ("Idol" in the gameplay code). A fresh entity of this class
/// appears each time the Urn spawns into the world (~every 5 min, alternating
/// mid-lane sides), so a newly-seen index = an "urn spawns" objective event.
const IDOL_CLASS: &str = "CCitadelItemPickupIdol";

/// While the Urn is carried, its world entity despawns (it's held abstractly on
/// the player). The picker is the hero standing on the urn the instant it
/// vanishes, so a despawn within this radius of a living pawn = a pickup, and we
/// then plot the urn on that carrier until the entity reappears (drop), the
/// carrier dies, or this timeout (a backstop for the deliver-and-survive case
/// the demo gives us no clean end-signal for).
const URN_PICKUP_RADIUS: f32 = 350.0;
const URN_CARRY_MAX_TICKS: i32 = 90 * 64;

/// Clustering / occupancy radius for grouping creeps into a camp (world units).
/// Tuned so a camp's spread (~600) groups but adjacent camps (~1000+) don't.
const CAMP_RADIUS: f32 = 700.0;

/// Camp size bucket (1 = small, 2 = medium, 3 = large) from a creep's max
/// health — the three neutral creep types are ~142 / ~355 / ~1323 HP. A camp's
/// size is the largest creep tier it contains.
fn neutral_tier(max_health: i32) -> u8 {
    if max_health >= 900 {
        3
    } else if max_health >= 250 {
        2
    } else {
        1
    }
}

/// Stable slug for an objective, from its networked class name. The frontend
/// turns these into display labels + icons.
fn objective_kind(class_name: &str) -> &'static str {
    match class_name {
        "CNPC_TrooperBoss" => "guardian",
        "CNPC_Boss_Tier2" => "walker",
        "CNPC_BarrackBoss" => "base_guardian",
        "CCitadel_Destroyable_Building" => "shrine",
        "CNPC_Boss_Tier3" => "patron",
        "CNPC_MidBoss" => "mid_boss",
        _ => "objective",
    }
}

#[wasm_bindgen]
impl DemoParser {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<DemoParser, JsError> {
        let inner = boon::Parser::from_bytes(bytes);
        inner.verify().map_err(to_js_error)?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = fileHeader)]
    pub fn file_header(&self) -> Result<JsValue, JsError> {
        let header = self.inner.file_header().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&header).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = fileInfo)]
    pub fn file_info(&self) -> Result<JsValue, JsError> {
        let info = self.inner.file_info().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Team number of the match winner, scanned from the
    /// `k_EUserMsg_GameOver` Citadel user message. Returns `null` if the
    /// demo doesn't contain one (e.g. it ended before the match did).
    #[wasm_bindgen(js_name = gameWinner)]
    pub fn game_winner(&self) -> Result<JsValue, JsError> {
        use boon_proto::proto::{
            CCitadelUserMessageGameOver, CitadelUserMessageIds as Msg,
        };
        use prost::Message;

        let events = self.inner.events(None).map_err(to_js_error)?;
        let mut winner: Option<i32> = None;
        for event in &events {
            if event.msg_type == Msg::KEUserMsgGameOver as u32
                && let Ok(msg) =
                    CCitadelUserMessageGameOver::decode(event.payload.as_slice())
            {
                winner = msg.winning_team;
            }
        }
        serde_wasm_bindgen::to_value(&winner).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = serializerFields)]
    pub fn serializer_fields(&self, class_name: &str) -> Result<JsValue, JsError> {
        let ctx = self.inner.parse_init().map_err(to_js_error)?;
        let serializer = ctx
            .serializers
            .get(class_name)
            .ok_or_else(|| JsError::new(&format!("class {class_name} not found")))?;
        let mut paths: Vec<String> = Vec::new();
        walk_fields(serializer, "", &mut paths);
        serde_wasm_bindgen::to_value(&paths).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Roster from CCitadelPlayerController: name, hero, team. Hero ID is
    /// resolved to a name via boon's lookup table.
    #[wasm_bindgen(js_name = players)]
    pub fn players(&self) -> Result<JsValue, JsError> {
        let class_filter: HashSet<&str> = [CONTROLLER_CLASS].into_iter().collect();

        let mut keys_resolved = false;
        let mut nk_team: Option<u64> = None;
        let mut nk_name: Option<u64> = None;
        let mut nk_hero: Option<u64> = None;

        let mut roster: HashMap<i32, PlayerInfo> = HashMap::new();

        self.inner
            .run_to_end_filtered(&class_filter, |ctx| {
                if !keys_resolved {
                    if let Some(s) = ctx.serializers.get(CONTROLLER_CLASS) {
                        nk_team = s.resolve_field_key("m_iTeamNum");
                        nk_name = s.resolve_field_key("m_iszPlayerName");
                        nk_hero = s.resolve_field_key("m_PlayerDataGlobal.m_nHeroID");
                        keys_resolved = true;
                    } else {
                        return;
                    }
                }

                for (&idx, entity) in ctx.entities.iter() {
                    if entity.class_name != CONTROLLER_CLASS {
                        continue;
                    }

                    let team = get_i64(entity, nk_team) as i32;
                    let name = get_string(entity, nk_name);
                    let hero_id = get_i64(entity, nk_hero);
                    let hero_name = if hero_id > 0 {
                        boon::hero_name(hero_id).to_string()
                    } else {
                        String::new()
                    };

                    let entry = roster.entry(idx).or_insert(PlayerInfo {
                        name: String::new(),
                        hero_id: 0,
                        hero_name: String::new(),
                        team: 0,
                    });
                    if !name.is_empty() {
                        entry.name = name;
                    }
                    if hero_id > 0 {
                        entry.hero_id = hero_id;
                        entry.hero_name = hero_name;
                    }
                    if team != 0 {
                        entry.team = team;
                    }
                }
            })
            .map_err(to_js_error)?;

        let players: Vec<PlayerInfo> = roster
            .into_values()
            .filter(|p| p.team == 2 || p.team == 3)
            .collect();
        serde_wasm_bindgen::to_value(&players).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Walk every tick and emit per-player frames sampled every
    /// `sample_every` ticks. Each frame contains both the position from
    /// CCitadelPlayerPawn and the live stats from CCitadelPlayerController,
    /// merged by hero ID.
    ///
    /// `progress` is invoked periodically as `(tick, total_ticks)` so the caller
    /// can render a progress bar; `total_ticks` is 0 if the demo trailer lacks a
    /// playback-tick count.
    #[wasm_bindgen(js_name = playerPositions)]
    pub fn player_positions(
        &self,
        sample_every: u32,
        progress: &js_sys::Function,
    ) -> Result<JsValue, JsError> {
        let class_filter: HashSet<&str> = [
            PAWN_CLASS,
            CONTROLLER_CLASS,
            GAMERULES_CLASS,
            NEUTRAL_CLASS,
            TROOPER_CLASS,
            IDOL_CLASS,
        ]
        .into_iter()
        .chain(OBJ_CLASSES.iter().copied())
        .collect();

        let step = sample_every.max(1) as i32;
        let mut last_emitted: Option<i32> = None;

        // Total tick count from the demo trailer, for the progress bar (0 if
        // absent). Progress is reported at most every ~512 ticks to keep the
        // JS round-trips cheap.
        let total_ticks = self
            .inner
            .file_info()
            .ok()
            .and_then(|fi| fi.playback_ticks)
            .unwrap_or(0);
        let mut last_progress_tick: i32 = i32::MIN;
        const PROGRESS_EVERY: i32 = 512;

        // Pawn keys
        let mut pawn_keys_resolved = false;
        let mut pk_x: Option<u64> = None;
        let mut pk_y: Option<u64> = None;
        let mut pk_cell_x: Option<u64> = None;
        let mut pk_cell_y: Option<u64> = None;
        let mut pk_team: Option<u64> = None;
        let mut pk_hero: Option<u64> = None;
        let mut pk_life: Option<u64> = None;
        let mut pk_health: Option<u64> = None;
        let mut pk_max_health: Option<u64> = None;
        // m_angEyeAngles: QAngle(pitch, yaw, roll) — the hero's look direction.
        let mut pk_eye: Option<u64> = None;

        // Controller keys
        let mut ctrl_keys_resolved = false;
        let mut ck_hero: Option<u64> = None;
        let mut ck_net_worth: Option<u64> = None;
        let mut ck_ap_net_worth: Option<u64> = None;
        let mut ck_kills: Option<u64> = None;
        let mut ck_deaths: Option<u64> = None;
        let mut ck_assists: Option<u64> = None;
        let mut ck_damage: Option<u64> = None;
        let mut ck_healing: Option<u64> = None;
        let mut ck_health_max: Option<u64> = None;
        // (eValType key, value key) pairs for the 20 stat-modifier slots on
        // m_PlayerDataGlobal.m_vecStatViewerModifierValues.
        let mut ck_stat_keys: Vec<(Option<u64>, Option<u64>)> =
            Vec::with_capacity(20);
        // (m_ItemID key, m_nUpgradeInfo key) pairs for the 8 ability-upgrade
        // slots on m_PlayerDataGlobal.m_vecAbilityUpgradeState — the hero's
        // signature abilities and their spent upgrade tiers.
        let mut ck_ability_keys: Vec<(Option<u64>, Option<u64>)> =
            Vec::with_capacity(8);

        let mut frames: Vec<PositionFrame> = Vec::new();
        let mut pawn_to_hero: HashMap<i32, i64> = HashMap::new();
        let mut slot_to_hero: HashMap<i32, i64> = HashMap::new();
        let mut item_events_raw: Vec<RawItemEvent> = Vec::new();
        let mut kill_events_raw: Vec<RawKillEvent> = Vec::new();
        let mut ability_events_raw: Vec<RawAbilityEvent> = Vec::new();
        let mut chat_events_raw: Vec<RawChatEvent> = Vec::new();
        let mut resolved_paths: Option<ResolvedPaths> = None;

        // Objective destructions (Guardian/Walker/Shrine/Base Guardian/Patron +
        // Mid-Boss). Resolved post-loop to hero IDs via pawn_to_hero. The
        // rolling cache holds each objective entity's kind by index so a kill
        // message can still be labeled after the entity despawns on its kill
        // tick.
        let mut obj_kind_by_idx: HashMap<i32, &'static str> = HashMap::new();
        let mut objective_events_raw: Vec<RawObjectiveEvent> = Vec::new();

        // Live objective state for the map overlay. Buildings are static, so we
        // capture a constant roster (kind/team/position/max_health, keyed by
        // entity index) plus sparse health samples — health is recorded only
        // when it changes at a sampled tick, like items/ability upgrades. Death
        // ticks come from BossKilled. Field keys are resolved once per class.
        let mut obj_keys: HashMap<&'static str, ObjKeys> = HashMap::new();
        let mut obj_roster: HashMap<i32, ObjectiveBuild> = HashMap::new();
        let mut obj_last_hp: HashMap<i32, (i32, i32)> = HashMap::new();
        let mut obj_health_events: Vec<ObjectiveHealthEvent> = Vec::new();
        let mut obj_death_tick: HashMap<i32, i32> = HashMap::new();

        // Neutral camps. No camp entity exists, so camps are clustered from
        // creep spawn positions (first-seen ≈ at-rest at the camp). Size is the
        // largest creep tier in the cluster; up/down state is sparse (a camp is
        // "up" at a sampled tick if a live creep is within CAMP_RADIUS of it).
        let mut neutral_keys_resolved = false;
        let mut nk_cell_x: Option<u64> = None;
        let mut nk_vec_x: Option<u64> = None;
        let mut nk_cell_y: Option<u64> = None;
        let mut nk_vec_y: Option<u64> = None;
        let mut nk_max_health: Option<u64> = None;
        let mut nk_life: Option<u64> = None;
        let mut camps: Vec<CampBuild> = Vec::new();
        let mut seen_creeps: HashSet<i32> = HashSet::new();
        let mut camp_state_events: Vec<CampStateEvent> = Vec::new();

        // Lane troopers — packed into each frame (see pack_trooper).
        let mut trooper_keys_resolved = false;
        let mut tk_cell_x: Option<u64> = None;
        let mut tk_vec_x: Option<u64> = None;
        let mut tk_cell_y: Option<u64> = None;
        let mut tk_vec_y: Option<u64> = None;
        let mut tk_team: Option<u64> = None;
        let mut tk_life: Option<u64> = None;

        // Urn (Idol) spawn tracking. Position keys resolved once; a per-tick
        // "present last tick" set turns a newly-appearing idol entity into one
        // "urn spawns" objective event at its spawn location.
        let mut idol_keys_resolved = false;
        let mut idk_cell_x: Option<u64> = None;
        let mut idk_vec_x: Option<u64> = None;
        let mut idk_cell_y: Option<u64> = None;
        let mut idk_vec_y: Option<u64> = None;
        let mut idk_team: Option<u64> = None;
        let mut idol_prev: HashSet<i32> = HashSet::new();
        let mut idol_now: HashSet<i32> = HashSet::new();
        let mut idol_last_pos: HashMap<i32, (f32, f32)> = HashMap::new();
        // The pawn currently carrying the urn (entity despawned), or None.
        let mut carrier_pawn: Option<i32> = None;
        let mut carry_start: i32 = 0;

        // Ability upgrades are stored as a sparse event log rather than on every
        // frame (each hero's 4 abilities only change a dozen times a match). The
        // constant per-hero ability set is captured once in `ability_slots`; the
        // frontend reconstructs current levels at the playback tick, like items.
        let mut ability_slots: HashMap<i64, Vec<AbilitySlot>> = HashMap::new();
        let mut ability_prev_level: HashMap<(i64, usize), i32> = HashMap::new();
        let mut ability_upgrade_events: Vec<AbilityUpgradeEvent> = Vec::new();

        // Pause / regulation tracking. `active_ticks` accumulates non-paused
        // ticks from the start of the recording (boon's regulation clock);
        // pauses come from CCitadelGameRulesProxy.m_pGameRules.m_bGamePaused.
        let mut gr_keys_resolved = false;
        let mut gk_paused: Option<u64> = None;
        let mut prev_tick: Option<i32> = None;
        let mut prev_paused = false;
        let mut active_ticks: i32 = 0;
        let mut pause_intervals: Vec<PauseInterval> = Vec::new();
        let mut cur_pause_start: Option<i32> = None;
        let mut game_over_tick: Option<i32> = None;
        let mut regulation_ticks: Option<i32> = None;

        self.inner
            .run_to_end_with_events_filtered(&class_filter, |ctx, events| {
                // --- report parse progress (throttled) ---
                // saturating_sub: last_progress_tick starts at i32::MIN, so a
                // plain subtraction would overflow and the bar would never
                // advance until the final 100% call.
                if ctx.tick.saturating_sub(last_progress_tick) >= PROGRESS_EVERY {
                    last_progress_tick = ctx.tick;
                    let _ = progress.call2(
                        &JsValue::NULL,
                        &JsValue::from(ctx.tick),
                        &JsValue::from(total_ticks),
                    );
                }

                // --- pause / regulation tracking (runs every tick) ---
                if !gr_keys_resolved
                    && let Some(s) = ctx.serializers.get(GAMERULES_CLASS)
                {
                    gk_paused = s.resolve_field_key("m_pGameRules.m_bGamePaused");
                    gr_keys_resolved = true;
                }
                let paused_now = ctx
                    .entities
                    .iter()
                    .find(|(_, e)| e.class_name == GAMERULES_CLASS)
                    .map(|(_, e)| e.get_bool(gk_paused))
                    .unwrap_or(prev_paused);
                if let Some(pt) = prev_tick
                    && !prev_paused
                {
                    // Attribute the elapsed ticks to the (prior) play state.
                    active_ticks += (ctx.tick - pt).max(0);
                }
                if paused_now && !prev_paused {
                    cur_pause_start = Some(ctx.tick);
                } else if !paused_now
                    && prev_paused
                    && let Some(start) = cur_pause_start.take()
                {
                    pause_intervals.push(PauseInterval { start, end: ctx.tick });
                }
                prev_tick = Some(ctx.tick);
                prev_paused = paused_now;

                // Keep each live objective entity's kind cached by index. Only
                // writes on change, so this is cheap despite running per tick.
                for (&idx, e) in ctx.entities.iter() {
                    if OBJ_CLASSES.contains(&e.class_name.as_str()) {
                        let kind = objective_kind(&e.class_name);
                        if obj_kind_by_idx.get(&idx) != Some(&kind) {
                            obj_kind_by_idx.insert(idx, kind);
                        }
                    }
                }

                // Resolve the Urn's position keys once it first appears.
                if !idol_keys_resolved
                    && let Some(s) = ctx.serializers.get(IDOL_CLASS)
                {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    idk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    idk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    idk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    idk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    idk_team = s.resolve_field_key("m_iTeamNum");
                    idol_keys_resolved = true;
                }

                // Urn lifecycle. A newly-seen idol entity is either a fresh
                // spawn (emit the "urn" objective event) or the urn being
                // dropped back into the world by the player who was carrying it
                // (no event — just end the carry). An idol that vanishes next to
                // a living hero was picked up by that hero.
                idol_now.clear();
                for (&idx, e) in ctx.entities.iter() {
                    if e.class_name != IDOL_CLASS {
                        continue;
                    }
                    idol_now.insert(idx);
                    let ux = cell_to_world(
                        get_i64(e, idk_cell_x) as i32,
                        get_f32(e, idk_vec_x),
                    );
                    let uy = cell_to_world(
                        get_i64(e, idk_cell_y) as i32,
                        get_f32(e, idk_vec_y),
                    );
                    idol_last_pos.insert(idx, (ux, uy));
                    if !idol_prev.contains(&idx) {
                        if carrier_pawn.is_some() {
                            // The carried urn reappeared → it was dropped, not a
                            // fresh spawn.
                            carrier_pawn = None;
                        } else {
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: ctx.tick,
                                kind: "urn",
                                team: get_i64(e, idk_team) as i32,
                                killer_pawn: -1,
                                x: Some(ux),
                                y: Some(uy),
                            });
                        }
                    }
                }
                // Pickups: an idol that despawned next to a living pawn.
                for &idx in idol_prev.iter() {
                    if idol_now.contains(&idx) {
                        continue;
                    }
                    let (lx, ly) =
                        idol_last_pos.remove(&idx).unwrap_or((0.0, 0.0));
                    let mut best = (f32::MAX, -1i32);
                    for (&pidx, pe) in ctx.entities.iter() {
                        if pe.class_name != PAWN_CLASS
                            || get_i64(pe, pk_life) != 0
                        {
                            continue;
                        }
                        let x = cell_to_world(
                            get_i64(pe, pk_cell_x) as i32,
                            get_f32(pe, pk_x),
                        );
                        let y = cell_to_world(
                            get_i64(pe, pk_cell_y) as i32,
                            get_f32(pe, pk_y),
                        );
                        let d = ((x - lx).powi(2) + (y - ly).powi(2)).sqrt();
                        if d < best.0 {
                            best = (d, pidx);
                        }
                    }
                    if best.0 < URN_PICKUP_RADIUS {
                        carrier_pawn = Some(best.1);
                        carry_start = ctx.tick;
                    }
                }
                std::mem::swap(&mut idol_prev, &mut idol_now);
                // End a carry when the carrier dies / disappears, or the backstop
                // timeout elapses.
                if let Some(cp) = carrier_pawn {
                    let ended = match ctx.entities.get(cp) {
                        Some(e) if e.class_name == PAWN_CLASS => {
                            get_i64(e, pk_life) != 0
                        }
                        _ => true,
                    } || ctx.tick.saturating_sub(carry_start)
                        > URN_CARRY_MAX_TICKS;
                    if ended {
                        carrier_pawn = None;
                    }
                }

                if !pawn_keys_resolved
                    && let Some(s) = ctx.serializers.get(PAWN_CLASS)
                {
                    let mut all_paths: Vec<String> = Vec::new();
                    walk_fields(s, "", &mut all_paths);

                    let find = |suffix: &str| -> Option<(String, u64)> {
                        all_paths
                            .iter()
                            .find(|p| {
                                p == &suffix || p.ends_with(&format!(".{suffix}"))
                            })
                            .and_then(|p| s.resolve_field_key(p).map(|k| (p.clone(), k)))
                    };

                    let (px, kx) = find("m_vecX").unzip();
                    let (py, ky) = find("m_vecY").unzip();
                    // z / cell_z paths are kept for the debug `paths` output, but
                    // the values aren't read per-tick, so their keys are dropped.
                    let (pz, _) = find("m_vecZ").unzip();
                    let (pcx, kcx) = find("m_cellX").unzip();
                    let (pcy, kcy) = find("m_cellY").unzip();
                    let (pcz, _) = find("m_cellZ").unzip();

                    pk_x = kx;
                    pk_y = ky;
                    pk_cell_x = kcx;
                    pk_cell_y = kcy;
                    pk_team = s.resolve_field_key("m_iTeamNum");
                    pk_hero = s.resolve_field_key(
                        "m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID",
                    );
                    pk_life = s.resolve_field_key("m_lifeState");
                    pk_health = s.resolve_field_key("m_iHealth");
                    pk_max_health = s.resolve_field_key("m_iMaxHealth");
                    pk_eye = s.resolve_field_key("m_angEyeAngles");

                    resolved_paths = Some(ResolvedPaths {
                        vec_x: px,
                        vec_y: py,
                        vec_z: pz,
                        cell_x: pcx,
                        cell_y: pcy,
                        cell_z: pcz,
                        team: pk_team.map(|_| "m_iTeamNum".into()),
                        life: pk_life.map(|_| "m_lifeState".into()),
                    });

                    pawn_keys_resolved = true;
                }

                if !ctrl_keys_resolved
                    && let Some(s) = ctx.serializers.get(CONTROLLER_CLASS)
                {
                    ck_hero = s.resolve_field_key("m_PlayerDataGlobal.m_nHeroID");
                    ck_net_worth =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iGoldNetWorth");
                    ck_ap_net_worth =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iAPNetWorth");
                    ck_kills =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerKills");
                    ck_deaths = s.resolve_field_key("m_PlayerDataGlobal.m_iDeaths");
                    ck_assists =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerAssists");
                    ck_damage =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iHeroDamage");
                    ck_healing =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iHeroHealing");
                    // Effective max health. The pawn's m_iMaxHealth is a base/
                    // stale value (current health exceeds it ~55% of ticks); the
                    // controller's m_iHealthMax already folds in level growth,
                    // items and buffs, so it's the correct denominator.
                    ck_health_max =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iHealthMax");
                    for i in 0..20usize {
                        let vt = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecStatViewerModifierValues.{i}.m_eValType"
                        ));
                        let val = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecStatViewerModifierValues.{i}.m_flValue"
                        ));
                        ck_stat_keys.push((vt, val));
                    }
                    for i in 0..8usize {
                        let item = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i:04}.m_ItemID"
                        ));
                        let bits = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i:04}.m_nUpgradeInfo"
                        ));
                        ck_ability_keys.push((item, bits));
                    }
                    ctrl_keys_resolved = true;
                }

                if !pawn_keys_resolved {
                    return;
                }

                // Maintain slot → hero_id mapping (controller entity index −1).
                if ctrl_keys_resolved {
                    for (&idx, entity) in ctx.entities.iter() {
                        if entity.class_name != CONTROLLER_CLASS {
                            continue;
                        }
                        let hero_id = get_i64(entity, ck_hero);
                        if hero_id != 0 {
                            slot_to_hero.insert(idx - 1, hero_id);
                        }
                    }
                }

                // Capture AbilitiesChanged events (item purchases / sells /
                // upgrades) and HeroKilled events. Hero IDs are mapped after
                // the parse via slot_to_hero / pawn_to_hero.
                {
                    use boon_proto::proto::{
                        CCitadelUserMessageImportantAbilityUsed,
                        CCitadelUserMsgAbilitiesChanged, CCitadelUserMsgBossKilled,
                        CCitadelUserMsgChatMsg, CCitadelUserMsgHeroKilled,
                        CitadelUserMessageIds as Msg,
                    };
                    use prost::Message;
                    for event in events {
                        if event.msg_type == Msg::KEUserMsgAbilitiesChanged as u32 {
                            if let Ok(msg) = CCitadelUserMsgAbilitiesChanged::decode(
                                event.payload.as_slice(),
                            ) {
                                item_events_raw.push(RawItemEvent {
                                    tick: event.tick,
                                    player_slot: msg.purchaser_player_slot.unwrap_or(-1),
                                    ability_id: msg.ability_id.unwrap_or(0),
                                    change: msg.change.unwrap_or(-1),
                                });
                            }
                        } else if event.msg_type == Msg::KEUserMsgHeroKilled as u32
                            && let Ok(msg) = CCitadelUserMsgHeroKilled::decode(
                                event.payload.as_slice(),
                            )
                        {
                            // Prefer scorer (last-hit attribution), fall back to
                            // raw attacker. Self-kills (suicide) come through
                            // with the same idx for victim/attacker.
                            let attacker = msg.entindex_scorer.unwrap_or(-1);
                            let attacker = if attacker > 0 {
                                attacker
                            } else {
                                msg.entindex_attacker.unwrap_or(-1)
                            };
                            let victim = msg.entindex_victim.unwrap_or(-1);
                            // Sample the victim pawn's current position so the
                            // map can show a marker at the kill location.
                            let (kx, ky) = ctx
                                .entities
                                .get(victim)
                                .map(|e| {
                                    let raw_x = get_f32(e, pk_x);
                                    let raw_y = get_f32(e, pk_y);
                                    let cx = get_i64(e, pk_cell_x) as i32;
                                    let cy = get_i64(e, pk_cell_y) as i32;
                                    (cell_to_world(cx, raw_x), cell_to_world(cy, raw_y))
                                })
                                .unwrap_or((0.0, 0.0));
                            kill_events_raw.push(RawKillEvent {
                                tick: event.tick,
                                victim_pawn: victim,
                                attacker_pawn: attacker,
                                x: kx,
                                y: ky,
                            });
                        } else if event.msg_type == Msg::KEUserMsgGameOver as u32
                            && game_over_tick.is_none()
                        {
                            // First GameOver marks the end of regulation play;
                            // freeze the regulation clock here.
                            game_over_tick = Some(event.tick);
                            regulation_ticks = Some(active_ticks);
                        } else if event.msg_type
                            == Msg::KEUserMsgImportantAbilityUsed as u32
                            && let Ok(msg) =
                                CCitadelUserMessageImportantAbilityUsed::decode(
                                    event.payload.as_slice(),
                                )
                        {
                            let name = msg.ability_name.unwrap_or_default();
                            if !name.is_empty() {
                                // `player` is a protobuf entity handle; its low
                                // bits index the casting pawn, mapped to a hero
                                // after the walk via pawn_to_hero.
                                ability_events_raw.push(RawAbilityEvent {
                                    tick: event.tick,
                                    pawn: boon::protobuf_handle_index(msg.player)
                                        .unwrap_or(-1),
                                    ability_name: name,
                                });
                            }
                        } else if event.msg_type == Msg::KEUserMsgBossKilled as u32
                            && let Ok(msg) = CCitadelUserMsgBossKilled::decode(
                                event.payload.as_slice(),
                            )
                        {
                            // An objective was destroyed. The killed entity has
                            // usually despawned by now, so label it from the
                            // rolling index→kind cache. entity_position is
                            // already world-space (same frame as kill markers).
                            let killed_idx =
                                boon::protobuf_handle_index(msg.entity_killed)
                                    .unwrap_or(-1);
                            let kind = obj_kind_by_idx
                                .get(&killed_idx)
                                .copied()
                                .unwrap_or("objective");
                            // Mark it dead for the live overlay (drop after this
                            // tick). First death wins.
                            obj_death_tick.entry(killed_idx).or_insert(event.tick);
                            let killer_pawn =
                                boon::protobuf_handle_index(msg.entity_killer)
                                    .unwrap_or(-1);
                            let (x, y) = msg
                                .entity_position
                                .map(|v| {
                                    (Some(v.x.unwrap_or(0.0)), Some(v.y.unwrap_or(0.0)))
                                })
                                .unwrap_or((None, None));
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: event.tick,
                                kind,
                                team: msg.objective_team.unwrap_or(-1),
                                killer_pawn,
                                x,
                                y,
                            });
                        } else if event.msg_type == Msg::KEUserMsgChatMsg as u32
                            && let Ok(msg) = CCitadelUserMsgChatMsg::decode(
                                event.payload.as_slice(),
                            )
                        {
                            // Player chat. `player_slot` maps to a hero via
                            // slot_to_hero (same as item purchases); resolved
                            // after the walk. all_chat distinguishes global vs
                            // team chat.
                            let text = msg.text.unwrap_or_default();
                            if !text.trim().is_empty() {
                                chat_events_raw.push(RawChatEvent {
                                    tick: event.tick,
                                    player_slot: msg.player_slot.unwrap_or(-1),
                                    all_chat: msg.all_chat.unwrap_or(false),
                                    text,
                                });
                            }
                        }
                    }
                }

                if let Some(last) = last_emitted
                    && ctx.tick - last < step
                {
                    return;
                }

                // --- Live objective roster + sparse health (sampled cadence) ---
                for (&idx, entity) in ctx.entities.iter() {
                    let Some(class) = OBJ_CLASSES
                        .iter()
                        .copied()
                        .find(|c| *c == entity.class_name.as_str())
                    else {
                        continue;
                    };
                    if !obj_keys.contains_key(class) {
                        if let Some(s) = ctx.serializers.get(class) {
                            obj_keys.insert(class, resolve_obj_keys(s));
                        } else {
                            continue;
                        }
                    }
                    let keys = &obj_keys[class];
                    let health = get_i64(entity, keys.health) as i32;
                    let max_health = get_i64(entity, keys.max_health) as i32;
                    let team = get_i64(entity, keys.team) as i32;
                    let cx = get_i64(entity, keys.cell_x) as i32;
                    let cy = get_i64(entity, keys.cell_y) as i32;
                    let wx = cell_to_world(cx, get_f32(entity, keys.vec_x));
                    let wy = cell_to_world(cy, get_f32(entity, keys.vec_y));

                    obj_roster.entry(idx).or_insert_with(|| ObjectiveBuild {
                        kind: objective_kind(&entity.class_name),
                        team,
                        x: wx,
                        y: wy,
                        max_health,
                        spawn_tick: ctx.tick,
                    });

                    // Sparse health: record only when (health, max) changes.
                    if max_health > 0 && obj_last_hp.get(&idx) != Some(&(health, max_health))
                    {
                        obj_last_hp.insert(idx, (health, max_health));
                        obj_health_events.push(ObjectiveHealthEvent {
                            tick: ctx.tick,
                            id: idx,
                            health,
                            max_health,
                        });
                    }
                }

                // --- Neutral camps (sampled cadence) ---
                if !neutral_keys_resolved
                    && let Some(s) = ctx.serializers.get(NEUTRAL_CLASS)
                {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    nk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    nk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    nk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    nk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    nk_max_health = s.resolve_field_key("m_iMaxHealth");
                    nk_life = s.resolve_field_key("m_lifeState");
                    neutral_keys_resolved = true;
                }
                if neutral_keys_resolved {
                    // Gather this tick's neutral creeps once.
                    let mut neutrals: Vec<(i32, f32, f32, bool, u8)> = Vec::new();
                    for (&idx, e) in ctx.entities.iter() {
                        if e.class_name != NEUTRAL_CLASS {
                            continue;
                        }
                        let x = cell_to_world(
                            get_i64(e, nk_cell_x) as i32,
                            get_f32(e, nk_vec_x),
                        );
                        let y = cell_to_world(
                            get_i64(e, nk_cell_y) as i32,
                            get_f32(e, nk_vec_y),
                        );
                        let alive = get_i64(e, nk_life) == 0;
                        let tier = neutral_tier(get_i64(e, nk_max_health) as i32);
                        neutrals.push((idx, x, y, alive, tier));
                    }

                    // Roster: cluster each creep's first-seen (≈ spawn) position.
                    // Spawn positions are exact, so clustering them is stable
                    // (live positions drift when creeps aggro).
                    for &(idx, x, y, _, tier) in &neutrals {
                        if !seen_creeps.insert(idx) {
                            continue;
                        }
                        let nearest = nearest_camp(&camps, x, y);
                        match nearest {
                            Some(i) => {
                                let c = &mut camps[i];
                                let n = c.spots as f32;
                                c.x = (c.x * n + x) / (n + 1.0);
                                c.y = (c.y * n + y) / (n + 1.0);
                                c.spots += 1;
                                if tier > c.size {
                                    c.size = tier;
                                }
                            }
                            None => camps.push(CampBuild {
                                x,
                                y,
                                spots: 1,
                                size: tier,
                                up: false,
                            }),
                        }
                    }

                    // Occupancy: a live creep marks its nearest camp "up".
                    let mut occupied = vec![false; camps.len()];
                    for &(_, x, y, alive, _) in &neutrals {
                        if !alive {
                            continue;
                        }
                        if let Some(i) = nearest_camp(&camps, x, y) {
                            occupied[i] = true;
                        }
                    }
                    for (i, c) in camps.iter_mut().enumerate() {
                        if occupied[i] != c.up {
                            c.up = occupied[i];
                            camp_state_events.push(CampStateEvent {
                                tick: ctx.tick,
                                camp_id: i as u32,
                                up: occupied[i],
                            });
                        }
                    }
                }

                // Build a hero_id → controller_stats map for this tick.
                let mut stats_by_hero: HashMap<i64, PlayerStats> = HashMap::new();
                if ctrl_keys_resolved {
                    for (_, entity) in ctx.entities.iter() {
                        if entity.class_name != CONTROLLER_CLASS {
                            continue;
                        }
                        let hero_id = get_i64(entity, ck_hero);
                        if hero_id == 0 {
                            continue;
                        }
                        // Sum each stat-modifier slot's m_flValue into the
                        // appropriate cumulative bucket (eValType identifies
                        // which stat the slot is contributing to).
                        let mut bonus_health = 0.0_f32;
                        let mut spirit_power = 0.0_f32;
                        let mut fire_rate = 0.0_f32;
                        let mut weapon_damage = 0.0_f32;
                        let mut cooldown_reduction = 0.0_f32;
                        let mut ammo = 0.0_f32;
                        for (vt_key, val_key) in &ck_stat_keys {
                            let vt = get_i64(entity, *vt_key) as u32;
                            if vt == 0 {
                                continue;
                            }
                            let v = get_f32(entity, *val_key);
                            // These ids are EModifierValue enum values. They are
                            // NOT in GameTracking/boon-proto, so they can't be
                            // auto-synced — after a game update, verify them with
                            // scripts/check-modifier-values.ts against a schema
                            // dump. This match is the source of truth.
                            match vt {
                                31 => bonus_health += v,
                                51 => spirit_power += v,
                                79 => fire_rate += v,
                                18 => weapon_damage += v,
                                109 => cooldown_reduction += v,
                                172 => ammo += v,
                                _ => {}
                            }
                        }
                        stats_by_hero.insert(
                            hero_id,
                            PlayerStats {
                                net_worth: get_i64(entity, ck_net_worth) as i32,
                                ap_net_worth: get_i64(entity, ck_ap_net_worth) as i32,
                                kills: get_i64(entity, ck_kills) as i32,
                                deaths: get_i64(entity, ck_deaths) as i32,
                                assists: get_i64(entity, ck_assists) as i32,
                                hero_damage: get_i64(entity, ck_damage) as i32,
                                hero_healing: get_i64(entity, ck_healing) as i32,
                                health_max: get_i64(entity, ck_health_max) as i32,
                                bonus_health,
                                spirit_power,
                                fire_rate,
                                weapon_damage,
                                cooldown_reduction,
                                ammo,
                            },
                        );

                        // Ability upgrades. Each non-empty slot is one of the
                        // hero's abilities; m_nUpgradeInfo packs the spent
                        // upgrade tiers as a bitmask in bits 17+, so the popcount
                        // of (raw >> 17) is the level (0 = unlocked/no tiers, up
                        // to 3). We capture the constant per-hero ability set
                        // once and log only level *increases* as events.
                        let mut slots: Vec<AbilitySlot> = Vec::new();
                        for (slot_idx, (item_key, bits_key)) in
                            ck_ability_keys.iter().enumerate()
                        {
                            let ability_id = get_i64(entity, *item_key) as u32;
                            if ability_id == 0 {
                                continue;
                            }
                            slots.push(AbilitySlot {
                                ability_id,
                                ability_name: boon::ability_name(ability_id)
                                    .to_string(),
                            });
                            let raw = get_i64(entity, *bits_key);
                            let level = ((raw >> 17) as i32).count_ones() as i32;
                            let prev = ability_prev_level
                                .get(&(hero_id, slot_idx))
                                .copied()
                                .unwrap_or(0);
                            if level > prev {
                                ability_prev_level
                                    .insert((hero_id, slot_idx), level);
                                ability_upgrade_events.push(AbilityUpgradeEvent {
                                    tick: ctx.tick,
                                    hero_id,
                                    ability_id,
                                    level,
                                });
                            }
                        }
                        // Keep the fullest ability set seen (slots populate over
                        // the first few frames; this converges without churn).
                        let better = ability_slots
                            .get(&hero_id)
                            .map(|cur| slots.len() > cur.len())
                            .unwrap_or(true);
                        if better && !slots.is_empty() {
                            ability_slots.insert(hero_id, slots);
                        }
                    }
                }

                let mut players: Vec<PlayerPosition> = Vec::new();
                for (&idx, entity) in ctx.entities.iter() {
                    if entity.class_name != PAWN_CLASS {
                        continue;
                    }

                    let team = get_i64(entity, pk_team);

                    let hero = get_i64(entity, pk_hero);
                    if hero != 0 {
                        pawn_to_hero.insert(idx, hero);
                    }
                    let hero_id = pawn_to_hero.get(&idx).copied().unwrap_or(0);

                    // Cell + offset are combined into world x/y here; the raw
                    // components and z aren't used downstream, so they stay out
                    // of the serialized frame to keep the frames array small.
                    let raw_x = get_f32(entity, pk_x);
                    let raw_y = get_f32(entity, pk_y);
                    let cx = get_i64(entity, pk_cell_x) as i32;
                    let cy = get_i64(entity, pk_cell_y) as i32;

                    let stats = stats_by_hero
                        .get(&hero_id)
                        .copied()
                        .unwrap_or_default();

                    // Look direction: QAngle is [pitch, yaw, roll] in degrees.
                    let eye = get_qangle(entity, pk_eye);
                    let pitch = eye.map(|a| a[0]).unwrap_or(0.0);
                    let yaw = eye.map(|a| a[1]).unwrap_or(0.0);

                    players.push(PlayerPosition {
                        slot: idx,
                        team,
                        hero_id,
                        alive: get_i64(entity, pk_life) == 0,
                        x: cell_to_world(cx, raw_x),
                        y: cell_to_world(cy, raw_y),
                        yaw,
                        pitch,
                        health: get_i64(entity, pk_health) as i32,
                        // Prefer the controller's effective max; fall back to
                        // the pawn's base max for heroes without a controller
                        // entity yet (m_iHealthMax not populated).
                        max_health: if stats.health_max > 0 {
                            stats.health_max
                        } else {
                            get_i64(entity, pk_max_health) as i32
                        },
                        net_worth: stats.net_worth,
                        ap_net_worth: stats.ap_net_worth,
                        kills: stats.kills,
                        deaths: stats.deaths,
                        assists: stats.assists,
                        hero_damage: stats.hero_damage,
                        hero_healing: stats.hero_healing,
                        bonus_health: stats.bonus_health,
                        spirit_power: stats.spirit_power,
                        fire_rate: stats.fire_rate,
                        weapon_damage: stats.weapon_damage,
                        cooldown_reduction: stats.cooldown_reduction,
                        ammo: stats.ammo,
                    });
                }

                if players.is_empty() {
                    return;
                }

                // Lane troopers: pack each alive one into the frame.
                if !trooper_keys_resolved
                    && let Some(s) = ctx.serializers.get(TROOPER_CLASS)
                {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    tk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    tk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    tk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    tk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    tk_team = s.resolve_field_key("m_iTeamNum");
                    tk_life = s.resolve_field_key("m_lifeState");
                    trooper_keys_resolved = true;
                }
                let mut troopers: Vec<i32> = Vec::new();
                if trooper_keys_resolved {
                    for (_, e) in ctx.entities.iter() {
                        if e.class_name != TROOPER_CLASS || get_i64(e, tk_life) != 0 {
                            continue;
                        }
                        let x = cell_to_world(
                            get_i64(e, tk_cell_x) as i32,
                            get_f32(e, tk_vec_x),
                        );
                        let y = cell_to_world(
                            get_i64(e, tk_cell_y) as i32,
                            get_f32(e, tk_vec_y),
                        );
                        troopers.push(pack_trooper(x, y, get_i64(e, tk_team)));
                    }
                }

                // Urn(s): plot each live idol entity's world position. Flat
                // [x0, y0, x1, y1, …] (usually 0–1 present, briefly 2 during a
                // handoff). The idol keys are resolved by the spawn-tracking
                // block above once the first urn appears.
                let mut urns: Vec<f32> = Vec::new();
                for (_, e) in ctx.entities.iter() {
                    if e.class_name != IDOL_CLASS {
                        continue;
                    }
                    let x = cell_to_world(
                        get_i64(e, idk_cell_x) as i32,
                        get_f32(e, idk_vec_x),
                    );
                    let y = cell_to_world(
                        get_i64(e, idk_cell_y) as i32,
                        get_f32(e, idk_vec_y),
                    );
                    urns.push(x);
                    urns.push(y);
                }
                // No world entity but someone's carrying it → plot it on the
                // carrier so the urn stays visible through the carry.
                if urns.is_empty()
                    && let Some(cp) = carrier_pawn
                    && let Some(e) = ctx.entities.get(cp)
                    && e.class_name == PAWN_CLASS
                {
                    urns.push(cell_to_world(
                        get_i64(e, pk_cell_x) as i32,
                        get_f32(e, pk_x),
                    ));
                    urns.push(cell_to_world(
                        get_i64(e, pk_cell_y) as i32,
                        get_f32(e, pk_y),
                    ));
                }

                last_emitted = Some(ctx.tick);
                frames.push(PositionFrame {
                    tick: ctx.tick,
                    reg_ticks: active_ticks,
                    players,
                    troopers,
                    urns,
                });
            })
            .map_err(to_js_error)?;

        // Final 100% tick so the progress bar lands on full.
        let _ = progress.call2(
            &JsValue::NULL,
            &JsValue::from(total_ticks),
            &JsValue::from(total_ticks),
        );

        // Close a pause that was still open when the recording ended.
        if let Some(start) = cur_pause_start.take() {
            let end = prev_tick.unwrap_or(start);
            pause_intervals.push(PauseInterval { start, end });
        }

        // Resolve raw item events to hero-keyed events. Drop events whose
        // slot we never saw (rare; mostly events fired before a controller
        // had a hero assigned) and anything outside the changes we care
        // about. We keep purchased / upgraded / sold for current-inventory
        // reconstruction on the JS side.
        let mut item_events: Vec<ItemEvent> = Vec::with_capacity(item_events_raw.len());
        for raw in item_events_raw {
            let hero_id = match slot_to_hero.get(&raw.player_slot).copied() {
                Some(h) => h,
                None => continue,
            };
            let kind = match raw.change {
                0 => "purchased",
                1 => "upgraded",
                2 => "sold",
                _ => continue,
            };
            item_events.push(ItemEvent {
                tick: raw.tick,
                hero_id,
                ability_id: raw.ability_id,
                ability_name: boon::ability_name(raw.ability_id).to_string(),
                change: kind.to_string(),
            });
        }

        // Resolve raw kill events via pawn_to_hero. Drop entries we can't
        // attribute on either side.
        let mut kill_events: Vec<KillEvent> = Vec::with_capacity(kill_events_raw.len());
        for raw in kill_events_raw {
            let victim_hero_id = match pawn_to_hero.get(&raw.victim_pawn).copied() {
                Some(h) => h,
                None => continue,
            };
            let attacker_hero_id =
                pawn_to_hero.get(&raw.attacker_pawn).copied().unwrap_or(0);
            kill_events.push(KillEvent {
                tick: raw.tick,
                attacker_hero_id,
                victim_hero_id,
                x: raw.x,
                y: raw.y,
            });
        }

        // Resolve important-ability-used events to hero IDs via pawn_to_hero.
        let mut ability_events: Vec<AbilityEvent> =
            Vec::with_capacity(ability_events_raw.len());
        for raw in ability_events_raw {
            let hero_id = match pawn_to_hero.get(&raw.pawn).copied() {
                Some(h) => h,
                None => continue,
            };
            ability_events.push(AbilityEvent {
                tick: raw.tick,
                hero_id,
                ability_name: raw.ability_name,
            });
        }

        // Resolve chat senders to hero IDs via slot_to_hero (same slot space as
        // item purchases). Unresolved senders (spectators) keep hero_id 0.
        let chat_events: Vec<ChatEvent> = chat_events_raw
            .into_iter()
            .map(|raw| ChatEvent {
                tick: raw.tick,
                hero_id: slot_to_hero.get(&raw.player_slot).copied().unwrap_or(0),
                all_chat: raw.all_chat,
                text: raw.text,
            })
            .collect();

        // Per-hero ability sets, sorted by hero_id for a stable order.
        let mut ability_slots_out: Vec<HeroAbilities> = ability_slots
            .into_iter()
            .map(|(hero_id, abilities)| HeroAbilities { hero_id, abilities })
            .collect();
        ability_slots_out.sort_by_key(|h| h.hero_id);

        // Resolve objective killers (entity handle → pawn → hero). Non-player
        // killers (troopers, self-destructs) resolve to 0.
        let objective_events: Vec<ObjectiveEvent> = objective_events_raw
            .into_iter()
            .map(|raw| {
                let killer_hero_id = if raw.killer_pawn > 0 {
                    pawn_to_hero.get(&raw.killer_pawn).copied().unwrap_or(0)
                } else {
                    0
                };
                ObjectiveEvent {
                    tick: raw.tick,
                    kind: raw.kind.to_string(),
                    team: raw.team,
                    killer_hero_id,
                    x: raw.x,
                    y: raw.y,
                }
            })
            .collect();

        // Objective roster, folding in death ticks; sorted by id for stability.
        let mut objectives: Vec<ObjectiveInfo> = obj_roster
            .into_iter()
            .map(|(id, b)| ObjectiveInfo {
                id,
                kind: b.kind.to_string(),
                team: b.team,
                x: b.x,
                y: b.y,
                max_health: b.max_health,
                spawn_tick: b.spawn_tick,
                death_tick: obj_death_tick.get(&id).copied(),
            })
            .collect();
        objectives.sort_by_key(|o| o.id);

        // Neutral camp roster (id = index, matching camp_state_events.camp_id).
        let neutral_camps: Vec<NeutralCamp> = camps
            .iter()
            .enumerate()
            .map(|(i, c)| NeutralCamp {
                id: i as u32,
                x: c.x,
                y: c.y,
                size: c.size,
            })
            .collect();

        let result = PositionsResult {
            paths: resolved_paths.unwrap_or_default(),
            frames,
            item_events,
            kill_events,
            ability_events,
            ability_slots: ability_slots_out,
            ability_upgrade_events,
            objective_events,
            objectives,
            objective_health: obj_health_events,
            neutral_camps,
            camp_state_events,
            chat_events,
            pause_intervals,
            game_over_tick,
            regulation_ticks,
        };
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

#[derive(Serialize)]
struct PositionsResult {
    paths: ResolvedPaths,
    frames: Vec<PositionFrame>,
    item_events: Vec<ItemEvent>,
    kill_events: Vec<KillEvent>,
    /// Important-ability-used events (ults / signature abilities).
    ability_events: Vec<AbilityEvent>,
    /// Each hero's signature abilities (constant), for the player ability panel.
    ability_slots: Vec<HeroAbilities>,
    /// Sparse ability upgrade-tier increases; reconstructed per tick like items.
    ability_upgrade_events: Vec<AbilityUpgradeEvent>,
    /// Objective destructions + Mid-Boss kill, in tick order.
    objective_events: Vec<ObjectiveEvent>,
    /// Constant roster of objectives (position, kind, team, max health, spawn /
    /// death ticks) for the live map overlay.
    objectives: Vec<ObjectiveInfo>,
    /// Sparse objective health samples; reconstructed per tick like items.
    objective_health: Vec<ObjectiveHealthEvent>,
    /// Neutral jungle camps (clustered from creep spawns), for the map overlay.
    neutral_camps: Vec<NeutralCamp>,
    /// Sparse camp up/down transitions; reconstructed per tick.
    camp_state_events: Vec<CampStateEvent>,
    /// Player chat (all + team), in tick order.
    chat_events: Vec<ChatEvent>,
    /// Tick ranges during which the match was paused.
    pause_intervals: Vec<PauseInterval>,
    /// Tick of the first GameOver user message, if the demo contains one.
    game_over_tick: Option<i32>,
    /// Active (non-paused) ticks from the start of the recording up to
    /// `game_over_tick` — the regulation duration. `None` without a GameOver.
    regulation_ticks: Option<i32>,
}

#[derive(Serialize)]
struct PauseInterval {
    start: i32,
    end: i32,
}

struct RawItemEvent {
    tick: i32,
    player_slot: i32,
    ability_id: u32,
    change: i32,
}

#[derive(Serialize)]
struct ItemEvent {
    tick: i32,
    hero_id: i64,
    ability_id: u32,
    ability_name: String,
    change: String,
}

struct RawKillEvent {
    tick: i32,
    victim_pawn: i32,
    attacker_pawn: i32,
    x: f32,
    y: f32,
}

#[derive(Serialize)]
struct KillEvent {
    tick: i32,
    attacker_hero_id: i64,
    victim_hero_id: i64,
    x: f32,
    y: f32,
}

struct RawAbilityEvent {
    tick: i32,
    pawn: i32,
    ability_name: String,
}

#[derive(Serialize)]
struct AbilityEvent {
    tick: i32,
    hero_id: i64,
    ability_name: String,
}

struct RawObjectiveEvent {
    tick: i32,
    kind: &'static str,
    team: i32,
    killer_pawn: i32,
    x: Option<f32>,
    y: Option<f32>,
}

struct RawChatEvent {
    tick: i32,
    player_slot: i32,
    all_chat: bool,
    text: String,
}

/// A player chat message. `hero_id` is the sender (0 if unresolved); `all_chat`
/// is true for global chat, false for team-only.
#[derive(Serialize)]
struct ChatEvent {
    tick: i32,
    hero_id: i64,
    all_chat: bool,
    text: String,
}

/// An objective destruction. `kind` is a stable slug ("guardian", "walker",
/// "shrine", "base_guardian", "patron", "mid_boss"); `team` is the
/// losing/owning team (−1/4 for the neutral Mid-Boss). `x`/`y` are world-space.
#[derive(Serialize)]
struct ObjectiveEvent {
    tick: i32,
    kind: String,
    team: i32,
    killer_hero_id: i64,
    x: Option<f32>,
    y: Option<f32>,
}

/// Resolved field keys for an objective entity's networked position + health.
struct ObjKeys {
    cell_x: Option<u64>,
    vec_x: Option<u64>,
    cell_y: Option<u64>,
    vec_y: Option<u64>,
    health: Option<u64>,
    max_health: Option<u64>,
    team: Option<u64>,
}

fn resolve_obj_keys(s: &Serializer) -> ObjKeys {
    // Objectives carry their transform on the body component's scene node.
    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
    ObjKeys {
        cell_x: s.resolve_field_key(&format!("{o}.m_cellX")),
        vec_x: s.resolve_field_key(&format!("{o}.m_vecX")),
        cell_y: s.resolve_field_key(&format!("{o}.m_cellY")),
        vec_y: s.resolve_field_key(&format!("{o}.m_vecY")),
        health: s.resolve_field_key("m_iHealth"),
        max_health: s.resolve_field_key("m_iMaxHealth"),
        team: s.resolve_field_key("m_iTeamNum"),
    }
}

/// Roster build state for one objective (constant for the match).
struct ObjectiveBuild {
    kind: &'static str,
    team: i32,
    x: f32,
    y: f32,
    max_health: i32,
    spawn_tick: i32,
}

/// One objective for the live map overlay. `death_tick` is None if it survived.
#[derive(Serialize)]
struct ObjectiveInfo {
    id: i32,
    kind: String,
    team: i32,
    x: f32,
    y: f32,
    max_health: i32,
    spawn_tick: i32,
    death_tick: Option<i32>,
}

/// A sparse objective health sample (recorded only when it changes).
#[derive(Serialize)]
struct ObjectiveHealthEvent {
    tick: i32,
    id: i32,
    health: i32,
    max_health: i32,
}

/// Index of the nearest camp within CAMP_RADIUS of (x, y), or None.
fn nearest_camp(camps: &[CampBuild], x: f32, y: f32) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut best_d = CAMP_RADIUS * CAMP_RADIUS;
    for (i, c) in camps.iter().enumerate() {
        let d = (c.x - x).powi(2) + (c.y - y).powi(2);
        if d < best_d {
            best_d = d;
            best = Some(i);
        }
    }
    best
}

/// Accumulating build state for one neutral camp (centroid is a running mean of
/// member spawn positions; `size` is the largest creep tier seen).
struct CampBuild {
    x: f32,
    y: f32,
    spots: u32,
    size: u8,
    up: bool,
}

/// A neutral camp for the map overlay. `size` is 1/2/3 (small/medium/large) and
/// drives the chevron count.
#[derive(Serialize)]
struct NeutralCamp {
    id: u32,
    x: f32,
    y: f32,
    size: u8,
}

/// A point at which a camp came up (spawned) or went down (cleared).
#[derive(Serialize)]
struct CampStateEvent {
    tick: i32,
    camp_id: u32,
    up: bool,
}

#[derive(Default, Serialize)]
struct ResolvedPaths {
    vec_x: Option<String>,
    vec_y: Option<String>,
    vec_z: Option<String>,
    cell_x: Option<String>,
    cell_y: Option<String>,
    cell_z: Option<String>,
    team: Option<String>,
    life: Option<String>,
}

#[derive(Serialize)]
struct PlayerInfo {
    name: String,
    hero_id: i64,
    hero_name: String,
    team: i32,
}

#[derive(Serialize)]
struct PositionFrame {
    tick: i32,
    /// Active (non-paused) ticks elapsed at this frame — the regulation clock.
    reg_ticks: i32,
    players: Vec<PlayerPosition>,
    /// Alive lane troopers, packed (see pack_trooper) to keep frames compact.
    troopers: Vec<i32>,
    /// Live urn (Idol) world positions, flat [x0, y0, x1, y1, …].
    urns: Vec<f32>,
}

#[derive(Serialize)]
struct PlayerPosition {
    slot: i32,
    team: i64,
    hero_id: i64,
    alive: bool,
    x: f32,
    y: f32,
    /// Look angles in degrees from m_angEyeAngles: yaw is the horizontal facing
    /// (0 = +X / east, CCW), pitch is the vertical look (wraps 0..360).
    yaw: f32,
    pitch: f32,
    health: i32,
    max_health: i32,
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    hero_healing: i32,
    bonus_health: f32,
    spirit_power: f32,
    fire_rate: f32,
    weapon_damage: f32,
    cooldown_reduction: f32,
    ammo: f32,
}

/// One of a hero's signature abilities (constant for the match), emitted once
/// per hero in PositionsResult.ability_slots in slot order.
#[derive(Serialize, Clone)]
struct AbilitySlot {
    ability_id: u32,
    ability_name: String,
}

#[derive(Serialize)]
struct HeroAbilities {
    hero_id: i64,
    abilities: Vec<AbilitySlot>,
}

/// A point at which an ability's spent upgrade tier increased (0 → up to 3).
/// Sparse — the frontend reconstructs the current level at the playback tick.
#[derive(Serialize)]
struct AbilityUpgradeEvent {
    tick: i32,
    hero_id: i64,
    ability_id: u32,
    level: i32,
}

#[derive(Default, Clone, Copy)]
struct PlayerStats {
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    hero_healing: i32,
    health_max: i32,
    bonus_health: f32,
    spirit_power: f32,
    fire_rate: f32,
    weapon_damage: f32,
    cooldown_reduction: f32,
    ammo: f32,
}

fn get_i64(e: &boon::Entity, key: Option<u64>) -> i64 {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::U32(n) => Some(*n as i64),
            boon::FieldValue::U64(n) => Some(*n as i64),
            boon::FieldValue::I32(n) => Some(*n as i64),
            boon::FieldValue::I64(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0)
}

fn get_f32(e: &boon::Entity, key: Option<u64>) -> f32 {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::F32(f) => Some(*f),
            _ => None,
        })
        .unwrap_or(0.0)
}

/// Read a QAngle / Vector3 field as `[x, y, z]` (degrees for angles).
fn get_qangle(e: &boon::Entity, key: Option<u64>) -> Option<[f32; 3]> {
    key.and_then(|k| e.fields.get(&k)).and_then(|v| match v {
        boon::FieldValue::QAngle(a) => Some(*a),
        boon::FieldValue::Vector3(a) => Some(*a),
        _ => None,
    })
}

fn get_string(e: &boon::Entity, key: Option<u64>) -> String {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::String(bytes) => {
                Some(String::from_utf8_lossy(bytes).into_owned())
            }
            _ => None,
        })
        .unwrap_or_default()
}

const CELL_BITS: u32 = 9;
const CELL_SIZE: f32 = (1 << CELL_BITS) as f32;
const WORLD_HALF: f32 = 16384.0;

fn cell_to_world(cell: i32, offset: f32) -> f32 {
    (cell as f32) * CELL_SIZE - WORLD_HALF + offset
}

fn walk_fields(s: &Serializer, prefix: &str, out: &mut Vec<String>) {
    for f in &s.fields {
        let mut name = String::with_capacity(prefix.len() + 32);
        if !prefix.is_empty() {
            name.push_str(prefix);
            name.push('.');
        }
        if let Some(sn) = f.send_node.as_deref()
            && !sn.is_empty()
        {
            name.push_str(sn);
            name.push('.');
        }
        name.push_str(&f.var_name);
        out.push(name.clone());
        if let Some(inner) = &f.field_serializer {
            walk_fields(inner, &name, out);
        }
    }
}

fn to_js_error(e: boon::Error) -> JsError {
    JsError::new(&e.to_string())
}
