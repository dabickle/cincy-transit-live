// Builds dist/: the site Cloudflare serves as static assets.
//
//   node scripts/build-data.mjs
//
// Downloads each agency's static GTFS and the area boundaries, and writes:
//   dist/v/network.<hash>.json      routes + simplified shapes (for the sketch)
//   dist/v/areas.<hash>.json        neighborhoods, cities, villages, townships
//   dist/v/geography.<hash>.json    counties tagged by state + the Ohio River
//   dist/v/stops.<hash>.json        stop names/roles (for naming time-lost spots)
//   dist/v/timetable-<agency>.<hash>.json   scheduled times (for Metro's lateness)
//   dist/v/sketch.<hash>.js, dist/index.html, and the rest of public/
//   dist/manifest.json              which hashed files are current
//   dist/_headers                   cache rules: /v/* for a year, manifest for 5 min
//
// Downloads are cached in data/ (GTFS for a week, boundaries for 30 days) so
// rebuilding is quick. If a boundary source is down, the last complete copy in
// data/ is used; with no copy at all the build fails, so a deploy never ships
// with areas missing.
//
// No dependencies: Node built-ins only.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENCIES, tag } from "../src/shared/agencies.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const DIST = path.join(ROOT, "dist");

const GTFS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const BOUNDARY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const AREAS_VERSION = 6;
const GEOGRAPHY_VERSION = 2;
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
const TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
const STATE_CODES = { 39: "OH", 21: "KY", 18: "IN" };
const OHIO_COUNTIES = { "017": "Butler", "025": "Clermont", "061": "Hamilton", "165": "Warren" };

const log = (...a) => console.log(...a);
const isFresh = (file, maxAge) => fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAge;

// ---------------------------------------------------------------------------
// Static GTFS

const zipFile = (agency) => path.join(DATA, agency, "gtfs.zip");

