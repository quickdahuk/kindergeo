// The unlabelled world map: MapLibre setup, styling, tapping, highlights and
// camera moves.  Zoomed out it is a globe; once the globe covers the whole
// screen, zooming in further unrolls it into a flat (Mercator) map.  In
// Explore mode the night side of the Earth is shaded, as it is right now.
import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';

// Where MapLibre was loaded from (tools/build_artifact.py swaps in a CDN copy).
const MAPLIBRE_URL = new URL('../vendor/maplibre-gl/maplibre-gl.mjs', import.meta.url).href;
if (new URL(MAPLIBRE_URL).origin !== location.origin) startWorkersFromCdn(MAPLIBRE_URL);

/**
 * MapLibre starts its web worker as a module that imports the worker code.
 * When MapLibre comes from a CDN, a strict page policy can block that import
 * inside a module worker.  So start a classic worker that loads the code with
 * import(), which counts as an ordinary script, and replay any messages that
 * arrive while it loads.
 */
function startWorkersFromCdn(libraryUrl) {
  const workerUrl = new URL('maplibre-gl-worker.mjs', libraryUrl).href;
  const source = `const held = [];
const hold = e => held.push(e);
self.addEventListener('message', hold);
import(${JSON.stringify(workerUrl)}).then(() => {
  self.removeEventListener('message', hold);
  for (const e of held) self.dispatchEvent(new MessageEvent('message', { data: e.data }));
}, err => setTimeout(() => { throw err; }));`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  // MapLibre starts a classic (non-module) worker for URLs ending in ".cjs".
  maplibregl.setWorkerUrl(`${url}#worker.cjs`);
}

// Bright, friendly country colours.  The data build colours the map like a
// graph, so neighbours never share a colour; none of them is blue, so land
// never blends into the sea.
export const PALETTE = ['#FF8A80', '#FFB74D', '#FFE066', '#AEDC6E', '#6FD6A8', '#B79CF2', '#F78FC2'];
export const RESULT_COLORS = { target: '#22C55E', neighbor: '#FB923C', continent: '#FACC15', miss: '#F87171' };
const OCEAN = '#5DB7EA';
const SHALLOWS = '#C9EEFF';
const BORDER = '#FFFFFF';
const COAST = '#2C6E9B';
const ICE = '#F4F9FD';

const MAX_ZOOM = 7;
const REVEAL_MAX_ZOOM = 5;
// The globe stays round until it covers the whole map, corners included (like
// Google Earth), then unrolls into a flat map over the next MORPH_ZOOMS levels.
const MORPH_ZOOMS = 1;
const MORPH_MARGIN = 0.04; // start just past the corners, never before
// Towards the poles the switch is held back: the flat map cannot show them.
const MORPH_MAX_LAT = 60;
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
const MAX_LAT = 85.051129;
const RAD = Math.PI / 180;

// Tiny countries are too small to see or tap on the globe.  They get a dot
// once the globe is half unrolled, fading in over DOT_FADE zoom levels.
const DOTS_AFTER_MORPH = 0.5;
const DOT_FADE = 0.25;

// A flicked globe spins on and slows down like a real one (see glide()).
// Speeds are in degrees a second.  Turning round the poles runs on for a few
// seconds; tipping north or south stops much sooner, like a globe on a stand.
// `tau` is how quickly it slows down (seconds), `friction` (degrees a second,
// every second) makes it stop rather than creep on forever.
const SPIN_LNG = { tau: 0.8, friction: 24, max: 360 };
const SPIN_LAT = { tau: 0.3, friction: 60, max: 120 };
// The last part of a drag that sets the speed, and how long the player may
// hold the globe still before letting go and still set it spinning (ms).
const FLICK_TIME = 80;
const FLICK_HOLD = 100;
// The globe spins instead of MapLibre's own slide after a drag (which the flat map keeps).
const NO_SLIDE = { maxSpeed: 0 };

// The night shadow: one see-through map tile of the whole world, drawn from
// where the sun is.  MapLibre asks for it with a made-up URL, so nothing is
// downloaded.  The shadow moves 1° every 4 minutes; it is redrawn every 2.
const NIGHT_SCHEME = 'cq-night';
const NIGHT_SIZE = 512;
const NIGHT_EVERY = 2 * 60 * 1000;
const NIGHT_RGB = [8, 14, 52];
const NIGHT_ALPHA = 0.55; // how dark the middle of the night is
const nightUrl = time => `${NIGHT_SCHEME}://${time}`;

maplibregl.addProtocol(NIGHT_SCHEME, async ({ url }) => {
  const time = Number(url.slice(NIGHT_SCHEME.length + 3));
  const canvas = nightCanvas(new Date(Number.isFinite(time) ? time : Date.now()));
  return { data: await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' }) };
});

// Camera boxes [west, south, east, north] for each region's home view.
const REGION_BOUNDS = {
  Africa: [-19, -36, 53, 38],
  Asia: [26, -11, 146, 55],
  Europe: [-25, 35, 42, 71],
  'North America': [-168, 7, -52, 72],
  'South America': [-82, -56, -34, 13],
  Oceania: [112, -48, 188, 8],
  'us-states': [-125, 24.5, -66.9, 49.4], // the 48 joined-up states
  // A country's provinces fit all of them in view (see provinceBox()), but
  // Canada's far north would push its southern provinces off the screen.
  CAN: [-141, 41.7, -52.6, 72],
};

// Names are drawn by MapLibre itself in the page's own font (no glyph server):
// "SemiBold" sets the weight, the second name is the real family.
const LABEL_FONT = ['Fredoka SemiBold', 'Fredoka'];
const COUNTRY_LABEL_LAYERS = ['country-labels', 'dot-labels'];
const LABEL_LAYERS = ['ocean-labels', 'sea-labels', ...COUNTRY_LABEL_LAYERS];
// The US states, or another country's provinces, are drawn over their country
// only when they are what is played or explored (see setStates()).
const STATE_LAYERS = ['state-land', 'state-result', 'state-borders', 'state-highlight',
  'state-target-outline', 'state-selected-outline', 'state-dots'];
const STATE_LABEL_LAYERS = ['state-labels', 'state-dot-labels'];
// Each state layer's own filter, if it has one; setStates() adds "in the
// chosen country" (the `s` of every state feature is its country's code).
const STATE_FILTERS = {
  'state-land': null,
  'state-result': null,
  'state-borders': ['!=', ['get', 'b'], 0],
  'state-highlight': null,
  'state-dots': null,
  'state-labels': ['!=', ['get', 'dot'], true],
  'state-dot-labels': ['==', ['get', 'dot'], true],
};
// With a country's provinces drawn, the other countries and the sea are
// muted, so the country being played stands out: half as colourful, at 30% of
// their brightness (see setStates()).
const MUTED_SATURATION = 0.5;
const MUTED_BRIGHTNESS = 0.3;

/**
 * A colour (#RRGGBB) made less colourful and less bright, the way CSS's
 * saturate() and brightness() filters do it.
 */
function muted(hex, saturation = MUTED_SATURATION, brightness = MUTED_BRIGHTNESS) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const s = saturation;
  const rows = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
  const out = rows.map(([kr, kg, kb]) => Math.round(Math.min(255, Math.max(0, (kr * r + kg * g + kb * b) * brightness))));
  return `rgb(${out.join(', ')})`;
}
const MUTED_PALETTE = PALETTE.map(color => muted(color));
function stateFilter(layer, country) {
  const own = ['==', ['get', 's'], country ?? ''];
  return STATE_FILTERS[layer] ? ['all', STATE_FILTERS[layer], own] : own;
}

