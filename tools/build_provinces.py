#!/usr/bin/env python3
"""Build the provinces, states, regions and districts of a few countries, for
the Start menu's second page.

Reads Natural Earth's 1:10m "admin 1 states and provinces (lakes)" GeoJSON
(public domain) and, for Bangladesh's 64 districts, geoBoundaries' districts of
Bangladesh (from the Bangladesh Bureau of Statistics and OCHA ROAP, CC BY 3.0
IGO).  Writes

  data/provinces.json  the places inside China, India, Canada, France, the
                       United Kingdom, Germany, Australia and Bangladesh:
                       quantized polygons, their edges, neighbours, region,
                       label point, bounds and map colour

Each country's places are fitted to the country's own shape in
data/world.json (bits of the country that no place covers go to the place
next to them), so their coasts and borders match the world map exactly.  Run
it after tools/build_data.py.

mapshaper (run with npx, so Node.js is needed) merges the source shapes and
simplifies them, keeping shared borders shared.  The rest uses the helpers of
build_data.py and the Python standard library:

  python3 tools/build_provinces.py            # downloads the sources on first run
  python3 tools/build_provinces.py --report   # also prints the neighbour lists
"""
import argparse
import json
import math
import os
import subprocess
import urllib.request
from collections import defaultdict

from build_data import (OUT_DIR, Q, ROOT, assign_colors, build_lines, dissolve, encode,
                        lon_span, point_in_ring, polygon_area_km2, quantize_ring, ring_bbox)

NE_URL = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/'
          'master/geojson/ne_10m_admin_1_states_provinces_lakes.geojson')
NE_FILE = os.path.join(ROOT, '.cache', 'ne', 'ne_10m_admin_1_states_provinces_lakes.geojson')
GB_URL = ('https://github.com/wmgeolab/geoBoundaries/raw/9469f09/'
          'releaseData/gbOpen/BGD/ADM2/geoBoundaries-BGD-ADM2.geojson')
GB_FILE = os.path.join(ROOT, '.cache', 'gb', 'geoBoundaries-BGD-ADM2.geojson')
WORK = os.path.join(ROOT, '.cache', 'provinces')
MAPSHAPER = ['npx', '-y', 'mapshaper@0.7.97']
FIRST_ID = 2001  # countries stay below 1001, US states below 2001
# A place gets a dot when it is too small to tap in its country's view on a
# phone: under about 12 px across in a map about 300 x 550 px.  (Countries and
# US states use an area instead, DOT_MAX_AREA_KM2.)
PHONE_MAP = (300, 550)
DOT_MAX_PX = 12

# The countries, in the Start menu's order, and how much their borders are
# simplified: about the detail of the world map at the zoom they are shown.
COUNTRIES = {'CHN': '2000m', 'IND': '2000m', 'CAN': '2000m', 'FRA': '1500m',
             'GBR': '1500m', 'DEU': '1500m', 'AUS': '2000m', 'BGD': '700m'}

# --- Which source shapes make up each place ---------------------------------

