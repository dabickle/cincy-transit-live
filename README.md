# Cincy Transit Live

A live map of Cincinnati Metro and TANK (Northern Kentucky) buses, drawn as a
[p5.js](https://p5js.org) sketch over neighborhood, city and township
boundaries. Three lenses colour the map by **route**, by **lateness**, or by
**time lost**: where along the network buses fall behind schedule, built from
history the app records itself. It runs on Cloudflare Workers.

```
npm install        # wrangler (Cloudflare's CLI), the only dependency, dev-only
npm run dev        # build dist/, then serve everything at http://localhost:8787
npm test           # unit tests (no network)
```

Needs Node.js 22 or later. The first build downloads both agencies'
timetables and the boundary data into `data/`, which takes a minute. Later
builds reuse them. See [Deploying](#deploying) to put it on Cloudflare.

Unofficial and provided as-is. See [License](#license) and [Data sources](#data-sources).

---

## Architecture

```
 Static GTFS zips · ArcGIS / TIGERweb boundaries
            │  at build time: GitHub Actions on every push, and weekly
            ▼
 ┌─ scripts/build-data.mjs (Node, no dependencies) ──────────────────────────────┐
 │ unzip + CSV → routes/shapes, stop names + roles, compact timetables           │
 │ boundaries → areas, counties + Ohio River                                     │
 │ writes dist/: content-hashed /v/* files, manifest.json, _headers, the sketch  │
 └──────────────────────────────────────┬────────────────────────────────────────┘
                                        │ wrangler deploy
                                        ▼
 ┌─ Cloudflare ───────────────────────────────────────────────────────────────────┐
 │ Static assets (dist/): served from the edge, cached for a year, never run code │
 │                                                                                │
 │ Worker (src/worker.js): /api/vehicles, /api/alerts, /api/timeloss, /api/otp    │
 │   └─ caches each answer in the local data centre for 10–300 s                  │
 │        │ cache miss                                                            │
 │        ▼                                                                       │
 │ Durable Object "Recorder" (one instance, SQLite storage)                       │
 │   ├─ fetches Metro + TANK GTFS-realtime (protobuf), ≤ once per 10 s            │
 │   ├─ alarm every 30 s: time-lost history (24 h) + on-time totals (kept)        │
 │   └─ reads stops + timetables from the static assets it shipped with           │
 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                        ▼
 ┌─ public/sketch.js (p5.js 1.9.4, browser) ──────────────────────────────────────┐
 │ Web Mercator view · cached base layer (areas, tints, river, routes, loss grid) │
 │ live buses · panels · tooltips · About dialog (index.html)                     │
 └────────────────────────────────────────────────────────────────────────────────┘
```

### Why it's split this way

Metro's realtime feeds send no CORS headers, so a browser can't fetch them
directly; something has to proxy them. Each kind of work goes to the part of
Cloudflare that suits it:

- **Anything that changes weekly or less is built ahead of time.** Parsing
  the timetable zips (~700k scheduled stops) and querying the boundary
  services happens in CI, not on a request path. The results are plain static
  files: free to serve, cached at the edge, and unaffected by load.
- **Live data needs one shared fetcher.** A single Durable Object fetches the
  agencies' feeds at most once per 10 s, so their load stays flat however
  many people are watching.
- **History needs something always on.** The same object's alarm wakes it
  every 30 s, with or without visitors. Workers cron triggers only go down to
  once a minute.

### Zero runtime dependencies

The Worker and the build script use only built-in APIs. Wrangler is the only
npm package, and it's a dev tool.

- **Protobuf** (`src/shared/realtime.js`): `readMessage()` is a small
  wire-format reader, about 30 lines (varints, length-delimited fields,
  fixed32/64). Decoders pick out only the GTFS-realtime fields the sketch
  uses. It uses `TextDecoder` and `DataView` rather than Node's `Buffer`, so
  the same code runs in Node (tests) and in Workers.
- **Zip** (build script): walks the central directory and inflates entries
  with `zlib.inflateRawSync`.
- **CSV** (build script): `parseCSV()` handles quoted fields.
  `stop_times.txt` skips it and splits lines directly for speed.

### Agencies and ids

Both agencies reuse route numbers, so every route and vehicle id is prefixed:
`metro:43`, `tank:1`. `src/shared/agencies.js` holds each agency's feed and
timetable URLs. Adding a third agency is mostly a matter of adding an entry
there.

---

## Build (`scripts/build-data.mjs`)

Writes `dist/`, which Cloudflare serves as static assets:

| File | Contents | Used by |
|---|---|---|
| `/v/network.<hash>.json` | Routes (name, colour, agency) and route shapes thinned to points about 40 m apart | sketch |
| `/v/areas.<hash>.json` | ~180 named areas with polygon rings and a `kind` | sketch |
| `/v/geography.<hash>.json` | Counties tagged by state, and the Ohio River | sketch |
| `/v/stops.<hash>.json` | `[name, lat, lon, flags]` per stop | Recorder (naming time-lost spots) |
| `/v/timetable-<agency>.<hash>.json` | Scheduled times per trip | Recorder (Metro's lateness) |
| `/v/sketch.<hash>.js`, `index.html` | The page; `index.html` links the hashed sketch | browser |
| `manifest.json` | Which `/v/` files are current | sketch, Recorder |
| `_headers` | Cache rules: `/v/*` for a year (`immutable`), the manifest for 5 min | Cloudflare |

Downloads are cached in `data/`: GTFS for 7 days, boundaries for 30. If a
boundary source is down, the build uses the last complete copy. With no copy
at all the build fails, so a deploy never ships with areas missing. In CI,
`data/` is carried between runs with `actions/cache`.

### Static GTFS

- **Stops**: names are tidied. All-caps names are title-cased, with fixes for
  "Mc" names and acronyms such as UC, NKU and CVG. Shouty words in mixed-case
  names are softened, and "at" becomes "&".
- **Stop roles**: a stop is a *route end* (`e`) when at least half the trips
  serving it start or finish there, which is where buses lay over. It's a
  *timepoint* (`t`) when at least half of them mark it `timepoint=1`, which
  is where early buses must wait.
- **Timetables** are delta-encoded per trip. Metro numbers each trip's stops
  1, 2, 3…, so a trip is `[firstSeq, t0, t1−t0, …]`. TANK numbers them 0, 50,
  85…, so a trip is `{seq: […], t: […]}`, both delta-encoded. That takes them
  from 18 MB to 2.5 MB, and `loadSchedule()` restores exact times.

### Areas

Area sources are fetched from public ArcGIS REST services as GeoJSON and
normalized into `{name, aliases, rings, kind}`:

| Builder | Areas | Source |
|---|---|---|
| `cincinnati` | Cincinnati's neighborhoods (OTR, CUF, …) | CAGIS |
| `covington` | Covington's neighborhoods (MainStrasse, …) | City of Covington |
| `nkyCities` | Other cities in Boone, Kenton and Campbell counties | Kentucky state GIS |
| `ohioPlaces` | Ohio cities and villages (Norwood, St. Bernard, …) | Census TIGERweb Places |
| `ohioTownships` | Ohio townships | TIGERweb County Subdivisions |
| `kyCommunities` | Unincorporated KY communities (Burlington, …) | TIGERweb CDPs |
| `kyCounties` | "Unincorporated Boone County", etc. | TIGERweb Counties |

Kentucky has no townships, so census-designated places plus a county
catch-all fill that role. Townships and county catch-alls are `kind:
"township"`, because they overlap the cities inside them. The Census layers
are queried only within the bus network's bounding box. Duplicate names get a
county qualifier, e.g. "Miami Township (Hamilton Co.)". `AREAS_VERSION` and
`GEOGRAPHY_VERSION` force a refetch when the format changes.

---

## Worker (`src/worker.js`)

### Endpoints

| Endpoint | Returns | Cache (browser + Cloudflare) | Recorder rebuilds it |
|---|---|---|---|
| `/api/vehicles` | Live vehicles with `delay` (seconds) attached, plus per-agency `errors` | 10 s | at most every 10 s |
| `/api/alerts` | Service alerts | 60 s | at most every 60 s |
| `/api/timeloss?hours=1\|3\|24&route=metro:43` | Time-lost grid, route totals | 60 s | at most every 30 s per window/route |
| `/api/otp?days=30&route=metro:43` | On-time totals per day and per hour of day | 5 min | at most every 5 min per window/route |

`hours` is snapped to 1/3/6/12/24, `days` to 7/30/90/365, and `route` must look like `agency:id`, so
the caches can't be flooded with variants. The Worker caches each answer with
the Cache API, which is per data centre and **only works on a custom domain**.
On `*.workers.dev`, every request reaches the Recorder, which is fine at small
scale because the Recorder memoizes its answers too.

### Recorder (the Durable Object)

One instance (`idFromName("main")`), holding what a long-running server would:

- **Feeds**: each agency's decoded feed, shared for 10 s.
- **Static data**: stops and timetables, read once from the deploy's static
  assets through the `ASSETS` binding.
- **History**: its SQLite storage has one row per 30 s tick, holding that
  tick's segments as JSON, rather than one row per segment. That keeps writes
  around 2,900 a day. Each bus's previous report is saved too, in one row
  rewritten each tick, because the object can be evicted between alarms.
  History survives evictions and deploys.
- **On-time totals**: the `otp` table, kept indefinitely. See below.
- **Alarm**: every 30 s, `alarm()` records history and on-time passages, and
  re-arms itself. A
  Worker cron trigger every 10 minutes makes sure the alarm exists, e.g.
  right after the first deploy.

### Lateness

- **Metro** sends predictions but not delays. `decodeTripUpdates()` takes the
  first upcoming stop's predicted time and subtracts the scheduled time. The
  scheduled time is converted to an absolute time from the GTFS service day,
  which starts at noon minus 12 h in the agency's time zone, so it is correct
  across DST and after-midnight trips. Results more than 3 h off are thrown
  out.
- **TANK** reports a delay for each stop directly; the first upcoming stop's
  is used.

`decodeTripUpdates()` also returns each trip's next stop
`[stop_sequence, stop_id]`, which the on-time stats use.

### History: "time lost"

Every 30 s, for each bus that has sent a new report on the same trip as last
time, the Recorder records one segment:

```
[time, lat, lon, delayChange, seconds, routeId]
```

The position is the midpoint of the two reports. A segment is dropped if the
gap between reports is under 10 s or over 3 min, or if the delay changed by
more than 10 min, since those are resets rather than traffic.

`timeLoss()` (`src/shared/timeloss.js`) sums segments into cells of 0.002°
lat × 0.0026° lon (about 220 m square at this latitude). Each cell carries:

- total delay change, seconds travelled, sample count;
- the **average sample position**: where in the cell buses actually were,
  which is used for the tooltip ring and for naming the spot;
- up to three **nearest stops** `[name, metres, flags]` near that position.
  "A & B" and "B & A" are merged. Stop names are almost always intersections,
  which is how a cell gets a name like "Vine St & 12th St".

The rate shown everywhere is `60 × change / seconds`, in **seconds lost per
minute of travel**. Negative means buses are making time up.

With `route=`, the grid only counts that route. Two sets of per-route totals
always cover every route:

- `routes`: everything;
- `routesNoTimepoints`: leaves out cells with a timetable timepoint within
  120 m of the cell's average position. Early buses waiting there is
  scheduled, not lost time.

### On-time stats over time

The time-lost history only covers 24 hours. For weeks and months the
Recorder keeps running totals instead of raw readings (`src/shared/otp.js`):

- **A passage** is a bus passing a stop: its trip's next stop moved on
  between ticks. The delay last predicted for the stop it left is recorded
  as its lateness there. Counting once per stop, rather than once per tick,
  keeps slow, late buses from being counted more often than quick ones.
- **Totals** are kept per local date × route × hour × timepoint-or-not:
  number of passages, summed delay, and counts in fixed buckets
  (`<-1m, -1–0, 0–1, 1–3, 3–5, 5–10, 10–20, >20 min`). On-time %, share late
  and rough percentiles all come from the buckets.
- **Timepoints** are the stop ids the build marks as mostly `timepoint=1`
  (shipped in each timetable file). On-time % is quoted there, as agencies
  usually do; the sketch falls back to all stops for a route with too few.
- **Writes**: totals build up in memory and are saved, with each bus's last
  next-stop, in one state row per tick (so an eviction loses nothing). Every
  5 minutes they are added to the `otp` table with an upsert, a few hundred
  rows at a time. That's a few thousand rows a day, roughly 1M a year:
  inside Workers Paid's included storage and writes.
- **Keyed by route, not trip**: trip ids change with every timetable, routes
  don't, so totals stay comparable across schedule changes.

These are predictions and position reports, not the agencies' official
arrival records, so figures will be close to but not the same as published
on-time performance. Gaps in the feeds are missing data, not on-time buses;
the passage count shows how much each day rests on.

### Bandwidth and cost

- **Static files are versioned by content.** Browsers and Cloudflare keep
  `/v/*` for a year. A new timetable or deploy produces new names, so nothing
  ever needs purging. If a page loaded the manifest just before a deploy and
  gets a 404, it rereads the manifest and retries once.
- **Cloudflare compresses** JSON and JS on the way out, so the sketch's data
  arrives at roughly a tenth of its size (`network`: 2.0 MB → ~75 KB).
- **The page polls lightly.** Vehicles every 15 s, alerts every 2 min, time
  lost every 5 min. All polling stops while the tab is hidden, and after
  30 minutes without input ("Paused while idle"). It picks up again on the
  next mouse, key or touch.
- **On Workers Paid ($5/month)** this fits within the included usage:
  - the Recorder's alarm is ~86,000 requests a month (1 million included);
  - SQLite writes are ~180,000 a month (50 million included);
  - static asset requests are free, and Cloudflare charges nothing for data
    transfer.

  The free plan's 10 ms CPU limit per request is too tight for time lost.

---

## Sketch (`public/sketch.js`)

### Rendering

- **Projection**: Web Mercator onto a unit square, with a `view` of
  `{x, y, scale}` for pan and zoom.
- **Base layer**: everything static is drawn into an offscreen
  `createGraphics` and only redrawn when `layerDirty` is set: area shading,
  state tints, the river, route lines and the time-lost grid. Each frame blits
  it, then draws buses, trails, bunching links and panels on top.
- **Areas** are filled with the even-odd rule, so holes and multi-part
  polygons just work. Township areas go down first. Incorporated areas are
  then cut out of them with `destination-out`, so a township only shades the
  land no city claims. The state tints go *under* everything with
  `destination-over`.
- **The river** is drawn as a stroked edge followed by a fill, which gives it
  a crisp bank line. The OHIO / KENTUCKY labels sit either side of where the
  river crosses the centre of the view (`riverCrossings`).
- **p5 style cache**: p5 skips re-setting a fill or stroke it thinks is
  current. After drawing straight onto the canvas 2D context, `resyncStyles()`
  makes it forget, otherwise colours leak between layers.
- **Buses** glide between reports over 2.5 s (smoothstep) and keep a short
  trail. Metro buses are circles and TANK buses are squares, with a bearing
  arrow when the feed reports one.

### Lenses and state

| State | Effect |
|---|---|
| `colorBy` = `route` / `delay` / `loss` | Route colours; a lateness ramp per bus and per area (median); the time-lost grid, area rates, worst spots, Hotspots window |
| `focusRoute` (pinned route) | Drawn on top in its own colour in every lens. Other routes dim. Lateness and loss stats, and the server's grid, are limited to it. The header shows its 30-day on-time trend: one bar per day (hover for that day), the share on time and late, and its worst hour |
| `focusHood` (focused area) | Area panel with its routes, buses, lateness or worst spots. Combines with a pinned route |
| `hideTimepoints` | Time-lost lens ignores timepoint cells. Recomputed client-side by `summarizeLoss()`; legend uses `routesNoTimepoints` |
| `agencyOn` | Hide Metro or TANK. Hiding the agency of a pinned route unpins it |

Panels are laid out each frame. The header and legend are fixed. The area
panel and alerts stack up from the bottom-left (`bottomStack`), and the
Hotspots window takes whatever height is left under the header. Panel
rectangles go into `panels[]`, so map hover and clicks ignore anything under
a panel.

### Derived signals

- **On time**: from 1 min early to 5 min late (`ON_TIME`).
- **Bunching** (`findBunches`): same route, headings within 45°, closer than
  500 m, and at least one of the pair has moved more than 25 m. Heading falls
  back to the course between reports when the feed's bearing is missing.
  Movement is only measured when the report timestamp changes, so a bus isn't
  counted as parked just because it hasn't reported yet.
- **Planned waiting**: cells near a route end are always left out of the
  Hotspots list, because layovers swamp everything else. Timepoints are kept,
  but tagged, unless the timepoint filter is on.

### Controls

Drag to pan, scroll to zoom. Click a bus or legend row to pin its route.
Click an area to focus it; double-click zooms to it. Hover a time-lost cell to
see where it is. Click a Hotspots row to jump there.

| Key | |
|---|---|
| `D` | Cycle lens: route → lateness → time lost |
| `F` | Fit the network in view |
| `T` / `L` / `N` / `B` | Toggle trails / route lines / areas / bunching links |
| `I` | About (sources, licenses) |
| `Esc` | Clear area focus, then the pinned route |

URL options: `?color=delay|loss`, `?route=43` (Metro first; `?route=tank1` for
TANK), `?hood=otr` (any area name), `?timepoints=exclude`.

---

## Files

```
src/worker.js             Worker (live API) + Recorder Durable Object
src/shared/agencies.js    feed and timetable URLs per agency
src/shared/realtime.js    protobuf reader, GTFS-realtime decoders, delay maths
src/shared/timeloss.js    history segments, grid, nearest stops
src/shared/otp.js         stop passages and on-time totals
scripts/build-data.mjs    builds dist/ from GTFS + boundary sources
public/index.html         page shell, p5.js from cdnjs, About dialog
public/sketch.js          the p5.js sketch
test/shared.test.js       unit tests for src/shared (npm test)
wrangler.toml             Cloudflare config: assets, Durable Object, cron
.github/workflows/        test, build and deploy
data/                     download cache (git-ignored; safe to delete)
dist/                     build output (git-ignored)
LICENSE                   MIT
```

## Deploying

The repo deploys itself from GitHub. Every push to `main`, and a weekly run
that picks up new timetables, tests, builds and deploys to Cloudflare. Pull
requests are tested and built, but not deployed.

**One-time setup:**

1. Create a Cloudflare account and subscribe to **Workers Paid** ($5/month).
   Durable Objects work on the free plan, but its 10 ms CPU limit per request
   is too tight for time lost.
2. In Cloudflare, create an API token from the **"Edit Cloudflare Workers"**
   template. Note your **Account ID** from the Workers overview page.
3. In GitHub, go to **Settings → Secrets and variables → Actions** and add the
   repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main`, or run the workflow by hand from the Actions tab. The site
   appears at `https://cincy-transit-live.<your-subdomain>.workers.dev`.
5. **Add your domain**: Workers → cincy-transit-live → Settings → Domains &
   Routes → Add → Custom domain. The domain's DNS must be on Cloudflare. This
   also turns on the Worker's Cache API, so most API requests are answered
   from the local data centre.

**Deploying from your machine instead:** `npx wrangler login`, then
`npm run deploy`.

**Things to know:**

- History starts empty on the first deploy, and fills over the next hours.
  On-time trends need a few days. Later deploys keep both.
- GitHub turns off scheduled workflows in a public repo after 60 days without
  activity. The weekly timetable refresh then stops until you push something
  or re-enable it in the Actions tab.
- Set a **billing notification** in Cloudflare (Manage Account → Billing →
  Billable Usage notifications) as a guardrail.
- `npx wrangler tail` streams the live Worker's logs.

## Known limits

- Metro's predictions are whole minutes, so short delay changes are coarse.
  Time lost becomes reliable as samples build up over hours.
- A bus with no trip-update prediction has no lateness. The header counts
  these as "no prediction".
- The timepoint test uses the cell's average position. With a route pinned,
  the map works that out from the pinned route's buses, while the legend
  totals use every route's. A cell right at the 120 m cutoff can be judged
  differently by each.
- Timetables only change when the site is rebuilt (weekly). If an agency
  publishes a new timetable mid-week, Metro's lateness can be off for trips
  that changed until the next build. Run the workflow by hand to pick it up
  sooner.

## Data sources

- **Cincinnati Metro (SORTA)**: GTFS and GTFS-realtime.
  [Developer data](https://www.go-metro.com/about/developer-data/). Under
  SORTA/Metro's developer license: non-exclusive, limited, revocable, as-is.
  Metro's marks may not be used with the data without written approval.
- **TANK**: GTFS and GTFS-realtime via
  [InfoPoint](https://tank.rideralerts.com/InfoPoint/). Offered free to
  developers; no written license found.
- **City of Cincinnati / CAGIS**: neighborhoods. As-is under the
  [CAGIS data disclaimer](https://cagis.org/Opendata/).
- **City of Covington**: neighborhoods, from an ArcGIS Online layer. No license
  stated.
- **Commonwealth of Kentucky** ([KyGeoNet](https://kygeonet.ky.gov/)): city
  limits. Data from KYTC, the Division of Geographic Information and NKAPC. No
  license stated.
- **U.S. Census Bureau** [TIGERweb](https://tigerweb.geo.census.gov/): places,
  townships, CDPs, counties, Ohio River. Public domain.

The in-app About page (`I`) has the same list with links. These summaries
aren't legal advice; check each provider's terms before reusing their data.
This project is not affiliated with or endorsed by any of them.

## How it was made

Written with [Claude Code](https://claude.com/claude-code) as a p5.js sketch,
the JavaScript successor to Processing.js, and deployed on Cloudflare Workers.

## License

The code in this repository is released under the [MIT License](LICENSE) and is
**provided as-is, without warranty of any kind**. That covers this project's
code only. The transit and boundary data it fetches stay under their
providers' terms, listed above.

p5.js is LGPL-2.1, loaded from cdnjs and not bundled.