// Oceans and big seas, named in Explore mode.  [name, longitude, latitude]
const OCEANS = [
  ['Pacific Ocean', -145, 5], ['Pacific Ocean', 165, 25], ['Atlantic Ocean', -40, 28],
  ['Atlantic Ocean', -18, -20], ['Indian Ocean', 78, -18], ['Arctic Ocean', 0, 83], ['Southern Ocean', 90, -60],
];
const SEAS = [
  ['Mediterranean Sea', 18, 34.5], ['Caribbean Sea', -76, 15], ['Gulf of Mexico', -90, 25.5],
  ['Arabian Sea', 64, 15], ['Bay of Bengal', 88, 15], ['South China Sea', 114, 13], ['Red Sea', 38.3, 20.5],
  ['Black Sea', 34, 43.3], ['Caspian Sea', 50.5, 41.8], ['North Sea', 3.5, 56], ['Baltic Sea', 19.8, 56.3],
  ['Coral Sea', 155, -16], ['Tasman Sea', 162, -38], ['Sea of Japan', 135, 40.5], ['Bering Sea', -178, 58],
  ['Hudson Bay', -85.5, 60], ['Gulf of Guinea', 3, 1.5],
];

const NONE = ['==', ['get', 'a'], -1];
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

export function webglSupported() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function paletteMatch(prop, palette = PALETTE) {
  const m = ['match', ['get', prop]];
  palette.forEach((color, i) => m.push(i, color));
  m.push('#D9D9D9');
  return m;
}

/** The countries' colours: the palette, and ice for Antarctica. */
const landColor = (palette, ice) => ['case', ['==', ['get', 'k'], 2], ice, paletteMatch('c', palette)];

function resultMatch(fallback) {
  return ['match', ['to-string', ['feature-state', 'result']],
    'target', RESULT_COLORS.target, 'exact', RESULT_COLORS.target,
    'neighbor', RESULT_COLORS.neighbor, 'continent', RESULT_COLORS.continent,
    'miss', RESULT_COLORS.miss, fallback];
}

const hasResult = ['!=', ['to-string', ['feature-state', 'result']], ''];
const isOn = name => ['boolean', ['feature-state', name], false];

function graticule() {
  const lines = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const line = [];
    for (let lat = -80; lat <= 80; lat += 2) line.push([lon, lat]);
    lines.push(line);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 2) line.push([lon, lat]);
    lines.push(line);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

const points = (list, props) => ({
  type: 'FeatureCollection',
  features: list.map(item => {
    const { id, coordinates, ...properties } = props(item);
    return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates } };
  }),
});

/** Name labels: bigger places get bigger text and are placed first. */
function labelData(countries, states) {
  return {
    states: points(states, c => ({
      id: c.id,
      coordinates: c.label,
      name: c.name,
      rank: c.area >= 3e5 ? 2 : c.area >= 1e5 ? 3 : 4,
      sort: -Math.log10(c.area + 1),
      country: true,
      dot: c.dot !== undefined,
      s: c.country,
    })),
    countries: points(countries, c => ({
      id: c.id,
      coordinates: c.label,
      name: c.name,
      rank: c.kind === 'antarctica' || c.area >= 2e6 ? 1 : c.area >= 3e5 ? 2 : c.area >= 4e4 ? 3 : 4,
      sort: -Math.log10(c.area + 1),
      country: c.kind === 'country',
      dot: c.dot !== undefined,
    })),
    oceans: points(OCEANS, ([name, lon, lat]) => ({ coordinates: [lon, lat], name })),
    seas: points(SEAS, ([name, lon, lat]) => ({ coordinates: [lon, lat], name })),
  };
}