FRANCE = {  # Natural Earth's region of each département -> the region
    'Auvergne-Rhône-Alpes': ('FR-ARA', 'Auvergne-Rhône-Alpes'),
    'Bourgogne-Franche-Comté': ('FR-BFC', 'Bourgogne-Franche-Comté'),
    'Bretagne': ('FR-BRE', 'Brittany'),
    'Centre-Val de Loire': ('FR-CVL', 'Centre-Val de Loire'),
    'Corse': ('FR-20R', 'Corsica'),
    'Grand Est': ('FR-GES', 'Grand Est'),
    'Hauts-de-France': ('FR-HDF', 'Hauts-de-France'),
    'Île-de-France': ('FR-IDF', 'Île-de-France'),
    'Normandie': ('FR-NOR', 'Normandy'),
    'Nouvelle-Aquitaine': ('FR-NAQ', 'Nouvelle-Aquitaine'),
    'Occitanie': ('FR-OCC', 'Occitania'),
    'Pays de la Loire': ('FR-PDL', 'Pays de la Loire'),
    "Provence-Alpes-Côte-d'Azur": ('FR-PAC', "Provence-Alpes-Côte d'Azur"),
}
ENGLAND = {  # Natural Earth's region of each English council -> the region
    'North East': ('GB-NEE', 'North East England'),
    'North West': ('GB-NWE', 'North West England'),
    'Yorkshire and the Humber': ('GB-YHU', 'Yorkshire and the Humber'),
    'East Midlands': ('GB-EMI', 'East Midlands'),
    'West Midlands': ('GB-WMI', 'West Midlands'),
    'East': ('GB-EOE', 'East of England'),
    'Greater London': ('GB-LON', 'London'),
    'South East': ('GB-SEE', 'South East England'),
    'South West': ('GB-SWE', 'South West England'),
}
UK_NATIONS = {'Scotland': 'GB-SCT', 'Wales': 'GB-WLS', 'Northern Ireland': 'GB-NIR'}

