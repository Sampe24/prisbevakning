/**
 * Prisbevakning som webbapp (iPhone, Android, dator). Ingen inloggning: webbläsaren slumpar fram ett hemligt id
 * och servern (follow-server/src/web.js) sparar bevakningarna under en hash av det. Servern kollar dem var
 * 30:e minut och skickar notiser via Web Push. Samma regler och format som Android-appen.
 */

// Lokalt (python -m http.server + wrangler dev) används den lokala servern
const SERVER = location.hostname === "localhost" ? "http://localhost:8787" : document.querySelector('meta[name="server"]').content;
const VAPID = document.querySelector('meta[name="vapid"]').content;
const LS = { secret: "pb.secret", data: "pb.data", values: "pb.values", endpoint: "pb.endpoint", installHint: "pb.installHint" };
const DEFAULT_LIST = { id: "default", name: "Mina bevakningar", active: true, from: "" };

const TYPES = {
  stock: { label: "Kurs", short: "Kurs" },
  crypto: { label: "Krypto", short: "Kurs" },
  pe_ratio: { label: "P/E-tal", short: "P/E" },
  pb_ratio: { label: "P/B-tal", short: "P/B" },
  div_yield: { label: "Direktavkastning", short: "Direktavk." },
  equity_ratio: { label: "Soliditet", short: "Soliditet" },
  debt_equity: { label: "Skuldsättningsgrad", short: "Skuldsättning" },
};
const STOCK_TYPES = ["stock", "pe_ratio", "pb_ratio", "div_yield", "equity_ratio", "debt_equity"];
const REPORT = new Set(["equity_ratio", "debt_equity"]);
const HELP = {
  pe_ratio: "Kursen delat med vinsten per aktie. Lågt = billigt i förhållande till vinsten.",
  pb_ratio: "Kursen delat med eget kapital per aktie. Under 1 betyder att börsen värderar bolaget lägre än det egna kapitalet i böckerna.",
  div_yield: "Utdelningen senaste året delat med kursen. Stiger när kursen faller.",
  equity_ratio: "Eget kapital delat med tillgångarna — hur stor del som inte är lånad. Under 30 % brukar räknas som lågt (banker och fastighetsbolag ligger ofta lägre).",
  debt_equity: "Lån delat med eget kapital. Över 1 = mer lån än eget kapital.",
};
const defaultAbove = (t) => t === "div_yield" || t === "debt_equity";

// ── Lagring i webbläsaren (kan saknas i privat läge: då fungerar appen ändå under besöket) ──

const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privat läge */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* privat läge */ } },
};

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad), (c) => c.charCodeAt(0));
}
const newId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

let secret = store.get(LS.secret);
if (!/^[A-Za-z0-9_-]{43}$/.test(secret || "")) {
  secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  store.set(LS.secret, secret);
}

// ── Tillstånd ──

const saved = store.get(LS.data, {});
const S = {
  alerts: saved.alerts || [],
  lists: saved.lists?.length ? saved.lists : [DEFAULT_LIST],
  onServer: !!saved.onServer,
  push: !!saved.push,
  notices: saved.notices || [],
  values: store.get(LS.values, { quotes: {}, balances: {}, t: 0 }),
  filter: "all",
  draft: null,          // bevakningen som redigeras
  stock: {},            // symbol → {quote, balance, profile} för aktiekortet
  insider: {},          // "issuer|months" → {trades}
  offline: false,
};

function persist() {
  store.set(LS.data, { alerts: S.alerts, lists: S.lists, onServer: S.onServer, push: S.push, notices: S.notices });
}

// ── Servern ──

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = "Bearer " + secret;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(SERVER + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || "HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}

let saveTimer = null;
function save() {
  persist();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushToServer, 250);
}
async function pushToServer() {
  try {
    await api("/v1/web/me", { method: "PUT", auth: true, body: { alerts: S.alerts, lists: S.lists } });
    S.onServer = true;
    S.offline = false;
  } catch {
    S.offline = true;
    toast("Kunde inte spara på servern just nu. Försöker igen nästa gång.");
  }
  persist();
}

async function loadFromServer() {
  try {
    const me = await api("/v1/web/me", { auth: true });
    S.alerts = me.alerts;
    S.lists = me.lists?.length ? me.lists : [DEFAULT_LIST];
    S.push = me.push;
    S.notices = me.notices || [];
    S.onServer = true;
    persist();
  } catch (e) {
    if (e.status === 404 && S.alerts.length) await pushToServer();   // finns bara lokalt: skicka upp
    else if (e.status !== 404) S.offline = true;
  }
  await syncPushSubscription();
}

async function refreshValues() {
  const symbols = [...new Set(S.alerts.map((a) => a.symbol))];
  if (!symbols.length) return;
  const report = [...new Set(S.alerts.filter((a) => REPORT.has(a.type)).map((a) => a.symbol))];
  try {
    const r = await api(`/v1/web/quotes?s=${encodeURIComponent(symbols.join(","))}&b=${encodeURIComponent(report.join(","))}`);
    S.values = { quotes: { ...S.values.quotes, ...r.quotes }, balances: { ...S.values.balances, ...r.balances }, t: Date.now() };
    store.set(LS.values, S.values);
  } catch {
    S.offline = true;
  }
}

// ── Formatering (som Fmt.kt) ──

const nf = (d) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtNum = (v, d = 2) => nf(d).format(v);
const autoDecimals = (v) => (v === 0 || Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4);
const currencySymbol = (c) => ({ SEK: "kr", NOK: "kr", DKK: "kr", ISK: "kr", USD: "$", EUR: "€", GBP: "£", GBp: "p", JPY: "¥", CNY: "¥" })[c] ?? (c || "");

