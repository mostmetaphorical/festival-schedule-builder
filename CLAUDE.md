# Working on this project

Meta's Nifty Film Fest Scheduler: a static web app that turns a Letterboxd or
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
- Cloudflare: wrangler is logged in. R2 and a workers.dev subdomain are not yet
  enabled on the account.
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
- Gitignored and must stay that way: `tmdb_key.txt`, `/data/` (MovieLens,
  licensed for research only — never redistribute), rating exports,
  `app/fixtures/private-*`, `my-commitments.json`.
- `app/fixtures/demo-ratings.csv` is invented, not anyone's real history.
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
./.venv/bin/python eval_letterboxd.py exports/     # test on real exports
./.venv/bin/python parse_festival.py <page.html>   # build festival.json
./.venv/bin/python enrich_festival.py              # credits + posters from TMDB
./.venv/bin/python export_model.py                 # retrain, write model.json
```

## In progress

Sharing from the app via a Cloudflare Worker: rating uploads kept private
(storage vs email not yet decided — R2 needs enabling), and festival
submissions validated then opened as a pull request for review.
