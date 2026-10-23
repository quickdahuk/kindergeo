#!/usr/bin/env python3
"""Build the map data for Country Quest from Natural Earth (public domain).

Reads the Natural Earth 1:50m "admin 0 countries (lakes)" GeoJSON and writes

  data/world.json      quantized country polygons plus border / coast lines
  data/countries.json  per-feature facts the game needs: names, continents,
                       land and sea neighbours, difficulty tier, label point,
                       bounds, map colour

Only the Python standard library is needed:

  python3 tools/build_data.py            # downloads the source on first run
  python3 tools/build_data.py --report   # also prints the neighbour lists
"""
import argparse
import json
import math
import os
import urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NE_URL = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/'
          'master/geojson/ne_50m_admin_0_countries_lakes.geojson')
NE_FILE = os.path.join(ROOT, '.cache', 'ne', 'ne_50m_admin_0_countries_lakes.geojson')
OUT_DIR = os.path.join(ROOT, 'data')

Q = 1000                 # coordinate quantization: units per degree (~110 m)
SEA_NEIGHBOR_KM = 150    # countries this close across water count as neighbours
ISLAND_FALLBACK_KM = 500 # isolated countries get their nearest few within this
DOT_MAX_AREA_KM2 = 7000  # quiz countries smaller than this get a tappable dot
MEDIUM_MIN_AREA_KM2 = 10000
PALETTE_SIZE = 7

# --- Which features are quiz countries -------------------------------------

UN_MEMBERS = set('''
DZA AGO BEN BWA BFA BDI CPV CMR CAF TCD COM COG COD CIV DJI EGY GNQ ERI SWZ ETH
GAB GMB GHA GIN GNB KEN LSO LBR LBY MDG MWI MLI MRT MUS MAR MOZ NAM NER NGA RWA
STP SEN SYC SLE SOM ZAF SSD SDN TZA TGO TUN UGA ZMB ZWE
AFG ARM AZE BHR BGD BTN BRN KHM CHN CYP GEO IND IDN IRN IRQ ISR JPN JOR KAZ KWT
KGZ LAO LBN MYS MDV MNG MMR NPL PRK OMN PAK PHL QAT KOR SAU SGP LKA SYR TJK THA
TLS TUR TKM ARE UZB VNM YEM
ALB AND AUT BLR BEL BIH BGR HRV CZE DNK EST FIN FRA DEU GRC HUN ISL IRL ITA LVA
LIE LTU LUX MLT MDA MCO MNE NLD MKD NOR POL PRT ROU RUS SMR SRB SVK SVN ESP SWE
CHE UKR GBR
ATG ARG BHS BRB BLZ BOL BRA CAN CHL COL CRI CUB DMA DOM ECU SLV GRD GTM GUY HTI
HND JAM MEX NIC PAN PRY PER KNA LCA VCT SUR TTO USA URY VEN
AUS FJI KIR MHL FSM NRU NZL PLW PNG WSM SLB TON TUV VUT
'''.split())
assert len(UN_MEMBERS) == 193
# Widely shown on world maps, so they are part of the quiz too.
EXTRA_QUIZ = {'TWN', 'XKX', 'PSE', 'VAT'}

# Big or famous countries that make up the "Easy" level.
EASY = set('''
EGY MAR DZA LBY NGA ZAF KEN ETH MDG COD SDN TZA SOM GHA AGO NAM
CHN IND JPN KOR SAU IRN IRQ TUR PAK MNG KAZ THA VNM IDN PHL AFG MYS LKA NPL
RUS GBR FRA DEU ESP ITA PRT GRC NOR SWE FIN POL UKR IRL ISL NLD CHE
USA CAN MEX CUB PAN JAM GTM CRI
BRA ARG CHL PER COL VEN BOL ECU URY PRY
AUS NZL PNG FJI
'''.split())

# Natural Earth code -> our code (ISO 3166 alpha-3 where one exists).
RENAME = {'SDS': 'SSD', 'PSX': 'PSE', 'SAH': 'ESH', 'KOS': 'XKX'}

# Parts that are internationally recognised as belonging to another feature.
MERGE = {
    'CYN': 'CYP',  # Northern Cyprus
    'SOL': 'SOM',  # Somaliland
    'KAS': 'IND',  # Siachen Glacier
    'HKG': 'CHN', 'MAC': 'CHN',
    'ALD': 'FIN',  # Åland
    'GGY': 'GBR', 'JEY': 'GBR', 'IMN': 'GBR',
}