function buildStyle(geo, stateGeo, view) {
  const lineSource = data => ({ type: 'geojson', data, maxzoom: 8, tolerance: 0.3 });
  // The US states and the provinces of other countries: these layers are
  // hidden until one of those is chosen (see setStates()).
  const states = (...layers) => layers.map(l => (l.id in STATE_FILTERS ? { ...l, filter: stateFilter(l.id, null) } : l));
  const hidden = { visibility: 'none' };
  return {
    version: 8,
    projection: view.projection,
    sky: view.sky,
    sources: {
      states: lineSource(stateGeo.countries),
      'state-lines': lineSource(stateGeo.lines),
      'state-dots': { type: 'geojson', data: stateGeo.dots, maxzoom: 8 },
      'state-names': { type: 'geojson', data: view.labels.states, maxzoom: 8 },
      countries: lineSource(geo.countries),
      lines: lineSource(geo.lines),
      dots: { type: 'geojson', data: geo.dots, maxzoom: 8 },
      graticule: { type: 'geojson', data: graticule(), maxzoom: 4 },
      'country-names': { type: 'geojson', data: view.labels.countries, maxzoom: 8 },
      'ocean-names': { type: 'geojson', data: view.labels.oceans, maxzoom: 8 },
      'sea-names': { type: 'geojson', data: view.labels.seas, maxzoom: 8 },
      night: { type: 'raster', tiles: [nightUrl(view.nightTime)], tileSize: NIGHT_SIZE, maxzoom: 0 },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
      {
        id: 'graticule', type: 'line', source: 'graticule',
        paint: { 'line-color': '#FFFFFF', 'line-opacity': 0.18, 'line-width': 1 }, // see setStates()
      },
      {
        // A soft light halo around every coast, like shallow water.
        id: 'shallows', type: 'line', source: 'lines', filter: ['==', ['get', 'b'], 0],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': SHALLOWS,
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 3, 4, 7, 7, 14],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 5, 7, 9],
        },
      },
      {
        id: 'land', type: 'fill', source: 'countries',
        paint: { 'fill-color': landColor(PALETTE, ICE) }, // see setStates()
      },
      {
        id: 'land-result', type: 'fill', source: 'countries',
        paint: { 'fill-color': resultMatch('#000000'), 'fill-opacity': ['case', hasResult, 0.92, 0] },
      },
      ...states(
        { id: 'state-land', type: 'fill', source: 'states', layout: hidden, paint: { 'fill-color': paletteMatch('c') } },
        {
          id: 'state-result', type: 'fill', source: 'states', layout: hidden,
          paint: { 'fill-color': resultMatch('#000000'), 'fill-opacity': ['case', hasResult, 0.92, 0] },
        },
        {
          // Between states only: the country layers draw coasts and the borders with other countries.
          id: 'state-borders', type: 'line', source: 'state-lines',
          layout: { ...hidden, 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#FFFFFF',
            'line-opacity': 0.95,
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 3, 0.8, 7, 1.8],
          },
        },
      ),
      {
        id: 'borders', type: 'line', source: 'lines', filter: ['!=', ['get', 'b'], 0],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': BORDER,
          'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 3, 1, 7, 2.2],
        },
      },
      {
        id: 'coast', type: 'line', source: 'lines', filter: ['==', ['get', 'b'], 0],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': COAST,
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 3, 0.8, 7, 1.6],
        },
      },
      {
        // Explore mode only: the side of the Earth where it is night.
        id: 'night', type: 'raster', source: 'night', layout: { visibility: 'none' },
        paint: { 'raster-opacity': view.nightOpacity, 'raster-fade-duration': 0 },
      },
      {
        // Above the night shadow, so a tapped country lights up even at night.
        id: 'land-highlight', type: 'fill', source: 'countries',
        paint: {
          'fill-color': '#FFFFFF',
          'fill-opacity': ['case', isOn('selected'), 0.45, isOn('hover'), 0.3, 0],
        },
      },
      ...states({
        id: 'state-highlight', type: 'fill', source: 'states', layout: hidden,
        paint: {
          'fill-color': '#FFFFFF',
          'fill-opacity': ['case', isOn('selected'), 0.45, isOn('hover'), 0.3, 0],
        },
      }),
      {
        id: 'target-outline', type: 'line', source: 'lines', filter: NONE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 3, 7, 4.5],
        },
      },
      {
        id: 'selected-outline', type: 'line', source: 'lines', filter: NONE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#26215C',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 3, 7, 4],
        },
      },
      ...states(
        {
          id: 'state-target-outline', type: 'line', source: 'state-lines', filter: NONE,
          layout: { ...hidden, 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#FFFFFF',
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 3, 7, 4.5],
          },
        },
        {
          id: 'state-selected-outline', type: 'line', source: 'state-lines', filter: NONE,
          layout: { ...hidden, 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#26215C',
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 3, 7, 4],
          },
        },
      ),
      // Tiny countries (and states) get a dot so they can be seen and tapped,
      // but only once the map is zoomed in (see dotFade).
      dotLayer('dots', 'dots', view.dotsFrom),
      ...states({ ...dotLayer('state-dots', 'state-dots', view.dotsFrom), layout: hidden }),
      {
        id: 'ocean-labels', type: 'symbol', source: 'ocean-names',
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 0, 11, 3, 15, 6, 20],
          'text-letter-spacing': 0.2,
          'text-max-width': 6,
        },
        paint: { 'text-color': '#EAF7FF', 'text-halo-color': 'rgba(22, 92, 150, 0.55)', 'text-halo-width': 1.2 },
      },
      {
        id: 'sea-labels', type: 'symbol', source: 'sea-names', minzoom: view.seaMinZoom,
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 4, 13, 7, 17],
          'text-letter-spacing': 0.12,
          'text-max-width': 6,
        },
        paint: { 'text-color': '#EAF7FF', 'text-halo-color': 'rgba(22, 92, 150, 0.55)', 'text-halo-width': 1.2 },
      },
      // Names of tiny places come below the others, so bigger places win
      // when names would overlap (MapLibre places the top layer first), and
      // state names come above country names.
      nameLayer('dot-labels', 'country-names', true, view.dotsFrom - DOT_FADE),
      nameLayer('country-labels', 'country-names', false),
      ...states(
        nameLayer('state-dot-labels', 'state-names', true, view.dotsFrom - DOT_FADE),
        nameLayer('state-labels', 'state-names', false),
      ),
    ],
  };
}

function dotLayer(id, source, dotsFrom) {
  return {
    id, type: 'circle', source,
    paint: {
      'circle-color': ['case', hasResult, resultMatch('#000000'), paletteMatch('c')],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 4, 6, 7, 8],
      'circle-stroke-color': ['case', isOn('selected'), '#26215C', '#FFFFFF'],
      'circle-stroke-width': ['case', isOn('selected'), 3, isOn('hover'), 2.5, 1.5],
      'circle-opacity': dotFade(dotsFrom),
      'circle-stroke-opacity': dotFade(dotsFrom),
    },
  };
}

/** Names of countries or states: bigger ones get bigger text and are placed first. */
function nameLayer(id, source, dot, minzoom = 0) {
  return {
    id, type: 'symbol', source, filter: [dot ? '==' : '!=', ['get', 'dot'], true], minzoom,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT,
      'text-size': ['interpolate', ['linear'], ['zoom'],
        0, ['match', ['get', 'rank'], 1, 11, 2, 10, 3, 9, 8.5],
        2, ['match', ['get', 'rank'], 1, 14, 2, 12, 3, 11, 10],
        4, ['match', ['get', 'rank'], 1, 18, 2, 16, 3, 14, 12.5],
        7, ['match', ['get', 'rank'], 1, 24, 2, 21, 3, 18, 16]],
      'text-max-width': 7,
      'text-line-height': 1.1,
      'text-padding': 3,
      'symbol-sort-key': ['get', 'sort'],
      // A tiny country's name sits just below its dot.
      'text-anchor': dot ? 'top' : 'center',
      'text-offset': dot ? [0, 0.75] : [0, 0],
    },
    paint: {
      'text-color': ['case', ['get', 'country'], '#1D2150', '#555B8C'],
      'text-halo-color': 'rgba(255, 255, 255, 0.92)',
      'text-halo-width': 1.6,
      'text-halo-blur': 0.3,
    },
  };
}

// Dots fade in from zoom `from` - DOT_FADE to `from`, and each fades out
// again between `dz` and `dz + 0.5`, once its country is big enough to see.
function dotFade(from) {
  const stops = ['interpolate', ['linear'], ['zoom'], from - DOT_FADE, 0];
  for (let z = from; z <= 10; z += 0.5) stops.push(z, ['case', ['>', ['get', 'dz'], z], 1, 0]);
  return stops;
}

// ---------- Day and night ----------

const wrapLongitude = lng => lng - 360 * Math.round(lng / 360);

/**
 * Where the sun is straight overhead at a moment in time, in degrees.  A short
 * form of the usual astronomy formulas, good to well under a degree.
 */
export function sunPosition(date = new Date()) {
  const days = date.getTime() / 86400000 - 10957.5; // since noon UTC, 1 January 2000
  const anomaly = (357.528 + 0.9856003 * days) * RAD;
  const eclipticLng = (280.46 + 0.9856474 * days + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const tilt = (23.439 - 0.0000004 * days) * RAD;
  const lat = Math.asin(Math.sin(tilt) * Math.sin(eclipticLng)) / RAD;
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(eclipticLng), Math.cos(eclipticLng)) / RAD;
  const lng = rightAscension - (280.46061837 + 360.98564736629 * days); // minus sidereal time
  return { lng: wrapLongitude(lng), lat };
}

/**
 * How dark it is (0 = day, 1 = night) for the sine of the sun's height above
 * the horizon: dusk runs from the sun touching the horizon to 12° below it.
 */
export function darkness(sinSunHeight) {
  const t = Math.min(1, Math.max(0, (0.0175 - sinSunHeight) / (0.0175 + 0.2079)));
  return t * t * (3 - 2 * t);
}

