// Stills library, hosted: this service worker answers the library page's requests from your Dropbox app folder,
// so the page (app.html, the same page the Mac serves) works anywhere with the Mac off.
// Built from 0_KIT/bin/hosted/sw.js by stills_publish.py --site. Talks only to Dropbox; nothing else sees your frames.
const APP_KEY = "xtkvkqi52cun78t";
const ROOT = "/library";
const API = "https://api.dropboxapi.com/2/", CONTENT = "https://content.dropboxapi.com/2/";
const C_THUMBS = "stills-thumbs-v1", C_FULL = "stills-full-v1", C_DATA = "stills-data-v1", C_PAGE = "stills-page-v1";
// the open page hears when something newer arrived in the background ("updated") or Dropbox wants a new sign-in
const tell = async msg => { for (const c of await self.clients.matchAll()) c.postMessage(msg); };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// ---- sign-in tokens (IndexedDB; the sign-in page writes them) ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("stills", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) { const db = await idb(); return new Promise(res => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function kvSet(k, v) { const db = await idb(); return new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); }); }

let refreshing = null;
async function token(force) {
  const t = await kvGet("auth");
  if (!t || !t.refresh) throw new Error("signin");
  if (!force && t.access && Date.now() < t.expires - 60000) return t.access;
  refreshing = refreshing || (async () => {
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: APP_KEY }) });
    if (r.status === 400 || r.status === 401) throw new Error("signin");     // revoked: sign in again
    if (!r.ok) throw new Error("dropbox " + r.status);
    const j = await r.json();
    t.access = j.access_token; t.expires = Date.now() + j.expires_in * 1000; await kvSet("auth", t);
    return t.access;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function call(url, opts, attempt = 0) {
  const o = Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { Authorization: "Bearer " + await token(attempt === 1) }) });
  const r = await fetch(url, o);
  if (r.status === 401 && attempt === 0) return call(url, opts, 1);
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    await new Promise(s => setTimeout(s, (+r.headers.get("Retry-After") || 1) * 1000 + attempt * 400));
    return call(url, opts, attempt + 2);
  }
  return r;
}
const arg = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const download = path => call(CONTENT + "files/download", { method: "POST", headers: { "Dropbox-API-Arg": arg({ path: ROOT + path }) } });
const upload = (path, text) => call(CONTENT + "files/upload", { method: "POST",
  headers: { "Dropbox-API-Arg": arg({ path: ROOT + path, mode: "overwrite", mute: true }), "Content-Type": "application/octet-stream" }, body: text });
