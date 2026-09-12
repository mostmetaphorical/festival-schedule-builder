# Festival schedule recommender

**Alpha.** Import your film ratings, say when you're busy, and get a
conflict-free festival schedule ranked by what you're most likely to enjoy.

**Everything runs in your browser.** Your ratings are never uploaded, there is
no account, and there is no server to send them to. The page reads your export,
scores the festival slate on your device, and that's the end of it.

## Help make it better

The model was trained on an old public dataset of mostly mainstream films, and
it is being tested against festival slates, where most titles are premieres
nobody has rated yet. Real rating histories make it measurably better.

To contribute yours: on a computer, open
[letterboxd.com/settings/data](https://letterboxd.com/settings/data/), click
**Export your data**, open the zip, and send **only `ratings.csv`** to
`festrecommender.crucial122@passmail.net`. Please don't send the whole zip.

That one file holds the date, film title, film year, a film link and your star
rating — nothing else. Your username, name, email, location, bio, reviews,
diary and watchlist are in *other* files in that zip, which is why only this
one is wanted. Delete the `Date` column first if you'd rather not share it; it
isn't used. Fifteen ratings is the minimum for the test to mean anything.

Ratings sent this way are used only to measure how well the recommender
predicts held-out ratings ([the test](#the-accuracy-test)), and are not
republished.

## How it's built

Two halves: **`app/`** is the thing people use, and everything else is the test
that decides whether it's worth using.

## The app

A static page. No server, no accounts, no telemetry. Someone's rating history
is read in the browser, scored there, and never leaves the device.

```bash
python -m http.server 8123 --directory app
```

Then open <http://localhost:8123>. To deploy, copy `app/` to any static host
(GitHub Pages, Cloudflare Pages, Netlify).

| Step | What happens |
|---|---|
| Ratings | Reads a Letterboxd export (`.zip` or `ratings.csv`) or an IMDb export. Credits come from `data/library.json`, bundled with the app, so no API key is needed for films it knows. A TMDB key can be pasted in to cover the rest; it stays in the browser. |
| Festival | Picks from `data/festivals.json`, or loads a schedule from a URL or pasted JSON. |
| Your time | Volunteer shifts, work, appointments — typed in, or imported from `.ics` or CSV. |
| Plan | A conflict-free schedule with reasons, which the person can override film by film. |

**Non-film events** — parties, secret screenings, live shows — are kept in the
slate and marked "not rated" rather than scored, because no rating history can
predict them. They can be pinned into the plan like anything else.

**Editing** — every slot has *Swap* (shows what else is on at that hour, with
synopses) and *Drop*. A pinned choice outranks the model, and the schedule
re-solves around it.

**Exports** — `.ics` for the phone's calendar, a self-contained HTML page, and
print-to-PDF. The HTML export has two flavours: schedule only, which is safe to
host or share, or schedule plus rating history, which can be loaded back into
the app later but is a personal file. The app says which is which at the point
of export.

**Storage** — off until switched on, then `localStorage` only. Not a cookie:
cookies are sent to a server on every request and cap out near 4KB, neither of
which suits a rating history. Browsers do clear this, so the app treats the
downloaded file as the real backup and says so.

### Making the predictions good

The recommender compares a festival film's credits and themes against the films
someone rated. Both sides have to be described the same way, and four things
were quietly breaking that:

| Problem | Fix | Effect |
|---|---|---|
| MovieLens writes "Big Lebowski, The"; Letterboxd writes "The Big Lebowski" | `festrec_eval/titles.py`, matched on both sides | library coverage 56% → 83% |
| The bundled film list stopped at 2018, missing every recent favourite | `build_tmdb_bundle.py` builds it from TMDB instead | 83% → **96%** on a real 674-film export |
| Festival films described in festival wording ("Dream-logic slasher") | `enrich_festival.py` matches the lineup to TMDB | 66 of 81 films gained real credits and themes |
| Films with no metadata scored *highest* | evidence shrinkage (below) | unknown shorts no longer top the list |

On a real 674-rating Letterboxd export, this took the profile from 380 matched
films with no genre data at all, to 645 matched films knowing 430 directors,
2,025 actors, 2,369 themes and 18 genres.

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
python eval_letterboxd.py exports/
```

Drop in each person's export zip. This needs exports people chose to share —
Letterboxd blocks automated access, their robots.txt names AI crawlers
explicitly, and other people's viewing histories aren't ours to collect.

### Translating festival vocabulary (optional)

`translate_festival.py` uses Claude to describe the films TMDB has never heard
of in TMDB's own vocabulary, picking only from the keyword list the model was
actually fitted on, so nothing invented can reach it. It runs **once per
festival** over about a dozen titles — cents, not per user — and the app works
without it.

### Rebuilding the app's data

```bash
python export_model.py                    # model.json + idf.json
python build_tmdb_bundle.py               # library.json, the offline credits
python parse_festival.py <festival.html>  # festival.json
python enrich_festival.py                 # match the lineup to TMDB
python translate_festival.py              # optional, needs an Anthropic key
```

A TMDB key goes in `tmdb_key.txt` (gitignored). `export_bundle.py` builds the
same bundle from a local MovieLens copy instead, if you'd rather not call TMDB.

---

# The accuracy test

Measures how well a recommender predicts one person's taste before any of it
is wired into a festival app. Every rater is treated as a festival-goer: 70% of
their ratings build a taste profile, the other 30% stand in for the festival
slate, and the test asks how well those held-out films are ranked.

Raters with fewer than 15 ratings are excluded.

## Running it

```bash
python run_eval.py --n-users 100
python test_sanity.py
```

Python lives in its own environment at `~/.venvs/festrec`, so the full command is
`~/.venvs/festrec/Scripts/python.exe run_eval.py`.

Useful flags: `--n-users`, `--seed`, `--split time` (train on what they watched
first, test on what came later), `--mode cold|warm|both`, `--min-ratings`.

`--facets` restricts which signals the model may use, so a gain can be traced to
the signal that caused it rather than guessed at:

```bash
python run_eval.py --facets genre,decade          # metadata-poor baseline
python run_eval.py --facets director,writer,cast  # people only
python run_eval.py --facets text                  # synopsis wording only
```

## The two conditions

| Condition | What the model may see | Why it's here |
|---|---|---|
| **cold** | Only the film's own details: genre, year, and — once TMDB is fetched — director, writer, cast, keywords | A festival premiere has no ratings yet. This is the number that predicts real behaviour. |
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
| `enrich_tmdb.py` | Fetches director, writer, cast and keywords from TMDB |
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

300 random raters, cold condition, 15,067 held-out ratings:

| model | ndcg@10 | precision@5 | top5_lift | rmse |
|---|---|---|---|---|
| user_mean (baseline) | 0.825 | 0.573 | +0.007 | 0.930 |
| **content model** | **0.888** | **0.711** | **+0.333** | **0.895** |

Paired against the baseline on the same users: ndcg +0.063 (95% CI +0.053 to
+0.073), precision@5 +0.138, rmse −0.035. All three favour the model, and the
intervals exclude zero.

Which signals earn their place (100 users, cold):

| signals used | ndcg@10 | spearman | top5_lift |
|---|---|---|---|
| genre + decade + year | 0.856 | 0.182 | 0.258 |
| people (director/writer/cast) | 0.865 | 0.187 | 0.304 |
| keywords | 0.862 | 0.239 | 0.263 |
| synopsis text | 0.832 | 0.126 | 0.147 |
| **people + keywords + text** | **0.880** | **0.279** | **0.363** |
| everything available | 0.871 | 0.242 | 0.324 |

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
| 15–30 ratings | 47 | +0.023 | +0.02 |
| 31–75 | 103 | +0.027 | +0.20 |
| 76–200 | 79 | +0.066 | +0.34 |
| 201+ | 71 | +0.138 | +0.73 |

Below about 30 ratings the recommender is barely better than telling someone
they'll like everything equally. It becomes genuinely useful around 75, and
strong past 200. The 15-rating floor keeps the arithmetic valid, but the app
should tell people where they sit on this table rather than imply every
profile gets the same quality of answer.

A harder variant — training on what someone watched first and testing on what
came later (`--split time`) — drops top5_lift to +0.24. Real use looks more
like that than like a random split, so treat it as the honest expectation.

### One methodological note

Leave-one-out removes a training film's own rating from its own features, but
keeps the person's average computed over their whole training half. That is
deliberate: at prediction time the model also has the full-history average, so
holding it fixed keeps fitting and prediction consistent.

## Refreshing the metadata

Film details come from TMDB and are cached in `data/tmdb_cache.json` (9,621
films). To rebuild or extend it, put a free TMDB key in `tmdb_key.txt` and run
`python enrich_tmdb.py`; it skips what it already has.

## Licence and attribution

Code is GPL-3.0 (see `LICENSE`).

Film metadata in `app/data/library.json` comes from **TMDB**. This product uses
the TMDB API but is not endorsed or certified by TMDB. It is included so the
app works without every visitor needing an API key; it is a subset of credits
and keywords, for non-commercial use.

The recommender's weights were fitted on **MovieLens** (GroupLens Research).
That dataset is licensed for research use and may not be redistributed, so it
is not in this repository — `export_model.py` rebuilds from a local copy you
download yourself.

Rating histories contributed by people are not published here.
