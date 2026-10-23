// Country Quest: find countries on a map with no names on it.
import { loadData, loadProvinces } from './data.js';
import { WorldMap, webglSupported } from './map.js';
import {
  COUNTRY_REGIONS, LEVELS, POINTS, REGIONS, US_STATES, isCountryRegion, pickQuestions, provinceCountry, roundCount,
  scoreGuess, seededRandom, stars,
} from './game.js';
import { confetti } from './confetti.js';
import { flag } from './flags.js';

const $ = sel => document.querySelector(sel);
const params = new URLSearchParams(location.search);

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`cq.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cq.${key}`, JSON.stringify(value));
    } catch {
      // Private browsing etc.: settings just aren't remembered.
    }
  },
};

const state = {
  phase: 'loading', // loading | menu | explore | ask | reveal | done
  region: store.get('region', 'world'), // chosen in the Start menu
  playRegion: 'world', // the one on the map: of the game being played, or being explored
  level: store.get('level', 'easy'),
  questions: [],
  results: [],
  round: 0,
  score: 0,
  selected: null,
  inGame: false,
  names: false, // Explore mode: show country names?  Every visit starts without.
};
// Everything the Start menu offers: its first page, then the countries on its second.
const ALL_REGIONS = [...REGIONS, ...COUNTRY_REGIONS];
const isRegion = id => ALL_REGIONS.some(r => r.id === id);
if (!isRegion(state.region)) state.region = 'world';
if (!LEVELS.some(l => l.id === state.level)) state.level = 'easy';

// The Start menu has two pages: the world, the continents and the US states,
// and (behind the second dot, for the keen) a few countries to play inside.
// Each page keeps its own choice, so going back to a page brings it back.
let menuPage = 1;
const pageChoice = { 1: 'world', 2: COUNTRY_REGIONS[0].id };
if (isCountryRegion(store.get('country'))) pageChoice[2] = store.get('country');
chooseRegion(state.region);

/** Choose a region: what "Let's go" plays, and which menu page it is on. */
function chooseRegion(id) {
  state.region = id;
  menuPage = isCountryRegion(id) ? 2 : 1;
  pageChoice[menuPage] = id;
}

// The provinces of the countries on the menu's second page load the first
// time the menu opens: the opening globe doesn't need them.  If they fail,
// the next time the menu opens tries again.
let provinces = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'

function needProvinces() {
  if (provinces === 'loading' || provinces === 'ready') return;
  provinces = 'loading';
  loadProvinces(data)
    .then(geo => {
      world.addStates(geo);
      provinces = 'ready';
    })
    .catch(err => {
      console.warn(err);
      provinces = 'failed';
    })
    .finally(() => {
      if (state.phase === 'menu') renderChoices();
    });
}

let data;
let world;
// The globe turns by itself on the opening page, and again after the globe
// button, until the player touches the map.
let idleGlobe = true;
const random = params.has('seed') ? seededRandom(Number(params.get('seed'))) : Math.random;

const CHEERS = ['Amazing!', 'You got it!', 'Super!', 'Brilliant!', 'Fantastic!', 'Spot on!', 'Wow!'];
const US_REGIONS = new Set(['Northeast', 'Midwest', 'South', 'West']);

/** What a region is made of: "country", "state", "province" … (with `many`, "countries" …). */
function placeWord(region, many = false) {
  if (region === US_STATES) return many ? 'states' : 'state';
  const country = COUNTRY_REGIONS.find(r => r.id === region);
  if (country) return many ? country.many : country.one;
  return many ? 'countries' : 'country';
}

/** Where the best score of a game is kept.  A country's provinces have no levels. */
const bestKey = (region, level) => (isCountryRegion(region) ? `best.${region}` : `best.${region}.${level}`);

/** A continent or US region as part of a sentence: "Europe", "the West". */
const regionWords = name => (US_REGIONS.has(name) ? `the ${name}` : name);
/** The region to fly to with world.home(): null for the whole globe. */
const homeRegion = () => (state.playRegion === 'world' ? null : state.playRegion);
const pickOne = list => list[Math.floor(Math.random() * list.length)];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** "🇧🇷 Brazil", or "Greenland (part of Denmark)" for territories. */
function label(country, { withFlag = true } = {}) {
  let text = escapeHtml(country.name);
  if (country.sov) text += ` <span class="muted">(part of ${escapeHtml(data.byId.get(country.sov).name)})</span>`;
  const f = withFlag ? flag(country.iso2) : '';
  return f ? `<span class="flag">${f}</span> ${text}` : text;
}

