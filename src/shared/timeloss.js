// Where buses lose time: grid cells summed from recorded history segments.
//
// A segment is [time, lat, lon, delayChange, seconds, routeId]: between two
// reports from the same bus on the same trip, its delay changed by
// delayChange over `seconds`, attributed to the midpoint.

export const CELL_LAT = 0.002; // ~220m grid cells
export const CELL_LON = 0.0026;

const cellKey = (lat, lon) => `${Math.floor(lat / CELL_LAT)},${Math.floor(lon / CELL_LON)}`;

// Stops as written by the build script, [[name, lat, lon, flags], ...], bucketed
// by grid cell. flags holds "e" for a route end and "t" for a timepoint.
export function stopsByCell(stops) {
  const byCell = new Map();
  for (const [name, lat, lon, flags] of stops) {
    const key = cellKey(lat, lon);
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push({ name, lat, lon, end: flags.includes("e"), timepoint: flags.includes("t") });
  }
  return byCell;
}

export function metersBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * toRad) / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(((bLon - aLon) * toRad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Up to three different intersections nearest a point, searching this cell
// and its neighbours: [[name, metres, flags], ...]. "A & B" and "B & A"
// (stops on opposite corners) count as the same place, sharing their flags.
export function nearestStops(byCell, lat, lon) {
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
export function timeLoss(segments, stops, hours, route = null, now = Date.now()) {
  const cutoff = now / 1000 - hours * 3600;
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
    const key = cellKey(lat, lon);
    add(all, key, change, dt, lat, lon);
    const perRoute = byCell.get(key) || byCell.set(key, {}).get(key);
    const pr = (perRoute[routeId] ||= [0, 0, 0]);
    pr[0] += change; pr[1] += dt; pr[2]++;
    if (route && routeId !== route) continue;
    samples++;
    add(cells, key, change, dt, lat, lon);
  }
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
    //  centre lat, centre lon, nearest stops [[name, metres, flags], ...]]
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

// New segments from a fresh set of vehicles, given each vehicle's previous
// sample (updated in place). Skips long silences and prediction resets.
export function newSegments(vehicles, lastSample) {
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
    if (dt < 10 || dt > 180 || Math.abs(change) > 600) continue;
    fresh.push([t, +((prev.lat + cur.lat) / 2).toFixed(5), +((prev.lon + cur.lon) / 2).toFixed(5), change, dt, v.trip.routeId]);
  }
  return fresh;
}
