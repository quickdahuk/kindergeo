#!/usr/bin/env python3
"""Automated checks for Country Quest, in a headless browser.

Runs tests/unit.html, then on a desktop, a phone and a phone held sideways:
checks the opening globe (its buttons, day and night, the Start menu, fact
cards, tiny countries, the globe button), flicks the globe to spin it, plays
games with real taps on the map, tries Explore mode and the US States
category, checks where the globe unrolls into a flat map, and saves
screenshots to test-results/.

Needs Playwright with Chromium, ideally in a virtualenv:

  virtualenv .venv && .venv/bin/pip install playwright
  .venv/bin/python -m playwright install chromium --only-shell
  .venv/bin/python tools/check.py
"""
import functools
import http.server
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test-results')
# Software WebGL, so the checks never touch the GPU.
BROWSER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

IDLE = """() => new Promise(res => { const m = window.countryQuest.world.map;
  const t = setTimeout(res, 10000); m.once('idle', () => { clearTimeout(t); res(); }); m.triggerRepaint(); })"""

# Picks a country (or state, or province) that should give the wanted result for the current question.
PICK = """(kind) => { const { state: s, data: d } = window.countryQuest; const t = s.questions[s.round];
  if (kind === 'exact') return t.id;
  if (kind === 'neighbor') return [...t.land, ...t.sea].find(id => d.byId.get(id).area > 20000) ?? t.land[0] ?? t.sea[0];
  const others = d.places.filter(c => c.kind === t.kind && c.country === t.country && c.id !== t.id && !t.land.includes(c.id)
    && !t.sea.includes(c.id) && c.area > 60000);
  if (kind === 'continent') return others.find(c => c.cont.some(x => t.cont.includes(x)))?.id;
  return others.find(c => !c.cont.some(x => t.cont.includes(x)))?.id; }"""

# Reads canvas pixels (CSS coordinates) straight after MapLibre draws a frame.
READ_PIXELS = """(points) => new Promise(res => { const m = window.countryQuest.world.map;
  m.once('render', () => { const c = m.getCanvas(), gl = c.getContext('webgl2'), scale = c.width / c.clientWidth;
    res(points.map(([x, y]) => { const px = new Uint8Array(4);
      gl.readPixels(Math.round(x * scale), Math.round(gl.drawingBufferHeight - 1 - y * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px]; })); });
  m.triggerRepaint(); })"""

# Puts the camera over central Africa, `dz` zoom levels past the globe-to-flat switch.
NEAR_SWITCH = """(dz) => { const w = window.countryQuest.world;
  w.map.jumpTo({ center: [20, 2] });
  w.map.jumpTo({ zoom: w.morph.start + dz }); }"""
# Central Europe, part way through unrolling: many countries, far from the equator.
UNROLLING_OVER_EUROPE = """() => { const w = window.countryQuest.world;
  w.map.jumpTo({ center: [15, 49] });
  w.map.jumpTo({ zoom: w.morph.start + 0.3 }); }"""

# Where the camera centres (its padding), and whether the answer sits in the
# part of the screen not covered by the top bar, the panel or the map buttons.
REVEAL_VIEW = """() => { const { world: w, state: s } = window.countryQuest, m = w.map, W = innerWidth, H = innerHeight;
  const hud = document.getElementById('hud').getBoundingClientRect(), panel = document.getElementById('panel').getBoundingClientRect();
  const tools = document.getElementById('map-tools').getBoundingClientRect(), side = panel.left > W * 0.3;
  const p = w.drawnPoint(s.questions[s.round].label);
  return { padding: m.getPadding(), x: p.x, y: p.y,
    open: p.x > 0 && p.x < (side ? panel.left : tools.left) && p.y > hud.bottom && p.y < (side ? H : panel.top) }; }"""

# Where the opening globe is: zoom, latitude, and how far (in degrees of
# longitude) it faces from the nearest line between day and night.
OPENING_VIEW = """() => { const w = window.countryQuest.world, c = w.map.getCenter(), sun = w.sun();
  const off = line => Math.abs(((c.lng - line) % 360 + 540) % 360 - 180);
  return { zoom: w.map.getZoom(), globe: w.zGlobe, lat: c.lat, fromLine: Math.min(off(sun.lng + 90), off(sun.lng - 90)) }; }"""

# The camera: centre and zoom.
VIEW = "() => { const m = window.countryQuest.world.map, c = m.getCenter(); return { lng: c.lng, lat: c.lat, zoom: m.getZoom() }; }"

