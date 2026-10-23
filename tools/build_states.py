#!/usr/bin/env python3
"""Build the US states for Country Quest's "US States" category.

Reads the Natural Earth 1:50m "admin 1 states and provinces (lakes)" GeoJSON
(public domain) and writes

  data/us-states.json  the 50 states and Washington, D.C.: quantized polygons,
                       their edges (borders between states, coasts), neighbours,
                       census region, difficulty tier, label point, bounds and
                       map colour

The cards' facts (capital, nickname, population, fun fact) are written by hand
in data/facts.json.  Uses the helpers of build_data.py and only the Python
standard library:

  python3 tools/build_states.py            # downloads the source on first run
  python3 tools/build_states.py --report   # also prints the neighbour lists
"""
import argparse
import json
import math
import os
import urllib.request
from collections import defaultdict

from build_data import (DOT_MAX_AREA_KM2, OUT_DIR, Q, ROOT, assign_colors, build_lines, encode, lon_span,
                        point_in_ring, polygon_area_km2, quantize_ring, ring_bbox)

NE_URL = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/'
          'master/geojson/ne_50m_admin_1_states_provinces_lakes.geojson')
NE_FILE = os.path.join(ROOT, '.cache', 'ne', 'ne_50m_admin_1_states_provinces_lakes.geojson')
FIRST_ID = 1001  # country ids stay below this

# Big or famous states that make up the "Easy" level.
EASY = set('US-' + s for s in 'AK AZ CA CO FL GA HI IL LA MI MT NM NV NY OK OR PA TX UT WA'.split())
MEDIUM_MIN_AREA_KM2 = 60000

# States that share a border out in the water (Lake Michigan, Lake Superior,
# Delaware Bay), where the map shows only water between them.
EXTRA_WATER_NEIGHBORS = [('US-MI', 'US-IL'), ('US-MI', 'US-MN'), ('US-DE', 'US-NJ')]

# Mexico's states are not in the source (Canada's provinces are, so the
# Canadian border is found from the geometry).  A state on the border must
# not get the same colour as the country next door.
MEXICO_BORDER = {'US-AZ', 'US-CA', 'US-NM', 'US-TX'}

NAMES = {'US-DC': 'Washington, D.C.'}


def load_source():
    if not os.path.exists(NE_FILE):
        os.makedirs(os.path.dirname(NE_FILE), exist_ok=True)
        print('downloading', NE_URL)
        urllib.request.urlretrieve(NE_URL, NE_FILE)
    with open(NE_FILE, encoding='utf-8') as f:
        return json.load(f)['features']


def polygons(geometry):
    raw = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    polys = []
    for poly in raw:
        rings = [quantize_ring(r) for r in poly]
        if rings[0] is not None:
            polys.append([rings[0]] + [r for r in rings[1:] if r])
    return polys


def inside(x, y, polys):
    """Is a (quantized) point inside one of the polygons, and not in a hole?"""
    return any(point_in_ring(x, y, p[0]) and not any(point_in_ring(x, y, h) for h in p[1:]) for p in polys)


