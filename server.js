// Tiny zero-dependency server for the Cincinnati-area transit p5.js sketch.
//
//   node server.js        → http://localhost:8000
//
// Covers Cincinnati Metro and TANK (Northern Kentucky). Metro's
// GTFS-realtime feeds don't send CORS headers, so a browser can't fetch them
// directly. This server fetches both agencies' feeds, decodes the protobuf,
// and hands the sketch plain JSON. It also downloads each agency's static
// GTFS zip (cached in ./data/<agency>, refreshed weekly) to build a route
// map and a timetable, which lets it work out how late each bus is.
// Area boundaries: Cincinnati neighborhoods (City of Cincinnati GIS),
// Covington neighborhoods (City of Covington's ArcGIS layer), the other
// Northern Kentucky cities' limits (Kentucky state GIS), and Ohio cities,
// villages and townships (US Census Bureau TIGERweb). Kentucky has no
// townships, so NKY gets the Census's unincorporated communities (e.g.
// Burlington) plus each county as a catch-all for the rest. Townships and
// those counties overlap the places inside them, so they're marked
// kind: "township" and the sketch treats them as a bottom layer covering only
// the land nothing else claims.
// Background geography (the Ohio River and the counties of each state)
// also comes from TIGERweb.
//
// It also records history in the background (every 30s, whether or not a
// browser is open): each time a bus reports again on the same trip, how much
// its delay changed and where. /api/timeloss sums that into a grid showing
// where buses lose (or make up) time, each grid cell labelled with the
// nearest stops' names (which are nearly always intersections, e.g.
// "Vine St & 12th St"). Kept for 24h in data/history/.
//
// Route and vehicle ids are prefixed with the agency ("metro:1", "tank:1")
// because the two agencies reuse the same route numbers.

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { promisify } = require("util");

const PORT = process.env.PORT || 8000;
const PUBLIC = path.join(__dirname, "public");
const DATA = path.join(__dirname, "data");

const METRO_RT = "https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService";
const TANK_RT = "https://tank.rideralerts.com/InfoPoint";
const AGENCIES = {
  metro: {
    name: "Metro",
    gtfs: "https://www.go-metro.com/wp-content/uploads/2024/12/google_transit-1.zip",
    feeds: {
      vehicles: `${METRO_RT}/vehicle/vehiclepositions.pb`,
      trips: `${METRO_RT}/tripupdate/tripupdates.pb`,
      alerts: `${METRO_RT}/alert/alerts.pb`,
    },
  },
  tank: {
    name: "TANK",
    gtfs: `${TANK_RT}/GTFS-Zip.ashx`,
    feeds: {
      vehicles: `${TANK_RT}/GTFS-Realtime.ashx?Type=VehiclePosition`,
      trips: `${TANK_RT}/GTFS-Realtime.ashx?Type=TripUpdate`,
      alerts: `${TANK_RT}/GTFS-Realtime.ashx?Type=Alert`,
    },
  },
};
const GTFS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const NETWORK_VERSION = 2;
const AREA_SOURCES = {
  cincinnati:
    "https://arcgis.cincinnati-oh.gov/arcgis/rest/services/Core/miscellaneous/MapServer/1/query?where=1%3D1&outFields=DIS_NAME&outSR=4326&f=geojson",
  covington:
    "https://services2.arcgis.com/oF37xW75ElmQLUav/arcgis/rest/services/Neighborhoods/FeatureServer/0/query?where=1%3D1&outFields=NbhdLbl,NbhdAss&outSR=4326&f=geojson",
  nkyCities:
    "https://kygisportalservices.ky.gov/server/rest/services/EconDev/CityLimitsMap/MapServer/0/query?where=COUNTY+IN+('BOONE','KENTON','CAMPBELL')+AND+NAME+<>+'COVINGTON'&outFields=NAME,COUNTY&outSR=4326&f=geojson",
  // Current incorporated places and county subdivisions; filtered to Ohio and
  // the network's extent below.
  ohioPlaces: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query",
  ohioTownships: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1/query",
  kyCommunities: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/5/query",
  kyCounties: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query",
};
const AREAS_VERSION = 6;
const TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
const GEOGRAPHY_VERSION = 2;
const STATE_CODES = { 39: "OH", 21: "KY", 18: "IN" };
const OHIO_COUNTIES = { "017": "Butler", "025": "Clermont", "061": "Hamilton", "165": "Warren" };
const CACHE_MS = 10_000;
const HISTORY_POLL_MS = 30_000;
const HISTORY_HOURS = 24;
const HISTORY_DIR = path.join(DATA, "history");
const STATIC_CHECK_MS = 3600_000; // how often to look for new timetables/boundaries
const CELL_LAT = 0.002;  // ~220m grid cells for /api/timeloss
const CELL_LON = 0.0026;

// ---------------------------------------------------------------------------
// Minimal protobuf reader — just enough for GTFS-realtime.

