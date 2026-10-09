import { CARS, SERIES, UPGRADES, AI_DRIVERS, AI_COLORS, POINTS, upgradeCost, effectiveStats, getCar, getSeries } from './data.js';
import { levelForXp } from './worlddef.js';

const KEY = 'turbotour.save.v1';
const OLD_KEY = 'apexrush.save.v1'; // pre-rename save, migrated once on load

export function defaultProfile() {
  return {
    name: 'You', money: 5000, cars: ['hatch'], selected: 'hatch', colorIndex: 0,
    upgrades: { hatch: { engine: 0, tires: 0, brakes: 0, aero: 0 } },
    series: {}, stats: { races: 0, wins: 0, podiums: 0, earned: 0 },
    bestLaps: {},
    settings: { quality: 'high', volume: 0.7, sound: true, p1Control: 'wasd', p2Control: 'arrows' },
    horizon: defaultHorizon(),
  };
}

/**
 * Free Roam progress: XP, best ratings per skill marker, collected boards, event results,
 * saved position, and where the player is in the first-drive guide ('new' → 'garage' →
 * 'event' → 'done'; null = not decided yet, see Horizon).
 */
export function defaultHorizon() {
  return { xp: 0, traps: {}, drifts: {}, zones: {}, boards: [], events: {}, discovered: [], pos: null, stats: { distance: 0 }, guide: null };
}

export function loadProfile() {
  try {
    if (localStorage.getItem(KEY) === null) {
      const old = localStorage.getItem(OLD_KEY);
      if (old !== null) localStorage.setItem(KEY, old);
    }
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProfile();
    const p = JSON.parse(raw);
    const d = defaultProfile();
    const hz = { ...d.horizon, ...(p.horizon || {}) };
    hz.stats = { ...d.horizon.stats, ...(hz.stats || {}) };
    return { ...d, ...p, settings: { ...d.settings, ...(p.settings || {}) }, stats: { ...d.stats, ...(p.stats || {}) }, horizon: hz };
  } catch (e) { return defaultProfile(); }
}

export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
}

export function resetProfile() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } return defaultProfile(); }

export function seriesState(profile, id) {
  if (!profile.series[id]) profile.series[id] = { event: 0, points: {}, complete: false, finalRank: null, results: [] };
  return profile.series[id];
}

/** Why a championship is locked ({ rank, level } flags), or null when it is open. */
export function seriesLock(profile, series) {
  const st = profile.series[series.id];
  if (st && (st.event > 0 || st.complete)) return null;      // already started: never lock it again
  const req = series.requires ? profile.series[series.requires] : null;
  const rank = !!series.requires && !(req && req.complete && req.finalRank !== null && req.finalRank <= series.requireRank);
  const level = levelForXp((profile.horizon || {}).xp || 0).level < (series.level || 1);
  return rank || level ? { rank, level } : null;
}

export function isSeriesUnlocked(profile, series) { return !seriesLock(profile, series); }

export function playerStats(profile, carId = profile.selected) {
  const car = getCar(carId);
  return effectiveStats(car, profile.upgrades[carId] || {});
}

export function canBuyUpgrade(profile, carId, upId) {
  const car = getCar(carId);
  const lvl = (profile.upgrades[carId] || {})[upId] || 0;
  const up = UPGRADES.find(u => u.id === upId);
  if (lvl >= up.maxLevel) return { ok: false, reason: 'MAX', cost: 0 };
  const cost = upgradeCost(car, upId, lvl);
  return { ok: profile.money >= cost, cost, reason: profile.money >= cost ? '' : 'Not enough credits' };
}

export function buyUpgrade(profile, carId, upId) {
  const r = canBuyUpgrade(profile, carId, upId);
  if (!r.ok) return false;
  profile.money -= r.cost;
  profile.upgrades[carId] = profile.upgrades[carId] || { engine: 0, tires: 0, brakes: 0, aero: 0 };
  profile.upgrades[carId][upId] = (profile.upgrades[carId][upId] || 0) + 1;
  saveProfile(profile);
  return true;
}

export function buyCar(profile, carId) {
  const car = getCar(carId);
  if (profile.cars.includes(carId) || profile.money < car.price) return false;
  profile.money -= car.price;
  profile.cars.push(carId);
  profile.upgrades[carId] = { engine: 0, tires: 0, brakes: 0, aero: 0 };
  profile.selected = carId;
  saveProfile(profile);
  return true;
}