/** The night shadow at a moment in time, as a Web Mercator picture of the world. */
function nightCanvas(date) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = NIGHT_SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(NIGHT_SIZE, NIGHT_SIZE);
  const px = image.data;
  const sun = sunPosition(date);
  const sinSun = Math.sin(sun.lat * RAD);
  const cosSun = Math.cos(sun.lat * RAD);
  const cosHour = new Float64Array(NIGHT_SIZE);
  for (let x = 0; x < NIGHT_SIZE; x++) cosHour[x] = Math.cos((((x + 0.5) / NIGHT_SIZE) * 360 - 180 - sun.lng) * RAD);
  for (let y = 0; y < NIGHT_SIZE; y++) {
    const lat = latFromMercatorY((y + 0.5) / NIGHT_SIZE) * RAD;
    const a = Math.sin(lat) * sinSun;
    const b = Math.cos(lat) * cosSun;
    for (let x = 0, i = y * NIGHT_SIZE * 4; x < NIGHT_SIZE; x++, i += 4) {
      px[i] = NIGHT_RGB[0];
      px[i + 1] = NIGHT_RGB[1];
      px[i + 2] = NIGHT_RGB[2];
      px[i + 3] = Math.round(255 * NIGHT_ALPHA * darkness(a + b * cosHour[x]));
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Where the opening globe looks: at the line between day and night (sunrise
 * or sunset) nearest the player, turned a little towards the player, so the
 * globe shows both day and night, and the player's own part of the world.
 */
function openingLongitude(sun) {
  // Roughly the player's longitude, from their clock: 15° per hour ahead of UTC.
  const home = -new Date().getTimezoneOffset() / 4;
  const offset = line => wrapLongitude(home - line);
  const line = [sun.lng + 90, sun.lng - 90].reduce((a, b) => (Math.abs(offset(a)) <= Math.abs(offset(b)) ? a : b));
  return wrapLongitude(line + Math.max(-25, Math.min(25, offset(line))));
}

export class WorldMap {
  /**
   * @param {HTMLElement} container
   * @param {{countries: object[], byId: Map, geo: object}} data
   * @param {{onTap?: Function, onReady?: Function, onError?: Function, getPadding?: Function}} hooks
   */
  constructor(container, data, hooks = {}) {
    this.data = data;
    this.hooks = hooks;
    this.markers = [];
    this.markerOffsets = new Map();
    this.hoverId = null;
    // The US states and other countries' provinces (more come with addStates()).
    const empty = () => ({ type: 'FeatureCollection', features: [] });
    this.stateGeo = data.stateGeo ?? { countries: empty(), lines: empty(), dots: empty() };
    this.statesOn = null; // the country whose states are drawn, see setStates()
    this.parentId = null; // and its id
    this.labelsOn = false;
    const dots = [...data.geo.dots.features, ...this.stateGeo.dots.features];
    this.dotIds = new Set(dots.map(f => f.id));
    this.nightTime = nightStamp();
    const view = { ...this.globeView(container), labels: labelData(data.countries, data.states), nightTime: this.nightTime };

    this.map = new maplibregl.Map({
      container,
      style: buildStyle(data.geo, this.stateGeo, view),
      center: [openingLongitude(this.sun()), 18],
      zoom: this.zGlobe,
      minZoom: view.minZoom,
      maxZoom: MAX_ZOOM,
      renderWorldCopies: true,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      clickTolerance: 8,
      fadeDuration: 0,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();

    this.map.on('load', () => hooks.onReady?.());
    this.map.on('error', e => hooks.onError?.(e.error || e));
    this.map.on('click', e => {
      const id = this.pick(e.point);
      hooks.onTap?.(id);
    });
    if (canHover()) {
      let frame = 0;
      this.map.on('mousemove', e => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.setHover(this.pick(e.point, 0)));
      });
      this.map.on('mouseout', () => {
        cancelAnimationFrame(frame);
        this.setHover(null);
      });
    }
    let resizeTimer;
    this.map.on('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.updateProjection(), 120);
    });
    // Flick the globe and it spins on (see glide()); touch it and it stops.
    // The speed is timed by when the pointer moved, not by when frames were
    // drawn, which on a slow device can be much later.
    let track = null;
    const input = { pressed: 0, moved: 0, released: 0 };
    const listen = (types, key) => {
      for (const type of types) document.addEventListener(type, e => { input[key] = e.timeStamp; }, { capture: true, passive: true });
    };
    listen(['mousemove', 'touchmove'], 'moved');
    listen(['mouseup', 'touchend'], 'released');
    this.map.on('dragstart', () => {
      this.glide(null);
      track = [];
    });
    this.map.on('move', () => {
      this.retuneMorph();
      this.placeMarkers();
      track?.push({ input: input.moved, center: this.map.getCenter() });
    });
    this.map.on('dragend', () => {
      const globe = this.globeness() > 0;
      this.map.dragPan.enable(globe ? NO_SLIDE : undefined);
      // (Unless the player has touched the map again already: a slow device
      // may only now get round to the end of the drag.)
      if (globe && input.pressed < input.released) this.glide(flickSpeed(track, input.released));
      track = null;
    });
    this.map.getCanvasContainer().addEventListener('pointerdown', e => {
      input.pressed = e.timeStamp;
      this.glide(null);
    }, { passive: true });
    // Keep the night shadow where it really is, also after the page was hidden.
    setInterval(() => this.updateNight(), 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.updateNight();
    });
  }

  /**
   * Sizes that depend on the screen: the starting globe (zGlobe) fills most of
   * the screen's short side, the switch to the flat map waits until the globe
   * covers the whole screen, and tiny countries get their dots half way
   * through that switch.
   */
  globeView(container) {
    const width = Math.max(200, container.clientWidth);
    const height = Math.max(200, container.clientHeight);
    this.zGlobe = Math.log2((Math.min(width, height) * 0.84 * Math.PI) / 512);
    this.morph = this.morphZooms(width, height, NO_PADDING, 0);
    this.dotsFrom = this.morph.start + DOTS_AFTER_MORPH;
    return {
      minZoom: Math.max(-1.5, this.zGlobe - 0.7),
      seaMinZoom: this.zGlobe + 0.6,
      dotsFrom: this.dotsFrom,
      // The night is darkest on the whole globe and lighter up close, where
      // it would only make the countries hard to see.
      nightOpacity: ['interpolate', ['linear'], ['zoom'], this.zGlobe + 0.3, 1, this.morph.end, 0.35],
      projection: morphProjection(this.morph),
      sky: {
        'sky-color': '#0B1640',
        'horizon-color': '#9ED8FF',
        // The glow suits the whole globe; up close its thin sunset-coloured
        // rim looks like a stray line, so fade it as soon as the player zooms in.
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], this.zGlobe, 1, this.zGlobe + 0.1, 0],
      },
    };
  }

  /** Zooms where the globe starts and finishes unrolling, for one camera. */
  morphZooms(width, height, padding, lat) {
    const fov = this.map?.getVerticalFieldOfView?.();
    const held = Math.max(-MORPH_MAX_LAT, Math.min(MORPH_MAX_LAT, lat));
    const start = Math.round((fillZoom(width, height, { padding, lat: held, fov }) + MORPH_MARGIN) * 100) / 100;
    return { start, end: start + MORPH_ZOOMS };
  }

  updateProjection() {
    if (!this.map.style) return;
    const dotsFrom = this.dotsFrom;
    const view = this.globeView(this.map.getContainer());
    this.map.setMinZoom(view.minZoom);
    this.map.setLayerZoomRange('sea-labels', view.seaMinZoom, 24);
    this.map.setSky(view.sky);
    this.map.setPaintProperty('night', 'raster-opacity', view.nightOpacity);
    if (view.dotsFrom !== dotsFrom) {
      for (const [dots, labels] of [['dots', 'dot-labels'], ['state-dots', 'state-dot-labels']]) {
        this.map.setPaintProperty(dots, 'circle-opacity', dotFade(view.dotsFrom));
        this.map.setPaintProperty(dots, 'circle-stroke-opacity', dotFade(view.dotsFrom));
        this.map.setLayerZoomRange(labels, view.dotsFrom - DOT_FADE, 24);
      }
    }
    if (!this.retuneMorph(true)) this.map.setProjection(view.projection);
    this.placeMarkers();
  }

  /**
   * Where the globe fills the screen depends on the camera: its padding moves
   * the globe off centre, and MapLibre draws the globe bigger at high
   * latitudes.  So the switch zooms are re-aimed as the camera moves.  This
   * edits MapLibre's projection in place (setProjection would reload every
   * tile); with a MapLibre that cannot, the switch stays where it was set.
   */
  retuneMorph(force = false) {
    const projection = this.map.style?.projection;
    if (!projection?.setProjection || !projection.updateTransitions) return false;
    const el = this.map.getContainer();
    const next = this.morphZooms(el.clientWidth, el.clientHeight, this.map.getPadding(), this.map.getCenter().lat);
    if (!force && next.start === this.morph.start) return true;
    this.morph = next;
    const spec = morphProjection(next);
    projection.setProjection(spec);
    projection.updateTransitions({ now: performance.now(), transition: { duration: 0, delay: 0 } });
    this.map.style.stylesheet.projection = spec;
    // Re-evaluate the style on the next frame, even if the zoom did not change.
    if (typeof this.map._update === 'function') this.map._update(true);
    else this.map.triggerRepaint();
    return true;
  }

  /** How round the map is drawn right now: 1 = globe, 0 = flat, between while unrolling. */
  globeness(zoom = this.map.getZoom()) {
    const { start, end } = this.morph;
    return Math.max(0, Math.min(1, (end - zoom) / (end - start)));
  }

  /**
   * While the globe unrolls, MapLibre draws every place part way between where
   * the globe and the flat map would put it, but still measures taps and
   * places markers on the globe.  This works out where a place is really drawn.
   * Returns null when the map is fully round or fully flat.
   */
  morphFrame() {
    const t = this.globeness();
    if (t <= 0 || t >= 1) return null;
    return { t, ...this.camera() };
  }

  /**
   * The camera in screen pixels: where the map centre is on screen, how far
   * the camera is from it, and the globe's radius.
   */
  camera() {
    const el = this.map.getContainer();
    const pad = this.map.getPadding();
    const center = this.map.getCenter();
    const worldSize = 512 * 2 ** this.map.getZoom();
    const fov = (this.map.getVerticalFieldOfView?.() ?? 36.87) * RAD;
    return {
      center,
      x: (el.clientWidth + pad.left - pad.right) / 2,
      y: (el.clientHeight + pad.top - pad.bottom) / 2,
      worldSize,
      distance: el.clientHeight / 2 / Math.tan(fov / 2),
      radius: worldSize / (2 * Math.PI * Math.cos(Math.min(Math.abs(center.lat), MAX_LAT) * RAD)),
    };
  }

  /**
   * Is a screen point on the map, rather than in the sky around the globe?
   * (MapLibre answers questions about the sky with the globe's edge.)
   */
  onMap({ x, y }) {
    if (this.globeness() < 1) return true; // it only unrolls once it covers the screen
    const cam = this.camera();
    // From the camera, the globe looks like a disc around the map centre.
    const disc = cam.radius / Math.sqrt(1 + (2 * cam.radius) / cam.distance);
    return Math.hypot(x - cam.x, y - cam.y) <= disc + 1;
  }

  /** The screen point where a [lng, lat] place is drawn. */
  drawnPoint(lngLat, frame = this.morphFrame()) {
    const globe = this.map.project(lngLat);
    if (!frame) return { x: globe.x, y: globe.y };
    const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
    const { t, center, worldSize, distance, radius } = frame;
    let dLng = lng - center.lng;
    dLng -= 360 * Math.round(dLng / 360);
    const cosArc = Math.sin(lat * RAD) * Math.sin(center.lat * RAD)
      + Math.cos(lat * RAD) * Math.cos(center.lat * RAD) * Math.cos(dLng * RAD);
    // The far side of the globe is not drawn at all (and is off screen by now).
    if (cosArc <= 0) return { x: globe.x, y: globe.y };
    // On the flat map...
    const flatX = frame.x + (dLng / 360) * worldSize;
    const flatY = frame.y + (mercatorY(lat) - mercatorY(center.lat)) * worldSize;
    // ...and blended with the globe the way MapLibre's shaders do it: by
    // position times depth, so points far round the globe lean globe-wards.
    const a = t * (distance + radius * (1 - cosArc));
    const b = (1 - t) * distance;
    return { x: (a * globe.x + b * flatX) / (a + b), y: (a * globe.y + b * flatY) / (a + b) };
  }

  /** The point to ask MapLibre about, for what is drawn at a screen point. */
  queryPoint(point) {
    const frame = this.morphFrame();
    if (!frame) return point;
    // Find the place drawn at `point` (Newton's method), then where MapLibre
    // thinks that place is.
    const { center, worldSize } = frame;
    let lng = center.lng + ((point.x - frame.x) / worldSize) * 360;
    let lat = latFromMercatorY(mercatorY(center.lat) + (point.y - frame.y) / worldSize);
    const h = 1e-4;
    for (let i = 0; i < 8; i++) {
      const p = this.drawnPoint([lng, lat], frame);
      const ex = point.x - p.x;
      const ey = point.y - p.y;
      if (ex * ex + ey * ey < 0.01) break;
      const pl = this.drawnPoint([lng + h, lat], frame);
      const pt = this.drawnPoint([lng, lat + h], frame);
      const a = (pl.x - p.x) / h, b = (pt.x - p.x) / h, c = (pl.y - p.y) / h, d = (pt.y - p.y) / h;
      const det = a * d - b * c;
      if (!det) break;
      lng += (d * ex - b * ey) / det;
      lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + (a * ey - c * ex) / det));
    }
    const q = this.map.project([lng, lat]);
    return { x: q.x, y: q.y };
  }

  /** Show or hide the names of countries, oceans and seas. */
  setLabels(on) {
    this.labelsOn = on;
    for (const id of LABEL_LAYERS) this.show(id, on);
    for (const id of STATE_LABEL_LAYERS) this.show(id, on && !!this.statesOn);
  }

  /**
   * Draw a country's states or provinces over it: `country` is its code
   * ('USA' for the US states, 'CHN' for China's provinces …), or null for none.
   */
  setStates(country) {
    country = country || null;
    if (country === this.statesOn) return;
    this.statesOn = country;
    this.parentId = country && (this.data.countries.find(c => c.code === country)?.id ?? null);
    for (const id of Object.keys(STATE_FILTERS)) this.map.setFilter(id, stateFilter(id, country));
    for (const id of STATE_LAYERS) this.show(id, !!country);
    for (const id of STATE_LABEL_LAYERS) this.show(id, !!country && this.labelsOn);
    // Their names replace the country's (see nameLayer for the filter).
    const notTiny = ['!=', ['get', 'dot'], true];
    this.map.setFilter('country-labels', country ? ['all', notTiny, ['!=', ['id'], this.parentId]] : notTiny);
    // The other countries and the sea are muted (less colourful, a little
    // darker), so this one stands out; so are their borders and coasts, and
    // their tiny countries lose their dots.  An answer shown on one of them
    // keeps its bright colour (the answer layers are on top).
    const own = ['==', ['id'], this.parentId ?? -1];
    const ownLine = ['any', ['==', ['get', 'a'], this.parentId ?? -1], ['==', ['get', 'b'], this.parentId ?? -1]];
    const ownOr = (mine, others) => (country ? ['case', own, mine, others] : mine);
    const ownLineOr = (mine, others) => (country ? ['case', ownLine, mine, others] : mine);
    this.map.setPaintProperty('land', 'fill-color', ownOr(landColor(PALETTE, ICE), landColor(MUTED_PALETTE, muted(ICE))));
    this.map.setPaintProperty('borders', 'line-color', ownLineOr(BORDER, muted(BORDER)));
    this.map.setPaintProperty('coast', 'line-color', ownLineOr(COAST, muted(COAST)));
    this.map.setPaintProperty('ocean', 'background-color', country ? muted(OCEAN) : OCEAN);
    this.map.setPaintProperty('shallows', 'line-color', country ? muted(SHALLOWS) : SHALLOWS);
    this.map.setPaintProperty('graticule', 'line-color', country ? muted('#FFFFFF') : '#FFFFFF');
    this.map.setFilter('dots', country ? NONE : null);
  }

  /** Add more states or provinces (from loadProvinces(), which comes after the map). */
  addStates(geo) {
    for (const key of ['countries', 'lines', 'dots']) this.stateGeo[key].features.push(...geo[key].features);
    this.map.getSource('states').setData(this.stateGeo.countries);
    this.map.getSource('state-lines').setData(this.stateGeo.lines);
    this.map.getSource('state-dots').setData(this.stateGeo.dots);
    this.map.getSource('state-names').setData(labelData([], this.data.states).states);
    for (const f of geo.dots.features) this.dotIds.add(f.id);
  }

  show(layer, on) {
    this.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  }

  /** Is this id a state or province (a US state, D.C., or another country's province) rather than a country? */
  isState(id) {
    const kind = this.data.byId.get(id)?.kind;
    return kind === 'state' || kind === 'district' || kind === 'province';
  }

  /** Shade the side of the Earth where it is night right now (Explore mode), or not. */
  setNight(on) {
    this.map.setLayoutProperty('night', 'visibility', on ? 'visible' : 'none');
    if (on) this.updateNight();
  }

  /** Move the night shadow to where it is now. */
  updateNight(time = nightStamp()) {
    const source = this.map.getSource('night');
    if (!source || time === this.nightTime) return;
    this.nightTime = time;
    source.setTiles([nightUrl(time)]);
  }

  /** Where the sun is overhead, as the night shadow on the map shows it. */
  sun() {
    return sunPosition(new Date(this.nightTime));
  }

  /** The country at a screen point, with a little slack for small fingers. */
  pick(drawn, slack = 14) {
    if (!this.onMap(drawn)) return null;
    const { x, y } = this.queryPoint(drawn);
    const point = [x, y];
    const zoom = this.map.getZoom();
    const states = this.statesOn;
    // With a country's states drawn, they are what is tapped inside it.
    const notParent = f => !(states && f.id === this.parentId);
    // Hidden name labels are never hit, so this only matters in Explore mode.
    const labels = states ? [...STATE_LABEL_LAYERS, ...COUNTRY_LABEL_LAYERS] : COUNTRY_LABEL_LAYERS;
    const named = this.map.queryRenderedFeatures(point, { layers: labels }).filter(notParent);
    if (named.length) return named[0].id;
    const layers = states ? ['state-dots', 'state-land', 'dots', 'land'] : ['dots', 'land'];
    const isDot = f => f.layer.id === 'dots' || f.layer.id === 'state-dots';
    // A tiny place can only be tapped where it can be seen: once its dot
    // shows, or once it is big enough itself.
    const dotsShown = zoom >= this.dotsFrom - DOT_FADE / 2;
    const usable = f => {
      const dz = this.data.byId.get(f.id).dot;
      if (isDot(f)) return dotsShown && zoom <= dz + 0.3;
      return notParent(f) && (dz === undefined || dotsShown || zoom >= dz);
    };
    let hits = this.map.queryRenderedFeatures(point, { layers }).filter(usable);
    if (!hits.length && slack > 0) {
      const box = [[x - slack, y - slack], [x + slack, y + slack]];
      hits = this.map.queryRenderedFeatures(box, { layers }).filter(usable);
      // Near several places: prefer a dot, then the smallest place.
      hits.sort((a, b) => (isDot(a) ? 0 : 1) - (isDot(b) ? 0 : 1)
        || this.data.byId.get(a.id).area - this.data.byId.get(b.id).area);
    }
    const hit = hits.find(isDot) || hits[0];
    return hit ? hit.id : null;
  }

  setHover(id) {
    if (id === this.hoverId) return;
    if (this.hoverId !== null) this.setState(this.hoverId, { hover: false });
    this.hoverId = id;
    if (id !== null) this.setState(id, { hover: true });
    this.map.getCanvas().style.cursor = id !== null ? 'pointer' : '';
  }

  setState(id, state) {
    const us = this.isState(id);
    this.map.setFeatureState({ source: us ? 'states' : 'countries', id }, state);
    if (this.dotIds.has(id)) this.map.setFeatureState({ source: us ? 'state-dots' : 'dots', id }, state);
  }

  outline(layer, id) {
    this.map.setFilter(layer, id == null ? NONE : ['any', ['==', ['get', 'a'], id], ['==', ['get', 'b'], id]]);
  }

  /** Outline a country or a state (`layer` names the country layer). */
  outlinePlace(layer, id) {
    const us = id != null && this.isState(id);
    this.outline(layer, us ? null : id);
    this.outline(`state-${layer}`, us ? id : null);
  }

  select(id) {
    if (this.selectedId != null) this.setState(this.selectedId, { selected: false });
    this.selectedId = id;
    if (id != null) this.setState(id, { selected: true });
    this.outlinePlace('selected-outline', id);
  }

  /** Colour the answer green and the player's pick by how close it was. */
  showResult(targetId, pickedId, outcome) {
    this.select(null);
    if (pickedId != null && pickedId !== targetId) this.setState(pickedId, { result: outcome });
    this.setState(targetId, { result: 'target' });
    this.outlinePlace('target-outline', targetId);
  }

  clearResult() {
    for (const source of ['countries', 'dots', 'states', 'state-dots']) {
      this.map.removeFeatureState({ source });
    }
    this.hoverId = null;
    this.selectedId = null;
    this.outlinePlace('target-outline', null);
    this.outlinePlace('selected-outline', null);
    this.clearMarkers();
  }

  /** A name tag above a country.  `kind` picks the colour (see CSS). */
  addTag(id, html, kind, { pulse = false } = {}) {
    // MapLibre positions markers with `transform`, so the animated parts are
    // children of the marker element, never the element itself.
    const country = this.data.byId.get(id);
    if (pulse) {
      const ring = document.createElement('div');
      ring.className = 'pulse';
      ring.innerHTML = '<span></span><span></span>';
      this.addMarker(new maplibregl.Marker({ element: ring, anchor: 'center' }), country.label, [0, 0]);
    }
    const el = document.createElement('div');
    el.className = 'tag-marker';
    el.innerHTML = `<div class="tag tag--${kind}">${html}</div>`;
    return this.addMarker(new maplibregl.Marker({ element: el, anchor: 'bottom' }), country.label, [0, -14]);
  }

  addMarker(marker, lngLat, offset) {
    this.markers.push(marker);
    this.markerOffsets.set(marker, offset);
    marker.setLngLat(lngLat).setOffset(this.markerShift(lngLat, offset)).addTo(this.map);
    return marker;
  }

  /** A marker's offset, plus the gap between where MapLibre and the unrolling globe put it. */
  markerShift(lngLat, [dx, dy], frame = this.morphFrame()) {
    if (!frame) return [dx, dy];
    const drawn = this.drawnPoint(lngLat, frame);
    const globe = this.map.project(lngLat);
    return [dx + drawn.x - globe.x, dy + drawn.y - globe.y];
  }

  /** Keep markers on their countries while the globe unrolls. */
  placeMarkers() {
    if (!this.markers.length) return;
    const frame = this.morphFrame();
    if (!frame && !this.markersShifted) return;
    for (const marker of this.markers) {
      marker.setOffset(this.markerShift(marker.getLngLat(), this.markerOffsets.get(marker), frame));
    }
    this.markersShifted = !!frame;
  }

  removeMarker(marker) {
    marker.remove();
    this.markers = this.markers.filter(m => m !== marker);
    this.markerOffsets.delete(marker);
  }

  clearMarkers() {
    this.markers.forEach(m => m.remove());
    this.markers = [];
    this.markerOffsets.clear();
  }

  padding() {
    return this.hooks.getPadding?.() || { top: 20, bottom: 20, left: 20, right: 20 };
  }

  /** Centre and zoom that fit a [west, south, east, north] box on screen. */
  cameraFor([w, s, e, n], pad = this.padding()) {
    const el = this.map.getContainer();
    const width = Math.max(80, el.clientWidth - pad.left - pad.right);
    const height = Math.max(80, el.clientHeight - pad.top - pad.bottom);
    const y = lat => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
    const zx = Math.log2(((width / 512) * 360) / Math.max(e - w, 0.3));
    const zy = Math.log2(((height / 512) * 2 * Math.PI) / Math.max(y(n) - y(s), 0.005));
    const midY = (y(n) + y(s)) / 2;
    const lat = ((2 * Math.atan(Math.exp(midY)) - Math.PI / 2) * 180) / Math.PI;
    let lng = (w + e) / 2;
    if (lng > 180) lng -= 360;
    return { center: [lng, lat], zoom: Math.min(zx, zy) - 0.1 };
  }

  /**
   * Fly to a centre and zoom.  Only home() moves the point the camera centres
   * on (its padding); other moves put their centre in the middle of the free
   * part of the screen with an offset, so showing a country turns the globe
   * in place instead of sliding the whole globe sideways.
   */
  move(camera, duration = 1400, padding = null) {
    this.glide(null);
    const options = { ...camera, bearing: 0, pitch: 0 };
    options.zoom = Math.max(this.map.getMinZoom(), Math.min(options.zoom, MAX_ZOOM));
    if (padding) options.padding = padding;
    else options.offset = this.freeOffset();
    if (prefersReducedMotion() || duration === 0) this.map.easeTo({ ...options, duration: 0 });
    else this.map.flyTo({ ...options, duration, essential: false });
  }

  /** From the point the camera centres on to the middle of the free part of the screen. */
  freeOffset(free = this.padding()) {
    const pad = this.map.getPadding();
    return [(free.left - free.right - pad.left + pad.right) / 2, (free.top - free.bottom - pad.top + pad.bottom) / 2];
  }

  /**
   * The starting view: the whole globe, or the chosen continent or country.
   * With `opening`, the globe also turns back to face the way it did when the
   * game opened (the line between day and night nearest the player).
   */
  home(region, duration = 1200, { opening = false } = {}) {
    // Same margin left and right, so the globe sits in the middle of the
    // screen; but when a panel at the side covers much of it (phones held
    // sideways), in the middle of the rest.
    const pad = this.padding();
    if (Math.abs(pad.left - pad.right) < 120) pad.left = pad.right = Math.max(pad.left, pad.right);
    const box = region && (REGION_BOUNDS[region] ?? this.provinceBox(region));
    if (box) {
      const camera = this.cameraFor(box, pad);
      // Showing an answer never zooms out further than this view.
      this.revealZoom = Math.max(REVEAL_MAX_ZOOM, Math.min(camera.zoom, MAX_ZOOM));
      this.move(camera, duration, pad);
    } else {
      this.revealZoom = REVEAL_MAX_ZOOM;
      const lng = opening ? openingLongitude(this.sun()) : this.map.getCenter().lng;
      this.move({ center: [lng, 18], zoom: this.zGlobe }, duration, pad);
    }
  }

  /** The box around a country's states or provinces (its code, like 'CHN'), or null. */
  provinceBox(country) {
    const boxes = this.data.states.filter(p => p.country === country).map(p => p.bbox);
    return boxes.length ? unionBoxes(boxes) : null;
  }

  /** Fly so that all the given countries are in view. */
  showCountries(ids, duration = 1500) {
    const boxes = ids.map(id => this.data.byId.get(id).bbox);
    const box = unionBoxes(boxes);
    const camera = this.cameraFor(box);
    // Zoom out a little from a tight fit, so the neighbours show too.
    camera.zoom = Math.min(camera.zoom - 0.6, this.revealZoom ?? REVEAL_MAX_ZOOM);
    this.move(camera, duration);
  }

  /** The camera as it is now, with the screen size, to come back to with restoreView(). */
  view() {
    const c = this.map.getCenter();
    const el = this.map.getContainer();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom(), padding: this.map.getPadding(), size: [el.clientWidth, el.clientHeight] };
  }

  /**
   * Fly back to a view saved with view().  Returns false, and stays put, when
   * the screen has changed size since (a phone turned round): the old view
   * would no longer fit.
   */
  restoreView({ center, zoom, padding, size }, duration = 1200) {
    const el = this.map.getContainer();
    if (size[0] !== el.clientWidth || size[1] !== el.clientHeight) return false;
    this.glide(null);
    const options = { center, zoom, padding, bearing: 0, pitch: 0 };
    if (prefersReducedMotion() || duration === 0) {
      this.map.jumpTo(options);
      return true;
    }
    this.map.flyTo({ ...options, duration, essential: false });
    // Over the globe MapLibre lands a little off the zoom it was given (it
    // corrects the zoom for latitude as it flies), so finish with a tiny jump;
    // but not when the player took over on the way.
    this.map.once('moveend', () => {
      const c = this.map.getCenter();
      if (Math.abs(wrapLongitude(c.lng - center[0])) < 1e-4 && Math.abs(c.lat - center[1]) < 1e-4) this.map.jumpTo(options);
    });
    return true;
  }

  zoomBy(delta) {
    this.glide(null);
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: prefersReducedMotion() ? 0 : 300 });
  }

  /** Slowly turn the globe, as on the opening page. */
  spin(on) {
    cancelAnimationFrame(this.spinFrame);
    if (on) this.glide(null);
    if (!on || prefersReducedMotion()) return;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!this.map.isMoving()) {
        const c = this.map.getCenter();
        this.map.jumpTo({ center: [c.lng + dt * 0.004, c.lat] });
      }
      this.spinFrame = requestAnimationFrame(step);
    };
    this.spinFrame = requestAnimationFrame(step);
  }

  /**
   * Spin the globe on after a flick, from `speed` ([longitude, latitude],
   * degrees a second), slowing down until it stops.  Touching the map or any
   * other camera move stops it, and so does glide(null).
   */
  glide(speed) {
    cancelAnimationFrame(this.glideFrame);
    if (!speed || prefersReducedMotion()) return;
    const limit = (v, { max }) => Math.max(-max, Math.min(max, v));
    let lng = limit(speed[0], SPIN_LNG);
    let lat = limit(speed[1], SPIN_LAT);
    // On the clock of the frames drawn (the drag ended in the one drawn last).
    let last = document.timeline?.currentTime ?? performance.now();
    const step = now => {
      // Someone else moves the camera now: the player, a zoom or a flight.
      if (this.map.isMoving()) return;
      const dt = Math.max(0, now - last) / 1000;
      last = now;
      const [dLng, lngAfter] = slowDown(lng, dt, SPIN_LNG);
      const [dLat, latAfter] = slowDown(lat, dt, SPIN_LAT);
      [lng, lat] = [lngAfter, latAfter];
      const c = this.map.getCenter();
      let toLat = c.lat + dLat;
      if (Math.abs(toLat) > MAX_LAT) {
        // Tipped as far as it goes: it stops tipping, and keeps turning.
        toLat = Math.abs(c.lat) > MAX_LAT ? c.lat : Math.sign(toLat) * MAX_LAT;
        lat = 0;
      }
      this.map.jumpTo({ center: [wrapLongitude(c.lng + dLng), toLat] });
      if (lng || lat) this.glideFrame = requestAnimationFrame(step);
    };
    this.glideFrame = requestAnimationFrame(step);
  }

  /** Screen position of a country's label point, as drawn. */
  screenPoint(id) {
    return this.drawnPoint(this.data.byId.get(id).label);
  }
}