// --- Screens -----------------------------------------------------------------

function show(el, visible = true) {
  el.hidden = !visible;
}

function renderChoices() {
  const chips = list => list.map(r => `
    <button type="button" class="chip chip--region" role="radio" data-region="${r.id}" aria-checked="${r.id === state.region}">
      <span class="chip__emoji" aria-hidden="true">${r.emoji ?? (flag(r.iso2) || '📍')}</span><span>${r.label}</span>
    </button>`).join('');
  $('#region-chips').innerHTML = chips(REGIONS);
  $('#country-chips').innerHTML = chips(COUNTRY_REGIONS);
  $('#level-chips').innerHTML = LEVELS.map(l => `
    <button type="button" class="chip chip--level" role="radio" data-level="${l.id}" aria-checked="${l.id === state.level}">
      <span class="chip__emoji" aria-hidden="true">${l.emoji}</span>${l.label}
    </button>`).join('');
  // One page of the menu shows at a time; the dots say which.
  for (const page of document.querySelectorAll('.start__page')) {
    const on = Number(page.dataset.page) === menuPage;
    page.classList.toggle('start__page--on', on);
    page.inert = !on;
    page.setAttribute('aria-hidden', String(!on));
  }
  for (const dot of document.querySelectorAll('.start__dot')) {
    dot.setAttribute('aria-current', String(Number(dot.dataset.page) === menuPage));
  }
  // A country's provinces can only be played once they have loaded.
  const waiting = isCountryRegion(state.region) && provinces !== 'ready';
  $('#start-btn').disabled = waiting;
  $('#explore-btn').disabled = waiting;
  if (waiting) {
    $('#round-info').textContent = provinces === 'failed' ? 'This map did not load. Close the menu and open it again to try again.' : 'Loading the map…';
    $('#best-info').textContent = '';
    return;
  }
  const n = roundCount(data.places, state.region, state.level);
  $('#round-info').textContent = `${n} ${placeWord(state.region, n !== 1)} to find`;
  const best = store.get(bestKey(state.region, state.level), 0);
  $('#best-info').textContent = best ? ` · Best score: ${best}` : '';
}

/** Turn the menu to its first page (the world) or its second (inside a country). */
function setMenuPage(page) {
  if (page === menuPage) return;
  chooseRegion(pageChoice[page]);
  renderChoices();
}

/** The Start menu: choose a quiz, go exploring, show names. */
function showMenu() {
  state.phase = 'menu';
  needProvinces();
  chooseRegion(state.region); // open on the page of the current choice
  renderChoices();
  renderNamesSwitch();
  show($('#resume-btn'), state.inGame);
  show($('#start'));
  show($('#end'), false);
  show($('#hud'), false);
  show($('#start-menu-btn'), false);
  show($('#panel'), false);
  show($('#map-tools'), false);
  // Behind the menu is the exploring globe (unless a quiz is paused: that map
  // never shows names), still turning if nobody has touched it yet.
  world.setLabels(!state.inGame && state.names);
  world.setNight(!state.inGame);
  if (!state.inGame) world.clearResult(); // a tapped country comes back when the menu closes
  world.spin(!state.inGame && idleGlobe);
  $('#start-btn').focus({ preventScroll: true });
}

/** Closing the menu goes back to the paused quiz, or to exploring. */
function closeMenu() {
  if (state.phase !== 'menu') return;
  if (state.inGame) resumeGame();
  else startExplore({ selected: exploreId, keepView: true });
}

/**
 * Show the buttons for the quiz (top bar, map buttons, the panel below) or for
 * Explore mode (map buttons and the Start button; a card when a place is tapped).
 */
function showPlayScreen(mode) {
  show($('#start'), false);
  show($('#end'), false);
  document.body.classList.toggle('exploring', mode === 'explore');
  show($('#hud'), mode === 'quiz');
  show($('#start-menu-btn'), mode === 'explore');
  show($('#panel'), mode === 'quiz');
  show($('#map-tools'));
  world.spin(false);
  world.setStates(provinceCountry(state.playRegion));
  // The quiz map never shows names, nor the night: every country must be clear.
  world.setLabels(mode === 'explore' && state.names);
  world.setNight(mode === 'explore');
}