# Drags the map from (x, y) by (dx, dy) in `ms` milliseconds with the mouse or
# a finger, then holds still for `hold` ms, lets go and waits for the map to
# see the drag end; with `touchAfter`, then touches the map at `sky` that many
# ms later (window.touchedAt: when, and the centre longitude then).  The events
# are sent from inside the page: Playwright's own input is too slow on a busy
# machine to make a flick.
FLICK = """async ({ x, y, dx, dy, ms, hold, touch, touchAfter, sky }) => {
  const m = window.countryQuest.world.map, el = m.getCanvas();
  const at = t => [x + dx * t, y + dy * t];
  const send = (type, [cx, cy]) => {
    if (touch) {
      const pt = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
      const list = type === 'touchend' ? [] : [pt];
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [pt] }));
    } else {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy,
        button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
    }
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerType: touch ? 'touch' : 'mouse' }));
  send(touch ? 'touchstart' : 'mousedown', at(0));
  const t0 = performance.now();
  await new Promise(done => { const step = () => { const t = Math.min(1, (performance.now() - t0) / ms);
    send(touch ? 'touchmove' : 'mousemove', at(t)); if (t < 1) setTimeout(step, 8); else done(); }; setTimeout(step, 8); });
  if (hold) await new Promise(res => setTimeout(res, hold));
  const dragEnd = new Promise(res => m.once('dragend', res));
  send(touch ? 'touchend' : 'mouseup', at(1));
  await Promise.race([dragEnd, new Promise(res => setTimeout(res, 5000))]);
  if (!touchAfter) return;
  await new Promise(res => setTimeout(res, touchAfter));
  window.touchedAt = [performance.now(), m.getCenter().lng];
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sky[0], clientY: sky[1], pointerType: touch ? 'touch' : 'mouse' }));
  send(touch ? 'touchstart' : 'mousedown', sky);
  send(touch ? 'touchend' : 'mouseup', sky);
}"""

# Waits (up to 20 s) until the page draws frames quickly again, ten in a row
# under 34 ms; true if it does.
QUICK_FRAMES = """() => new Promise(res => { const t0 = performance.now(); let last = t0, quick = 0;
  const f = now => { quick = now - last < 34 ? quick + 1 : 0; last = now;
    if (quick >= 10 || now - t0 > 20000) res(quick >= 10); else requestAnimationFrame(f); };
  requestAnimationFrame(f); })"""

# From the moment the player lets go of the map: [time in ms, centre longitude]
# whenever the camera moves, for 8 seconds.  The times are those of the frames
# drawn, as the spinning globe uses.  Also counts the frames drawn during the
# drag (window.dragFrames).
RECORD_LET_GO = """() => { const m = window.countryQuest.world.map; window.letGo = null; window.dragFrames = 0;
  const now = () => document.timeline.currentTime;
  const frame = () => { window.dragFrames++; };
  m.once('dragstart', () => m.on('move', frame));
  m.once('dragend', () => { m.off('move', frame); const log = window.letGo = [[now(), m.getCenter().lng]];
    const add = () => { const t = now(); if (t - log[log.length - 1][0] > 1) log.push([t, m.getCenter().lng]); };
    m.on('move', add);
    setTimeout(() => m.off('move', add), 8000); }); }"""


def same_view(a, b):
    return (abs((a['lng'] - b['lng'] + 540) % 360 - 180) < 1e-3 and abs(a['lat'] - b['lat']) < 1e-3
            and abs(a['zoom'] - b['zoom']) < 1e-3)


# How many country names the map shows.
NAMES = "() => window.countryQuest.world.map.queryRenderedFeatures({ layers: ['country-labels', 'dot-labels'] }).length"
PHASE = '() => window.countryQuest.state.phase'

failures = []


def check(cond, message):
    print(('  ok   ' if cond else '  FAIL ') + message)
    if not cond:
        failures.append(message)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, 'http://127.0.0.1:%d' % server.server_address[1]


class Game:
    def __init__(self, browser, base, name, viewport, mobile=False):
        self.name = name
        self.mobile = mobile
        self.shot_no = 0
        self.answer_view = None  # the camera when the last answer was given
        self.ctx = browser.new_context(viewport=viewport, device_scale_factor=2 if mobile else 1,
                                       is_mobile=mobile, has_touch=mobile)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('console', lambda m: self.errors.append(m.text) if m.type == 'error' else None)
        self.page.goto(base + '/?seed=11')
        self.page.wait_for_function("() => window.countryQuest?.state.phase === 'explore'", timeout=90000)

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def idle(self):
        self.js(IDLE)

    def shot(self, label):
        self.shot_no += 1
        self.page.screenshot(path=os.path.join(OUT, '%s-%02d-%s.png' % (self.name, self.shot_no, label)))

    def tap(self, x, y):
        if self.mobile:
            self.page.touchscreen.tap(x, y)
        else:
            self.page.mouse.click(x, y)

    def click(self, selector):
        # force: the Check button gently pulses, which Playwright calls "unstable".
        self.page.click(selector, force=True)

    def answer(self, kind):
        """Tap a country that should score `kind`, press Check, return the result."""
        pick = self.js(PICK, kind)
        self.js('(id) => window.countryQuest.world.showCountries([id], 0)', pick)
        self.idle()
        pt = self.js('(id) => window.countryQuest.world.screenPoint(id)', pick)
        self.tap(pt['x'], pt['y'])
        self.page.wait_for_timeout(250)
        selected = self.js('() => window.countryQuest.state.selected')
        check(selected == pick, '%s: tapping the map selects what was tapped (%s)' % (self.name, kind))
        before = self.js(REVEAL_VIEW)
        self.answer_view = self.js(VIEW)
        self.click('[data-action=check]')
        self.page.wait_for_timeout(1700)
        self.idle()
        # The globe turns to the answer in place: the point the camera centres
        # on stays put, and the answer ends up in the open part of the screen.
        after = self.js(REVEAL_VIEW)
        check(after['padding'] == before['padding'] and after['open'],
              '%s: the globe turns to the answer without sliding, and the answer is in view at (%.0f, %.0f)'
              % (self.name, after['x'], after['y']))
        return self.js("""() => { const s = window.countryQuest.state, r = s.results[s.round];
            return { outcome: r.outcome, points: r.points, score: s.score, gaveUp: !!r.gaveUp }; }""")

    def next(self):
        """Press Next; after an answer the camera must fly back to where the player was looking."""
        last = self.js('() => { const s = window.countryQuest.state; return s.round === s.questions.length - 1; }')
        self.click('[data-action=next]')
        self.page.wait_for_timeout(1400)
        self.idle()
        if self.answer_view and not last:
            back = self.js(VIEW)
            check(same_view(back, self.answer_view), '%s: "Next" flies back to the view from before the answer (%.2f, %.2f, zoom %.2f)'
                  % (self.name, back['lng'], back['lat'], back['zoom']))
        self.answer_view = None