# Bangladesh's 64 districts: ISO 3166-2 code -> name (as the government spells
# it since 2018: Bogura, Barishal, Cumilla, Chattogram, Jashore), division
# (see DIVISIONS), people in the 2022 census (from Wikipedia's "Districts of
# Bangladesh") and the name in geoBoundaries.
BANGLADESH = {
    'BD-01': ('Bandarban', 'B', 481109, 'Bandarban'),
    'BD-02': ('Barguna', 'A', 1010530, 'Barguna'),
    'BD-03': ('Bogura', 'E', 3734300, 'Bogra'),
    'BD-04': ('Brahmanbaria', 'B', 3306559, 'Brahamanbaria'),
    'BD-05': ('Bagerhat', 'D', 1613079, 'Bagerhat'),
    'BD-06': ('Barishal', 'A', 2570450, 'Barisal'),
    'BD-07': ('Bhola', 'A', 1932514, 'Bhola'),
    'BD-08': ('Cumilla', 'B', 6212216, 'Comilla'),
    'BD-09': ('Chandpur', 'B', 2635748, 'Chandpur'),
    'BD-10': ('Chattogram', 'B', 9169464, 'Chittagong'),
    'BD-11': ("Cox's Bazar", 'B', 2823265, "Cox's Bazar"),
    'BD-12': ('Chuadanga', 'D', 1234066, 'Chuadanga'),
    'BD-13': ('Dhaka', 'C', 14734701, 'Dhaka'),
    'BD-14': ('Dinajpur', 'F', 3315238, 'Dinajpur'),
    'BD-15': ('Faridpur', 'C', 2162876, 'Faridpur'),
    'BD-16': ('Feni', 'B', 1648896, 'Feni'),
    'BD-17': ('Gopalganj', 'C', 1295053, 'Gopalganj'),
    'BD-18': ('Gazipur', 'C', 5263474, 'Gazipur'),
    'BD-19': ('Gaibandha', 'F', 2562232, 'Gaibandha'),
    'BD-20': ('Habiganj', 'G', 2358886, 'Habiganj'),
    'BD-21': ('Jamalpur', 'H', 2499737, 'Jamalpur'),
    'BD-22': ('Jashore', 'D', 3076849, 'Jessore'),
    'BD-23': ('Jhenaidah', 'D', 1771304, 'Jhenaidah'),
    'BD-24': ('Joypurhat', 'E', 956430, 'Joypurhat'),
    'BD-25': ('Jhalokati', 'A', 661161, 'Jhalokati'),
    'BD-26': ('Kishoreganj', 'C', 3267630, 'Kishoreganj'),
    'BD-27': ('Khulna', 'D', 2613385, 'Khulna'),
    'BD-28': ('Kurigram', 'F', 2329161, 'Kurigram'),
    'BD-29': ('Khagrachhari', 'B', 714119, 'Khagrachhari'),
    'BD-30': ('Kushtia', 'D', 2149692, 'Kushtia'),
    'BD-31': ('Lakshmipur', 'B', 1938111, 'Lakshmipur'),
    'BD-32': ('Lalmonirhat', 'F', 1428406, 'Lalmonirhat'),
    'BD-33': ('Manikganj', 'C', 1558024, 'Manikganj'),
    'BD-34': ('Mymensingh', 'H', 5899052, 'Mymensingh'),
    'BD-35': ('Munshiganj', 'C', 1625418, 'Munshiganj'),
    'BD-36': ('Madaripur', 'C', 1293027, 'Madaripur'),
    'BD-37': ('Magura', 'D', 1033115, 'Magura'),
    'BD-38': ('Moulvibazar', 'G', 2123445, 'Maulvibazar'),
    'BD-39': ('Meherpur', 'D', 705356, 'Meherpur'),
    'BD-40': ('Narayanganj', 'C', 3909138, 'Narayanganj'),
    'BD-41': ('Netrokona', 'H', 2324856, 'Netrakona'),
    'BD-42': ('Narsingdi', 'C', 2584452, 'Narsingdi'),
    'BD-43': ('Narail', 'D', 788673, 'Narail'),
    'BD-44': ('Natore', 'E', 1859921, 'Natore'),
    'BD-45': ('Chapai Nawabganj', 'E', 1835527, 'Nawabganj'),
    'BD-46': ('Nilphamari', 'F', 3092567, 'Nilphamari'),
    'BD-47': ('Noakhali', 'B', 3625252, 'Noakhali'),
    'BD-48': ('Naogaon', 'E', 2784598, 'Naogaon'),
    'BD-49': ('Pabna', 'E', 2909622, 'Pabna'),
    'BD-50': ('Pirojpur', 'A', 1198193, 'Pirojpur'),
    'BD-51': ('Patuakhali', 'A', 1727254, 'Patuakhali'),
    'BD-52': ('Panchagarh', 'F', 1179843, 'Panchagarh'),
    'BD-53': ('Rajbari', 'C', 1189821, 'Rajbari'),
    'BD-54': ('Rajshahi', 'E', 2915013, 'Rajshahi'),
    'BD-55': ('Rangpur', 'F', 3169615, 'Rangpur'),
    'BD-56': ('Rangamati', 'B', 647587, 'Rangamati'),
    'BD-57': ('Sherpur', 'H', 1501853, 'Sherpur'),
    'BD-58': ('Satkhira', 'D', 2196581, 'Satkhira'),
    'BD-59': ('Sirajganj', 'E', 3357708, 'Sirajganj'),
    'BD-60': ('Sylhet', 'G', 3857037, 'Sylhet'),
    'BD-61': ('Sunamganj', 'G', 2695495, 'Sunamganj'),
    'BD-62': ('Shariatpur', 'C', 1294561, 'Shariatpur'),
    'BD-63': ('Tangail', 'C', 4037608, 'Tangail'),
    'BD-64': ('Thakurgaon', 'F', 1533894, 'Thakurgaon'),
}
DIVISIONS = {'A': 'Barishal', 'B': 'Chattogram', 'C': 'Dhaka', 'D': 'Khulna',
             'E': 'Rajshahi', 'F': 'Rangpur', 'G': 'Sylhet', 'H': 'Mymensingh'}


def group_key(p):
    """The place a Natural Earth shape belongs to, or None to leave it out
    (it then goes to the place next to it, see settle())."""
    country, code = p['adm0_a3'], p['iso_3166_2']
    if country == 'HKG':
        return 'CHN', 'CN-HK'
    if country == 'MAC':
        return 'CHN', 'CN-MO'
    if country == 'CHN':
        return ('CHN', code) if p['type_en'] else None  # not the Paracel Islands
    if country == 'FRA':
        return ('FRA', FRANCE[p['region']][0]) if p['type_en'] == 'Metropolitan department' else None
    if country == 'GBR':
        nation = p['geonunit']
        return 'GBR', ENGLAND[p['region']][0] if nation == 'England' else UK_NATIONS[nation]
    if country == 'AUS':
        # Lord Howe Island is part of New South Wales already; Macquarie Island
        # belongs to Tasmania.  Jervis Bay is left to New South Wales.
        return ('AUS', 'AU-TAS') if code == 'AU-X03~' else None if code == 'AU-X02~' else ('AUS', code)
    if country in ('IND', 'CAN', 'DEU'):
        return country, code
    return None  # (Bangladesh comes from geoBoundaries)


