// Cincinnati Metro + TANK (Northern Kentucky) — live bus positions in p5.js.
// Metro buses are circles, TANK buses are squares.
//
// Static data is built by scripts/build-data.mjs; /manifest.json names the
// current versioned files (cached for good):
//   network: route list + route shapes (static GTFS)
//   areas: neighborhoods, cities, villages, townships
//   geography: the Ohio River, and counties tagged by state
// Live data comes from the Cloudflare Worker (src/worker.js):
//   /api/vehicles  live vehicle positions, with each bus's delay in seconds
//   /api/alerts    service alerts
//   /api/timeloss   where buses have been losing time (recorded every 30 s)
//
// To keep bandwidth down, polling stops while the tab is hidden or nobody has
// touched the page for IDLE_MS, and picks up again on the next mouse/key/touch.
//
// Controls: drag to pan · scroll to zoom · click a bus or legend row to pin
// its route (it stays highlighted in every colour mode, and the lateness and
// time-lost lenses then describe just that route) · click a neighborhood to
// focus it (double-click zooms to it); a pinned route and a focused area
// combine · Esc clears the area focus, then the pinned route · D cycles colour modes (route, lateness, time lost) ·
// F refits · T toggles trails · L toggles route lines · N toggles
// neighborhoods · B toggles bunching links · I opens About (sources, licenses)
//
// Bunching: two buses on the same route, heading the same way, within
// BUNCH_METERS of each other (and not both parked) are linked on the map.
//
// URL options: ?color=delay or ?color=loss picks the colour mode, ?route=43
// pins a route (Metro first; ?route=tank1 for TANK's), ?hood=otr focuses a
// neighborhood or city (any name, e.g. ?hood=mainstrasse, ?hood=norwood).
// ?timepoints=exclude starts the time-lost lens with timepoints left out.

const POLL_MS = 15000;     // how often to ask for new positions
const GLIDE_MS = 2500;     // how long a bus takes to glide to its new spot
const TRAIL_LEN = 24;      // reported positions kept per bus
const ON_TIME = [-60, 300]; // usual transit definition: ≤1 min early, ≤5 min late
const BUNCH_METERS = 500;  // same route + direction this close = bunched
const ALERTS_MS = 120000;  // alerts change rarely
const LOSS_POLL_MS = 300000; // time-lost history moves slowly
const IDLE_MS = 30 * 60000; // stop polling after this long without input
const LOSS_MIN_SAMPLES = 3; // per grid cell before it's drawn
const AREA_LOSS_MIN_SAMPLES = 10;
const SPOT_MIN_SAMPLES = 5;   // per cell before it can be a "worst spot"
const HOTSPOT_ROWS = 8;

// Time-lost ramp: [seconds of delay gained per minute of travel, colour].
// Negative means buses make time up there.
const LOSS_STOPS = [
  [-20, "#4aa8ff"],
  [0, "#7d8794"],
  [10, "#f5d14a"],
  [20, "#ff9a3c"],
  [40, "#ff5a5a"],
];

// Lateness colour ramp: [seconds late, colour].
const DELAY_STOPS = [
  [-180, "#4aa8ff"],
  [-60, "#4cd97b"],
  [120, "#4cd97b"],
  [300, "#f5d14a"],
  [600, "#ff9a3c"],
  [1200, "#ff5a5a"],
];

let network = null;
let routes = {};           // id → { name, longName, color, shapes: [[x,y]...] }
let vehicles = {};         // id → { from, to, t0, trail, data }
let alerts = [];
let lastUpdate = null;
let feedError = null;

let view = { x: 0, y: 0, scale: 1 };   // centre in mercator units + px per unit
let bounds = null;
let routeLayer;                        // cached drawing of neighborhoods + route lines
let layerDirty = true;

let focusRoute = null;
let hoverVehicle = null;
let showTrails = true;
let showLines = true;
let legendRows = [];
let colorBy = "route";     // "route", "delay" or "loss"
let buttons = [];          // header buttons, rebuilt every frame: { x, y, w, h, onClick }
let bunches = [];          // [{ a, b, meters }] pairs of bunched vehicles
let showBunches = true;
let loss = null;           // last /api/timeloss response, cells indexed by key
let lossHours = 3;
let hideTimepoints = false; // leave timepoint cells out of the time-lost lens
let hoverCell = null;
let headerBottom = 0;      // y where the header panel ends, for stacking below it
let hotspotRows = [];      // clickable rows in the hotspots window
let spotlight = null;      // { cell, until } ring drawn after jumping to a hotspot
let bottomStack = 0;       // top of the panels stacked in the bottom-left corner
let agencyNames = {};      // "metro" → "Metro"
let agencyOn = {};         // agencies currently shown

let hoods = [];            // { name, aliases, rings, bbox, label, routes: Set, vehicles: [] }
let geo = null;            // { counties: [{ state, rings }], river: [{ rings }] }

// Background tints: Ohio warm, Kentucky cool, Indiana barely there.
const STATE_TINT = { OH: "rgba(255,190,120,0.05)", KY: "rgba(110,170,255,0.07)", IN: "rgba(255,255,255,0.015)" };
const RIVER_FILL = "#17324e";
const RIVER_EDGE = "rgba(120,175,240,0.55)";
let focusHood = null;
let hoverHood = null;
let showHoods = true;

// ---------------------------------------------------------------------------
// Projection (Web Mercator, unit square)

function mercator(lat, lon) {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

const toScreen = ([x, y]) => [(x - view.x) * view.scale + width / 2, (y - view.y) * view.scale + height / 2];
const toWorld = (sx, sy) => [(sx - width / 2) / view.scale + view.x, (sy - height / 2) / view.scale + view.y];

function fitView(b = bounds, frac = 0.9) {
  if (!b) return;
  view.x = (b.minX + b.maxX) / 2;
  view.y = (b.minY + b.maxY) / 2;
  view.scale = frac * Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY));
  layerDirty = true;
}

// ---------------------------------------------------------------------------
// Data

// Static data lives at versioned URLs (/v/name.<hash>.json) that browsers and
// Cloudflare cache for good; the manifest (cached for minutes) names the
// current versions. If a deploy replaced them since the manifest was read,
// read it again and retry once.
let manifest = null;
async function getStatic(name, retry = true) {
  manifest ||= fetch("/manifest.json", retry ? undefined : { cache: "no-cache" }).then((r) => r.json());
  const url = (await manifest)[name];
  if (!url) throw new Error(`${name} isn't available yet`);
  const res = await fetch(url);
  if (res.status === 404 && retry) {
    manifest = null;
    return getStatic(name, false);
  }
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

async function loadNetwork() {
  network = await getStatic("network");
  agencyNames = network.agencies;
  for (const a in agencyNames) agencyOn[a] = true;

  // Both agencies reuse a few colours across many routes, so spread every bus
  // route around the colour wheel instead. The streetcar keeps its own colour.
  const order = Object.keys(agencyNames);
  const buses = network.routes.filter((r) => r.type === 3);
  buses.sort(
    (a, b) => order.indexOf(a.agency) - order.indexOf(b.agency) || parseInt(a.name) - parseInt(b.name) || a.name.localeCompare(b.name)
  );
  colorMode(HSB, 360, 100, 100);
  buses.forEach((r, i) => {
    routes[r.id] = { ...r, color: color((i * 137.508) % 360, 55, 95), shapes: [] };
  });
  network.routes
    .filter((r) => r.type !== 3)
    .forEach((r) => (routes[r.id] = { ...r, color: color("#" + (r.color || "ffffff")), shapes: [] }));
  colorMode(RGB, 255);

  bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of network.shapes) {
    const pts = s.pts.map(([lat, lon]) => mercator(lat, lon));
    for (const [x, y] of pts) {
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    }
    routes[s.route]?.shapes.push(pts);
  }
  fitView();
}

async function loadGeography() {
  const raw = await getStatic("geography");
  const project = (f) => ({ ...f, rings: f.rings.map((ring) => ring.map(([lat, lon]) => mercator(lat, lon))) });
  geo = { counties: raw.counties.map(project), river: raw.river.map(project) };
}