def play_full_game(g):
    g.click('#start-menu-btn')
    g.page.wait_for_timeout(400)
    g.click('#start-btn')
    g.page.wait_for_timeout(1500)
    g.idle()
    g.shot('ask')
    check(g.js(PHASE) == 'ask', '%s: game starts' % g.name)
    check(g.js("() => window.countryQuest.world.map.getLayoutProperty('night', 'visibility')") == 'none',
          '%s: the quiz map has no night shadow' % g.name)
    asked = g.js('() => window.countryQuest.state.questions.map(q => q.dot === undefined || q.pop >= 1e6)')
    check(all(asked), '%s: the quiz asks no tiny countries with few people' % g.name)

    expected = [('exact', 100), ('neighbor', 50), ('continent', 25), ('miss', 0)]
    total = 0
    for kind, points in expected:
        r = g.answer(kind)
        total += points
        check(r['outcome'] == kind and r['points'] == points, '%s: %s scores %d (got %s)' % (g.name, kind, points, r))
        check(r['score'] == total, '%s: running score is %d' % (g.name, total))
        g.shot(kind)
        if kind == 'miss':
            # After answering, tapping a country shows its name.
            pt = g.js('() => window.countryQuest.world.screenPoint(window.countryQuest.state.questions[window.countryQuest.state.round].id)')
            g.tap(pt['x'], pt['y'] + 2)
            g.page.wait_for_timeout(400)
            check(g.page.locator('.tag--explore').count() == 1, '%s: tapping after answering shows a name' % g.name)
        g.next()

    # Give up on round 5, looking at somewhere else entirely.
    g.js("() => window.countryQuest.world.map.jumpTo({ center: [100, 40], zoom: window.countryQuest.world.zGlobe + 0.5 })")
    g.idle()
    g.answer_view = g.js(VIEW)
    g.click('[data-action=giveup]')
    g.page.wait_for_timeout(1500)
    r = g.js('() => { const s = window.countryQuest.state; return s.results[s.round]; }')
    check(r['gaveUp'] and r['points'] == 0, '%s: "Show me" reveals the answer for 0 points' % g.name)
    g.shot('gave-up')
    g.next()

    # Tapping the open sea only shows a hint.
    g.js("() => window.countryQuest.world.map.jumpTo({ center: [-140, -30], zoom: 3 })")
    g.idle()
    vp = g.page.viewport_size
    g.tap(vp['width'] * 0.45, vp['height'] * 0.5)
    g.page.wait_for_timeout(300)
    check(g.js('() => window.countryQuest.state.selected') is None, '%s: tapping the sea selects nothing' % g.name)
    check('sea' in g.page.inner_text('#toast'), '%s: tapping the sea shows a hint' % g.name)

    # Finish the rest quickly through the game API.
    g.js("""() => { const q = window.countryQuest;
        while (q.state.phase !== 'done') { if (q.state.phase === 'ask') q.finishRound(q.state.questions[q.state.round].id); else q.next(); } }""")
    g.page.wait_for_timeout(2500)
    check(g.page.is_visible('#end'), '%s: end screen appears' % g.name)
    check('/ 1000' in g.page.inner_text('#end'), '%s: end screen shows the score' % g.name)
    # The places are grouped by their points, best first: 6 right (rounds 1
    # and 6-10), one neighbour, one on the same continent, a miss and a give-up.
    groups = g.js("""() => [...document.querySelectorAll('.recap__group')].map(e =>
        [e.querySelector('.recap__pts').textContent.replace(/[^+0-9]/g, ''), e.querySelectorAll('.recap__name').length])""")
    check(groups == [['+100', 6], ['+50', 1], ['+25', 1], ['+0', 2]], '%s: the end screen groups the 10 places by points %s' % (g.name, groups))
    fits = g.js("() => { const e = document.getElementById('end'); return e.scrollHeight <= e.clientHeight; }")
    check(fits, '%s: the end screen fits without scrolling' % g.name)
    g.shot('end')
    g.click('[data-action=again]')
    g.page.wait_for_timeout(800)
    check(g.js('() => window.countryQuest.state.phase') == 'ask' and g.js('() => window.countryQuest.state.score') == 0,
          '%s: "Play again" starts a fresh game' % g.name)


def open_menu(g):
    """Open the Start menu: the Start button when exploring, the menu button in a quiz."""
    if not g.page.is_visible('#start'):
        g.click('#start-menu-btn' if g.page.is_visible('#start-menu-btn') else '#menu-btn')
        g.page.wait_for_timeout(500)


