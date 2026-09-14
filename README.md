# Meta's Nifty Film Fest Scheduler

**Alpha.** Import your film ratings, say when you're busy, and get a
conflict-free festival schedule ranked by what you're most likely to enjoy.

**Everything runs in your browser.** Your ratings are never uploaded unless
you choose to share them, and there is no account. The page reads your export
and scores the festival slate on your device.

## Help make it better

The model was trained on an old public dataset of mostly mainstream films, and
it is being tested against festival slates, where most titles are premieres
nobody has rated yet. Real rating histories make it measurably better.

**Please only share if you've rated at least 30 films** — smaller histories
measurably can't tell the test anything, so they aren't collected.

**From the app:** build a plan, and on the *Plan* step tick *I agree to share
these ratings*. Only title, year and star rating are sent — not the date you
watched, your username, reviews, diary or watchlist.

**Or by email:** export from
[letterboxd.com/settings/data](https://letterboxd.com/settings/data/), open the
zip, and send **only `ratings.csv`** to the address in the app's *Emailing
instead* section (it isn't written here, to keep it away from address
harvesters). Please don't send the whole zip — your profile details are in
the other files.

Shared ratings are used only to measure how well the recommender predicts
held-out ratings ([the test](#the-accuracy-test)), and are never republished.

## How it's built

Two halves: **`app/`** is the thing people use, and everything else is the test
that decides whether it's worth using.

## The app

A static page. No server, no accounts, no telemetry. Someone's rating history
is read in the browser, scored there, and never leaves the device.

```bash
./setup.sh                                              # first run only
./.venv/bin/python -m http.server 8123 --directory app
```

Then open <http://localhost:8123>. To deploy, copy `app/` to any static host —
this repo publishes `app/` to GitHub Pages on every push to `main`.

Developed on Linux, including WSL. `setup.sh` builds the virtual environment
and installs the dependencies; on Ubuntu you may first need
`sudo apt install -y python3-venv python3-pip`.

| Step | What happens |
|---|---|
| Ratings | Reads a Letterboxd export (`.zip` or `ratings.csv`) or an IMDb export. Credits come from `data/library.json`, bundled with the app and built from Wikidata. Films it doesn't know can be looked up on Wikidata live, on request — no key, and only the titles are sent. |
| Festival | Picks from `data/festivals.json`, or loads a schedule — a spreadsheet (CSV, with a downloadable template) or JSON — from a file, a URL or pasted text. Posters come from the festival file. Each festival card says when its listings were uploaded (a JSON file’s optional `captured` date, or the day the file was loaded). Below the list, a reminder to confirm times sits with *Upload a schedule update*: pick the festival, load a newer file, and the plan is kept while a report lists what moved, was added or was removed. Once a festival is chosen, its name is pasted across the page title as a slanted banner. |
| Your time | Volunteer shifts, work, appointments — typed in, or imported from `.ics` or CSV. |
| Plan | A conflict-free schedule with reasons, which the person can override film by film. Each film is planned with 10 minutes for a Q&A before the gap between screenings starts, and free time stays folded behind its timeline diamond until opened. |

**Non-film events** — parties, secret screenings, live shows — are kept in the
slate and marked "not rated" rather than scored, because no rating history can
predict them. They can be pinned into the plan like anything else.

**Editing** — every slot has *Swap* and *Drop*. Swap lists what else is on at
that hour, with synopses, and greys out films starting within an hour either
side, which can still be chosen. An edit changes only what it touches: the rest
of the plan stays put. If a swapped-in film runs into another pick, both stay
and the plan shows a clash warning with a choice of which to drop; the swap
list says so before choosing. Dropping a film leaves its slot free and lists
what fits there, rather than quietly moving the next-best film in; the dropped
film stays in those lists, marked, so it can be put straight back. Changing
the daily limit, the gap between films or commitments re-plans around the
films you picked yourself. Nothing is ruled out for you: every film stays
reachable, whether in free time, a swap list, or on a day with nothing
planned, with clashes and commitments labelled rather than hidden.

**Exports** — `.ics` for the phone's calendar, a self-contained HTML page, and
print-to-PDF. The HTML export has two flavours: schedule only, which is safe to
host or share, or schedule plus rating history, which can be loaded back into
the app later but is a personal file. The app says which is which at the point
of export.

**No third parties by default** — fonts are served from `app/fonts/` (all
three are under the SIL Open Font License; `fetch_fonts.py` refreshes them), so
opening the page contacts no one but this site. Posters load from wherever the
festival file points, and Wikidata is only contacted if someone asks it to
look up films the bundled library doesn't know.

**Reporting a bug** — *Report a bug* (top right of every page) opens a
short form: what went wrong, where, an optional email for a reply, and — if
the box stays ticked — technical details that are shown in full before sending
(browser, window size, festival, counts; never ratings). It goes to the same
Worker as sharing, or can be emailed instead.

**Storage** — off until switched on, then `localStorage` only. Not a cookie:
cookies are sent to a server on every request and cap out near 4KB, neither of
which suits a rating history. Browsers do clear this, so the app treats the
downloaded file as the real backup and says so.

### Sharing (`worker/`)

Sharing is opt-in and goes to a small Cloudflare Worker, `worker/`. It is
**write-only**: there is no route that reads anything back out.

**Staying free.** Uploads are stored in Workers KV on the free plan, with no
payment method on the account. Past the free limits (1 GB, 1,000 writes a day)
KV refuses operations rather than billing for them. R2 is deliberately not
used: it has no spending cap. The Worker also enforces its own lower limits —
1 MB per upload, 900 MB total, 300 uploads a day — so sharing pauses with a
clear message instead of failing.

**Checking what arrives.** Every upload is treated as hostile. In order:
a Cloudflare Turnstile bot check; a hard 1 MB read limit whatever the request
claims; strict UTF-8 with no control characters (binary files fail here); an
exact `Name,Year,Rating` header; every row checked (30-10,000 rows, half-star
ratings, real years, sane title lengths). Any failure rejects the whole file.
The original bytes are never stored — a new file is rebuilt from the checked
values, with spreadsheet formulas neutralised. Festival files go through the
same pattern with a schema check, markup refused, and posters accepted only
as plain `https` addresses. The summary lists every poster host, so the
reviewer sees where images would load from before a festival goes public.

**Nothing about the sender is kept**: no IP address, filename or browser
details. Each upload is a random id plus the day it arrived. Cloudflare's
bot-check script is only loaded once someone ticks a consent box.

**Festival submissions never publish themselves.** They wait in storage until
reviewed; `worker/review-festival.sh` puts one on a branch for a pull request,
where CI re-validates it, and a person compares it with the official schedule
before merging.

Bug reports use the same pattern: a bot check, a 16 KB cap, a description of
10–3,000 characters, and only known fields rebuilt into storage.

```bash
cd worker && npm test                          # 44 tests, incl. malicious uploads
npm run deploy                                 # tests first, then deploy
worker/download-ratings.sh [--delete]          # shared ratings -> exports/
worker/review-festival.sh [<key>|--reject <key>]
worker/download-reports.sh [--delete]         # bug reports -> reports/ (gitignored)
```

For local testing, `wrangler dev` uses Cloudflare's documented always-pass
Turnstile test keys (`worker/.dev.vars`, gitignored); open the app with
`?share-test` on localhost to point it there.

### Making the predictions good

The recommender compares a festival film's credits and themes against the films
someone rated. Both sides have to be described the same way, and four things
were quietly breaking that:

| Problem | Fix | Effect |
|---|---|---|
| MovieLens writes "Big Lebowski, The"; Letterboxd writes "The Big Lebowski" | `festrec_eval/titles.py`, matched on both sides | library coverage 56% → 83% |
| The bundled film list stopped at 2018, missing every recent favourite | `build_bundle.py` takes the most widely written-about films of every year, and more of them from 2018 on | 83% → **95%** on a real 674-film export and 87% on a 502-film one (the TMDB-built list reached 96% on the first). Most of what's left is from the 2020s, which the in-app Wikidata lookup covers on request |
| Festival films described in festival wording ("Dream-logic slasher") | `enrich_festival.py` matches the lineup to Wikidata | repertory and known titles gain real credits and themes |
| Films with no metadata scored *highest* | evidence shrinkage (below) | unknown shorts no longer top the list |

On a real 674-rating Letterboxd export (with the earlier TMDB-built data),
this took the profile from 380 matched films with no genre data at all, to 645
matched films knowing 430 directors, 2,025 actors, 2,369 themes and 18 genres.

**Evidence shrinkage.** Standardised features make "nothing is known about this
film" a specific point in feature space, not a neutral one — so films with no
credits and no themes were landing near the top. Predictions are now scaled by
how much the person's history actually says: no evidence, no opinion. Measured
neutral on MovieLens (where nearly every film has some metadata) and it fixes
a visible ordering failure at a festival.

**Two things that sounded good and measured worse.** Both are kept in the
codebase as recorded negatives rather than deleted:

- *A separate model for films where you've rated nobody involved* (`TwoRegime`
  in `models.py`). In the regime it was built for, it gave no ranking
  improvement (ndcg +0.004, interval −0.005 to +0.012) and was significantly
  worse on rating accuracy (rmse +0.037). An earlier reading that genre
  "doubled the lift" turned out to be seed noise — the same configuration
  scored 0.045 and 0.083 on two different samples.
- *Genre, decade and year in the main model.* Still off by default; they
  dilute the sharper signals (see the ablation table below).

### Testing on real Letterboxd data

MovieLens says whether the recommender works. It can't say whether it works on
*this* population — Letterboxd users rate newer, more arthouse films, and rate
them higher (3.9 average against MovieLens's 3.5). `eval_letterboxd.py` runs
the identical 70/30 test on real exports:

```bash
./.venv/bin/python eval_letterboxd.py exports/
```

Drop in each person's export zip. This needs exports people chose to share —
Letterboxd blocks automated access, their robots.txt names AI crawlers
explicitly, and other people's viewing histories aren't ours to collect.

### Translating festival vocabulary (optional)

`translate_festival.py` uses Claude to describe the films Wikidata has never
heard of in the model's own vocabulary, picking only from the keyword list the model was
actually fitted on, so nothing invented can reach it. It runs **once per
festival** over about a dozen titles — cents, not per user — and the app works
without it.

### Rebuilding the app's data

```bash
./.venv/bin/python enrich_wikidata.py                 # training-film metadata (resumable)
./.venv/bin/python export_model.py                    # model.json + idf.json
./.venv/bin/python build_bundle.py                    # library.json, the offline credits
./.venv/bin/python parse_festival.py <festival.html>  # festival.json
./.venv/bin/python enrich_festival.py                 # match the lineup to Wikidata
./.venv/bin/python translate_festival.py              # optional, needs an Anthropic key
```

No API keys are needed. Everything fetched from Wikidata and Wikipedia is
cached in `data/` (gitignored), so a rebuild only asks about new films.

### Where the film data comes from, and why not TMDB

| What | Source | Licence |
|---|---|---|
| Director, writer, cast, genre, keywords, runtime | [Wikidata](https://www.wikidata.org/) | CC0 — free for any use |
| Synopses of known films | [Wikipedia](https://en.wikipedia.org/) | CC BY-SA 4.0 — the app credits the article wherever one is shown |
| Festival synopses and posters | the festival's own listing, via its festival file | the festival's |

The app used to get all of this from TMDB. TMDB's API terms forbid using its
content "in connection with" a machine-learning application, and this is one,
so it was replaced. IMDb's free datasets can't be republished as a database,
which the bundled library would be, and OMDb's posters aren't its to license.
Wikidata covered the training films as well: 99% matched, with a director for
98%, cast for 95%, a synopsis for 97% and keywords for 78%.

---

# The accuracy test

Measures how well a recommender predicts one person's taste before any of it
is wired into a festival app. Every rater is treated as a festival-goer: 70% of
their ratings build a taste profile, the other 30% stand in for the festival
slate, and the test asks how well those held-out films are ranked.

Raters with fewer than 15 ratings are excluded.

## Running it

```bash
./.venv/bin/python run_eval.py --n-users 100
./.venv/bin/python test_sanity.py
```

The evaluation needs MovieLens, which is licensed for research and cannot be
redistributed — download `ml-latest-small.zip` from
[grouplens.org](https://grouplens.org/datasets/movielens/) and unzip it into
`data/`. The app itself doesn't use it.

Useful flags: `--n-users`, `--seed`, `--split time` (train on what they watched
first, test on what came later), `--mode cold|warm|both`, `--min-ratings`.

`--facets` restricts which signals the model may use, so a gain can be traced to
the signal that caused it rather than guessed at:

```bash
./.venv/bin/python run_eval.py --facets genre,decade          # metadata-poor baseline
./.venv/bin/python run_eval.py --facets director,writer,cast  # people only
./.venv/bin/python run_eval.py --facets text                  # synopsis wording only
```

## The two conditions

| Condition | What the model may see | Why it's here |
|---|---|---|
| **cold** | Only the film's own details: genre, year, and — once Wikidata is fetched — director, writer, cast, keywords, synopsis | A festival premiere has no ratings yet. This is the number that predicts real behaviour. |
| **warm** | Also the crowd's average rating for each candidate | Impossible at a festival. Included to show what that missing signal is worth. |

Crowd averages are computed from raters outside the sample, so nothing the
models see is contaminated by the held-out ratings.

## What's measured

The app only needs the right handful of films at the top, so ranking matters
more than star accuracy.

- **ndcg@10** — ranking quality: were their favourites near the top? 1.0 is perfect.
- **precision@5** — of the 5 films recommended, what share did they rate 4★ or better.
- **top5_lift** — how much better the top 5 were than the slate average. This is the
  felt benefit: "the app's picks were half a star better than picking blind."
- **spearman** — rank correlation across the whole held-out set.
- **rmse / mae** — star-rating error. Secondary: being uniformly half a star low
  costs nothing if the order is right.

Every model is compared against **user_mean** — predicting that someone rates
everything at their own average. A recommender that can't beat that is useless,
and it's a harder baseline than it sounds.

## Trusting the result

`test_sanity.py` checks the test rather than the model: the 15-rating rule is
enforced, train and test never overlap, the cold condition really has no crowd
features, crowd stats exclude sampled users, and leave-one-out strips a training
film's own rating from its own features.

The decisive check shuffles each person's ratings so there is no taste left to
learn. A leaking test would still report a gain; this one collapses to roughly
the baseline. Whatever small gain remains is the noise floor, and real results
should be read against it, not against zero.

## The pieces

| File | What it does |
|---|---|
| `festrec_eval/data.py` | Loading, the 15-rating filter, per-person 70/30 split |
| `festrec_eval/features.py` | Taste-overlap features; nothing that needs crowd ratings |
| `festrec_eval/text.py` | Synopsis similarity (TF-IDF), the signal a premiere does have |
| `festrec_eval/models.py` | Baselines and the ridge content model |
| `festrec_eval/metrics.py` | Scoring, with bootstrap intervals over users |
| `festrec_eval/llm.py` | Optional Claude comparison (`--llm`), cached, costed |
| `festrec_eval/wikidata.py`, `enrich_wikidata.py` | Fetch director, writer, cast, keywords and synopses from Wikidata and Wikipedia |
| `festrec_eval/genres.py` | The model's genre words, and how other sources' wording maps onto them |
| `test_sanity.py` | The leak checks above |

## How a film gets scored

Each feature asks the same question: how has this person rated films sharing
something with the candidate — a director, a genre, a release era? Each is the
overlap-weighted average of their ratings on matching films, pulled toward
neutral when the evidence is thin (one shared actor is not an opinion). A ridge
regression fitted across all sampled users learns how much each signal is worth,
and each person's own average is added back at the end.

Synopsis similarity works the same way in word space: the films someone rated
above their average pull a "taste direction" one way, the ones below pull it
back, and a candidate is scored by how well its description aligns. It uses
TF-IDF rather than a language model, so it needs no network and no downloads and
can run in the browser for free. That matters most for premieres, where the
description is often all that exists.

None of it needs anyone else's opinion of the candidate film, which is what lets
it work on a premiere.

## Results

300 random raters, cold condition, 14,927 held-out ratings, with film data
from Wikidata and Wikipedia:

| model | ndcg@10 | precision@5 | top5_lift | rmse |
|---|---|---|---|---|
| user_mean (baseline) | 0.821 | 0.567 | +0.022 | 0.961 |
| **content model** | **0.886** | **0.697** | **+0.350** | **0.921** |

Paired against the baseline on the same users: ndcg +0.065 (95% CI +0.055 to
+0.076), precision@5 +0.129, rmse −0.040. All three favour the model, and the
intervals exclude zero. The shuffled-ratings check gains +0.007 on noise.

**Against the earlier TMDB data**, the same test gave ndcg +0.063, precision@5
+0.138 and top5_lift +0.333. Switching sources cost nothing measurable: the
gains overlap within their intervals. (Absolute scores differ slightly because
the held-out set differs by the handful of films each source couldn't match.)

Which signals earn their place (100 users, cold, Wikidata; TMDB-era figures in
brackets):

| signals used | ndcg@10 | spearman | top5_lift |
|---|---|---|---|
| genre + decade + year | 0.856 (0.856) | 0.182 (0.182) | 0.258 (0.258) |
| people (director/writer/cast) | 0.864 (0.865) | 0.172 (0.187) | 0.318 (0.304) |
| keywords | 0.850 (0.862) | 0.145 (0.239) | 0.212 (0.263) |
| synopsis text | 0.867 (0.832) | 0.230 (0.126) | 0.307 (0.147) |
| **people + keywords + text** | **0.872 (0.880)** | **0.245 (0.279)** | **0.370 (0.363)** |
| everything available | 0.871 (0.871) | 0.236 (0.242) | 0.300 (0.324) |

Wikidata's keywords are thinner than TMDB's, and Wikipedia's lead paragraphs
are richer than TMDB's one-line overviews. Those lead paragraphs also name the
director and stars, so part of the synopsis signal overlaps the people signal.
The combination still comes out on top.

Using every signal is *worse* than using the right three — genre, decade and
year are crude enough to dilute the sharper ones, so they are off by default.
The choice was made on one sample of users and then confirmed on three fresh
samples (ndcg 0.879–0.896) so it isn't an artifact of the users it was tuned on.

These figures are the corrected ones. An earlier run of this table was wrong:
`load_movielens` built its title and year columns as pandas Series and then
handed them an index of movie IDs, so pandas aligned row numbers against IDs
and turned 4,341 of 9,742 titles and years into nulls. That silently emptied
the year and decade features and unfairly penalised every configuration using
them (genre+decade+year read 0.844, "everything" 0.866). The headline results
never depended on those fields, and did not change. `test_sanity.py` now
asserts the columns survive loading.

### How much history a person needs

This is the finding that matters most for the app (300 users, cold):

| profile size | users | gain over baseline | top5_lift |
|---|---|---|---|
| 15–30 ratings | 59 | +0.014 | +0.07 |
| 31–75 | 110 | +0.040 | +0.24 |
| 76–200 | 67 | +0.081 | +0.45 |
| 201+ | 64 | +0.141 | +0.70 |

Below about 30 ratings the recommender is barely better than telling someone
they'll like everything equally. It becomes genuinely useful around 75, and
strong past 200. The 15-rating floor keeps the arithmetic valid, but the app
should tell people where they sit on this table rather than imply every
profile gets the same quality of answer.

A harder variant — training on what someone watched first and testing on what
came later (`--split time`) — drops top5_lift to +0.26 (TMDB-era: +0.24). Real use looks more
like that than like a random split, so treat it as the honest expectation.

### One methodological note

Leave-one-out removes a training film's own rating from its own features, but
keeps the person's average computed over their whole training half. That is
deliberate: at prediction time the model also has the full-history average, so
holding it fixed keeps fitting and prediction consistent.

## Refreshing the metadata

Film details come from Wikidata and Wikipedia and are cached in
`data/wikidata_films.json`; `data/film_metadata.json` maps them onto MovieLens
(9,651 films). Run `python enrich_wikidata.py` to rebuild or extend it; it skips
what it already has, and re-applies the genre rules to cached films without
fetching them again.

## Licence and attribution

Code is GPL-3.0 (see `LICENSE`).

Film credits in `app/data/library.json` come from **Wikidata** (CC0 1.0).
Synopses taken from **Wikipedia** are CC BY-SA 4.0 and are credited to their
article wherever the app shows one. Festival synopses and posters come from
each festival's own listing.

The recommender's weights were fitted on **MovieLens** (GroupLens Research).
That dataset is licensed for research use and may not be redistributed, so it
is not in this repository — `export_model.py` rebuilds from a local copy you
download yourself.

Rating histories contributed by people are not published here.
