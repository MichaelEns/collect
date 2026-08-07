# My Collection Tracker

A tracker for mystery-box collectibles, built for a six-year-old chasing the
Star Wars Doorables Galaxy Peek sets.

**Live:** https://michaelens.github.io/collect/

Add it to a home screen and it works like an app — including in a shop aisle
with no signal, which is exactly where you need to know whether you already
have Boba Fett.

## What it does

- **Tap a figure to mark it found.** Found and missing differ by colour,
  border, brightness *and* a tick, so the difference survives a colourblind eye
  and a sunlit screen.
- **Counts spares**, because the point of spares is trading them.
- **Photograph your own figures.** The picture on the card becomes the one you
  took (see below for why).
- **Write down the capsule codes you find**, which is how you learn to spot a
  figure before you buy it.
- **Progress bar and a celebration** when a set is finished.
- Everything is saved on the device. Nothing is uploaded anywhere, ever.

## The two things this app refuses to do

**It does not show official product photos.** There is no legal, free way for a
private individual to put Just Play or Disney product images into a third-party
app — not by bundling them, not by hot-linking a retailer. Amazon, Target and
Walmart all prohibit hot-linking and gate their image APIs behind approved
affiliate accounts. So instead the app links out to the official page, and lets
the child photograph the figures he actually owns. That is legally clean, and
a shelf of his own photos is better than a borrowed catalogue anyway.

**It does not tell you which code means which figure.** The code system is
real: there is a short code moulded into the plastic on the bottom of each
capsule, and collectors do maintain code-to-figure spreadsheets. But those
codes change between production batches, Just Play has never published them,
and the community sheets could not be independently verified. A guessed mapping
would have a child put a capsule back on the shelf because the app told him the
wrong thing. So the app explains where to look, links the community list, and
records the codes *he* finds — which are correct for his batch by construction.

## How trustworthy is the data?

The rosters come from the Disney Doorables community wiki, cross-checked
against HobbyDB, Coleka and trade press. Just Play never published a checklist
online and has since taken its Series 1 and 2 pages down entirely, so there is
no official source left to check against. The app says so, on screen, under the
progress bar.

Two entries — the two Anakin Skywalkers in Series 2 — are marked with a **?**
because the words distinguishing them come from collectors rather than from the
box.

One specific trap is worth recording: several AI search summaries confidently
list Greedo, BB-8, Hera Syndulla and Chopper as the Series 2 ultra-rares. They
are the **Series 1** ultra-rares. There is a test that fails if they ever
appear in the Series 2 file.

## Adding another collection

Drop a JSON file into `sets/` and name it in `sets/index.json`. No code
changes. `sets/FORMAT.json` documents every field, and `tests/sets.test.mjs`
enforces it — including the honesty rules: a set must say where its roster came
from, must not ship codes it cannot verify, and must not claim to be verified
while containing unconfirmed entries.

```
index.html            one page: picker, grid, figure card
app.js                storage, photos, rendering
sets/                 one file per collection
tools/make_icons.py   regenerates the home screen icons
```

Progress lives in `localStorage`; photos live in IndexedDB, shrunk to 480px
first — a few full-size phone photos would blow the quota and start throwing,
taking the progress data down with them.

## Tests

```powershell
node --test tests/sets.test.mjs                    # the data, and its honesty
node --test tests/install.test.mjs                 # installable and offline-capable
node tests/collect.cjs "<path to msedge.exe>"      # drives the real page
node tools/screenshots.cjs                         # one shot per screen
```

`collect.cjs` picks a set, marks a figure, records a code, reloads to prove the
progress survived, checks the two sets keep separate progress, then **kills the
server** and reopens it to prove the whole checklist still works offline.
