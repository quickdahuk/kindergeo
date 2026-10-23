# Notes for AI agents

Kinder Geo is a geography game for kids, live at <https://kindergeo.com>.
Read [README.md](README.md) first (what it is, how to run, test and deploy),
then [ARCHITECTURE.md](ARCHITECTURE.md) (how the code works, the design
rules, and how to make common changes).

## Ground rules

- **Static site, no build step.** Plain HTML, CSS and JavaScript modules;
  MapLibre is in `vendor/`. Don't add npm packages, bundlers, frameworks, or
  scripts, fonts or analytics from other sites: the game promises schools
  that it loads nothing from elsewhere.
- **Edit the files at the repository root.** `firebase/public/` is a copy
  made by `tools/build_firebase.py`; never edit or commit it.
- **`docs/` is the project page** on GitHub Pages
  (<https://quickdahuk.github.io/kindergeo/>), not the game. It goes live when
  `main` is pushed. Keep its words and screenshots in step with the game.
- **Don't commit** `.cache/`, `.venv/`, `test-results/` or `firebase/public/`
  (`.gitignore` covers them).
- **Keep the old internal name.** `window.countryQuest` and the `cq.` keys in
  `localStorage` date from the game's first name, Country Quest. Renaming them
  would wipe players' saved settings and break the tests.
- **Words players read** must be plain enough for young children, and facts
  must be true and checked against a reliable source.
- **Screens must fit without scrolling** on a phone upright, a phone on its
  side, and a desktop (the three sizes `tools/check.py` uses).
- **Ask the owner before** changing the first page of the Start menu, the
  look of the map, the domain or DNS, or anything players see that wasn't
  asked for. Show screenshots of visual changes before deploying them.

## Commands

```sh
python3 tools/serve.py 8766                  # run it: http://localhost:8766
# unit tests: open http://localhost:8766/tests/unit.html

python3 -m venv .venv && .venv/bin/pip install playwright   # once
.venv/bin/python -m playwright install chromium --only-shell
.venv/bin/python tools/check.py              # all checks, 10-15 minutes

python3 tools/build_data.py                  # rebuild the data (rarely needed), in this order
python3 tools/build_states.py
python3 tools/build_provinces.py             # needs Node.js (npx mapshaper)

python3 tools/build_firebase.py              # deploy: copy the site, then
cd firebase && npx firebase-tools@latest deploy --only hosting --project playkindermap
```

Deploying needs the Firebase CLI to be signed in to the owner's Google account
(`npx firebase-tools@latest login`, done by the owner). After a deploy, check
that the live files match: `curl -s https://kindergeo.com/js/map.js | shasum`
against `shasum < firebase/public/js/map.js`.

## Before you say it's done

1. Run the unit tests, and `tools/check.py` for anything beyond a small change.
   On a slow computer, "the opening globe turns" can fail on its own; the rest
   should pass.
2. Look at the change in a browser (desktop and phone sizes), not only in the
   tests.
3. Update `README.md` and `ARCHITECTURE.md` when what they describe changes.
4. Deploy only when the owner asks, and verify the live files afterwards.