# --- What each place is called ----------------------------------------------

NAMES = {
    'CN-NM': 'Inner Mongolia', 'CN-XZ': 'Tibet', 'CN-HK': 'Hong Kong', 'CN-MO': 'Macau',
    'IN-AN': 'Andaman and Nicobar Islands',
    'CA-QC': 'Quebec',
    'AU-NSW': 'New South Wales', 'AU-TAS': 'Tasmania',  # (Lord Howe and Macquarie Islands share their codes)
    'DE-BY': 'Bavaria', 'DE-HE': 'Hesse', 'DE-NI': 'Lower Saxony', 'DE-NW': 'North Rhine-Westphalia',
    'DE-RP': 'Rhineland-Palatinate', 'DE-SN': 'Saxony', 'DE-ST': 'Saxony-Anhalt', 'DE-TH': 'Thuringia',
    'GB-SCT': 'Scotland', 'GB-WLS': 'Wales', 'GB-NIR': 'Northern Ireland',
    **{code: name for code, name in FRANCE.values()},
    **{code: name for code, name in ENGLAND.values()},
    **{code: d[0] for code, d in BANGLADESH.items()},
}

# Its page on the English Wikipedia, where that is not the name (for
# Bangladesh: not the name and "District").
WIKI = {
    'CN-XZ': 'Tibet Autonomous Region',
    'IN-PB': 'Punjab, India', 'IN-JK': 'Jammu and Kashmir (union territory)',
    'IN-PY': 'Puducherry (union territory)',
    'AU-VIC': 'Victoria (state)',
    'DE-HB': 'Bremen (state)',
    'FR-BRE': 'Brittany (administrative region)', 'FR-OCC': 'Occitania (administrative region)',
    'GB-WMI': 'West Midlands (region)',
    'BD-03': 'Bogra District', 'BD-06': 'Barisal District', 'BD-08': 'Comilla District',
    'BD-10': 'Chittagong District', 'BD-14': 'Dinajpur District, Bangladesh',
    'BD-17': 'Gopalganj District, Bangladesh', 'BD-22': 'Jessore District', 'BD-25': 'Jhalokathi District',
}


def wiki_title(code, name):
    if code in WIKI:
        return WIKI[code]
    return name + ' District' if code.startswith('BD-') else None


COUNTRY_NAMES = {'CHN': 'China', 'IND': 'India', 'CAN': 'Canada', 'FRA': 'France',
                 'GBR': 'the United Kingdom', 'DEU': 'Germany', 'AUS': 'Australia', 'BGD': 'Bangladesh'}


def about(country, code, ne_type):
    """What the place is, for its card: "A province of China"."""
    of = COUNTRY_NAMES[country]
    if country == 'CHN':
        if code in ('CN-HK', 'CN-MO'):
            return 'A special administrative region of China'
        return {'Province': 'A province of China', 'Autonomous Region': 'An autonomous region of China',
                'Municipality': 'A province-level city of China'}[ne_type]
    if country == 'IND':
        # Natural Earth calls Himachal Pradesh a union territory, and Gujarat nothing.
        ut = ne_type == 'Union Territory' and code != 'IN-HP'
        return 'A union territory of India' if ut else 'A state of India'
    if country in ('CAN', 'AUS'):
        if code in ('CA-YT', 'CA-NT', 'CA-NU', 'AU-ACT', 'AU-NT'):
            return 'A territory of ' + of
        return ('A province of ' if country == 'CAN' else 'A state of ') + of
    if country == 'GBR':
        if code == 'GB-NIR':
            return 'A part of the United Kingdom'
        return 'A country of the United Kingdom' if code in ('GB-SCT', 'GB-WLS') else 'A region of England'
    if country == 'BGD':
        return 'A district in %s Division' % DIVISIONS[BANGLADESH[code][1]]
    return {'FRA': 'A region of France', 'DEU': 'A state of Germany'}[country]