// Downloads an agency's GTFS zip if it's missing or more than a week old.
// A failed refresh falls back to the copy on disk.
async function staticGTFS(agency) {
  const file = zipFile(agency);
  if (!isFresh(file, GTFS_MAX_AGE_MS)) {
    try {
      log(`Downloading ${AGENCIES[agency].name} static GTFS…`);
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

// stop_times.txt is ~700k rows, so skip the general CSV parser: header
// indexes plus each row split on commas (the columns used never contain one).
function stopTimeRows(text, columns) {
  const lines = text.split(/\r?\n/);
  const head = lines[0].replace(/^﻿/, "").split(",");
  const idx = columns.map((h) => head.indexOf(h));
  const rows = [];
  for (let i = 1; i < lines.length; i++) if (lines[i]) rows.push(lines[i].split(","));
  return { idx, rows };
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

function agencyNetwork(agency, files) {
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

// Scheduled times per trip, in seconds since the service day began, keyed by
// stop_sequence, plus which stops are timepoints. Delta-encoded to keep the file small:
//   dense trips (Metro numbers stops 1, 2, 3…): [firstSeq, t0, t1-t0, t2-t1, …]
//   sparse trips (TANK numbers them 0, 50, 85…): { seq: [s0, s1-s0, …], t: [t0, t1-t0, …] }
function agencyTimetable(files) {
  const tz = parseCSV(files["agency.txt"])[0].agency_timezone;
  const { idx: [iTrip, iArr, iDep, iSeq], rows } = stopTimeRows(files["stop_times.txt"], ["trip_id", "arrival_time", "departure_time", "stop_sequence"]);
  const byTrip = new Map();
  for (const c of rows) {
    const t = c[iArr] || c[iDep];
    if (!t) continue;
    const [h, m, sec] = t.split(":");
    let r = byTrip.get(c[iTrip]);
    if (!r) byTrip.set(c[iTrip], (r = []));
    r.push([+c[iSeq], h * 3600 + m * 60 + +sec]);
  }
  const deltas = (xs) => xs.map((x, i) => (i ? x - xs[i - 1] : x));
  const trips = {};
  for (const [id, r] of byTrip) {
    r.sort((a, b) => a[0] - b[0]);
    const seqs = r.map(([s]) => s), times = r.map(([, t]) => t);
    const dense = seqs.every((s, i) => s === seqs[0] + i);
    trips[id] = dense ? [seqs[0], ...deltas(times)] : { seq: deltas(seqs), t: deltas(times) };
  }
  // Stop ids that are mostly timepoints, for on-time stats measured there.
  const timepoints = [...stopRoles(files["stop_times.txt"])].filter(([, r]) => r.timepoint).map(([id]) => id);
  return { tz, trips, timepoints };
}

// Per stop, from the timetable: whether it's mostly a route end (most trips
// serving it start or finish there, so buses lay over) and whether it's
// mostly a timepoint (early buses must wait there). Both show up as "lost"
// time that's actually planned.
function stopRoles(stopTimes) {
  const { idx: [iTrip, iStop, iSeq, iTp], rows } = stopTimeRows(stopTimes, ["trip_id", "stop_id", "stop_sequence", "timepoint"]);
  const served = new Map(), timed = new Map(), trips = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const c of rows) {
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

const titleCase = (raw) => raw.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

// Stops with tidied names: Metro's "VINE ST & 12TH ST" → "Vine St & 12th St",
// TANK's "Holman at 17th" → "Holman & 17th". [[name, lat, lon, flags], ...]
function agencyStops(files) {
  const roles = stopRoles(files["stop_times.txt"]);
  const out = [];
  for (const s of parseCSV(files["stops.txt"])) {
    if (!s.stop_name || s.location_type === "1") continue; // skip parent stations
    let name = s.stop_name.trim().replace(/\s+at\s+/i, " & ").replace(/\s+/g, " ");
    if (name === name.toUpperCase())
      name = titleCase(name)
        .replace(/\bMc([a-z])/g, (_, c) => "Mc" + c.toUpperCase())
        .replace(/\b(Otc|Eol|Nku|Uc|Va|Cvg|Ii|Iii)\b/g, (w) => w.toUpperCase());
    // Mixed names like "HARD ROCK CASINO Station": soften shouty words, keep short acronyms.
    else name = name.replace(/\b[A-Z]{4,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
    const role = roles.get(s.stop_id) || {};
    out.push([name, +(+s.stop_lat).toFixed(5), +(+s.stop_lon).toFixed(5), (role.end ? "e" : "") + (role.timepoint ? "t" : "")]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Areas: Cincinnati and Covington neighborhoods, every other city in Boone,
// Kenton and Campbell counties, Ohio cities, villages and townships, and
// Kentucky's unincorporated communities. Kentucky has no townships, so each
// NKY county is a catch-all for the rest. Townships and those counties
// overlap the places inside them, so they're kind: "township" and the sketch
// treats them as a bottom layer covering only the land nothing else claims.

const HOOD_NAMES = { "CBD/RIVERFRONT": "Downtown", CUF: "CUF", "OVER-THE-RHINE": "Over-the-Rhine" };
const HOOD_ALIASES = {
  "OVER-THE-RHINE": ["otr"],
  "CBD/RIVERFRONT": ["cbd", "riverfront"],
  CUF: ["clifton heights", "university heights", "fairview"],
};

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

// The bus network's bounding box [west, south, east, north], padded by `pad` degrees.
function networkBBox(network, pad = 0) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of network.shapes)
    for (const [lat, lon] of s.pts) {
      b[0] = Math.min(b[0], lon); b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lon); b[3] = Math.max(b[3], lat);
    }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

// TIGERweb query parameters for features overlapping the bus network.
function networkQuery(network, where, outFields, pad = 0) {
  return new URLSearchParams({
    where,
    geometry: networkBBox(network, pad).join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    outSR: "4326",
    f: "geojson",
  });
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
  async ohioPlaces(url, network) {
    const q = networkQuery(network, "STATE='39' AND BASENAME<>'Cincinnati'", "BASENAME,LSADC");
    return (await fetchGeo(`${url}?${q}`)).map((f) => ({
      name: f.properties.BASENAME.replace(/^The Village of /, ""),
      where: `${f.properties.LSADC === "47" ? "Village" : "City"} in Ohio`,
      qualifier: "OH",
      aliases: [],
      rings: geoRings(f.geometry),
    }));
  },
  // Ohio townships (LSADC 44) in the same extent.
  async ohioTownships(url, network) {
    const q = networkQuery(network, "STATE='39' AND LSADC='44'", "BASENAME,COUNTY");
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
  async kyCommunities(url, network) {
    const q = networkQuery(network, "STATE='21'", "BASENAME");
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
  async kyCounties(url, network) {
    const q = networkQuery(network, "STATE='21'", "BASENAME");
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

// Boundaries change rarely, so a fetched copy is reused for 30 days. Only a
// complete set is cached; if any source fails, fall back to the last
// complete copy, or fail the build if there isn't one.
async function cachedBoundaries(name, version, build) {
  const file = path.join(DATA, `${name}.json`);
  const cached = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const usable = cached && JSON.parse(cached).version === version;
  if (usable && isFresh(file, BOUNDARY_MAX_AGE_MS)) return cached;
  try {
    const json = JSON.stringify({ version, ...(await build()) });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(file, json);
    return json;
  } catch (err) {
    if (!usable) throw new Error(`${name}: ${err.message}`);
    console.warn(`${name} refresh failed (${err.message}); using cached copy`);
    return cached;
  }
}

async function buildAreas(network) {
  const results = await Promise.all(
    Object.entries(AREA_SOURCES).map(([key, url]) =>
      AREA_BUILDERS[key](url, network).catch((err) => {
        throw new Error(`${key} failed: ${err.message}`);
      })
    )
  );
  const areas = results.flat();
  // A few names repeat (two Miami Townships, California OH/KY), so tell
  // those apart: "Miami Township (Hamilton Co.)".
  const counts = {};
  for (const a of areas) counts[a.name] = (counts[a.name] || 0) + 1;
  for (const a of areas) if (counts[a.name] > 1) a.name = `${a.name} (${a.qualifier})`;
  log(`Areas: ${areas.length}`);
  return { areas };
}

// The counties around the network (tagged with their state, so the sketch
// can tint Ohio and Kentucky differently) and the Ohio River between them.
async function buildGeography(network) {
  const counties = networkQuery(network, `STATE IN (${Object.keys(STATE_CODES).map((c) => `'${c}'`).join(",")})`, "STATE,BASENAME", 0.25);
  const rivers = networkQuery(network, "NAME='Ohio Riv'", "NAME", 0.1);
  const [countyFeatures, riverFeatures] = await Promise.all([
    fetchGeo(`${TIGER}/State_County/MapServer/1/query?${counties}`),
    fetchGeo(`${TIGER}/Hydro/MapServer/1/query?${rivers}`),
  ]);
  log(`Geography: ${countyFeatures.length} counties, ${riverFeatures.length} Ohio River pieces`);
  return {
    counties: countyFeatures.map((f) => ({
      name: f.properties.BASENAME,
      state: STATE_CODES[f.properties.STATE],
      rings: geoRings(f.geometry),
    })),
    river: riverFeatures.map((f) => ({ rings: geoRings(f.geometry) })),
  };
}

// ---------------------------------------------------------------------------
// Output

const hashOf = (body) => crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);

// Writes dist/v/<name>.<hash><ext> and returns its URL path.
function emit(name, body, ext = ".json") {
  const file = `${name}.${hashOf(body)}${ext}`;
  fs.writeFileSync(path.join(DIST, "v", file), body);
  log(`  /v/${file}  ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`);
  return `/v/${file}`;
}

const HEADERS = `# Generated by scripts/build-data.mjs.
# Files under /v/ are named by their content hash, so they never change.
/v/*
  Cache-Control: public, max-age=31536000, immutable

# Names the current /v/ files; short so a deploy shows up quickly.
/manifest.json
  Cache-Control: public, max-age=300
`;

async function main() {
  const agencies = Object.keys(AGENCIES);
  const gtfs = {};
  for (const a of agencies)
    gtfs[a] = unzip(await staticGTFS(a), ["agency.txt", "routes.txt", "trips.txt", "shapes.txt", "stops.txt", "stop_times.txt"]);

  const parts = agencies.map((a) => agencyNetwork(a, gtfs[a]));
  const network = {
    version: NETWORK_VERSION,
    agencies: Object.fromEntries(agencies.map((a) => [a, AGENCIES[a].name])),
    routes: parts.flatMap((p) => p.routes),
    shapes: parts.flatMap((p) => p.shapes),
  };
  log(`Network: ${network.routes.length} routes, ${network.shapes.length} shapes`);
  const stops = agencies.flatMap((a) => agencyStops(gtfs[a]));
  log(`Stops: ${stops.length}`);
  const timetables = Object.fromEntries(agencies.map((a) => [a, agencyTimetable(gtfs[a])]));

  const [areas, geography] = await Promise.all([
    cachedBoundaries("areas", AREAS_VERSION, () => buildAreas(network)),
    cachedBoundaries("geography", GEOGRAPHY_VERSION, () => buildGeography(network)),
  ]);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "v"), { recursive: true });
  log("Writing dist/");
  const manifest = {
    built: new Date().toISOString(),
    network: emit("network", JSON.stringify(network)),
    areas: emit("areas", areas),
    geography: emit("geography", geography),
    stops: emit("stops", JSON.stringify(stops)),
    timetables: Object.fromEntries(agencies.map((a) => [a, emit(`timetable-${a}`, JSON.stringify(timetables[a]))])),
  };

  // public/: the sketch gets a hashed name, index.html points at it.
  const sketch = emit("sketch", fs.readFileSync(path.join(PUBLIC, "sketch.js")), ".js");
  for (const f of fs.readdirSync(PUBLIC)) {
    if (f === "sketch.js") continue;
    let body = fs.readFileSync(path.join(PUBLIC, f));
    if (f === "index.html") {
      const html = body.toString("utf8");
      if (!html.includes('src="sketch.js"')) throw new Error('index.html no longer loads "sketch.js"');
      body = html.replace('src="sketch.js"', `src="${sketch}"`);
    }
    fs.writeFileSync(path.join(DIST, f), body);
  }
  fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(DIST, "_headers"), HEADERS);
  log("Done.");
}

main().catch((err) => {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
});