const rpc = (name, body) => call(API + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function readJSON(path, dflt) {
  const r = await download(path);
  if (r.status === 409) return dflt;                       // not there yet
  if (!r.ok) throw new Error("read " + r.status);
  return JSON.parse(await r.text());
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---- the library data (data.js): opens from the phone's copy at once; a newer one is fetched in the background ----
async function newData(cache, haveRev) {
  const m = await rpc("files/get_metadata", { path: ROOT + "/data.js.gz" });
  if (!m.ok) throw new Error("data " + m.status);
  const rev = (await m.json()).rev;
  if (rev === haveRev) return null;
  const r = await download("/data.js.gz");
  if (!r.ok) throw new Error("data " + r.status);
  const js = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const resp = new Response(js, { headers: { "Content-Type": "application/javascript", "x-rev": rev } });
  await cache.put("data.js", resp.clone());
  return resp;
}
async function dataJS(e) {
  const cache = await caches.open(C_DATA), hit = await cache.match("data.js");
  if (!hit) return newData(cache, null);
  e.waitUntil(newData(cache, hit.headers.get("x-rev"))
    .then(r => r && tell({ type: "updated", what: "data" }))
    .catch(err => err.message === "signin" && tell({ type: "signin" })));
  return hit;
}

// ---- boards, picks, rotations, jobs: Dropbox's copy if it answers within a moment, else the last one seen ----
async function remember(key, o) { await (await caches.open(C_DATA)).put("state/" + key, json(o)); return o; }
async function cachedJSON(key, load, e) {
  const hit = await (await caches.open(C_DATA)).match("state/" + key);
  const net = load().then(o => remember(key, o)).then(o => json(o));
  if (!hit) return net;
  e.waitUntil(net.catch(() => {}));
  return Promise.race([net.catch(() => hit), new Promise(r => setTimeout(() => r(hit), 1200))]);
}

// ---- the page itself: from the phone's copy, checked against GitHub in the background ----
async function appPage(e, scope) {
  const a = await kvGet("auth");
  if (!a || !a.refresh) return Response.redirect(scope.href, 302);              // not signed in: the sign-in page
  const cache = await caches.open(C_PAGE), hit = await cache.match("app.html"), oldText = hit && hit.clone().text();
  const net = fetch(new URL("app.html", scope), { cache: "no-cache" }).then(async r => {
    if (!r.ok) return r;
    const text = await r.clone().text();
    await cache.put("app.html", r.clone());
    if (hit && text !== await oldText) tell({ type: "updated", what: "page" });
    return r;
  });
  if (!hit) return net;
  e.waitUntil(net.catch(() => {}));
  return hit;
}

// ---- thumbnails: 25 per request (Dropbox thumbnail batches), kept on the phone after the first look ----
const queue = []; let timer = 0;
function b64img(s) { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function flush() {
  timer = 0;
  while (queue.length) {
    const batch = queue.splice(0, 25);
    rpcContent("files/get_thumbnail_batch", { entries: batch.map(b => ({ path: ROOT + "/thumbs/" + b.id + ".jpg", format: "jpeg", size: "w480h320", mode: "bestfit" })) })
      .then(j => j.entries.forEach((e, i) => e[".tag"] === "success" ? batch[i].res(b64img(e.thumbnail)) : batch[i].rej(new Error("missing"))))
      .catch(err => batch.forEach(b => b.rej(err)));
  }
}
async function rpcContent(name, body) {
  const r = await call(CONTENT + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(name + " " + r.status);
  return r.json();
}
function thumbBytes(id) { return new Promise((res, rej) => { queue.push({ id, res, rej }); if (!timer) timer = setTimeout(flush, 15); }); }
async function thumbResp(req, id) {
  const cache = await caches.open(C_THUMBS), hit = await cache.match(req);
  if (hit) return hit;
  const resp = new Response(await thumbBytes(id), { headers: { "Content-Type": "image/jpeg" } });
  await cache.put(req, resp.clone());
  return resp;
}

// ---- full-res (2048px): the last 60 kept on the phone; until a frame's copy has synced, show its thumbnail ----
async function fullResp(req, id) {
  const cache = await caches.open(C_FULL), hit = await cache.match(req);
  if (hit) return hit;
  const r = await download("/full/" + id + ".jpg");
  if (r.status === 409) return thumbResp(new Request(new URL("thumbs/" + id + ".jpg", self.registration.scope)), id);
  if (!r.ok) throw new Error("full " + r.status);
  const resp = new Response(await r.blob(), { headers: { "Content-Type": "image/jpeg" } });
  await cache.put(req, resp.clone());
  const keys = await cache.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - 60))) cache.delete(k);
  return resp;
}

// ---- shared state: boards, picked colors, rotations (the Mac edits the same files) ----
let writing = Promise.resolve();                            // one change at a time
const serial = fn => (writing = writing.then(fn, fn));
const STATE = { "picks.json": {}, "rotations.json": {}, "boards.json": { boards: [] } };

async function setPicks(id, body) {
  const cols = (Array.isArray(body) ? body : []).filter(c => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toUpperCase()).slice(0, 24);
  const p = await readJSON("/state/picks.json", {});
  if (cols.length) p[id] = cols; else delete p[id];
  const r = await upload("/state/picks.json", JSON.stringify(p, null, 1));
  if (r.ok) await remember("picks.json", p);
  return new Response(null, { status: r.ok ? 204 : 500 });
}
async function setRotation(id, body) {
  const deg = ((+body.deg || 0) % 360 + 360) % 360;
  if (![0, 90, 180, 270].includes(deg)) return new Response(null, { status: 400 });
  const p = await readJSON("/state/rotations.json", {});
  if (deg) p[id] = deg; else delete p[id];
  const r = await upload("/state/rotations.json", JSON.stringify(p, null, 1));
  if (r.ok) await remember("rotations.json", p);
  return new Response(null, { status: r.ok ? 204 : 500 });
}
function slugify(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "board";
  let slug = base, n = 2; while (taken.has(slug)) slug = `${base}-${n++}`; return slug;
}
async function boardOp(body) {
  const b = await readJSON("/state/boards.json", { boards: [] }), L = b.boards, now = new Date().toISOString().slice(0, 19);
  const clean = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 80), job = clean(body.job);
  if (body.op === "create") {
    const name = clean(body.name) || "Untitled board";
    L.unshift({ slug: slugify(name, new Set(L.map(x => x.slug))), name, job, ids: (body.ids || []).slice(0, 500), created: now, updated: now });
  } else {
    const x = L.find(y => y.slug === body.slug); if (!x) return json({ error: "no such board" }, 400);
    const sid = body.id;
    if (body.op === "add" && !x.ids.includes(sid)) x.ids.push(sid);
    else if (body.op === "remove") x.ids = x.ids.filter(i => i !== sid);
    else if (body.op === "move" && x.ids.includes(sid)) { x.ids.splice(x.ids.indexOf(sid), 1); x.ids.splice(Math.max(0, Math.min(x.ids.length, +body.to || 0)), 0, sid); }
    else if (body.op === "update") { if ("name" in body) x.name = clean(body.name) || x.name; if ("job" in body) x.job = job; }
    else if (body.op === "delete") L.splice(L.indexOf(x), 1);
    x.updated = now;
    if (body.op !== "delete") { L.splice(L.indexOf(x), 1); L.unshift(x); }
  }
  const r = await upload("/state/boards.json", JSON.stringify(b, null, 1));
  if (r.ok) await remember("boards.json", b);
  return r.ok ? json(b) : json({ error: "couldn't save to Dropbox" }, 500);
}