/** Standings for a series: [{name, points, isPlayer}] sorted. */
export function standings(profile, seriesId) {
  const st = seriesState(profile, seriesId);
  const rows = Object.entries(st.points).map(([name, points]) => ({ name, points, isPlayer: name === profile.name }));
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  return rows;
}

/** Build the AI field for a series (consistent across its events). */
export function seriesField(series) {
  const tierCar = ['hatch', 'gt', 'proto', 'formula'][series.tier - 1] || 'formula';
  const lvl = Math.min(5, series.tier - 1);
  const baseStats = effectiveStats(getCar(tierCar), { engine: lvl, tires: lvl, brakes: lvl, aero: lvl });
  return AI_DRIVERS.slice(0, series.aiCount).map((d, i) => {
    const skill = series.aiSkill * d.skill;
    const stats = { ...baseStats, maxSpeed: baseStats.maxSpeed * (0.86 + 0.14 * skill), accel: baseStats.accel * (0.88 + 0.12 * skill), grip: baseStats.grip * (0.9 + 0.1 * skill) };
    return { name: d.name, skill, color: AI_COLORS[i % AI_COLORS.length], stats, shape: getCar(tierCar).shape };
  });
}

/** Generic AI field for quick races. difficulty 0..1 */
export function quickField(count, difficulty, carId) {
  const car = getCar(carId);
  const lvl = Math.round(difficulty * 4);
  const base = effectiveStats(car, { engine: lvl, tires: lvl, brakes: lvl, aero: lvl });
  return AI_DRIVERS.slice(0, count).map((d, i) => {
    const skill = (0.72 + difficulty * 0.34) * d.skill;
    const stats = { ...base, maxSpeed: base.maxSpeed * (0.88 + 0.14 * skill), accel: base.accel * (0.9 + 0.12 * skill), grip: base.grip * (0.9 + 0.1 * skill) };
    return { name: d.name, skill, color: AI_COLORS[i % AI_COLORS.length], stats, shape: car.shape };
  });
}

/**
 * Apply a finished career race to the profile.
 * Returns { pointsEarned, money, position, seriesComplete, finalRank, championBonus, unlocked }
 */
export function applyCareerResult(profile, seriesId, results) {
  const series = getSeries(seriesId);
  const st = seriesState(profile, seriesId);
  let summary = { pointsEarned: 0, money: 0, position: 0, seriesComplete: false, finalRank: null, championBonus: 0, unlocked: null };
  for (const r of results) {
    const pts = POINTS[r.rank - 1] || 0;
    const name = r.isPlayer ? profile.name : r.name;
    st.points[name] = (st.points[name] || 0) + pts;
    if (r.isPlayer) {
      summary.pointsEarned = pts;
      summary.position = r.rank;
      summary.money = series.prize[r.rank - 1] || 0;
    }
  }
  profile.money += summary.money;
  profile.stats.earned += summary.money;
  profile.stats.races++;
  if (summary.position === 1) profile.stats.wins++;
  if (summary.position <= 3) profile.stats.podiums++;
  st.results.push({ event: st.event, position: summary.position });
  st.event++;
  if (st.event >= series.events.length) {
    st.complete = true;
    const rows = standings(profile, seriesId);
    st.finalRank = rows.findIndex(r => r.isPlayer) + 1;
    summary.seriesComplete = true;
    summary.finalRank = st.finalRank;
    const bonus = st.finalRank === 1 ? series.bonus : st.finalRank === 2 ? Math.round(series.bonus / 2) : st.finalRank === 3 ? Math.round(series.bonus / 4) : 0;
    summary.championBonus = bonus;
    profile.money += bonus;
    profile.stats.earned += bonus;
    const next = SERIES.find(s => s.requires === seriesId);
    if (next && isSeriesUnlocked(profile, next)) summary.unlocked = next;
  }
  saveProfile(profile);
  return summary;
}

export function restartSeries(profile, seriesId) {
  profile.series[seriesId] = { event: 0, points: {}, complete: false, finalRank: null, results: [] };
  saveProfile(profile);
}

export function recordBestLap(profile, trackId, carId, t) {
  const k = `${trackId}:${carId}`;
  if (t && (!profile.bestLaps[k] || t < profile.bestLaps[k])) { profile.bestLaps[k] = t; saveProfile(profile); return true; }
  return false;
}

export { CARS, SERIES, UPGRADES, getCar, getSeries, upgradeCost, effectiveStats };