function startGame() {
  if (isCountryRegion(state.region) && provinces !== 'ready') return;
  idleGlobe = false;
  store.set('region', state.region);
  store.set('level', state.level);
  const recent = store.get('recent', []);
  Object.assign(state, {
    playRegion: state.region,
    questions: pickQuestions(data.places, state.region, state.level, random, recent),
    results: [],
    round: 0,
    score: 0,
    inGame: true,
  });
  store.set('recent', [...recent, ...state.questions.map(q => q.id)].slice(-80));
  showPlayScreen('quiz');
  renderScore(0);
  askRound();
  world.home(homeRegion());
}

function resumeGame() {
  state.phase = state.results.length > state.round ? 'reveal' : 'ask';
  showPlayScreen('quiz');
}

function askRound() {
  state.phase = 'ask';
  state.selected = null;
  world.clearResult();
  peekTag = null;
  renderQuestion();
  renderProgress();
  renderPanel();
}

function renderQuestion() {
  const target = state.questions[state.round];
  const f = flag(target.iso2);
  $('#quest-flag').textContent = f;
  show($('#quest-flag'), !!f);
  $('#quest-name').textContent = target.name;
}

function renderProgress() {
  $('#progress').innerHTML = state.questions.map((q, i) => {
    const r = state.results[i];
    const cls = r ? `pip--${r.outcome}` : i === state.round ? 'pip--current' : '';
    return `<li class="pip ${cls}" aria-label="Round ${i + 1}${r ? `: ${r.points} points` : ''}"></li>`;
  }).join('');
  $('#round-label').textContent = `${state.round + 1} / ${state.questions.length}`;
}

let shownScore = 0;
function renderScore(value, animate = false) {
  const el = $('#score');
  const from = shownScore;
  shownScore = value;
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = value;
    return;
  }
  const start = performance.now();
  const tick = now => {
    const t = Math.min(1, (now - start) / 700);
    el.textContent = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const box = el.closest('.score');
  box.classList.remove('score--bump');
  void box.offsetWidth;
  box.classList.add('score--bump');
}

function renderPanel() {
  const panel = $('#panel');
  panel.classList.remove('panel--card');
  const target = state.questions[state.round];
  if (state.phase === 'ask' && state.selected === null) {
    panel.innerHTML = `
      <div class="panel__row">
        <p class="panel__hint"><span aria-hidden="true">👆</span> Tap <b>${escapeHtml(target.name)}</b> on the map</p>
        <button type="button" class="btn btn--ghost" data-action="giveup">🤷 Show me</button>
      </div>`;
  } else if (state.phase === 'ask') {
    panel.innerHTML = `
      <div class="panel__row">
        <button type="button" class="btn btn--primary btn--big btn--pulse" data-action="check">✓ Check!</button>
        <button type="button" class="btn btn--ghost" data-action="giveup">🤷 Show me</button>
      </div>
      <p class="panel__small">Not sure? Tap a different country to change.</p>`;
  } else if (state.phase === 'reveal') {
    const r = state.results[state.round];
    const last = state.round === state.questions.length - 1;
    panel.innerHTML = `
      <div class="result result--${r.gaveUp ? 'gaveup' : r.outcome}">
        <div class="result__emoji" aria-hidden="true">${r.emoji}</div>
        <div class="result__text">
          <div class="result__title">${r.title}</div>
          <div class="result__msg">${r.message}</div>
        </div>
        <div class="result__points">+${r.points}</div>
      </div>
      <button type="button" class="btn btn--primary btn--big" data-action="next">${last ? 'See my score 🏆' : 'Next ▶'}</button>`;
    panel.querySelector('[data-action="next"]').focus({ preventScroll: true });
  }
}

/** The feedback shown after an answer: emoji, title and a message. */
function describeResult(target, picked, result) {
  const t = `<b>${label(target)}</b>`;
  const p = picked && `<b>${label(picked)}</b>`;
  if (result.gaveUp) return { emoji: '👀', title: 'Here it is!', message: `This is ${t}. You'll get it next time!` };
  switch (result.outcome) {
    case 'exact':
      return { emoji: '🎉', title: pickOne(CHEERS), message: `That's ${t}!` };
    case 'neighbor':
      return {
        emoji: '🤝',
        title: 'So close!',
        message: result.via === 'land'
          ? `You picked ${p}. It's right next to ${escapeHtml(target.name)}.`
          : `You picked ${p}. It's ${escapeHtml(target.name)}'s neighbor across the water.`,
      };
    case 'continent':
      return {
        emoji: '👍',
        title: 'Good try!',
        message: `You picked ${p}. It's in ${escapeHtml(regionWords(result.continent))} too. Here's ${escapeHtml(target.name)}!`,
      };
    default:
      return { emoji: '🙈', title: 'Oops!', message: `That's ${p}. ${escapeHtml(target.name)} is over here!` };
  }
}

