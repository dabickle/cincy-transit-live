// GTFS-realtime decoding and delay maths. Web APIs only (no Node Buffer), so
// it runs in a Worker as well as in Node.

import { tag } from "./agencies.js";

// ---------------------------------------------------------------------------
// Minimal protobuf reader — just enough for GTFS-realtime.

export function readMessage(buf, start = 0, end = buf.length) {
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

const utf8 = new TextDecoder();
const msg = (f, n) => (f[n] ? readMessage(f[n][0]) : null);
const msgs = (f, n) => (f[n] || []).map((b) => readMessage(b));
const str = (f, n) => (f[n] ? utf8.decode(f[n][0]) : null);
const num = (f, n) => (f[n] ? Number(f[n][0]) : null);
const flt = (f, n) => (f[n] ? new DataView(f[n][0].buffer, f[n][0].byteOffset, 4).getFloat32(0, true) : null);
const translated = (f) => (f ? str(msgs(f, 1)[0] || {}, 1) : null);

function decodeTrip(t, agency) {
  return t && { tripId: str(t, 1), routeId: tag(agency, str(t, 5)), directionId: num(t, 6), startTime: str(t, 2) };
}

export function decodeVehicles(buf, agency) {
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

// Each trip's delay at its next stop: the first stop whose predicted time
// hasn't passed. TANK's trip updates include each stop's delay; Metro's carry
// only predicted times, so compare the prediction to the timetable.
// `schedule` comes from loadSchedule() below, or is null if it isn't loaded.
// Also returns each trip's next stop, [stop_sequence, stop_id], so a change
// shows when a bus has passed a stop.
export function decodeTripUpdates(buf, agency, schedule) {
  const feed = readMessage(buf);
  const now = num(msg(feed, 1), 3) || Math.floor(Date.now() / 1000);
  const delays = {}, next = {};
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
      const seq = num(stu, 1), predicted = num(ev, 2);
      if (predicted != null && predicted < now - 30) continue; // already passed
      let delay;
      if (ev[1]) delay = Number(BigInt.asIntN(32, ev[1][0]));
      else {
        if (!times || seq == null || predicted == null) continue;
        const scheduled = times instanceof Map ? times.get(seq) : times[seq];
        if (scheduled == null || scheduled < 0) continue;
        delay = predicted - (day0 + scheduled);
        if (Math.abs(delay) >= 3 * 3600) continue; // ignore nonsense
      }
      delays[tripId] = delay;
      next[tripId] = [seq, str(stu, 4)];
      break;
    }
  }
  return { timestamp: now, delays, next };
}

export function decodeAlerts(buf, agency) {
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

// Timetable as written by the build script (see agencyTimetable there) into
// the form decodeTripUpdates wants: tripId → Int32Array indexed by
// stop_sequence for dense trips, or a Map(stop_sequence → time) for sparse
// ones. Timepoint stop ids become a Set.
export function loadSchedule({ tz, trips, timepoints = [] }) {
  const undelta = (xs) => { let acc = 0; return xs.map((x) => (acc += x)); };
  const map = new Map();
  for (const id in trips) {
    const trip = trips[id];
    if (Array.isArray(trip)) {
      const times = undelta(trip.slice(1));
      const arr = new Int32Array(trip[0] + times.length).fill(-1);
      arr.set(times, trip[0]);
      map.set(id, arr);
    } else {
      const seqs = undelta(trip.seq), times = undelta(trip.t);
      map.set(id, new Map(seqs.map((s, i) => [s, times[i]])));
    }
  }
  return { tz, trips: map, timepoints: new Set(timepoints) };
}