/**
 * How fast the globe turned as the player let go of it, in degrees a second
 * ([longitude, latitude]).  `track` has the camera centre each time the drag
 * moved it, with `input`, when the pointer last moved by then; `released` is
 * when the player let go.  Null when they held it still before letting go.
 */
export function flickSpeed(track, released) {
  if (!track || track.length < 2) return null;
  const last = track[track.length - 1];
  if (released - last.input > FLICK_HOLD) return null;
  let i = track.length - 2;
  while (i > 0 && last.input - track[i].input < FLICK_TIME) i--;
  const from = track[i];
  const dt = (last.input - from.input) / 1000;
  if (dt <= 0) return null;
  return [wrapLongitude(last.center.lng - from.center.lng) / dt, (last.center.lat - from.center.lat) / dt];
}

/**
 * A spin slowing down: how far it turns in `dt` seconds from `speed`, and
 * its speed after.  It loses speed in proportion to its speed (`tau`), plus
 * a steady `friction` that brings it to a stop.
 */
export function slowDown(speed, dt, { tau, friction }) {
  const s = Math.abs(speed);
  if (s < 0.01) return [0, 0];
  const k = friction * tau;
  const stopsIn = tau * Math.log(1 + s / k);
  const t = Math.min(dt, stopsIn);
  const decay = Math.exp(-t / tau);
  const turned = tau * (s + k) * (1 - decay) - k * t;
  const after = t < dt ? 0 : Math.max(0, (s + k) * decay - k);
  return [Math.sign(speed) * turned, Math.sign(speed) * after];
}