/** Score the pick for a round and remember the result. */
function recordResult(round, pickedId) {
  const target = state.questions[round];
  const picked = pickedId == null ? null : data.byId.get(pickedId);
  const result = scoreGuess(target, picked);
  state.results[round] = { ...result, ...describeResult(target, picked, result), target, picked };
  return state.results[round];
}

/** Colour the answer on the map, label it and fly there. */
function showReveal(r, duration) {
  world.showResult(r.target.id, r.picked?.id, r.outcome);
  world.addTag(r.target.id, label(r.target), 'target', { pulse: true });
  if (r.picked && r.picked.id !== r.target.id) world.addTag(r.picked.id, label(r.picked), r.outcome);
  const close = r.picked && r.picked.id !== r.target.id && r.outcome !== 'miss';
  world.showCountries(close ? [r.target.id, r.picked.id] : [r.target.id], duration);
}

// Where the player was looking when they answered: "Next" goes back there.
let answerView = null;

function finishRound(pickedId) {
  answerView = world.view();
  const r = recordResult(state.round, pickedId);
  state.score += r.points;
  state.phase = 'reveal';
  state.selected = null;
  // The result goes up first, so the camera knows how much of the screen it covers.
  renderPanel();
  showReveal(r);
  if (r.outcome === 'exact') confetti($('#confetti'));
  renderScore(state.score, r.points > 0);
  renderProgress();
}

function next() {
  if (state.round < state.questions.length - 1) {
    state.round += 1;
    askRound();
    // Back to the player's own view, the one they had before the answer showed.
    if (!answerView || !world.restoreView(answerView)) world.home(homeRegion());
  } else {
    endGame();
  }
}

function endGame() {
  state.phase = 'done';
  state.inGame = false;
  const max = state.questions.length * 100;
  const rating = stars(state.score, max);
  const key = bestKey(state.playRegion, state.level);
  const best = store.get(key, 0);
  const newBest = state.score > best;
  if (newBest) store.set(key, state.score);
  const headings = [['🧭', 'Keep exploring!'], ['👍', 'Nice try!'], ['🌟', 'Great exploring!'], ['🏆', 'Super explorer!']];
  const [emoji, title] = headings[rating];
  // The rounds grouped by their points, best first, so the list is short
  // enough to fit on the screen without scrolling.
  const groups = [['exact', '🎯'], ['neighbor', '🤝'], ['continent', '🗺️'], ['miss', '❌']]
    .map(([outcome, icon]) => ({ outcome, icon, results: state.results.filter(r => r.outcome === outcome) }))
    .filter(group => group.results.length);
  $('#end .card').innerHTML = `
    <div class="end__summary">
      <div class="end__emoji" aria-hidden="true">${emoji}</div>
      <h2 class="end__title">${title}</h2>
      <div class="stars" aria-label="${rating} of 3 stars">${[1, 2, 3].map(i => `<span class="${i <= rating ? 'on' : ''}">★</span>`).join('')}</div>
      <p class="end__score"><b>${state.score}</b> / ${max} points</p>
      <p class="end__best">${newBest && state.score > 0 ? '🎉 New best score!' : `Best score: ${Math.max(best, state.score)}`}</p>
    </div>
    <ul class="recap" aria-label="Your answers">
      ${groups.map(({ outcome, icon, results }) => `
        <li class="recap__group recap__group--${outcome}">
          <span class="recap__pts"><span aria-hidden="true">${icon}</span> +${POINTS[outcome]}</span>
          <ul class="recap__names">${results.map(r => `<li class="recap__name">${label(r.target)}</li>`).join('')}</ul>
        </li>`).join('')}
    </ul>
    <div class="end__actions">
      <button type="button" class="btn btn--primary btn--big" data-action="again">Play again ▶</button>
      <div class="end__more">
        <button type="button" class="btn btn--ghost" data-action="explore">🧭 Explore</button>
        <button type="button" class="btn btn--ghost" data-action="menu">Change game</button>
      </div>
    </div>`;
  show($('#panel'), false);
  show($('#hud'), false);
  show($('#map-tools'), false);
  show($('#end'));
  fitEndCard();
  if (rating >= 2) confetti($('#confetti'), 200);
  world.home(null, 1600);
  $('#end [data-action="again"]').focus({ preventScroll: true });
}