function readMessage(buf, start = 0, end = buf.length) {
  const fields = {};
  let pos = start;
  const varint = () => {
    let result = 0n, shift = 0n, b;
    do {
      b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return result;
  };
  while (pos < end) {
    const key = Number(varint());
    const num = key >>> 3, type = key & 7;
    let val;
    if (type === 0) val = varint();
    else if (type === 1) { val = buf.subarray(pos, pos + 8); pos += 8; }
    else if (type === 2) { const len = Number(varint()); val = buf.subarray(pos, pos + len); pos += len; }
    else if (type === 5) { val = buf.subarray(pos, pos + 4); pos += 4; }
    else throw new Error(`unsupported wire type ${type}`);
    (fields[num] ||= []).push(val);
  }
  return fields;
}

const msg = (f, n) => (f[n] ? readMessage(f[n][0]) : null);
const msgs = (f, n) => (f[n] || []).map((b) => readMessage(b));
const str = (f, n) => (f[n] ? Buffer.from(f[n][0]).toString("utf8") : null);
const num = (f, n) => (f[n] ? Number(f[n][0]) : null);
const flt = (f, n) => (f[n] ? Buffer.from(f[n][0]).readFloatLE(0) : null);
const translated = (f) => (f ? str(msgs(f, 1)[0] || {}, 1) : null);
const tag = (agency, id) => (id == null ? id : `${agency}:${id}`);

function decodeTrip(t, agency) {
  return t && { tripId: str(t, 1), routeId: tag(agency, str(t, 5)), directionId: num(t, 6), startTime: str(t, 2) };
}

function decodeVehicles(buf, agency) {
  const feed = readMessage(buf);
  const header = msg(feed, 1);
  const vehicles = [];
  for (const ent of msgs(feed, 2)) {
    const v = msg(ent, 4);
    if (!v) continue;
    const p = msg(v, 2);
    if (!p) continue;
    const desc = msg(v, 8);
    vehicles.push({
      id: tag(agency, (desc && (str(desc, 1) || str(desc, 2))) || str(ent, 1)),
      agency,
      label: desc && str(desc, 2),
      trip: decodeTrip(msg(v, 1), agency),
      lat: flt(p, 1),
      lon: flt(p, 2),
      bearing: flt(p, 3),
      speed: flt(p, 5), // m/s
      stopId: str(v, 7),
      status: num(v, 4), // 0 incoming, 1 stopped, 2 in transit
      timestamp: num(v, 5),
    });
  }
  return { timestamp: num(header, 3), vehicles };
}

// TANK's trip updates include each stop's delay. Metro's carry only predicted
// times, so compare the prediction for the trip's next stop to the timetable.
function decodeTripUpdates(buf, agency) {
  const feed = readMessage(buf);
  const now = num(msg(feed, 1), 3) || Math.floor(Date.now() / 1000);
  const delays = {};
  const schedule = schedules[agency];
  for (const ent of msgs(feed, 2)) {
    const tu = msg(ent, 3);
    const trip = tu && msg(tu, 1);
    const tripId = trip && str(trip, 1);
    if (!tripId) continue;
    const times = schedule?.trips.get(tripId);
    const day0 = times && serviceDayStart(str(trip, 3) || todayIn(schedule.tz), schedule.tz);
    for (const stu of msgs(tu, 2)) {
      const ev = msg(stu, 2) || msg(stu, 3); // arrival, else departure
      if (!ev) continue;
      if (ev[1]) { delays[tripId] = Number(BigInt.asIntN(32, ev[1][0])); break; }
      const seq = num(stu, 1);
      if (!times || seq == null) continue;
      const predicted = num(ev, 2);
      const scheduled = times[seq];
      if (predicted == null || scheduled == null || scheduled < 0 || predicted < now - 30) continue;
      const delay = predicted - (day0 + scheduled);
      if (Math.abs(delay) < 3 * 3600) delays[tripId] = delay; // ignore nonsense
      break;
    }
  }
  return { timestamp: now, delays };
}

function decodeAlerts(buf, agency) {
  const feed = readMessage(buf);
  const alerts = [];
  for (const ent of msgs(feed, 2)) {
    const a = msg(ent, 5);
    if (!a) continue;
    alerts.push({
      id: str(ent, 1),
      routes: msgs(a, 5).map((e) => tag(agency, str(e, 2))).filter(Boolean),
      header: translated(msg(a, 10)),
      description: translated(msg(a, 11)),
    });
  }
  return { timestamp: num(msg(feed, 1), 3), alerts };
}

const DECODERS = { vehicles: decodeVehicles, trips: decodeTripUpdates, alerts: decodeAlerts };

// ---------------------------------------------------------------------------
// Realtime proxy with a short cache so many tabs don't hammer the agencies.

const cache = {};
async function getFeed(agency, kind) {
  const key = `${agency}/${kind}`;
  const c = cache[key];
  if (c && Date.now() - c.at < CACHE_MS) return c.data;
  const res = await fetch(AGENCIES[agency].feeds[kind]);
  if (!res.ok) throw new Error(`${kind} feed: HTTP ${res.status}`);
  const data = DECODERS[kind](Buffer.from(await res.arrayBuffer()), agency);
  cache[key] = { at: Date.now(), data };
  return data;
}

// Runs fn for every agency, keeping whatever succeeds. Fails only if every
// agency does; otherwise the failures come back as `errors`.
async function eachAgency(fn) {
  const results = await Promise.all(
    Object.keys(AGENCIES).map((a) =>
      fn(a).then(
        (value) => ({ value }),
        (err) => ({ error: `${AGENCIES[a].name}: ${err.message}` })
      )
    )
  );
  const errors = results.filter((r) => r.error).map((r) => r.error);
  if (errors.length === results.length) throw new Error(errors.join("; "));
  return { values: results.filter((r) => !r.error).map((r) => r.value), errors };
}

// Vehicle positions with each bus's delay (seconds, + is late) attached.
async function getVehicles() {
  const { values, errors } = await eachAgency(async (agency) => {
    const [feed, trips] = await Promise.all([getFeed(agency, "vehicles"), getFeed(agency, "trips").catch(() => null)]);
    const delays = trips ? trips.delays : {};
    return { ...feed, vehicles: feed.vehicles.map((v) => ({ ...v, delay: delays[v.trip?.tripId] ?? null })) };
  });
  return {
    timestamp: Math.max(...values.map((v) => v.timestamp || 0)) || null,
    vehicles: values.flatMap((v) => v.vehicles),
    errors,
  };
}

// ---------------------------------------------------------------------------
// History: where buses lose time.
//
// A segment is [time, lat, lon, delayChange, seconds, routeId]: between two
// reports from the same bus on the same trip, its delay changed by
// delayChange over `seconds`, attributed to the midpoint.

let segments = [];
const lastSample = new Map(); // vehicle id → { t, tripId, lat, lon, delay }

const historyFile = (t) => path.join(HISTORY_DIR, `${new Date(t * 1000).toISOString().slice(0, 10)}.jsonl`);

function loadHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return;
  const cutoff = Date.now() / 1000 - HISTORY_HOURS * 3600;
  for (const f of fs.readdirSync(HISTORY_DIR).sort()) {
    const day = Date.parse(f.slice(0, 10));
    if (!(day / 1000 + 86400 > cutoff)) {
      fs.rmSync(path.join(HISTORY_DIR, f)); // older than we keep
      continue;
    }
    for (const line of fs.readFileSync(path.join(HISTORY_DIR, f), "utf8").split("\n")) {
      if (!line) continue;
      const seg = JSON.parse(line);
      if (seg[0] >= cutoff) segments.push(seg);
    }
  }
  console.log(`History: ${segments.length} samples from the last ${HISTORY_HOURS}h`);
}