# Overseas parts split off into their own (non-quiz) features, so that
# tapping French Guiana does not say "France".  (lon0, lat0, lon1, lat1)
SPLIT = {
    'FRA': [('GUF', 'French Guiana', 'GF', (-55, 1.5, -51, 6.5), 'South America'),
            ('GLP', 'Guadeloupe', 'GP', (-62, 15.8, -60.9, 16.6), 'North America'),
            ('MTQ', 'Martinique', 'MQ', (-61.3, 14.3, -60.7, 15.0), 'North America'),
            ('REU', 'Réunion', 'RE', (55, -21.5, 56, -20.8), 'Africa'),
            ('MYT', 'Mayotte', 'YT', (44.9, -13.1, 45.4, -12.5), 'Africa')],
    'NLD': [('BES', 'Caribbean Netherlands', 'BQ', (-69, 11.5, -62.5, 18.5), 'North America')],
    'NZL': [('TKL', 'Tokelau', 'TK', (-173, -10, -170, -8), 'Oceania')],
}
# Polygons moved between features: Crimea (Ukraine, per the UN).
MOVE = [('RUS', 'UKR', (32.0, 44.0, 36.8, 46.3))]

# Hand-made corrections to the computed sea neighbours: pairs people call
# neighbours although they are a bit too far apart, and pairs that are only
# "close" along a coast that belongs to a third country.
EXTRA_SEA_NEIGHBORS = [('AUS', 'NZL'), ('AUS', 'IDN'), ('IDN', 'PHL'), ('JPN', 'TWN'), ('USA', 'CUB')]
NOT_NEIGHBORS = [('FRA', 'NLD'), ('ALB', 'HRV'), ('BEN', 'GHA')]

SOVEREIGN = {'DN1': 'DNK', 'FR1': 'FRA', 'GB1': 'GBR', 'NL1': 'NLD', 'US1': 'USA',
             'AU1': 'AUS', 'NZ1': 'NZL', 'FI1': 'FIN', 'CH1': 'CHN', 'IS1': 'ISR',
             'CU1': 'CUB', 'KA1': 'KAZ'}

NAMES = {
    'USA': 'United States', 'RUS': 'Russia', 'KOR': 'South Korea',
    'PRK': 'North Korea', 'LAO': 'Laos', 'COD': 'DR Congo',
    'COG': 'Republic of the Congo', 'CZE': 'Czechia', 'SWZ': 'Eswatini',
    'CPV': 'Cape Verde', 'TLS': 'East Timor', 'VAT': 'Vatican City',
    'BRN': 'Brunei', 'GMB': 'Gambia', 'FSM': 'Micronesia', 'TUR': 'Turkey',
    'STP': 'São Tomé and Príncipe', 'CIV': "Côte d'Ivoire",
    'VCT': 'Saint Vincent and the Grenadines', 'FLK': 'Falkland Islands',
    'IOA': 'Christmas and Cocos Islands', 'ATF': 'French Southern Lands',
    'SGS': 'South Georgia', 'HMD': 'Heard Island', 'FRO': 'Faroe Islands',
    'IOT': 'British Indian Ocean Territory', 'ESH': 'Western Sahara',
    'MAF': 'Saint Martin', 'BLM': 'Saint Barthélemy', 'WLF': 'Wallis and Futuna',
    'ATC': 'Ashmore and Cartier Islands', 'XKX': 'Kosovo', 'PSE': 'Palestine',
}

CONTINENT_OVERRIDE = {
    # Countries that sit on two continents count for both.
    'RUS': ['Europe', 'Asia'], 'TUR': ['Asia', 'Europe'], 'CYP': ['Europe', 'Asia'],
    'GEO': ['Asia', 'Europe'], 'ARM': ['Asia', 'Europe'], 'AZE': ['Asia', 'Europe'],
    # Remote islands Natural Earth files under "Seven seas".
    'ATF': ['Antarctica'], 'HMD': ['Antarctica'], 'SGS': ['Antarctica'],
    'IOT': ['Asia'], 'IOA': ['Asia'], 'SHN': ['Africa'],
}