/** With long names on a small screen, squeeze the score card so it still fits without scrolling. */
function fitEndCard() {
  const screen = $('#end');
  const card = screen.querySelector('.card');
  card.classList.remove('end--tight');
  const pad = getComputedStyle(screen);
  if (card.offsetHeight > screen.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)) {
    card.classList.add('end--tight');
  }
}

// --- Explore mode ---------------------------------------------------------------
// No questions here: the globe shows day and night as they are right now, the
// map can show every name, and tapping a country opens a card about it.  The
// game opens in this mode, on the whole globe with no names.

let exploreId = null;
let exploreTag = null;

function startExplore({ selected = null, keepView = false, opening = false } = {}) {
  if (!opening && !keepView && isCountryRegion(state.region) && provinces !== 'ready') return;
  // The opening globe turns until the player touches it or picks a place to go.
  if (!opening && !keepView) idleGlobe = false;
  if (!keepView) state.playRegion = opening ? 'world' : state.region;
  store.set('region', state.region);
  Object.assign(state, { phase: 'explore', inGame: false, selected: null });
  world.clearResult();
  exploreId = null;
  exploreTag = null;
  showPlayScreen('explore');
  // Fill the card first, so the camera knows how much of the screen it covers.
  renderExplorePanel();
  if (opening) world.home(null, 0);
  else if (!keepView) world.home(homeRegion());
  if (selected != null && data.byId.has(selected)) exploreSelect(selected);
  world.spin(idleGlobe && exploreId == null);
}

/** Show names on the exploring map, or not (the switch is in the Start menu). */
function setNames(on) {
  state.names = on;
  renderNamesSwitch();
  // Behind the menu the names show at once, unless a quiz is paused there.
  if (!state.inGame) world.setLabels(on);
}

function renderNamesSwitch() {
  $('#names-btn').setAttribute('aria-checked', String(state.names));
}

/** With names hidden, a tapped country gets a name tag on the map. */
function showExploreTag() {
  if (exploreTag) world.removeMarker(exploreTag);
  exploreTag = null;
  if (exploreId != null && !state.names) exploreTag = world.addTag(exploreId, label(data.byId.get(exploreId)), 'explore');
}

function exploreSelect(id) {
  exploreId = id;
  world.select(id);
  showExploreTag();
  renderExplorePanel();
  keepInView(id);
}

/** Nudge the map so a tapped country is not hidden behind the card. */
function keepInView(id) {
  const { x, y } = world.screenPoint(id);
  const pad = mapPadding();
  const w = window.innerWidth;
  const h = window.innerHeight;
  let dx = 0;
  let dy = 0;
  if (y > h - pad.bottom) dy = y - (h - pad.bottom) + 40;
  else if (y < pad.top) dy = y - pad.top - 40;
  if (x > w - pad.right) dx = x - (w - pad.right) + 40;
  if (dx || dy) world.map.panBy([dx, dy], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450 });
}

function exploreClear() {
  exploreId = null;
  world.select(null);
  showExploreTag();
  renderExplorePanel();
}

/**
 * The globe button: back to the start view.  Exploring the whole world, that
 * is the opening globe, turning again; otherwise the view of the place.
 */
function resetView() {
  if (state.phase !== 'explore') {
    world.home(homeRegion(), 900);
    return;
  }
  if (exploreId != null) exploreClear();
  idleGlobe = state.playRegion === 'world';
  world.home(homeRegion(), 1200, { opening: idleGlobe });
  world.spin(idleGlobe);
}

