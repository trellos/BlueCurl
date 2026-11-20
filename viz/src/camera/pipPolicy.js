// BlueCurl Swell — automatic picture-in-picture policy (WP7). Pure functions, no three.js, no DOM.
//
// pipStep(state, events, t, pipCfg, heightOf) → new state. Deterministic: the result depends only on the inputs.
// Called once per sim step with the RideEvents that appeared during that step (in emission order).
//
//   takeoff  (cfg.onTakeoff) → open a tile for the rider if a slot is free; when every slot is busy, it may only
//                              replace a tile that is holding after its ride ended (the current ride is kept).
//   barrel   (cfg.onBarrel)  → mark the rider's tile as barrelling, or open a tile; when busy it SWITCHES: replaces
//                              a holding tile, else the oldest tile that is not barrelling itself.
//   rideEnd                  → the rider's tile holds for cfg.holdAfterRide s, then animates out.
//   priority                 → priorityOf(ev) (surfers 2, animals 1): a takeoff may also replace a riding tile of
//                              LOWER priority that is not barrelling (a surfer's ride beats a porpoising dolphin).
//   cfg.minHeight            → takeoff/barrel events whose ride (ZoneBreak H, via heightOf(ev)) is smaller are ignored.
//   cfg.enabled = false      → every tile animates out.  cfg.maxConcurrent = N tiles (stacked away from the corner).
//   ongoing                  → rides still in progress ([{ riderId, frontId, zi, tube, since }]): when a slot is free
//                              after the events, the best one not on screen is picked up (barrel first, then the
//                              earliest take-off), subject to the same trigger switches and minHeight.
//
// Tile { key, slot, riderId, frontId, zi, startedAt, endAt (null while riding), barrel, cut }
//   key   unique per tile (a switch gives the slot a new key → the follow cam restarts)
//   cut   the tile replaced another one in place (no slide-in; the replaced tile is not drawn while leaving)
// state.leaving keeps removed tiles for PIP_ANIM s so they can animate out.

export const PIP_ANIM = 0.3;              // s, slide in / out
export const PIP_MARGIN = 0.022;          // margin to the screen edge, fraction of the screen HEIGHT
export const PIP_GAP = 0.018;             // gap between stacked tiles, fraction of the screen height

export const PIP_DEFAULTS = { enabled: true, onTakeoff: true, onBarrel: true, minHeight: 0.3, maxConcurrent: 1,
  holdAfterRide: 1.5, size: 1 / 3, corner: 'bottom-right' };

export function createPipState() { return { tiles: [], leaving: [], serial: 0 }; }

const lowestFreeSlot = (tiles) => { let s = 0; while (tiles.some((x) => x.slot === s)) s++; return s; };