def set_names(g, on):
    """Switch the map's names on or off in the Start menu, which is open."""
    if (g.page.get_attribute('#names-btn', 'aria-checked') == 'true') != on:
        g.click('#names-btn')
        g.page.wait_for_timeout(300)


def box(g, selector):
    return g.page.locator(selector).bounding_box()


def overlap(a, b):
    """Do two bounding boxes overlap?"""
    return a['x'] < b['x'] + b['width'] and b['x'] < a['x'] + a['width'] and a['y'] < b['y'] + b['height'] and b['y'] < a['y'] + a['height']


def turning(g, ms=1500):
    """Does the globe turn by itself?  (Slowly here: software rendering draws few frames.)"""
    lng = g.js('() => window.countryQuest.world.map.getCenter().lng')
    g.page.wait_for_timeout(ms)
    return abs(g.js('() => window.countryQuest.world.map.getCenter().lng') - lng) > 0.05


def opening_flow(g):
    """The game opens on a turning globe in Explore mode: day and night, no names, a Start menu."""
    js = g.js
    vp = g.page.viewport_size
    check(js(PHASE) == 'explore' and g.page.is_visible('#start-menu-btn') and not g.page.is_visible('#start'),
          '%s: the game opens on the globe in Explore mode, with a Start button' % g.name)
    start = box(g, '#start-menu-btn')
    check(abs(start['x'] + start['width'] / 2 - vp['width'] / 2) < 2 and start['y'] < 24,
          '%s: the Start button is at the top in the middle' % g.name)
    check(not g.page.is_visible('#panel') and g.page.locator('#sound-btn').count() == 0,
          '%s: no panel ("tap a country") and no sound button on the globe' % g.name)
    tools = js("""() => [...document.querySelectorAll('#map-tools button')].map(b => {
        const r = b.getBoundingClientRect(), bg = getComputedStyle(b).backgroundColor.match(/[\\d.]+/g).map(Number);
        return { size: Math.max(r.width, r.height), alpha: bg.length > 3 ? bg[3] : 1 }; })""")
    check(len(tools) == 3 and all(t['size'] <= 40 and t['alpha'] <= 0.5 for t in tools),
          '%s: the map buttons are small and see-through %s' % (g.name, tools))
    g.idle()
    check(js(NAMES) == 0, '%s: the opening globe has no names' % g.name)
    lng = js('() => window.countryQuest.world.map.getCenter().lng')
    g.page.wait_for_timeout(800)
    check(abs(js('() => window.countryQuest.world.map.getCenter().lng') - lng) > 0.5, '%s: the opening globe turns' % g.name)
    sky = (vp['width'] * 0.03, vp['height'] * 0.12)  # top left, clear of the globe and the buttons
    g.tap(*sky)
    g.page.wait_for_timeout(300)
    check(not turning(g, 800), '%s: touching the map stops it' % g.name)
    check(g.page.locator('.info__name').count() == 0, '%s: a tap in the sky beside the globe selects nothing' % g.name)
    g.shot('opening')

    # Day and night as they are now: look along the evening line, with day to
    # the west and night to the east, and compare how bright the two sides are.
    sun = js('() => window.countryQuest.world.sun()')
    js("""(lng) => { const w = window.countryQuest.world; w.map.jumpTo({ center: [lng, 0], zoom: w.zGlobe }); }""", sun['lng'] + 90)
    g.idle()
    side = lambda dlng: js("""([lng, lats]) => lats.map(lat => { const p = window.countryQuest.world.map.project([lng, lat]); return [p.x, p.y]; })""",
                           [sun['lng'] + 90 + dlng, [-30, -15, 0, 15, 30]])
    light = lambda px: sum(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in px) / len(px)
    day, night = light(js(READ_PIXELS, side(-40))), light(js(READ_PIXELS, side(40)))
    check(night < 0.7 * day, '%s: the night side of the globe is darker (%.0f) than the day side (%.0f)' % (g.name, night, day))
    g.shot('day-and-night')

    # A country card has the capital, languages and a fun fact.
    japan = js("() => window.countryQuest.data.countries.find(c => c.name === 'Japan').id")
    js('(id) => window.countryQuest.world.showCountries([id], 0)', japan)
    g.idle()
    pt = js('(id) => window.countryQuest.world.screenPoint(id)', japan)
    g.tap(pt['x'], pt['y'])
    g.page.wait_for_timeout(700)
    details = g.page.inner_text('.info__details') if g.page.locator('.info__details').count() else ''
    fact = g.page.inner_text('.info__fact') if g.page.locator('.info__fact').count() else ''
    check(g.page.inner_text('.info__name') == 'Japan' and 'Tokyo' in details and 'Japanese' in details and len(fact) > 40,
          '%s: a country card shows the capital, language and a fun fact' % g.name)
    g.shot('fact-card')

    # The Start button opens the Start menu, where names can be switched on.
    g.click('#start-menu-btn')
    g.page.wait_for_timeout(500)
    check(g.page.is_visible('#start') and g.page.get_attribute('#names-btn', 'aria-checked') == 'false',
          '%s: the Start button opens the Start menu, with names off' % g.name)
    fits = js("() => { const s = document.getElementById('start'); return s.scrollHeight <= s.clientHeight; }")
    check(fits and g.page.inner_text('#round-info') == '10 countries to find',
          '%s: the Start menu fits on the screen without scrolling (%s)' % (g.name, g.page.inner_text('#round-info')))
    g.shot('start-menu')
    set_names(g, True)
    g.click('#menu-close')
    g.page.wait_for_timeout(800)
    g.idle()
    check(js(PHASE) == 'explore' and js(NAMES) > 0 and g.page.inner_text('.info__name') == 'Japan',
          '%s: closing the menu goes back to Japan\'s card, now with names (%d)' % (g.name, js(NAMES)))
    g.click('#start-menu-btn')
    g.page.wait_for_timeout(400)
    g.page.keyboard.press('Escape')
    g.page.wait_for_timeout(500)
    check(js(PHASE) == 'explore' and not g.page.is_visible('#start'), '%s: Escape closes the Start menu' % g.name)

    # Tiny countries have no dot on the globe and cannot be tapped there; zoomed
    # in, their dot shows and can be tapped.
    js('() => window.countryQuest.world.setNight(false)')
    nauru = js("() => window.countryQuest.data.countries.find(c => c.name === 'Nauru').id")

    def look_at_nauru(zoom):
        js("""([id, zoom]) => { const w = window.countryQuest.world; w.move({ center: w.data.byId.get(id).label, zoom }, 0); }""",
           [nauru, zoom])
        g.idle()
        pt = js('(id) => window.countryQuest.world.screenPoint(id)', nauru)
        with_dots = js(READ_PIXELS, [[pt['x'], pt['y']]])[0]
        js("() => window.countryQuest.world.map.setLayoutProperty('dots', 'visibility', 'none')")
        without = js(READ_PIXELS, [[pt['x'], pt['y']]])[0]
        js("() => window.countryQuest.world.map.setLayoutProperty('dots', 'visibility', 'visible')")
        g.idle()
        drawn = sum((a - b) ** 2 for a, b in zip(with_dots[:3], without[:3])) ** 0.5 > 60
        g.tap(pt['x'], pt['y'])
        g.page.wait_for_timeout(500)
        return drawn, js('() => window.countryQuest.world.selectedId') == nauru

    drawn, picked = look_at_nauru(js('() => window.countryQuest.world.zGlobe + 1'))
    check(not drawn and not picked, '%s: on the globe a tiny country has no dot and cannot be tapped' % g.name)
    drawn, picked = look_at_nauru(js('() => window.countryQuest.world.dotsFrom + 0.2'))
    check(drawn and picked, '%s: zoomed in, its dot shows and can be tapped' % g.name)
    g.shot('tiny-country-dot')
    js('() => window.countryQuest.world.setNight(true)')

    # The globe button is a reset: the card closes, the camera goes back to
    # the opening globe (facing the line between day and night) and it turns.
    g.click('#zoom-home')
    g.page.wait_for_timeout(1500)
    g.idle()
    view = js(OPENING_VIEW)
    check(not g.page.is_visible('#panel') and abs(view['zoom'] - view['globe']) < 0.05 and abs(view['lat'] - 18) < 0.5
          and view['fromLine'] < 30 and turning(g),
          '%s: the globe button closes the card, goes back to the opening globe and turns it again (%s)' % (g.name, view))
    g.shot('reset')
    g.tap(*sky)
    g.page.wait_for_timeout(300)
    check(not turning(g, 800), '%s: touching the map stops it again' % g.name)