// ---- Grab Stills feedback from the phone: keep / reject (swapping files needs the Mac; it applies rejects on its next run) ----
async function grabStatus(gr) {
  const fb = await readJSON("/state/feedback.json", { events: [] });
  const last = fb.events.filter(e => e.gr === gr).pop();
  return json({ hosted: true, gr, status: last ? last.action : "pick", lesson: (last && last.lesson) || "", cands: [] });
}
async function grabFeedback(body) {
  const gr = String(body.gr || ""), action = body.action;
  if (!/^\d{8}-\d{6}:\d+$/.test(gr)) return json({ error: "not a Grab Stills frame" }, 400);
  if (action === "swap") return json({ error: "Swapping in another frame works in the library on the Mac." }, 501);
  if (action !== "keep" && action !== "reject") return json({ error: "action must be keep or reject" }, 400);
  const fb = await readJSON("/state/feedback.json", { events: [] });
  const ev = { gr, action, source: "phone", at: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19) };   // local time, like the Mac
  if (action === "reject") ev.applied = false;
  fb.events.push(ev);
  const r = await upload("/state/feedback.json", JSON.stringify(fb, null, 1));
  return r.ok ? json({ ok: true, action }) : json({ error: "couldn't save to Dropbox" }, 500);
}

// ---- routing: the page asks for the same addresses the Mac serves ----
async function route(p, req, e) {
  const get = req.method === "GET";
  if (get && p === "data.js") return dataJS(e);
  if (get && p.startsWith("thumbs/")) return thumbResp(req, p.slice(7).replace(/\.jpg.*$/, ""));
  if (get && p.startsWith("orig/")) return fullResp(req, p.slice(5));
  if (get && p in STATE) return cachedJSON(p, () => readJSON("/state/" + p, STATE[p]), e);
  if (get && p === "jobs") return cachedJSON("jobs.json", () => readJSON("/jobs.json", { jobs: [] }), e);
  if (get && p === "whoami") return json({ mac: false, hosted: true });
  if (get && p.startsWith("grab/")) return grabStatus(new URL(req.url).searchParams.get("gr") || "");
  if (!get && p.startsWith("grab/")) { const b = await req.json().catch(() => ({})); return serial(() => grabFeedback(b)); }
  if (!get && p.startsWith("picks/")) { const b = await req.json().catch(() => []); return serial(() => setPicks(p.slice(6), b)); }
  if (!get && p.startsWith("rotate/")) { const b = await req.json().catch(() => ({})); return serial(() => setRotation(p.slice(7), b)); }
  if (!get && p === "boards") { const b = await req.json().catch(() => ({})); return serial(() => boardOp(b)); }
  if (!get && p.startsWith("lookbook/")) return json({ error: "PDF export runs on the Mac" }, 501);
  if (!get && p.startsWith("reveal/")) return new Response(null, { status: 403 });
  return null;
}
const ROUTED = /^(data\.js|thumbs\/|orig\/|picks\.json|rotations\.json|boards\.json|jobs|whoami|picks\/|rotate\/|boards|lookbook\/|reveal\/|grab\/)/;

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url), scope = new URL(self.registration.scope);
  if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return;
  const p = u.pathname.slice(scope.pathname.length);
  if (p === "app.html" && e.request.mode === "navigate") {
    e.respondWith(appPage(e, scope).catch(() => fetch(e.request, { cache: "no-cache" })));
    return;
  }
  if ((p === "" || p === "index.html") && e.request.mode === "navigate") {
    // signed in: straight to the library (skips a page load); ?signin / ?signout still reach the sign-in page
    e.respondWith(kvGet("auth").then(a => a && a.refresh && !u.search
      ? Response.redirect(new URL("app.html", scope).href, 302) : fetch(e.request, { cache: "no-cache" })));
    return;
  }
  if (!ROUTED.test(p)) return;                                      // the page, icons, manifest: from GitHub Pages
  e.respondWith(route(p, e.request, e).then(r => r || fetch(e.request)).catch(err => {
    if (err.message === "signin") return p === "data.js"
      ? new Response('location.replace("./?signin")', { headers: { "Content-Type": "application/javascript" } })
      : json({ error: "Sign in again" }, 401);
    return json({ error: err.message }, 503);
  }));
});
