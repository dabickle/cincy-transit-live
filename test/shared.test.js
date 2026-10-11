// Unit tests for src/shared. Run with `npm test` (node --test); no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeVehicles, decodeTripUpdates, decodeAlerts, loadSchedule } from "../src/shared/realtime.js";
import { timeLoss, newSegments, stopsByCell, nearestStops, CELL_LAT, CELL_LON } from "../src/shared/timeloss.js";
import { BINS, newPassages, addPassages, localDayHour } from "../src/shared/otp.js";

// --- a tiny protobuf encoder, just enough to build GTFS-realtime feeds ---

const varint = (n) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const field = (num, type, bytes) => [...varint((num << 3) | type), ...bytes];
const int = (num, n) => field(num, 0, varint(n));
const bytes = (num, b) => field(num, 2, [...varint(b.length), ...b]);
const str = (num, s) => bytes(num, [...new TextEncoder().encode(s)]);
const float = (num, f) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, f, true);
  return field(num, 5, [...b]);
};
const feed = (timestamp, entities) => new Uint8Array([...bytes(1, int(3, timestamp)), ...entities.flatMap((e) => bytes(2, e))]);

test("decodes vehicle positions", () => {
  const vehicle = [
    ...bytes(1, [...str(1, "trip-1"), ...str(5, "43")]), // trip: id, route
    ...bytes(2, [...float(1, 39.1), ...float(2, -84.5), ...float(3, 90)]), // lat, lon, bearing
    ...int(5, 1700000000),
    ...bytes(8, [...str(1, "1234"), ...str(2, "Bus 1234")]),
  ];
  const { timestamp, vehicles } = decodeVehicles(feed(1700000005, [[...str(1, "e1"), ...bytes(4, vehicle)]]), "metro");
  assert.equal(timestamp, 1700000005);
  assert.equal(vehicles.length, 1);
  const v = vehicles[0];
  assert.equal(v.id, "metro:1234");
  assert.equal(v.trip.routeId, "metro:43");
  assert.equal(v.trip.tripId, "trip-1");
  assert.ok(Math.abs(v.lat - 39.1) < 1e-5 && Math.abs(v.lon + 84.5) < 1e-5);
  assert.equal(v.bearing, 90);
  assert.equal(v.timestamp, 1700000000);
});

test("decodes alerts with their routes", () => {
  const translation = (s) => bytes(1, str(1, s));
  const alert = [...bytes(5, str(2, "1")), ...bytes(10, translation("Detour")), ...bytes(11, translation("Use 5th St"))];
  const { alerts } = decodeAlerts(feed(1, [[...str(1, "a1"), ...bytes(5, alert)]]), "tank");
  assert.deepEqual(alerts, [{ id: "a1", routes: ["tank:1"], header: "Detour", description: "Use 5th St" }]);
});

test("timetables round-trip, dense and sparse", () => {
  const { trips } = loadSchedule({
    tz: "America/New_York",
    trips: { dense: [1, 3600, 60, 120], sparse: { seq: [0, 50, 35], t: [7200, 300, 0] } },
  });
  const dense = trips.get("dense");
  assert.deepEqual([dense[1], dense[2], dense[3]], [3600, 3660, 3780]);
  assert.equal(dense[0], -1);
  const sparse = trips.get("sparse");
  assert.deepEqual([...sparse], [[0, 7200], [50, 7500], [85, 7500]]);
});

test("Metro-style delay: prediction minus timetable, in the agency's time zone", () => {
  // Trip on service day 2026-01-15 (EST, UTC-5); stop 2 scheduled at 08:00.
  const schedule = loadSchedule({ tz: "America/New_York", trips: { t1: [1, 7 * 3600 + 50 * 60, 10 * 60] } });
  const scheduled = Date.UTC(2026, 0, 15, 13, 0) / 1000; // 08:00 EST
  const predicted = scheduled + 180;
  const update = [
    ...bytes(1, [...str(1, "t1"), ...str(3, "20260115")]),
    ...bytes(2, [...int(1, 2), ...bytes(2, int(2, predicted))]), // stop_sequence 2, arrival time
  ];
  const { delays } = decodeTripUpdates(feed(scheduled - 600, [[...str(1, "e"), ...bytes(3, update)]]), "metro", schedule);
  assert.equal(delays.t1, 180);
});

test("TANK-style delay: taken from the feed, at the next stop", () => {
  const stu = (seq, stop, delay, time) => bytes(2, [...int(1, seq), ...bytes(2, [...int(1, delay), ...int(2, time)]), ...str(4, stop)]);
  const update = [...bytes(1, str(1, "t9")), ...stu(50, "A", -60, 900), ...stu(85, "B", 120, 1100)];
  const { delays, next } = decodeTripUpdates(feed(1000, [[...str(1, "e"), ...bytes(3, update)]]), "tank", null);
  assert.equal(delays.t9, 120); // stop A's time has passed
  assert.deepEqual(next.t9, [85, "B"]);
});

