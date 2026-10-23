// Unit tests for the game rules and the generated data.  Open tests/unit.html
// in a browser (served over http), or run tools/check.py.
import {
  COUNTRY_REGIONS, LEVELS, POINTS, REGIONS, ROUNDS, TINY_MIN_POP, US_STATES, inRegion, isAsked, pickQuestions, provinceCountry, roundCount,
  scoreGuess, seededRandom, stars,
} from '../js/game.js';
import { addFacts, decodeWorld } from '../js/data.js';
import { darkness, fillZoom, flickSpeed, slowDown, sunPosition, unionBoxes } from '../js/map.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message} expected ${e}, got ${a}`);
}

const [world, info, facts, us, prov] = await Promise.all([
  fetch('../data/world.json').then(r => r.json()),
  fetch('../data/countries.json').then(r => r.json()),
  fetch('../data/facts.json').then(r => r.json()),
  fetch('../data/us-states.json').then(r => r.json()),
  fetch('../data/provinces.json').then(r => r.json()),
]);
const countries = info.countries;
const states = us.states;
const places = [...countries, ...states];
for (const c of places) addFacts(c, facts.places[c.code]);
const stateById = new Map(states.map(s => [s.id, s]));
const st = postal => {
  const s = states.find(x => x.postal === postal);
  if (!s) throw new Error(`no state ${postal}`);
  return s;
};
const byId = new Map(countries.map(c => [c.id, c]));
const byName = name => {
  const c = countries.find(x => x.name === name);
  if (!c) throw new Error(`no country called ${name}`);
  return c;
};
const quiz = countries.filter(c => c.kind === 'country');

// --- Scoring --------------------------------------------------------------------

test('the right country scores full points', () => {
  eq(scoreGuess(byName('France'), byName('France')), { outcome: 'exact', points: 100 });
});

test('a country sharing a border scores half', () => {
  const r = scoreGuess(byName('France'), byName('Spain'));
  eq([r.outcome, r.via, r.points], ['neighbor', 'land', 50]);
});

test('a neighbour across the sea scores half', () => {
  const r = scoreGuess(byName('Japan'), byName('South Korea'));
  eq([r.outcome, r.via, r.points], ['neighbor', 'sea', 50]);
  eq(scoreGuess(byName('United Kingdom'), byName('France')).points, 50, 'UK/France');
});

test('same continent scores a quarter', () => {
  const r = scoreGuess(byName('Brazil'), byName('Chile'));
  eq([r.outcome, r.continent, r.points], ['continent', 'South America', 25]);
});

test('anything else scores nothing', () => {
  eq(scoreGuess(byName('Brazil'), byName('Japan')), { outcome: 'miss', points: 0 });
});

test('giving up scores nothing', () => {
  eq(scoreGuess(byName('Brazil'), null), { outcome: 'miss', points: 0, gaveUp: true });
});

test('countries on two continents count for both', () => {
  eq(scoreGuess(byName('India'), byName('Russia')).outcome, 'continent', 'Russia is in Asia');
  eq(scoreGuess(byName('Spain'), byName('Russia')).outcome, 'continent', 'Russia is in Europe');
  eq(scoreGuess(byName('Germany'), byName('Turkey')).outcome, 'continent', 'Turkey is partly in Europe');
});

test('points are 100 / 50 / 25 / 0', () => {
  eq(POINTS, { exact: 100, neighbor: 50, continent: 25, miss: 0 });
});

// --- Neighbours in the data ----------------------------------------------------------

test('neighbour lists are symmetric', () => {
  for (const c of countries) {
    for (const id of c.land) assert(byId.get(id).land.includes(c.id), `${c.name} / ${byId.get(id).name} (land)`);
    for (const id of c.sea) assert(byId.get(id).sea.includes(c.id), `${c.name} / ${byId.get(id).name} (sea)`);
  }
});