def continents_for(p):
    region, sub = p['REGION_UN'], p['SUBREGION']
    if region == 'Americas':
        return ['South America' if sub == 'South America' else 'North America']
    if region in ('Africa', 'Asia', 'Europe', 'Oceania', 'Antarctica'):
        return [region]
    raise ValueError('no continent for %s (%s / %s)' % (p['ADM0_A3'], region, sub))


# --- Geometry helpers ------------------------------------------------------

def quantize_ring(ring):
    out = []
    for lon, lat in ring:
        p = (round(lon * Q), round(lat * Q))
        if not out or p != out[-1]:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def signed_area2(ring):
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
               for i in range(len(ring) - 1))


def ring_area_km2(ring):
    """Area of a (quantized) lon/lat ring on a sphere, in km²."""
    r = 6371.0088
    s = 0.0
    for i in range(len(ring) - 1):
        l1, p1 = math.radians(ring[i][0] / Q), math.radians(ring[i][1] / Q)
        l2, p2 = math.radians(ring[i + 1][0] / Q), math.radians(ring[i + 1][1] / Q)
        s += (l2 - l1) * (2 + math.sin(p1) + math.sin(p2))
    return abs(s * r * r / 2)


def polygon_area_km2(poly):
    return max(0.0, ring_area_km2(poly[0]) - sum(ring_area_km2(h) for h in poly[1:]))


def ring_bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs) / Q, min(ys) / Q, max(xs) / Q, max(ys) / Q


def point_in_ring(x, y, ring):
    inside = False
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def dissolve(polys):
    """Union polygons that share edges (exact vertex matches).

    Rings are oriented (outer CCW, holes CW); a shared edge then appears once
    in each direction and cancels out.  What is left is chained back into rings.
    """
    count = defaultdict(int)
    for poly in polys:
        for k, ring in enumerate(poly):
            ccw = signed_area2(ring) > 0
            r = ring if ccw == (k == 0) else ring[::-1]
            for i in range(len(r) - 1):
                a, b = r[i], r[i + 1]
                if count.get((b, a), 0) > 0:
                    count[(b, a)] -= 1
                else:
                    count[(a, b)] += 1
    nxt = defaultdict(list)
    for (a, b), n in count.items():
        if n > 0:
            nxt[a].extend([b] * n)
    rings = []
    while nxt:
        start = next(iter(nxt))
        ring, cur = [start], start
        while True:
            options = nxt[cur]
            step = options.pop()
            if not options:
                del nxt[cur]
            ring.append(step)
            cur = step
            if cur == start:
                break
        if len(ring) >= 4:
            rings.append(ring)
    outers = [[r] for r in rings if signed_area2(r) > 0]
    for hole in (r for r in rings if signed_area2(r) <= 0):
        x, y = hole[0]
        owners = [p for p in outers if point_in_ring(x, y, p[0])]
        if owners:
            min(owners, key=lambda p: abs(signed_area2(p[0]))).append(hole)
    return outers


def lon_span(intervals):
    """Smallest longitude range covering all [w, e] intervals (may cross 180°)."""
    intervals = sorted(intervals)
    merged = []
    for w, e in intervals:
        if merged and w <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([w, e])
    if len(merged) == 1:
        return merged[0][0], merged[0][1]
    # Find the biggest empty gap (including the one across the antimeridian).
    best_gap, west, east = (merged[0][0] + 360) - merged[-1][1], merged[0][0], merged[-1][1]
    for i in range(len(merged) - 1):
        gap = merged[i + 1][0] - merged[i][1]
        if gap > best_gap:
            best_gap, west, east = gap, merged[i + 1][0], merged[i][1] + 360
    return west, east


def chain(segments):
    """Join undirected segments into as few polylines as possible."""
    adj = defaultdict(list)
    for i, (p, q) in enumerate(segments):
        adj[p].append(i)
        adj[q].append(i)
    used = [False] * len(segments)

    def walk(start, si):
        line, cur = [start], start
        while si is not None:
            used[si] = True
            p, q = segments[si]
            cur = q if p == cur else p
            line.append(cur)
            si = None
            if len(adj[cur]) == 2:
                si = next((s for s in adj[cur] if not used[s]), None)
        return line

    lines = []
    for v, segs in adj.items():
        if len(segs) != 2:
            for si in segs:
                if not used[si]:
                    lines.append(walk(v, si))
    for si in range(len(segments)):
        if not used[si]:
            lines.append(walk(segments[si][0], si))
    return lines


