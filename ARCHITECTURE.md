# How Kinder Geo works

This is the guide for working on Kinder Geo: how the code is put together,
why it is built that way, and how to change it without breaking it. The
[README](README.md) describes the game, where it runs and how to deploy it;
read that first. (The game was first called Country Quest, and some names in
the code keep that name: `window.countryQuest`, the `cq.` storage keys.)

Contents: [In one minute](#in-one-minute) ·
[Design rules](#design-rules) · [Code map](#code-map) ·
[How the pieces fit](#how-the-pieces-fit) · [The app](#the-app) ·
[The data](#the-data) · [The map](#the-map) ·
[Working on it](#working-on-it) ·
[The Claude artifact version](#the-claude-artifact-version) ·
[Deploying](#deploying) · [Status and open items](#status-and-open-items)

## In one minute

- **The game.** A geography game for kids on a colourful map with no names.
  - It opens in *Explore mode*: a slowly turning globe that shows day and
    night as they are right now. Tapping a place opens a card about it.
  - The *quiz* asks for 10 places. A pick scores 100 if it is right, 50 for a
    neighbour and 25 for the same continent (for US states, the same census
    region). Anything else scores 0.
- **Only static files.** There is no server code, no accounts and no database.
  Any web server that can hand out files can host it.
- **No build step.** The browser loads plain JavaScript modules, CSS and HTML
  as they are. There is no npm, bundler or framework. MapLibre GL JS, the map
  engine, is kept in `vendor/`.
- **Map data is made ahead of time.** Python scripts (standard library only;
  the provinces also use mapshaper through npx) turn Natural Earth's
  public-domain borders into compact JSON in `data/`.
  They work out neighbours, continents and colours in advance. The facts on
  the cards are written by hand.
- **Nothing leaves the device.** The page loads only its own files: no
  analytics, cookies, ads, or fonts and scripts from other sites. Settings and
  best scores stay in the browser's `localStorage`.

## Design rules

These choices are deliberate. Keep them unless you mean to change the game.

- **The quiz map never shows names or the night shadow**, so every country is
  easy to see. Names appear only after answering (as name tags), or in Explore
  mode with **Show names** on.
- **Nothing is too small to tap.**
  - Tiny countries can't be tapped on the globe. Once zoomed in, they get a dot
    that can be tapped.
  - They are only asked if at least a million people live there (`isAsked`).
  - Taps have 14 px of slack.
- **The globe stays round until it covers the whole screen**, corners
  included. Only then does it unroll into a flat map, over one zoom level.
- **Camera moves turn the globe in place.** They don't slide the whole globe
  across the screen, and they keep answers clear of the panels. **Next** flies
  back to where the player was looking.
- **Screens fit without scrolling** on phones, both upright and on their side:
  the Start menu, the score card and the cards. Check new screens on the three
  sizes `tools/check.py` uses.
- **Calm and friendly.**
  - No timers and no sound.
  - Few buttons: three small see-through map buttons and a Start button.
  - Encouraging messages.
  - `prefers-reduced-motion` turns off the spinning, flights and confetti.
- **Plain words** that young children can read, in everything the player sees.
- **Facts must be true**: short (30–130 characters), friendly, and checked
  against a reliable source.

## Code map

| Path | What it does |
|---|---|
| `index.html` | The page. Every screen and button is here from the start, hidden until needed. Loads `js/main.js`. |
| `js/main.js` | The app: game state and phases, screens, panels and cards, taps, buttons, keyboard and storage. |
| `js/map.js` | `WorldMap`, a wrapper round MapLibre: the map style and layers, the switch from globe to flat map, tapping, highlights, name tags, camera moves, day and night, spinning. |
| `js/game.js` | The rules, as pure functions: points, regions, levels, choosing questions, stars. |
| `js/data.js` | Loads `data/*.json` and decodes the geometry into GeoJSON. |
| `js/flags.js` | Flag emoji from two-letter country codes, only where the device can draw them. |
| `js/confetti.js` | A short burst of confetti on a canvas. |
| `css/style.css` | All styling and layout, for every screen size. |
| `data/` | The generated map data, and the hand-written `facts.json`. |
| `vendor/maplibre-gl/` | MapLibre GL JS 6.15.0 (BSD-3-Clause): ES module, worker and CSS. |
| `assets/` | Icons, and the Fredoka font (SIL OFL). |
| `tools/build_data.py`, `tools/build_states.py` | Build `data/` from Natural Earth. |
| `tools/build_provinces.py` | Builds `data/provinces.json`, the places inside the countries on the Start menu's second page (Natural Earth, and geoBoundaries for Bangladesh's districts), fitted to the world map with mapshaper. |
| `tools/serve.py` | A web server for development, for this computer and for phones on the same network. |
| `tools/check.py` | The automated checks, in a headless browser. |
| `tools/build_artifact.py` | Builds the version published as a Claude artifact. |
| `tools/build_firebase.py` | Copies the site into `firebase/public/`, ready to deploy. |
| `tests/unit.html`, `tests/unit.js` | Unit tests that run in the browser. |
| `firebase/` | Only what Firebase Hosting needs: `firebase.json`, and `public/`, a copy of the site. |

Words used in the code:

| Word | Meaning |
|---|---|
| place | Anything on the map with an id: a country, a territory, Antarctica, a US state, Washington, D.C., or a province of another country. |
| region | What the Start menu offers: on its first page `world`, a continent, or `us-states` (`REGIONS` in `game.js`); on its second, a country's code such as `CHN`, for that country's provinces (`COUNTRY_REGIONS`). |
| province | A place inside one of the countries on the menu's second page (`kind: 'province'`): a Chinese province, an Indian state, a district of Bangladesh … Its `country` is that country's code. The code calls the US states and provinces "states" together: `setStates()`, the `state-*` layers. |
| tier, level | The data build gives each place a tier from 1 (big and famous) to 3. A level (Easy, Medium or Hard) asks from some of the tiers (`LEVELS`). |
| dot | The tappable circle for a tiny place, shown once zoomed in. |
| morph, unrolling | The switch from globe to flat map. `morph.start` and `morph.end` are its zooms, and `globeness()` says how far along it is. |
| padding, free part of the screen | The part of the screen not covered by the top bar, the panels and the buttons (`mapPadding()` in `main.js`). |

## How the pieces fit

```
                         index.html
                             │
                        js/main.js ─── state, screens, panels, buttons, storage
         ┌──────────┬────────┴───┬────────────┬──────────────┐
    js/data.js   js/map.js    js/game.js   js/flags.js   js/confetti.js
         │      (WorldMap)    (rules)
         │          │
    data/*.json   vendor/maplibre-gl
         ▲
  tools/build_data.py, tools/build_states.py ◄── Natural Earth (downloaded once to .cache/ne/)
  tools/build_provinces.py ◄── Natural Earth 1:10m, geoBoundaries (.cache/gb/), mapshaper
  data/facts.json (written by hand)
```

`main.js` runs the game and tells `WorldMap` what to do:

- draw things: `select`, `showResult`, `addTag`, `setLabels`, `setNight`,
  `setStates`;
- move the camera: `home`, `showCountries`, `restoreView`, `zoomBy`;
- turn the opening globe: `spin`.

`WorldMap` reports taps back through its `onTap` hook, with the id of the
tapped place, or `null` for the sea. `WorldMap` never changes the game's state,
and `game.js` knows nothing about the page.

The map also needs to know how much of the screen is covered. Its
`getPadding` hook (`mapPadding()` in `main.js`) measures the top bar, the panel
or card and the map buttons on the page. So **show a panel before moving the
camera**, as `finishRound()` and `startExplore()` do.

## The app

### Start-up

1. `init()` in `main.js` runs. Without WebGL 2, it shows a message and stops.
2. `loadData()` fetches the data files:
   - `world.json` and `countries.json`, which are needed;
   - `facts.json` and `us-states.json`, which are optional (the game works
     without them).

   It adds the facts to the places and decodes the geometry.
3. `new WorldMap(...)` builds the MapLibre style in code and creates the map.
   If the map isn't ready within 30 seconds, the loading screen says so.
4. When MapLibre fires `load`, the loading screen goes away and
   `startExplore({ opening: true })` shows the turning globe.
5. The first time the Start menu opens, `loadProvinces()` fetches
   `provinces.json`, adds the provinces to `data` and `WorldMap.addStates()`
   adds their shapes to the map. Until then (and if it fails) the menu's
   second page says so and its buttons wait; if it failed, opening the menu
   again tries again.

Inside the Claude artifact viewer, `window.claude.hot` lets a newer version of
the page take over from a running one:

- `snapshot()` saves the settings, the game in progress and the camera;
- `init(saved)` puts them back.

Anywhere else, `window.claude` doesn't exist and `init()` starts fresh.

### Phases

`state.phase` is one of `loading`, `explore`, `menu`, `ask`, `reveal` or
`done`.

| From | When | To |
|---|---|---|
| `loading` | the map is ready | `explore`: the opening globe |
| `explore` | the Start button | `menu` |
| `menu` | **Let's go!** | `ask`: a new game |
| `menu` | **Explore** | `explore`: flies to the chosen place |
| `menu` | close button, Escape, a tap beside the menu | `explore`, or back to the paused game |
| `ask` | tap a place, then **Check** (or Enter) | `reveal` |
| `ask` | **Show me** | `reveal`, for 0 points |
| `reveal` | **Next** | `ask` for the next round; `done` after the last one |
| `ask`, `reveal` | the menu button | `menu`: the game is paused, and **Back to my game** carries on |
| `done` | **Play again**, **Explore**, **Change game** | `ask`, `explore`, `menu` |

What each mode shows (set in `showPlayScreen()`):

| | Explore | Quiz (`ask`, `reveal`) |
|---|---|---|
| Top bar `#hud` | no | what to find, progress, score |
| Start button `#start-menu-btn` | yes | no |
| `#panel` | the card of the tapped place (no panel if nothing is tapped) | the hint, **Check** and **Show me**; then the result and **Next** |
| Names | if **Show names** is on | never |
| Night shadow | yes | never |
| US states or a country's provinces drawn | when exploring the US States or a country on the menu's second page | in a quiz of them |
| Other countries and the sea muted | with states or provinces drawn | with states or provinces drawn |

The opening globe turns by itself (`idleGlobe`) until the player touches the
map (a pointer, the mouse wheel or a key) or chooses a place.

The globe button (`resetView()`) goes back to the start view. When exploring
the whole world, that is the opening globe, which starts turning again.

### State and storage

- **`state`** in `main.js` holds:
  - the settings (region, level, names);
  - the current game (questions, results, round, score, selection);
  - the phase.
- **`localStorage`** keys all start with `cq.`:
  - `region` and `level`;
  - `country`: the last country chosen on the menu's second page;
  - `recent`: the last 80 ids asked, so new games ask other places first;
  - `best.<region>.<level>`, or `best.<country code>` for a country's
    provinces, which have no levels.

  Reading and writing never throw; in private browsing nothing is remembered.
  **Show names** is not stored, so every visit starts without names.
- **`?seed=<number>`** in the address makes the questions repeatable. The
  checks use it.
- **`window.countryQuest`** gives the checks, and anyone in the browser
  console, `state`, `data`, `world`, `startGame`, `finishRound` and `next`,
  and `provinces`: whether `provinces.json` is `idle` (the menu hasn't opened
  yet), `loading`, `ready` or `failed`.

### Screens and layout

- **Elements.** Everything is in `index.html` from the start and is shown or
  hidden with the `hidden` attribute:
  - the top bar `#hud`, the map buttons `#map-tools` and the Start button
    `#start-menu-btn`;
  - `#panel`: the quiz panel, or in Explore mode the card (`panel--card`);
  - the full-screen `#start` (the menu), `#end` (the score card) and
    `#loading`;
  - `#toast` and `#confetti`.
- **Panels** are rebuilt from template strings, and every name goes through
  `escapeHtml()`. Their buttons carry `data-action`, and one listener per
  container handles them.
- **`css/style.css`** keeps its colours and sizes as custom properties on
  `:root`, and allows for the notches on phones (`env(safe-area-inset-*)`).
- **Layout by screen size:**

| Media query | Layout |
|---|---|
| (none) | The panel at the bottom, the map buttons at the right. |
| `min-width: 760px` | More room on bigger screens. |
| `orientation: landscape` and `min-width: 900px` and `min-height: 501px` | Computers and tablets held sideways: the Explore card sits at the top right, just left of the map buttons. |
| `max-width: 649px` and `orientation: portrait` | Phones held upright, exploring: the map buttons move to the top right, out of the card's way. |
| `max-width: 380px` | Small phones. |
| `max-height: 760px`, `max-width: 420px` | A tighter score card for short and narrow screens. |
| `max-height: 500px` and `orientation: landscape` | Phones on their side: the panels sit at the right, and the Start menu has two columns. |
| `prefers-reduced-motion: reduce` | No animations. |

- **The score card** groups the rounds by points, so it fits on the screen. If
  it is still too tall (long names on a small screen), `fitEndCard()` adds
  `.end--tight`. It checks again when the window is resized.
- **The Explore card:** `keepInView()` moves the map so the tapped place isn't
  hidden behind the card.
- **Keyboard:**
  - Enter checks an answer or goes on to the next round;
  - Escape clears the selection, or closes the card or the menu;
  - on each screen, focus moves to its main button.

## The data

### Places

`loadData()` returns one list of places, plus `byId` and the decoded
geometry. The list has the countries and other map areas from
`countries.json`, then the states from `us-states.json`; `loadProvinces()`
adds the provinces from `provinces.json` to it later (see Start-up). Japan,
for example:

```json
{ "id": 85, "code": "JPN", "name": "Japan", "iso2": "JP", "kind": "country", "cont": ["Asia"], "tier": 1,
  "land": [], "sea": [145, 163, 173], "area": 370118, "pop": 126264931,
  "label": [138.442, 36.143], "bbox": [129.58, 31.015, 145.833, 45.51], "color": 1 }
```

From `facts.json` each place also gets `capital`, `languages` (or a state's
`nickname`) and `fact`.

| Field | Meaning |
|---|---|
| `id` | The number used everywhere at run time: feature ids, neighbour lists, the game state. Countries come first, then territories, then Antarctica, each in order of name: 1–240. States and D.C. are numbered from 1001, provinces from 2001 (country by country, in the menu's order). Ids can change when the data is rebuilt; codes don't. |
| `code`, `iso2` | `code` is the three-letter ISO 3166 code where there is one (Kosovo is `XKX`), `US-TX` for a state, or the ISO 3166-2 code for a province (`CN-GD`, `BD-13`; the regions of England and France get codes like `GB-NEE` and `FR-ARA`); `facts.json` is keyed by it. `iso2` is the two-letter code that gives the flag emoji. |
| `kind` | `country` (the 197 that can be asked about), `territory` (Greenland, Puerto Rico, French Guiana, …), `antarctica`, `state`, `district` (Washington, D.C.) or `province`. A territory's `sov` is the id of the country it belongs to. |
| `country` | States and provinces: their country's code (`USA` for the states, which `loadData()` adds). |
| `about` | Provinces: what the place is, for its card ("A province of China", "A district in Dhaka Division"). |
| `wiki` | Provinces whose English Wikipedia page is not their name. |
| `cont` | The continents. Russia, Turkey, Cyprus, Georgia, Armenia and Azerbaijan have two. For a state this is its census region; for a province, the part of its country it is in (East China, South India, Western Canada, England, Dhaka Division), or nothing where the country has no such parts. |
| `tier` | 1 is easy, 2 medium and 3 hard; 0 for places that are never asked. |
| `land`, `sea` | Ids of the neighbours that share a border (or touch at a point), and of those across the water. Both lists always go both ways. |
| `area`, `pop` | The area in km², and the population: Natural Earth's estimate, or for states and a few overseas areas the number in `facts.json`. |
| `label` | Where the place's name goes. |
| `bbox` | The box the camera fits, `[west, south, east, north]`. It covers only the main landmasses, so the USA's box leaves out the far Aleutians. `east` can be past 180 for a place that crosses the date line. |
| `color` | Which colour in `PALETTE` (`map.js`) the place gets. Antarctica has −1 and is drawn as ice. |
| `dot` | Tiny places only: the zoom up to which the place is too small to tap (less than about 18 px wide), so a dot marks it. A province gets one only when it is too small to tap in its country's view on a phone. |
| `postal` | States only: the two-letter code, shown where a country shows its flag. |

### Files

- **`world.json`**: `{ q, countries: [{ id, polys }], lines: [{ a, b, lines }] }`.
  - Coordinates are whole numbers in thousandths of a degree (`q` is 1000,
    about 110 m). Each is stored as the difference from the one before:
    `[x0, y0, dx1, dy1, …]`.
  - `polys` are the place's polygons, each a list of rings: the outline, then
    any holes.
  - Each entry in `lines` is the edge between places `a` and `b`; `b` = 0
    means it is a coast.
  - The map draws borders and coasts from `lines`. To outline a place, it
    filters the lines whose `a` or `b` is that place's id.
- **`countries.json`**: `{ source, countries: [place, …] }`.
- **`us-states.json`**: `{ source, q, states, polys, lines }`. These are the
  same shapes for the 50 states and Washington, D.C. Here `b` = 0 also covers
  the borders with Canada and Mexico, which the country layers already draw.
- **`provinces.json`**: `{ source, q, provinces, polys, lines }`, like
  `us-states.json`, for the provinces of all the countries on the menu's
  second page. Every province's edges are in `lines` (`b` = 0 for its coasts
  and its country's borders).
- **`facts.json`**: `{ about, places: { CODE: { capital, languages, nickname, fact, pop } } }`.
  - `capital` can be a list (South Africa has three); a missing `capital` means
    the place has none.
  - The unit tests check that:
    - every place on the world map has a fact of 30–130 characters that ends
      a sentence;
    - every country has a capital and languages;
    - every state has a capital, a nickname, a population and a fact.

### Building the data

`python3 tools/build_data.py`, or with `--report` to also print every
neighbour list, goes through these steps:

1. **Download.** It downloads Natural Earth's 1:50m countries (with lakes) to
   `.cache/ne/`, on the first run only.
2. **Round and fix.** It rounds the coordinates to thousandths of a degree,
   then fixes the source to match UN-recognised borders and what people
   expect:
   - `MOVE` moves Crimea to Ukraine.
   - `MERGE` joins these into their countries: Northern Cyprus, Somaliland,
     Siachen, Hong Kong, Macau, Åland, Jersey, Guernsey and the Isle of Man.
   - `SPLIT` splits French Guiana, Réunion and other overseas areas off France,
     the Netherlands and New Zealand, so tapping them doesn't say "France".
   - Merged shapes are dissolved, so no border is left running through them.
3. **Kinds.** The 193 UN members, plus Vatican City, Palestine, Kosovo and
   Taiwan, are countries. Everything else is a territory.
4. **Borders and land neighbours.** It sorts every edge into a border or a
   coast and joins the edges into lines. Places that share an edge or a corner
   are land neighbours.
5. **Sea neighbours.**
   - Coasts within 150 km of each other count, as long as the straight line
     between them doesn't cross a third country. A 0.05° land grid checks
     that.
   - Island countries left with no neighbours get their nearest three within
     500 km.
   - `EXTRA_SEA_NEIGHBORS` and `NOT_NEIGHBORS` change the result by hand.
6. **Colours.** It colours the map like a graph (the DSatur method) with 7
   colours, so neighbours by land or sea don't share one.
7. **Tiers and dots.**
   - `EASY` lists the easy countries.
   - Of the rest, countries of 10,000 km² or more are medium, and smaller ones
     hard.
   - Countries under 7,000 km² get a `dot` zoom.
8. **Write.** It writes `world.json` and `countries.json`, and prints a
   summary.

`python3 tools/build_states.py` does the same for the states, using the same
helpers on Natural Earth's states and provinces file. Run it **after**
`build_data.py`. It reads the colours of Canada and Mexico, so that a border
state never has the same colour as the country next door. The neighbours
across Lake Michigan, Lake Superior and Delaware Bay are added by hand
(`EXTRA_WATER_NEIGHBORS`).

`python3 tools/build_provinces.py` (also after `build_data.py`) makes
`provinces.json` for the countries in its `COUNTRIES` list:

1. **Sources.** Natural Earth's 1:10m states and provinces, grouped by
   `group_key()`: France's départements into regions, the UK's councils into
   England's regions and the other three nations, small islands into the place
   they belong to. Bangladesh's 64 districts come from geoBoundaries (their
   names, divisions and populations are in `BANGLADESH`).
2. **Fit.** mapshaper (run with npx) merges each place's shapes, simplifies
   them with shared borders kept shared, and cuts them to the country's own
   shape in `world.json`. `settle()` gives each bit of the country that no
   place covers to the place it shares the longest border with, so the places
   fill the country exactly and their coasts and borders are the world map's.
   A place the world map hardly draws (Macau, Lakshadweep) keeps its own shape.
3. **The rest** is as for the states: neighbours from shared edges, a few
   across the water by hand, colours that differ from the neighbours and from
   the countries next door, names in English (`NAMES`), what each place is
   (`about()`), the part of the country it is in (`region()`), and a dot for
   places too small to tap in their country's view on a phone.

Natural Earth's files are downloaded from the latest version of its
repository, so a fresh download may be a little different. After rebuilding,
read the printed summary and the `--report` lists, then run the unit tests.
They check the neighbours both ways, the colours, well-known neighbours, the
counts (197 countries, 169 of them asked, 50 states, and each country's
provinces) and the facts.

## The map

Everything here is in `js/map.js`.

### Style and layers

`buildStyle()` builds the map style in code. Its sources are GeoJSON made from
the decoded data, so there is no tile, glyph or sprite server. The layers, from
bottom to top:

| Layers | What they draw |
|---|---|
| `ocean`, `graticule`, `shallows` | The sea colour, grid lines every 30°, and a soft light glow along the coasts. |
| `land`, `land-result` | The country colours, and the answer colours over them (from feature state): the answer in green, the player's pick in orange, yellow or red. |
| `state-land`, `state-result`, `state-borders` | The same for the US states and other countries' provinces, hidden until one country's are chosen. Every feature's `s` is its country's code, and `setStates(country)` filters these layers by it (`STATE_FILTERS`). |
| `borders`, `coast` | White borders and blue coastlines. |
| `night` | The night shadow (Explore mode only). |
| `land-highlight`, `state-highlight` | A white glow on the place under the mouse or the selected one. It is above the night layer, so it shows there too. |
| `target-outline`, `selected-outline`, and their `state-` versions | Outlines, drawn by filtering `lines`. |
| `dots`, `state-dots` | The dots for tiny places. |
| `ocean-labels`, `sea-labels`, `dot-labels`, `country-labels`, `state-dot-labels`, `state-labels` | Names (hidden unless **Show names** is on). |

While a country's states or provinces are drawn, `setStates()` mutes everything
else: the other countries (`land`, with `MUTED_PALETTE`), their borders and
coasts, and the sea (`ocean`, `shallows`, `graticule`) get colours half as
colourful and at 30% of their brightness (`MUTED_SATURATION`,
`MUTED_BRIGHTNESS`; `muted()` works like CSS's `saturate()` and
`brightness()`). An answer shown on another country keeps its bright colour,
since `land-result` is drawn on top.

How each place looks comes from MapLibre *feature state* on the `countries`,
`dots`, `states` and `state-dots` sources:

- `hover`;
- `selected`;
- `result`: one of `target`, `neighbor`, `continent` or `miss`.

`setState()` sets it on both a place's shape and its dot.

### Globe, then flat map

The projection is a zoom expression. It is a globe (`vertical-perspective`) up
to `morph.start` and becomes flat (`mercator`) by `morph.end`, one zoom level
later.

`morph.start` is just past `fillZoom()`, the zoom where the globe covers the
corners of the screen. That zoom depends on:

- the size of the screen;
- the camera padding: a panel at the side moves the globe off centre, so it
  has to grow more to reach the far corners;
- the latitude: MapLibre draws the globe 1/cos(latitude) times bigger towards
  the poles. For the switch, latitudes are capped at 60°.

`fillZoom()` works this out from MapLibre's camera. Seen from a camera at
distance *d*, a globe of radius *R* looks like a disc of radius
R/√(1 + 2R/d). The unit tests compare the result with zooms measured in
MapLibre 6.15.

As the camera moves, `retuneMorph()` moves the switch zooms to match. It edits
MapLibre's projection object in place, because `setProjection()` would reload
every tile.

`globeness()` says how round the map is: 1 for the globe, 0 for the flat map.

- Taps in the sky are only possible on the full globe, because it starts
  unrolling only once it covers the screen.
- A flick spins the map as long as it is still at least partly round.

### Drawing and tapping while it unrolls

Part way through the unrolling, MapLibre *draws* every point somewhere between
where the globe and the flat map would put it. But `project()`,
`queryRenderedFeatures()` and markers still work as if it were the globe. So:

- `drawnPoint(lngLat)` works out where a place is really drawn. It blends the
  two positions the way MapLibre's shaders do, by position times depth.
- `queryPoint(point)` goes the other way, using Newton's method. It turns the
  point on screen where a place is drawn into the point to ask MapLibre about.
- `placeMarkers()` moves the name tags by the difference whenever the map
  moves.

`tools/check.py` checks this by reading pixels while the globe unrolls over
Europe.

### Tapping

`pick()` decides what a tap hits:

1. A tap in the sky around the globe hits nothing. `onMap()` checks this
   because MapLibre would answer with the globe's edge.
2. Names come first: tapping a name selects its place.
3. Then dots and shapes. A tiny place can be tapped only once it can be seen:
   from about half way through the unrolling (`dotsFrom`), when its dot
   appears.
4. If nothing is right under the finger, it looks in a 28 px box (14 px either
   way). It prefers a dot, then the smallest place.
5. When a country's states or provinces are drawn, the country's own shape is
   ignored, so a tap there picks one of them.

### Camera

- **`home(region)`** shows the opening globe, or a region's box from
  `REGION_BOUNDS`.
  - Apart from going back to a saved view, it is the only move that changes
    the camera padding, so the globe sits in the middle of the free part of
    the screen.
  - With `opening`, the globe also turns back to face the line between day and
    night.
- **`move()` and `showCountries()`** keep the padding and pass an `offset`
  instead, so showing an answer turns the globe in place rather than sliding
  it across the screen.
  - An answer is shown 0.6 zoom levels further out than a tight fit, so the
    neighbours show too, and never closer than zoom 5.
- **`view()` and `restoreView()`**: when the player answers, the game saves the
  view, and **Next** flies back to it.
  - If the screen has changed size since (a phone turned round),
    `restoreView()` returns false and the game goes to the home view instead.
- **Every camera move** first calls `glide(null)`, which stops a spin.
- **With reduced motion**, moves jump instead of flying.

### Day and night

- **The sun.** `sunPosition()` works out where the sun is straight overhead.
- **The picture.** `nightCanvas()` paints one 512 px picture of the whole
  world in Web Mercator. It is darker where the sun is lower, with dusk running
  from the horizon to 12° below it (`darkness()`).
- **Loading it.** MapLibre loads the picture as a map tile from a made-up
  `cq-night://<time>` address (`addProtocol`), so nothing is downloaded.
- **Keeping it current.** The time is rounded to 2 minutes. Every 30 seconds,
  and whenever the page is shown again, a newer time swaps in a new tile.
- **Zoomed in,** the shadow is lighter.
- **The opening globe** faces the sunrise or sunset line nearest the player.
  The player's longitude is guessed from the clock's time zone
  (`openingLongitude()`).

### Spinning

**The opening turn.** `spin(true)` turns the globe 4° a second until the
player touches the map. While anything else moves the camera, it waits.

**Flicks.** If the player lets go of the globe while it is moving, `glide()`
keeps it turning, slowing down like a real globe.

- **The speed** comes from `flickSpeed()`. During a drag, the code records the
  camera centre each time the map moves. It takes the speed over about the last
  80 ms. The times used are when the pointer moved, not when frames were drawn,
  because a slow device draws frames late.
- **Holding still** for more than 100 ms before letting go means no spin.
- **Slowing down.** `slowDown()` solves dv/dt = −v/τ − friction exactly for
  each frame, so the spin is the same at any frame rate. `SPIN_LNG` and
  `SPIN_LAT` set the feel. Tipping the globe north or south stops much sooner
  than turning it.
- **Stopping.** Touching the map (`pointerdown`) stops the spin at once, and so
  does any camera move.

On the globe, the `dragend` handler turns off MapLibre's own slide after a drag
with `dragPan.enable({ maxSpeed: 0 })`. MapLibre fires `dragend` before it
works out its slide, so this takes effect for the drag that just ended. The
flat map keeps MapLibre's slide.

### Names

- **No glyph server.** MapLibre draws the text itself in the page's Fredoka
  font (`text-font: ['Fredoka SemiBold', 'Fredoka']`).
- **Size and order.** Bigger places get bigger text (`rank`) and are placed
  first (`symbol-sort-key`), so they win when names would overlap.
- **Tiny places:** the name sits under the dot, and shows only once the dots
  do.
- **States and provinces:** when a country's are drawn, its name is hidden and
  theirs show instead.
- **Oceans and seas:** their names and positions are listed in `OCEANS` and
  `SEAS`.

### MapLibre details the code relies on

Check these when upgrading MapLibre:

- `retuneMorph()` uses `map.style.projection.setProjection()`,
  `.updateTransitions()` and `map._update()`. If they are missing, the switch
  zooms stay where they were first set.
- `drawnPoint()` copies how MapLibre blends the globe and the flat map.
- `dragend` fires before MapLibre works out its slide.
- `jumpTo()` stops gestures and flights, so the spin loops check
  `map.isMoving()` before they move the camera.
- When MapLibre comes from a CDN (the artifact version),
  `startWorkersFromCdn()` starts the worker as a classic worker instead of a
  module worker, because the host's security rules block the module one.
- MapLibre positions markers with `transform`, so the animated parts of a name
  tag are children of the marker element, never the element itself.

To upgrade MapLibre:

1. Replace the files in `vendor/maplibre-gl/`.
2. Change the version in `tools/build_artifact.py`.
3. Measure the zooms again for the unit test "the globe covers the screen at
   the zoom MapLibre does".
4. Run `tools/check.py`; its globe checks read pixels from the screen.

## Working on it

### Running it

```sh
python3 tools/serve.py 8642     # http://localhost:8642/, plus an address for phones on your network
```

- `serve.py` compresses text files and sends `Cache-Control: no-cache`, so a
  reload always gets your latest changes. It doesn't serve hidden folders
  (`.cache`, `.venv`) or list directories.
- Opening `index.html` straight from disk doesn't work, because browsers block
  ES modules on `file://`.

### Code style

- **JavaScript** is modern, as current browsers run it: no transpiling, and
  no dependencies apart from MapLibre. Keep to what the browsers in the README
  support (Safari on iOS 15 and later, and recent Chrome, Firefox and Edge).
- **The tools** are Python 3, using only the standard library.
- **Comments** say why, in plain sentences, with `/** … */` above functions.
  Constants are UPPER_CASE at the top of a file.
- **Spelling:** comments and docs use British spelling (colour, neighbour).
  Names in the code use American spelling (`color`, `neighbor`).
- **No outside requests:** don't add scripts, fonts, analytics or anything
  else loaded from other sites. Put what's needed in `vendor/` or `assets/`.

### Tests

**Unit tests** (`tests/unit.js`, 43 tests): start the server and open
`/tests/unit.html`. They cover:

- scoring;
- choosing questions, levels and regions;
- the generated data: neighbours, colours, counts, facts and the US states;
- the sun and the night shadow;
- the zoom at which the globe fills the screen;
- how a flicked globe slows down.

They use a tiny `test()` and `eq()` helper, with no test framework.

**Automated checks** (`tools/check.py`):

- It serves the folder and runs the unit tests.
- It plays the game in headless Chromium on three screens: a desktop
  (1366×820), a phone (390×844) and a phone on its side (844×390).
- It prints an `ok` or `FAIL` line for each check, saves screenshots to
  `test-results/`, and exits with an error if any check fails.

| Flow | What it checks |
|---|---|
| `opening_flow` | The opening globe: the Start button at the top in the middle, small see-through map buttons, no names, it turns until touched, the night side is darker, a fact card, the Start menu fits and has the names switch, a tiny country, the globe button. |
| `flick_flow` | A flick spins the globe on, and it slows down and stops by itself. A touch stops it at once. Holding still before letting go gives no spin. |
| `play_full_game` | A whole game with real taps for each outcome. The globe turns to each answer, and **Next** flies back. Also **Show me**, a tap in the sea, the score card's groups and fit, and **Play again**. |
| `explore_flow` | Names on, a country card and where it sits, names off with a name tag, then back to a quiz with no names. |
| `us_states_flow` | A US States quiz answered by tapping states, then state names and a state card. |
| `province_flow` | The Start menu's second page: its dot, the country chips, a quiz of Bangladesh's districts with the other countries muted, the first page keeping its own choice, and nothing muted back on the world. |
| `globe_flow` | Pixel checks: the globe covers every corner before it unrolls, the map is flat one zoom level later, and while it unrolls countries are drawn and tapped where the game expects. |

```sh
virtualenv .venv && .venv/bin/pip install playwright
.venv/bin/python -m playwright install chromium --only-shell
.venv/bin/python tools/check.py
```

- **Speed:** the browser draws with software WebGL (SwiftShader), so the
  checks never use the GPU, but they are slow. On a busy shared machine, run
  them with `nice -n 19`; there they take about 15–25 minutes.
- **Browser location:** to keep the browser inside the project folder, set
  `PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright` for both the install and
  the checks.
- **Emoji:** on a Linux machine with no colour emoji font, flags and emoji
  don't show in the screenshots. The checks pass either way.

**Writing a check:** add a `something_flow(g)` function and call it from
`main()`.

- `g.js()` runs code in the page, usually through `window.countryQuest`.
- `g.tap()` taps the way the device would (a finger on phones).
- `g.idle()` waits for the map to finish drawing.
- `check(condition, message)` records the result.

On a slow machine:

- wait for the map to be idle rather than for a fixed time;
- send fast gestures, like flicks, as events from inside the page, because
  Playwright's own input is too slow there;
- load the map tiles before timing anything.

### Common changes

| To change | Where | Then |
|---|---|---|
| A fact, capital or language | `data/facts.json`, keyed by code | Unit tests |
| A country's name, the Easy list, continents | `NAMES`, `EASY`, `CONTINENT_OVERRIDE` in `tools/build_data.py` | Rebuild the data, run the unit tests |
| Neighbours | `EXTRA_SEA_NEIGHBORS` and `NOT_NEIGHBORS` (`build_data.py`), `EXTRA_WATER_NEIGHBORS` (`build_states.py`) | Rebuild with `--report` and read the lists |
| Points, rounds, stars | `POINTS`, `ROUNDS`, `stars()` in `js/game.js` | Unit tests, and the score card checks in `check.py`, which expect 100, 50, 25 and 0 |
| Levels | `LEVELS` in `game.js`; tiers in the build scripts | Unit tests |
| Which tiny countries are asked | `TINY_MIN_POP` in `game.js` | Unit tests (they expect 169 countries asked) |
| A region's starting view | `REGION_BOUNDS` in `js/map.js` | Look at it on all three screen sizes |
| Map colours | `PALETTE`, `RESULT_COLORS` and `OCEAN` in `map.js` | Also change `COLOURS` in `tools/check.py`, which the pixel checks use. Keep 7 colours (`PALETTE_SIZE` in `build_data.py`), none of them blue. |
| How a flicked globe spins | `SPIN_LNG`, `SPIN_LAT`, `FLICK_TIME`, `FLICK_HOLD` in `map.js` | The unit test keeps its own copy of the `SPIN_LNG` numbers, so update it too |
| The night | the `NIGHT_*` constants, and `nightOpacity` in `globeView()` | The day-and-night pixel check |
| Words the player reads | `main.js` (messages and cards), `index.html` (buttons and the menu) | `check.py` looks for some of them, such as "10 countries to find" |

To rebuild all the data: `python3 tools/build_data.py && python3 tools/build_states.py && python3 tools/build_provinces.py`.

### Adding a country to the menu's second page

1. **Data.** In `tools/build_provinces.py`, add the country to `COUNTRIES`
   and teach `group_key()`, `NAMES`, `WIKI`, `about()` and `region()` about
   it. Rebuild, and look at the `--report` lists and at the map.
2. **Menu.** Add it to `COUNTRY_REGIONS` in `game.js`, with what its places
   are called.
3. **Camera.** Its view fits all its places (`provinceBox()`). If far-away
   islands make that view poor, give it a box in `REGION_BOUNDS`, as Canada
   has.
4. **Tests.** Add its count to the provinces test in `tests/unit.js`.

## The Claude artifact version

`python3 tools/build_artifact.py` writes `.cache/artifact/`, which is published
as a Claude artifact. That host only allows scripts from a few CDNs and fonts
from Google Fonts. So this version:

- loads MapLibre 6.15.0 from jsDelivr and Fredoka from Google Fonts;
- puts the CSS inside the page;
- leaves out the outer HTML tags, which the host adds itself.

The game code is otherwise the same:

- `map.js` notices that MapLibre came from another site and starts its worker
  in a way the host allows.
- The `window.claude.hot` hooks in `main.js` keep a game going while a new
  version is published.

Nothing else depends on this version. A normal deployment uses the files as
they are.

## Deploying

The site is the folder itself; there is nothing to build.

- **Upload:** `index.html`, `manifest.webmanifest`, `css/`, `js/`, `data/`,
  `vendor/` and `assets/`. That is 23 files, 4.5 MB.
- **Leave out** everything else: the docs, `tools/` and `tests/` aren't
  needed, and `.cache/`, `.venv/` and `test-results/` must never go online.

The web server must do three things:

- **Serve `.js` and `.mjs` files as JavaScript.** Browsers refuse to run module
  scripts sent with the wrong type. `.json`, `.webmanifest` and `.woff2` files
  should also get their proper types.
- **Compress text files.** A first visit downloads about 3.5 MB, or about
  1.2 MB compressed. Most of it is MapLibre and `world.json`. `provinces.json`
  (0.8 MB, 0.3 MB compressed) comes only when the Start menu opens.
- **Make browsers check for updates.** The file names carry no version, so use
  `Cache-Control: no-cache` (with ETags), as `serve.py` does. With long cache
  times, a player could end up with a mix of old and new files after an update.

Any static host can do this: Firebase Hosting, GitHub Pages, Cloudflare Pages,
Netlify, nginx or a school's own web server. Cloud Run works too, as a small
nginx container with compression turned on.

### Firebase Hosting

The `firebase/` folder holds only what Firebase needs:

- **`firebase.json`**: the public folder, Firebase's usual ignore list, and
  the caching header.
- **`public/`**: a copy of the 23 files that go online, made by
  `python3 tools/build_firebase.py`. The copy doesn't follow changes to the
  game, so run the script before every deploy. It isn't kept in git.

A copy is simpler and safer than deploying the project folder itself. Firebase's
default ignore list would upload `.cache/` and `.venv/` too: its `**/.*` skips
hidden files, but not the files inside hidden folders (2,101 files instead
of 22).

The settings in `firebase.json`:

- **Caching.** Every file gets `Cache-Control: no-cache`. Without it, Firebase
  lets browsers keep files for an hour.
- **Types and compression** need no settings: Firebase serves `.mjs` as
  JavaScript, compresses with Brotli or gzip, and sends ETags.

The live site is the Firebase project `playkindermap`, at
<https://kindergeo.com> and <https://playkindermap.web.app>. To deploy, use
the [Firebase CLI](https://firebase.google.com/docs/cli) (through npx, so
only Node.js is needed), logged in to the Google account that owns the
project:

```sh
python3 tools/build_firebase.py
cd firebase
npx firebase-tools@latest hosting:channel:deploy try-out --project playkindermap  # a test address
npx firebase-tools@latest deploy --only hosting --project playkindermap           # the real site
```

`kindergeo.com` is registered with Squarespace Domains, whose DNS points it at
Firebase: an `A` record for `@` → `199.36.158.100` and a `TXT` record for
`@` → `hosting-site=playkindermap`. `www.kindergeo.com` isn't set up.

The test address works like the real site and expires after 7 days
(`--expires 30d` at most). The folder also works on its own, so it can be
copied to another computer and deployed from there. Don't run
`firebase init hosting`: it replaces the settings in `firebase.json` with
Firebase's defaults, and offers to replace `public/index.html` with a template.

The free plan includes 10 GB of downloads a month. A first visit downloads
about 1 MB, so that is roughly 9,000 new players; returning players already
have the files. Over the limit, Firebase switches the site off until the next
month, unless the project is on the pay-as-you-go plan ($0.15 per GB above
10 GB, as of October 2026).

## Status and open items

- **Release.** The plan is to publish it as an open-source app for children in
  schools. The code is on GitHub: <https://github.com/quickdahuk/kindergeo>.
- **Hosting.** Live on [Firebase Hosting](#firebase-hosting) at
  <https://kindergeo.com>. Firebase serves the files from servers around the
  world, and keeps no visitor logs in the project unless they are turned on.
  `www.kindergeo.com` isn't set up yet.
- **License:** MIT ([LICENSE](LICENSE)). The parts the game bundles keep
  their own: MapLibre (BSD-3-Clause), Fredoka (SIL OFL), Natural Earth (public
  domain), and geoBoundaries' districts of Bangladesh in `data/provinces.json`
  (CC BY 3.0 IGO, which asks for credit: it is in the README, not yet in the
  game).
- **Privacy** (in the README too): no accounts, cookies, analytics or ads;
  nothing loaded from other sites; settings stay on the device. Schools look
  for this. Keep it true: no outside scripts, fonts or analytics.
- **Provinces** have no capitals or fun facts yet; their cards show what they
  are, Bangladesh's districts their population, and a Wikipedia link.
- **Known gaps:**
  - **Flags on Windows.** Chrome and Edge on Windows can't draw flag emoji, so
    the cards there show no flag. Chromebooks, iPads and Macs are fine.
    Shipping flag images with the game would fix this.
  - **Borders.** For disputed places the map shows one point of view:
    - Taiwan, Kosovo and Palestine are countries;
    - Western Sahara is separate from Morocco;
    - Kashmir is split along the lines each country controls;
    - Crimea is part of Ukraine.

    Some countries, like India and China, have official rules for maps.
    Natural Earth also publishes borders as each country sees them, if a
    version for one country is needed.
  - **English only.**
  - **No offline play.** There is no service worker, although the game can be
    added to a phone's home screen.