function money(v, cur) {
  const n = fmtNum(v, autoDecimals(v));
  return ["$", "€", "£"].includes(cur) ? cur + n : cur ? `${n} ${cur}` : n;
}
function fmtValue(type, v, cur) {
  if (v === null || v === undefined) return "–";
  if (type === "pe_ratio") return "P/E " + fmtNum(v);
  if (type === "pb_ratio") return "P/B " + fmtNum(v);
  if (type === "div_yield" || type === "equity_ratio") return fmtNum(v, 1) + " %";
  if (type === "debt_equity") return fmtNum(v);
  return money(v, cur);
}
function big(v, cur) {
  if (v === null || v === undefined) return "–";
  const a = Math.abs(v);
  if (a < 1e6) return money(v, cur);
  const billions = a >= 1e9;
  const n = billions ? v / 1e9 : v / 1e6;
  const t = fmtNum(n, Math.abs(n) >= 100 ? 0 : 1);
  return cur === "kr" ? `${t} ${billions ? "mdkr" : "Mkr"}` : `${t} ${billions ? "mdr" : "milj"} ${cur}`.trim();
}
function parseNumber(s) {
  const t = String(s).trim().replace(/[\s  ]/g, "").replace("−", "-").replace(",", ".");
  const n = Number(t);
  return t !== "" && isFinite(n) ? n : null;
}
/** "AB Volvo (publ)" → "AB Volvo" */
const cleanName = (n) => String(n || "").replace(/\s*\(publ\.?\)/i, "").trim();
const plain = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))).replace(".", ",");
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (t) => {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "idag " + time;
  if (d.toDateString() === new Date(now - 86400_000).toDateString()) return "igår " + time;
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) + " " + time;
};

function alertValue(a, q, b) {
  switch (a.type) {
    case "stock": case "crypto": return q?.price ?? null;
    case "pe_ratio": return q?.pe ?? null;
    case "pb_ratio": return q?.pb ?? null;
    case "div_yield": return q?.dividendYield ?? null;
    case "equity_ratio": return b?.equityRatio ?? null;
    case "debt_equity": return b?.debtEquity ?? null;
  }
  return null;
}
function missing(a, q, b) {
  if (REPORT.has(a.type)) return b ? "Negativt eget kapital?" : "Ingen balansräkning";
  if (!q) return "Ingen data";
  return ({ pe_ratio: "Inget P/E (förlust?)", pb_ratio: "Inget P/B", div_yield: "Ingen utdelning" })[a.type] || "Inget pris";
}
const curOf = (a, q) => a.currency || currencySymbol(q?.currency);
const rule = (a, cur) => `${a.direction === "above" ? "över" : "under"} ${fmtValue(a.type, a.threshold, cur)}`;

// ── Notiser ──

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    await navigator.serviceWorker.register("sw.js");
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

async function enablePush() {
  if (!pushSupported) {
    toast(isIos ? "Lägg först till appen på hemskärmen (se instruktionen)." : "Den här webbläsaren kan inte ta emot notiser.");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("Notiser är avstängda för sidan. Slå på dem i webbläsarens inställningar.");
    render();
    return;
  }
  const reg = await registration();
  if (!reg) return toast("Kunde inte starta notiserna.");
  try {
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(VAPID) }));
    if (!S.onServer) await pushToServer();
    await api("/v1/web/me/push", { method: "PUT", auth: true, body: sub.toJSON() });
    store.set(LS.endpoint, sub.endpoint);
    S.push = true;
    persist();
    toast("Notiserna är på! 🎉");
  } catch (e) {
    toast("Kunde inte slå på notiserna: " + e.message);
  }
  render();
}

async function disablePush() {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => {});
  await api("/v1/web/me/push", { method: "DELETE", auth: true }).catch(() => {});
  store.del(LS.endpoint);
  S.push = false;
  persist();
  render();
}

/** Om webbläsaren fått en ny prenumeration (eller servern tappat den) skickas den igen. */
async function syncPushSubscription() {
  if (!pushSupported || Notification.permission !== "granted" || !S.onServer) return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) {
    if (S.push) { S.push = false; persist(); }
    return;
  }
  if (!S.push || store.get(LS.endpoint) !== sub.endpoint) {
    try {
      await api("/v1/web/me/push", { method: "PUT", auth: true, body: sub.toJSON() });
      store.set(LS.endpoint, sub.endpoint);
      S.push = true;
      persist();
    } catch { /* nästa gång */ }
  }
}

// ── Vyer ──