/** "68 million people", "830 people" … rounded the way you'd say it. */
function people(n) {
  const short = x => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  if (n >= 1e9) return `${short(n / 1e9)} billion people`;
  if (n >= 1e6) return `${short(n / 1e6)} million people`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} thousand people`;
  if (n >= 1e3) return `${(Math.round(n / 100) * 100).toLocaleString('en')} people`;
  return `${Math.round(n / 10) * 10} people`;
}

// Places whose name alone leads to the wrong English Wikipedia page (one about
// another place, or a "which one did you mean?" page).  Checked October 2026.
const WIKI_TITLES = {
  GEO: 'Georgia (country)',
  FSM: 'Federated States of Micronesia',
  IOA: 'Australian Indian Ocean Territories',
  SHN: 'Saint Helena, Ascension and Tristan da Cunha',
  MAF: 'Collectivity of Saint Martin',
  SGS: 'South Georgia and the South Sandwich Islands',
  'US-GA': 'Georgia (U.S. state)',
  'US-NY': 'New York (state)',
  'US-WA': 'Washington (state)',
};

/** The place's page on the English Wikipedia. */
function wikiUrl(place) {
  const title = WIKI_TITLES[place.code] ?? place.wiki ?? place.name;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

/** "a", "a and b", "a, b and c". */
function listText(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('');
}

/** The card about the tapped place; with nothing tapped there is no panel at all. */
function renderExplorePanel() {
  const panel = $('#panel');
  show(panel, exploreId != null);
  if (exploreId == null) return;
  // Above the Start button; on wide screens held sideways, at the right (see the CSS).
  panel.classList.add('panel--card');
  const c = data.byId.get(exploreId);
  const us = c.kind === 'state' || c.kind === 'district';
  const province = c.kind === 'province';
  // A US state has no flag emoji: its two-letter code goes there instead.  A
  // province shows its country's flag.
  const badge = us ? `<span class="info__badge" aria-hidden="true">${escapeHtml(c.postal)}</span>` : '';
  const f = us ? '' : flag(province ? data.countries.find(x => x.code === c.country)?.iso2 : c.iso2);
  const parts = [];
  if (c.kind === 'antarctica') {
    parts.push('The icy continent around the South Pole. No country owns it.');
  } else if (province) {
    parts.push(escapeHtml(c.about)); // "A province of China"
  } else if (us) {
    parts.push(c.kind === 'state' ? `A state in ${escapeHtml(regionWords(c.cont[0]))}` : 'The capital of the United States');
  } else {
    if (c.sov) parts.push(`Part of ${escapeHtml(data.byId.get(c.sov).name)}`);
    parts.push(escapeHtml(c.cont.join(' and ')));
  }
  if (c.pop && c.kind !== 'antarctica') parts.push(`about ${people(c.pop)}`);
  const facts = parts.join(' · ');
  // Capital, nickname or languages (from data/facts.json); some places have none.
  const details = [];
  const capitals = [c.capital ?? []].flat();
  if (capitals.length) details.push(['🏛️', capitals.length > 1 ? 'Capitals' : 'Capital', listText(capitals)]);
  // The place's page on Wikipedia: after the fun fact, or by itself where there is none.
  const more = `<a class="info__more" href="${escapeHtml(wikiUrl(c))}" target="_blank" rel="noopener noreferrer"
    aria-label="Learn more about ${escapeHtml(c.name)} on Wikipedia (opens in a new tab)">Learn more ↗</a>`;
  if (c.nickname) details.push(['🏷️', 'Nickname', c.nickname]);
  if (c.languages?.length) details.push(['🗣️', c.languages.length > 1 ? 'Languages' : 'Language', listText(c.languages)]);
  panel.innerHTML = `
    <div class="info">
      <div class="info__head">
        ${badge}
        ${f ? `<span class="info__flag" aria-hidden="true">${f}</span>` : ''}
        <div class="info__titles">
          <h2 class="info__name">${escapeHtml(c.name)}</h2>
          <p class="info__facts">${facts}</p>
        </div>
        <button type="button" class="info__close" data-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      ${details.length ? `<dl class="info__details">${details.map(([icon, title, text]) => `
        <div class="info__detail">
          <dt><span aria-hidden="true">${icon}</span> ${title}</dt>
          <dd>${escapeHtml(text)}</dd>
        </div>`).join('')}
      </dl>` : ''}
      ${c.fact ? `<p class="info__fact"><span aria-hidden="true">💡</span><span><b>Fun fact:</b> ${escapeHtml(c.fact)}
        ${more}</span></p>` : `<p class="info__link">${more}</p>`}
    </div>`;
}

// --- Map taps -------------------------------------------------------------------

let toastTimer;
function toast(html, ms = 2200) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), ms);
}

let peekTag = null;
let peekTimer;
function onTap(id) {
  const country = id == null ? null : data.byId.get(id);
  if (state.phase === 'explore') {
    if (country) exploreSelect(id);
    else exploreClear();
  } else if (state.phase === 'ask') {
    if (!country) return toast(`🌊 That's the sea! Tap on a ${placeWord(state.playRegion)}.`);
    if (country.kind === 'antarctica') return toast('🐧 Brrr! That\'s Antarctica. No countries there!');
    state.selected = id;
    world.select(id);
    renderPanel();
  } else if (state.phase === 'reveal' && country) {
    // After answering, tapping a country tells you its name.
    if (peekTag) world.removeMarker(peekTag);
    peekTag = world.addTag(id, label(country), 'explore');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (peekTag) world.removeMarker(peekTag);
      peekTag = null;
    }, 2500);
  }
}

