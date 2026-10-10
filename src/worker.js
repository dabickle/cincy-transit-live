// Cloudflare Worker: the live API. Static files (the sketch, route shapes,
// areas) are served from dist/ by Workers static assets and never reach this
// code; see scripts/build-data.mjs.
//
//   /api/vehicles   live vehicle positions, each bus's delay in seconds attached
//   /api/alerts     service alerts
//   /api/timeloss?hours=1|3|6|12|24&route=metro:43   where buses lose time
//
// Answers come from one Durable Object, Recorder, which fetches the agencies'
// GTFS-realtime feeds (at most once per 10 s, however many people are
// watching) and records history every 30 s whether or not anyone is. The
// Worker caches each answer in the local data centre for its max-age, so most
// requests never reach the Durable Object. (The Cache API only works on a
// custom domain; on *.workers.dev every request goes through to it, which is
// fine at small scale since it memoizes too.)

import { DurableObject } from "cloudflare:workers";
import { AGENCIES } from "./shared/agencies.js";
import { decodeVehicles, decodeTripUpdates, decodeAlerts, loadSchedule } from "./shared/realtime.js";
import { stopsByCell, timeLoss, newSegments } from "./shared/timeloss.js";

const FEED_CACHE_MS = 10_000;
const ALERTS_CACHE_MS = 60_000;
const HISTORY_POLL_MS = 30_000;
const HISTORY_HOURS = 24;
const TIMELOSS_HOURS = [1, 3, 6, 12, 24];

