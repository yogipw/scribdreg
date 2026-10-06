/**
 * Scribd Auto Trial — FULL API (tanpa browser).
 * Lihat SNIFF-API.md untuk dokumentasi endpoint.
 *
 *   node scribd-api.js [--reg-only]
 *
 * --reg-only: berhenti setelah akun + cart jadi (tanpa Stripe/GoPay).
 *   Cocok untuk autoreg dulu, bayar belakangan.
 *
 * Input manual (terminal) — HANYA yang tidak bisa di-API-kan:
 *   [1] Captcha Turnstile: otomatis via solver service (2captcha/NopeCHA,
 *       set turnstile_solver di config). Fallback: jendela Camoufox
 *       (dengan cookie sesi) lalu --paste-token untuk paste manual.
 *   [2] OTP SMS/WhatsApp GoPay — baca HP, paste
 *   [3] Unlink GoPay di aplikasi kalau nomor "already linked" (lalu Enter)
 * PIN GoPay + nomor HP diambil dari config-scribd.json (otomatis).
 */
import { readFileSync, appendFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import * as readline from "readline";
import { createTempEmail } from "./temp-email.js";
import { genPassword } from "./lib/camoufox-browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, "config-scribd.json"), "utf-8")
);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const AUTO = process.argv.includes("--auto");

const LOG_FILE = join(__dirname, "scribd-api.log");
try { readFileSync(LOG_FILE); } catch { /* abaikan */ }

const C = {
  r: "\x1b[0m", b: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m",
};
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

/* Masking input sensitif buat log (struktur tetap kelihatan). */
function maskSecrets(obj) {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const kl = String(k).toLowerCase();
    if (/password|passwd/.test(kl)) out[k] = "***";
    else if (/(^|_)(pin|otp|cvv|cvc)$/.test(kl) || /^(pin|otp)$/.test(kl)) out[k] = "***";
    else if (/token|secret|captcha|authorization|client_secret|clientkey|api_key|apikey/.test(kl)) {
      out[k] = typeof v === "string" && v.length > 14 ? v.slice(0, 10) + `…(${v.length})` : "***";
    } else if (/phone/.test(kl) && typeof v === "string" && v.length > 5) {
      out[k] = v.slice(0, 3) + "***" + v.slice(-2);
    } else if (typeof v === "string" && /^\d{8,}$/.test(v.replace(/[\s-]/g, ""))) {
      const d = v.replace(/[\s-]/g, "");
      out[k] = d.slice(0, 4) + "***" + d.slice(-4);
    } else out[k] = maskSecrets(v);
  }
  return out;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 70 ? u.pathname.slice(0, 70) + "…" : u.pathname;
    return u.hostname + p;
  } catch {
    return String(url).slice(0, 90);
  }
}

function formToObj(form) {
  try {
    const s = form instanceof URLSearchParams ? form.toString() : String(form);
    return Object.fromEntries(new URLSearchParams(s));
  } catch {
    return null;
  }
}