def encode(coords):
    """Delta-encode a list of integer points: [x0, y0, dx1, dy1, ...]."""
    out = [coords[0][0], coords[0][1]]
    for i in range(1, len(coords)):
        out.append(coords[i][0] - coords[i - 1][0])
        out.append(coords[i][1] - coords[i - 1][1])
    return out


# --- Build -----------------------------------------------------------------

def load_source():
    if not os.path.exists(NE_FILE):
        os.makedirs(os.path.dirname(NE_FILE), exist_ok=True)
        print('downloading', NE_URL)
        urllib.request.urlretrieve(NE_URL, NE_FILE)
    with open(NE_FILE, encoding='utf-8') as f:
        return json.load(f)['features']


def build_features(source):
    feats = {}
    for f in source:
        p = f['properties']
        code = RENAME.get(p['ADM0_A3'], p['ADM0_A3'])
        g = f['geometry']
        raw = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        polys = []
        for poly in raw:
            rings = [quantize_ring(r) for r in poly]
            if rings[0] is None:
                continue
            polys.append([rings[0]] + [r for r in rings[1:] if r])
        iso2 = p['ISO_A2_EH'] if p['ISO_A2_EH'] not in ('-99', None) else ''
        feats[code] = {
            'code': code,
            'name': NAMES.get(code) or p['NAME_LONG'],
            'iso2': iso2,
            'sov': SOVEREIGN.get(p['SOV_A3'], RENAME.get(p['SOV_A3'], p['SOV_A3'])),
            'cont': CONTINENT_OVERRIDE.get(code) or continents_for(p),
            'label': [p['LABEL_X'], p['LABEL_Y']],
            'pop': int(p['POP_EST'] or 0),
            'polys': polys,
        }

    for src, dst, (x0, y0, x1, y1) in MOVE:
        keep, moved = [], []
        for poly in feats[src]['polys']:
            w, s, e, n = ring_bbox(poly[0])
            (moved if (w >= x0 and s >= y0 and e <= x1 and n <= y1) else keep).append(poly)
        print('moved %d polygon(s) %s -> %s (%.0f km²)' % (
            len(moved), src, dst, sum(polygon_area_km2(p) for p in moved)))
        feats[src]['polys'] = keep
        feats[dst]['polys'] += moved
        feats[dst]['dissolve'] = True

    for src, parts in SPLIT.items():
        for code, name, iso2, (x0, y0, x1, y1), cont in parts:
            keep, taken = [], []
            for poly in feats[src]['polys']:
                w, s, e, n = ring_bbox(poly[0])
                cx, cy = (w + e) / 2, (s + n) / 2
                (taken if (x0 <= cx <= x1 and y0 <= cy <= y1) else keep).append(poly)
            assert taken, 'nothing split off for ' + code
            feats[src]['polys'] = keep
            big = max(taken, key=polygon_area_km2)
            w, s, e, n = ring_bbox(big[0])
            feats[code] = {'code': code, 'name': name, 'iso2': iso2, 'sov': src,
                           'cont': [cont], 'label': [(w + e) / 2, (s + n) / 2],
                           'pop': 0, 'polys': taken}

    for src, dst in MERGE.items():
        part = feats.pop(src)
        feats[dst]['polys'] += part['polys']
        feats[dst]['pop'] += part['pop']
        feats[dst]['dissolve'] = True

    for f in feats.values():
        if f.pop('dissolve', False):
            before = len(f['polys'])
            f['polys'] = dissolve(f['polys'])
            print('dissolved %s: %d -> %d polygons' % (f['code'], before, len(f['polys'])))
        f['area'] = sum(polygon_area_km2(p) for p in f['polys'])
        if f['code'] == 'ATA':
            f['kind'] = 'antarctica'
        elif f['code'] in UN_MEMBERS or f['code'] in EXTRA_QUIZ:
            f['kind'] = 'country'
        else:
            f['kind'] = 'territory'
        if f['kind'] != 'territory' or f['sov'] == f['code']:
            f['sov'] = ''

    quiz = {c for c, f in feats.items() if f['kind'] == 'country'}
    missing = (UN_MEMBERS | EXTRA_QUIZ) - quiz
    assert not missing, 'quiz countries missing from source: %s' % sorted(missing)
    return feats