# India's zonal councils (Natural Earth's regions for India have gaps).  The
# island territories sit with the Southern council.
INDIA_ZONES = {
    'North India': 'CH DL HR HP JK LA PB RJ',
    'Central India': 'CT MP UT UP',
    'East India': 'BR JH OR WB',
    'West India': 'DH GA GJ MH',
    'South India': 'AN AP KA KL LD PY TN TG',
    'Northeast India': 'AR AS MN ML MZ NL SK TR',
}


def region(country, code, ne_region):
    """The part of the country a place is in, for scoring ("It's in East China
    too"); empty where the country has no such parts."""
    if country == 'CHN':
        if code in ('CN-HK', 'CN-MO'):
            return ['South Central China']
        return ['East China'] if code == 'CN-FJ' else [ne_region]
    if country == 'IND':
        return [next(name for name, codes in INDIA_ZONES.items() if code[3:] in codes.split())]
    if country == 'CAN':
        return [ne_region]
    if country == 'GBR' and code not in UK_NATIONS.values():
        return ['England']
    if country == 'BGD':
        return [DIVISIONS[BANGLADESH[code][1]] + ' Division']
    return []


# Places that share a border out in the water, where the map shows only sea
# between them.
EXTRA_WATER_NEIGHBORS = [
    ('CN-HI', 'CN-GD'), ('CN-SD', 'CN-LN'), ('CN-HK', 'CN-MO'),
    ('CA-PE', 'CA-NB'), ('CA-PE', 'CA-NS'), ('CA-NL', 'CA-NS'), ('CA-NU', 'CA-QC'), ('CA-NU', 'CA-ON'),
    ('FR-20R', 'FR-PAC'),
    ('GB-NIR', 'GB-SCT'),
    ('AU-TAS', 'AU-VIC'),
]
# Places that keep their own shape (see settle()) share no edges with the
# places around them, so their land borders are listed here.
EXTRA_LAND_NEIGHBORS = [('CN-MO', 'CN-GD')]


# --- Sources ----------------------------------------------------------------

def download(url, path):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print('downloading', url)
        urllib.request.urlretrieve(url, path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)['features']


def decode(flat):
    out, x, y = [], 0, 0
    for i in range(0, len(flat), 2):
        x += flat[i]
        y += flat[i + 1]
        out.append((x, y))
    return out


def feature(geometry, **props):
    return {'type': 'Feature', 'properties': props, 'geometry': geometry}


def write_geojson(path, features):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f)


def read_polys(geometry):
    """A GeoJSON (multi)polygon as quantized polygons."""
    if not geometry:
        return []
    raw = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    polys = []
    for poly in raw:
        rings = [quantize_ring(r) for r in poly]
        if rings[0] is not None:
            polys.append([rings[0]] + [r for r in rings[1:] if r])
    return polys


# --- Fitting the places to the world map ----------------------------------------

def fit(country, raw, parent, interval):
    """Merge and simplify a country's source shapes, then cut them to the
    country's shape on the world map.  Returns (fitted, simplified): each a
    dict code -> quantized polygons; `fitted` also has '' for the bits of the
    country that no place covers."""
    os.makedirs(WORK, exist_ok=True)
    path = lambda name: os.path.join(WORK, '%s-%s.geojson' % (country, name))
    write_geojson(path('raw'), raw)
    write_geojson(path('parent'), [feature(parent)])
    subprocess.run([
        *MAPSHAPER,
        '-i', path('raw'), 'name=places',
        '-dissolve', 'key',
        '-simplify', 'interval=' + interval, 'keep-shapes',
        '-o', path('simplified'), 'precision=0.001',
        '-i', path('parent'), 'name=parent',
        '-clip', 'target=places', 'source=parent',
        # The places, and under them the country: what is left of the
        # country is the bits that no place covers.
        '-merge-layers', 'target=parent,places', 'flatten', 'force', 'name=fitted',
        '-explode',
        '-clean',
        '-o', path('fitted'), 'precision=0.001',
        '-quiet',
    ], check=True)

    def load(name):
        out = defaultdict(list)
        with open(path(name), encoding='utf-8') as f:
            for feat in json.load(f)['features']:
                out[(feat['properties'] or {}).get('key') or ''].extend(read_polys(feat['geometry']))
        return out
    return load('fitted'), load('simplified')