/* Box kredensial / info biar menarik (console warna + file polos). */
function showBox(title, rows) {
  const W = 64;
  const bar = "─".repeat(W - 2);
  const lines = [`┌${bar}┐`, (`│ ${title}`).padEnd(W - 1) + "│", `├${bar}┤`];
  for (const [k, v] of rows) lines.push((`│ ${k} : ${v}`).padEnd(W - 1) + "│");
  lines.push(`└${bar}┘`);
  for (const l of lines) {
    console.log(`${C.cyan}${C.b}${l}${C.r}`);
    writeLog(l);
  }
}
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
function writeLog(line) {
  try {
    appendFileSync(LOG_FILE, `[${ts()}] ` + stripAnsi(line) + "\n");
  } catch { /* abaikan */ }
}
const log = {
  ok: (t) => { console.log(`${C.green}✔${C.r} ${t}`); writeLog(`✔ ${t}`); },
  info: (t) => { console.log(`${C.cyan}▸${C.r} ${t}`); writeLog(`▸ ${t}`); },
  warn: (t) => { console.log(`${C.yellow}⚠${C.r} ${t}`); writeLog(`⚠ ${t}`); },
  err: (t) => { console.log(`${C.red}✖${C.r} ${t}`); writeLog(`✖ ${t}`); },
  step: (n, t) => { console.log(`\n${C.b}${C.cyan}[${n}]${C.r} ${C.b}${t}${C.r}`); writeLog(`[${n}] ${t}`); },
  dim: (t) => { console.log(`${C.gray}${t}${C.r}`); writeLog(`${t}`); },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise((res) => rl.question(`${C.yellow}>>> ${q}${C.r} `, (a) => res(a.trim())));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- cookie jar per-host (tanpa deps) ---------- */
const jars = new Map();
function jarGet(url) {
  const h = new URL(url).hostname;
  const m = jars.get(h);
  return m ? [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}
function jarSet(url, headers) {
  const h = new URL(url).hostname;
  let list = [];
  try {
    list = headers.getSetCookie ? headers.getSetCookie() : [];
  } catch { list = []; }
  if (!list.length) {
    const single = headers.get("set-cookie");
    if (single) list = [single];
  }
  if (!list.length) return;
  if (!jars.has(h)) jars.set(h, new Map());
  const m = jars.get(h);
  for (const c of list) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function req(method, url, { json, form, headers = {}, timeout = 30000 } = {}) {
  const h = { "User-Agent": UA, ...headers };
  const ck = jarGet(url);
  if (ck) h["Cookie"] = ck;
  let body;
  let payloadLog = "";
  if (json !== undefined) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(json);
    try {
      const m = JSON.stringify(maskSecrets(json));
      if (m && m !== "{}") payloadLog = m;
    } catch { /* abaikan */ }
  } else if (form !== undefined) {
    h["Content-Type"] = "application/x-www-form-urlencoded";
    body = form instanceof URLSearchParams ? form.toString() : String(form);
    const o = formToObj(form);
    if (o) {
      try {
        const m = JSON.stringify(maskSecrets(o));
        if (m && m !== "{}") payloadLog = m;
      } catch { /* abaikan */ }
    }
  }
  log.dim(`   → ${method} ${shortUrl(url)}`);
  if (payloadLog) log.dim(`     in: ${payloadLog.slice(0, 500)}`);
  const res = await fetch(url, {
    method, headers: h, body, redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  jarSet(url, res.headers);
  const loc = res.headers.get("location");
  if (loc) log.dim(`   ← ${res.status} -> ${shortUrl(new URL(loc, url).toString())}`);
  else log.dim(`   ← ${res.status}`);
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { status: res.status, location: loc, text, json: data };
}

async function followRedirects(url, max = 8) {
  let cur = url;
  for (let i = 0; i < max; i++) {
    const r = await req("GET", cur, { headers: { Accept: "text/html,*/*" } });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
      cur = new URL(r.location, cur).toString();
      log.dim(`   redirect -> ${cur.slice(0, 110)}`);
      continue;
    }
    return { url: cur, status: r.status, text: r.text };
  }
  throw new Error("Terlalu banyak redirect: " + cur.slice(0, 120));
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = d.slice(1);
  else if (d.startsWith("62") && d.length > 11) d = d.slice(2);
  return d;
}

function jarCookies(host) {
  const m = jars.get(host);
  if (!m) return [];
  return [...m.entries()].map(([name, value]) => ({ name, value, domain: host, path: "/" }));
}

const TURNSTILE_SITEKEY = "0x4AAAAAACwSuI5jPtwnNwc5";

/* Ambil action/cdata Turnstile dari HTML /u/signup (opsional, untuk solver). */
function extractTurnstileParams(html) {
  const out = {};
  let m = /data-action\s*=\s*["']([^"']+)["']/i.exec(html || "");
  if (m) out.action = m[1];
  m = /data-cdata\s*=\s*["']([^"']+)["']/i.exec(html || "");
  if (m) out.cdata = m[1];
  m = /turnstile\.render\([^,]+,\s*\{[^}]*sitekey['"]?\s*:\s*['"]([^'"]+)['"]/i.exec(html || "");
  if (m) out.sitekey = m[1];
  return out;
}

/* 2captcha: TurnstileTaskProxyless -> token. */
async function solveTurnstile2Captcha(pageUrl, apiKey, extra = {}, timeoutMs = 180000) {
  log.info("solver 2captcha: buat task...");
  const task = { type: "TurnstileTaskProxyless", websiteURL: pageUrl, websiteKey: TURNSTILE_SITEKEY };
  if (extra.action) task.action = extra.action;
  if (extra.cdata) task.data = extra.cdata;
  if (extra.pagedata) task.pagedata = extra.pagedata;
  const c = await req("POST", "https://api.2captcha.com/createTask", {
    json: { clientKey: apiKey, task },
    headers: { Accept: "application/json" },
  });
  if (c.json?.errorId !== 0 || !c.json?.taskId) {
    throw new Error("2captcha createTask: " + (c.json?.errorDescription || c.text || ("HTTP " + c.status)).slice(0, 200));
  }
  const taskId = c.json.taskId;
  log.info(`2captcha task ${taskId}, tunggu hasil...`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(5000);
    const r = await req("POST", "https://api.2captcha.com/getTaskResult", {
      json: { clientKey: apiKey, taskId },
      headers: { Accept: "application/json" },
    });
    if (r.json?.errorId !== 0) {
      throw new Error("2captcha getTaskResult: " + (r.json?.errorDescription || r.text || ("HTTP " + r.status)).slice(0, 200));
    }
    if (r.json?.status === "ready") {
      const token = r.json?.solution?.token;
      if (token) return token;
      throw new Error("2captcha ready tanpa token");
    }
  }
  throw new Error("2captcha timeout");
}

/* NopeCHA: POST /token -> id -> poll GET /token?key=&id= -> token. */
async function solveTurnstileNopecha(pageUrl, apiKey, extra = {}, timeoutMs = 180000) {
  log.info("solver NopeCHA: buat task...");
  const body = { key: apiKey, type: "turnstile", sitekey: TURNSTILE_SITEKEY, url: pageUrl };
  const data = {};
  if (extra.action) data.action = extra.action;
  if (extra.cdata) data.cdata = extra.cdata;
  if (Object.keys(data).length) body.data = data;
  const c = await req("POST", "https://api.nopecha.com/token/", {
    json: body, headers: { Accept: "application/json" },
  });
  const jobId = c.json?.data;
  if (!jobId) throw new Error("NopeCHA submit: " + (c.text || ("HTTP " + c.status)).slice(0, 200));
  log.info(`NopeCHA job ${jobId}, tunggu hasil...`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(5000);
    const r = await req("GET", `https://api.nopecha.com/token/?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(jobId)}`,
      { headers: { Accept: "application/json" } });
    const tok = r.json?.data;
    if (typeof tok === "string" && tok.length > 20 && !/processing|pending|waiting/i.test(tok)) return tok;
    if (r.json && r.json.error) throw new Error("NopeCHA: " + JSON.stringify(r.json).slice(0, 200));
  }
  throw new Error("NopeCHA timeout");
}

async function solveTurnstileService(signupUrl, signupHtml) {
  const cfg = config.turnstile_solver || {};
  const provider = String(cfg.provider || "").toLowerCase();
  const apiKey = String(cfg.api_key || "").trim();
  if (!apiKey || (provider !== "2captcha" && provider !== "nopecha")) return null;
  const timeoutMs = (cfg.timeout_seconds ?? 180) * 1000;
  const attempts = Math.max(1, cfg.attempts ?? 3);
  const extra = extractTurnstileParams(signupHtml);
  for (let a = 1; a <= attempts; a++) {
    try {
      log.info(`solver ${provider}: percobaan ${a}/${attempts}...`);
      const token = provider === "2captcha"
        ? await solveTurnstile2Captcha(signupUrl, apiKey, extra, timeoutMs)
        : await solveTurnstileNopecha(signupUrl, apiKey, extra, timeoutMs);
      if (token && token.length > 20) {
        log.ok(`token Turnstile didapat via ${provider} (attempt ${a})`);
        return token;
      }
    } catch (err) {
      log.warn(`solver ${provider} attempt ${a} gagal: ${err.message}`);
    }
    if (a < attempts) await sleep(5000);
  }
  return null;
}

/* Buka jendela captcha (Camoufox + cookie sesi), user solve Turnstile,
   token diambil otomatis. Return token atau null. */
async function solveTurnstileViaBrowser(signupUrl) {
  const cookies = jarCookies("auth.scribd.com");
  if (!cookies.length) {
    log.warn("tidak ada cookie auth.scribd.com — lewati browser captcha");
    return null;
  }
  log.info("buka jendela captcha — selesaikan Turnstile di situ...");
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let py;
    try {
      py = spawn("python", [join(__dirname, "captcha-token.py"), signupUrl, JSON.stringify(cookies), "300"],
        { stdio: ["ignore", "pipe", "inherit"] });
    } catch {
      return done(null);
    }
    let out = "";
    py.stdout.on("data", (d) => { out += d.toString(); });
    py.on("error", () => done(null));
    py.on("close", (code) => {
      if (code !== 0) return done(null);
      const tok = out.trim();
      done(tok.length > 20 ? tok : null);
    });
    setTimeout(() => { try { py.kill(); } catch { /* ignore */ } done(null); }, 330000).unref?.();
  });
}

const STRIPE_PK = "pk_live_51PsB5HP5U6Cf0VJbRlTah0lxhrA98JVMUneMeVfCN5Nq20uXYU7sM5uXZKOe2iQolCDA5J1lKM0974rcDNo9U5d000sIvsUogG";

/* Linking & charge Midtrans HARUS via browser (butuh X-Snap-Signature
   dari JS snap). Return envelope mule atau null. */
async function muleSnapLink(snap, phone) {
  const data = await runMule(["snaplink", snap, phone, "90"], 240000);
  return data?.linking || null;
}

async function muleSnapCharge(snap) {
  const ck = [...jarCookies("app.midtrans.com")];
  const data = await runMule(["snapcharge", snap, JSON.stringify(ck), "150"], 300000);
  return data || null;
}

function refFromActivationLink(url) {
  const m = /reference=([0-9a-f-]{36})/i.exec(url || "");
  return m ? m[1] : null;
}
function refFromChallengeUrl(url) {
  const m = /reference=([A-Z0-9]+)/i.exec(url || "");
  return m ? m[1] : null;
}

function importCookiesAuto(list) {
  for (const c of list || []) {
    if (!c.name || c.value === undefined) continue;
    const host = String(c.domain || "").replace(/^\./, "");
    if (!host) continue;
    if (!jars.has(host)) jars.set(host, new Map());
    jars.get(host).set(c.name, c.value);
  }
}

/* Jalankan session-mule.py (mode auth/callback). Return {url, cookies} atau null. */
async function runMule(args, killMs = 300000) {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let py;
    try {
      py = spawn("python", [join(__dirname, "session-mule.py"), ...args],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, MULE_HEADLESS: config.mule_headless ? "1" : "" },
        });
    } catch { return done(null); }
    let out = "";
    py.stdout.on("data", (d) => { out += d.toString(); });
    py.stderr.on("data", (d) => {
      const line = d.toString().trim();
      if (line) log.dim("   [mule] " + line.split("\n").join(" | ").slice(0, 300));
    });
    py.on("error", () => done(null));
    py.on("close", (code) => {
      log.dim(`   [mule] exit code: ${code}`);
      try {
        const data = JSON.parse(out.trim());
        if (data.cookies?.length) importCookiesAuto(data.cookies);
        if (data.linking || data.charge) return done(data);
        if (data.url) log.dim(`   [mule] url: ${String(data.url).slice(0, 120)} | cookie: ${(data.cookies || []).map((c) => c.name).join(",")}`);
        if (code === 0 && data.landed && data.url) return done(data);
      } catch { /* abaikan */ }
      done(null);
    });
    setTimeout(() => { try { py.kill(); } catch { /* ignore */ } done(null); }, killMs).unref?.();
  });
}