def flick_flow(g):
    """A flick sets the globe spinning: it slows down and stops by itself, and a touch stops it at once."""
    vp = g.page.viewport_size
    w, h = vp['width'], vp['height']
    lng = lambda: g.js('() => window.countryQuest.world.map.getCenter().lng')
    # Software drawing on this busy machine can be slow enough to hide a
    # flick's speed: no names (they make no difference to the spin), and every
    # part of the globe loaded first, so no map tiles arrive during a flick.
    g.js('() => window.countryQuest.world.setLabels(false)')
    for turn in (90, 180, 270, 360):
        g.js('(lng) => { const m = window.countryQuest.world.map; m.jumpTo({ center: [m.getCenter().lng + 90, m.getCenter().lat] }); }', turn)
        g.idle()

    def flick(hold=0, touch_after=0):
        """Flick the globe to the left, so it turns east.  If the machine drew too few
        frames during the flick to see its speed, try again."""
        for _ in range(3):
            g.idle()
            g.js(QUICK_FRAMES)
            g.js(RECORD_LET_GO)
            g.js(FLICK, {'x': w * 0.65, 'y': h * 0.5, 'dx': -w * 0.3, 'dy': 0, 'ms': 600, 'hold': hold, 'touch': g.mobile,
                         'touchAfter': touch_after, 'sky': [w * 0.03, h * 0.12]})
            if g.js('() => window.dragFrames') >= 3:
                return
        print('  (the machine drew too few frames during the flick)')

    def after_let_go():
        """How far the globe turned after letting go, when it last moved (ms), and its speeds on the way."""
        log = g.js('() => window.letGo')
        if not log:
            return 0, 0, [], 0  # no drag at all
        lngs = [log[0][1]]
        for _, x in log[1:]:
            lngs.append(lngs[-1] + (x - lngs[-1] + 540) % 360 - 180)  # unwrapped
        moved = [i for i in range(1, len(log)) if lngs[i] != lngs[i - 1]]
        speeds = [(lngs[i] - lngs[i - 1]) / (log[i][0] - log[i - 1][0]) * 1000 for i in moved]
        return lngs[-1] - lngs[0], (log[moved[-1]][0] if moved else log[0][0]) - log[0][0], speeds, log[0][0]

    flick()
    g.page.wait_for_timeout(5000)
    before = lng()
    g.page.wait_for_timeout(1000)
    turned, took, speeds, _ = after_let_go()
    check(turned > 10 and took > 500 and len(speeds) >= 2 and speeds[0] > speeds[-1] > 0 and lng() == before,
          '%s: a flick sets the globe spinning on; it slows down (%.0f°/s to %.0f°/s) and stops by itself, %.0f° and %.1f s later'
          % (g.name, speeds[0] if speeds else 0, speeds[-1] if speeds else 0, turned, took / 1000))
    g.shot('flicked')

    flick(touch_after=250)
    g.page.wait_for_timeout(1500)
    _, last, _, let_go = after_let_go()
    touched = g.js('() => window.touchedAt')
    check(touched[0] - let_go < took / 2 and last <= touched[0] - let_go and lng() == touched[1],
          '%s: touching the spinning globe stops it at once (%.1f s after letting go)' % (g.name, (touched[0] - let_go) / 1000))

    flick(hold=1500)
    g.page.wait_for_timeout(2500)
    held = after_let_go()[0]
    check(abs(held) < 0.01, '%s: a drag held still before letting go does not spin the globe (%.2f°)' % (g.name, held))
    g.js('() => window.countryQuest.world.setLabels(window.countryQuest.state.names)')


