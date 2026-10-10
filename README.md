# Cincy Transit Live

A live map of Cincinnati Metro and TANK (Northern Kentucky) buses, drawn as a
[p5.js](https://p5js.org) sketch over neighborhood, city and township
boundaries. Three lenses colour the map by **route**, by **lateness**, or by
**time lost**: where along the network buses fall behind schedule, built from
history the server records itself.

```
node server.js          # → http://localhost:8000   (PORT=… to change)
```

Needs Node.js 18 or later (it uses the built-in `fetch`). There are no npm packages to install.
The first start downloads both agencies' timetables and the boundary data
into `data/`, which takes a minute or so. Later starts read from the cache.

Unofficial and provided as-is. See [License](#license) and [Data sources](#data-sources).

---

## Architecture

```
 Agency feeds (GTFS-realtime, protobuf)        Static GTFS zips           ArcGIS / TIGERweb
 Metro: tmgtfsprd.sorttrpcloud.com             go-metro.com               CAGIS, Covington, KY,
 TANK:  tank.rideralerts.com/InfoPoint         tank.rideralerts.com       US Census
            │  every request (10 s cache)            │ weekly                   │ once
            ▼                                        ▼                          ▼
 ┌──────────────────────────────────── server.js (Node, no dependencies) ───────────────────────────┐
 │ protobuf reader → vehicles, trip delays, alerts      zip + CSV reader → network, timetable,     │
 │                                                       stop names/roles                          │
 │ history recorder (every 30 s, always on) ──► data/history/YYYY-MM-DD.jsonl (24 h kept)          │
 │ boundary + geography builders ──► data/neighborhoods.json, data/geography.json                  │
 └──────────────── JSON over /api/* ─────────────────────── static files from public/ ────────────┘
            ▼
 ┌──────────────────────────────── public/sketch.js (p5.js 1.9.4, browser) ───────────────────────┐
 │ Web Mercator view · cached base layer (areas, tints, river, routes, loss grid) · live buses   │
 │ header / legend / area / alerts / hotspot panels · hover tooltips · About dialog (index.html)  │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why there's a server

Metro's realtime feeds send no CORS headers, so a browser can't fetch them
directly. The server proxies both agencies, decodes the protobuf, and turns
the static GTFS into something the browser can use. It also does the work that
needs memory over time: recording history. Keeping all of that server-side
lets the sketch stay a plain p5.js file with no build step.

### Zero dependencies

Everything uses Node built-ins (`http`, `fs`, `zlib`):

- **Protobuf**: `readMessage()` is a small wire-format reader, about 30 lines
  (varints, length-delimited fields, fixed32/64). Decoders pick out only the
  GTFS-realtime fields the sketch uses.
- **Zip**: `unzip()` walks the central directory and inflates entries with
  `zlib.inflateRawSync`.
- **CSV**: `parseCSV()` handles quoted fields. `stop_times.txt` (~700k rows)
  skips it and splits lines directly for speed.

### Agencies and ids

Both agencies reuse route numbers, so every route and vehicle id is prefixed:
`metro:43`, `tank:1`. The `AGENCIES` table in `server.js` holds each agency's
feed URLs. Adding a third agency is mostly a matter of adding an entry there.

---

## Server (`server.js`)

### Endpoints

| Endpoint | Returns | Browser / CDN cache | Server-side |
|---|---|---|---|
| `/api/manifest` | Versioned URLs of the three static data files | 5 min | Rechecks sources at most hourly |
| `/data/network.<hash>.json` | Routes (name, colour, agency) and thinned route shapes | 1 year, `immutable` | From static GTFS → `data/network.json` |
| `/data/areas.<hash>.json` | ~180 named areas with polygon rings and a `kind` | 1 year, `immutable` | ArcGIS / TIGERweb → `data/neighborhoods.json` |
| `/data/geography.<hash>.json` | Counties tagged by state, and the Ohio River | 1 year, `immutable` | TIGERweb → `data/geography.json` |
| `/api/vehicles` | Live vehicles with `delay` (seconds) attached, plus per-agency `errors` | 10 s | Built once per 10 s for everyone |
| `/api/alerts` | Service alerts | 60 s | Built once per 60 s |
| `/api/timeloss?hours=1\|3\|24&route=metro:43` | Time-lost grid, route totals | 60 s | Built once per 30 s per window/route |

`/api/network`, `/api/neighborhoods` and `/api/geography` still answer with a
5-minute cache for older clients. Everything else is served from `public/`:
`index.html` is cached for 60 s and links `sketch.js?v=<hash>`, which is cached
for a year.

### Bandwidth and caching

Designed to be cheap to host behind a CDN.

- **Compressed once, served many times.** Every body is compressed with gzip
  and brotli when it's built, not per request. Static data uses maximum
  compression, which shrinks it 8–28×; `network` goes from 2.0 MB to 73 KB.
  Live answers use a fast setting, except time lost, which is big enough to
  be worth the CPU.
- **Versioned by content.** Static data and scripts are named by a hash of
  their contents. Browsers and CDNs keep them for a year. A new timetable or
  deploy produces a new name, so nothing ever needs purging. The previous
  version of each data file stays available, for pages that read the
  manifest just before a change.
- **Shared live answers.** Every viewer sees the same vehicles. With a CDN
  honouring `Cache-Control`, the server answers a few times a minute however
  many people are watching. `ETag`s let unchanged answers return `304`.
- **Bounded cache keys.** `hours` is snapped to 1/3/6/12/24 and `route` must
  look like `agency:id`, so neither the server's cache nor a CDN's (which
  includes the query string) can be flooded with variants.
- **The page polls lightly.** Vehicles every 15 s, alerts every 2 min, time
  lost every 5 min. All polling stops while the tab is hidden, and after
  30 minutes without input ("Paused while idle"). It picks up again on the
  next mouse, key or touch.

Measured with brotli: a first visit is about 0.4 MB of this server's data
plus p5.js from cdnjs. A repeat visit downloads no static data at all. An
open tab uses about 1.2 MB an hour for vehicles. The time-lost lens adds
about 1 MB an hour; that figure grows as history builds up over the day.

### Static GTFS

`staticGTFS(agency)` downloads each agency's zip to `data/<agency>/gtfs.zip`
and refreshes it after 7 days. From it the server builds:

- **The network**: routes and shapes, with points thinned to at least ~0.0004° apart (about 40 m). This is
  versioned (`NETWORK_VERSION`), so a format change rebuilds the cache.
- **The timetable**: `buildSchedule()`, per trip, stores an `Int32Array` of
  scheduled seconds indexed by stop sequence.
- **Stops**: `getStops()` tidies names. All-caps names are title-cased, with
  fixes for "Mc" names and acronyms such as UC, NKU and CVG. Shouty words in
  mixed-case names are softened, and "at" becomes "&". Stops are bucketed by
  grid cell for nearest-stop lookups.
- **Stop roles**: `stopRoles()`. A stop is a *route end* (`e`) when at least
  half the trips serving it start or finish there, which is where buses lay
  over. It's a *timepoint* (`t`) when at least half of them mark it
  `timepoint=1`, which is where early buses must wait.

### Lateness

- **Metro** sends predictions but not delays. `decodeTripUpdates()` takes the
  first upcoming stop's predicted time and subtracts the scheduled time. The
  scheduled time is converted to an absolute time from the GTFS service day,
  which starts at noon minus 12 h in the agency's time zone, so it is correct
  across DST and after-midnight trips. Results more than 3 h off are thrown
  out.
- **TANK** reports a delay directly, and the server uses it as-is.

### History: "time lost"

`recordHistory()` runs every 30 s whether or not anyone has the page open.
For each bus that has sent a new report on the same trip as last time, it
records one segment:

```
[time, lat, lon, delayChange, seconds, routeId]
```

The position is the midpoint of the two reports. A segment is dropped if the
gap between reports is under 10 s or over 3 min, or if the delay changed by
more than 10 min, since those are resets rather than traffic. Segments are
appended to `data/history/YYYY-MM-DD.jsonl` and kept for 24 h. Older files
are deleted on startup.

`timeLoss(hours, route)` sums segments into cells of 0.002° lat × 0.0026° lon
(about 220 m square at this latitude). Each cell carries:

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
"township"`, because they overlap the cities inside them. The Census
layers are queried only within the bus network's bounding box. Duplicate names get a county
qualifier, e.g. "Miami Township (Hamilton Co.)".

The area cache is only written when **every** source succeeded, so a
temporary outage doesn't get frozen to disk. `AREAS_VERSION` and
`GEOGRAPHY_VERSION` force rebuilds when the format changes.

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
| `focusRoute` (pinned route) | Drawn on top in its own colour in every lens. Other routes dim. Lateness and loss stats, and the server's grid, are limited to it |
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
server.js            proxy, decoders, GTFS builders, history, area/geography builders
public/index.html    page shell, p5.js from cdnjs, About dialog
public/sketch.js     the p5.js sketch
data/                generated cache (safe to delete; rebuilt on start)
  metro/, tank/        gtfs.zip per agency (refreshed weekly)
  network.json         routes + shapes
  neighborhoods.json   areas
  geography.json       counties + Ohio River
  history/*.jsonl      time-lost segments, last 24 h
LICENSE              MIT
```

Deleting `data/history/` resets time-lost history. Deleting everything else in
`data/` forces a fresh download on the next start.

## Known limits

- Metro's predictions are whole minutes, so short delay changes are coarse.
  Time lost becomes reliable as samples build up over hours.
- A bus with no trip-update prediction has no lateness. The header counts
  these as "no prediction".
- The timepoint test uses the cell's average position. With a route pinned,
  the map works that out from the pinned route's buses, while the legend
  totals use every route's. A cell right at the 120 m cutoff can be judged
  differently by each.
- Boundary sources change occasionally. A failed source just means that
  layer is missing until the next start.

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
the JavaScript successor to Processing.js.

## License

The code in this repository is released under the [MIT License](LICENSE) and is
**provided as-is, without warranty of any kind**. That covers this project's
code only. The transit and boundary data it fetches stay under their
providers' terms, listed above.

p5.js is LGPL-2.1, loaded from cdnjs and not bundled.