/* Buka callback URL di Camoufox (lolos FullStory), tunggu /checkout,
   ambil cookie www.scribd.com. Return {cookies, url} atau null. */
/* Authorize via browser (server state asli) — fallback: direct API. */
async function doAuthorizeViaMule() {
  log.info("authorize via browser (server state asli)...");
  const data = await runMule(["auth", "60"]);
  if (!data) return null;
  importCookiesAuto(data.cookies);
  const m = /\/u\/signup\?state=([^&]+)/.exec(data.url);
  if (!m) return null;
  return { txnState: m[1], signupUrl: data.url, html: "" };
}

async function doAuthorize() {
  const oauthState = randomUUID().replace(/-/g, "");
  const corrId = randomUUID();
  const authzUrl =
    "https://auth.scribd.com/authorize?client_id=gyc7yrfzsvJfiwylseau8cx9uVaoaNSP" +
    "&response_type=code" +
    "&redirect_uri=" + encodeURIComponent("https://www.scribd.com/oauth/callback") +
    "&state=" + oauthState +
    "&scope=" + encodeURIComponent("openid profile email offline_access") +
    "&nway_experiment=require_email_verification_and_mfa" +
    "&ui_locales=en&correlation_id=" + corrId +
    "&audience=" + encodeURIComponent("https://api.scribd.com/api/v3/") +
    "&ext-ul-analytics=enabled&screen_hint=signup";
  const authz = await followRedirects(authzUrl);
  const m = /\/u\/signup\?state=([^&]+)/.exec(authz.url);
  if (!m) throw new Error("Gagal sampai /u/signup (cek: " + authz.url.slice(0, 120) + ")");
  return { txnState: m[1], signupUrl: authz.url, html: authz.text };
}