async function recordHistory() {
  try {
    const { vehicles } = await getVehicles();
    const fresh = [];
    for (const v of vehicles) {
      const t = v.timestamp;
      if (!t || v.delay == null || !v.trip?.tripId) {
        lastSample.delete(v.id);
        continue;
      }
      const prev = lastSample.get(v.id);
      if (prev && prev.t === t) continue; // no new report since last time
      const cur = { t, tripId: v.trip.tripId, lat: v.lat, lon: v.lon, delay: v.delay };
      lastSample.set(v.id, cur);
      if (!prev || prev.tripId !== cur.tripId) continue;
      const dt = t - prev.t, change = cur.delay - prev.delay;
      // Skip long silences and prediction resets.
      if (dt < 10 || dt > 180 || Math.abs(change) > 600) continue;
      fresh.push([t, +((prev.lat + cur.lat) / 2).toFixed(5), +((prev.lon + cur.lon) / 2).toFixed(5), change, dt, v.trip.routeId]);
    }
    if (fresh.length) {
      segments.push(...fresh);
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.appendFileSync(historyFile(fresh[0][0]), fresh.map((s) => JSON.stringify(s)).join("\n") + "\n");
    }
    const cutoff = Date.now() / 1000 - HISTORY_HOURS * 3600;
    if (segments.length && segments[0][0] < cutoff) segments = segments.filter((s) => s[0] >= cutoff);
  } catch (err) {
    console.warn("history:", err.message);
  }
}

// Per stop, from the timetable: whether it's mostly a route end (most trips
// serving it start or finish there, so buses lay over) and whether it's
// mostly a timepoint (early buses must wait there). Both show up as "lost"
// time that's actually planned.
function stopRoles(stopTimes) {
  const lines = stopTimes.split(/\r?\n/);
  const head = lines[0].replace(/^\uFEFF/, "").split(",");
  const [iTrip, iStop, iSeq, iTp] = ["trip_id", "stop_id", "stop_sequence", "timepoint"].map((h) => head.indexOf(h));
  const served = new Map(), timed = new Map(), trips = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(",");
    const stop = c[iStop], seq = +c[iSeq];
    bump(served, stop);
    if (iTp >= 0 && c[iTp] === "1") bump(timed, stop);
    let t = trips.get(c[iTrip]);
    if (!t) trips.set(c[iTrip], (t = [Infinity, null, -Infinity, null]));
    if (seq < t[0]) { t[0] = seq; t[1] = stop; }
    if (seq > t[2]) { t[2] = seq; t[3] = stop; }
  }
  const ends = new Map();
  for (const [, first, , last] of trips.values()) { bump(ends, first); bump(ends, last); }
  const roles = new Map();
  for (const [stop, n] of served)
    roles.set(stop, { end: (ends.get(stop) || 0) / n >= 0.5, timepoint: (timed.get(stop) || 0) / n >= 0.5 });
  return roles;
}

