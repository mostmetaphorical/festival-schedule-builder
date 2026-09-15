# Working on this project

Meta's Nifty Film Fest Planner: a static web app that turns a Letterboxd or
IMDb ratings export into a conflict-free festival schedule, plus the offline
test that decides whether its recommendations are worth trusting. README.md
explains the product and the measured results; this file is how to work on it.

## Where things live

- **Canonical repo: `~/festival-schedule-builder` in WSL (Ubuntu).** An older
  copy exists on Windows under ProtonDrive — it is stale; don't edit it.
- `app/` is the whole website. Pushing to `main` deploys it to GitHub Pages
  (https://mostmetaphorical.github.io/festival-schedule-builder/).
- Everything else (Python) is the evaluation, data building and model export.

## Environment

- Python: `./setup.sh` once, then `./.venv/bin/python …`
- Node (for wrangler): via nvm — `source ~/.nvm/nvm.sh` in non-login shells.
- Cloudflare: wrangler is logged in. The share Worker (`worker/`) is deployed
  as `festrec-share`, storing in the KV namespace `festrec-shares`.
  **Never enable R2 or add a payment method** — KV on the free plan fails
  instead of billing, and staying unchargeable is a hard requirement.
- Worker commands run with `source ~/.nvm/nvm.sh` first; `cd worker && npm test`.
- Local site: `./.venv/bin/python dev_server.py` → http://localhost:8124.
  **Use this, not `python -m http.server`.** The built-in server lets the
  browser cache JS modules, so an edit can appear to do nothing — this made a
  fixed bug look unfixed once already.

## Rules

### Never publish personal data
- **Stage files by name. Never `git add -A` or `git commit -a`.** Twice this
  swept things in that shouldn't have shipped — once someone's volunteer shift
  schedule, once untested work.
- Before every commit, read `git diff --cached --stat` and grep the staged diff
  for personal data (commitments, ratings exports, keys).
- Personal commitments parsed from a festival page go to
  `app/data/my-commitments.json`, which is gitignored. Never into
  `festival.json`.
- Gitignored and must stay that way: `/data/` (MovieLens, licensed for
  research only — never redistribute), `/raw/` (festival pages and data saved
  by hand), rating exports, `app/fixtures/private-*`, `my-commitments.json`.

### Film data sources
- Credits, genres and keywords come from **Wikidata** (CC0); synopses from
  **Wikipedia** (CC BY-SA 4.0 — any synopsis shown must credit its article);
  posters from **each festival's own listing**.
- **Do not use TMDB.** Its API terms forbid use "in connection with" a machine
  learning application, which this is. IMDb's datasets can't be republished
  and OMDb's posters aren't its to license, so neither is a substitute.
- Never write the contact email address out in full in the site, scripts or
  README. The app assembles it in `app/js/contact.js` only when someone opens
  an emailing section, to keep it away from address harvesters.
- Don't automate collection from festival or ticketing sites (Eventive's terms
  forbid bots and data-gathering tools). Converters read files a person saved.
- `app/fixtures/demo-ratings.csv` is the maintainer's own Letterboxd ratings,
  published at their request (Name, Year, Rating only - no watch dates or
  links). Never replace it with anyone else's history.
- Letterboxd: no scraping, ever. Their robots.txt disallows it and profiles are
  other people's data. Real data only arrives as exports people chose to send.

### Deploys
- Push (and so deploy) only after a significant, tested batch of changes — not
  after every edit. Commit locally in between.
- Commit messages: write to a file and `git commit -F`; end with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### Testing UI changes
- Drive the actual interaction in the browser, not just page load: click Swap,
  Drop, Add a film, the synopsis toggle, the demo profile. Check the result.
- Check mobile width too (`resize_window` mobile), then reset to desktop.
- Content inside a hidden panel won't lazy-load images — check the Plan view
  once it's visible.

