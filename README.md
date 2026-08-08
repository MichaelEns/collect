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
- **Type a capsule's code and see what is inside it, before you open it.** The
  headline feature, and the one worth having in a shop.
- **Write down the capsule codes you find**, for batches nobody has recorded yet.
- **Progress bar and a celebration** when a set is finished.
- Everything is saved on the device. Nothing is uploaded anywhere, ever.

## Telling what is in a capsule before you buy it

There is a short code moulded into the plastic on the **bottom** of every
capsule — a letter and some numbers, like `A001`. Type it in and the app names
the four figures inside, and says how many of them you still need.

The letter at the front is the **batch**. Each batch has its own numbering, so
`A001` and `L002` are different capsules from different production runs. That
is genuinely why an unknown code shows up occasionally: it is from a batch
nobody has written down yet, not a bug.

**339 codes ship with the app**, covering all five series:

| Series | Codes | Batches | Figures covered |
| --- | --- | --- | --- |
| 1 | 12 | 7 | 20 of 25 |
| 2 | 177 | 12 (A–L) | 25 of 25 |
| 3 | 44 | 5 | 25 of 25 |
| 4 | 69 | 2 | 25 of 25 |
| 5 | 37 | 2 | 25 of 25 |

Where collectors disagreed about a code — two of them, both in Series 2 — the
app shows **every** version reported rather than quietly picking one.

Open a figure's card and it also works the other way round: it lists **every**
capsule known to contain that figure, grouped by batch. No truncation. One
figure appears in 45 different capsules across all 12 batches, and all 45 are
shown — a capped list quietly answers "no" for the codes it hides, which is the
opposite of useful when it is being checked against a capsule in hand.

### An earlier version of this README was wrong about this

It used to say the app deliberately would not map codes to figures, because
"the codes change between batches". That was half a true fact acted on badly.
The codes do vary by batch, but the community has mapped the batches, which is
why a collector using those sheets finds they essentially always work. Refusing
to ship them was overcaution, and it cost the app its most useful feature.

The data comes from the code spreadsheet kept by **@FuzzyLuzzi** and the Disney
Doorables collectors, linked from the Doorables wiki. `tools/build_codes.cjs`
rebuilds `sets/codes-*.json` from a fresh download of it; the sheet itself is
not copied into this repo.

## The thing this app still refuses to do

**It does not show official product photos.** There is no legal, free way for a
private individual to put Just Play or Disney product images into a third-party
app — not by bundling them, not by hot-linking a retailer. Amazon, Target and
Walmart all prohibit hot-linking and gate their image APIs behind approved
affiliate accounts. So instead the app links out to the official page, and lets
the child photograph the figures he actually owns. That is legally clean, and
a shelf of his own photos is better than a borrowed catalogue anyway.

**Fan art does not solve this either**, which is worth writing down because it
looks like it should. A Creative Commons licence on a drawing of Darth Vader
covers only the artist's own brushwork; it cannot grant rights in Lucasfilm's
character design, which is the entire reason anyone would want the picture.
Under 17 U.S.C. § 103(b) and the US Copyright Office's Circular 14, copyright
in a derivative work reaches only what the later author added. Creative Commons
says the same thing in its own FAQ: *"the CC license only applies to the rights
you have in the work"*. Uploading such a drawing to a CC0 site does not launder
it. Nothing Star Wars enters the public domain until the 2070s.

Character **names** are fine: names are not copyrightable (37 CFR § 202.1(a)),
and listing them to identify actual toys is textbook nominative trademark fair
use. The app carries an unaffiliated-with-Lucasfilm notice to keep that clear.

## How trustworthy is the data?

Series 1 and 2 were built from the Disney Doorables community wiki, HobbyDB and
Coleka. Series 3, 4 and 5 came from the code spreadsheet. The two were then
compared: **for all 50 figures across Series 1 and 2, every name, rarity tier
and bag number agreed exactly** — two independent sources, no conflicts. That
is why the later three are trusted from the sheet alone.

Just Play never published a checklist online and has taken several of its own
product pages down, so there is no official source left to check against. The
app says so, on screen, under the progress bar.

Where something is *not* confirmed, the app says that too, in the same place:

- **Series 3 and 4 capsule colours are unknown.** The capsule is also no longer
  a Death Star from Series 3 onward — 3 and 4 are cargo-drop capsules and 5 is
  a grey AT-AT. Getting that wrong would send a child to the wrong box, so the
  app names the shape and tells him to check the printed series number.
- **Series 4 may have 50 figures in two waves.** Just Play's own description
  says 50 while shops list 25. The app ships the 25 that have recorded codes
  and says the rest may exist.
- **Series 5 rarities are unofficial.** Just Play had not published the rarity
  sheet, and collectors disagree.

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
from, a shipped code mapping must carry its provenance and must name four real
figures from its own set, a disputed code must keep every version reported
rather than picking one, and a set must not claim to be verified while
containing unconfirmed entries.

```
index.html              one page: picker, grid, finder, figure card
app.js                  storage, photos, code lookup, rendering
sets/                   one file per collection, plus codes-*.json
tools/build_codes.cjs   rebuilds the code files from the community sheet
tools/build_sets.cjs    rebuilds the set files and the index
tools/make_icons.py     regenerates the home screen icons
```