const view = document.getElementById("view");
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function route() {
  const [, name = "", ...rest] = location.hash.replace(/^#/, "").split("/");
  return { name, arg: rest.map(decodeURIComponent).join("/") };
}

function render() {
  // Delad länk till webbappen: …/app/#PB1.xxx eller #F1.xxx (från delningssidan)
  const shared = location.hash.match(/^#(PB1\.[A-Za-z0-9_-]+|F1\.[A-Za-z0-9]{12,32})$/);
  if (shared) return location.replace("#/import/" + shared[1]);
  const { name, arg } = route();
  const fab = name === "" ? `<a class="btn fab" href="#/add">＋ Ny bevakning</a>` : "";
  let html;
  switch (name) {
    case "add": html = viewSearch(); break;
    case "new": html = viewForm(arg, null); break;
    case "edit": html = viewForm(null, arg); break;
    case "stock": html = viewStock(arg); break;
    case "settings": html = viewSettings(); break;
    case "notices": html = viewNotices(); break;
    case "import": html = viewImport(arg); break;
    default: html = viewHome();
  }
  view.innerHTML = html + fab;
  after[name]?.(arg);
}
const after = {};

function banners() {
  const out = [];
  if (isIos && !standalone && !store.get(LS.installHint)) {
    out.push(`<section class="card soft">
      <h2>📲 Lägg till på hemskärmen</h2>
      <p>På iPhone kommer notiser bara när appen ligger på hemskärmen. Gör det innan du lägger till bevakningar, annars hamnar de bara här i Safari.</p>
      <ol class="steps"><li>Tryck på <b>Dela</b> (rutan med pilen) längst ner i Safari.</li><li>Välj <b>Lägg till på hemskärmen</b>.</li><li>Öppna Prisbevakning från hemskärmen.</li></ol>
      <div class="row"><button class="btn ghost" data-act="hide-install">Jag fortsätter i Safari</button></div>
    </section>`);
  } else if (!S.push && S.alerts.length) {
    const denied = pushSupported && Notification.permission === "denied";
    out.push(`<section class="card soft">
      <h2>🔔 Slå på notiser</h2>
      <p>${denied ? "Notiser är blockerade för sidan. Tillåt dem i webbläsarens inställningar för den här sidan och ladda om." : "Servern kollar dina bevakningar var 30:e minut och säger till när något når ditt mål, även när appen är stängd."}</p>
      ${denied ? "" : `<div class="row"><button class="btn" data-act="push-on">Slå på notiser</button></div>`}
    </section>`);
  }
  if (S.offline) out.push(`<p class="muted small center">Ingen kontakt med servern just nu. Visar det som senast hämtades.</p>`);
  return out.join("");
}

function alertCard(a) {
  const q = S.values.quotes[a.symbol];
  const b = S.values.balances[a.symbol];
  const cur = curOf(a, q);
  const v = alertValue(a, q, b);
  const list = S.lists.find((l) => l.id === a.list);
  const paused = !a.active || list?.active === false;
  const hit = v !== null && (a.direction === "above" ? v >= a.threshold : v <= a.threshold);
  let status, pct = 0;
  if (v === null) {
    status = `<span class="muted">${h(missing(a, q, b))}</span>`;
  } else if (hit) {
    status = `<span class="up">✓ Målet är nått</span>`;
    pct = 100;
  } else {
    const dist = Math.abs(v - a.threshold) / Math.abs(v || 1) * 100;
    status = `<span class="muted">${fmtNum(dist, dist < 10 ? 1 : 0)} % kvar</span>`;
    pct = Math.max(4, 100 - Math.min(100, dist * 2));
  }
  const from = list && list.id !== "default" ? `<span class="badge">${h(list.name)}</span>` : "";
  return `<a class="alert-card${hit ? " hit" : ""}${paused ? " paused" : ""}" href="#/stock/${encodeURIComponent(a.symbol)}">
    <div class="alert-name">${h(a.name)}${from}</div>
    <div class="alert-value">${v === null ? "–" : h(fmtValue(a.type, v, cur))}</div>
    <div class="alert-sub">${h(TYPES[a.type].short)} ${h(rule(a, cur))}${paused ? " · pausad" : ""}</div>
    <div class="alert-status">${status}</div>
    <div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
  </a>`;
}

function viewHome() {
  const lists = S.lists;
  const shown = S.alerts.filter((a) => S.filter === "all" || a.list === S.filter);
  const chips = lists.length > 1
    ? `<div class="chips" role="group" aria-label="Listor">
        <button class="chip" data-act="filter" data-id="all" aria-pressed="${S.filter === "all"}">Alla</button>
        ${lists.map((l) => `<button class="chip" data-act="filter" data-id="${h(l.id)}" aria-pressed="${S.filter === l.id}">${h(l.name)}${l.active ? "" : " ⏸"}</button>`).join("")}
      </div>`
    : "";
  const body = S.alerts.length
    ? `${chips}<div class="alerts">${shown.map(alertCard).join("") || `<p class="muted center">Listan är tom.</p>`}</div>
       <p class="muted small center">${S.values.t ? "Värden hämtade " + when(S.values.t) + " · " : ""}<button class="btn ghost" data-act="refresh">Uppdatera</button></p>`
    : `<div class="empty"><div class="big">📈</div><h1>Inga bevakningar än</h1>
        <p class="muted">Sök upp en aktie eller ett krypto och välj en gräns. Du får en notis när värdet når dit.</p>
        <a class="btn" href="#/add">＋ Ny bevakning</a></div>`;
  return banners() + body;
}
after[""] = () => {
  if (S.alerts.length && Date.now() - S.values.t > 60_000) refreshValues().then(() => route().name === "" && render());
};

// Sök

let searchTimer = null, searchSeq = 0;
function viewSearch() {
  return `<h1>Ny bevakning</h1>
    <input class="input" id="q" type="search" placeholder="Sök aktie eller krypto, t.ex. Volvo eller Bitcoin" autocomplete="off" enterkeyhint="search" aria-label="Sök">
    <div id="results" class="results card" hidden></div>
    <p class="muted small">Svenska aktier slutar på .ST, krypto på -USD. Data från Yahoo Finance.</p>`;
}
after.add = () => {
  const q = document.getElementById("q");
  q.focus();
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(q.value.trim()), 300);
  });
};
async function search(q) {
  const box = document.getElementById("results");
  if (!box) return;
  if (q.length < 2) { box.hidden = true; return; }
  const seq = ++searchSeq;
  box.hidden = false;
  box.innerHTML = `<p class="muted">Söker…</p>`;
  try {
    const { results } = await api("/v1/web/search?q=" + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    box.innerHTML = results.length
      ? results.map((r) => `<button class="result" data-act="pick" data-symbol="${h(r.symbol)}" data-name="${h(r.name)}" data-kind="${h(r.kind)}">
          <b>${h(r.name)}</b><span class="muted small">${h(r.symbol)} · ${h(r.exchange)}${r.kind === "CRYPTOCURRENCY" ? " · krypto" : r.kind === "ETF" ? " · fond" : ""}</span></button>`).join("")
      : `<p class="muted">Inga träffar.</p>`;
  } catch {
    if (seq === searchSeq) box.innerHTML = `<p class="muted">Sökningen fungerar inte just nu.</p>`;
  }
}

// Formulär för ny/ändrad bevakning

function viewForm(symbol, editId) {
  let d = S.draft;
  if (editId && d?.id !== editId) {
    const a = S.alerts.find((x) => x.id === editId);
    if (!a) return `<p>Bevakningen finns inte längre.</p><a class="btn" href="#/">Till listan</a>`;
    d = S.draft = { ...a, isNew: false, thresholdText: plain(a.threshold) };
  }
  if (!editId && (!d || !d.isNew || d.symbol !== symbol)) {
    const crypto = /-USD$|-EUR$/.test(symbol) && S.pickedKind === "CRYPTOCURRENCY";
    d = S.draft = {
      id: newId(), isNew: true, symbol, name: S.pickedName || symbol, type: crypto ? "crypto" : "stock",
      direction: "below", threshold: null, thresholdText: "", currency: "", cooldown_hours: 24,
      active: true, insider: !crypto, list: S.filter !== "all" ? S.filter : "default",
    };
  }
  const info = S.stock[d.symbol];
  const q = info?.quote || S.values.quotes[d.symbol];
  const b = info?.balance || S.values.balances[d.symbol];
  const cur = curOf(d, q);
  const now = alertValue(d, q, b);
  const types = d.type === "crypto" ? ["crypto"] : STOCK_TYPES;
  const unit = d.type === "div_yield" || d.type === "equity_ratio" ? "%" : d.type === "pe_ratio" ? "P/E" : d.type === "pb_ratio" ? "P/B" : d.type === "debt_equity" ? "ggr" : cur;
  const quick = now !== null ? [-10, -5, 5, 10].map((p) => `<button class="chip" data-act="quick" data-p="${p}">${p > 0 ? "+" : ""}${p} %</button>`).join("") : "";
  return `<div class="stock-head">
      <h1>${h(d.name)}</h1>
      <p class="muted">${h(d.symbol)}${q?.price != null ? " · " + h(money(q.price, currencySymbol(q.currency))) : ""}</p>
    </div>
    <section class="card">
      ${types.length > 1 ? `<div class="chips wrap" role="group" aria-label="Vad ska bevakas">${types.map((t) => `<button class="chip" data-act="type" data-type="${t}" aria-pressed="${d.type === t}">${TYPES[t].label}</button>`).join("")}</div>` : ""}
      ${HELP[d.type] ? `<p class="muted small">${h(HELP[d.type])}</p>` : ""}
      <p>Nu: <b class="num">${now === null ? (info || q ? h(missing(d, q, b)) : "hämtar…") : h(fmtValue(d.type, now, cur))}</b>${REPORT.has(d.type) && b ? `<span class="muted small"> · rapport ${h(b.asOf)}</span>` : ""}</p>
      <div class="seg" role="group" aria-label="Riktning">
        <button data-act="dir" data-dir="below" aria-pressed="${d.direction === "below"}">Larma under</button>
        <button data-act="dir" data-dir="above" aria-pressed="${d.direction === "above"}">Larma över</button>
      </div>
      <label class="field">Gräns
        <span class="input-wrap"><input class="input num" id="threshold" inputmode="decimal" autocomplete="off" value="${h(d.thresholdText)}" placeholder="${now !== null ? h(plain(+now.toFixed(2))) : ""}"><span class="unit">${h(unit)}</span></span>
      </label>
      ${quick ? `<div class="chips">${quick}</div>` : ""}
      ${S.lists.length > 1 ? `<label class="field">Lista<select class="input" id="list">${S.lists.map((l) => `<option value="${h(l.id)}"${l.id === d.list ? " selected" : ""}>${h(l.name)}</option>`).join("")}</select></label>` : ""}
      ${!REPORT.has(d.type) ? `<label class="field">Påminn igen efter
        <select class="input" id="cooldown">${[[6, "6 timmar"], [12, "12 timmar"], [24, "1 dygn"], [72, "3 dygn"], [168, "1 vecka"]].map(([v, t]) => `<option value="${v}"${d.cooldown_hours === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>` : `<p class="muted small">Nyckeltal från rapporten ger en notis per ny rapport.</p>`}
      ${d.symbol.endsWith(".ST") ? `<label class="toggle"><span>Notis när någon i ledningen köper eller säljer</span><input type="checkbox" id="insider-toggle"${d.insider ? " checked" : ""}></label>` : ""}
      <div class="row">
        <button class="btn" data-act="save">${d.isNew ? "Spara bevakning" : "Spara ändringar"}</button>
        ${d.isNew ? `<a class="btn ghost" href="#/add">Avbryt</a>` : `<button class="btn secondary" data-act="toggle-active">${d.active ? "Pausa" : "Återuppta"}</button>`}
      </div>
      ${d.isNew ? "" : `<div class="row"><button class="btn danger" data-act="delete">Ta bort bevakningen</button></div>`}
    </section>
    ${d.isNew && d.type !== "crypto" ? `<h2 class="section-title">Om aktien</h2><div id="details">${stockDetails(d.symbol)}</div>` : ""}`;
}
after.new = after.edit = () => {
  const d = S.draft;
  if (!d) return;
  const t = document.getElementById("threshold");
  t?.addEventListener("input", () => (d.thresholdText = t.value));
  document.getElementById("list")?.addEventListener("change", (e) => (d.list = e.target.value));
  document.getElementById("cooldown")?.addEventListener("change", (e) => (d.cooldown_hours = Number(e.target.value)));
  document.getElementById("insider-toggle")?.addEventListener("change", (e) => (d.insider = e.target.checked));
  loadStock(d.symbol);
};

function saveDraft() {
  const d = S.draft;
  const v = parseNumber(d.thresholdText);
  if (v === null) return toast("Skriv en gräns, till exempel 250.");
  const q = S.stock[d.symbol]?.quote || S.values.quotes[d.symbol];
  const a = {
    id: d.id, name: d.name, symbol: d.symbol, type: d.type, threshold: v, direction: d.direction,
    currency: d.type === "stock" || d.type === "crypto" ? currencySymbol(q?.currency) : "",
    cooldown_hours: d.cooldown_hours, active: d.active, insider: d.insider && d.type !== "crypto", list: d.list,
  };
  const i = S.alerts.findIndex((x) => x.id === a.id);
  if (i >= 0) S.alerts[i] = a; else S.alerts.push(a);
  if (q) S.values.quotes[a.symbol] = q;
  const bal = S.stock[d.symbol]?.balance;
  if (bal) S.values.balances[a.symbol] = bal;
  S.draft = null;
  save();
  toast(i >= 0 ? "Ändringen är sparad." : "Bevakningen är sparad.");
  location.hash = "#/";
}

// Aktiekortet

async function loadStock(symbol) {
  if (!symbol || S.stock[symbol]?.loading) return;
  if (S.stock[symbol]?.quote !== undefined && Date.now() - S.stock[symbol].t < 300_000) return;
  S.stock[symbol] = { ...(S.stock[symbol] || {}), loading: true };
  try {
    const r = await api("/v1/web/stock/" + encodeURIComponent(symbol));
    S.stock[symbol] = { ...r, t: Date.now() };
  } catch {
    S.stock[symbol] = { quote: null, balance: null, profile: null, error: true, t: Date.now() };
  }
  const { name, arg } = route();
  if ((name === "stock" && arg === symbol) || ((name === "new" || name === "edit") && S.draft?.symbol === symbol)) {
    const scroll = window.scrollY;
    const focused = document.activeElement?.id;
    render();
    window.scrollTo(0, scroll);
    if (focused) document.getElementById(focused)?.focus();
  }
  if (symbol.endsWith(".ST") && S.stock[symbol].quote?.name) loadInsider(symbol, S.insiderMonths || 12);
}

function viewStock(symbol) {
  const info = S.stock[symbol];
  const q = info?.quote || S.values.quotes[symbol];
  const mine = S.alerts.filter((a) => a.symbol === symbol);
  const name = cleanName(q?.name) || mine[0]?.name || symbol;
  const change = q?.changePercent;
  return `<div class="stock-head">
      <p class="muted">${h(symbol)}</p>
      <h1>${h(name)}</h1>
      <div class="row"><span class="price">${q?.price != null ? h(money(q.price, currencySymbol(q.currency))) : `<span class="skeleton">000,00 kr</span>`}</span>
      ${change != null ? `<span class="${change >= 0 ? "up" : "down"} num">${change >= 0 ? "▲" : "▼"} ${fmtNum(Math.abs(change))} % idag</span>` : ""}</div>
    </div>
    <section class="card">
      <div class="section-title"><h2>Dina bevakningar</h2></div>
      ${mine.length ? mine.map((a) => {
        const cur = curOf(a, q);
        return `<a class="row spread" href="#/edit/${encodeURIComponent(a.id)}" style="text-decoration:none;color:inherit">
          <span><b>${h(TYPES[a.type].label)}</b> ${h(rule(a, cur))}${a.active ? "" : ' <span class="muted">· pausad</span>'}</span><span class="muted">Ändra ›</span></a>`;
      }).join("") : `<p class="muted">Ingen bevakning på den här än.</p>`}
      <div class="row"><button class="btn secondary" data-act="new-on" data-symbol="${h(symbol)}" data-name="${h(name)}">＋ Ny bevakning</button></div>
    </section>
    ${/-USD$/.test(symbol) && q && !info?.profile ? "" : stockDetails(symbol)}`;
}
after.stock = (symbol) => loadStock(symbol);

function stockDetails(symbol) {
  const info = S.stock[symbol];
  if (!info || info.loading && info.quote === undefined) return `<section class="card"><p class="muted">Hämtar bolagsfakta…</p></section>`;
  if (info.error) return `<section class="card"><p class="muted">Kunde inte hämta bolagsfakta just nu.</p></section>`;
  const q = info.quote || {};
  const b = info.balance;
  const p = info.profile;
  const cur = currencySymbol(q.currency);
  const rep = currencySymbol(b?.currency || q.reportCurrency || q.currency);
  const out = [];
  if (p) {
    out.push(`<section class="card"><h2>Om bolaget</h2>
      <p class="muted small">${[p.sector, p.industry].filter(Boolean).map(h).join(" · ")}${p.employees ? " · " + fmtNum(p.employees, 0) + " anställda" : ""}${p.country ? " · " + h(p.country) : ""}</p>
      ${p.summary ? `<p class="summary-text" id="summary">${h(p.summary)}</p><button class="btn ghost" data-act="more" style="justify-self:start">Visa mer</button>` : ""}
      ${p.website ? `<a href="${h(p.website)}" target="_blank" rel="noopener">${h(p.website.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : ""}
    </section>`);
  }
  const rows = [
    ["P/E-tal", q.pe != null ? fmtNum(q.pe) : "–"],
    ["P/B-tal", q.pb != null ? fmtNum(q.pb) : "–"],
    ["Direktavkastning", q.dividendYield != null ? fmtNum(q.dividendYield, 1) + " %" : "–"],
    ["Eget kapital per aktie", q.bookValue != null ? money(q.bookValue, rep) : "–"],
    ["52 veckor, lägst – högst", q.low52 != null ? `${fmtNum(q.low52, autoDecimals(q.low52))} – ${fmtNum(q.high52, autoDecimals(q.high52))}` : "–"],
    ["Börsvärde", q.marketCap != null ? big(q.marketCap, cur) : "–"],
  ];
  out.push(`<section class="card"><h2>Nyckeltal</h2><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${h(v)}</dd>`).join("")}</dl>
    ${q.reportCurrency && q.currency && q.reportCurrency !== q.currency ? `<p class="muted small">Bolaget rapporterar i ${h(q.reportCurrency)} men handlas i ${h(q.currency)}, så P/B och eget kapital per aktie kan vara missvisande.</p>` : ""}</section>`);
  if (b) {
    const brows = [
      ["Tillgångar", big(b.assets, rep)], ["Eget kapital", big(b.equity, rep)], ["Lån", big(b.debt, rep)],
      ["Kassa", big(b.cash, rep)], ["Nettoskuld", big(b.netDebt, rep)],
      ["Soliditet", b.equityRatio != null ? fmtNum(b.equityRatio, 1) + " %" : "–"],
      ["Skuldsättningsgrad", b.debtEquity != null ? fmtNum(b.debtEquity) : "–"],
    ];
    out.push(`<section class="card"><div class="section-title"><h2>Balansräkning</h2><span class="muted small">per ${h(b.asOf)}</span></div>
      <dl class="kv">${brows.map(([k, v]) => `<dt>${k}</dt><dd>${h(v)}</dd>`).join("")}</dl></section>`);
  }
  if (symbol.endsWith(".ST")) out.push(insiderSection(symbol));
  return out.join("");
}

// Insynshandel

function issuerOf(symbol) {
  const n = S.stock[symbol]?.quote?.name || "";
  return n.replace(/\s*\(publ\)\s*/i, " ").trim();
}
async function loadInsider(symbol, months) {
  const issuer = issuerOf(symbol);
  const key = issuer + "|" + months;
  if (!issuer || S.insider[key]) return;
  S.insider[key] = { loading: true };
  try {
    S.insider[key] = await api(`/v1/web/insider?issuer=${encodeURIComponent(issuer)}&months=${months}`);
  } catch {
    S.insider[key] = { error: true };
  }
  const box = document.getElementById("insider");
  if (box) box.outerHTML = insiderSection(symbol);
}
function insiderSection(symbol) {
  const months = S.insiderMonths || 12;
  const kind = S.insiderKind || "all";
  const data = S.insider[issuerOf(symbol) + "|" + months];
  let body;
  if (!data || data.loading) body = `<p class="muted">Hämtar från Finansinspektionen…</p>`;
  else if (data.error) body = `<p class="muted">Finansinspektionen svarar inte just nu.</p>`;
  else {
    const all = data.trades;
    const sum = (k) => all.filter((t) => t.kind === k).reduce((s, t) => s + (t.amount || 0), 0);
    const count = (k) => all.filter((t) => t.kind === k).length;
    const cur = currencySymbol(all.find((t) => t.currency)?.currency || "SEK");
    const shown = all.filter((t) => kind === "all" || t.kind === kind).slice(0, 40);
    body = all.length
      ? `<div class="stats">
          <div class="stat buy"><span class="small">Köp</span><b>${count("köp")} st</b><span class="small num">${h(big(sum("köp"), cur))}</span></div>
          <div class="stat sell"><span class="small">Sälj</span><b>${count("sälj")} st</b><span class="small num">${h(big(sum("sälj"), cur))}</span></div>
        </div>
        <div class="seg" role="group" aria-label="Visa">${[["all", "Alla"], ["köp", "Köp"], ["sälj", "Sälj"]].map(([k, t]) => `<button data-act="ins-kind" data-k="${k}" data-symbol="${h(symbol)}" aria-pressed="${kind === k}">${t}</button>`).join("")}</div>
        <div>${shown.map((t) => `<div class="trade">
            <span class="who">${h(t.who)}</span>
            <span class="amt">${t.amount != null ? h(big(t.amount, currencySymbol(t.currency))) : ""}</span>
            <span class="muted small">${t.kind === "köp" ? '<span class="pill buy">Köp</span>' : t.kind === "sälj" ? '<span class="pill sell">Sälj</span>' : h(t.action)} ${h(t.date)}${t.role ? " · " + h(t.role) : ""}${t.relatedTo ? " · närstående till " + h(t.relatedTo) : ""}</span>
            <span class="muted small amt">${t.volume != null ? fmtNum(t.volume, 0) + " st" : ""}${t.price != null ? " à " + fmtNum(t.price) : ""}</span>
          </div>`).join("") || `<p class="muted">Inga sådana affärer.</p>`}</div>`
      : `<p class="muted">Inga insynsaffärer de senaste ${months} månaderna.</p>`;
  }
  return `<section class="card" id="insider">
    <div class="section-title"><h2>Insynshandel</h2><a class="small" href="https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Start/Insyn" target="_blank" rel="noopener">FI ›</a></div>
    <div class="seg" role="group" aria-label="Period">${[3, 6, 12].map((m) => `<button data-act="ins-months" data-m="${m}" data-symbol="${h(symbol)}" aria-pressed="${months === m}">${m} mån</button>`).join("")}</div>
    ${body}
  </section>`;
}

// Inställningar

function viewSettings() {
  const denied = pushSupported && Notification.permission === "denied";
  const pushCard = !pushSupported
    ? `<p>${isIos && !standalone ? "På iPhone: lägg till appen på hemskärmen (Dela → Lägg till på hemskärmen) och öppna den därifrån, så går notiser att slå på." : "Den här webbläsaren kan inte ta emot notiser."}</p>`
    : S.push
      ? `<p>✅ Notiserna är på. Servern kollar var 30:e minut, insynshandel var tredje timme.</p>
         <div class="row"><button class="btn secondary" data-act="push-test">Skicka en testnotis</button><button class="btn ghost" data-act="push-off">Stäng av</button></div>`
      : denied
        ? `<p>Notiser är blockerade för sidan. Tillåt dem i webbläsarens inställningar och ladda om.</p>`
        : `<p>Av. Slå på för att få en notis när en bevakning når sitt mål.</p><div class="row"><button class="btn" data-act="push-on">Slå på notiser</button></div>`;
  return `<h1>Inställningar</h1>
    <section class="card"><h2>🔔 Notiser</h2>${pushCard}</section>
    <section class="card"><h2>📂 Listor</h2>
      ${S.lists.map((l) => `<div class="row spread">
        <span><b>${h(l.name)}</b>${l.from ? ` <span class="muted small">från ${h(l.from)}</span>` : ""}<br><span class="muted small">${S.alerts.filter((a) => a.list === l.id).length} bevakningar${l.active ? "" : " · pausad"}</span></span>
        <span class="row"><button class="btn ghost" data-act="list-toggle" data-id="${h(l.id)}">${l.active ? "Pausa" : "Återuppta"}</button>
        ${l.id === "default" ? "" : `<button class="btn ghost" data-act="list-delete" data-id="${h(l.id)}" style="color:var(--down)">Ta bort</button>`}</span>
      </div>`).join("")}
      <div class="row"><input class="input" id="newlist" placeholder="Ny lista, t.ex. Utdelning" aria-label="Namn på ny lista" style="flex:1 1 180px"><button class="btn secondary" data-act="list-add">Lägg till</button></div>
    </section>
    <section class="card"><h2>🔗 Lägg till en delad lista</h2>
      <p class="muted small">Klistra in en länk som någon delat från Prisbevakning (Android-appen eller webbappen).</p>
      <div class="row"><input class="input" id="sharelink" placeholder="https://sampe24.github.io/prisbevakning/#…" aria-label="Delad länk" style="flex:1 1 180px"><button class="btn secondary" data-act="import-link">Öppna</button></div>
    </section>
    <section class="card"><h2>ℹ️ Om webbappen</h2>
      <p class="small">Dina bevakningar sparas på servern under ett hemligt id som bara finns i den här webbläsaren. Det finns ingen inloggning, så rensar du webbläsarens data eller byter telefon börjar du om från början.</p>
      <p class="small muted">Kurser och nyckeltal från Yahoo Finance (kan vara fördröjda ca 15 min), insynshandel från Finansinspektionen. Appen ger inga köp- eller säljråd. Har du Android finns även <a href="../om/">appen</a>.</p>
      <div class="row"><button class="btn danger" data-act="wipe">Radera allt</button></div>
    </section>`;
}

function viewNotices() {
  return `<h1>Senaste notiser</h1>
    <section class="card">${S.notices.length ? S.notices.map((n) => `<a class="notice" href="${h(n.url && n.url.startsWith(location.origin) ? n.url.slice(n.url.indexOf("#")) : "#/")}">
      <span class="muted small">${h(when(n.t))}</span><b>${h(n.title)}</b><p>${h(n.body)}</p></a>`).join("")
      : `<p class="muted">Inga notiser än. De ${S.push ? "dyker upp här när en bevakning når sitt mål" : "kommer när du slagit på notiser och en bevakning når sitt mål"}.</p>`}</section>`;
}
after.notices = async () => {
  if (!S.onServer) return;
  try {
    const me = await api("/v1/web/me", { auth: true });
    S.notices = me.notices || [];
    persist();
    if (route().name === "notices") view.innerHTML = viewNotices();
  } catch { /* visar det sparade */ }
};

// Importera en delad lista (samma kompakta format som Android-appens Share.kt)

const imports = {};
function viewImport(token) {
  const data = imports[token];
  if (!data) return `<h1>Delad lista</h1><p class="muted">Hämtar listan…</p>`;
  if (data.error) return `<h1>Delad lista</h1><p>${h(data.error)}</p><a class="btn" href="#/">Till listan</a>`;
  const alerts = (data.a || []).filter((a) => TYPES[a.t] && a.s);
  return `<h1>${h(data.n || "Delad lista")}</h1>
    <p class="muted">${data.f ? h(data.f) + " delar " : ""}${alerts.length} ${alerts.length === 1 ? "bevakning" : "bevakningar"}</p>
    <section class="card">${alerts.map((a) => `<div><b>${h(a.n || a.s)}</b><br><span class="muted small">${h(a.s)} · ${h(TYPES[a.t].label)} ${h(rule({ type: a.t, direction: a.u ? "above" : "below", threshold: Number(a.x) }, a.c || ""))}</span></div>`).join("")}</section>
    <div class="row"><button class="btn" data-act="import-save" data-token="${h(token)}">Lägg till som ny lista</button><a class="btn ghost" href="#/">Avbryt</a></div>
    <p class="muted small">Listan kopieras. Ändringar som avsändaren gör senare kommer inte med.</p>`;
}
after.import = async (token) => {
  if (imports[token]) return;
  try {
    if (token.startsWith("F1.")) {
      const r = await fetch(SERVER + "/v1/feed/" + encodeURIComponent(token.slice(3)));
      imports[token] = r.status === 404 ? { error: "Listan delas inte längre." } : await r.json();
    } else if (token.startsWith("PB1.")) {
      const stream = new Blob([fromB64url(token.slice(4))]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      imports[token] = JSON.parse(await new Response(stream).text());
    } else {
      imports[token] = { error: "Länken känns inte igen." };
    }
  } catch {
    imports[token] = { error: "Länken verkar vara ofullständig." };
  }
  if (route().name === "import") render();
};
function importSave(token) {
  const data = imports[token];
  const list = { id: newId(), name: String(data.n || "Delad lista").slice(0, 60), active: true, from: String(data.f || "").slice(0, 40) };
  const alerts = (data.a || []).filter((a) => TYPES[a.t] && a.s && isFinite(Number(a.x))).map((a) => ({
    id: newId(), name: String(a.n || a.s).slice(0, 80), symbol: String(a.s).toUpperCase(), type: a.t, threshold: Number(a.x),
    direction: a.u ? "above" : "below", currency: a.c || "", cooldown_hours: a.h || 24, active: true,
    insider: a.q !== 0 && a.t !== "crypto", list: list.id,
  }));
  S.lists.push(list);
  S.alerts.push(...alerts);
  S.filter = list.id;
  save();
  toast(`${alerts.length} bevakningar tillagda i "${list.name}".`);
  location.hash = "#/";
  refreshValues().then(render);
}

// ── Händelser ──

const armed = new Set();
function confirmTap(btn, key, text) {
  if (armed.has(key)) { armed.delete(key); return true; }
  armed.add(key);
  btn.classList.add("armed");
  btn.textContent = text;
  setTimeout(() => { armed.delete(key); if (btn.isConnected) render(); }, 4000);
  return false;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const d = S.draft;
  switch (act) {
    case "filter": S.filter = el.dataset.id; render(); break;
    case "refresh": el.disabled = true; await refreshValues(); render(); break;
    case "hide-install": store.set(LS.installHint, 1); render(); break;
    case "push-on": el.disabled = true; await enablePush(); break;
    case "push-off": await disablePush(); toast("Notiserna är avstängda."); break;
    case "push-test":
      el.disabled = true;
      try { await api("/v1/web/me/test", { method: "POST", auth: true }); toast("Testnotisen är skickad."); }
      catch (err) { toast(err.status === 409 ? "Notiserna är inte på." : "Testnotisen gick inte fram: " + err.message); await syncPushSubscription(); }
      render();
      break;
    case "pick":
      S.pickedName = cleanName(el.dataset.name);
      S.pickedKind = el.dataset.kind;
      S.draft = null;
      location.hash = "#/new/" + encodeURIComponent(el.dataset.symbol);
      break;
    case "new-on":
      S.pickedName = cleanName(el.dataset.name);
      S.pickedKind = /-USD$/.test(el.dataset.symbol) && !S.stock[el.dataset.symbol]?.profile ? "CRYPTOCURRENCY" : "EQUITY";
      S.draft = null;
      location.hash = "#/new/" + encodeURIComponent(el.dataset.symbol);
      break;
    case "type":
      d.type = el.dataset.type;
      d.direction = defaultAbove(d.type) ? "above" : "below";
      d.thresholdText = "";
      render();
      break;
    case "dir": d.direction = el.dataset.dir; render(); break;
    case "quick": {
      const info = S.stock[d.symbol];
      const now = alertValue(d, info?.quote || S.values.quotes[d.symbol], info?.balance || S.values.balances[d.symbol]);
      if (now === null) break;
      const v = now * (1 + Number(el.dataset.p) / 100);
      d.thresholdText = plain(+v.toFixed(Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4));
      d.direction = Number(el.dataset.p) < 0 ? "below" : "above";
      render();
      break;
    }
    case "save": saveDraft(); break;
    case "toggle-active": d.active = !d.active; render(); break;
    case "delete":
      if (!confirmTap(el, "del", "Tryck igen för att ta bort")) break;
      S.alerts = S.alerts.filter((a) => a.id !== d.id);
      S.draft = null;
      save();
      toast("Bevakningen är borttagen.");
      location.hash = "#/";
      break;
    case "more": {
      const s = document.getElementById("summary");
      s.classList.toggle("open");
      el.textContent = s.classList.contains("open") ? "Visa mindre" : "Visa mer";
      break;
    }
    case "ins-months":
      S.insiderMonths = Number(el.dataset.m);
      document.getElementById("insider").outerHTML = insiderSection(el.dataset.symbol);
      loadInsider(el.dataset.symbol, S.insiderMonths);
      break;
    case "ins-kind":
      S.insiderKind = el.dataset.k;
      document.getElementById("insider").outerHTML = insiderSection(el.dataset.symbol);
      break;
    case "list-toggle": {
      const l = S.lists.find((x) => x.id === el.dataset.id);
      l.active = !l.active;
      save();
      render();
      break;
    }
    case "list-delete": {
      const l = S.lists.find((x) => x.id === el.dataset.id);
      if (!confirmTap(el, "list" + l.id, "Tryck igen: listan och dess bevakningar tas bort")) break;
      S.lists = S.lists.filter((x) => x.id !== l.id);
      S.alerts = S.alerts.filter((a) => a.list !== l.id);
      if (S.filter === l.id) S.filter = "all";
      save();
      render();
      break;
    }
    case "list-add": {
      const name = document.getElementById("newlist").value.trim();
      if (!name) break;
      S.lists.push({ id: newId(), name: name.slice(0, 60), active: true, from: "" });
      save();
      render();
      break;
    }
    case "import-link": {
      const m = document.getElementById("sharelink").value.match(/(PB1\.[A-Za-z0-9_-]+|F1\.[A-Za-z0-9]{12,32})/);
      if (!m) { toast("Hittar ingen lista i länken."); break; }
      location.hash = "#/import/" + m[0];
      break;
    }
    case "import-save": importSave(el.dataset.token); break;
    case "wipe":
      if (!confirmTap(el, "wipe", "Tryck igen: allt raderas")) break;
      await disablePush().catch(() => {});
      await api("/v1/web/me", { method: "DELETE", auth: true }).catch(() => {});
      for (const k of Object.values(LS)) store.del(k);
      location.hash = "#/";
      location.reload();
      break;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "threshold") saveDraft();
  if (e.key === "Enter" && e.target.id === "newlist") document.querySelector('[data-act="list-add"]')?.click();
});
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type !== "push") return;
  window.lastPush = e.data.title;
  refreshValues().then(() => after.notices()).then(render);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && route().name === "") refreshValues().then(() => route().name === "" && render());
});

render();
registration();
loadFromServer().then(() => { refreshValues().then(render); });