def explore_flow(g):
    """Explore mode: names on the map, a country card, neighbours, names off, back to the quiz."""
    g.click('#menu-btn')
    g.page.wait_for_timeout(500)
    g.click('#explore-btn')
    g.page.wait_for_timeout(1500)
    g.idle()
    check(g.js(PHASE) == 'explore', '%s: Explore mode opens' % g.name)
    check(g.js(NAMES) > 10, '%s: Explore mode shows country names (%d)' % (g.name, g.js(NAMES)))
    check(g.js("() => window.countryQuest.world.map.getLayoutProperty('night', 'visibility')") == 'visible',
          '%s: Explore mode shows the night' % g.name)
    g.shot('explore')

    brazil = g.js("() => window.countryQuest.data.countries.find(c => c.name === 'Brazil').id")
    g.js('(id) => window.countryQuest.world.showCountries([id], 0)', brazil)
    g.idle()
    pt = g.js('(id) => window.countryQuest.world.screenPoint(id)', brazil)
    g.tap(pt['x'], pt['y'])
    g.page.wait_for_timeout(700)
    check(g.page.inner_text('.info__name') == 'Brazil', '%s: tapping a country opens its card' % g.name)
    check('South America' in g.page.inner_text('.info__facts') and 'million people' in g.page.inner_text('.info__facts')
          and 'Brasília' in g.page.inner_text('.info__details'),
          '%s: the card shows the continent, population and capital' % g.name)
    g.shot('explore-card')

    # The card is compact (no lists of neighbours). On a wide screen held
    # sideways it sits at the right, on a phone held upright at the bottom,
    # and the map moves so the tapped country is not hidden under it.
    g.idle()
    vp = g.page.viewport_size
    card = box(g, '#panel')
    wide = vp['width'] > vp['height']
    placed = card['x'] > vp['width'] * 0.45 if wide else card['y'] > vp['height'] * 0.4
    pt = g.js('(id) => window.countryQuest.world.screenPoint(id)', brazil)
    hidden = card['x'] <= pt['x'] <= card['x'] + card['width'] and card['y'] <= pt['y'] <= card['y'] + card['height']
    check(g.page.locator('.info__group').count() == 0 and placed and not hidden,
          '%s: the card has no neighbour lists, sits at the %s and leaves Brazil in sight'
          % (g.name, 'right' if wide else 'bottom'))
    check(not overlap(card, box(g, '#start-menu-btn')) and not overlap(card, box(g, '#map-tools')),
          '%s: the card covers neither the Start button nor the map buttons' % g.name)

    g.click('#start-menu-btn')
    g.page.wait_for_timeout(400)
    set_names(g, False)
    g.click('#menu-close')
    g.page.wait_for_timeout(600)
    g.idle()
    check(g.js(NAMES) == 0, '%s: "Show names" off hides the names' % g.name)
    cid = g.js('() => window.countryQuest.world.selectedId')
    pt = g.js('(id) => window.countryQuest.world.screenPoint(id)', cid)
    g.tap(pt['x'], pt['y'])
    g.page.wait_for_timeout(500)
    check(g.page.locator('.tag--explore').count() == 1, '%s: with names off, a tapped country gets a name tag' % g.name)
    g.shot('explore-names-off')

    g.click('[data-action=close]')
    g.page.wait_for_timeout(300)
    check(g.js('() => window.countryQuest.world.selectedId') is None and not g.page.is_visible('#panel'),
          '%s: closing the card clears the selection and leaves no panel' % g.name)
    g.click('#start-menu-btn')
    g.page.wait_for_timeout(400)
    set_names(g, True)
    g.click('#start-btn')
    g.page.wait_for_timeout(1200)
    check(g.js(PHASE) == 'ask', '%s: "Let\'s go!" in the Start menu starts a game' % g.name)
    check(g.js("() => window.countryQuest.world.map.getLayoutProperty('country-labels', 'visibility')") == 'none',
          '%s: the quiz map has no names, even with "Show names" on' % g.name)