test('well-known land borders exist', () => {
  const pairs = [['France', 'Spain'], ['United States', 'Canada'], ['United States', 'Mexico'], ['China', 'India'],
    ['Brazil', 'Argentina'], ['Russia', 'China'], ['Egypt', 'Sudan'], ['Ukraine', 'Russia'], ['Somalia', 'Ethiopia'],
    ['Zambia', 'Botswana'], ['Germany', 'Poland'], ['Brazil', 'French Guiana']];
  for (const [a, b] of pairs) assert(byName(a).land.includes(byName(b).id), `${a} should border ${b}`);
});

test('well-known sea neighbours exist', () => {
  const pairs = [['Japan', 'Russia'], ['Spain', 'Morocco'], ['Sri Lanka', 'India'], ['Australia', 'Papua New Guinea'],
    ['Australia', 'New Zealand'], ['Cuba', 'United States'], ['Madagascar', 'Mozambique'], ['Italy', 'Malta']];
  for (const [a, b] of pairs) assert(byName(a).sea.includes(byName(b).id), `${a} and ${b} should be sea neighbours`);
});

test('countries far apart or blocked by a third country are not neighbours', () => {
  const pairs = [['France', 'Brazil'], ['Germany', 'Italy'], ['Bangladesh', 'Nepal'], ['France', 'Netherlands'],
    ['Austria', 'Croatia'], ['New Zealand', 'Samoa']];
  for (const [a, b] of pairs) {
    const x = byName(a);
    const y = byName(b);
    assert(!x.land.includes(y.id) && !x.sea.includes(y.id), `${a} and ${b} should not be neighbours`);
  }
});

test('islands have neighbours across the water', () => {
  for (const name of ['Japan', 'United Kingdom', 'Iceland', 'Madagascar', 'Philippines', 'Cuba', 'Taiwan']) {
    assert(byName(name).sea.length > 0, `${name} has no sea neighbours`);
  }
});

test('Crimea is part of Ukraine', () => {
  const ukraine = byName('Ukraine');
  // Crimea reaches down to about 44.4°N; mainland Ukraine stops near 45.2°N.
  assert(ukraine.bbox[1] < 44.6, `Ukraine's southern edge is ${ukraine.bbox[1]}`);
});

// --- Countries in the data -------------------------------------------------------------

test('there are 197 quiz countries', () => {
  eq(quiz.length, 197);
});

test('every quiz country has a continent, tier, label and colour', () => {
  const continents = new Set(REGIONS.map(r => r.id).filter(id => id !== 'world'));
  for (const c of quiz) {
    assert(c.cont.length && c.cont.every(x => continents.has(x)), `${c.name}: continents ${c.cont}`);
    assert([1, 2, 3].includes(c.tier), `${c.name}: tier ${c.tier}`);
    assert(c.label.length === 2 && c.bbox.length === 4, `${c.name}: label/bbox`);
    assert(c.color >= 0 && c.color < 7, `${c.name}: colour ${c.color}`);
  }
});

test('neighbouring countries never share a colour', () => {
  for (const c of countries) {
    for (const id of c.land) assert(byId.get(id).color !== c.color || c.color < 0, `${c.name} / ${byId.get(id).name}`);
  }
});

test('label points lie inside their bounding box', () => {
  for (const c of quiz) {
    const [w, s, e, n] = c.bbox;
    let [x, y] = c.label;
    if (x < w) x += 360;
    assert(x >= w - 1 && x <= e + 1 && y >= s - 1 && y <= n + 1, `${c.name}: ${c.label} not in ${c.bbox}`);
  }
});

test('every quiz country has a population for Explore mode', () => {
  for (const c of quiz) assert(c.pop > 0, `${c.name} has no population`);
  assert(byName('China').pop > 1.3e9 && byName('Vatican City').pop < 2000, 'population scale');
});