### Changing the recommender
- **Python and JavaScript must agree.** `festrec_eval/features.py` ↔
  `app/js/recommend.js`, and `festrec_eval/titles.py` ↔ `normalise()` in
  `app/js/metadata.js`. Change one, change the other, re-export the model.
  The blend likewise: `festrec_eval/serve.py` ↔ `app/js/blend.js`; run
  `check_blend_parity.py` then `node check_blend_parity.mjs` after any change.
- Measure before claiming an improvement: `run_eval.py`, paired against
  `user_mean`, and compare two models *directly* with a paired bootstrap.
- A difference on one seed is not a result. Check another seed; results here
  have moved by 2x between samples.
- Report negative results in README rather than quietly dropping them.
- `test_sanity.py` must pass (it catches leakage). Run it after data or
  feature changes.

### Tooling traps
- Don't round-trip text files through PowerShell `Get-Content`/`Set-Content` —
  it mangles UTF-8 (em-dashes become `â€”`). Use the edit tools, or `sed`
  inside WSL for ASCII-only changes.
- From Windows, run WSL commands as script files rather than inline
  `wsl -e bash -lc "…"` strings; quoting breaks otherwise.
- Don't `pkill -f` a pattern that appears in your own command line.
- Writing a backslash-u escape (backslash, `u`, four hex digits) through the
  file-writing tool can turn it into the raw character — this put null bytes
  in two validators and made git treat them as binary. After writing regexes
  or strings with such escapes, check with
  `grep -nP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' <file>`; build characters with
  `chr()` in Python if you need to generate them.

### The share Worker
- Write-only. Never add a route that reads stored data back out.
- Never store the uploaded bytes — rebuild from validated values.
- Never log or store anything about the sender (IP, user agent, filename).
- Bot checks: never complete a real Turnstile challenge yourself. Test the
  accepted path with `wrangler dev` and Cloudflare's test keys (`?share-test`).
- Run `npm test` before every deploy (`npm run deploy` does).
- Anything rendered into the page with `innerHTML` must go through
  `escapeHTML` — festival data comes from strangers.

### In the product
- Say what a score rests on. Thin evidence gets labelled, not dressed up.
- Profiles under 30 ratings get honest warnings — measured, they barely beat
  chance.
- Festival data submitted by the public is reviewed by a person before it goes
  live. Never auto-merge it: a wrong showtime means someone misses a film.

## Common commands

```bash
./.venv/bin/python dev_server.py                   # local site, no caching
./.venv/bin/python test_sanity.py                  # leakage checks
./.venv/bin/python run_eval.py --n-users 100       # accuracy test
./.venv/bin/python diagnose.py [--folds 5]         # RMSE/MAE, P@10/R@10, leakage, cold start, latency
node diagnose_js.mjs exports/                      # browser model: parity with Python, latency, slate spread
./.venv/bin/python eval_letterboxd.py exports/     # test on real exports
./.venv/bin/python convert_eventive.py raw/<fest> --name "<Festival Year>" --previous app/data/festival.json
                                                   # festival.json from saved Eventive films/events responses
./.venv/bin/python convert_tiff.py raw/tiff/films.json --name "TIFF 2026"  # from TIFF's saved festivalfilmlist response
./.venv/bin/python parse_festival.py <page.html>   # build festival.json
./.venv/bin/python enrich_festival.py              # credits for known films, from Wikidata
./.venv/bin/python enrich_wikidata.py              # training-film metadata (resumable)
./.venv/bin/python build_bundle.py                 # app/data/library.json from Wikidata
./.venv/bin/python export_model.py                 # retrain, write model.json
./.venv/bin/python export_blend.py                 # blend.json, model-genre.json, track.json
./.venv/bin/python build_bundle.py --content-factors   # library with synopsis terms and CF factors
./.venv/bin/python add_content_factors.py <festival.json ...>  # CF factors for festival films
node check_slate_spread.mjs exports/                  # prediction spread on real slates
```

Maintaining shared data:

```bash
worker/download-ratings.sh [--delete]              # shared ratings -> exports/
worker/review-festival.sh                          # list festival submissions
worker/review-festival.sh <key>                    # branch + PR link for one
node worker/validate-festivals.mjs                 # what CI checks on PRs
```