def us_states_flow(g):
    """The US States category: a quiz answered by tapping states, then exploring them."""
    states_drawn = "() => window.countryQuest.world.map.getLayoutProperty('state-land', 'visibility') === 'visible'"
    open_menu(g)
    g.click('[data-region="us-states"]')
    g.page.wait_for_timeout(300)
    check(g.page.inner_text('#round-info').startswith('10 states'), '%s: the Start menu offers a US States quiz' % g.name)
    g.click('#start-btn')
    g.page.wait_for_timeout(1500)
    g.idle()
    check(g.js("() => window.countryQuest.state.questions.every(q => q.kind === 'state')") and g.js(states_drawn),
          '%s: a US States game asks for states, on a map of the states' % g.name)
    g.shot('us-states')
    for kind, points in [('exact', 100), ('neighbor', 50), ('continent', 25), ('miss', 0)]:
        r = g.answer(kind)
        check(r['outcome'] == kind and r['points'] == points, '%s: a state answer, %s, scores %d (got %s)' % (g.name, kind, points, r))
        g.next()

    open_menu(g)
    set_names(g, True)
    g.click('#explore-btn')
    g.page.wait_for_timeout(1500)
    g.idle()
    names = g.js("() => window.countryQuest.world.map.queryRenderedFeatures({ layers: ['state-labels'] }).length")
    check(g.js(PHASE) == 'explore' and g.js(states_drawn) and names >= 10,
          '%s: exploring the US States shows the states and their names (%d)' % (g.name, names))
    texas = g.js("() => window.countryQuest.data.states.find(s => s.postal === 'TX').id")
    g.js('(id) => window.countryQuest.world.showCountries([id], 0)', texas)
    g.idle()
    pt = g.js('(id) => window.countryQuest.world.screenPoint(id)', texas)
    g.tap(pt['x'], pt['y'])
    g.page.wait_for_timeout(700)
    details = g.page.inner_text('.info__details') if g.page.locator('.info__details').count() else ''
    check(g.page.inner_text('.info__name') == 'Texas' and 'Austin' in details and 'Lone Star' in details
          and g.page.inner_text('.info__badge') == 'TX', '%s: a state card shows its code, capital and nickname' % g.name)
    g.shot('us-states-card')

    open_menu(g)
    g.click('[data-region="world"]')
    set_names(g, False)
    g.click('#explore-btn')
    g.page.wait_for_timeout(1200)
    check(not g.js(states_drawn), '%s: back on the whole world, the states are hidden' % g.name)


def province_flow(g):
    """The Start menu's second page: a country's provinces (here Bangladesh's districts), with the other countries muted."""
    page2 = "() => !document.querySelector('.start__page[data-page=\"2\"]').inert"
    drawn = '() => window.countryQuest.world.statesOn'
    faded = "() => window.countryQuest.world.map.getPaintProperty('ocean', 'background-color') !== '#5DB7EA'"
    open_menu(g)
    g.page.wait_for_function("() => window.countryQuest.provinces === 'ready'", timeout=60000)
    check(not g.js(page2), '%s: the Start menu opens on its first page' % g.name)
    g.click('.start__dot[data-page="2"]')
    g.page.wait_for_function("""() => getComputedStyle(document.querySelector('.start__page[data-page="2"]')).visibility === 'visible'""")
    g.page.wait_for_timeout(300)
    check(g.js(page2) and g.page.locator('#country-chips .chip').count() == 8,
          '%s: the second dot turns the menu to the countries' % g.name)
    g.click('#country-chips [data-region="BGD"]')
    g.page.wait_for_timeout(300)
    check(g.page.inner_text('#round-info').startswith('10 districts'), '%s: Bangladesh offers its districts' % g.name)
    g.shot('countries-menu')
    g.click('#start-btn')
    g.page.wait_for_timeout(1500)
    g.idle()
    check(g.js("() => window.countryQuest.state.questions.every(q => q.kind === 'province' && q.country === 'BGD')")
          and g.js(drawn) == 'BGD' and g.js(faded),
          '%s: a Bangladesh game asks for its districts, on a map of them, with the other countries muted' % g.name)
    g.shot('bangladesh')
    for kind, points in [('exact', 100), ('neighbor', 50)]:
        r = g.answer(kind)
        check(r['outcome'] == kind and r['points'] == points, '%s: a district answer, %s, scores %d (got %s)' % (g.name, kind, points, r))
        g.next()
    open_menu(g)
    check(g.js(page2), '%s: the menu opens again on the countries' % g.name)
    g.click('.start__dot[data-page="1"]')
    g.page.wait_for_function("""() => getComputedStyle(document.querySelector('.start__page[data-page="1"]')).visibility === 'visible'""")
    g.page.wait_for_timeout(300)
    check(g.js('() => window.countryQuest.state.region') == 'world', '%s: the first page keeps its own choice' % g.name)
    g.click('#explore-btn')
    g.page.wait_for_timeout(1200)
    check(not g.js(drawn) and not g.js(faded), '%s: back on the whole world, no districts and nothing muted' % g.name)