def label_point(f):
    """Natural Earth's label point if it is on land; else the point of the
    biggest polygon farthest from its edges (on a coarse grid)."""
    x, y = round(f['label'][0] * Q), round(f['label'][1] * Q)
    if inside(x, y, f['polys']):
        return f['label']
    poly = max(f['polys'], key=polygon_area_km2)
    w, s, e, n = ring_bbox(poly[0])
    best, best_d = None, -1
    for i in range(1, 40):
        for j in range(1, 40):
            px, py = round((w + (e - w) * i / 40) * Q), round((s + (n - s) * j / 40) * Q)
            if not inside(px, py, [poly]):
                continue
            d = min(math.hypot(px - a[0], py - a[1]) for ring in poly for a in ring)
            if d > best_d:
                best, best_d = (px / Q, py / Q), d
    print('moved the label of %s onto land' % f['code'])
    return list(best)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--report', action='store_true', help='print neighbour lists')
    args = ap.parse_args()

    feats, provinces = {}, {}
    for f in load_source():
        p = f['properties']
        if p['adm0_a3'] == 'USA':
            code = p['iso_3166_2']
            feats[code] = {
                'code': code, 'postal': p['postal'], 'name': NAMES.get(code, p['name']),
                'kind': 'state' if p['type_en'] == 'State' else 'district',
                'cont': [p['region']], 'label': [p['longitude'], p['latitude']],
                'polys': polygons(f['geometry']),
            }
        elif p['adm0_a3'] == 'CAN':
            provinces[p['iso_3166_2']] = {'polys': polygons(f['geometry'])}
    assert sum(f['kind'] == 'state' for f in feats.values()) == 50, 'expected the 50 states'

    # Borders: between states (drawn on the map), and with Canada (for colours).
    lines, land, _ = build_lines({**feats, **provinces})
    codes = sorted(feats)
    on_canada = {c for c in codes if any(n in provinces for n in land[c])}
    land = {c: {n for n in land[c] if n in feats} for c in codes}
    water = defaultdict(set)
    for a, b in EXTRA_WATER_NEIGHBORS:
        water[a].add(b)
        water[b].add(a)

    # Colours: neighbouring states differ, and so do states and the country
    # across the border.
    with open(os.path.join(OUT_DIR, 'countries.json'), encoding='utf-8') as fh:
        country_color = {c['code']: c['color'] for c in json.load(fh)['countries']}
    graph = {c: land[c] | water[c] for c in codes}
    graph['CAN'], graph['MEX'] = set(on_canada), set(MEXICO_BORDER)
    for c in on_canada:
        graph[c].add('CAN')
    for c in MEXICO_BORDER:
        graph[c].add('MEX')
    colors = assign_colors(codes, graph, fixed={'CAN': country_color['CAN'], 'MEX': country_color['MEX']})

    ids = {c: FIRST_ID + i for i, c in enumerate(sorted(codes, key=lambda c: feats[c]['name']))}
    meta, geo = [], []
    for code in sorted(codes, key=ids.get):
        f = feats[code]
        f['area'] = sum(polygon_area_km2(p) for p in f['polys'])
        # Camera bounds from the main parts only (not the far Aleutians or the
        # tiny north-western Hawaiian islands).
        areas = [polygon_area_km2(p) for p in f['polys']]
        main_parts = [p for p, a in zip(f['polys'], areas) if a >= 0.02 * f['area'] or a == max(areas)]
        intervals, south, north = [], 90.0, -90.0
        for poly in main_parts:
            w, s, e, n = ring_bbox(poly[0])
            intervals.append((w, e))
            south, north = min(south, s), max(north, n)
        west, east = lon_span(intervals)
        label = label_point(f)
        m = {
            'id': ids[code], 'code': code, 'postal': f['postal'], 'name': f['name'], 'kind': f['kind'],
            'cont': f['cont'],
            'tier': 0 if f['kind'] != 'state' else 1 if code in EASY else 2 if f['area'] >= MEDIUM_MIN_AREA_KM2 else 3,
            'land': sorted(ids[n] for n in land[code]),
            'sea': sorted(ids[n] for n in water[code]),
            'area': round(f['area']),
            'pop': 0,  # from data/facts.json
            'label': [round(label[0], 3), round(label[1], 3)],
            'bbox': [round(west, 3), round(south, 3), round(east, 3), round(north, 3)],
            'color': colors[code],
        }
        if f['area'] < DOT_MAX_AREA_KM2:
            # Too small to tap until this zoom (about 18 px wide), so a dot marks it.
            size_km = max(0.3, math.sqrt(f['area']))
            m['dot'] = round(math.log2(18 * 40075 * math.cos(math.radians(label[1])) / (512 * size_km)), 1)
        meta.append(m)
        geo.append({'id': ids[code], 'polys': [[encode(r) for r in poly] for poly in f['polys']]})

    # Every edge of every state, for outlining a state: borders between two
    # states, and (with b = 0) coasts and borders with Canada and Mexico,
    # which the country map already draws.
    geo_lines = []
    for l in lines:
        a, b = (l['a'], l['b']) if l['a'] in feats else (l['b'], l['a'])
        if a in feats:
            geo_lines.append({'a': ids[a], 'b': ids.get(b, 0), 'lines': [encode(line) for line in l['lines']]})

    out = os.path.join(OUT_DIR, 'us-states.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'source': 'Natural Earth 1:50m admin 1 states and provinces (public domain)', 'q': Q,
                   'states': meta, 'polys': geo, 'lines': geo_lines}, fh, ensure_ascii=False, separators=(',', ':'))

    states = [m for m in meta if m['kind'] == 'state']
    print('states: %d (easy %d, medium %d, hard %d), dots: %s' % (
        len(states), *[sum(1 for m in states if m['tier'] == t) for t in (1, 2, 3)],
        ', '.join(m['postal'] for m in meta if 'dot' in m)))
    print('on the Canadian border:', ' '.join(sorted(feats[c]['postal'] for c in on_canada)))
    print('colours used:', sorted(set(colors[c] for c in codes)))
    print('%-15s %7.0f KB' % ('us-states.json', os.path.getsize(out) / 1024))
    if args.report:
        by_id = {m['id']: m for m in meta}
        for m in meta:
            print('%-22s %-10s land: %s%s' % (m['name'], m['cont'][0], ' '.join(by_id[i]['postal'] for i in m['land']),
                                              '  water: ' + ' '.join(by_id[i]['postal'] for i in m['sea']) if m['sea'] else ''))


if __name__ == '__main__':
    main()