def is_seam(a, b):
    """Edges along the antimeridian or the south pole are cut lines, not coast."""
    return (abs(a[0]) == 180 * Q and a[0] == b[0]) or (a[1] <= -89.9 * Q and b[1] <= -89.9 * Q)


def build_lines(feats):
    """Classify every polygon edge as a border (two features) or coast (one).

    Returns the chained lines, the land-neighbour sets and each feature's
    coast edges.  Features that touch at a single vertex are neighbours too.
    """
    owners = defaultdict(list)
    vertex_owners = defaultdict(set)
    for code, f in feats.items():
        for poly in f['polys']:
            for ring in poly:
                for i in range(len(ring) - 1):
                    a, b = ring[i], ring[i + 1]
                    owners[(a, b) if a < b else (b, a)].append(code)
                    vertex_owners[a].add(code)
    groups = defaultdict(list)
    for seg, codes in owners.items():
        distinct = sorted(set(codes))
        if len(distinct) == 1:
            if len(codes) == 1 and not is_seam(*seg):
                groups[(distinct[0], '')].append(seg)
        else:
            for i, a in enumerate(distinct):
                for b in distinct[i + 1:]:
                    groups[(a, b)].append(seg)
    land = defaultdict(set)
    for codes in vertex_owners.values():
        if len(codes) > 1:
            for a in codes:
                land[a] |= codes - {a}
    lines = [{'a': a, 'b': b, 'lines': chain(segs)} for (a, b), segs in sorted(groups.items())]
    coast = {a: segs for (a, b), segs in groups.items() if not b}
    return lines, land, coast


class LandMask:
    """Which feature owns each 0.05° cell (0 = water), by scanline fill."""
    RES = 0.05

    def __init__(self, feats, index):
        self.w, self.h = int(360 / self.RES), int(180 / self.RES)
        self.cells = bytearray(self.w * self.h)
        for code, f in feats.items():
            fill = bytes([index[code]])
            for poly in f['polys']:
                rows = defaultdict(list)
                for ring in poly:
                    for i in range(len(ring) - 1):
                        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
                        if y1 == y2:
                            continue
                        lo, hi = min(y1, y2) / Q, max(y1, y2) / Q
                        r0 = math.ceil((lo + 90) / self.RES - 0.5)
                        r1 = math.ceil((hi + 90) / self.RES - 0.5)
                        for r in range(r0, r1):
                            yc = ((r + 0.5) * self.RES - 90) * Q
                            rows[r].append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
                for r, xs in rows.items():
                    if not 0 <= r < self.h:
                        continue
                    xs.sort()
                    base = r * self.w
                    for j in range(0, len(xs) - 1, 2):
                        c0 = max(0, math.ceil((xs[j] / Q + 180) / self.RES - 0.5))
                        c1 = min(self.w - 1, math.floor((xs[j + 1] / Q + 180) / self.RES - 0.5))
                        if c1 >= c0:
                            self.cells[base + c0:base + c1 + 1] = fill * (c1 - c0 + 1)

    def owner(self, lon, lat):
        c = int((lon + 180) / self.RES) % self.w
        r = min(self.h - 1, max(0, int((lat + 90) / self.RES)))
        return self.cells[r * self.w + c]