// Stops from both agencies, bucketed by grid cell, with tidied names:
// Metro's "VINE ST & 12TH ST" → "Vine St & 12th St", TANK's "Holman at 17th"
// → "Holman & 17th".
let stopsPromise = null;
function getStops() {
  return (stopsPromise ||= (async () => {
    const byCell = new Map();
    for (const agency of Object.keys(AGENCIES)) {
      const { "stops.txt": text, "stop_times.txt": stopTimes } = unzip(await staticGTFS(agency), ["stops.txt", "stop_times.txt"]);
      const roles = stopRoles(stopTimes);
      for (const s of parseCSV(text)) {
        if (!s.stop_name || s.location_type === "1") continue; // skip parent stations
        let name = s.stop_name.trim().replace(/\s+at\s+/i, " & ").replace(/\s+/g, " ");
        if (name === name.toUpperCase())
          name = titleCase(name)
            .replace(/\bMc([a-z])/g, (_, c) => "Mc" + c.toUpperCase())
            .replace(/\b(Otc|Eol|Nku|Uc|Va|Cvg|Ii|Iii)\b/g, (w) => w.toUpperCase());
        // Mixed names like "HARD ROCK CASINO Station": soften shouty words, keep short acronyms.
        else name = name.replace(/\b[A-Z]{4,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
        const role = roles.get(s.stop_id) || {};
        const stop = { name, lat: +s.stop_lat, lon: +s.stop_lon, end: !!role.end, timepoint: !!role.timepoint };
        const key = `${Math.floor(stop.lat / CELL_LAT)},${Math.floor(stop.lon / CELL_LON)}`;
        if (!byCell.has(key)) byCell.set(key, []);
        byCell.get(key).push(stop);
      }
    }
    return byCell;
  })());
}

function metersBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * toRad) / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(((bLon - aLon) * toRad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Up to three different intersections nearest a point, searching this cell
// and its neighbours: [[name, metres, flags], ...] where flags holds "e" for
// a route end and "t" for a timepoint. "A & B" and "B & A" (stops on
// opposite corners) count as the same place, sharing their flags.
function nearestStops(byCell, lat, lon) {
  const i = Math.floor(lat / CELL_LAT), j = Math.floor(lon / CELL_LON);
  const places = new Map();
  const placeKey = (name) => name.toLowerCase().split(" & ").map((p) => p.trim()).sort().join("&");
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++)
      for (const s of byCell.get(`${i + di},${j + dj}`) || []) {
        const m = Math.round(metersBetween(lat, lon, s.lat, s.lon));
        const key = placeKey(s.name);
        const p = places.get(key);
        if (!p) places.set(key, { name: s.name, m, end: s.end, timepoint: s.timepoint });
        else {
          if (m < p.m) { p.m = m; p.name = s.name; }
          p.end ||= s.end;
          p.timepoint ||= s.timepoint;
        }
      }
  return [...places.values()]
    .sort((a, b) => a.m - b.m)
    .slice(0, 3)
    .map((p) => [p.name, p.m, (p.end ? "e" : "") + (p.timepoint ? "t" : "")]);
}

// Grid cells and per-route totals for the last `hours`.
// Each total is [delay change summed, seconds summed, samples].
// With `route`, cells (and the sample count) cover only that route; the
// per-route totals always cover every route.
async function timeLoss(hours, route = null) {
  const cutoff = Date.now() / 1000 - hours * 3600;
  const cells = new Map();   // the grid sent back (only the pinned route's samples, if any)
  const all = new Map();     // every route's samples: centres for the timepoint test
  const byCell = new Map();  // key → { routeId: [change, seconds, samples] }
  const routes = {};
  let samples = 0;
  const add = (map, key, change, dt, lat, lon) => {
    let c = map.get(key);
    if (!c) map.set(key, (c = [0, 0, 0, 0, 0])); // change, seconds, samples, Σlat, Σlon
    c[0] += change; c[1] += dt; c[2]++; c[3] += lat; c[4] += lon;
  };
  for (const [t, lat, lon, change, dt, routeId] of segments) {
    if (t < cutoff) continue;
    const r = (routes[routeId] ||= [0, 0, 0]);
    r[0] += change; r[1] += dt; r[2]++;
    const key = `${Math.floor(lat / CELL_LAT)},${Math.floor(lon / CELL_LON)}`;
    add(all, key, change, dt, lat, lon);
    const perRoute = byCell.get(key) || byCell.set(key, {}).get(key);
    const pr = (perRoute[routeId] ||= [0, 0, 0]);
    pr[0] += change; pr[1] += dt; pr[2]++;
    if (route && routeId !== route) continue;
    samples++;
    add(cells, key, change, dt, lat, lon);
  }
  const stops = await getStops().catch(() => new Map());
  // Route totals again, leaving out cells at a timepoint (a timetabled stop
  // within 120 m of where buses were), where early buses wait on purpose.
  const routesNoTimepoints = {};
  for (const id in routes) routesNoTimepoints[id] = [0, 0, 0];
  for (const [key, c] of all) {
    const near = nearestStops(stops, c[3] / c[2], c[4] / c[2]);
    if (near.some(([, m, flags = ""]) => m <= 120 && flags.includes("t"))) continue;
    for (const [id, pr] of Object.entries(byCell.get(key)))
      for (let k = 0; k < 3; k++) routesNoTimepoints[id][k] += pr[k];
  }
  return {
    hours,
    route,
    since: segments.length ? segments[0][0] : null,
    samples,
    cellLat: CELL_LAT,
    cellLon: CELL_LON,
    // [south-west lat, south-west lon, change, seconds, samples,
    //  centre lat, centre lon, nearest stops [[name, metres], ...]]
    // The centre is the average sample position: where in the cell buses were.
    cells: [...cells].map(([key, c]) => {
      const [i, j] = key.split(",").map(Number);
      const cLat = c[3] / c[2], cLon = c[4] / c[2];
      return [+(i * CELL_LAT).toFixed(5), +(j * CELL_LON).toFixed(5), c[0], c[1], c[2], +cLat.toFixed(5), +cLon.toFixed(5), nearestStops(stops, cLat, cLon)];
    }),
    routes,
    routesNoTimepoints,
  };
}

async function getAlerts() {
  const { values, errors } = await eachAgency((agency) => getFeed(agency, "alerts"));
  return { alerts: values.flatMap((v) => v.alerts), errors };
}

// ---------------------------------------------------------------------------
// Service-day time maths. GTFS times are seconds since "noon minus 12h" on
// the service date, in the agency's time zone, and can run past 24:00.

function tzOffset(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(ms)
      .map((p) => [p.type, +p.value])
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

function serviceDayStart(yyyymmdd, tz) {
  const noon = Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8), 12);
  return Math.round((noon - tzOffset(noon, tz)) / 1000) - 12 * 3600;
}

function todayIn(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()).replaceAll("-", "");
}