test('tiny countries get a dot', () => {
  for (const name of ['Vatican City', 'Monaco', 'Singapore', 'Tuvalu', 'Malta']) {
    assert(byName(name).dot !== undefined, `${name} has no dot`);
  }
  assert(byName('Brazil').dot === undefined, 'Brazil should not have a dot');
});

test('every place has a fun fact, and every country a capital and languages', () => {
  const codes = new Set(places.map(c => c.code));
  for (const code of Object.keys(facts.places)) assert(codes.has(code), `facts.json has an unknown code ${code}`);
  for (const c of countries) {
    assert(typeof c.fact === 'string' && c.fact.length >= 30 && c.fact.length <= 130, `${c.name}: fact ${c.fact?.length} long`);
    assert(/[.!?]'?$/.test(c.fact), `${c.name}: the fact should end a sentence`);
    if (c.kind !== 'country') continue;
    assert([c.capital].flat().every(x => typeof x === 'string' && x.length > 1), `${c.name}: capital ${c.capital}`);
    assert(Array.isArray(c.languages) && c.languages.length > 0, `${c.name}: languages`);
  }
  eq([byName('France').capital, byName('Brazil').languages], ['Paris', ['Portuguese']]);
  eq(byName('South Africa').capital, ['Pretoria', 'Cape Town', 'Bloemfontein']);
  assert(byName('Réunion').pop > 5e5, 'facts.json fills in populations the map data lacks');
});

test('geometry decodes for every country', () => {
  const geo = decodeWorld(world, byId);
  eq(geo.countries.features.length, countries.length, 'feature count');
  const france = geo.countries.features.find(f => f.id === byName('France').id);
  const ring = france.geometry.coordinates[0][0];
  eq(JSON.stringify(ring[0]), JSON.stringify(ring[ring.length - 1]), 'rings are closed');
  const [lon, lat] = ring[0];
  assert(lon > -6 && lon < 10 && lat > 41 && lat < 52, `France ring starts at ${lon},${lat}`);
  assert(geo.lines.features.some(f => f.properties.b === 0), 'has coast lines');
  assert(geo.lines.features.some(f => f.properties.b !== 0), 'has border lines');
});

// --- Choosing questions --------------------------------------------------------------------

test('a game has 10 different countries', () => {
  const qs = pickQuestions(countries, 'world', 'medium', seededRandom(1));
  eq(qs.length, ROUNDS);
  eq(new Set(qs.map(q => q.id)).size, ROUNDS, 'all different');
});

test('easy games only ask big, famous countries', () => {
  const qs = pickQuestions(countries, 'world', 'easy', seededRandom(2));
  assert(qs.every(q => q.tier === 1), qs.map(q => q.name).join(', '));
});

test('hard games ask the less famous countries', () => {
  const qs = pickQuestions(countries, 'world', 'hard', seededRandom(3));
  assert(qs.every(q => q.tier >= 2), qs.map(q => q.name).join(', '));
});

test('region games stay in their region', () => {
  for (const region of REGIONS.map(r => r.id).filter(id => id !== 'world')) {
    for (const level of LEVELS.map(l => l.id)) {
      const qs = pickQuestions(places, region, level, seededRandom(4));
      assert(qs.length > 0, `${region}/${level} has no questions`);
      const ok = q => (region === US_STATES ? q.kind === 'state' : q.kind === 'country' && q.cont.includes(region));
      assert(qs.every(ok), `${region}/${level}: ${qs.map(q => q.name)}`);
      eq(qs.length, roundCount(places, region, level), `${region}/${level} round count`);
    }
  }
  assert(pickQuestions(places, 'world', 'hard', seededRandom(9)).every(q => q.kind === 'country'), 'world games ask countries');
});

test('small regions top up from the next tier', () => {
  const qs = pickQuestions(countries, 'North America', 'easy', seededRandom(5));
  eq(qs.length, 10);
  assert(qs.slice(0, 8).every(q => q.tier === 1), 'the 8 easy ones come first');
});

test('recently asked countries are avoided', () => {
  const first = pickQuestions(countries, 'Europe', 'medium', seededRandom(6));
  const second = pickQuestions(countries, 'Europe', 'medium', seededRandom(7), first.map(q => q.id));
  const repeats = second.filter(q => first.some(f => f.id === q.id));
  eq(repeats.length, 0, 'repeats');
});

test('the quiz leaves out tiny countries with few people', () => {
  for (const name of ['Vatican City', 'Monaco', 'Tuvalu', 'Malta', 'Luxembourg', 'Barbados']) assert(!isAsked(byName(name)), name);
  for (const name of ['Singapore', 'Bahrain', 'Mauritius', 'France', 'Iceland']) assert(isAsked(byName(name)), name);
  assert(!isAsked(byName('Greenland')), 'territories are never asked');
  const asked = quiz.filter(isAsked);
  eq(asked.length, 169, 'asked countries');
  assert(asked.every(c => c.dot === undefined || c.pop >= TINY_MIN_POP), 'only big or busy countries');
  for (const region of REGIONS.map(r => r.id)) {
    for (const level of LEVELS.map(l => l.id)) {
      for (let seed = 0; seed < 20; seed++) {
        const qs = pickQuestions(countries, region, level, seededRandom(seed));
        assert(qs.every(isAsked), `${region}/${level}: ${qs.filter(q => !isAsked(q)).map(q => q.name)}`);
      }
    }
  }
});

test('the same seed gives the same game', () => {
  const a = pickQuestions(countries, 'world', 'easy', seededRandom(42)).map(q => q.id);
  const b = pickQuestions(countries, 'world', 'easy', seededRandom(42)).map(q => q.id);
  eq(a, b);
});

// --- Stars and map helpers -----------------------------------------------------------------

test('stars: 3 from 80%, 2 from 50%, 1 for anything, 0 for nothing', () => {
  eq([stars(1000, 1000), stars(800, 1000), stars(799, 1000), stars(500, 1000), stars(25, 1000), stars(0, 1000)], [3, 3, 2, 2, 1, 0]);
});

test('bounding boxes join across the 180° meridian', () => {
  eq(unionBoxes([[170, -20, 180, -10], [-180, -20, -170, -10]]), [170, -20, 190, -10]);
  eq(unionBoxes([[-10, 40, 10, 50], [20, 30, 30, 45]]), [-10, 30, 30, 50]);
});

test('the globe covers the screen at the zoom MapLibre does', () => {
  // Measured in MapLibre 6.15: the zoom where all four corners first touch the globe.
  const near = (a, b) => Math.abs(a - b) < 0.005;
  for (const [w, h, z] of [[1366, 820, 4.168], [390, 844, 3.031], [844, 390, 3.563], [1920, 1080, 4.674]]) {
    assert(near(fillZoom(w, h), z), `${w}x${h}: ${fillZoom(w, h)} should be ${z}`);
  }
  // MapLibre draws the globe twice as big at 60 degrees, so it fills one zoom level sooner.
  assert(near(fillZoom(1366, 820, { lat: 60 }), 3.168), 'latitude');
  // A side panel pushes the globe off centre, so it must grow more to reach the far corners.
  const panel = { top: 0, bottom: 0, left: 20, right: 480 };
  assert(fillZoom(844, 390, { padding: panel }) > fillZoom(844, 390) + 0.5, 'padding');
});

test('a flicked globe slows down and stops, the same at any frame rate', () => {
  const spin = { tau: 0.8, friction: 24 };
  // Turn for 10 seconds in steps of `frame` seconds: how far, and the speed at the end.
  const run = (speed, frame) => {
    let turned = 0;
    for (let t = 0; t < 10; t += frame) {
      const [d, v] = slowDown(speed, frame, spin);
      turned += d;
      speed = v;
    }
    return [turned, speed];
  };
  const [smooth, end] = run(280, 1 / 60);
  assert(end === 0, `still turning at ${end} degrees a second`);
  for (const frame of [10, 0.5, 1 / 7]) {
    assert(Math.abs(run(280, frame)[0] - smooth) < 1e-6, `${frame} s frames: ${run(280, frame)[0]} vs ${smooth}`);
  }
  // A good flick turns the globe about half way round; a gentle one a little.
  assert(smooth > 150 && smooth < 220, `a 280°/s flick turns ${smooth}°`);
  const gentle = run(30, 1 / 60)[0];
  assert(gentle > 2 && gentle < 15, `a 30°/s flick turns ${gentle}°`);
  assert(run(-280, 1 / 60)[0] === -smooth, 'the other way round');
  // It slows down gradually: after half a second it still turns, slower.
  const [, half] = slowDown(280, 0.5, spin);
  assert(half > 50 && half < 200, `speed after half a second: ${half}`);
});

test('the flick speed is how fast the globe turned as it was let go', () => {
  // Every 16 ms the pointer moved, and the centre 2° east and 0.5° north; let go just after.
  const track = Array.from({ length: 12 }, (_, i) => ({ input: 1000 + 16 * i, center: { lng: 165 + 2 * i, lat: 10 + i / 2 } }));
  const released = track.at(-1).input + 5;
  const [lng, lat] = flickSpeed(track, released);
  assert(Math.abs(lng - 125) < 1e-6 && Math.abs(lat - 31.25) < 1e-6, `${lng}, ${lat}`);
  // Across the 180° meridian (165 + 22 = 187 is -173): still 125°/s east.
  for (const p of track) p.center.lng = ((p.center.lng + 540) % 360) - 180;
  assert(Math.abs(flickSpeed(track, released)[0] - 125) < 1e-6, 'across the date line');
  // Held still before letting go: no spin.
  eq(flickSpeed(track, released + 300), null);
  eq(flickSpeed(track.slice(0, 1), released), null);
});

// --- US states ------------------------------------------------------------------------------

test('the US states: all 50, plus Washington, D.C. on the map', () => {
  eq([states.filter(s => s.kind === 'state').length, states.filter(s => s.kind === 'district').length], [50, 1]);
  const regions = new Set(['Northeast', 'Midwest', 'South', 'West']);
  for (const s of states) {
    assert(s.id > Math.max(...countries.map(c => c.id)), `${s.name}: id ${s.id} clashes with a country`);
    assert(/^US-[A-Z]{2}$/.test(s.code) && s.postal === s.code.slice(3), `${s.name}: code ${s.code}`);
    assert(s.cont.length === 1 && regions.has(s.cont[0]), `${s.name}: region ${s.cont}`);
    assert(s.color >= 0 && s.color < 7, `${s.name}: colour`);
    const [w, so, e, n] = s.bbox;
    assert(s.label[0] >= w - 1 && s.label[0] <= e + 1 && s.label[1] >= so - 1 && s.label[1] <= n + 1, `${s.name}: label`);
  }
  eq(st('TX').cont, ['South']);
  eq(st('CA').cont, ['West']);
  assert(st('RI').dot !== undefined && st('TX').dot === undefined, 'tiny states get a dot');
});

test('neighbouring states never share a colour, nor a colour with Canada or Mexico', () => {
  for (const s of states) {
    for (const id of [...s.land, ...s.sea]) {
      assert(stateById.get(id).color !== s.color, `${s.name} / ${stateById.get(id).name}`);
    }
  }
  const color = code => countries.find(c => c.code === code).color;
  for (const p of 'AK WA ID MT ND MN MI NY VT NH ME'.split(' ')) assert(st(p).color !== color('CAN'), `${p} / Canada`);
  for (const p of 'CA AZ NM TX'.split(' ')) assert(st(p).color !== color('MEX'), `${p} / Mexico`);
});

test('state neighbours: borders, the Four Corners, and across Lake Michigan', () => {
  const near = (a, b) => [...st(a).land, ...st(a).sea].includes(st(b).id);
  for (const [a, b] of [['TX', 'OK'], ['CA', 'NV'], ['NY', 'PA'], ['AZ', 'CO'], ['UT', 'NM'], ['MI', 'IL'], ['DE', 'NJ'], ['VA', 'DC']]) {
    assert(near(a, b) && near(b, a), `${a} and ${b} should be neighbours`);
  }
  for (const [a, b] of [['TX', 'CA'], ['AK', 'WA'], ['HI', 'CA'], ['FL', 'TX']]) assert(!near(a, b), `${a} and ${b} are not neighbours`);
});

test('every state has a capital, nickname, population and fun fact', () => {
  for (const s of states.filter(x => x.kind === 'state')) {
    assert(s.capital && s.nickname && s.pop > 5e5 && s.fact?.length > 30, `${s.name}: ${s.capital} / ${s.nickname} / ${s.pop}`);
  }
  eq([st('TX').capital, st('NY').capital, st('HI').nickname], ['Austin', 'Albany', 'The Aloha State']);
  assert(st('CA').pop > 39e6 && st('WY').pop < 6e5, 'population scale');
});

test('a US states game asks 10 states, never Washington, D.C.', () => {
  for (let seed = 0; seed < 30; seed++) {
    for (const level of LEVELS.map(l => l.id)) {
      const qs = pickQuestions(places, US_STATES, level, seededRandom(seed));
      eq(qs.length, ROUNDS);
      assert(qs.every(q => q.kind === 'state' && inRegion(q, US_STATES)), qs.map(q => q.name).join(', '));
      if (level === 'easy') assert(qs.every(q => q.tier === 1), `easy: ${qs.map(q => q.name)}`);
    }
  }
  assert(!isAsked(states.find(s => s.kind === 'district')), 'D.C. is not a state');
});

test('state answers score like countries: neighbour, same region, anything else', () => {
  eq(scoreGuess(st('TX'), st('TX')).points, 100);
  eq([scoreGuess(st('TX'), st('OK')).outcome, scoreGuess(st('TX'), st('OK')).points], ['neighbor', 50]);
  const r = scoreGuess(st('TX'), st('FL'));
  eq([r.outcome, r.continent, r.points], ['continent', 'South', 25]);
  eq(scoreGuess(st('TX'), st('CA')).points, 0);
  eq(scoreGuess(st('TX'), countries.find(c => c.code === 'MEX')).points, 0, 'a country is not a state');
});

// --- Other countries' provinces --------------------------------------------------------------

const provinces = prov.provinces;
const allPlaces = [...places, ...provinces];
const provinceById = new Map(provinces.map(p => [p.id, p]));
const pr = (country, name) => {
  const p = provinces.find(x => x.country === country && x.name === name);
  if (!p) throw new Error(`no province ${name} in ${country}`);
  return p;
};

test('the provinces: how many each country has, with ids and codes of their own', () => {
  const count = code => provinces.filter(p => p.country === code).length;
  eq(COUNTRY_REGIONS.map(r => [r.id, count(r.id)]),
    [['CHN', 33], ['IND', 36], ['CAN', 13], ['FRA', 13], ['GBR', 12], ['DEU', 16], ['AUS', 8], ['BGD', 64]]);
  const lastId = Math.max(...countries.map(c => c.id), ...states.map(s => s.id));
  for (const p of provinces) {
    assert(p.id > lastId, `${p.name}: id ${p.id} clashes`);
    assert(p.kind === 'province' && countries.some(c => c.code === p.country), `${p.name}: kind ${p.kind}, country ${p.country}`);
    assert(p.about && p.color >= 0 && p.color < 7, `${p.name}: about, colour`);
    const [w, so, e, n] = p.bbox;
    assert(p.label[0] >= w - 1 && p.label[0] <= e + 1 && p.label[1] >= so - 1 && p.label[1] <= n + 1, `${p.name}: label`);
  }
  eq(new Set(provinces.map(p => p.code)).size, provinces.length, 'codes are unique');
  eq([pr('CHN', 'Tibet').about, pr('IND', 'Delhi').about, pr('GBR', 'London').about],
    ['An autonomous region of China', 'A union territory of India', 'A region of England']);
});

test('Bangladesh: its 64 districts in their 8 divisions, with populations', () => {
  const bd = provinces.filter(p => p.country === 'BGD');
  eq(new Set(bd.map(p => p.cont[0])).size, 8);
  eq([pr('BGD', 'Dhaka').cont, pr('BGD', 'Netrokona').cont], [['Dhaka Division'], ['Mymensingh Division']]);
  assert(bd.every(p => p.pop > 3e5), 'every district has a population');
  assert(pr('BGD', 'Dhaka').pop > 1e7 && pr('BGD', 'Bandarban').pop < 1e6, 'population scale');
});

test('neighbouring provinces are in the same country and never share a colour', () => {
  for (const p of provinces) {
    for (const id of [...p.land, ...p.sea]) {
      const n = provinceById.get(id);
      assert(n && n.country === p.country, `${p.name}: neighbour ${id} is not in ${p.country}`);
      assert(n.color !== p.color, `${p.name} / ${n.name}`);
    }
  }
});

test('province neighbours: borders, and a few across the water', () => {
  const near = (c, a, b) => [...pr(c, a).land, ...pr(c, a).sea].includes(pr(c, b).id);
  for (const [c, a, b] of [
    ['CHN', 'Beijing', 'Hebei'], ['CHN', 'Hainan', 'Guangdong'], ['CHN', 'Macau', 'Guangdong'], ['IND', 'Delhi', 'Haryana'],
    ['IND', 'Goa', 'Karnataka'], ['CAN', 'Ontario', 'Quebec'], ['CAN', 'Prince Edward Island', 'Nova Scotia'],
    ['FRA', 'Corsica', "Provence-Alpes-Côte d'Azur"], ['GBR', 'Scotland', 'North East England'], ['GBR', 'Northern Ireland', 'Scotland'],
    ['DEU', 'Berlin', 'Brandenburg'], ['AUS', 'Tasmania', 'Victoria'], ['BGD', 'Dhaka', 'Gazipur'], ['BGD', 'Mymensingh', 'Netrokona'],
  ]) {
    assert(near(c, a, b) && near(c, b, a), `${a} and ${b} should be neighbours`);
  }
  for (const [c, a, b] of [['IND', 'Kerala', 'Punjab'], ['DEU', 'Bavaria', 'Hamburg'], ['BGD', 'Dhaka', 'Rangpur'], ['AUS', 'Western Australia', 'Victoria']]) {
    assert(!near(c, a, b), `${a} and ${b} are not neighbours`);
  }
});

test('a country game asks 10 of its provinces (Australia: all 8), whatever the level', () => {
  for (const r of COUNTRY_REGIONS) {
    const all = provinces.filter(p => p.country === r.id).length;
    for (let seed = 0; seed < 10; seed++) {
      const qs = pickQuestions(allPlaces, r.id, 'easy', seededRandom(seed));
      eq(qs.length, Math.min(ROUNDS, all), r.id);
      assert(qs.every(q => q.kind === 'province' && q.country === r.id && inRegion(q, r.id) && isAsked(q)), `${r.id}: ${qs.map(q => q.name)}`);
      eq(new Set(qs.map(q => q.id)).size, qs.length, `${r.id}: no place twice`);
    }
    eq(roundCount(allPlaces, r.id, 'easy'), roundCount(allPlaces, r.id, 'hard'), `${r.id}: the level makes no difference`);
    eq(provinceCountry(r.id), r.id);
  }
  eq([provinceCountry(US_STATES), provinceCountry('Asia'), provinceCountry('world')], ['USA', null, null]);
  for (const region of REGIONS.map(r => r.id)) {
    assert(pickQuestions(allPlaces, region, 'hard', seededRandom(1)).every(q => q.kind !== 'province'), `${region} asks no provinces`);
  }
});

test('province answers score like countries: neighbour, same region, anything else', () => {
  eq(scoreGuess(pr('IND', 'Kerala'), pr('IND', 'Kerala')).points, 100);
  eq(scoreGuess(pr('IND', 'Kerala'), pr('IND', 'Tamil Nadu')).outcome, 'neighbor');
  const r = scoreGuess(pr('IND', 'Kerala'), pr('IND', 'Telangana'));
  eq([r.outcome, r.continent, r.points], ['continent', 'South India', 25]);
  eq(scoreGuess(pr('IND', 'Kerala'), pr('IND', 'Punjab')).points, 0);
  eq(scoreGuess(pr('FRA', 'Brittany'), pr('FRA', 'Corsica')).points, 0, 'French regions have no bigger parts');
  eq(scoreGuess(pr('BGD', 'Dhaka'), countries.find(c => c.code === 'IND')).points, 0, 'a country is not a district');
});

test('geometry decodes for every province, marked with its country', () => {
  const geo = decodeWorld({ q: prov.q, countries: prov.polys, lines: prov.lines }, provinceById);
  eq(geo.countries.features.length, provinces.length);
  for (const f of geo.countries.features) {
    const p = provinceById.get(f.id);
    eq(f.properties.s, p.country, p.name);
    const [w, s, e, n] = p.bbox;
    const pts = f.geometry.coordinates.flat(2);
    assert(pts.some(([x, y]) => x >= w - 0.01 && x <= e + 0.01 && y >= s - 0.01 && y <= n + 0.01), `${p.name}: shape inside its box`);
  }
  assert(geo.lines.features.every(f => f.properties.s === provinceById.get(f.properties.a).country), 'every edge knows its country');
  assert(geo.dots.features.length > 0 && geo.dots.features.every(f => f.properties.s), 'dots');
});

// --- Day and night ---------------------------------------------------------------------------

test('the sun is overhead where the astronomers say', () => {
  // Expected values from NOAA's solar calculator.
  const at = (iso, lng, lat) => {
    const sun = sunPosition(new Date(iso));
    assert(Math.abs(sun.lng - lng) < 0.1 && Math.abs(sun.lat - lat) < 0.05, `${iso}: ${sun.lng}, ${sun.lat} should be ${lng}, ${lat}`);
  };
  at('2024-06-20T20:51:00Z', -132.30, 23.44); // June solstice: over the Tropic of Cancer
  at('2024-12-21T09:21:00Z', 39.32, -23.44); // December solstice: over the Tropic of Capricorn
  at('2026-03-20T12:00:00Z', 1.86, -0.04); // March equinox, about noon at Greenwich
  at('2026-10-20T14:30:00Z', -41.32, -10.48);
});

test('night is dark, day is clear, dusk is in between', () => {
  const height = deg => Math.sin((deg * Math.PI) / 180);
  eq([darkness(height(30)), darkness(height(1.5)), darkness(height(-13)), darkness(height(-60))], [0, 0, 1, 1]);
  assert(darkness(height(-6)) > 0.3 && darkness(height(-6)) < 0.7, 'dusk');
  assert(darkness(height(-3)) < darkness(height(-6)) && darkness(height(-6)) < darkness(height(-9)), 'darker as the sun sinks');
});

// --- Report ----------------------------------------------------------------------------------

const failed = results.filter(r => !r.ok);
document.getElementById('results').innerHTML = results.map(r =>
  `<li class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : ` — ${r.error}`}</li>`).join('');
document.getElementById('summary').textContent = failed.length
  ? `${failed.length} of ${results.length} tests failed`
  : `All ${results.length} tests passed`;
document.getElementById('summary').className = failed.length ? 'fail' : 'pass';
window.testResults = results;