async function getToken(signupUrl, html) {
  let t = (await solveTurnstileService(signupUrl, html)) || "";
  if (t) return t;
  if (AUTO) throw new Error("solver Turnstile gagal (mode --auto)");
  if (!process.argv.includes("--paste-token")) {
    t = (await solveTurnstileViaBrowser(signupUrl)) || "";
    if (t) {
      log.ok("token Turnstile didapat dari jendela captcha");
      return t;
    }
  }
  console.log("   Mode paste manual: solve Turnstile di browser + paste token.");
  for (let i = 0; i < 3; i++) {
    t = await ask("Paste cf-turnstile-response:");
    if (t.length > 20) return t;
    log.warn("token kosong/pendek — coba lagi");
  }
  throw new Error("Token Turnstile tidak valid");
}

/* ================= MAIN ================= */
async function main() {
  try {
    writeFileSync(LOG_FILE, `=== run ${new Date().toISOString()} ${process.argv.slice(2).join(" ")} ===\n`);
  } catch { /* abaikan */ }
  console.log(`\n${C.b}${C.cyan}━━ Scribd Auto Trial — FULL API ━━${C.r}`);
  const regOnly = process.argv.includes("--reg-only");
  const gopayPhone = normalizePhone(config.gopay?.phone);
  const gopayPin = String(config.gopay?.pin || "").replace(/\D/g, "");
  if (!regOnly) {
    if (!gopayPhone) throw new Error("gopay.phone kosong di config-scribd.json");
    if (!gopayPin) throw new Error("gopay.pin kosong di config-scribd.json");
  }
  log.info(`GoPay: +62${gopayPhone} | PIN: ${"*".repeat(gopayPin.length)}`);

  /* ---- [1-4] email -> authorize -> token -> signup -> sesi ----
     Outer retry: email+state fresh (state hangus setelah code terbit).
     Inner retry: token fresh, state+email sama (POST ditolak = belum hangus). */
  let email = "", password = "", checkoutUrl = "";
  let ctokenId = "", pk = STRIPE_PK, clientSecret = "", setiId = "";
  let stripeJsId = "", elementsSessionId = "", configId = "";
  for (let outer = 0; outer < 3 && !checkoutUrl; outer++) {
    // sesi fresh tiap attempt (cookie Auth0 lama bikin SSO-skip yang salah akun)
    jars.delete("auth.scribd.com");
    jars.delete("www.scribd.com");
    // email selalu fresh tiap outer (yang lama sudah terdaftar/hangus)
    {
      log.step(1, `Temp email + password (attempt ${outer + 1})`);
      const box = await createTempEmail(config);
      email = box.email;
      password = genPassword();
      log.ok(`email: ${email}`);
      showBox("KREDENSIAL AKUN", [["Email", email], ["Password", password]]);
    }
    log.step(2, "Auth0 authorize");
    let auth = await doAuthorizeViaMule();
    if (auth) {
      log.ok(`server state via browser (${auth.txnState.slice(0, 20)}...)`);
    } else {
      log.warn("mule-auth gagal — fallback direct authorize (kemungkinan homepage)");
      auth = await doAuthorize();
    }
    log.ok(`transaction state dapat (${auth.txnState.slice(0, 20)}...)`);
    log.step(3, "Captcha Turnstile");
    let tsToken = await getToken(auth.signupUrl, auth.html);
    log.step(4, "POST signup Auth0 + bootstrap sesi");
    let codeUrl = "";
    for (let inner = 0; inner < 3; inner++) {
      const form = new URLSearchParams({
        state: auth.txnState,
        "passwordPolicy.isFlexible": "false",
        strengthPolicy: "good",
        "complexityOptions.minLength": "10",
        email, password, captcha: tsToken,
      });
      const r = await req("POST", `https://auth.scribd.com/u/signup?state=${auth.txnState}`, { form });
      if (![301, 302, 303].includes(r.status) || !r.location) {
        const detail = (r.text || "").replace(/\s+/g, " ").slice(0, 500);
        log.warn(`signup ditolak (HTTP ${r.status}) — token fresh lagi`);
        if (detail && !r.location) log.dim(`     body: ${detail}`);
        try {
          writeFileSync(join(__dirname, "dbg_signup_400.html"), r.text || "");
        } catch { /* abaikan */ }
        tsToken = await getToken(auth.signupUrl, auth.html);
        continue;
      }
      const resume = await req("GET", new URL(r.location, "https://auth.scribd.com").toString(),
        { headers: { Accept: "text/html,*/*" } });
      codeUrl = resume.location ? new URL(resume.location, "https://auth.scribd.com").toString() : "";
      if (!codeUrl.includes("/oauth/callback?code=")) {
        log.warn("resume tidak keluarkan code: " + (codeUrl || ("HTTP " + resume.status)).slice(0, 120));
        codeUrl = "";
        tsToken = await getToken(auth.signupUrl, auth.html);
        continue;
      }
      break;
    }
    if (!codeUrl) {
      log.warn("signup gagal 3x inner — email+state fresh");
      email = "";
      continue;
    }
    log.ok("code OAuth dapat");

    /* ---- [5] Stripe ctoken via fetch (tanpa scribd) ---- */
    log.step(5, "Stripe ctoken (fetch)");
    try {
      stripeJsId = randomUUID();
      const sessQ = new URLSearchParams({
        "deferred_intent[mode]": "subscription", "deferred_intent[amount]": "0",
        "deferred_intent[currency]": "idr", "deferred_intent[setup_future_usage]": "off_session",
        "deferred_intent[payment_method_types][0]": "card", "deferred_intent[payment_method_types][1]": "gopay",
        currency: "idr", key: STRIPE_PK, elements_init_source: "stripe.elements",
        referrer_host: "www.scribd.com", stripe_js_id: stripeJsId,
        locale: "en", browser_timezone: "Asia/Singapore", type: "deferred_intent",
      });
      const sess = await req("GET", "https://api.stripe.com/v1/elements/sessions?" + sessQ.toString(), {
        headers: { Origin: "https://www.scribd.com", Referer: "https://www.scribd.com/" },
      });
      elementsSessionId = sess.json?.elements_session_id || ("elements_session_" + randomUUID().slice(0, 12));
      configId = sess.json?.config_id || "83aefe98-e1a3-43d7-9b96-74e5ffde4e6f";
      const ctForm = new URLSearchParams({
        "payment_method_data[type]": "gopay",
        "payment_method_data[payment_user_agent]": "stripe.js;stripe-js-v3;payment-element;deferred-intent",
        "payment_method_data[referrer]": "https://www.scribd.com",
        "payment_method_data[time_on_page]": String(8000 + Math.floor(Math.random() * 5000)),
        "payment_method_data[client_attribution_metadata][client_session_id]": stripeJsId,
        "payment_method_data[client_attribution_metadata][merchant_integration_source]": "elements",
        "payment_method_data[client_attribution_metadata][merchant_integration_subtype]": "payment-element",
        "payment_method_data[client_attribution_metadata][merchant_integration_version]": "2021",
        "payment_method_data[client_attribution_metadata][payment_intent_creation_flow]": "deferred",
        "payment_method_data[client_attribution_metadata][payment_method_selection_flow]": "merchant_specified",
        "payment_method_data[client_attribution_metadata][elements_session_id]": elementsSessionId,
        "payment_method_data[client_attribution_metadata][elements_session_config_id]": configId,
        "payment_method_data[guid]": randomUUID(), "payment_method_data[muid]": randomUUID(),
        "payment_method_data[sid]": randomUUID(),
        key: STRIPE_PK,
      });
      const ctok = await req("POST", "https://api.stripe.com/v1/confirmation_tokens", {
        form: ctForm, headers: { Origin: "https://www.scribd.com", Referer: "https://www.scribd.com/" },
      });
      ctokenId = ctok.json?.id || "";
      if (!ctokenId) throw new Error("confirmation_tokens: " + ctok.text.slice(0, 200));
      log.ok("ctoken: " + ctokenId);
    } catch (err) {
      log.warn("stripe ctoken gagal: " + err.message.slice(0, 150) + " — email+state fresh");
      email = "";
      continue;
    }

    /* ---- [6] Checkout + subscribe via browser ---- */
    log.step(6, "Checkout + subscribe (browser)");
    const ckAll = [...jarCookies("www.scribd.com"), ...jarCookies("auth.scribd.com")];
    const co = await runMule(["checkout", codeUrl, JSON.stringify(ckAll), ctokenId, "120"], 300000);
    if (!co?.client_secret) {
      log.warn("checkout browser gagal — email+state fresh (email lama sudah terdaftar)");
      email = "";
      continue;
    }
    importCookiesAuto(co.cookies);
    checkoutUrl = co.url;
    clientSecret = co.client_secret;
    setiId = String(clientSecret).split("_secret_")[0];
    if (co.pk) pk = co.pk;
    log.ok(`checkout OK (wordUserId ${co.cart?.data?.cart?.wordUserId}) | setup ${setiId}`);
  }
  if (!checkoutUrl) throw new Error("Signup gagal 3x outer — berhenti");
  log.ok("signup OK -> " + checkoutUrl.slice(0, 90));

  if (regOnly) {
    const result = {
      email, password, payment_method: "none",
      status: "registered-no-payment", url: checkoutUrl, engine: "full-api-reg-only",
    };
    appendFileSync(join(__dirname, config.results_file || "results-scribd.jsonl"),
      JSON.stringify({ ...result, at: new Date().toISOString() }) + "\n");
    log.ok(`REG-ONLY SELESAI — ${email} / ${password} (akun jadi, belum bayar)`);
    rl.close();
    return;
  }

  /* ---- [7] Setup confirm (fetch, Stripe publik) ---- */
  log.step(7, "Setup confirm -> snap");
  const attrib = {
    "payment_method_data[client_attribution_metadata][client_session_id]": stripeJsId,
    "payment_method_data[client_attribution_metadata][merchant_integration_source]": "elements",
    "payment_method_data[client_attribution_metadata][merchant_integration_subtype]": "payment-element",
    "payment_method_data[client_attribution_metadata][merchant_integration_version]": "2021",
    "payment_method_data[client_attribution_metadata][payment_intent_creation_flow]": "deferred",
    "payment_method_data[client_attribution_metadata][payment_method_selection_flow]": "merchant_specified",
    "payment_method_data[client_attribution_metadata][elements_session_id]": elementsSessionId,
    "payment_method_data[client_attribution_metadata][elements_session_config_id]": configId,
    "payment_method_data[guid]": randomUUID(), "payment_method_data[muid]": randomUUID(),
    "payment_method_data[sid]": randomUUID(),
  };
  const cfForm = new URLSearchParams({
    return_url: "https://www.scribd.com/payments/billing/stripe/complete?view=web",
    client_secret: clientSecret,
    expected_payment_method_type: "gopay",
    "client_context[currency]": "idr",
    "client_context[mode]": "subscription",
    "client_context[payment_method_types][0]": "card",
    "client_context[payment_method_types][1]": "gopay",
    "client_context[setup_future_usage]": "off_session",
    "client_attribution_metadata[client_session_id]": stripeJsId,
    "client_attribution_metadata[merchant_integration_source]": "elements",
    "client_attribution_metadata[merchant_integration_subtype]": "payment-element",
    "client_attribution_metadata[merchant_integration_version]": "2021",
    "client_attribution_metadata[payment_intent_creation_flow]": "deferred",
    "client_attribution_metadata[payment_method_selection_flow]": "merchant_specified",
    "client_attribution_metadata[elements_session_id]": elementsSessionId,
    "client_attribution_metadata[elements_session_config_id]": configId,
    "mandate_data[customer_acceptance][type]": "online",
    "mandate_data[customer_acceptance][online][infer_from_client]": "true",
    "payment_method_data[type]": "gopay",
    "payment_method_data[payment_user_agent]": "stripe.js;stripe-js-v3;payment-element;deferred-intent",
    "payment_method_data[referrer]": "https://www.scribd.com",
    "payment_method_data[time_on_page]": String(10000 + Math.floor(Math.random() * 5000)),
    ...attrib, key: pk,
  });
  const cf = await req("POST", `https://api.stripe.com/v1/setup_intents/${setiId}/confirm`, {
    form: cfForm, headers: { Origin: "https://www.scribd.com", Referer: "https://www.scribd.com/" },
  });
  const pmUrl = cf.json?.next_action?.redirect_to_url?.url;
  if (!pmUrl) throw new Error("setup confirm tanpa redirect: " + cf.text.slice(0, 300));
  log.ok("pm-redirects dapat");
  const pm = await req("GET", pmUrl);
  const snapMatch = /snap\/v4\/redirection\/([0-9a-f-]{36})/i.exec(pm.location || "");
  if (!snapMatch) throw new Error("snap token tidak ketemu (loc: " + (pm.location || "-").slice(0, 120) + ")");
  const SNAP = snapMatch[1];
  log.ok("SNAP token: " + SNAP);

  /* ---- [7] Midtrans linking ---- */
  log.step(8, "Midtrans linking GoPay (browser)");
  let reference = "";
  for (let i = 0; i < 5; i++) {
    const lk = await muleSnapLink(SNAP, gopayPhone);
    if (!lk) throw new Error("mule snaplink gagal total");
    if (lk.status === 201) {
      reference = lk.data?.reference || refFromActivationLink(lk.data?.activation_link_url);
      if (!reference) throw new Error("linking 201 tanpa reference");
      log.ok("linking OK, reference: " + reference);
      break;
    }
    log.warn(`linking HTTP ${lk.status}: ${JSON.stringify(lk.data || {}).slice(0, 200)}`);
    if (lk.status === 406 || /already linked/i.test(JSON.stringify(lk.data || {}))) {
      console.log("   Nomor ini sudah terhubung ke akun Scribd lain.");
      console.log("   Buka aplikasi GoPay > Settings > Connected Apps > HAPUS Scribd,");
      await ask("lalu tekan Enter untuk retry (atau Ctrl+C untuk batal)");
      continue;
    }
    throw new Error("linking gagal tak terduga");
  }
  if (!reference) throw new Error("linking gagal");

  const GH = { Accept: "application/json", Origin: "https://gwc.gopayapi.com", Referer: "https://gwc.gopayapi.com/" };
  await req("POST", "https://gwa.gopayapi.com/v1/linking/validate-reference", {
    json: { reference_id: reference }, headers: GH,
  });
  await req("POST", "https://gwa.gopayapi.com/v1/linking/user-consent", {
    json: { reference_id: reference }, headers: GH,
  });
  log.ok("consent OK — OTP dikirim ke SMS/WhatsApp");

  /* ---- [8] MANUAL: OTP -> PIN ---- */
  log.step(9, "OTP + PIN linking (OTP MANUAL)");
  let challenge = null;
  for (let i = 0; i < 3; i++) {
    const otp = (await ask(`Kode OTP GoPay 6 digit [coba ${i + 1}/3]:`)).replace(/\D/g, "");
    if (otp.length !== 6) {
      log.warn("OTP harus 6 digit — coba lagi");
      continue;
    }
    const vo = await req("POST", "https://gwa.gopayapi.com/v1/linking/validate-otp", {
      json: { reference_id: reference, otp }, headers: GH,
    });
    if (vo.json?.success && vo.json?.data?.next_action === "linking-validate-pin") {
      challenge = vo.json.data.challenge.action.value;
      break;
    }
    log.warn("OTP ditolak: " + (vo.text || "").slice(0, 200));
  }
  if (!challenge) throw new Error("OTP gagal 3x — berhenti");
  const pt = await req("POST", "https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
    json: { challenge_id: challenge.challenge_id, client_id: challenge.client_id, pin: gopayPin },
    headers: { Accept: "application/json", Origin: "https://pin-web-client.gopayapi.com", Referer: "https://pin-web-client.gopayapi.com/" },
  });
  const pinJwt = pt.json?.data?.token;
  if (!pinJwt) throw new Error("pin token gagal: " + pt.text.slice(0, 300));
  const vp = await req("POST", "https://gwa.gopayapi.com/v1/linking/validate-pin", {
    json: { reference_id: reference, token: pinJwt }, headers: GH,
  });
  if (!vp.json?.success || vp.json?.data?.next_action !== "linking-success") {
    throw new Error("validate-pin gagal: " + vp.text.slice(0, 300));
  }
  log.ok("linking-success (GoPay terhubung)");

  /* ---- [9] Charge Rp1 + PIN (charge via browser) ---- */
  log.step(10, "Charge Rp1 GoPay (browser)");
  const chMule = await muleSnapCharge(SNAP);
  const chData = chMule?.charge?.data || {};
  const chargeRef = refFromChallengeUrl(chData.gopay_verification_link_url);
  const finish200 = chData.finish_200_redirect_url;
  if (!chargeRef) throw new Error("charge gagal: " + JSON.stringify(chMule?.charge || null).slice(0, 300));
  log.ok("charge reference: " + chargeRef);
  if (chMule.settled) log.ok("settlement confirmed (via browser)");
  else log.warn("status belum settlement — lanjut, cek di finish");
  await req("GET", `https://gwa.gopayapi.com/v1/payment/validate?reference_id=${chargeRef}`, { headers: GH });
  const pc = await req("POST", `https://gwa.gopayapi.com/v1/payment/confirm?reference_id=${chargeRef}`, {
    json: { payment_instructions: [] }, headers: GH,
  });
  const ch2 = pc.json?.data?.challenge?.action?.value;
  if (!ch2) throw new Error("payment confirm tanpa challenge: " + pc.text.slice(0, 300));
  const pt2 = await req("POST", "https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
    json: { pin: gopayPin, challenge_id: ch2.challenge_id, client_id: ch2.client_id },
    headers: { Accept: "application/json", Origin: "https://pin-web-client.gopayapi.com", Referer: "https://pin-web-client.gopayapi.com/" },
  });
  const pinJwt2 = pt2.json?.data?.token;
  if (!pinJwt2) throw new Error("pin token (charge) gagal: " + pt2.text.slice(0, 300));
  const pp = await req("POST", `https://gwa.gopayapi.com/v1/payment/process?reference_id=${chargeRef}`, {
    json: { challenge: { type: "GOPAY_PIN_CHALLENGE", value: { pin_token: pinJwt2 } } }, headers: GH,
  });
  if (!pp.json?.success || pp.json?.data?.next_action !== "payment-success") {
    throw new Error("payment process gagal: " + pp.text.slice(0, 300));
  }
  log.ok("payment-success (Rp1 settlement)");

  /* ---- [10] Verifikasi status + kembali ke Scribd ---- */
  log.step(11, "Finalisasi di Scribd");
  // rantai finish (302) hanya jalan di browser (fetch kena bot-check)
  const ckFin = [...jarCookies("www.scribd.com"), ...jarCookies("auth.scribd.com")];
  const markers = [...(config.success_contains ?? []), ...(config.success_url_contains ?? [])];
  const finMule = await runMule(["finish", finish200, JSON.stringify(ckFin), JSON.stringify(markers), "90"], 180000);
  if (finMule) importCookiesAuto(finMule.cookies);
  const finUrl = finMule?.url || "";
  const finText = (finMule?.snippet || "").toLowerCase();
  const success = !!finMule?.ok
    || ((config.success_contains ?? []).some((k) => finText.includes(k.toLowerCase()))
      && (config.success_url_contains ?? []).some((k) => finUrl.toLowerCase().includes(k.toLowerCase())));
  const result = {
    email, password, payment_method: "gopay-api",
    status: success ? "success" : "unknown", url: finUrl, engine: "full-api",
  };
  appendFileSync(join(__dirname, config.results_file || "results-scribd.jsonl"),
    JSON.stringify({ ...result, at: new Date().toISOString() }) + "\n");
  if (success) log.ok(`BERHASIL — ${email} / ${password}`);
  else log.warn(`SELESAI (cek manual) — ${email} | ${finUrl.slice(0, 100)}`);
  rl.close();
}

main().catch((err) => {
  const msg = `✖ FATAL: ${err.message}`;
  console.error(`${C.red}${msg}${C.r}`);
  writeLog(msg);
  try { rl.close(); } catch { /* ignore */ }
  process.exit(1);
});