// Where a vertical line at world x crosses the Ohio River, as [north, south]
// bank pairs (screen y grows southward). The Census splits the river into
// pieces (e.g. along the state line), so each piece's spans are merged
// with their neighbours to get bank-to-bank spans.
function riverCrossings(pieces, x) {
  const spans = [];
  for (const piece of pieces) {
    const ys = [];
    for (const ring of piece.rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j], [x2, y2] = ring[i];
        if (x1 <= x !== x2 <= x) ys.push(y1 + ((x - x1) * (y2 - y1)) / (x2 - x1));
      }
    ys.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ys.length; i += 2) spans.push([ys[i], ys[i + 1]]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] - last[1] < 2e-6) last[1] = Math.max(last[1], sp[1]); // touching: same channel
    else merged.push([...sp]);
  }
  return merged;
}

async function loadNeighborhoods() {
  const raw = (await getStatic("areas")).areas;
  hoods = raw.map((h) => {
    const rings = h.rings.map((ring) => ring.map(([lat, lon]) => mercator(lat, lon)));
    const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const ring of rings)
      for (const [x, y] of ring) {
        bbox.minX = Math.min(bbox.minX, x); bbox.maxX = Math.max(bbox.maxX, x);
        bbox.minY = Math.min(bbox.minY, y); bbox.maxY = Math.max(bbox.maxY, y);
      }
    // Label at the centroid of the biggest ring.
    const big = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
    return { ...h, rings, bbox, label: ringCentroid(big), routes: new Set(), vehicles: [] };
  });
  // Townships contain some villages, so check them last: a point only
  // counts as township when no city, village or neighborhood claims it.
  hoods.sort((a, b) => (a.kind === "township") - (b.kind === "township"));
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function ringCentroid(ring) {
  let cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  const a = ringArea(ring) * 6;
  return [cx / a, cy / a];
}