/**
 * The zoom at which the globe covers a whole width × height map, corners
 * included.  MapLibre centres the globe in the padded area, views it with a
 * perspective camera, and draws it 1 / cos(latitude) bigger towards the poles.
 */
export function fillZoom(width, height, { padding = NO_PADDING, lat = 0, fov = 36.87 } = {}) {
  // The corner farthest from the globe's centre.
  const reach = Math.hypot(width / 2 + Math.abs(padding.left - padding.right) / 2,
    height / 2 + Math.abs(padding.top - padding.bottom) / 2);
  // Camera height above the map, in pixels.  A globe of radius R pixels looks
  // like a disc of radius R / sqrt(1 + 2R / camera) from there; solve for a
  // disc that reaches the corner.
  const camera = height / 2 / Math.tan((fov * RAD) / 2);
  const k = (reach * reach) / camera;
  const radius = k + Math.sqrt(k * k + reach * reach);
  return Math.log2((2 * Math.PI * radius * Math.cos(Math.min(Math.abs(lat), MAX_LAT) * RAD)) / 512);
}

const morphProjection = ({ start, end }) => ({
  type: ['interpolate', ['linear'], ['zoom'], start, 'vertical-perspective', end, 'mercator'],
});

/** The time the night shadow is drawn for: now, in steps of NIGHT_EVERY. */
const nightStamp = (now = Date.now()) => now - (now % NIGHT_EVERY);

/** Web Mercator y from 0 (north edge) to 1 (south edge). */
const mercatorY = lat => {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return (1 - Math.log(Math.tan(Math.PI / 4 + (clamped * RAD) / 2)) / Math.PI) / 2;
};
const latFromMercatorY = y => (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) / RAD;

/** Smallest box containing all boxes, allowing for the 180° meridian. */
export function unionBoxes(boxes) {
  let [w, s, e, n] = boxes[0];
  for (const box of boxes.slice(1)) {
    let [bw, bs, be, bn] = box;
    // Shift the box by ±360° if that keeps the union narrower.
    const options = [0, 360, -360].map(shift => {
      const nw = Math.min(w, bw + shift);
      const ne = Math.max(e, be + shift);
      return { shift, span: ne - nw, nw, ne };
    });
    const best = options.reduce((a, b) => (b.span < a.span ? b : a));
    w = best.nw;
    e = best.ne;
    s = Math.min(s, bs);
    n = Math.max(n, bn);
  }
  if (w < -180) {
    w += 360;
    e += 360;
  }
  return [w, s, e, n];
}
