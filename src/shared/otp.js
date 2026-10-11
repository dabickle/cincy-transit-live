// On-time performance over weeks and months, kept as running totals rather
// than raw readings.
//
// A passage is a bus passing a stop: its trip's next stop moved on, so the
// delay last predicted for that stop is (close to) how late it got there.
// Passages are counted per local day × route × hour × timepoint-or-not:
// [n, Σdelay, ...counts per BINS bucket]. Timepoints are the stops the
// schedule promises, so on-time % is usually quoted there.

// Bucket edges in seconds: <-1m, -1–0, 0–1, 1–3, 3–5, 5–10, 10–20, >20 min.
export const BINS = [-60, 0, 60, 180, 300, 600, 1200];

const binOf = (d) => {
  let i = 0;
  while (i < BINS.length && d >= BINS[i]) i++;
  return i;
};

const formats = new Map();
// Local service date and hour of a time: ["2026-10-11", 17].
export function localDayHour(t, tz) {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })));
  const p = Object.fromEntries(f.formatToParts(t * 1000).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, +p.hour];
}

// Passages since the last tick, given each vehicle's last next-stop (updated
// in place). `timepoints` is agency → Set of stop ids. Returns
// [[day, route, hour, timepoint (0/1), delay], ...].
export function newPassages(vehicles, lastStop, timepoints, tz, now) {
  const out = [];
  for (const v of vehicles) {
    const [seq, stopId] = v.nextStop || [];
    if (v.delay == null || !v.trip?.tripId || seq == null) {
      lastStop.delete(v.id);
      continue;
    }
    const prev = lastStop.get(v.id);
    lastStop.set(v.id, { t: now, tripId: v.trip.tripId, seq, stopId, delay: v.delay });
    if (!prev || prev.tripId !== v.trip.tripId || seq <= prev.seq || now - prev.t > 300) continue;
    const [day, hour] = localDayHour(now, tz);
    out.push([day, v.trip.routeId, hour, timepoints[v.agency]?.has(prev.stopId) ? 1 : 0, prev.delay]);
  }
  return out;
}

// Adds passages to running totals: key "day|route|hour|tp" → [n, Σdelay, ...bins].
export function addPassages(totals, passages) {
  for (const [day, route, hour, tp, delay] of passages) {
    const key = `${day}|${route}|${hour}|${tp}`;
    let c = totals.get(key);
    if (!c) totals.set(key, (c = new Array(2 + BINS.length + 1).fill(0)));
    c[0]++;
    c[1] += delay;
    c[2 + binOf(delay)]++;
  }
  return totals;
}