def globe_flow(g):
    """The globe stays round until it covers the whole screen, then unrolls; taps hit what is drawn."""
    open_menu(g)
    set_names(g, False)  # no names or night, so the pixel checks see the country colours
    g.click('#explore-btn')
    g.page.wait_for_timeout(1500)
    g.js('() => window.countryQuest.world.setNight(false)')
    corners = g.js("""() => { const c = window.countryQuest.world.map.getCanvas(), w = c.clientWidth, h = c.clientHeight;
        return [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]]; }""")
    roundness = '() => window.countryQuest.world.map.style.projection.transitionState'

    def corner_pixels(dz):
        g.js(NEAR_SWITCH, dz)
        g.idle()
        return g.js(READ_PIXELS, corners), g.js(roundness)

    px, round_ = corner_pixels(-0.1)
    check(round_ == 1 and any(p[3] < 10 for p in px),
          '%s: just before the switch the map is a round globe that does not cover the corners yet' % g.name)
    px, round_ = corner_pixels(0)
    check(round_ == 1 and all(p[3] > 250 for p in px), '%s: the globe covers every corner before it unrolls' % g.name)
    g.shot('globe-fills-screen')
    _, round_ = corner_pixels(1)
    check(round_ == 0, '%s: one zoom level later the map is flat' % g.name)

    # While the globe unrolls, MapLibre draws places away from where its own
    # maths puts them.  Every country in the open part of the screen must be
    # drawn where the game thinks it is, and tapping there must pick it.
    g.js(UNROLLING_OVER_EUROPE)
    g.idle()
    rows = g.js("""() => { const { world: w, data: d } = window.countryQuest, m = w.map;
        const c = m.getCanvas(), pad = w.padding();  // the part of the screen not under cards and buttons
        const mid = m.getCenter(), rad = Math.PI / 180;
        const nearSide = ([lng, lat]) => Math.sin(lat * rad) * Math.sin(mid.lat * rad)
          + Math.cos(lat * rad) * Math.cos(mid.lat * rad) * Math.cos((lng - mid.lng) * rad) > 0;
        return d.countries.filter(country => country.kind === 'country' && country.area > 50000 && nearSide(country.label)).map(country => {
          const p = w.drawnPoint(country.label), q = m.project(country.label);
          return { name: country.name, color: country.color, x: p.x, y: p.y, gap: Math.hypot(p.x - q.x, p.y - q.y) };
        }).filter(r => r.x > pad.left && r.x < c.clientWidth - pad.right && r.y > pad.top && r.y < c.clientHeight - pad.bottom); }""")
    pixels = g.js(READ_PIXELS, [[r['x'], r['y']] for r in rows])
    wrong = [r['name'] for r, px in zip(rows, pixels) if nearest_colour(px) != r['color']]
    widest = max(rows, key=lambda r: r['gap'])
    check(len(rows) >= 3 and not wrong, '%s: while unrolling, %d countries are drawn where the game thinks, up to %.0f px from '
          'MapLibre\'s own point %s' % (g.name, len(rows), widest['gap'], wrong))
    g.tap(widest['x'], widest['y'])
    g.page.wait_for_timeout(700)
    check(g.page.inner_text('.info__name') == widest['name'], '%s: tapping %s there opens its card' % (g.name, widest['name']))
    g.shot('globe-unrolling')


# The map's country colours (js/map.js), then the sea.
COLOURS = ['#FF8A80', '#FFB74D', '#FFE066', '#AEDC6E', '#6FD6A8', '#B79CF2', '#F78FC2', '#5DB7EA']


def nearest_colour(px):
    """Index in COLOURS of the colour closest to an [r, g, b, a] pixel."""
    def dist(hex_):
        return sum((int(hex_[i:i + 2], 16) - px[j]) ** 2 for j, i in enumerate((1, 3, 5)))
    return min(range(len(COLOURS)), key=lambda i: dist(COLOURS[i]))


def main():
    os.makedirs(OUT, exist_ok=True)
    server, base = start_server()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=BROWSER_ARGS)

        print('unit tests')
        page = browser.new_page()
        page.goto(base + '/tests/unit.html')
        page.wait_for_function('window.testResults', timeout=60000)
        for r in page.evaluate('window.testResults'):
            check(r['ok'], r['name'] + ('' if r['ok'] else ' — ' + r['error']))
        page.close()

        for name, viewport, mobile in [('desktop', {'width': 1366, 'height': 820}, False),
                                       ('phone', {'width': 390, 'height': 844}, True),
                                       ('phone-landscape', {'width': 844, 'height': 390}, True)]:
            print(name)
            g = Game(browser, base, name, viewport, mobile)
            g.page.wait_for_timeout(1500)
            opening_flow(g)
            flick_flow(g)
            play_full_game(g)
            explore_flow(g)
            us_states_flow(g)
            province_flow(g)
            globe_flow(g)
            check(not g.errors, '%s: no errors in the console %s' % (name, g.errors[:3]))
            g.ctx.close()
        browser.close()
    server.shutdown()

    print()
    print('screenshots in', os.path.relpath(OUT, os.getcwd()))
    if failures:
        print('%d check(s) FAILED' % len(failures))
        sys.exit(1)
    print('all checks passed')


if __name__ == '__main__':
    main()