def coast_grid(coast):
    """Coast vertices bucketed into 1° cells, thinned to one per 0.05°."""
    grid = defaultdict(lambda: defaultdict(list))
    for code, segs in coast.items():
        seen = set()
        for seg in segs:
            for x, y in seg:
                fine = (x * 20 // Q, y * 20 // Q)
                if fine in seen:
                    continue
                seen.add(fine)
                grid[(math.floor(x / Q), math.floor(y / Q))][code].append((x / Q, y / Q))
    return grid


def sea_neighbors(grid, mask, index, limit_km, skip=frozenset(), only=None):
    """Shortest over-water distance (km) between coasts closer than limit_km.

    A connection only counts if the straight line between the two coast
    points does not cross a third country's land, so e.g. the Netherlands and
    France are not "neighbours across the sea" via Belgium's coast.  Pairs in
    `skip` are ignored; with `only`, just pairs involving those codes.
    """
    cands = defaultdict(list)
    dlat = int(math.ceil(limit_km / 111.0))
    lim2 = (limit_km / 111.2) ** 2
    for (cx, cy), by_code in grid.items():
        if only is not None and not (only & by_code.keys()):
            continue
        kx = math.cos(math.radians(cy + 0.5))
        edge = math.cos(math.radians(min(89.0, abs(cy + 0.5) + 1 + limit_km / 111.0)))
        dlon = min(180, int(math.ceil(limit_km / (111.0 * max(0.02, edge)))))
        for ox in range(-dlon, dlon + 1):
            for oy in range(-dlat, dlat + 1):
                other = grid.get((((cx + ox + 180) % 360) - 180, cy + oy))
                if not other:
                    continue
                for a, pts_a in by_code.items():
                    if only is not None and a not in only:
                        continue
                    for b, pts_b in other.items():
                        if a == b or (only is None and a > b):
                            continue
                        key = (a, b) if a < b else (b, a)
                        if key in skip:
                            continue
                        found = []
                        for (x1, y1) in pts_a:
                            for (x2, y2) in pts_b:
                                dx = x2 - x1
                                if dx > 180:
                                    dx -= 360
                                elif dx < -180:
                                    dx += 360
                                d2 = (dx * kx) ** 2 + (y2 - y1) ** 2
                                if d2 < lim2:
                                    found.append((d2, x1, y1, x1 + dx, y2))
                        if found:
                            cands[key].extend(found)
    best = {}
    for (a, b), pairs in cands.items():
        pairs.sort()
        allowed = (0, index[a], index[b])
        for d2, x1, y1, x2, y2 in pairs[:500]:
            d = math.sqrt(d2) * 111.2
            steps = max(4, int(d / 3))
            if all(mask.owner(x1 + (x2 - x1) * t / steps, y1 + (y2 - y1) * t / steps) in allowed
                   for t in range(1, steps)):
                best[(a, b)] = d
                break
    return best


def assign_colors(codes, graph, fixed=None):
    """DSatur graph colouring, balancing how often each colour is used.

    `fixed` holds nodes that already have a colour (they keep it)."""
    color, used = dict(fixed or {}), [0] * PALETTE_SIZE
    remaining = set(codes) - set(color)
    while remaining:
        def saturation(c):
            return len({color[n] for n in graph[c] if n in color})
        c = max(remaining, key=lambda c: (saturation(c), len(graph[c]), c))
        taken = {color[n] for n in graph[c] if n in color}
        free = [k for k in range(PALETTE_SIZE) if k not in taken] or list(range(PALETTE_SIZE))
        k = min(free, key=lambda k: (used[k], k))
        color[c] = k
        used[k] += 1
        remaining.remove(c)
    return color


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--report', action='store_true', help='print neighbour lists')
    args = ap.parse_args()

    feats = build_features(load_source())
    lines, land, coast = build_lines(feats)

    # Sea neighbours: coasts within SEA_NEIGHBOR_KM across open water, plus a
    # fallback for island countries that would otherwise have no neighbours.
    codes = sorted(c for c, f in feats.items() if f['kind'] != 'antarctica')
    index = {c: i + 1 for i, c in enumerate(sorted(feats))}
    mask = LandMask(feats, index)
    grid = coast_grid({c: coast[c] for c in codes if c in coast})
    skip = frozenset((a, b) for a in land for b in land[a] if a < b)
    dist = sea_neighbors(grid, mask, index, SEA_NEIGHBOR_KM, skip)
    for a, b in NOT_NEIGHBORS:
        dist.pop((a, b) if a < b else (b, a), None)
    sea = defaultdict(set)
    for a, b in list(dist) + EXTRA_SEA_NEIGHBORS:
        sea[a].add(b)
        sea[b].add(a)
    isolated = {c for c in codes if feats[c]['kind'] == 'country' and not land[c] and not sea[c]}
    far = sea_neighbors(grid, mask, index, ISLAND_FALLBACK_KM, skip, only=isolated)
    for c in sorted(isolated):
        near = sorted((d, b if a == c else a) for (a, b), d in far.items() if c in (a, b))
        for d, other in near[:3]:
            sea[c].add(other)
            sea[other].add(c)
    dist.update(far)

    graph = {c: land[c] | sea[c] for c in codes}
    colors = assign_colors(codes, graph)

    # Stable numeric ids: countries first (alphabetical by name), then the rest.
    order = sorted(feats.values(), key=lambda f: ({'country': 0, 'territory': 1, 'antarctica': 2}[f['kind']], f['name']))
    ids = {f['code']: i + 1 for i, f in enumerate(order)}

    meta, geo_countries = [], []
    for f in order:
        code = f['code']
        # Bounds for the camera: the main landmasses only, so revealing the
        # USA does not zoom out to fit Hawaii and the far Aleutians.
        areas = [polygon_area_km2(p) for p in f['polys']]
        main_parts = [p for p, a in zip(f['polys'], areas) if a >= 0.02 * f['area'] or a == max(areas)]
        intervals, south, north = [], 90.0, -90.0
        for poly in main_parts:
            w, s, e, n = ring_bbox(poly[0])
            intervals.append((w, e))
            south, north = min(south, s), max(north, n)
        west, east = lon_span(intervals)
        tier = 0
        if f['kind'] == 'country':
            tier = 1 if code in EASY else 2 if f['area'] >= MEDIUM_MIN_AREA_KM2 else 3
        m = {
            'id': ids[code], 'code': code, 'name': f['name'], 'iso2': f['iso2'],
            'kind': f['kind'], 'cont': f['cont'], 'tier': tier,
            'land': sorted(ids[n] for n in land[code]),
            'sea': sorted(ids[n] for n in sea[code]),
            'area': round(f['area']),
            'pop': f['pop'],
            'label': [round(f['label'][0], 3), round(f['label'][1], 3)],
            'bbox': [round(west, 3), round(south, 3), round(east, 3), round(north, 3)],
            'color': colors.get(code, -1),
        }
        if f['sov']:
            m['sov'] = ids[f['sov']]
        if f['kind'] == 'country' and f['area'] < DOT_MAX_AREA_KM2:
            # Zoom level until which the country is too small to tap: there a
            # dot marks it.  (Approx. zoom where it becomes ~18 px wide.)
            size_km = max(0.3, math.sqrt(f['area']))
            lat = math.radians(f['label'][1])
            m['dot'] = round(math.log2(18 * 40075 * math.cos(lat) / (512 * size_km)), 1)
        meta.append(m)
        geo_countries.append({'id': ids[code], 'polys': [[encode(r) for r in poly] for poly in f['polys']]})

    geo_lines = [{'a': ids[l['a']], 'b': ids[l['b']] if l['b'] else 0,
                  'lines': [encode(line) for line in l['lines']]} for l in lines]

    os.makedirs(OUT_DIR, exist_ok=True)
    world = {'q': Q, 'countries': geo_countries, 'lines': geo_lines}
    with open(os.path.join(OUT_DIR, 'world.json'), 'w', encoding='utf-8') as fh:
        json.dump(world, fh, separators=(',', ':'))
    with open(os.path.join(OUT_DIR, 'countries.json'), 'w', encoding='utf-8') as fh:
        json.dump({'source': 'Natural Earth 1:50m admin 0 countries (public domain)',
                   'countries': meta}, fh, ensure_ascii=False, separators=(',', ':'))

    quiz = [m for m in meta if m['kind'] == 'country']
    print('features: %d (quiz countries %d: easy %d, medium %d, hard %d)' % (
        len(meta), len(quiz), *[sum(1 for m in quiz if m['tier'] == t) for t in (1, 2, 3)]))
    print('dots:', len([m for m in meta if 'dot' in m]))
    print('colours used:', sorted(set(colors.values())))
    for name in ('world.json', 'countries.json'):
        print('%-15s %7.0f KB' % (name, os.path.getsize(os.path.join(OUT_DIR, name)) / 1024))

    if args.report:
        by_id = {m['id']: m for m in meta}
        for m in quiz:
            print('%-26s land: %s' % (m['name'], ', '.join(by_id[i]['name'] for i in m['land'])))
            if m['sea']:
                print('%-26s sea:  %s' % ('', ', '.join(
                    '%s (%.0f km)' % (by_id[i]['name'], dist.get(tuple(sorted((m['code'], by_id[i]['code']))), 0))
                    for i in m['sea'])))


if __name__ == '__main__':
    main()