/** Screen space the map's camera should keep clear of the HUD, buttons and panels. */
function mapPadding() {
  const hud = $('#hud');
  const panel = $('#panel');
  const tools = $('#map-tools');
  const startBtn = $('#start-menu-btn');
  const pad = { top: 20, bottom: 20, left: 20, right: 20 };
  if (!hud.hidden) pad.top = hud.getBoundingClientRect().bottom + 16;
  if (!tools.hidden) pad.right = window.innerWidth - tools.getBoundingClientRect().left + 8;
  if (!startBtn.hidden) pad.top = Math.max(pad.top, startBtn.getBoundingClientRect().bottom + 12);
  if (!panel.hidden) {
    const box = panel.getBoundingClientRect();
    // On phones held sideways, and for Explore mode's card on wide screens,
    // the panel sits at the right, not the bottom.  A bottom panel is centred
    // (on wide screens its left edge can be far from the screen's), so tell
    // them apart by where the panel's middle is.
    const offCentre = (box.left + box.right) / 2 - window.innerWidth / 2;
    if (offCentre > 60) pad.right = Math.max(pad.right, window.innerWidth - box.left + 16);
    else pad.bottom = Math.max(pad.bottom, window.innerHeight - box.top + 16);
  }
  return pad;
}

// --- Wiring ------------------------------------------------------------------------

function wire() {
  $('#region-chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-region]');
    if (!chip) return;
    chooseRegion(chip.dataset.region);
    renderChoices();
  });
  $('#country-chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-region]');
    if (!chip) return;
    chooseRegion(chip.dataset.region);
    store.set('country', state.region);
    renderChoices();
  });
  $('#start-dots').addEventListener('click', e => {
    const dot = e.target.closest('[data-page]');
    if (dot) setMenuPage(Number(dot.dataset.page));
  });
  // Up and down arrows turn the page too, from the dots.
  $('#start-dots').addEventListener('keydown', e => {
    const page = { ArrowUp: 1, ArrowDown: 2 }[e.key];
    if (!page) return;
    e.preventDefault();
    setMenuPage(page);
    $(`.start__dot[data-page="${page}"]`).focus();
  });
  $('#level-chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-level]');
    if (!chip) return;
    state.level = chip.dataset.level;
    renderChoices();
  });
  $('#start-btn').addEventListener('click', startGame);
  $('#explore-btn').addEventListener('click', () => startExplore());
  $('#names-btn').addEventListener('click', () => setNames(!state.names));
  $('#resume-btn').addEventListener('click', resumeGame);
  $('#menu-btn').addEventListener('click', showMenu);
  $('#start-menu-btn').addEventListener('click', showMenu);
  $('#menu-close').addEventListener('click', closeMenu);
  // A tap outside the menu card closes it too.
  $('#start').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeMenu();
  });
  // The opening globe stops turning as soon as the player touches the map
  // (the globe button sets it turning again).
  const settle = () => {
    idleGlobe = false;
    if (state.phase === 'explore') world.spin(false);
  };
  for (const type of ['pointerdown', 'wheel', 'keydown']) $('#map').addEventListener(type, settle, { passive: true });
  $('#panel').addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'check' && state.selected !== null) finishRound(state.selected);
    if (action === 'giveup' && state.phase === 'ask') finishRound(null);
    if (action === 'next' && state.phase === 'reveal') next();
    if (action === 'close' && state.phase === 'explore') exploreClear();
  });
  $('#end').addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'again') startGame();
    if (action === 'explore') startExplore();
    if (action === 'menu') showMenu();
  });
  $('#zoom-in').addEventListener('click', () => {
    settle();
    world.zoomBy(1);
  });
  $('#zoom-out').addEventListener('click', () => {
    settle();
    world.zoomBy(-1);
  });
  $('#zoom-home').addEventListener('click', resetView);
  window.addEventListener('resize', () => {
    if (!$('#end').hidden) fitEndCard();
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('button') && e.key === 'Enter') return; // the button handles it
    if (e.key === 'Enter' && state.phase === 'ask' && state.selected !== null) finishRound(state.selected);
    else if (e.key === 'Enter' && state.phase === 'reveal') next();
    else if (e.key === 'Escape' && state.phase === 'ask' && state.selected !== null) {
      state.selected = null;
      world.select(null);
      renderPanel();
    } else if (e.key === 'Escape' && state.phase === 'explore') {
      exploreClear();
    } else if (e.key === 'Escape' && state.phase === 'menu') {
      closeMenu();
    }
  });
}