def edges_of(polys):
    for poly in polys:
        for ring in poly:
            for i in range(len(ring) - 1):
                a, b = ring[i], ring[i + 1]
                yield (a, b) if a < b else (b, a)


def settle(fitted, simplified, codes):
    """Give each leftover bit of the country to the place it shares the longest
    border with (an island: the nearest place), and let places the world map
    hardly draws (Macau, Lakshadweep) keep their own shape."""
    places = {c: list(fitted.get(c, [])) for c in codes}
    for c in codes:
        full = sum(polygon_area_km2(p) for p in simplified[c])
        kept = sum(polygon_area_km2(p) for p in places[c])
        if kept < 0.5 * full:
            print('  %s: the world map hardly draws it (%.0f of %.0f km²), so it keeps its own shape' % (c, kept, full))
            places[c] = simplified[c]
    edge_owner = defaultdict(set)
    vertices = defaultdict(list)
    for c in codes:
        for seg in edges_of(places[c]):
            edge_owner[seg].add(c)
        for poly in places[c]:
            for (x, y) in poly[0][::4]:
                vertices[(x // 500, y // 500)].append((x, y, c))
    for bit in fitted.get('', []):
        shared = defaultdict(float)
        for seg in edges_of([bit]):
            for c in edge_owner.get(seg, ()):
                (x1, y1), (x2, y2) = seg
                shared[c] += math.hypot(x2 - x1, y2 - y1)
        if shared:
            owner = max(shared, key=shared.get)
        else:
            # An island: the place with the nearest shore.
            x, y = bit[0][0]
            best = None
            for r in range(40):
                for gx in range(x // 500 - r, x // 500 + r + 1):
                    for gy in range(y // 500 - r, y // 500 + r + 1):
                        for vx, vy, c in vertices.get((gx, gy), ()):
                            d = math.hypot(vx - x, vy - y)
                            if best is None or d < best[0]:
                                best = (d, c)
                if best:
                    break
            if not best:
                continue
            owner = best[1]
        places[owner].append(bit)
    return {c: dissolve(polys) for c, polys in places.items()}


def phone_zoom(boxes):
    """The zoom that fits these [west, south, east, north] boxes on a phone."""
    west, east = lon_span([(b[0], b[2]) for b in boxes])
    south, north = min(b[1] for b in boxes), max(b[3] for b in boxes)
    y = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(max(-85, min(85, lat))) / 2))
    zx = math.log2(PHONE_MAP[0] / 512 * 360 / (east - west))
    zy = math.log2(PHONE_MAP[1] / 512 * 2 * math.pi / (y(north) - y(south)))
    return min(zx, zy) - 0.1


# --- Labels -------------------------------------------------------------------

def label_point(polys):
    """A point well inside the biggest polygon: the one farthest from its
    edges, on a coarse grid and then a finer one around the best cell."""
    poly = max(polys, key=polygon_area_km2)
    edge = [p for ring in poly for p in ring[::max(1, sum(len(r) for r in poly) // 300)]]

    def inside(x, y):
        return point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:])

    def score(x, y):
        return min((x - a) ** 2 + (y - b) ** 2 for a, b in edge) if inside(x, y) else -1

    w, s, e, n = (v * Q for v in ring_bbox(poly[0]))
    best = (-1, (w + e) / 2, (s + n) / 2)
    for i in range(1, 16):
        for j in range(1, 16):
            x, y = w + (e - w) * i / 16, s + (n - s) * j / 16
            best = max(best, (score(x, y), x, y))
    _, cx, cy = best
    dx, dy = (e - w) / 16, (n - s) / 16
    for i in range(-4, 5):
        for j in range(-4, 5):
            x, y = cx + dx * i / 4, cy + dy * j / 4
            best = max(best, (score(x, y), x, y))
    return [round(best[1] / Q, 3), round(best[2] / Q, 3)]


# --- Build --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--report', action='store_true', help='print neighbour lists')
    args = ap.parse_args()

    with open(os.path.join(OUT_DIR, 'world.json'), encoding='utf-8') as f:
        world = json.load(f)
    with open(os.path.join(OUT_DIR, 'countries.json'), encoding='utf-8') as f:
        countries = {c['code']: c for c in json.load(f)['countries']}
    assert world['q'] == Q
    shapes = {c['id']: [[decode(r) for r in p] for p in c['polys']] for c in world['countries']}
    code_of = {c['id']: code for code, c in countries.items()}

    raw, info = defaultdict(list), {}
    for f in download(NE_URL, NE_FILE):
        p = f['properties']
        key = group_key(p)
        if not key:
            continue
        country, code = key
        raw[country].append(feature(f['geometry'], key=code))
        if code not in info or p['adm0_a3'] == country:
            info[code] = {'type': p['type_en'], 'region': p['region'], 'name': p['name']}
    by_gb_name = {d[3]: code for code, d in BANGLADESH.items()}
    for f in download(GB_URL, GB_FILE):
        code = by_gb_name[f['properties']['shapeName']]
        raw['BGD'].append(feature(f['geometry'], key=code))
        info[code] = {'type': 'District', 'region': None, 'name': BANGLADESH[code][0]}
    assert sum(1 for c in info if c.startswith('BD-')) == 64, 'expected the 64 districts of Bangladesh'

    meta, geo, geo_lines = [], [], []
    ids = {}
    for country, interval in COUNTRIES.items():
        codes = sorted({f['properties']['key'] for f in raw[country]})
        print('%s: %d places' % (country, len(codes)))
        parent = countries[country]
        outline = {'type': 'MultiPolygon',
                   'coordinates': [[[[x / Q, y / Q] for x, y in r] for r in p] for p in shapes[parent['id']]]}
        fitted, simplified = fit(country, raw[country], outline, interval)
        polys = settle(fitted, simplified, codes)

        # Neighbours: shared borders, and the few across the water.
        feats = {c: {'polys': polys[c]} for c in codes}
        lines, land, _ = build_lines(feats)
        for a, b in EXTRA_LAND_NEIGHBORS:
            if a in feats and b in feats:
                land[a].add(b)
                land[b].add(a)
        water = defaultdict(set)
        for a, b in EXTRA_WATER_NEIGHBORS:
            if a in feats and b in feats and b not in land[a]:
                water[a].add(b)
                water[b].add(a)
        # Colours: neighbours differ, and so do places and the country across
        # the border (whose border points are the same as theirs).
        graph = {c: set(land[c]) | water[c] for c in codes}
        fixed = {}
        for nid in parent['land']:
            ncode = code_of[nid]
            border = {pt for p in shapes[nid] for r in p for pt in r}
            touching = {c for c in codes if any(pt in border for p in polys[c] for pt in p[0])}
            if touching:
                fixed[ncode] = countries[ncode]['color']
                graph[ncode] = touching
                for c in touching:
                    graph[c].add(ncode)
        colors = assign_colors(codes, graph, fixed=fixed)
        clashes = [(c, n) for c in codes for n in graph[c] if colors[n] == colors[c] and (n not in codes or c < n)]
        if clashes:
            print('  colour clashes:', clashes)

        country_meta = []
        for code in codes:
            ps = polys[code]
            area = sum(polygon_area_km2(p) for p in ps)
            areas = [polygon_area_km2(p) for p in ps]
            # Camera bounds from the main parts only.
            main_parts = [p for p, a in zip(ps, areas) if a >= 0.02 * area or a == max(areas)]
            intervals, south, north = [], 90.0, -90.0
            for poly in main_parts:
                w, s, e, n = ring_bbox(poly[0])
                intervals.append((w, e))
                south, north = min(south, s), max(north, n)
            west, east = lon_span(intervals)
            label = label_point(ps)
            name = NAMES.get(code) or info[code]['name']
            m = {
                'code': code, 'name': name, 'kind': 'province', 'country': country,
                'about': about(country, code, info[code]['type']),
                'cont': region(country, code, info[code]['region']),
                'tier': 0,
                'area': round(area),
                'pop': BANGLADESH[code][2] if country == 'BGD' else 0,
                'label': label,
                'bbox': [round(west, 3), round(south, 3), round(east, 3), round(north, 3)],
                'color': colors[code],
            }
            # Too small to tap until this zoom (about 18 px wide); see below for its dot.
            size_km = max(0.3, math.sqrt(area))
            m['dz'] = math.log2(18 * 40075 * math.cos(math.radians(label[1])) / (512 * size_km))
            if wiki_title(code, name):
                m['wiki'] = wiki_title(code, name)
            country_meta.append(m)
        # Dots for the places too small to tap in the country's view on a phone.
        home = phone_zoom([m['bbox'] for m in country_meta])
        for m in country_meta:
            dz = m.pop('dz')
            if dz > home + math.log2(18 / DOT_MAX_PX):
                m['dot'] = round(dz, 1)
        # Ids follow the countries' order, then the names.
        country_meta.sort(key=lambda m: m['name'])
        first = FIRST_ID + len(meta)
        for i, m in enumerate(country_meta):
            ids[m['code']] = first + i
        for m in country_meta:
            code = m['code']
            m['id'] = ids[code]
            m['land'] = sorted(ids[n] for n in land[code])
            m['sea'] = sorted(ids[n] for n in water[code])
            meta.append(m)
            geo.append({'id': ids[code], 'polys': [[encode(r) for r in poly] for poly in polys[code]]})
        # Every edge of every place: borders between two places, and (with
        # b = 0) coasts and borders with other countries, which the country
        # map already draws.
        for l in lines:
            geo_lines.append({'a': ids[l['a']], 'b': ids[l['b']] if l['b'] else 0,
                              'lines': [encode(line) for line in l['lines']]})
        if args.report:
            by_code = {m['code']: m for m in country_meta}
            for m in country_meta:
                print('  %-28s %-20s land: %s%s' % (
                    m['name'], (m['cont'] or [''])[0],
                    ', '.join(by_code[n]['name'] for n in sorted(land[m['code']])),
                    '  water: ' + ', '.join(by_code[n]['name'] for n in sorted(water[m['code']])) if water[m['code']] else ''))

    out = os.path.join(OUT_DIR, 'provinces.json')
    keys = ['id', 'code', 'name', 'kind', 'country', 'about', 'cont', 'tier', 'land', 'sea', 'area', 'pop',
            'label', 'bbox', 'color', 'dot', 'wiki']
    places = [{k: m[k] for k in keys if k in m} for m in meta]
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'source': 'Natural Earth 1:10m admin 1 states and provinces (public domain); the districts of '
                             'Bangladesh: Bangladesh Bureau of Statistics and OCHA ROAP, via geoBoundaries '
                             '(CC BY 3.0 IGO). Fitted to the countries in world.json.',
                   'q': Q, 'provinces': places, 'polys': geo, 'lines': geo_lines},
                  fh, ensure_ascii=False, separators=(',', ':'))
    for country in COUNTRIES:
        ps = [m for m in meta if m['country'] == country]
        print('%s: %d places, dots: %s' % (country, len(ps), ', '.join(m['name'] for m in ps if 'dot' in m) or '-'))
    print('%-15s %7.0f KB' % ('provinces.json', os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
