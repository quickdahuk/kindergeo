#!/usr/bin/env python3
"""Build the version of Country Quest that is published as a Claude artifact.

The artifact host wraps the page in its own <html>/<head>/<body>, allows
scripts only from a few CDNs and stylesheets only from Google Fonts.  So this
version loads MapLibre from jsDelivr and Fredoka from Google Fonts, inlines the
CSS (with the few MapLibre rules the game needs) and writes the page without
the outer tags.  Game code and data are copied unchanged otherwise.

  python3 tools/build_artifact.py        # writes .cache/artifact/
"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '.cache', 'artifact')

MAPLIBRE_LOCAL = '../vendor/maplibre-gl/maplibre-gl.mjs'
MAPLIBRE_CDN = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.mjs'
FONT_CSS = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&display=swap'

# The parts of maplibre-gl.css this game relies on (its stylesheet cannot be
# linked from the artifact): canvas and marker placement, and handing all
# touch gestures to the map so a pinch zooms the map rather than the page.
# Like the real stylesheet, these come before the game's own CSS.
MAP_CSS = """
.maplibregl-map { position: relative; overflow: hidden; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
.maplibregl-canvas { position: absolute; left: 0; top: 0; }
.maplibregl-canvas-container.maplibregl-interactive { cursor: grab; -webkit-user-select: none; user-select: none; }
.maplibregl-canvas-container.maplibregl-interactive:active { cursor: grabbing; }
.maplibregl-canvas-container.maplibregl-touch-drag-pan.maplibregl-touch-zoom-rotate,
.maplibregl-canvas-container.maplibregl-touch-drag-pan.maplibregl-touch-zoom-rotate .maplibregl-canvas { touch-action: none; }
.maplibregl-marker { position: absolute; top: 0; left: 0; will-change: transform; transition: opacity 0.2s; }
.maplibregl-boxzoom { position: absolute; top: 0; left: 0; width: 0; height: 0; background: #fff; border: 2px dotted #202020; opacity: 0.5; }
"""

# The game has one deliberate look in every theme: a dark sky with light cards.
THEME_CSS = """
:root { color-scheme: dark; }
.card, .panel, .quest, .toast { color-scheme: light; }
"""


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


def write(path, text):
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    html = read('index.html')
    title = re.search(r'<title>(.*?)</title>', html).group(1)
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1).strip()
    # The font comes from Google Fonts here, so drop the local @font-face.
    css = re.sub(r'@font-face\s*\{[^}]*\}\s*', '', read('css/style.css'), count=1)
    write('index.html', '\n'.join([
        '<title>%s</title>' % title,
        '<link rel="stylesheet" href="%s">' % FONT_CSS,
        '<style>',
        MAP_CSS.strip(),
        css.strip(),
        THEME_CSS.strip(),
        '</style>',
        body,
        '<script type="module" src="js/main.js"></script>',
        '',
    ]))

    for name in sorted(os.listdir(os.path.join(ROOT, 'js'))):
        if name.endswith('.js'):
            write('js/' + name, read('js/' + name).replace(MAPLIBRE_LOCAL, MAPLIBRE_CDN))
    for name in ('world.json', 'countries.json', 'facts.json', 'us-states.json', 'provinces.json'):
        write('data/' + name, read('data/' + name))

    with open(os.path.join(OUT, 'js', 'map.js'), encoding='utf-8') as f:
        assert MAPLIBRE_CDN in f.read(), 'the MapLibre import was not rewritten'
    for folder, _, files in sorted(os.walk(OUT)):
        for name in sorted(files):
            path = os.path.join(folder, name)
            print('%-22s %7.0f KB' % (os.path.relpath(path, OUT), os.path.getsize(path) / 1024))


if __name__ == '__main__':
    main()