function fail(message) {
  $('#loading').innerHTML = `<div class="card"><p class="loading__error">😕 ${message}</p></div>`;
  show($('#loading'));
}

// --- Keeping a game going when the page is updated ----------------------------------
// In the Claude artifact viewer a newer version of this page can replace the
// running one.  These hooks carry the settings, the game and the map view
// across; outside the viewer `window.claude` does not exist and they do nothing.

function snapshot() {
  const center = world?.map.getCenter();
  return {
    region: state.region,
    playRegion: state.playRegion,
    level: state.level,
    names: state.names,
    camera: center ? { center: [center.lng, center.lat], zoom: world.map.getZoom() } : null,
    game: state.inGame
      ? { questions: state.questions.map(q => q.id), picks: state.results.map(r => r.picked?.id ?? null), round: state.round, view: answerView }
      : null,
    explore: state.phase === 'explore' ? { selected: exploreId } : null,
  };
}

/** Continue a game saved by snapshot(). Returns false when there is none. */
function restoreGame(saved) {
  const game = saved?.game;
  const questions = (game?.questions || []).map(id => data.byId.get(id));
  if (!questions.length || questions.some(q => !q) || !(game.round < questions.length)) return false;
  Object.assign(state, { questions, results: [], round: game.round, score: 0, selected: null, inGame: true });
  answerView = game.view ?? null;
  game.picks.forEach((pick, i) => {
    state.score += recordResult(i, pick).points;
  });
  showPlayScreen('quiz');
  renderScore(state.score);
  if (state.results[state.round]) {
    state.phase = 'reveal';
    renderQuestion();
    renderProgress();
    renderPanel();
    showReveal(state.results[state.round], 0);
  } else {
    askRound();
  }
  return true;
}

async function init(saved = {}) {
  if (isRegion(saved.region)) chooseRegion(saved.region);
  if (isRegion(saved.playRegion)) state.playRegion = saved.playRegion;
  if (LEVELS.some(l => l.id === saved.level)) state.level = saved.level;
  if (typeof saved.names === 'boolean') state.names = saved.names;
  if (!webglSupported()) {
    fail('This game needs a newer browser (with WebGL 2). Try the latest Chrome, Safari, Firefox or Edge.');
    return;
  }
  try {
    data = await loadData();
  } catch (err) {
    console.error(err);
    fail('Could not load the map. Check your connection and reload the page.');
    return;
  }
  let ready = false;
  const stuck = setTimeout(() => {
    if (!ready) fail('The map is taking too long to start. Check your connection and reload the page.');
  }, 30000);
  world = new WorldMap($('#map'), data, {
    onTap,
    getPadding: mapPadding,
    onReady: () => {
      ready = true;
      clearTimeout(stuck);
      show($('#loading'), false);
      let resumed = false;
      try {
        if (saved.camera) idleGlobe = false; // the page was updated while someone played
        if (saved.explore) {
          startExplore({ selected: saved.explore.selected, keepView: !!saved.camera });
          resumed = true;
        } else {
          resumed = restoreGame(saved);
        }
      } catch (err) {
        console.error(err);
        state.inGame = false;
      }
      // The game opens on the turning globe, in Explore mode.
      if (!resumed) startExplore({ opening: true });
      if (saved.camera) world.map.jumpTo(saved.camera);
    },
    onError: err => {
      console.error(err);
      if (!ready) fail('The map could not start. Reload the page to try again.');
    },
  });
  wire();
  // A small hook for automated tests and the curious.
  window.countryQuest = {
    state, data, world, startGame, finishRound, next,
    get provinces() { return provinces; }, // 'idle' (until the menu opens), 'loading', 'ready' or 'failed'
  };
}

const hot = window.claude?.hot;
hot?.snapshot?.(snapshot);
if (hot?.ready) hot.ready(init);
else init(hot?.data ?? {});