export function pipStep(prev, events, t, pipCfg = {}, heightOf = () => null, ongoing = [], priorityOf = () => 0) {
  const c = { ...PIP_DEFAULTS, ...(pipCfg || {}) };
  const s = {
    tiles: prev.tiles.map((x) => ({ ...x })),
    leaving: prev.leaving.filter((x) => t - x.leftAt < PIP_ANIM - 1e-9).map((x) => ({ ...x })),
    serial: prev.serial,
  };
  const maxN = c.enabled ? Math.max(0, Math.floor(Number(c.maxConcurrent) || 0)) : 0;
  const remove = (tile, cut = false) => {
    s.tiles.splice(s.tiles.indexOf(tile), 1);
    s.leaving.push({ ...tile, leftAt: t, hidden: cut });
  };
  const add = (ev, slot, cut = false) => {
    const tile = { key: ++s.serial, slot, riderId: ev.riderId, frontId: ev.frontId ?? null, zi: ev.zi ?? -1,
      startedAt: t, endAt: null, barrel: ev.type === 'barrel', cut, prio: priorityOf(ev) || 0 };
    s.tiles.push(tile);
    return tile;
  };

  // holds that ran out, then tiles beyond maxConcurrent (cfg lowered, or disabled): newest go first
  for (const tile of s.tiles.filter((x) => x.endAt != null && t >= x.endAt - 1e-9)) remove(tile);
  while (s.tiles.length > maxN) remove([...s.tiles].sort((a, b) => b.startedAt - a.startedAt || b.key - a.key)[0]);

  for (const ev of events || []) {
    if (!ev || ev.riderId == null) continue;
    const own = s.tiles.find((x) => x.riderId === ev.riderId);
    if (ev.type === 'rideEnd') {
      if (own && own.endAt == null) own.endAt = (ev.t ?? t) + Math.max(0, Number(c.holdAfterRide) || 0);
      continue;
    }
    if (ev.type !== 'takeoff' && ev.type !== 'barrel') continue;
    if (maxN === 0) continue;
    if (ev.type === 'takeoff' && !c.onTakeoff) continue;
    if (ev.type === 'barrel' && !c.onBarrel) continue;
    const H = heightOf(ev);
    if (H != null && Number.isFinite(H) && H < c.minHeight) continue;

    if (own) {                                       // already on screen: a new ride or a barrel within the ride
      if (ev.type === 'takeoff') { own.endAt = null; own.barrel = false; own.frontId = ev.frontId ?? own.frontId; own.zi = ev.zi ?? own.zi; }
      else { own.barrel = true; own.endAt = null; }
      continue;
    }
    if (s.tiles.length < maxN) { add(ev, lowestFreeSlot(s.tiles)); continue; }

    // busy: holding tiles yield to anything; riding tiles only to a barrel, and never one that is barrelling
    const holding = s.tiles.filter((x) => x.endAt != null).sort((a, b) => a.endAt - b.endAt || a.key - b.key);
    let victim = holding[0];
    if (!victim && ev.type === 'barrel') {
      victim = s.tiles.filter((x) => !x.barrel).sort((a, b) => a.startedAt - b.startedAt || a.key - b.key)[0];
    }
    if (!victim && ev.type === 'takeoff') {
      const p = priorityOf(ev) || 0;
      victim = s.tiles.filter((x) => !x.barrel && (x.prio || 0) < p).sort((a, b) => (a.prio || 0) - (b.prio || 0) || a.startedAt - b.startedAt || a.key - b.key)[0];
    }
    if (!victim) continue;
    const slot = victim.slot;
    remove(victim, true);
    add(ev, slot, true);
  }

  // free slots: pick up a ride that is still going (e.g. skipped while the slot was busy)
  if (maxN > 0 && s.tiles.length < maxN && ongoing && ongoing.length) {
    const cands = ongoing.filter((r) => r && r.riderId != null && !s.tiles.some((x) => x.riderId === r.riderId)
      && !s.leaving.some((x) => x.riderId === r.riderId && x.leftAt === t)
      && (r.tube ? (c.onBarrel || c.onTakeoff) : c.onTakeoff)
      && !(Number.isFinite(heightOf(r)) && heightOf(r) < c.minHeight))
      .sort((a, b) => (b.tube ? 1 : 0) - (a.tube ? 1 : 0) || (priorityOf(b) || 0) - (priorityOf(a) || 0)
        || (a.since ?? 0) - (b.since ?? 0) || a.riderId - b.riderId);
    for (const r of cands) {
      if (s.tiles.length >= maxN) break;
      add({ type: r.tube ? 'barrel' : 'takeoff', riderId: r.riderId, frontId: r.frontId, zi: r.zi }, lowestFreeSlot(s.tiles));
    }
  }
  return s;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

/**
 * Tile rectangles at time t (pure function of state, t). aspect = screen width / height.
 * Returns [{ key, slot, riderId, rect: {x,y,w,h} normalized (origin TOP-LEFT, y down), alpha 0..1, phase, startedAt,
 *   barrel, leaving }], drawing order (leaving first). rect may extend past the screen edge while sliding.
 */
export function pipLayout(state, t, pipCfg = {}, aspect = 16 / 9) {
  const c = { ...PIP_DEFAULTS, ...(pipCfg || {}) };
  const size = Math.min(0.9, Math.max(0.05, Number(c.size) || 1 / 3));
  const w = size, h = size;
  const my = PIP_MARGIN, mx = PIP_MARGIN / aspect, gap = PIP_GAP;
  const corner = String(c.corner || 'bottom-right');
  const right = !corner.includes('left'), bottom = !corner.includes('top');
  const base = (slot) => ({
    x: right ? 1 - mx - w : mx,
    y: bottom ? 1 - my - h - slot * (h + gap) : my + slot * (h + gap),
    w, h,
  });
  const out = [];
  const place = (tile, p, phase, leaving) => {
    const r = base(tile.slot), e = easeOut(clamp01(p));
    r.x += (right ? 1 : -1) * (1 - e) * (w + mx);
    out.push({ key: tile.key, slot: tile.slot, riderId: tile.riderId, rect: r, alpha: e, phase,
      startedAt: tile.startedAt, barrel: !!tile.barrel, leaving });
  };
  for (const tile of state.leaving) {
    if (tile.hidden) continue;
    const p = 1 - (t - tile.leftAt) / PIP_ANIM;
    if (p > 0) place(tile, p, 'out', true);
  }
  for (const tile of state.tiles) {
    const p = tile.cut ? 1 : (t - tile.startedAt) / PIP_ANIM;
    place(tile, p, p >= 1 ? (tile.endAt != null ? 'hold' : 'on') : 'in', false);
  }
  return out;
}