// ---------------------------------------------------------------------------
// Static GTFS → data/network.json (routes + simplified shapes) and in-memory
// timetables.

const zipFile = (agency) => path.join(DATA, agency, "gtfs.zip");

// Downloads an agency's GTFS zip if it's missing or more than a week old.
// A failed refresh falls back to the copy on disk.
const zipPromises = {};
function staticGTFS(agency) {
  return (zipPromises[agency] ||= (async () => {
    const file = zipFile(agency);
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < GTFS_MAX_AGE_MS;
    if (!fresh) {
      try {
        console.log(`Downloading ${AGENCIES[agency].name} static GTFS…`);
        const res = await fetch(AGENCIES[agency].gtfs);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        if (!fs.existsSync(file)) throw new Error(`${AGENCIES[agency].name} static GTFS: ${err.message}`);
        console.warn(`${AGENCIES[agency].name} GTFS refresh failed (${err.message}); using cached copy`);
      }
    }
    return fs.readFileSync(file);
  })());
}

function unzip(buf, wanted) {
  // Walk the central directory (end record is in the last ~64KB).
  const out = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (wanted.includes(name)) {
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(dataStart, dataStart + size);
      out[name] = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const row = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else cur += ch;
    }
    row.push(cur);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ""), r[i]])));
}

// Drop points closer than ~40m to the previous kept point.
function thin(pts, min = 0.0004) {
  const out = [pts[0]];
  for (const pt of pts) {
    const last = out[out.length - 1];
    if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) > min) out.push(pt);
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

function agencyNetwork(agency, zip) {
  const files = unzip(zip, ["routes.txt", "trips.txt", "shapes.txt"]);

  const routes = parseCSV(files["routes.txt"]).map((r) => ({
    id: tag(agency, r.route_id),
    agency,
    name: r.route_short_name,
    longName: r.route_long_name,
    type: Number(r.route_type),
    color: r.route_color,
  }));

  const shapeRoute = {};
  for (const t of parseCSV(files["trips.txt"])) shapeRoute[t.shape_id] ||= t.route_id;

  const shapes = {};
  for (const s of parseCSV(files["shapes.txt"])) {
    (shapes[s.shape_id] ||= []).push([+s.shape_pt_sequence, +(+s.shape_pt_lat).toFixed(4), +(+s.shape_pt_lon).toFixed(4)]);
  }
  const shapeList = Object.entries(shapes)
    .filter(([id]) => shapeRoute[id])
    .map(([id, pts]) => ({
      route: tag(agency, shapeRoute[id]),
      pts: thin(pts.sort((a, b) => a[0] - b[0]).map(([, lat, lon]) => [lat, lon])),
    }));
  return { routes, shapes: shapeList };
}

// Rebuilt when missing, from an older version of this server, or older than
// any agency's GTFS zip.
let networkPromise = null;
function buildNetwork() {
  return (networkPromise ||= (async () => {
    const file = path.join(DATA, "network.json");
    const agencies = Object.keys(AGENCIES);
    const zips = await Promise.all(agencies.map(staticGTFS));
    if (fs.existsSync(file)) {
      const built = fs.statSync(file).mtimeMs;
      const current =
        JSON.parse(fs.readFileSync(file, "utf8")).version === NETWORK_VERSION &&
        agencies.every((a) => fs.statSync(zipFile(a)).mtimeMs <= built);
      if (current) return;
    }
    const parts = agencies.map((a, i) => agencyNetwork(a, zips[i]));
    const network = {
      version: NETWORK_VERSION,
      agencies: Object.fromEntries(agencies.map((a) => [a, AGENCIES[a].name])),
      routes: parts.flatMap((p) => p.routes),
      shapes: parts.flatMap((p) => p.shapes),
    };
    fs.writeFileSync(file, JSON.stringify(network));
    console.log(`Wrote ${file}: ${network.routes.length} routes, ${network.shapes.length} shapes`);
  })().finally(() => (networkPromise = null)));
}

// ---------------------------------------------------------------------------
// Areas → data/neighborhoods.json: Cincinnati and Covington neighborhoods,
// plus every other incorporated city in Boone, Kenton and Campbell counties.

const HOOD_NAMES = { "CBD/RIVERFRONT": "Downtown", CUF: "CUF", "OVER-THE-RHINE": "Over-the-Rhine" };
const HOOD_ALIASES = {
  "OVER-THE-RHINE": ["otr"],
  "CBD/RIVERFRONT": ["cbd", "riverfront"],
  CUF: ["clifton heights", "university heights", "fairview"],
};

const titleCase = (raw) => raw.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

// Every ring (outer edges and holes) as [lat, lon] points, ~10m apart.
function geoRings(geometry) {
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return polys.flat().map((ring) => thin(ring.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]), 0.0001));
}

async function fetchGeo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const geo = await res.json();
  if (geo.error) throw new Error(geo.error.message || "query failed");
  return geo.features.filter((f) => f.geometry);
}