Progress lives in `localStorage`; photos live in IndexedDB, shrunk to 480px
first — a few full-size phone photos would blow the quota and start throwing,
taking the progress data down with them.

## Sharing a collection between devices

Optional, off until switched on, and the app is fully usable without it.

One **family code** — four words like `comet-ewok-brave-moon` — identifies a
collection. There is no account and no password, because the person using this
is six. He can read four words off a sticky note once; he cannot manage a login.

Turn it on, and the code appears. Type it on a second device and the two keep
each other up to date: found marks, spares, codes he has written down, and his
photos.

### What it costs

Nothing. It runs on a Cloudflare Worker with a KV namespace, and a family's
whole collection is about 12KB of progress plus a few tens of KB per photo —
comfortably inside the free tier.

Workers KV allows 1,000 writes a day but 100,000 reads, so the design spends
reads instead of writes: a push whose merged result matches what is stored
costs a read and nothing else, photos are written only when their hash changes,
and the client waits for a lull before pushing at all. Rate limiting uses the
Workers rate limiting binding rather than a KV counter, which would have spent
the budget it exists to protect.

### Not losing a child's collection

The merge lives only on the server, in `worker/src/merge.js`, so two devices
can never disagree about what merging means. Two rules carry it:

- **The key set is the union of both sides.** Absence is never a delete
  instruction. A reinstalled device pushes `{}` and gets the whole collection
  back rather than erasing it — the disaster this design exists to prevent, and
  the case both test suites check explicitly.
- **Newest wins per figure**, not per document. Whole-document last-write-wins
  would throw away everything the other device did since the last sync.
  Un-ticking still works: it is an edit with a newer timestamp.

A device whose clock is set wrong is clamped to server time, or its timestamps
would beat everything real forever and freeze the collection.

### When it syncs

Shortly after the app opens, after an edit once things go quiet, when the app
is brought back to the front, and when the network comes back.

**There is no periodic poll.** A device left untouched with the app open will
show stale data until something wakes it. That is a deliberate trade, and it is
safe because of the merge rather than the timing: being stale costs a stale
*screen*, never data. When that device does sync, the union rule means nothing
it holds is dropped and per-figure newest-wins means nothing it did is
overwritten — it catches up rather than losing.

Coming back to the app is also the only moment staleness could matter, since it
is the moment somebody looks at the screen. Phones fire that event on app
switch, tab change and screen lock, so in practice it fires constantly. The
two-device test pins it.

### How safe is it?

The code is the only protection, which is a deliberate trade. It is generated,
never chosen, so it cannot be a birthday. 256 words to the fourth power is 4.3
billion combinations, and the worker rate limits per IP, so guessing is not
realistic. Requests from any origin other than the app's own are refused, so a
random page cannot read the collection using a cached code.

What is stored is a list of toy names and photos of toys. Anyone holding the
four words can read and change it, so keep them in the family; if they leak,
turn sharing off and on again for a new code.

## Tests

```powershell
node --test "tests/*.test.mjs"                    # data, honesty, install, merge
node tests/collect.cjs "<path to msedge.exe>"     # drives the real page
node tests/sync.cjs "<path to msedge.exe>"        # two real browsers, one collection
node tests/sync.cjs "<path to msedge.exe>" --live # ...against the PUBLISHED site and worker
node tools/check_live.cjs                         # the deployed worker, over the internet
node tools/screenshots.cjs                        # one shot per screen
```

`collect.cjs` picks a set, marks a figure, records a code, reloads to prove the
progress survived, checks the sets keep separate progress, exercises the code
finder, then **kills the server and tells the browser it is offline** and
reopens a set that was never opened while online — proving both the checklist
and the code lookup come from the precache.

`sync.cjs` runs **two real browser profiles** against the real worker code and
checks they converge: both devices edit at once and neither loses its work, an
un-tick propagates, a photo arrives byte for byte, a deleted photo stays
deleted, a mistyped code is refused, and an emptied device gets everything back
instead of wiping the other one.

Regressions these now pin, all found the hard way:

- **Routes could race.** Switching sets before the first finished loading let
  the abandoned one finish last and win, leaving the right title above the
  wrong figures. Offline that window is seconds wide.
- **Offline used to cost 2.5 seconds a tap.** The service worker waited out its
  network timeout before falling back to cache, even when the device already
  knew it had no connection. It now answers immediately in that case — 2322ms
  to 110ms — and the test asserts the timing, not just the outcome.
- **KV `list()` is eventually consistent.** A freshly uploaded photo took about
  twenty seconds to appear in it, so photos synced late and a deleted one could
  be resurrected. The worker now keeps an explicit index key, which is strongly
  consistent. This one only ever failed against the deployed worker, because
  the local test double answered immediately — so the double now lags on
  purpose.
- **The privacy test only read `app.js`.** Sync arrived in new files and sent
  data off the device without the test noticing. A guard now checks the list of
  inspected scripts against what `index.html` actually loads.