const recorder = (env) => env.RECORDER.get(env.RECORDER.idFromName("main"));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });

    let ttl, call;
    const key = new URL(url.pathname, url.origin);
    if (url.pathname === "/api/vehicles") (ttl = 10), (call = (r) => r.vehicles());
    else if (url.pathname === "/api/alerts") (ttl = 60), (call = (r) => r.alerts());
    else if (url.pathname === "/api/timeloss") {
      // Snap to a few windows and sane route ids, so neither cache can be
      // flooded with variants.
      const asked = Number(url.searchParams.get("hours")) || 3;
      const hours = TIMELOSS_HOURS.reduce((a, b) => (Math.abs(b - asked) < Math.abs(a - asked) ? b : a));
      const r = url.searchParams.get("route");
      const route = r && /^[a-z]+:[\w.-]{1,24}$/.test(r) ? r : null;
      key.searchParams.set("hours", hours);
      if (route) key.searchParams.set("route", route);
      (ttl = 60), (call = (rec) => rec.timeloss(hours, route));
    } else return new Response("not found", { status: 404 });

    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return hit;
    try {
      const res = new Response(await call(recorder(env)), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (err) {
      console.error(err);
      return Response.json({ error: err.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  },

  // Safety net: makes sure the recorder's 30 s alarm is running even if no
  // one has visited since a deploy.
  async scheduled(controller, env) {
    await recorder(env).ensureAlarm();
  },
};

// ---------------------------------------------------------------------------
// The one Recorder: everything the Node server kept in memory.
//
// History is stored one row per 30 s tick (that tick's segments as JSON),
// not one row per segment, which keeps SQLite writes to ~2,900 a day. Each
// bus's previous report is saved too (one row, rewritten each tick): the
// object can be evicted between alarms, and segments need both reports.

export class Recorder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.feeds = {};            // "agency/kind" → { at, promise }
    this.answers = new Map();   // memoized JSON answers: key → { until, promise }
    this.lastSample = new Map(); // vehicle id → previous report, for history
    this.segments = [];
    this.static = null;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS ticks (t INTEGER PRIMARY KEY, segs TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      for (const { v } of this.sql.exec("SELECT v FROM state WHERE k = 'lastSample'")) this.lastSample = new Map(JSON.parse(v));
      const cutoff = Math.floor(Date.now() / 1000) - HISTORY_HOURS * 3600;
      this.sql.exec("DELETE FROM ticks WHERE t < ?", cutoff);
      const routeIds = new Map(); // share one string per route id
      for (const { segs } of this.sql.exec("SELECT segs FROM ticks ORDER BY t")) {
        for (const s of JSON.parse(segs)) {
          if (!routeIds.has(s[5])) routeIds.set(s[5], s[5]);
          s[5] = routeIds.get(s[5]);
          this.segments.push(s);
        }
      }
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  // Stops (for naming time-lost spots) and timetables (for Metro's delays),
  // read once from the static assets this deploy shipped with.
  staticData() {
    return (this.static ||= (async () => {
      const get = async (p) => {
        const res = await this.env.ASSETS.fetch(new URL(p, "https://assets.local"));
        if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
        return res.json();
      };
      const manifest = await get("/manifest.json");
      const agencies = Object.keys(AGENCIES);
      const [stops, ...timetables] = await Promise.all([get(manifest.stops), ...agencies.map((a) => get(manifest.timetables[a]))]);
      return {
        stops: stopsByCell(stops),
        schedules: Object.fromEntries(agencies.map((a, i) => [a, loadSchedule(timetables[i])])),
      };
    })().catch((err) => {
      this.static = null; // try again next time
      throw err;
    }));
  }

  // One agency feed, decoded, shared for FEED_CACHE_MS.
  feed(agency, kind) {
    const key = `${agency}/${kind}`;
    const c = this.feeds[key];
    if (c && Date.now() - c.at < FEED_CACHE_MS) return c.promise;
    const promise = (async () => {
      const res = await fetch(AGENCIES[agency].feeds[kind]);
      if (!res.ok) throw new Error(`${kind} feed: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (kind === "vehicles") return decodeVehicles(buf, agency);
      if (kind === "alerts") return decodeAlerts(buf, agency);
      const s = await this.staticData().catch((err) => (console.warn("static data:", err.message), null));
      return decodeTripUpdates(buf, agency, s?.schedules[agency]);
    })();
    this.feeds[key] = { at: Date.now(), promise };
    promise.catch(() => delete this.feeds[key]);
    return promise;
  }

  // Runs fn for every agency, keeping whatever succeeds. Fails only if every
  // agency does; otherwise the failures come back as `errors`.
  async eachAgency(fn) {
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
  async getVehicles() {
    const { values, errors } = await this.eachAgency(async (agency) => {
      const [feed, trips] = await Promise.all([this.feed(agency, "vehicles"), this.feed(agency, "trips").catch(() => null)]);
      const delays = trips ? trips.delays : {};
      return { ...feed, vehicles: feed.vehicles.map((v) => ({ ...v, delay: delays[v.trip?.tripId] ?? null })) };
    });
    return {
      timestamp: Math.max(...values.map((v) => v.timestamp || 0)) || null,
      vehicles: values.flatMap((v) => v.vehicles),
      errors,
    };
  }

  // A JSON answer, built once per `ttlMs` and shared by every request in between.
  answer(key, ttlMs, make) {
    const now = Date.now();
    let e = this.answers.get(key);
    if (!e || e.until <= now) {
      if (this.answers.size > 300) for (const [k, v] of this.answers) if (v.until <= now) this.answers.delete(k);
      const promise = make().then((body) => JSON.stringify(body));
      this.answers.set(key, (e = { until: now + ttlMs, promise }));
      promise.catch(() => this.answers.delete(key));
    }
    return e.promise;
  }

  // --- RPC methods, called by the Worker ---

  vehicles() {
    return this.answer("vehicles", FEED_CACHE_MS, () => this.getVehicles());
  }

  alerts() {
    return this.answer("alerts", ALERTS_CACHE_MS, async () => {
      const { values, errors } = await this.eachAgency((agency) => this.feed(agency, "alerts"));
      return { alerts: values.flatMap((v) => v.alerts), errors };
    });
  }

  timeloss(hours, route) {
    return this.answer(`timeloss|${hours}|${route}`, HISTORY_POLL_MS, async () => {
      const s = await this.staticData().catch(() => null);
      return timeLoss(this.segments, s?.stops || new Map(), hours, route);
    });
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  // --- History, every 30 s ---

  async alarm() {
    try {
      await this.record();
    } catch (err) {
      console.warn("history:", err.message);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + HISTORY_POLL_MS);
    }
  }

  async record() {
    const { vehicles } = await this.getVehicles();
    const fresh = newSegments(vehicles, this.lastSample);
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec("INSERT OR REPLACE INTO state (k, v) VALUES ('lastSample', ?)", JSON.stringify([...this.lastSample]));
    if (fresh.length) {
      this.sql.exec("INSERT OR REPLACE INTO ticks (t, segs) VALUES (?, ?)", now, JSON.stringify(fresh));
      this.segments.push(...fresh);
    }
    const cutoff = now - HISTORY_HOURS * 3600;
    if (this.segments.length && this.segments[0][0] < cutoff) {
      this.segments = this.segments.filter((s) => s[0] >= cutoff);
      this.sql.exec("DELETE FROM ticks WHERE t < ?", cutoff);
    }
  }
}