test("history segments: same trip, new report, sane gap", () => {
  const last = new Map();
  const bus = (t, delay, tripId = "a", lat = 39.1) => ({ id: "metro:1", timestamp: t, delay, lat, lon: -84.5, trip: { tripId, routeId: "metro:1" } });
  assert.deepEqual(newSegments([bus(1000, 0)], last), []); // first sighting
  assert.deepEqual(newSegments([bus(1000, 0)], last), []); // no new report
  assert.deepEqual(newSegments([bus(1030, 20, "a", 39.102)], last), [[1030, 39.101, -84.5, 20, 30, "metro:1"]]);
  assert.deepEqual(newSegments([bus(1300, 40)], last), []); // 270 s gap: too long
  assert.deepEqual(newSegments([bus(1330, 50, "b")], last), []); // new trip
});

test("time lost: cells, pinned route, and timepoint-free totals", () => {
  const lat = 39.1001, lon = -84.5001; // one cell
  const far = [lat + 5 * CELL_LAT, lon + 5 * CELL_LON]; // another, with a timepoint
  const now = 2_000_000_000_000;
  const t = now / 1000 - 60;
  const segments = [
    [t, lat, lon, 30, 60, "metro:1"],
    [t, lat, lon, 10, 60, "metro:2"],
    [t, ...far, 60, 60, "metro:1"],
    [t - 7200, lat, lon, 999, 60, "metro:1"], // outside a 1 h window
  ];
  const stops = stopsByCell([
    ["Main St & 1st St", lat, lon, ""],
    ["Vine St & 2nd St", far[0], far[1], "t"],
  ]);
  const all = timeLoss(segments, stops, 1, null, now);
  assert.equal(all.samples, 3);
  assert.equal(all.cells.length, 2);
  const main = all.cells.find((c) => c[7][0][0] === "Main St & 1st St");
  assert.deepEqual(main.slice(2, 5), [40, 120, 2]);
  assert.deepEqual(all.routes["metro:1"], [90, 120, 2]);
  assert.deepEqual(all.routesNoTimepoints["metro:1"], [30, 60, 1]); // the timepoint cell is left out

  const pinned = timeLoss(segments, stops, 1, "metro:2", now);
  assert.equal(pinned.samples, 1);
  assert.equal(pinned.cells.length, 1);
  assert.deepEqual(pinned.routes["metro:1"], [90, 120, 2]); // totals still cover every route
});

test("nearest stops merge opposite corners of one intersection", () => {
  const stops = stopsByCell([
    ["Vine St & 12th St", 39.1, -84.5, ""],
    ["12th St & Vine St", 39.1001, -84.5, "t"],
  ]);
  const near = nearestStops(stops, 39.1, -84.5);
  assert.equal(near.length, 1);
  assert.deepEqual(near[0], ["Vine St & 12th St", 0, "t"]);
});

test("on-time: a passage when the next stop moves on", () => {
  const last = new Map();
  const tps = { metro: new Set(["TP"]) };
  const bus = (seq, stop, delay, tripId = "a") => ({ id: "metro:1", agency: "metro", delay, nextStop: [seq, stop], trip: { tripId, routeId: "metro:1" } });
  const t = Date.UTC(2026, 9, 11, 21, 30) / 1000; // 5:30 pm EDT
  assert.deepEqual(newPassages([bus(4, "TP", 200)], last, tps, "America/New_York", t), []); // first sighting
  assert.deepEqual(newPassages([bus(4, "TP", 240)], last, tps, "America/New_York", t + 30), []); // still heading there
  assert.deepEqual(newPassages([bus(5, "X", 250)], last, tps, "America/New_York", t + 60), [["2026-10-11", "metro:1", 17, 1, 240]]);
  assert.deepEqual(newPassages([bus(6, "Y", 250)], last, tps, "America/New_York", t + 600), []); // too long a gap
  assert.deepEqual(newPassages([bus(9, "Z", 250, "b")], last, tps, "America/New_York", t + 630), []); // new trip
});

test("on-time: totals and local days across DST", () => {
  assert.deepEqual(localDayHour(Date.UTC(2026, 10, 1, 4, 30) / 1000, "America/New_York"), ["2026-11-01", 0]); // EDT
  assert.deepEqual(localDayHour(Date.UTC(2026, 10, 1, 6, 30) / 1000, "America/New_York"), ["2026-11-01", 1]); // EST
  const totals = addPassages(new Map(), [["d", "r", 8, 1, -90], ["d", "r", 8, 1, 30], ["d", "r", 8, 1, 400], ["d", "r", 9, 0, 2000]]);
  const bins = (i) => Object.assign(new Array(BINS.length + 1).fill(0), { [i]: 1 });
  const at8 = totals.get("d|r|8|1");
  assert.deepEqual(at8.slice(0, 2), [3, 340]);
  assert.deepEqual(at8.slice(2), bins(0).map((x, i) => x + bins(2)[i] + bins(5)[i]));
  assert.deepEqual(totals.get("d|r|9|0").slice(2), bins(7));
});
