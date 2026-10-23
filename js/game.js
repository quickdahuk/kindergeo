// Game rules: scoring, question selection and star ratings.
// Pure functions only, so they are easy to test (see tests/unit.html).

export const POINTS = { exact: 100, neighbor: 50, continent: 25, miss: 0 };
export const ROUNDS = 10;
// Countries too small to see on the globe (they get a dot when zoomed in) are
// only asked if this many people live there, like Singapore or Bahrain.
export const TINY_MIN_POP = 1e6;

// The region whose places are the US states rather than countries.
export const US_STATES = 'us-states';

export const REGIONS = [
  { id: 'world', label: 'Whole World', emoji: '🌍' },
  { id: 'Africa', label: 'Africa', emoji: '🦁' },
  { id: 'Asia', label: 'Asia', emoji: '🐼' },
  { id: 'Europe', label: 'Europe', emoji: '🏰' },
  { id: 'North America', label: 'North America', emoji: '🦅' },
  { id: 'South America', label: 'South America', emoji: '🦜' },
  { id: 'Oceania', label: 'Oceania', emoji: '🐨' },
  { id: US_STATES, label: 'US States', emoji: '🗽' },
];

// Countries whose provinces, states or districts can be played: the Start
// menu's second page.  Each is a region too, named by the country's code;
// `iso2` gives its flag, and `one` and `many` say what its places are called.
export const COUNTRY_REGIONS = [
  { id: 'CHN', label: 'China', iso2: 'CN', one: 'province', many: 'provinces' },
  { id: 'IND', label: 'India', iso2: 'IN', one: 'state', many: 'states and territories' },
  { id: 'CAN', label: 'Canada', iso2: 'CA', one: 'province', many: 'provinces and territories' },
  { id: 'FRA', label: 'France', iso2: 'FR', one: 'region', many: 'regions' },
  { id: 'GBR', label: 'United Kingdom', iso2: 'GB', one: 'region', many: 'regions' },
  { id: 'DEU', label: 'Germany', iso2: 'DE', one: 'state', many: 'states' },
  { id: 'AUS', label: 'Australia', iso2: 'AU', one: 'state', many: 'states and territories' },
  { id: 'BGD', label: 'Bangladesh', iso2: 'BD', one: 'district', many: 'districts' },
];

/** Is this one of the countries on the Start menu's second page? */
export const isCountryRegion = region => COUNTRY_REGIONS.some(r => r.id === region);

/**
 * The country whose states or provinces a region is made of ('USA' for the
 * US states, 'CHN' for China …), or null when it is made of countries.
 */
export function provinceCountry(region) {
  if (region === US_STATES) return 'USA';
  return isCountryRegion(region) ? region : null;
}

// Countries and states come in three tiers (1 = big and famous, 3 = small or
// less known).  Each level asks from its main tiers and tops up from `fill`
// when a region is small.
export const LEVELS = [
  { id: 'easy', label: 'Easy', emoji: '🐣', main: [1], fill: [2] },
  { id: 'medium', label: 'Medium', emoji: '🦊', main: [1, 2], fill: [3] },
  { id: 'hard', label: 'Hard', emoji: '🦉', main: [2, 3], fill: [1] },
];

/**
 * Score a guess.  `target` and `picked` are places (countries or US states,
 * whose "continent" is their census region); `picked` is null when the
 * player gave up.
 */
export function scoreGuess(target, picked) {
  if (!picked) return { outcome: 'miss', points: POINTS.miss, gaveUp: true };
  if (picked.id === target.id) return { outcome: 'exact', points: POINTS.exact };
  if (target.land.includes(picked.id)) return { outcome: 'neighbor', via: 'land', points: POINTS.neighbor };
  if (target.sea.includes(picked.id)) return { outcome: 'neighbor', via: 'sea', points: POINTS.neighbor };
  const continent = target.cont.find(c => picked.cont.includes(c));
  if (continent) return { outcome: 'continent', continent, points: POINTS.continent };
  return { outcome: 'miss', points: POINTS.miss };
}

/**
 * Is a place part of a region: the world or a continent (countries), the US
 * states, or a country's provinces?
 */
export function inRegion(place, region) {
  if (region === US_STATES) return place.kind === 'state';
  if (isCountryRegion(region)) return place.kind === 'province' && place.country === region;
  return place.kind === 'country' && (region === 'world' || place.cont.includes(region));
}

/**
 * Can the quiz ask for this place?  Any US state or province; countries too,
 * but no tiny ones with few people.  (Territories and Washington, D.C. are
 * never asked.)
 */
export function isAsked(place) {
  if (place.kind === 'state' || place.kind === 'province') return true;
  if (place.kind !== 'country') return false;
  const tiny = place.dot !== undefined;
  return !tiny || place.pop >= TINY_MIN_POP;
}

function tierPool(places, region, tiers) {
  return places.filter(c => isAsked(c) && tiers.includes(c.tier) && inRegion(c, region));
}

/** A level's tiers.  A country's provinces have no levels: any of them can come up. */
function levelFor(region, levelId) {
  if (isCountryRegion(region)) return { main: [0], fill: [] };
  return LEVELS.find(l => l.id === levelId);
}

/** How many rounds a game with these settings has. */
export function roundCount(places, region, levelId) {
  const level = levelFor(region, levelId);
  const available = tierPool(places, region, [...level.main, ...level.fill]).length;
  return Math.min(ROUNDS, available);
}

/**
 * Choose the places (countries, US states or provinces) for one game.  Places
 * in `recent` (ids asked in earlier games) are only used once the fresh ones
 * run out.
 */
export function pickQuestions(places, region, levelId, random = Math.random, recent = []) {
  const level = levelFor(region, levelId);
  const seen = new Set(recent);
  const order = list => shuffle(list, random).sort((a, b) => seen.has(a.id) - seen.has(b.id));
  const main = order(tierPool(places, region, level.main));
  const fill = order(tierPool(places, region, level.fill));
  return [...main, ...fill].slice(0, ROUNDS);
}

export function shuffle(list, random = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Small seedable PRNG (mulberry32), so a game can be replayed in tests. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stars(score, maxScore) {
  const share = maxScore ? score / maxScore : 0;
  if (share >= 0.8) return 3;
  if (share >= 0.5) return 2;
  return share > 0 ? 1 : 0;
}