const AREA_BUILDERS = {
  async cincinnati(url) {
    return (await fetchGeo(url)).map((f) => ({
      name: HOOD_NAMES[f.properties.DIS_NAME] || titleCase(f.properties.DIS_NAME),
      where: "Cincinnati neighborhood",
      qualifier: "Cincinnati",
      aliases: HOOD_ALIASES[f.properties.DIS_NAME] || [],
      rings: geoRings(f.geometry),
    }));
  },
  async covington(url) {
    return (await fetchGeo(url)).map((f) => ({
      name: f.properties.NbhdLbl.trim(),
      where: "Covington neighborhood",
      qualifier: "Covington",
      // The layer has lost its apostrophes ("Ritte?s East"), so put them back.
      association: (f.properties.NbhdAss || "").trim().replace(/(\w)\?s\b/g, "$1's") || null,
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  async nkyCities(url) {
    return (await fetchGeo(url)).map((f) => ({
      name: titleCase(f.properties.NAME),
      where: `City in ${titleCase(f.properties.COUNTY)} County, KY`,
      qualifier: "KY",
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  // Every Ohio city and village (other than Cincinnati) that overlaps the
  // area the bus routes cover.
  async ohioPlaces(url) {
    const q = await networkQuery("STATE='39' AND BASENAME<>'Cincinnati'", "BASENAME,LSADC");
    return (await fetchGeo(`${url}?${q}`)).map((f) => ({
      name: f.properties.BASENAME.replace(/^The Village of /, ""),
      where: `${f.properties.LSADC === "47" ? "Village" : "City"} in Ohio`,
      qualifier: "OH",
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  // Ohio townships (LSADC 44) in the same extent.
  async ohioTownships(url) {
    const q = await networkQuery("STATE='39' AND LSADC='44'", "BASENAME,COUNTY");
    return (await fetchGeo(`${url}?${q}`)).map((f) => ({
      name: `${f.properties.BASENAME} Township`,
      where: `Unincorporated ${OHIO_COUNTIES[f.properties.COUNTY] || "Ohio"}${OHIO_COUNTIES[f.properties.COUNTY] ? " County" : ""} township`,
      kind: "township",
      qualifier: `${OHIO_COUNTIES[f.properties.COUNTY] || "OH"} Co.`,
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  // Census Designated Places: named unincorporated communities.
  async kyCommunities(url) {
    const q = await networkQuery("STATE='21'", "BASENAME");
    return (await fetchGeo(`${url}?${q}`)).map((f) => ({
      name: f.properties.BASENAME,
      where: "Unincorporated community, KY",
      qualifier: "KY",
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  // Whole NKY counties; the sketch only uses the parts outside every city and
  // community above.
  async kyCounties(url) {
    const q = await networkQuery("STATE='21'", "BASENAME");
    return (await fetchGeo(`${url}?${q}`)).map((f) => ({
      name: `Unincorporated ${f.properties.BASENAME} County`,
      where: "Outside any city, KY",
      kind: "township",
      qualifier: "KY",
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
};

// The bus network's bounding box [west, south, east, north], padded by `pad` degrees.
async function networkBBox(pad = 0) {
  await buildNetwork();
  const { shapes } = JSON.parse(fs.readFileSync(path.join(DATA, "network.json"), "utf8"));
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of shapes)
    for (const [lat, lon] of s.pts) {
      b[0] = Math.min(b[0], lon); b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lon); b[3] = Math.max(b[3], lat);
    }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

// TIGERweb query parameters for features overlapping the bus network.
async function networkQuery(where, outFields, pad = 0) {
  const b = await networkBBox(pad);
  return new URLSearchParams({
    where,
    geometry: b.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    outSR: "4326",
    f: "geojson",
  });
}

// Only cached to disk when every source worked, so a source that was down
// gets retried next time instead of going missing for good.
let areasMemo = null;
async function getAreas() {
  const file = path.join(DATA, "neighborhoods.json");
  if (areasMemo) return areasMemo;
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file, "utf8");
    if (JSON.parse(cached).version === AREAS_VERSION) return (areasMemo = cached);
  }
  const results = await Promise.all(
    Object.entries(AREA_SOURCES).map(([key, url]) =>
      AREA_BUILDERS[key](url).catch((err) => {
        console.warn(`areas (${key}) failed: ${err.message}`);
        return null;
      })
    )
  );
  const areas = results.filter(Boolean).flat();
  if (!areas.length) throw new Error("no area boundaries could be loaded");
  // A few names repeat (two Miami Townships, California OH/KY), so tell
  // those apart: "Miami Township (Hamilton Co.)".
  const counts = {};
  for (const a of areas) counts[a.name] = (counts[a.name] || 0) + 1;
  for (const a of areas) if (counts[a.name] > 1) a.name = `${a.name} (${a.qualifier})`;
  const json = JSON.stringify({ version: AREAS_VERSION, areas });
  if (results.every(Boolean)) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(file, json);
    console.log(`Wrote ${file}: ${areas.length} areas`);
    areasMemo = json;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Background geography → data/geography.json: the counties around the
// network (tagged with their state, so the sketch can tint Ohio and Kentucky
// differently) and the Ohio River between them.

let geographyMemo = null;
async function getGeography() {
  const file = path.join(DATA, "geography.json");
  if (geographyMemo) return geographyMemo;
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file, "utf8");
    if (JSON.parse(cached).version === GEOGRAPHY_VERSION) return (geographyMemo = cached);
  }
  const counties = await networkQuery(`STATE IN (${Object.keys(STATE_CODES).map((c) => `'${c}'`).join(",")})`, "STATE,BASENAME", 0.25);
  const rivers = await networkQuery("NAME='Ohio Riv'", "NAME", 0.1);
  const [countyFeatures, riverFeatures] = await Promise.all([
    fetchGeo(`${TIGER}/State_County/MapServer/1/query?${counties}`),
    fetchGeo(`${TIGER}/Hydro/MapServer/1/query?${rivers}`),
  ]);
  const json = JSON.stringify({
    version: GEOGRAPHY_VERSION,
    counties: countyFeatures.map((f) => ({
      name: f.properties.BASENAME,
      state: STATE_CODES[f.properties.STATE],
      rings: geoRings(f.geometry),
    })),
    river: riverFeatures.map((f) => ({ rings: geoRings(f.geometry) })),
  });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, json);
  console.log(`Wrote ${file}: ${countyFeatures.length} counties, ${riverFeatures.length} Ohio River pieces`);
  return (geographyMemo = json);
}

// schedules[agency].trips: trip_id → Int32Array of scheduled seconds,
// indexed by stop_sequence (-1 where a sequence number is unused).
const schedules = {};

async function buildSchedule(agency) {
  const files = unzip(await staticGTFS(agency), ["agency.txt", "stop_times.txt"]);
  const tz = parseCSV(files["agency.txt"])[0].agency_timezone;
  // stop_times.txt is ~700k rows, so skip the general CSV parser.
  const lines = files["stop_times.txt"].split(/\r?\n/);
  const head = lines[0].replace(/^\uFEFF/, "").split(",");
  const [iTrip, iArr, iDep, iSeq] = ["trip_id", "arrival_time", "departure_time", "stop_sequence"].map((h) => head.indexOf(h));
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(",");
    const t = c[iArr] || c[iDep];
    if (!t) continue;
    const [h, m, sec] = t.split(":");
    let r = rows.get(c[iTrip]);
    if (!r) rows.set(c[iTrip], (r = []));
    r.push(+c[iSeq], h * 3600 + m * 60 + +sec);
  }
  const trips = new Map();
  for (const [id, r] of rows) {
    let max = 0;
    for (let i = 0; i < r.length; i += 2) max = Math.max(max, r[i]);
    const times = new Int32Array(max + 1).fill(-1);
    for (let i = 0; i < r.length; i += 2) times[r[i]] = r[i + 1];
    trips.set(id, times);
  }
  schedules[agency] = { tz, trips };
  console.log(`${AGENCIES[agency].name} timetable loaded: ${trips.size} trips`);
}

// ---------------------------------------------------------------------------

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// Plain responses: errors and 404s. Never cached.
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Bandwidth. Every response body is compressed once (gzip and brotli) and
// served to everyone who asks, with an ETag and a Cache-Control header a CDN
// can honour:
//   /data/<name>.<hash>.json   static data, versioned by content: cached for a year
//   sketch.js?v=<hash>         same, index.html links the current hash
//   /api/vehicles, /alerts, /timeloss   shared by every viewer for 10-60s
// So behind a CDN the server sends each static file about once per change,
// and the live endpoints a few times a minute however many people watch.

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);
const IMMUTABLE = "public, max-age=31536000, immutable";

async function packBody(body, type = "application/json", fast = false) {
  const raw = Buffer.from(body);
  const [gz, br] = await Promise.all([
    gzip(raw, { level: fast ? 6 : 9 }),
    brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: fast ? 5 : 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  ]);
  const etag = `W/"${crypto.createHash("sha256").update(raw).digest("base64url").slice(0, 16)}"`;
  return { type, raw, gz, br, etag };
}

function sendPacked(req, res, p, cache) {
  const headers = { "Content-Type": p.type, "Cache-Control": cache, ETag: p.etag, Vary: "Accept-Encoding" };
  if ((req.headers["if-none-match"] || "").includes(p.etag.slice(2))) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accept = req.headers["accept-encoding"] || "";
  let body = p.raw;
  if (/\bbr\b/.test(accept)) (body = p.br), (headers["Content-Encoding"] = "br");
  else if (/\bgzip\b/.test(accept)) (body = p.gz), (headers["Content-Encoding"] = "gzip");
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

// Live answers, built and compressed once per `ttlMs` and shared by every
// request in between (concurrent requests share the same promise). `fast`
// trades ~25% size for ~50x less CPU; worth it for small, frequent answers.
const liveCache = new Map(); // key → { until, promise }
function live(key, ttlMs, make, fast = true) {
  const now = Date.now();
  let e = liveCache.get(key);
  if (!e || e.until <= now) {
    if (liveCache.size > 300) for (const [k, v] of liveCache) if (v.until <= now) liveCache.delete(k);
    const promise = make().then((body) => packBody(JSON.stringify(body), "application/json", fast));
    liveCache.set(key, (e = { until: now + ttlMs, promise }));
    promise.catch(() => liveCache.delete(key)); // don't keep a failure around
  }
  return e.promise;
}

// Static data, published under a content hash. The previous version stays
// available too, for pages that read the manifest just before a change.
const assets = {};            // name → { url, hash, ...packed }
const assetFiles = new Map(); // url → packed
async function publishAsset(name, body) {
  const raw = Buffer.from(body);
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  if (assets[name]?.hash === hash) return;
  const packed = await packBody(raw);
  const old = assets[name];
  if (old?.prev) assetFiles.delete(old.prev);
  const url = `/data/${name}.${hash}.json`;
  assets[name] = { ...packed, hash, url, prev: old?.url };
  assetFiles.set(url, packed);
  console.log(`Published ${url}: ${raw.length} bytes, ${packed.br.length} brotli, ${packed.gz.length} gzip`);
}

// Rebuild/republish at most hourly: timetables refresh weekly, boundaries
// almost never. A source that fails keeps its last published version.
let staticChecked = 0;
let staticRefresh = null;
function refreshStatic() {
  if (staticRefresh && Date.now() - staticChecked < STATIC_CHECK_MS) return staticRefresh;
  staticChecked = Date.now();
  return (staticRefresh = Promise.allSettled([
    buildNetwork().then(() => publishAsset("network", fs.readFileSync(path.join(DATA, "network.json")))),
    getAreas().then((json) => publishAsset("areas", json)),
    getGeography().then((json) => publishAsset("geography", json)),
  ]).then((results) => {
    for (const r of results) if (r.status === "rejected") console.warn("static data:", r.reason?.message);
  }));
}

// Files in public/, compressed once per change. index.html gets its local
// scripts and stylesheets rewritten to name?v=<hash>, so those can be cached
// for good and a deploy still reaches everyone.
const fileCache = new Map(); // path → { key, packed }
async function packFile(file) {
  let body = fs.readFileSync(file);
  let key = String(fs.statSync(file).mtimeMs);
  if (file.endsWith(".html")) {
    const refs = [];
    const html = body.toString("utf8");
    for (const [, ref] of html.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))"/g)) {
      const dep = path.join(path.dirname(file), ref);
      if (dep.startsWith(PUBLIC) && fs.existsSync(dep)) refs.push([ref, await packFile(dep)]);
    }
    key += refs.map(([, p]) => p.etag).join();
    const hit = fileCache.get(file);
    if (hit?.key === key) return hit.packed;
    body = html.replace(/((?:src|href)=")([\w./-]+\.(?:js|css))"/g, (m, attr, ref) => {
      const dep = refs.find(([r]) => r === ref);
      return dep ? `${attr}${ref}?v=${dep[1].version}"` : m;
    });
  } else {
    const hit = fileCache.get(file);
    if (hit?.key === key) return hit.packed;
  }
  const packed = await packBody(body, TYPES[path.extname(file)] || "application/octet-stream");
  packed.version = crypto.createHash("sha256").update(packed.raw).digest("hex").slice(0, 10);
  fileCache.set(file, { key, packed });
  return packed;
}

const TIMELOSS_HOURS = [1, 3, 6, 12, 24];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/api/vehicles")
        return sendPacked(req, res, await live("vehicles", CACHE_MS, getVehicles), "public, max-age=10");
      if (url.pathname === "/api/alerts")
        return sendPacked(req, res, await live("alerts", 60_000, getAlerts), "public, max-age=60");
      if (url.pathname === "/api/timeloss") {
        // Snap to a few windows and sane route ids, so the cache (ours and a
        // CDN's, which keys on the query string) can't be flooded with variants.
        const asked = Number(url.searchParams.get("hours")) || 3;
        const hours = TIMELOSS_HOURS.reduce((a, b) => (Math.abs(b - asked) < Math.abs(a - asked) ? b : a));
        const r = url.searchParams.get("route");
        const route = r && /^[a-z]+:[\w.-]{1,24}$/.test(r) ? r : null;
        const packed = await live(`timeloss|${hours}|${route}`, HISTORY_POLL_MS, () => timeLoss(hours, route), false);
        return sendPacked(req, res, packed, "public, max-age=60");
      }
      if (url.pathname === "/api/manifest") {
        const packed = await live("manifest", 60_000, async () => {
          await refreshStatic();
          return { network: assets.network?.url, areas: assets.areas?.url, geography: assets.geography?.url };
        });
        return sendPacked(req, res, packed, "public, max-age=300");
      }
      if (url.pathname.startsWith("/data/")) {
        const packed = assetFiles.get(url.pathname);
        return packed ? sendPacked(req, res, packed, IMMUTABLE) : send(res, 404, "not found", "text/plain");
      }
      // Older unversioned URLs still work, with a short cache.
      const legacy = { "/api/network": "network", "/api/neighborhoods": "areas", "/api/geography": "geography" }[url.pathname];
      if (legacy) {
        await refreshStatic();
        const a = assets[legacy];
        return a ? sendPacked(req, res, a, "public, max-age=300") : send(res, 503, JSON.stringify({ error: `${legacy} not ready` }));
      }
      const file = path.join(PUBLIC, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return send(res, 404, "not found", "text/plain");
      const packed = await packFile(file);
      // A ?v= that matches this file's content can be cached for good; pages
      // themselves revalidate after a minute so a deploy shows up quickly.
      const cache = url.searchParams.get("v") === packed.version ? IMMUTABLE : file.endsWith(".html") ? "public, max-age=60" : "public, max-age=300";
      sendPacked(req, res, packed, cache);
    } catch (err) {
      console.error(err);
      send(res, 502, JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, () => {
    console.log(`Cincy transit sketch → http://localhost:${PORT}`);
    refreshStatic();
    for (const a in AGENCIES) buildSchedule(a).catch((e) => console.error(`${AGENCIES[a].name} timetable failed:`, e.message));
    loadHistory();
    setInterval(recordHistory, HISTORY_POLL_MS);
    recordHistory();
  });
