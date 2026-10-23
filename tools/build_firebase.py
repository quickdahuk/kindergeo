#!/usr/bin/env python3
"""Copy the site into firebase/public/, ready for Firebase Hosting.

The firebase/ folder holds only what Firebase needs: firebase.json and a copy
of the files that go online.  Run this before every deploy, so the copy
matches the game:

  python3 tools/build_firebase.py        # writes firebase/public/
  cd firebase && firebase deploy --only hosting --project <project-id>
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'firebase', 'public')

# Everything the page loads.  The rest of the project is for development.
SITE = ['index.html', 'manifest.webmanifest', 'css', 'js', 'data', 'vendor', 'assets']


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for name in SITE:
        src = os.path.join(ROOT, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(OUT, name),
                            ignore=shutil.ignore_patterns('.*', '__pycache__'))
        else:
            shutil.copy2(src, OUT)
    count = size = 0
    for folder, _, files in os.walk(OUT):
        for name in files:
            count += 1
            size += os.path.getsize(os.path.join(folder, name))
    print('Wrote firebase/public/: %d files, %.1f MB' % (count, size / 1e6))


if __name__ == '__main__':
    main()