// Even-odd test across every ring, so holes and multi-part areas just work.
function inHood(h, [x, y]) {
  const b = h.bbox;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  let inside = false;
  for (const ring of h.rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

const hoodAt = (p) => hoods.find((h) => inHood(h, p)) || null;

// Which routes pass through each neighborhood.
function indexHoodRoutes() {
  for (const id in routes)
    for (const pts of routes[id].shapes)
      for (const p of pts) hoodAt(p)?.routes.add(id);
}

function hoodFromURL() {
  const q = new URLSearchParams(location.search).get("hood");
  if (!q) return;
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const want = norm(q);
  // "Miami Township" also matches "Miami Township (Hamilton Co.)"; when
  // several match, pick the one with the most bus routes.
  const matches = hoods.filter(
    (h) =>
      norm(h.name) === want ||
      norm(h.name.replace(/\s*\(.*\)$/, "")) === want ||
      h.aliases.some((a) => norm(a) === want)
  );
  const h = matches.sort((a, b) => b.routes.size - a.routes.size)[0];
  if (h) zoomToHood(h);
}

let lastActive = Date.now();
let paused = false;   // polling stopped: tab hidden or nobody around
let alertsAt = 0;     // when alerts were last fetched

async function poll() {
  if (document.hidden || Date.now() - lastActive > IDLE_MS) {
    paused = true; // wake() restarts us
    return;
  }
  paused = false;
  try {
    const wantAlerts = Date.now() - alertsAt > ALERTS_MS;
    const [vRes, aRes] = await Promise.all([fetch("/api/vehicles"), wantAlerts ? fetch("/api/alerts") : null]);
    const v = await vRes.json();
    if (v.error) throw new Error(v.error);
    if (aRes?.ok) {
      alerts = (await aRes.json()).alerts || [];
      alertsAt = Date.now();
    }
    ingest(v);
    // One agency can be down while the other still works.
    feedError = v.errors?.length ? v.errors.join("; ") : null;
  } catch (err) {
    feedError = err.message;
  }
  setTimeout(poll, POLL_MS);
}

// Any input counts as someone watching. Coming back from a pause fetches
// straight away, and refreshes time lost if it went stale meanwhile.
function wake() {
  lastActive = Date.now();
  if (!paused || document.hidden || !network) return;
  paused = false;
  poll();
  if (colorBy === "loss" && Date.now() - (loss?.fetchedAt || 0) > LOSS_POLL_MS) fetchLoss();
}

function ingest(feed) {
  lastUpdate = feed.timestamp ? new Date(feed.timestamp * 1000) : new Date();
  const seen = new Set();
  for (const d of feed.vehicles) {
    if (!d.lat || !d.lon) continue;
    seen.add(d.id);
    const p = mercator(d.lat, d.lon);
    const v = vehicles[d.id];
    if (!v) {
      vehicles[d.id] = { from: p, to: p, t0: 0, trail: [p], data: d };
      continue;
    }
    v.from = currentPos(v);
    v.to = p;
    v.t0 = millis();
    // Only measure movement on a new report; the feeds refresh about every
    // 30s, so an unchanged report would make every bus look parked.
    if (d.timestamp !== v.data.timestamp) {
      v.moved = metersBetween(v.data, d);
      // Metro often omits bearing, so remember the direction the bus last moved.
      if (v.moved > 25) v.course = courseBetween(v.data, d);
    }
    v.data = d;
    const last = v.trail[v.trail.length - 1];
    if (last[0] !== p[0] || last[1] !== p[1]) {
      v.trail.push(p);
      if (v.trail.length > TRAIL_LEN) v.trail.shift();
    }
  }
  for (const id in vehicles) if (!seen.has(id)) delete vehicles[id];

  for (const h of hoods) h.vehicles = [];
  for (const v of Object.values(vehicles)) {
    v.hood = hoodAt(v.to);
    v.hood?.vehicles.push(v);
  }
  findBunches();
  layerDirty = true; // neighborhood shading follows the buses
}

function metersBetween(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Same route, heading the same way, close together, and at least one of them
// actually moving (two buses parked at a terminal aren't bunched).
function findBunches() {
  bunches = [];
  const list = Object.values(vehicles).filter((v) => v.data.trip?.routeId && heading(v) != null);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.data.trip.routeId !== b.data.trip.routeId) continue;
      const turn = Math.abs(((heading(a) - heading(b) + 540) % 360) - 180);
      if (turn > 45) continue;
      if (!(a.moved > 25 || b.moved > 25)) continue;
      const meters = metersBetween(a.data, b.data);
      if (meters < BUNCH_METERS) bunches.push({ a, b, meters });
    }
}

// Compass bearing from a to b, in degrees.
function courseBetween(a, b) {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const heading = (v) => v.data.bearing ?? v.course ?? null;

const bunchOf = (v) => bunches.find((p) => p.a === v || p.b === v);

// ---------------------------------------------------------------------------
// Time lost (history recorded by the server)

async function fetchLoss() {
  try {
    const want = focusRoute;
    const q = `hours=${lossHours}${want ? `&route=${encodeURIComponent(want)}` : ""}`;
    const data = await (await fetch(`/api/timeloss?${q}`)).json();
    if (want !== focusRoute) return; // pin changed while this was in flight
    data.fetchedAt = Date.now();
    data.byKey = new Map();
    data.cells = data.cells.map(([lat, lon, change, secs, n, cLat, cLon, places]) => {
      const c = {
        lat, lon, t: [change, secs, n], places: places || [],
        sw: mercator(lat, lon), ne: mercator(lat + data.cellLat, lon + data.cellLon),
        center: mercator(cLat ?? lat, cLon ?? lon), // where in the cell buses actually were
      };
      c.hood = hoodAt([(c.sw[0] + c.ne[0]) / 2, (c.sw[1] + c.ne[1]) / 2]);
      c.timepoint = isTimepoint(c);
      data.byKey.set(`${Math.round(lat / data.cellLat)},${Math.round(lon / data.cellLon)}`, c);
      return c;
    });
    loss = data;
    summarizeLoss();
  } catch (err) {
    console.warn("timeloss:", err);
  }
}

// Cells the time-lost lens counts, given the timepoint filter.
const lossCellOn = (c) => !(hideTimepoints && c.timepoint);
// Per-route totals from the server, with or without timepoint cells.
const routeLossTotals = () => (hideTimepoints && loss?.routesNoTimepoints) || loss?.routes;

// Area totals, each area's worst spots and the network hotspots, from the
// cells that pass the filter. Rerun when the filter changes; no refetch.
function summarizeLoss() {
  if (!loss) return;
  for (const h of hoods) { h.loss = [0, 0, 0]; h.spots = []; }
  const cells = loss.cells.filter(lossCellOn);
  for (const c of cells) {
    if (!c.hood) continue;
    for (let k = 0; k < 3; k++) c.hood.loss[k] += c.t[k];
    if (c.t[2] >= SPOT_MIN_SAMPLES) c.hood.spots.push(c);
  }
  // Each area's worst spots, most time lost first.
  for (const h of hoods) h.spots = h.spots.sort((a, b) => lossRate(b.t) - lossRate(a.t)).slice(0, 3);
  // Network-wide hotspots, ranked by total delay added there (so a busy
  // corner where every bus loses a little beats one bus's bad moment).
  // Route ends and transit centres are left out: planned layovers swamp them.
  loss.hotspots = cells
    .filter((c) => c.t[2] >= SPOT_MIN_SAMPLES && c.t[0] > 0 && !isLayover(c))
    .sort((a, b) => b.t[0] - a.t[0])
    .slice(0, HOTSPOT_ROWS);
  layerDirty = true;
}

function setHideTimepoints(on) {
  hideTimepoints = on;
  hoverCell = null;
  summarizeLoss();
}

function inverseMercator([x, y]) {
  return [(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, x * 360 - 180];
}

function findCell() {
  if (!loss || colorBy !== "loss") return null;
  const [lat, lon] = inverseMercator(toWorld(mouseX, mouseY));
  const c = loss.byKey.get(`${Math.floor(lat / loss.cellLat)},${Math.floor(lon / loss.cellLon)}`);
  return c && c.t[2] >= LOSS_MIN_SAMPLES && lossCellOn(c) ? c : null;
}

function currentPos(v) {
  const t = constrain((millis() - v.t0) / GLIDE_MS, 0, 1);
  const e = t * t * (3 - 2 * t); // smoothstep
  return [lerp(v.from[0], v.to[0], e), lerp(v.from[1], v.to[1], e)];
}

const routeOf = (v) => routes[v.data.trip?.routeId];
const isShown = (v) => agencyOn[v.data.agency] !== false;
const routeLabel = (r) => `${agencyNames[r.agency] || ""} ${r.name}`.trim();
// Buses in an area, limited to the pinned route when there is one.
const hoodVehicles = (h) => h.vehicles.filter((v) => isShown(v) && (!focusRoute || v.data.trip?.routeId === focusRoute));
const busWord = (n) => `${focusRoute ? routeLabel(routes[focusRoute]) + " " : ""}bus${n === 1 ? "" : "es"}`;

// Metro is drawn with circles, TANK with squares.
function mark(agency, x, y, d) {
  if (agency === "tank") {
    rectMode(CENTER);
    rect(x, y, d * 0.88, d * 0.88, d * 0.18);
    rectMode(CORNER);
  } else {
    circle(x, y, d);
  }
}

function areaColor(h) {
  if (colorBy === "delay") {
    const d = hoodDelay(h);
    return d == null ? null : delayColor(d);
  }
  if (colorBy === "loss") {
    const r = lossRate(h.loss, AREA_LOSS_MIN_SAMPLES);
    return r == null ? null : lossColor(r);
  }
  return null;
}

function hoodDelay(h) {
  const ds = hoodVehicles(h).map((v) => v.data.delay).filter((d) => d != null);
  return ds.length ? median(ds) : null;
}

function rampColor(stops, d) {
  if (d == null) return color(120);
  if (d <= stops[0][0]) return color(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [d1, c1] = stops[i];
    if (d <= d1) {
      const [d0, c0] = stops[i - 1];
      return lerpColor(color(c0), color(c1), (d - d0) / (d1 - d0));
    }
  }
  return color(stops[stops.length - 1][1]);
}

const delayColor = (d) => rampColor(DELAY_STOPS, d);
const lossColor = (r) => rampColor(LOSS_STOPS, r);

// Seconds of delay gained per minute of travel, from [change, seconds, samples].
const lossRate = (t, min = 1) => (t && t[2] >= min && t[1] > 0 ? (60 * t[0]) / t[1] : null);

function fmtLoss(r, short = false) {
  if (r == null) return short ? "—" : "not enough data yet";
  const n = Math.round(Math.abs(r));
  if (short) return n === 0 ? "0s/m" : `${r > 0 ? "+" : "−"}${n}s/m`;
  if (n === 0) return "hold steady";
  return r > 0 ? `lose ${n}s per minute` : `make up ${n}s per minute`;
}

function vehicleColor(v) {
  if (colorBy === "delay") return delayColor(v.data.delay);
  if (colorBy === "loss") return color(225); // the grid carries the colour here
  const r = routeOf(v);
  return r ? r.color : color(200);
}

function fmtDelay(d, short = false) {
  if (d == null) return short ? "—" : "no prediction";
  const m = Math.round(Math.abs(d) / 60);
  if (short) return m === 0 ? "0m" : `${d > 0 ? "+" : "−"}${m}m`;
  if (m === 0) return "on time";
  return `${m} min ${d > 0 ? "late" : "early"}`;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---------------------------------------------------------------------------
// p5

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  // p5 reports the mouse at (0, 0) until it moves, so track whether it's really over the map.
  cnv.elt.addEventListener("mousemove", () => (mouseOnMap = true));
  cnv.elt.addEventListener("mouseleave", () => (mouseOnMap = false));
  pixelDensity(Math.min(2, displayDensity()));
  routeLayer = createGraphics(width, height);
  const startColor = new URLSearchParams(location.search).get("color");
  if (startColor === "delay" || startColor === "loss") colorBy = startColor;
  if (new URLSearchParams(location.search).get("timepoints") === "exclude") hideTimepoints = true;
  setInterval(() => colorBy === "loss" && !paused && fetchLoss(), LOSS_POLL_MS);
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"])
    window.addEventListener(ev, wake, { passive: true });
  document.addEventListener("visibilitychange", wake);
  Promise.all([
    loadNetwork(),
    loadNeighborhoods().catch((e) => console.warn("neighborhoods:", e)),
    loadGeography().catch((e) => console.warn("geography:", e)),
  ])
    .then(() => {
      indexHoodRoutes();
      hoodFromURL();
      routeFromURL();
      poll();
      if (colorBy === "loss") fetchLoss();
    })
    .catch((e) => (feedError = e.message));
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  routeLayer.resizeCanvas(width, height);
  layerDirty = true;
}

function draw() {
  background(14, 17, 22);
  if (!network) return drawStatus(feedError ? `Couldn't load network: ${feedError}` : "Loading Metro + TANK networks…");

  if (layerDirty) renderRouteLayer();
  image(routeLayer, 0, 0, width, height);

  hoverVehicle = mouseOnMap ? findHover() : null;
  hoverCell = mouseOnMap && !hoverVehicle && !overPanel() ? findCell() : null;
  hoverHood = mouseOnMap && showHoods && !hoverVehicle && !legendHit() && !overPanel() ? hoodAt(toWorld(mouseX, mouseY)) : null;
  if (hoverHood && hoverHood !== focusHood) {
    const ctx = drawingContext;
    hoodPath(ctx, hoverHood);
    // A township's outline runs around villages inside it, so don't tint those.
    if (hoverHood.kind !== "township") {
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fill("evenodd");
    }
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    resyncStyles();
  }
  drawGeoLabels();
  if (showHoods) drawHoodLabels();

  const list = Object.values(vehicles).filter(isShown);
  if (showTrails) list.forEach(drawTrail);
  if (showBunches) drawBunches();
  // Draw focused route last so it sits on top.
  list.sort((a, b) => (routeOf(a)?.id === focusRoute) - (routeOf(b)?.id === focusRoute));
  list.forEach(drawVehicle);

  drawHeader(list);
  drawLegend(list);
  if (hoverVehicle) drawTooltip(hoverVehicle);
  else if (hoverCell) drawCellTooltip(hoverCell);
  else if (hoverHood) drawHoodTooltip(hoverHood);
  bottomStack = height - 12;
  if (focusHood) drawHoodPanel();
  if (focusRoute) drawAlerts();
  hotspotRows = [];
  if (colorBy === "loss") drawHotspots();
  drawSpotlight();
  cursor(hoverVehicle || legendHit() || buttonHit() || hotspotHit() || hoverHood ? HAND : dragging ? MOVE : ARROW);
}

// p5 skips re-applying a fill/stroke it believes is already set. After
// drawing straight onto a canvas context, make it forget, or its next
// fill()/stroke() can silently keep whatever colour we left behind.
function resyncStyles(target) {
  const r = (target || window)._renderer;
  r._cachedFillStyle = r._cachedStrokeStyle = undefined;
}

function hoodPath(ctx, h) {
  ctx.beginPath();
  for (const ring of h.rings) {
    ring.forEach((p, i) => {
      const [x, y] = toScreen(p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
  }
}

function renderRouteLayer() {
  const g = routeLayer;
  g.clear();


  if (showHoods) {
    const ctx = g.drawingContext;
    ctx.lineJoin = "round";
    const fillHood = (h) => {
      hoodPath(ctx, h);
      // Shade each area by its buses' median delay, or by time lost there.
      const c = areaColor(h);
      if (c) {
        ctx.fillStyle = `rgba(${red(c)},${green(c)},${blue(c)},0.16)`;
        ctx.fill("evenodd");
      }
      if (h === focusHood) {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fill("evenodd");
      }
    };
    const townships = hoods.filter((h) => h.kind === "township");
    const others = hoods.filter((h) => h.kind !== "township");
    // Township fills first, then punch out everything incorporated so a
    // township only shades its unincorporated parts.
    townships.forEach(fillHood);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (const h of others) {
      hoodPath(ctx, h);
      ctx.fill("evenodd");
    }
    ctx.globalCompositeOperation = "source-over";
    others.forEach(fillHood);
    for (const h of [...townships, ...others]) {
      if (h === focusHood) continue;
      hoodPath(ctx, h);
      ctx.strokeStyle = "rgba(255,255,255,0.13)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (focusHood) {
      hoodPath(ctx, focusHood);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  if (geo) {
    const ctx = g.drawingContext;
    // Counties tinted by state, slid *underneath* what's drawn so far (the
    // township cut-outs above would otherwise erase the tint).
    ctx.globalCompositeOperation = "destination-over";
    for (const c of geo.counties) {
      hoodPath(ctx, c);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = STATE_TINT[c.state] || "transparent";
      ctx.fill("evenodd");
    }
    ctx.globalCompositeOperation = "source-over";

    // The river above the area shading, below the routes (so bridges stay
    // visible). The Census splits it into pieces, so stroke every piece thick,
    // then fill them all on top: the fill hides the seams inside the river and
    // leaves just the outer half of the stroke along each bank.
    ctx.strokeStyle = RIVER_EDGE;
    ctx.lineWidth = 3;
    for (const piece of geo.river) {
      hoodPath(ctx, piece);
      ctx.stroke();
    }
    ctx.fillStyle = RIVER_FILL;
    for (const piece of geo.river) {
      hoodPath(ctx, piece);
      ctx.fill("evenodd");
    }
    resyncStyles(g);
  }

  if (showLines) {
    g.noFill();
    g.strokeJoin(ROUND);
    // The pinned route keeps its colour in every mode and is drawn on top.
    const order = Object.keys(routes).sort((a, b) => (a === focusRoute) - (b === focusRoute));
    for (const id of order) {
      const r = routes[id];
      if (!agencyOn[r.agency]) continue;
      const strong = id === focusRoute || (focusHood && focusHood.routes.has(id));
      const c = colorBy === "route" || id === focusRoute ? r.color : color(150);
      g.stroke(red(c), green(c), blue(c), dimmed(r) ? 18 : strong ? 200 : colorBy === "route" ? 70 : 45);
      g.strokeWeight(id === focusRoute ? 3 : strong ? 2 : 1.2);
      for (const pts of r.shapes) {
        g.beginShape();
        for (const p of pts) g.vertex(...toScreen(p));
        g.endShape();
      }
    }
  }
  // Time-lost grid: one square per ~220m cell, more opaque with more samples.
  if (colorBy === "loss" && loss) {
    g.noStroke();
    for (const c of loss.cells) {
      if (c.t[2] < LOSS_MIN_SAMPLES || !lossCellOn(c)) continue;
      if (focusHood && c.hood !== focusHood) continue;
      const [x0, y1] = toScreen(c.sw), [x1, y0] = toScreen(c.ne);
      const col = lossColor(lossRate(c.t));
      g.fill(red(col), green(col), blue(col), map(c.t[2], LOSS_MIN_SAMPLES, 40, 110, 235, true));
      const pad = Math.max(0, (x1 - x0) * 0.08);
      g.rect(x0 + pad, y0 + pad, Math.max(2, x1 - x0 - 2 * pad), Math.max(2, y1 - y0 - 2 * pad), 2);
    }
  }
  layerDirty = false;
}

function drawBunches() {
  const pulse = 0.5 + 0.5 * Math.sin(millis() / 300);
  for (const { a, b, meters } of bunches) {
    if (!isShown(a) || !isShown(b) || dimmedVehicle(a) || dimmedVehicle(b)) continue;
    const [ax, ay] = toScreen(currentPos(a)), [bx, by] = toScreen(currentPos(b));
    stroke(255, 80, 200, 60 + 50 * pulse);
    strokeWeight(9);
    line(ax, ay, bx, by);
    stroke(255, 120, 215, 230);
    strokeWeight(2.5);
    line(ax, ay, bx, by);
    if (view.scale > 60000) {
      noStroke();
      fill(255, 140, 220);
      textAlign(CENTER, BOTTOM);
      textSize(10);
      textStyle(BOLD);
      text(`bunched · ${Math.round(meters)} m`, (ax + bx) / 2, (ay + by) / 2 - 8);
      textStyle(NORMAL);
    }
  }
}

// A route is dimmed when another route is focused, or when a neighborhood
// is focused and the route doesn't pass through it.
function dimmed(r) {
  if (focusRoute) return r?.id !== focusRoute;
  if (focusHood) return !focusHood.routes.has(r?.id);
  return false;
}

const dimmedVehicle = (v) => dimmed(routeOf(v)) || (focusHood && v.hood !== focusHood);

function drawGeoLabels() {
  if (!geo) return;
  noStroke();
  textAlign(CENTER, CENTER);

  // State names on either bank, following the river under the view's centre.
  const pairs = riverCrossings(geo.river, view.x);
  if (!pairs.length) return textStyle(NORMAL);
  const [north, south] = pairs.reduce((best, pr) =>
    Math.abs((pr[0] + pr[1]) / 2 - view.y) < Math.abs((best[0] + best[1]) / 2 - view.y) ? pr : best
  );
  const n = toScreen([view.x, north]), s = toScreen([view.x, south]);
  textStyle(BOLD);
  textSize(15);
  drawingContext.letterSpacing = "6px";
  fill(255, 200, 140, 90);
  if (n[1] > 40) text("OHIO", n[0], n[1] - 26);
  fill(140, 190, 255, 110);
  if (s[1] < height - 40) text("KENTUCKY", s[0], s[1] + 26);
  drawingContext.letterSpacing = "0px";
  textStyle(NORMAL);
}

function drawHoodLabels() {
  textAlign(CENTER, CENTER);
  textSize(10);
  noStroke();
  for (const h of hoods) {
    const hot = h === focusHood || h === hoverHood;
    const w = (h.bbox.maxX - h.bbox.minX) * view.scale;
    textStyle(hot ? BOLD : NORMAL);
    // Only label neighborhoods with room for their name, unless highlighted.
    if (!hot && w < textWidth(h.name) + 16) continue;
    const [x, y] = toScreen(h.label);
    fill(255, 255, 255, hot ? 230 : 85);
    text(h.name, x, y);
  }
  textStyle(NORMAL);
}

function drawTrail(v) {
  if (dimmedVehicle(v) || v.trail.length < 2) return;
  const c = vehicleColor(v);
  const pts = [...v.trail.slice(0, -1), currentPos(v)].map(toScreen);
  strokeWeight(2);
  for (let i = 1; i < pts.length; i++) {
    stroke(red(c), green(c), blue(c), map(i, 1, pts.length - 1, 10, 140));
    line(...pts[i - 1], ...pts[i]);
  }
}

function drawVehicle(v) {
  const r = routeOf(v);
  const c = vehicleColor(v);
  const [x, y] = toScreen(currentPos(v));
  const size = constrain(view.scale / 4000, 7, 18);
  const alpha = dimmedVehicle(v) ? 40 : 255;

  push();
  translate(x, y);
  // Bearing arrow (0° = north, clockwise).
  if (v.data.bearing != null) {
    rotate(radians(v.data.bearing));
    noStroke();
    fill(red(c), green(c), blue(c), alpha);
    triangle(0, -size * 1.15, -size * 0.45, -size * 0.35, size * 0.45, -size * 0.35);
    rotate(-radians(v.data.bearing));
  }
  stroke(14, 17, 22, alpha);
  strokeWeight(1.5);
  fill(red(c), green(c), blue(c), alpha);
  mark(v.data.agency, 0, 0, size);
  if (v === hoverVehicle) {
    noFill();
    stroke(255);
    strokeWeight(1.5);
    mark(v.data.agency, 0, 0, size + 8);
  }
  // Route number on the dot once zoomed in enough to read it.
  if (size >= 14 && r && !dimmedVehicle(v)) {
    noStroke();
    fill(14, 17, 22);
    textAlign(CENTER, CENTER);
    textSize(size * 0.5);
    textStyle(BOLD);
    text(r.name, 0, 0.5);
  }
  pop();
}

function drawHeader(list) {
  const active = new Set(list.map((v) => v.data.trip?.routeId).filter(Boolean));
  const delays = list.map((v) => v.data.delay).filter((d) => d != null);
  const x = 12, y = 12, w = 340;
  // Panel height depends on which optional rows are showing.
  const h =
    34 + 18 + 18 + (showBunches ? 18 : 0) + (focusRoute ? 42 : 0) + 4 + 26 + 30 +
    (colorBy === "delay" ? 26 : 0) + (colorBy === "loss" ? 30 + 30 + 26 + 18 : 0) + 18 + 6;
  panels = [{ x, y, w, h }];
  buttons = [];
  headerBottom = y + h;
  noStroke();
  fill(14, 17, 22, 210);
  rect(x, y, w, h, 8);
  fill(240);
  textAlign(LEFT, TOP);
  textStyle(BOLD);
  textSize(16);
  text("Cincinnati + NKY transit · live", x + 12, y + 10);
  textStyle(NORMAL);
  textSize(12);
  // "About" link in the title row: sources, licences, how it was made.
  {
    const bw = textWidth("About") + 16, bx = x + w - bw - 10, by = y + 9;
    const hot = mouseX >= bx && mouseX <= bx + bw && mouseY >= by && mouseY <= by + 20;
    fill(255, 255, 255, hot ? 45 : 20);
    rect(bx, by, bw, 20, 10);
    fill(200);
    text("About", bx + 8, by + 4);
    buttons.push({ x: bx, y: by, w: bw, h: 20, onClick: openAbout });
  }
  fill(170);
  const updated = lastUpdate ? lastUpdate.toLocaleTimeString() : "waiting for feed…";
  const perAgency = Object.keys(agencyNames)
    .filter((a) => agencyOn[a])
    .map((a) => `${list.filter((v) => v.data.agency === a).length} ${agencyNames[a]}`)
    .join(" + ");
  let ly = y + 34;
  text(`${perAgency || "No"} buses · ${active.size} routes · ${updated}`, x + 12, ly);
  ly += 18;

  if (delays.length) {
    const onTime = delays.filter((d) => d >= ON_TIME[0] && d <= ON_TIME[1]).length;
    const missing = list.length - delays.length;
    const pct = `${Math.round((100 * onTime) / delays.length)}% on time`;
    fill(230);
    textStyle(BOLD);
    text(pct, x + 12, ly);
    const pw = textWidth(pct);
    textStyle(NORMAL);
    fill(170);
    text(` · median ${fmtDelay(median(delays))}${missing ? ` · ${missing} no prediction` : ""}`, x + 12 + pw, ly);
  }
  ly += 18;

  if (showBunches) {
    const shown = bunches.filter((p) => isShown(p.a) && isShown(p.b));
    if (shown.length) {
      const names = [...new Set(shown.map((p) => routeOf(p.a)).filter(Boolean).map(routeLabel))];
      fill(255, 130, 215);
      text(truncate(`${shown.length} bunched pair${shown.length === 1 ? "" : "s"}: ${names.join(", ")}`, 52), x + 12, ly);
    } else {
      fill(130);
      text("No bunched buses right now", x + 12, ly);
    }
    ly += 18;
  }

  // Pinned route: name, live stats, and an × to unpin.
  if (focusRoute) {
    const r = routes[focusRoute];
    fill(255, 255, 255, 14);
    rect(x + 8, ly - 3, w - 16, 38, 6);
    fill(r.color);
    mark(r.agency, x + 20, ly + 7, 10);
    fill(240);
    textStyle(BOLD);
    text(fitText(`Pinned: ${routeLabel(r)} · ${r.longName}`, w - 76), x + 32, ly);
    textStyle(NORMAL);
    const bx = x + w - 32, by = ly - 1;
    fill(255, 255, 255, 30);
    rect(bx, by, 18, 18, 9);
    fill(220);
    textAlign(CENTER, CENTER);
    text("×", bx + 9, by + 8);
    textAlign(LEFT, TOP);
    buttons.push({ x: bx, y: by, w: 18, h: 18, onClick: () => setFocus(focusRoute) });

    const mine = list.filter((v) => v.data.trip?.routeId === focusRoute);
    const ds = mine.map((v) => v.data.delay).filter((d) => d != null);
    let st = `${mine.length} bus${mine.length === 1 ? "" : "es"} running`;
    if (ds.length) {
      const onTime = ds.filter((d) => d >= ON_TIME[0] && d <= ON_TIME[1]).length;
      st += ` · ${Math.round((100 * onTime) / ds.length)}% on time · median ${fmtDelay(median(ds))}`;
    }
    const rl = lossRate(routeLossTotals()?.[focusRoute], AREA_LOSS_MIN_SAMPLES);
    if (rl != null) st += ` · ${fmtLoss(rl, true)}`;
    const nb = bunches.filter((p) => routeOf(p.a)?.id === focusRoute).length;
    if (nb) st += ` · ${nb} bunched`;
    fill(170);
    text(fitText(st, w - 44), x + 32, ly + 17);
    ly += 42;
  }
  ly += 4;

  // Colour mode and agency toggles.
  const toggleRow = (by, title, items) => {
    let bx = x + 12;
    fill(130);
    text(title, bx, by + 4);
    bx = x + 80;
    for (const { label, on, onClick, agency } of items) {
      const pad = agency ? 30 : 18;
      const bw = textWidth(label) + pad;
      fill(on ? color(240) : color(255, 255, 255, 20));
      rect(bx, by, bw, 20, 10);
      fill(on ? color(14, 17, 22) : color(200));
      if (agency) mark(agency, bx + 12, by + 10, 8);
      text(label, bx + pad - 9, by + 4);
      buttons.push({ x: bx, y: by, w: bw, h: 20, onClick });
      bx += bw + 6;
    }
  };
  toggleRow(ly, "Colour by", [
    { label: "Route", on: colorBy === "route", onClick: () => setColorBy("route") },
    { label: "Lateness", on: colorBy === "delay", onClick: () => setColorBy("delay") },
    { label: "Time lost", on: colorBy === "loss", onClick: () => setColorBy("loss") },
  ]);
  ly += 26;
  toggleRow(
    ly,
    "Show",
    Object.keys(agencyNames).map((a) => ({ label: agencyNames[a], agency: a, on: agencyOn[a], onClick: () => toggleAgency(a) }))
  );
  ly += 30;

  const gradientKey = (stops, ticks, label) => {
    const kx = x + 12, kw = w - 24, lo = stops[0][0], hi = stops[stops.length - 1][0];
    for (let i = 0; i < kw; i++) {
      fill(rampColor(stops, lo + ((hi - lo) * i) / kw));
      rect(kx + i, ly, 1.5, 8);
    }
    fill(150);
    textSize(10);
    for (const t of ticks) {
      const tx = kx + ((t - lo) / (hi - lo)) * kw;
      textAlign(t === lo ? LEFT : t === hi ? RIGHT : CENTER, TOP);
      text(label(t), tx, ly + 11);
    }
    textAlign(LEFT, TOP);
    textSize(12);
    ly += 26;
  };

  if (colorBy === "delay") {
    gradientKey(DELAY_STOPS, [-180, 300, 600, 1200], (t) => (t < 0 ? `${-t / 60}m early` : fmtDelay(t, true)));
  }
  if (colorBy === "loss") {
    toggleRow(
      ly,
      "Window",
      [1, 3, 24].map((hrs) => ({ label: `${hrs}h`, on: lossHours === hrs, onClick: () => setLossHours(hrs) }))
    );
    ly += 30;
    toggleRow(ly, "Timepoints", [
      { label: "Include", on: !hideTimepoints, onClick: () => setHideTimepoints(false) },
      { label: "Exclude", on: hideTimepoints, onClick: () => setHideTimepoints(true) },
    ]);
    ly += 30;
    gradientKey(LOSS_STOPS, [-20, 0, 20, 40], (t) => (t < 0 ? `gains ${-t}s/min` : t === 0 ? "steady" : `loses ${t}s/min`));
    fill(130);
    if (!loss) text("Loading history…", x + 12, ly);
    else {
      const since = loss.since ? new Date(loss.since * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
      const note = loss.samples < 200 ? " · still collecting" : "";
      text(`${loss.samples.toLocaleString()} samples${since ? ` · recording since ${since}` : ""}${note}`, x + 12, ly);
    }
    ly += 18;
  }
  if (paused && !feedError) {
    fill(240, 190, 90);
    text("Paused while idle · move the mouse to resume", x + 12, ly);
    return;
  }
  fill(feedError ? color(255, 120, 110) : color(110));
  text(feedError ? `feed error: ${feedError}` : "click bus/area · dbl-click zoom · D F T L N B I Esc", x + 12, ly);
}

function drawLegend(list) {
  const counts = {};
  const routeDelays = {};
  for (const v of list) {
    const id = v.data.trip?.routeId;
    if (!id || !routes[id]) continue;
    counts[id] = (counts[id] || 0) + 1;
    if (v.data.delay != null) (routeDelays[id] ||= []).push(v.data.delay);
  }
  const med = Object.fromEntries(Object.entries(routeDelays).map(([id, ds]) => [id, median(ds)]));
  const byName = (a, b) => routes[a].name.localeCompare(routes[b].name, undefined, { numeric: true });
  const routeLoss = (id) => lossRate(routeLossTotals()?.[id], AREA_LOSS_MIN_SAMPLES);
  const ids = Object.keys(counts).sort(
    colorBy === "delay"
      ? (a, b) => (med[b] ?? -Infinity) - (med[a] ?? -Infinity) || byName(a, b)
      : colorBy === "loss"
        ? (a, b) => (routeLoss(b) ?? -Infinity) - (routeLoss(a) ?? -Infinity) || byName(a, b)
        : (a, b) => counts[b] - counts[a] || byName(a, b)
  );
  const w = 220;
  const rowH = constrain(Math.floor((height - 36) / Math.max(1, ids.length)), 13, 18);
  const maxRows = Math.floor((height - 36) / rowH);
  const shown = ids.slice(0, maxRows);
  const x = width - w - 12, y0 = 12;

  noStroke();
  fill(14, 17, 22, 210);
  rect(x, y0, w, shown.length * rowH + 12, 8);
  panels.push({ x, y: y0, w, h: shown.length * rowH + 12 });
  legendRows = [];
  textSize(11);
  textAlign(LEFT, CENTER);
  shown.forEach((id, i) => {
    const r = routes[id];
    const y = y0 + 6 + i * rowH;
    legendRows.push({ id, x, y, w, h: rowH });
    const hl = id === focusRoute;
    if (hl) { fill(255, 255, 255, 25); rect(x + 4, y, w - 8, rowH, 4); }
    const dot = colorBy === "delay" ? delayColor(med[id]) : colorBy === "loss" ? lossColor(routeLoss(id)) : r.color;
    fill(dimmed(r) ? color(red(dot), green(dot), blue(dot), 70) : dot);
    mark(r.agency, x + 16, y + rowH / 2, 9);
    fill(dimmed(r) ? 100 : 230);
    textStyle(BOLD);
    text(r.name, x + 28, y + rowH / 2);
    textStyle(NORMAL);
    fill(dimmed(r) ? 80 : 150);
    text(truncate(r.longName, 20), x + 64, y + rowH / 2);
    textAlign(RIGHT, CENTER);
    if (colorBy === "delay") {
      fill(dimmed(r) ? 80 : delayColor(med[id]));
      text(fmtDelay(med[id], true), x + w - 12, y + rowH / 2);
    } else if (colorBy === "loss") {
      fill(dimmed(r) ? 80 : lossColor(routeLoss(id)));
      text(fmtLoss(routeLoss(id), true), x + w - 12, y + rowH / 2);
    } else {
      text(counts[id], x + w - 12, y + rowH / 2);
    }
    textAlign(LEFT, CENTER);
  });
}

function drawTooltip(v) {
  const r = routeOf(v);
  const d = v.data;
  const lines = [
    r ? `${routeLabel(r)} · ${r.longName}` : `${agencyNames[d.agency] || ""} bus, no route`,
    `Bus ${d.label || d.id} · ${fmtDelay(d.delay)}`,
    bunchOf(v) ? bunchLine(v) : null,
    d.speed != null ? `${Math.round(d.speed * 2.23694)} mph` : null,
    d.timestamp ? `reported ${Math.max(0, Math.round(Date.now() / 1000 - d.timestamp))}s ago` : null,
  ].filter(Boolean);
  textSize(12);
  const w = Math.max(...lines.map((l) => textWidth(l))) + 20;
  const h = lines.length * 17 + 12;
  let [x, y] = toScreen(currentPos(v));
  x = constrain(x + 14, 8, width - w - 8);
  y = constrain(y + 14, 8, height - h - 8);
  noStroke();
  fill(30, 34, 42, 240);
  rect(x, y, w, h, 6);
  textAlign(LEFT, TOP);
  lines.forEach((l, i) => {
    fill(i === 0 ? 245 : 175);
    textStyle(i === 0 ? BOLD : NORMAL);
    text(l, x + 10, y + 8 + i * 17);
  });
  textStyle(NORMAL);
}

function bunchLine(v) {
  const p = bunchOf(v);
  const other = p.a === v ? p.b : p.a;
  return `Bunched with bus ${other.data.label || other.data.id}, ${Math.round(p.meters)} m away`;
}

// Two kinds of planned waiting show up as "lost" time. Route ends and
// transit centres: buses lay over there between trips. Timepoints: buses
// running early must hold there. The server flags both from the timetable
// ("e" / "t"); stop names catch a few more route ends.
const isLayover = (c) =>
  c.places.some(([name, m, flags = ""]) => m <= 150 && (flags.includes("e") || /\bEOL\b|transit cent|end of line/i.test(name)));
const isTimepoint = (c) => c.places.some(([, m, flags = ""]) => m <= 120 && flags.includes("t"));

// "Vine St & 12th St", or "between stops, 280 m from …" when nothing is close.
function placeName(c) {
  const [first] = c.places;
  if (!first) return "Unnamed spot";
  return first[1] <= 120 ? first[0] : `Between stops, ${first[1]} m from ${first[0]}`;
}

function drawCellTooltip(c) {
  const others = c.places.slice(1).filter(([, m]) => m <= 250).map(([name]) => name);
  const lines = [
    placeName(c),
    `Buses here ${fmtLoss(lossRate(c.t))}`,
    others.length ? `Also near: ${others.join(" · ")}` : null,
    isLayover(c) ? "Route end / transit centre: planned layovers count here" : null,
    isTimepoint(c) ? "Timepoint: buses running early wait here on purpose" : null,
    `${c.t[2]} samples · last ${lossHours}h`,
  ].filter(Boolean);

  // Mark exactly where in the square the buses were.
  const [mx, my] = toScreen(c.center);
  noFill();
  stroke(255);
  strokeWeight(2);
  circle(mx, my, 14);
  stroke(14, 17, 22);
  strokeWeight(1);
  circle(mx, my, 18);
  noStroke();

  textSize(12);
  const w = Math.max(...lines.map((l) => textWidth(l))) + 20;
  const h = lines.length * 17 + 12;
  const x = constrain(mouseX + 14, 8, width - w - 8);
  const y = constrain(mouseY + 14, 8, height - h - 8);
  noStroke();
  fill(30, 34, 42, 240);
  rect(x, y, w, h, 6);
  textAlign(LEFT, TOP);
  lines.forEach((l, i) => {
    fill(i === 0 ? 245 : i === 1 ? lossColor(lossRate(c.t)) : 175);
    textStyle(i <= 1 ? BOLD : NORMAL);
    text(l, x + 10, y + 8 + i * 17);
  });
  textStyle(NORMAL);
}

// Small window under the header: the network's worst spots, click to jump.
function drawHotspots() {
  if (!loss) return;
  const list = loss.hotspots;
  const x = 12, y = headerBottom + 8, w = 340, rowH = 18;
  // Leave room for the area panel at the bottom.
  const room = Math.floor((bottomStack - y - 48) / rowH);
  const shown = list.slice(0, Math.max(0, Math.min(HOTSPOT_ROWS, room)));
  if (room < 1) return;
  const h = 48 + Math.max(1, shown.length) * rowH;
  panels.push({ x, y, w, h });
  noStroke();
  fill(14, 17, 22, 210);
  rect(x, y, w, h, 8);
  textAlign(LEFT, TOP);
  textSize(12);
  textStyle(BOLD);
  fill(240);
  text(focusRoute ? `Hotspots · ${routeLabel(routes[focusRoute])}` : "Hotspots", x + 12, y + 10);
  textStyle(NORMAL);
  fill(130);
  textSize(11);
  textAlign(RIGHT, TOP);
  text(`most delay added · last ${lossHours}h`, x + w - 12, y + 11);
  textAlign(LEFT, TOP);
  if (!shown.length) {
    fill(130);
    text("Not enough data yet; check back in a while.", x + 12, y + 30);
    return;
  }
  shown.forEach((c, i) => {
    const ry = y + 30 + i * rowH;
    const row = { c, x: x + 4, y: ry - 2, w: w - 8, h: rowH };
    hotspotRows.push(row);
    const hot = hotspotHit() === row;
    if (hot) { fill(255, 255, 255, 25); rect(row.x, row.y, row.w, row.h, 4); }
    const r = lossRate(c.t);
    fill(110);
    textAlign(RIGHT, TOP);
    text(`${i + 1}`, x + 22, ry);
    textAlign(LEFT, TOP);
    fill(lossColor(r));
    circle(x + 32, ry + 6.5, 7);
    // Name gets whatever space is left before the numbers (and the tag).
    const tp = c.timepoint;
    textSize(10);
    const tagW = tp ? textWidth("timepoint") + 6 : 0;
    textSize(12);
    const label = fitText(placeName(c), x + w - 132 - (x + 42) - tagW);
    fill(hot ? 255 : 220);
    text(label, x + 42, ry);
    if (tp) {
      const lw = textWidth(label);
      fill(120);
      textSize(10);
      text("timepoint", x + 48 + lw, ry + 1);
      textSize(12);
    }
    // Total minutes added, then rate.
    textAlign(RIGHT, TOP);
    fill(lossColor(r));
    text(`+${(c.t[0] / 60).toFixed(c.t[0] < 600 ? 1 : 0)} min`, x + w - 72, ry);
    fill(150);
    text(fmtLoss(r, true), x + w - 12, ry);
    textAlign(LEFT, TOP);
  });
  fill(100);
  textSize(10);
  text(`Route ends & transit centres ${hideTimepoints ? "and timepoints left out" : "left out · timepoints: early buses hold there"}`, x + 12, y + h - 15);
  textSize(12);
}

function hotspotHit() {
  return hotspotRows.find((r) => mouseX >= r.x && mouseX <= r.x + r.w && mouseY >= r.y && mouseY < r.y + r.h);
}

function jumpToSpot(c) {
  const pad = 0.006;
  const a = mercator(c.lat - pad, c.lon - pad * 1.3), b = mercator(c.lat + pad, c.lon + pad * 1.3);
  fitView({ minX: a[0], maxX: b[0], minY: b[1], maxY: a[1] }, 1);
  spotlight = { cell: c, until: millis() + 5000 };
}

// Pulsing ring on a hotspot: while its row is hovered, or briefly after a jump.
function drawSpotlight() {
  const row = hotspotHit();
  const c = row ? row.c : spotlight && millis() < spotlight.until ? spotlight.cell : null;
  if (!c) return;
  const [x, y] = toScreen(c.center);
  const pulse = (millis() % 1200) / 1200;
  noFill();
  stroke(255, 255, 255, 255 * (1 - pulse));
  strokeWeight(2);
  circle(x, y, 14 + 40 * pulse);
  stroke(255);
  circle(x, y, 12);
  noStroke();
}

function drawAlerts() {
  const mine = alerts.filter((a) => a.routes.includes(focusRoute));
  const r = routes[focusRoute];
  const w = Math.min(460, width - 24);
  const lines = [`${routeLabel(r)} · ${r.longName} — ${mine.length ? mine.length + " alert" + (mine.length > 1 ? "s" : "") : "no alerts"}`];
  for (const a of mine.slice(0, 5)) lines.push("• " + truncate(sentence(a.header || a.description || ""), 70));
  if (mine.length > 5) lines.push(`  +${mine.length - 5} more`);
  const h = lines.length * 17 + 14;
  const x = 12, y = bottomStack - h;
  bottomStack = y - 8;
  panels.push({ x, y, w, h });
  noStroke();
  fill(14, 17, 22, 220);
  rect(x, y, w, h, 8);
  textSize(12);
  textAlign(LEFT, TOP);
  lines.forEach((l, i) => {
    fill(i === 0 ? r.color : 190);
    textStyle(i === 0 ? BOLD : NORMAL);
    text(l, x + 12, y + 8 + i * 17, w - 24);
  });
  textStyle(NORMAL);
}

function drawHoodTooltip(h) {
  const n = hoodVehicles(h).length;
  const label = `${h.name} · ${n} ${busWord(n)}`;
  textSize(12);
  textStyle(BOLD);
  const w = textWidth(label) + 20;
  const x = constrain(mouseX + 14, 8, width - w - 8);
  const y = constrain(mouseY + 14, 8, height - 34);
  noStroke();
  fill(30, 34, 42, 240);
  rect(x, y, w, 26, 6);
  fill(240);
  textAlign(LEFT, CENTER);
  text(label, x + 10, y + 13);
  textStyle(NORMAL);
}

function drawHoodPanel() {
  const h = focusHood;
  const here = hoodVehicles(h);
  const n = here.length;
  const ds = here.map((v) => v.data.delay).filter((d) => d != null);
  let stats = `${n} ${busWord(n)} here now`;
  if (ds.length) {
    const onTime = ds.filter((d) => d >= ON_TIME[0] && d <= ON_TIME[1]).length;
    stats += ` · ${Math.round((100 * onTime) / ds.length)}% on time · median ${fmtDelay(median(ds))}`;
  }
  if (colorBy === "loss") {
    const r = lossRate(h.loss, AREA_LOSS_MIN_SAMPLES);
    stats = r == null ? `Time lost: not enough data yet (last ${lossHours}h)` : `Buses here ${fmtLoss(r)} · ${h.loss[2]} samples, last ${lossHours}h`;
  }
  const order = Object.keys(agencyNames);
  const ids = [...h.routes]
    .filter((id) => agencyOn[routes[id].agency])
    .sort(
      (a, b) =>
        order.indexOf(routes[a].agency) - order.indexOf(routes[b].agency) ||
        routes[a].name.localeCompare(routes[b].name, undefined, { numeric: true })
    );

  // Lay route chips out in rows first so the panel can be sized to fit.
  const w = Math.min(460, width - 24);
  textSize(11);
  textStyle(BOLD);
  const chips = [];
  let cx = 0, row = 0;
  for (const id of ids) {
    const cw = textWidth(routes[id].name) + 14;
    if (cx + cw > w - 24) { cx = 0; row++; }
    chips.push({ id, x: cx, row, w: cw });
    cx += cw + 4;
  }
  const rows = ids.length ? row + 1 : 0;
  const spots = colorBy === "loss" ? h.spots || [] : [];
  const spotsH = spots.length ? 22 + spots.length * 17 : 0;
  const ph = 82 + rows * 22 + spotsH;
  const x = 12, y = bottomStack - ph;
  bottomStack = y - 8;
  panels.push({ x, y, w, h: ph });

  noStroke();
  fill(14, 17, 22, 220);
  rect(x, y, w, ph, 8);
  textAlign(LEFT, TOP);
  fill(245);
  textSize(15);
  text(h.name, x + 12, y + 10);
  textStyle(NORMAL);
  textSize(12);
  fill(130);
  text(truncate(h.where + (h.association ? ` · ${h.association}` : ""), 72), x + 12, y + 31);
  fill(175);
  text(stats, x + 12, y + 49);
  if (spots.length) {
    const sy = y + 70 + rows * 22;
    fill(130);
    text("Worst spots", x + 12, sy);
    spots.forEach((c, i) => {
      const r = lossRate(c.t);
      fill(lossColor(r));
      textAlign(RIGHT, TOP);
      text(fmtLoss(r, true), x + w - 12, sy + 18 + i * 17);
      fill(215);
      textAlign(LEFT, TOP);
      text(truncate(placeName(c), 54), x + 22, sy + 18 + i * 17);
    });
  }
  if (!ids.length) return;
  textSize(11);
  textStyle(BOLD);
  textAlign(CENTER, CENTER);
  for (const c of chips) {
    const r = routes[c.id];
    const busesHere = here.some((v) => routeOf(v) === r);
    const col = r.color;
    const bx = x + 12 + c.x, by = y + 70 + c.row * 22;
    fill(red(col), green(col), blue(col), busesHere ? 255 : 60);
    rect(bx, by, c.w, 18, r.agency === "tank" ? 3 : 9); // square-ish chips for TANK
    if (c.id === focusRoute) {
      noFill();
      stroke(255);
      strokeWeight(1.5);
      rect(bx - 2, by - 2, c.w + 4, 22, r.agency === "tank" ? 4 : 11);
      noStroke();
    }
    fill(busesHere ? color(14, 17, 22) : color(220));
    text(r.name, bx + c.w / 2, by + 9.5);
  }
  textStyle(NORMAL);
}

function drawStatus(msg) {
  fill(170);
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(14);
  text(msg, width / 2, height / 2);
}

// Shorten s with an ellipsis until it fits maxW pixels at the current text size.
function fitText(s, maxW) {
  if (textWidth(s) <= maxW) return s;
  while (s.length > 1 && textWidth(s + "…") > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const sentence = (s) => s.charAt(0) + s.slice(1).toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// Interaction

let dragging = false;
let dragMoved = false;
let panels = [];           // on-screen UI boxes, rebuilt every frame
let mouseOnMap = false;

const overPanel = () => panels.some((p) => mouseX >= p.x && mouseX <= p.x + p.w && mouseY >= p.y && mouseY <= p.y + p.h);

function findHover() {
  let best = null, bestD = 14;
  for (const v of Object.values(vehicles)) {
    if (!isShown(v) || dimmedVehicle(v)) continue;
    const [x, y] = toScreen(currentPos(v));
    const d = dist(mouseX, mouseY, x, y);
    if (d < bestD) { best = v; bestD = d; }
  }
  return best;
}

function buttonHit() {
  return buttons.find((b) => mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY < b.y + b.h);
}

function setColorBy(mode) {
  colorBy = mode;
  if (mode === "loss") fetchLoss();
  layerDirty = true;
}

function setLossHours(hrs) {
  lossHours = hrs;
  fetchLoss();
}

function toggleAgency(a) {
  agencyOn[a] = !agencyOn[a];
  if (focusRoute && routes[focusRoute].agency === a) setFocus(focusRoute); // unpin a hidden route
  layerDirty = true;
}

function legendHit() {
  return legendRows.find((r) => mouseX >= r.x && mouseX <= r.x + r.w && mouseY >= r.y && mouseY < r.y + r.h);
}

// Pin (or unpin) a route. It stays pinned across colour modes and area focus.
function setFocus(id) {
  focusRoute = focusRoute === id ? null : id;
  if (colorBy === "loss") fetchLoss(); // the time-lost lens follows the pin
  layerDirty = true;
}

function setHoodFocus(h) {
  focusHood = focusHood === h ? null : h;
  layerDirty = true;
}

function zoomToHood(h) {
  focusHood = h;
  fitView(h.bbox, 0.45);
}

function routeFromURL() {
  const q = new URLSearchParams(location.search).get("route");
  if (!q) return;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const order = Object.keys(agencyNames);
  const match = Object.values(routes)
    .filter((r) => norm(r.name) === norm(q) || norm(routeLabel(r)) === norm(q) || norm(r.id) === norm(q))
    .sort((a, b) => order.indexOf(a.agency) - order.indexOf(b.agency))[0];
  if (match) focusRoute = match.id;
}

// The About dialog sits over the canvas; p5 still hears its clicks, keys and
// scrolls, so the map ignores input while it's open.
const aboutDialog = () => document.getElementById("about");
const aboutOpen = () => !!aboutDialog()?.open;
function openAbout() {
  aboutDialog()?.showModal();
  dragging = false;
}

function mousePressed() {
  if (aboutOpen()) return;
  dragging = true;
  dragMoved = false;
}

function mouseDragged() {
  if (!dragging) return;
  if (Math.abs(movedX) + Math.abs(movedY) > 0) dragMoved = true;
  view.x -= movedX / view.scale;
  view.y -= movedY / view.scale;
  layerDirty = true;
}

function mouseReleased() {
  if (aboutOpen()) return;
  dragging = false;
  if (dragMoved) return;
  const btn = buttonHit();
  if (btn) return btn.onClick();
  const spot = hotspotHit();
  if (spot) return jumpToSpot(spot.c);
  const row = legendHit();
  if (row) return setFocus(row.id);
  if (hoverVehicle) return setFocus(routeOf(hoverVehicle)?.id ?? null);
  if (overPanel()) return;
  if (showHoods) setHoodFocus(hoodAt(toWorld(mouseX, mouseY)));
}

function doubleClicked() {
  if (aboutOpen() || overPanel() || !showHoods) return;
  const h = hoodAt(toWorld(mouseX, mouseY));
  if (h) zoomToHood(h);
}

function mouseWheel(e) {
  if (aboutOpen()) return; // let the dialog scroll
  const [wx, wy] = toWorld(mouseX, mouseY);
  view.scale *= Math.exp(-e.delta * 0.0015);
  // Keep the point under the cursor fixed while zooming.
  const [nx, ny] = toWorld(mouseX, mouseY);
  view.x += wx - nx;
  view.y += wy - ny;
  layerDirty = true;
  return false;
}

function keyPressed() {
  if (aboutOpen()) return; // Esc closes the dialog itself
  if (key === "i" || key === "I") openAbout();
  else if (keyCode === ESCAPE) {
    // Peel back one layer at a time: area focus first, then the pinned route.
    if (focusHood) focusHood = null;
    else if (focusRoute) setFocus(focusRoute);
    layerDirty = true;
  }
  else if (key === "n" || key === "N") { showHoods = !showHoods; layerDirty = true; }
  else if (key === "d" || key === "D") setColorBy({ route: "delay", delay: "loss", loss: "route" }[colorBy]);
  else if (key === "b" || key === "B") showBunches = !showBunches;
  else if (key === "f" || key === "F") fitView();
  else if (key === "t" || key === "T") showTrails = !showTrails;
  else if (key === "l" || key === "L") { showLines = !showLines; layerDirty = true; }
}
