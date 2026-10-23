// Loads the files made by tools/build_data.py, tools/build_states.py and
// tools/build_provinces.py (plus the hand-written facts) and turns the
// compact, delta-encoded geometry back into GeoJSON for MapLibre.

const KIND = { country: 0, territory: 1, antarctica: 2, state: 3, district: 3, province: 3 };

export async function loadData(base = 'data/') {
  // The facts on Explore mode's cards and the US states are extras: the game
  // works without them.
  const extra = name => fetchJson(base + name).catch(err => {
    console.warn(err);
    return null;
  });
  const [world, info, facts, us] = await Promise.all([
    fetchJson(base + 'world.json'),
    fetchJson(base + 'countries.json'),
    extra('facts.json'),
    extra('us-states.json'),
  ]);
  const countries = info.countries;
  const states = us?.states ?? [];
  // A state's country, as for the provinces of other countries.
  for (const s of states) s.country = 'USA';
  const places = [...countries, ...states];
  for (const c of places) addFacts(c, facts?.places[c.code]);
  const index = list => new Map(list.map(c => [c.id, c]));
  return {
    countries,
    states,
    places,
    facts,
    byId: index(places),
    geo: decodeWorld(world, index(countries)),
    stateGeo: us && decodeWorld({ q: us.q, countries: us.polys, lines: us.lines }, index(states)),
  };
}

/**
 * The provinces, states and districts of a few countries, for the Start
 * menu's second page.  They come after the map is up, so the game starts as
 * fast as before.  Adds them to `data` (with the US states in `data.states`)
 * and returns their geometry for WorldMap.addStates().
 */
export async function loadProvinces(data, base = 'data/') {
  const file = await fetchJson(base + 'provinces.json');
  const provinces = file.provinces;
  for (const c of provinces) {
    addFacts(c, data.facts?.places[c.code]);
    data.byId.set(c.id, c);
  }
  data.states.push(...provinces);
  data.places.push(...provinces);
  return decodeWorld({ q: file.q, countries: file.polys, lines: file.lines }, new Map(provinces.map(c => [c.id, c])));
}

/** Capital, languages (or a state's nickname) and a fun fact from data/facts.json (written by hand). */
export function addFacts(country, facts) {
  if (!facts) return;
  const { capital, languages, nickname, fact, pop } = facts;
  Object.assign(country, { capital, languages, nickname, fact });
  // Natural Earth has no population for a few overseas areas the data build splits off.
  if (!country.pop && pop) country.pop = pop;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.json();
}

function decodeLine(flat, q) {
  const out = new Array(flat.length / 2);
  let x = 0;
  let y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i];
    y += flat[i + 1];
    out[i / 2] = [x / q, y / q];
  }
  return out;
}

export function decodeWorld(world, byId) {
  const q = world.q;
  const countries = world.countries.map(c => {
    const info = byId.get(c.id);
    return {
      type: 'Feature',
      id: c.id,
      // A state or province also has its country's code, `s`.
      properties: { c: info.color, k: KIND[info.kind], ...(info.country && { s: info.country }) },
      geometry: { type: 'MultiPolygon', coordinates: c.polys.map(p => p.map(r => decodeLine(r, q))) },
    };
  });
  const lines = world.lines.map(l => ({
    type: 'Feature',
    properties: { a: l.a, b: l.b, ...(byId.get(l.a)?.country && { s: byId.get(l.a).country }) },
    geometry: { type: 'MultiLineString', coordinates: l.lines.map(r => decodeLine(r, q)) },
  }));
  const dots = [...byId.values()].filter(c => c.dot !== undefined).map(c => ({
    type: 'Feature',
    id: c.id,
    properties: { c: c.color, dz: c.dot, ...(c.country && { s: c.country }) },
    geometry: { type: 'Point', coordinates: c.label },
  }));
  return {
    countries: { type: 'FeatureCollection', features: countries },
    lines: { type: 'FeatureCollection', features: lines },
    dots: { type: 'FeatureCollection', features: dots },
  };
}
