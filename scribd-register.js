import { spawnSync } from "child_process";
import { readFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createTempEmail, pollVerificationLink } from "./temp-email.js";
import {
  createCamoufoxBrowser,
  destroyCamoufoxBrowser,
  genPassword,
  randomDelay,
  sleep,
} from "./lib/camoufox-browser.js";
import { humanClick, fillField } from "./lib/pw-human.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, "config-scribd.json"), "utf-8")
);

// ── pretty logger (ANSI, no deps) ──
const C = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};
const L = {
  title: (t) => console.log(`\n${C.b}${C.cyan}━━ ${t} ━━${C.r}`),
  ok: (t) => console.log(`${C.green}✔${C.r} ${t}`),
  info: (t) => console.log(`${C.cyan}▸${C.r} ${t}`),
  warn: (t) => console.log(`${C.yellow}⚠${C.r} ${t}`),
  err: (t) => console.log(`${C.red}✖${C.r} ${t}`),
  step: (n, t) => console.log(`\n${C.b}${C.blue}[${n}]${C.r} ${C.b}${t}${C.r}`),
  dim: (t) => console.log(`${C.gray}${t}${C.r}`),
};

function loadAccounts() {
  const n = Number(config.run_count ?? 1);
  return Array.from({ length: Math.max(1, n) }, (_, i) => ({ name: `Akun ${i + 1}` }));
}

/** First matching visible locator from comma-separated CSS selectors. */
async function findVisible(scope, selectorCsv, timeoutMs) {
  const list = selectorCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const sel of list) {
      try {
        const loc = scope.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      } catch {
        // try next
      }
    }
    await sleep(150);
  }
  throw new Error(`Elemen tidak ditemukan: ${selectorCsv}`);
}

async function fillFieldPaste(page, selectorCsv, value) {
  const field = await findVisible(page, selectorCsv, config.timeout_seconds * 1000);
  await fillField(field, value, { paste: true });
  const actual = await field.inputValue().catch(() => "");
  if (actual !== value) {
    throw new Error(`Field tidak terisi: ${selectorCsv}`);
  }
}

/** Captcha 1x SEBELUM form signup muncul — bot diam, tidak ulang halaman */
async function waitForPreSignupCaptcha(page) {
  const cfg = config.pre_signup_captcha ?? {};
  if (cfg.enabled === false) {
    await waitForSignupForm(page, (config.signup_via_trial_link?.wait_seconds ?? 20) * 1000);
    return;
  }

  const timeout = (cfg.timeout_seconds ?? 300) * 1000;
  console.log("\n>>> CAPTCHA SEBELUM SIGNUP (1x manual) <<<");
  console.log(">>> Selesaikan captcha — JANGAN refresh / jangan klik ulang");
  console.log(">>> Bot tunggu form email (#email) muncul...\n");

  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await isOnSignupForm(page)) return;
    await sleep(1000);
  }
  throw new Error("Timeout captcha pre-signup");
}

/** Bot klik Continue otomatis — user hanya selesaikan captcha yang muncul. */
async function clickSignupContinue(page) {
  const clicked = await page
    .evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit']")];
      const cont = btns.find((b) => /^\s*continue\s*$/i.test(b.innerText || ""));
      if (!cont || cont.disabled) return null;
      cont.scrollIntoView({ block: "center" });
      cont.click();
      return (cont.innerText || "Continue").trim();
    })
    .catch(() => null);
  if (clicked) {
    console.log(`   Bot klik: "${clicked}"`);
    await sleep(1500);
    return true;
  }
  // Fallback via Playwright locator (lebih terlihat manusiawi)
  try {
    const btn = page
      .locator("button[type='submit']")
      .filter({ hasText: /^\s*continue\s*$/i })
      .first();
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      await humanClick(btn);
      console.log('   Bot klik: "Continue" (locator)');
      await sleep(1500);
      return true;
    }
  } catch {
    // abaikan — serahkan ke manual
  }
  return false;
}

function captchaRestartCfg() {
  const c = config.captcha_restart ?? {};
  return {
    enabled: c.enabled !== false,
    unsolvedSeconds: c.unsolved_timeout_seconds ?? 120,
    maxRestarts: c.max_restarts ?? 2,
    cfSeconds: c.cloudflare_timeout_seconds ?? 30,
  };
}

/**
 * Deteksi SEMUA jenis captcha (visible + invisible):
 * Cloudflare Turnstile, hCaptcha, Arkose.
 * Cek: iframe URL, cf-turnstile-response input, script tags, visible frames.
 */
async function detectVisibleCaptcha(page) {
  try {
    return await page.evaluate(() => {
      const allIframes = [...document.querySelectorAll("iframe")];

      // 1. Visible iframes
      const visible = allIframes.filter((f) => {
        if (f.offsetParent === null) return false;
        const r = f.getBoundingClientRect();
        return r.width > 40 && r.height > 20;
      });
      const visSig = visible.map((f) => `${f.src || ""} ${f.title || ""}`.toLowerCase());

      // 2. ALL iframes (visible atau tidak) — cek URL apa aja
      const allSig = allIframes.map((f) => `${f.src || ""} ${f.title || ""}`.toLowerCase());

      const hasHcaptcha = visSig.some((s) => s.includes("hcaptcha")) ||
        allSig.some((s) => s.includes("hcaptcha"));
      const hasArkose = visSig.some((s) => s.includes("arkose") || s.includes("funcaptcha")) ||
        allSig.some((s) => s.includes("arkose") || s.includes("funcaptcha"));
      const hasTurnstileVis = visSig.some(
        (s) => s.includes("turnstile") || s.includes("challenges.cloudflare")
      );
      const hasTurnstileAll = allSig.some(
        (s) => s.includes("turnstile") || s.includes("challenges.cloudflare")
      );

      const text = (document.body?.innerText || "").toLowerCase();
      const cfText = /verifying you are human|just a moment|verify you are human|confirm you are human/i.test(text);

      // 3. Invisible Turnstile indicators
      const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
      const hasTurnstileInput = !!(turnstileInput && turnstileInput.offsetParent !== null);
      const turnstileScript = [...document.querySelectorAll("script")].some(
        (s) => (s.src || "").includes("challenges.cloudflare.com/turnstile")
      );
      const hasAnyTurnstileChallenge = allSig.some(
        (s) => s.includes("turnstile") || s.includes("challenges.cloudflare")
      );

      const present =
        hasHcaptcha ||
        hasArkose ||
        hasTurnstileVis ||
        hasTurnstileAll ||
        hasTurnstileInput ||
        turnstileScript ||
        cfText;

      return {
        present,
        detail: {
          hasHcaptcha,
          hasArkose,
          hasTurnstileVis,
          hasTurnstileAll,
          hasTurnstileInput,
          turnstileScript,
          hasAnyTurnstileChallenge,
          cfText,
          iframeCount: allIframes.length,
          iframeUrls: allSig.filter(Boolean).slice(0, 10),
        },
      };
    });
  } catch {
    return { present: false, detail: {} };
  }
}

/** Challenge Cloudflare/Turnstile hilang? (tidak ada widget visible + bukan halaman challenge) */
async function isCloudflareCleared(page) {
  const cap = await detectVisibleCaptcha(page);
  return !cap.detail?.hasTurnstile && !cap.detail?.cfText;
}

async function humanMouseClick(page, x, y) {
  const tx = x + (Math.random() * 10 - 5);
  const ty = y + (Math.random() * 10 - 5);
  const steps = 10 + Math.floor(Math.random() * 15);
  await page.mouse.move(tx, ty, { steps }).catch(() => {});
  await sleep(100 + Math.floor(Math.random() * 200));
  await page.mouse.down().catch(() => {});
  await sleep(50 + Math.floor(Math.random() * 100));
  await page.mouse.up().catch(() => {});
}

async function hasTurnstileToken(page) {
  try {
    return await page.evaluate(() => {
      const el =
        document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('input[name="captcha"]');
      return !!(el && el.value && el.value.length > 10);
    });
  } catch {
    return false;
  }
}

/**
 * CF solver — handle Cloudflare Turnstile + Auth0 v2 inline widget.
 * Auth0: widget belum dirender (container kosong), perlu render manual
 * via window.turnstile.render() setelah script loaded.
 */
async function solveCloudflareCheckbox(page) {
  const sleepTime = config.cf_solver?.sleep_time ?? 5;
  if (config.cf_solver?.enabled === false) return isCloudflareCleared(page);

  if (await isCloudflareCleared(page)) return true;
  if (await hasTurnstileToken(page)) {
    console.log("   CF solver: token sudah ada ✓");
    return true;
  }

  // === AUTH0 V2: Render Turnstile widget yang belum muncul ===
  // Cek apakah container captcha ada tapi kosong (widget belum dirender)
  const needsAuth0Render = await page.evaluate(() => {
    const container = document.querySelector("#ulp-auth0-v2-captcha");
    if (!container) return null;
    const sitekey = container.closest("[data-captcha-sitekey]")?.getAttribute("data-captcha-sitekey");
    const innerEmpty = container.querySelector("div")?.children.length === 0;
    return innerEmpty ? sitekey : null;
  }).catch(() => null);

  if (needsAuth0Render) {
    console.log(`   CF solver: render Auth0 Turnstile (sitekey=${needsAuth0Render})...`);
    const rendered = await page.evaluate((sitekey) => {
      return new Promise((resolve) => {
        const container = document.querySelector("#ulp-auth0-v2-captcha");
        if (!container) return resolve(false);

        // Kalau window.turnstile sudah ada, render langsung
        if (window.turnstile) {
          window.turnstile.render(container, {
            sitekey: sitekey,
            theme: "light",
            callback: function(token) {
              const inp = document.querySelector('input[name="captcha"]');
              if (inp) inp.value = token;
              resolve(true);
            },
            "error-callback": function() { resolve(false); },
            "expired-callback": function() { resolve(false); },
          });
          return;
        }

        // Script belum loaded — inject + wait
        const existing = document.querySelector('script[src*="turnstile"]');
        if (existing) existing.remove();

        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.onload = () => {
          const check = setInterval(() => {
            if (window.turnstile) {
              clearInterval(check);
              window.turnstile.render(container, {
                sitekey: sitekey,
                theme: "light",
                callback: function(token) {
                  const inp = document.querySelector('input[name="captcha"]');
                  if (inp) inp.value = token;
                  resolve(true);
                },
                "error-callback": function() { resolve(false); },
                "expired-callback": function() { resolve(false); },
              });
            }
          }, 300);
          setTimeout(() => { clearInterval(check); resolve(false); }, 15000);
        };
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });
    }, needsAuth0Render).catch(() => false);

    if (rendered) {
      console.log("   CF solver: Auth0 widget dirender — tunggu solved...");
      await sleep(2000);
      // Sekarang click checkbox kalau ada
    }
  }

  // === Standard Turnstile iframe click ===
  let clicked = false;

  // 1. Teknik art3m4ik3: bbox → width/9 + height/2 → mouse move
  for (const frame of page.frames()) {
    const furl = (frame.url() || "").toLowerCase();
    if (!furl.includes("challenges.cloudflare.com") && !furl.includes("turnstile")) continue;
    try {
      const el = await frame.frameElement();
      const box = await el.boundingBox();
      if (!box) continue;
      const cx = box.x + box.width / 9;
      const cy = box.y + box.height / 2;
      await sleep(sleepTime * 1000);
      await humanMouseClick(page, cx, cy);
      clicked = true;
      console.log(`   CF solver: click @ ${Math.round(cx)},${Math.round(cy)} [bbox]`);
      break;
    } catch {
      // next frame
    }
  }

  // 2. Fallback: locator click di dalam frame
  if (!clicked) {
    for (const frame of page.frames()) {
      const furl = (frame.url() || "").toLowerCase();
      if (!furl.includes("challenges.cloudflare.com") && !furl.includes("turnstile")) continue;
      for (const sel of ["input[type='checkbox']", "label", "body"]) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            await humanClick(loc);
            clicked = true;
            break;
          }
        } catch {
          // next
        }
      }
      if (clicked) break;
    }
  }

  // 3. Fallback: coordinate click di main frame
  if (!clicked) {
    clicked = await page
      .evaluate(() => {
        const frames = [...document.querySelectorAll("iframe")].filter((f) => {
          if (f.offsetParent === null) return false;
          const r = f.getBoundingClientRect();
          return r.width > 40 && r.height > 20;
        });
        const cf = frames.find((f) =>
          /challenges\.cloudflare|hcaptcha|arkose|funcaptcha|turnstile/i.test(`${f.src} ${f.title}`)
        );
        if (!cf) return false;
        const r = cf.getBoundingClientRect();
        const x = r.left + r.width / 9;
        const y = r.top + r.height / 2;
        const el = document.elementFromPoint(x, y) || cf;
        try {
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (clicked) console.log("   CF solver: click via evaluate [fallback]");
  }

  if (!clicked) {
    console.log("   CF solver: checkbox tak ketemu — mungkin auto-clear...");
  }

  await sleep(4500);
  if (await isCloudflareCleared(page)) {
    console.log("   CF solver: lolos ✓");
    return true;
  }
  if (await hasTurnstileToken(page)) {
    console.log("   CF solver: token muncul ✓");
    return true;
  }
  return false;
}

/**
 * Bersihkan challenge Cloudflare di suatu halaman: coba solver aktif,
 * lalu tunggu sebentar; kalau masih macet → CLOUDFLARE_BLOCKED (restart).
 */
async function waitCloudflareClear(page, label = "halaman") {
  if (await isCloudflareCleared(page)) return;
  console.log(`   Cloudflare terdeteksi di ${label} — solver jalan...`);
  const solved = await solveCloudflareCheckbox(page).catch(() => false);
  if (solved) return;

  const timeoutMs = captchaRestartCfg().cfSeconds * 1000;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1500);
    if (await isCloudflareCleared(page)) {
      console.log("   Cloudflare clear (tunggu pasif) ✓");
      return;
    }
  }
  throw new Error("CLOUDFLARE_BLOCKED");
}

/**
 * Setelah bot klik Continue — captcha manual BERBATAS WAKTU.
 * Kalau captcha terlihat tapi tak diselesaikan dalam unsolved_timeout_seconds
 * → throw CAPTCHA_UNSOLVED → bot ULANG OTOMATIS (browser + email baru).
 */
async function waitForManualContinue(page) {
  const rcfg = captchaRestartCfg();
  const timeout = (config.manual_captcha?.timeout_seconds ?? 300) * 1000;
  console.log("\n>>> CAPTCHA (manual, batas waktu) <<<");
  console.log(">>> Kalau captcha muncul: selesaikan di browser");
  console.log(">>> Kalau tombol Continue masih ada: klik lagi — JANGAN refresh");
  if (rcfg.enabled) {
    console.log(`>>> Kalau tidak selesai dalam ${rcfg.unsolvedSeconds} detik: bot ULANG otomatis\n`);
  } else {
    console.log("");
  }

  const end = Date.now() + timeout;
  const unsolvedMs = rcfg.unsolvedSeconds * 1000;
  let captchaSince = 0;
  let lastLog = 0;
  while (Date.now() < end) {
    let url = "";
    try {
      url = page.url();
    } catch {
      throw new Error("Browser ditutup oleh user");
    }

    if (rcfg.enabled) {
      const cap = await detectVisibleCaptcha(page);
      const now = Date.now();
      if (cap.present) {
        // Debug: log detection detail
        if (Object.values(cap.detail || {}).some(Boolean)) {
          const d = cap.detail;
          console.log(
            `   [cap-detect] visTS=${d.hasTurnstileVis} allTS=${d.hasTurnstileAll} inputTS=${d.hasTurnstileInput} script=${d.turnstileScript} cfText=${d.cfText} hc=${d.hasHcaptcha} ark=${d.hasArkose} frames=${d.iframeCount}`
          );
        }
        if (!captchaSince) {
          captchaSince = now;
          console.log("   Captcha terdeteksi — solver aktif...");
        }
        if (now - captchaSince > unsolvedMs) {
          throw new Error("CAPTCHA_UNSOLVED");
        }
        if (await hasTurnstileToken(page)) {
          console.log("   Captcha solved (token ada) ✓");
          captchaSince = 0;
        } else {
          const solved = await solveCloudflareCheckbox(page).catch(() => false);
          if (solved) {
            console.log("   CF solver: click OK — tunggu token...");
            let tokenFound = false;
            for (let i = 0; i < 15; i++) {
              await sleep(1000);
              if (await hasTurnstileToken(page)) {
                console.log("   Token muncul di DOM ✓");
                tokenFound = true;
                break;
              }
              if (i < 5) console.log(`   ... polling token (${i + 1}/15)`);
            }
            if (tokenFound) {
              captchaSince = 0;
            } else {
              console.log("   [!] Solver click OK tapi token belum muncul — retry solver");
            }
          } else {
            if (now - lastLog > 20000) {
              const left = Math.ceil((unsolvedMs - (now - captchaSince)) / 1000);
              console.log(`   ... solver gagal, retry (sisa ${left}s)`);
              lastLog = now;
            }
          }
        }
      } else {
        captchaSince = 0;
      }
    }

    if (!isAuthFormUrl(url)) return url;

    await sleep(2000);
  }
  throw new Error("Timeout menunggu perubahan URL");
}

async function waitForManualPayment(page) {
  const cfg = config.manual_payment ?? {};
  if (cfg.enabled === false) return;

  const timeout = (cfg.timeout_seconds ?? 300) * 1000;
  const startUrl = page.url();

  console.log("\n>>> PAYMENT (manual) - monitor hasil <<<");

  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const url = page.url();
      const source = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (url !== startUrl && !/\/checkout(\/|$|\?)/i.test(url)) return;
      if (pageLooksSuccess(source, url) || pageLooksError(source)) return;
    } catch {
      throw new Error("Browser ditutup oleh user");
    }
    await sleep(3000);
  }
  throw new Error("Timeout menunggu payment manual");
}

function copyEmailToClipboard(email) {
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      "[Console]::InputEncoding=[System.Text.UTF8Encoding]::UTF8; $input | Set-Clipboard",
    ],
    { input: email, encoding: "utf8", windowsHide: true }
  );
}

/** Poll ringan — hanya URL (jangan ganggu captcha) */
async function waitUrlOnly(page, predicate, timeoutMs, pollMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const url = page.url();
      if (predicate(url)) return url;
    } catch {
      throw new Error("Browser ditutup oleh user");
    }
    await sleep(pollMs);
  }
  throw new Error("Timeout menunggu perubahan URL");
}

function isAuthFormUrl(url) {
  return (
    (/auth\.scribd\.com/i.test(url) &&
      /\/u\/(signup|login)|authorize|signup|sign-up|login/i.test(url)) ||
    /scribd\.com\/oauth\/(signup|signin)/i.test(url)
  );
}

/** Cek semua tab — hanya URL */
async function scanTabsForAuthUrl(context, preferredPage) {
  const pages = context.pages();
  let lastUrl = preferredPage?.url?.() || "";
  for (const p of pages) {
    try {
      const url = p.url();
      lastUrl = url;
      if (isAuthFormUrl(url)) {
        return { found: true, url, page: p, tabs: pages.length };
      }
    } catch {
      // closed
    }
  }
  return { found: false, url: lastUrl, page: preferredPage, tabs: pages.length };
}

function isManualFormFill() {
  return config.manual_signup?.enabled === true || config.form_fill?.mode === "manual";
}

/** Kamu klik trial sendiri — bot deteksi halaman signup/login */
async function waitForAuthForm(context, pageRef) {
  const timeout = (config.signup_via_trial_link?.wait_seconds ?? 300) * 1000;
  const pollMs = 3500;
  const end = Date.now() + timeout;
  let lastLog = 0;
  let page = pageRef;

  console.log("\n>>> KLIK MANUAL: trial link ('Download free for 30 days') <<<");
  console.log(">>> Bot tunggu form signup/login (#email) muncul...\n");

  while (Date.now() < end) {
    const hit = await scanTabsForAuthUrl(context, page);
    if (hit.found) {
      console.log(`   Halaman signup/login terdeteksi: ${hit.url}`);
      if (hit.page && hit.page !== page) {
        page = hit.page;
        await page.bringToFront().catch(() => {});
      }
      return page;
    }

    if (Date.now() - lastLog > 20000) {
      console.log(
        `   ... masih nunggu (${hit.tabs} tab) | URL: ${String(hit.url).slice(0, 100)}`
      );
      lastLog = Date.now();
    }

    await sleep(pollMs);
  }

  throw new Error(
    "Timeout — klik trial link sampai halaman signup/login dengan field #email muncul"
  );
}

async function waitForManualSignup(page, email, password) {
  const timeout = (config.manual_captcha?.timeout_seconds ?? 300) * 1000;
  copyEmailToClipboard(email);

  console.log("\n>>> ISI FORM + CAPTCHA MANUAL (bot diam total di halaman ini) <<<");
  console.log(`    Email    : ${email}  ← sudah di-copy, Ctrl+V di field email`);
  console.log(`    Password : ${password}  ← ketik/copy sendiri`);
  console.log("    1. Isi email + password SENDIRI (jangan biarkan bot klik/paste)");
  console.log("    2. Selesaikan captcha — tunggu spinner berhenti");
  console.log("    3. Klik Continue");
  console.log("    Bot lanjut otomatis SETELAH kamu keluar halaman signup");
  console.log("    Tips: matikan VPN kalau captcha muter terus\n");

  await waitUrlOnly(page, (url) => !isAuthFormUrl(url), timeout, 4000);
  console.log("\n>>> SIGNUP SELESAI — BOT LANJUT: checkout GoPay <<<\n");
}

function isSignupUrl(url) {
  return isAuthFormUrl(url);
}

async function autoFillSignupForm(page, email, password) {
  const stabilize = (config.manual_captcha?.stabilize_seconds ?? 2) * 1000;
  const usePaste = config.form_fill?.use_paste === true;

  console.log("   Mode isi form: ketik human-like (Camoufox humanize cursor)");
  console.log("   Jangan gerakkan mouse saat bot isi form...");
  await sleep(stabilize);

  // Tutup banner cookie (sering menutupi field/tombol di Auth0)
  try {
    const bannerBtn = page
      .locator("button:has-text('Accept'), button:has-text('Got it'), button:has-text('Allow'), button[aria-label='Close'], button[class*='close' i]")
      .first();
    if (await bannerBtn.isVisible().catch(() => false)) {
      await bannerBtn.click({ timeout: 3000 }).catch(() => {});
      console.log("         banner cookie ditutup");
      await sleep(400);
    }
  } catch {
    // abaikan — lanjut isi form
  }

  console.log(`   [1/2] Ketik email    : ${email}`);
  const emailField = await findVisible(
    page,
    config.selectors.email,
    config.timeout_seconds * 1000
  );
  await fillField(emailField, email, { paste: usePaste });
  console.log("         ✓ email terisi & tervalidasi");
  await randomDelay(700, 1400);

  console.log(`   [2/2] Ketik password : ${"*".repeat(password.length)}`);
  const pwdField = await findVisible(
    page,
    config.selectors.password,
    config.timeout_seconds * 1000
  );
  await fillField(pwdField, password, { paste: false });
  console.log("         ✓ password terisi & tervalidasi");
  await randomDelay(500, 1000);

  // Pastikan tombol Continue aktif setelah kedua field valid
  const continueState = await page
    .evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit']")];
      const cont = btns.find((b) => /continue/i.test(b.innerText || ""));
      return cont
        ? { found: true, disabled: cont.disabled, text: cont.innerText.trim() }
        : { found: false };
    })
    .catch(() => ({ found: false }));
  if (continueState.found) {
    console.log(
      `         Tombol "${continueState.text}": ${continueState.disabled ? "NONAKTIF (cek field)" : "AKTIF ✓"}`
    );
    if (continueState.disabled) throw new Error("Tombol Continue nonaktif — email/password ditolak form");
  }
}

/**
 * Tunggu signup manual tanpa false-positive di halaman entry.
 * Selesai hanya setelah: pernah di halaman signup → lalu keluar dari signup.
 */
async function waitForFullyManualSignup(page, email, password, entryUrl) {
  const timeout = (config.signup_via_trial_link?.wait_seconds ?? 300) * 1000;
  const pollMs = 3000;
  copyEmailToClipboard(email);

  console.log("\n>>> SIGNUP MANUAL — bot diam sampai kamu selesai <<<");
  console.log(`    Entry    : ${entryUrl}`);
  console.log(`    Email    : ${email}  ← sudah di-copy, Ctrl+V`);
  console.log(`    Password : ${password}`);
  console.log("    1. Klik 'Download free for 30 days' / trial link SENDIRI");
  console.log("    2. Isi email + password SENDIRI");
  console.log("    3. Captcha + Continue SENDIRI");
  console.log("    Bot lanjut otomatis SETELAH kamu keluar halaman signup");
  console.log("    Tips: matikan VPN kalau captcha muter terus\n");

  let seenSignup = false;
  const doneUrl = await waitUrlOnly(
    page,
    (url) => {
      if (isSignupUrl(url)) seenSignup = true;
      return seenSignup && !isSignupUrl(url);
    },
    timeout,
    pollMs
  );

  console.log(`\n>>> SIGNUP SELESAI (${doneUrl}) — BOT LANJUT: checkout GoPay <<<\n`);
  await sleep(1500);
}

async function clickIfExists(page, selectorCsv) {
  try {
    const btn = await findVisible(page, selectorCsv, 5000);
    await humanClick(btn);
    return true;
  } catch {
    return false;
  }
}

async function findTrialLink(page) {
  const cfg = config.signup_via_trial_link ?? {};
  const texts = cfg.link_texts ?? ["download free for 30 days", "start free trial"];

  for (const text of texts) {
    // Playwright text match (case-insensitive)
    const candidates = [
      page.getByRole("link", { name: new RegExp(text, "i") }),
      page.getByRole("button", { name: new RegExp(text, "i") }),
      page.locator(`a, button`).filter({ hasText: new RegExp(text, "i") }),
    ];
    for (const loc of candidates) {
      try {
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) {
            const label = ((await el.innerText().catch(() => "")) || text).trim();
            return { el, label };
          }
        }
      } catch {
        // skip
      }
    }
  }

  const hrefEls = page.locator(
    "a[href*='oauth/signup'], a[href*='subscribe'], a[href*='checkout']"
  );
  const n = await hrefEls.count();
  for (let i = 0; i < n; i++) {
    const el = hrefEls.nth(i);
    try {
      if (!(await el.isVisible().catch(() => false))) continue;
      const label = ((await el.innerText().catch(() => "")) || "").trim();
      if (/free|trial|download|30/i.test(label)) {
        return { el, label: label || "signup link" };
      }
    } catch {
      // skip
    }
  }

  return null;
}

async function scrollToFindTrialLink(page) {
  const heights = [0, 0.35, 0.65, 1];
  for (const ratio of heights) {
    await page.evaluate((r) => {
      window.scrollTo(0, Math.floor(document.body.scrollHeight * r));
    }, ratio);
    await sleep(350);
    const hit = await findTrialLink(page);
    if (hit) return hit;
  }
  return null;
}

async function hasSignupEmailField(page) {
  try {
    const email = page.locator("#email").first();
    return await email.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

async function waitForSignupForm(page, timeoutMs) {
  console.log("\n>>> Tunggu halaman signup (auth.scribd.com) <<<");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await hasSignupEmailField(page)) return;
    await sleep(400);
  }
  throw new Error("Timeout — halaman signup belum siap");
}

async function isOnSignupForm(page) {
  const url = page.url();
  if (!/auth\.scribd\.com/i.test(url)) return false;
  return hasSignupEmailField(page);
}

async function openSignupFromEntry(session, entryUrl) {
  const { page, context } = session;
  console.log(`   Entry: ${entryUrl}`);
  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  await randomDelay(600, 1000);

  // Tutup Osano cookie consent dialog SEBELUM mencari tombol trial
  try {
    const osanoClose = page
      .locator(".osano-cm-window button, .osano-cm-dialog__close, [aria-label='Close this consent banner'], [aria-label='Cookie Preferences']")
      .first();
    if (await osanoClose.isVisible({ timeout: 3000 }).catch(() => false)) {
      await osanoClose.click({ timeout: 3000 }).catch(() => {});
      console.log("   Cookie consent dialog ditutup");
      await sleep(400);
    }
  } catch {
    // abaikan — lanjut
  }

  // Stage awal: bersihkan Cloudflare dulu sebelum cari tombol trial
  await waitCloudflareClear(page, "entry").catch((err) => {
    if (err.message === "CLOUDFLARE_BLOCKED") throw err;
  });

  const safe = config.captcha_safe?.enabled !== false;
  if (safe && config.captcha_safe?.manual_entry_click !== false) {
    const authPage = await waitForAuthForm(context, page);
    session.page = authPage;
    return true;
  }

  let hit = null;
  for (let retry = 0; retry < 3; retry++) {
    hit = await scrollToFindTrialLink(page);
    if (!hit) break;
    try {
      console.log(`   Klik: "${hit.label}" (attempt ${retry + 1})`);
      await humanClick(hit.el);
      break;
    } catch (err) {
      console.warn(`   [!] Klik trial link gagal: ${err.message} — retry...`);
      await sleep(1000);
      continue;
    }
  }
  if (!hit) {
    const txtHit = await clickByTexts(
      page,
      ["download free for 30 days", "start free trial", "free for 30 days", "try free for 30 days"],
      8000
    ).catch(() => null);
    if (txtHit) {
      console.log(`   Klik: "${txtHit}" (clickByTexts)`);
    } else {
      return false;
    }
  }
  await randomDelay(800, 1200);
  // Setelah klik trial (stage awal) — solver siaga kalau CF muncul di auth
  await waitCloudflareClear(page, "post-trial-klik").catch((err) => {
    if (err.message === "CLOUDFLARE_BLOCKED") throw err;
  });

  // New tab may open for OAuth
  await sleep(1000);
  const hit2 = await scanTabsForAuthUrl(context, page);
  if (hit2.found && hit2.page) {
    session.page = hit2.page;
    await hit2.page.bringToFront().catch(() => {});
  }
  return true;
}

async function goToSignupViaTrialLink(session, credentials = null) {
  const cfg = config.signup_via_trial_link ?? {};
  const waitMs = (cfg.wait_seconds ?? 25) * 1000;
  const noBotTouch =
    config.captcha_safe?.no_bot_touch_signup === true &&
    config.captcha_safe?.enabled !== false;
  let { page } = session;

  if (cfg.enabled === false) {
    const url = cfg.fallback_signup_url || "https://www.scribd.com/oauth/signup";
    console.log(`   Fallback: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (noBotTouch && credentials) {
      await waitForFullyManualSignup(page, credentials.email, credentials.password, url);
    } else {
      await waitForSignupForm(page, waitMs);
    }
    return url;
  }

  const pages = cfg.entry_pages?.length ? cfg.entry_pages : ["https://www.scribd.com/"];
  const entryUrl = pages[Math.floor(Math.random() * pages.length)];

  if (noBotTouch && credentials) {
    console.log(`   Entry: ${entryUrl}`);
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    await randomDelay(600, 1000);
    await waitForFullyManualSignup(
      page,
      credentials.email,
      credentials.password,
      entryUrl
    );
    console.log(`   Signup OK: ${page.url()}`);
    return entryUrl;
  }

  let opened = await openSignupFromEntry(session, entryUrl);
  page = session.page;
  if (!opened) {
    const fallback = cfg.fallback_signup_url || "https://www.scribd.com/oauth/signup";
    console.log(`   Link trial tidak ada — fallback: ${fallback}`);
    await page.goto(fallback, { waitUntil: "domcontentloaded" });
    await waitForSignupForm(page, waitMs);
    return fallback;
  }

  await waitForSignupForm(page, waitMs);
  console.log(`   Signup OK: ${page.url()}`);
  return entryUrl;
}

async function pageText(page) {
  const url = page.url();
  const source = await page.content();
  return { url, source, low: (url + " " + source).toLowerCase() };
}

async function needsEmailVerification(page) {
  const { low } = await pageText(page);
  return /verify|verification|check your email|confirm your email|we sent you an email/i.test(
    low
  );
}

async function waitForVerificationSettled(page, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let lastUrl = "";
  let stableSince = 0;
  try {
    lastUrl = page.url();
    stableSince = Date.now();
  } catch {
    return "";
  }
  while (Date.now() < end) {
    await sleep(400);
    let url = "";
    try {
      url = page.url();
    } catch {
      return lastUrl;
    }
    if (pageLooksVerify(url)) {
      lastUrl = url;
      stableSince = Date.now();
      continue;
    }
    if (url !== lastUrl) {
      lastUrl = url;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince > 1200) return url;
  }
  return lastUrl;
}

async function handleEmailVerification(session, tempBox) {
  const page = session.page;
  const context = session.context;
  const verifyCfg = config.email_verification ?? {};
  if (verifyCfg.enabled === false) return false;

  if (!(await needsEmailVerification(page))) return false;

  const checkoutUrl = page.url();
  const saveCheckout = /\/checkout/i.test(checkoutUrl);

  console.log("   Tunggu link verifikasi di inbox...");
  const link = await pollVerificationLink(tempBox, {
    timeout_ms: (verifyCfg.timeout_seconds ?? 120) * 1000,
    interval_ms: verifyCfg.poll_interval_ms ?? 5000,
  });

  if (saveCheckout) {
    console.log("   Verifikasi di tab baru (tetap di checkout)...");
    const newPage = await context.newPage();
    await newPage.goto(link, { waitUntil: "domcontentloaded" });
    const settled = await waitForVerificationSettled(newPage, 12000);
    console.log(`   Verifikasi settle: ${settled.slice(0, 100)}`);
    await newPage.close().catch(() => {});
    await page.bringToFront().catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded" });
    await randomDelay(2000, 3000);
  } else {
    await page.goto(link, { waitUntil: "domcontentloaded" });
    const settled = await waitForVerificationSettled(page, 12000);
    console.log(`   Verifikasi settle: ${settled.slice(0, 100)}`);
    await page.goto(config.payment_url || "https://www.scribd.com/checkout", {
      waitUntil: "domcontentloaded",
    });
    await randomDelay(800, 1200);
  }

  return true;
}

/**
 * Walk the FULL frame tree recursively — `page.frames()` kadang tidak expose
 * frame nested di dalam cross-origin wrapper (mis. `__privateStripeFrame*`
 * ada di dalam `m.stripe.network/inner.html`).
 */
function collectAllFrames(rootFrame) {
  const out = [];
  const seen = new Set();
  const walk = (frame) => {
    if (!frame || seen.has(frame)) return;
    seen.add(frame);
    out.push(frame);
    let children = [];
    try { children = frame.childFrames(); } catch { children = []; }
    for (const c of children) walk(c);
  };
  try { walk(rootFrame); } catch { /* ignore */ }
  return out;
}

async function clickByTexts(page, texts, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const text of texts) {
      const candidates = [
        page.getByRole("button", { name: new RegExp(text, "i") }),
        page.getByRole("link", { name: new RegExp(text, "i") }),
        page.getByRole("label", { name: new RegExp(text, "i") }),
        page.locator("button, a, label").filter({ hasText: new RegExp(text, "i") }),
      ];
      for (const loc of candidates) {
        try {
          const count = await loc.count();
          for (let i = 0; i < Math.min(count, 5); i++) {
            const el = loc.nth(i);
            if (await el.isVisible().catch(() => false)) {
              await humanClick(el);
              return text;
            }
          }
        } catch {
          // skip
        }
      }
    }
    await sleep(150);
  }
  return null;
}

async function clickCheckoutContinueTrial(page) {
  const selector =
    config.selectors.checkout_continue_trial || "button[data-e2e='standard-plan-cta']";

  try {
    const btn = await findVisible(page, selector, 15000);
    const label = ((await btn.innerText().catch(() => "")) || "Continue with free trial").trim();
    console.log(`   Klik: "${label}"`);
    await humanClick(btn);
    return true;
  } catch {
    const hit = await clickByTexts(page, [
      "continue with free trial",
      "start free trial",
      "continue with trial",
    ]);
    if (hit) {
      console.log(`   Klik: "${hit}"`);
      return true;
    }
    throw new Error("Tombol Continue with free trial tidak ditemukan di /checkout");
  }
}

/**
 * Pilih plan trial: monthly (default) atau annual — selector EXAKT:
 *   button[data-e2e="monthly-plan-cta"] / button[data-e2e="annual-plan-cta"]
 * Fallback: tombol "Start your 30 day trial" di dalam kartu
 * <h3>Premium Monthly|Annual</h3> yang sesuai.
 * Return true kalau berhasil klik (lalu tunggu navigasi di caller).
 */
async function selectTrialPlan(page) {
  const want = String(config.plan || "monthly").toLowerCase().startsWith("annual")
    ? "annual"
    : "monthly";

  // 1. Selector exakt data-e2e
  try {
    const btn = page.locator(`button[data-e2e="${want}-plan-cta"]`).first();
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      const label = ((await btn.innerText().catch(() => "")) || "Start trial").trim().slice(0, 50);
      console.log(`   Plan: ${want} → klik "${label}" [${want}-plan-cta]`);
      await humanClick(btn);
      return true;
    }
  } catch {
    // lanjut fallback
  }

  // 2. Fallback: kartu berdasarkan heading (teks plan ada di h3, bukan tombol)
  const cardHit = await page
    .evaluate((wantAnnual) => {
      const re = wantAnnual ? /premium annual/i : /premium monthly/i;
      const h = [...document.querySelectorAll("h1, h2, h3, h4")].find((el) => re.test(el.innerText || ""));
      if (!h) return null;
      let card = h.parentElement;
      for (let i = 0; i < 4 && card; i++) {
        if (card.querySelector("button")) break;
        card = card.parentElement;
      }
      if (!card) return null;
      const btns = [...card.querySelectorAll("button")].filter(
        (b) => b.offsetParent !== null && !b.disabled
      );
      const t = btns.find((b) => /start.*trial|continue/i.test(b.innerText || ""));
      if (!t) return null;
      try {
        t.scrollIntoView({ block: "center" });
        t.click();
        return (t.innerText || "").trim().slice(0, 50);
      } catch {
        return null;
      }
    }, want === "annual")
    .catch(() => null);
  if (cardHit) {
    console.log(`   Plan: ${want} → klik "${cardHit}" (card fallback)`);
    await sleep(800);
    return true;
  }

  return false;
}

/**
 * Pilih opsi metode GoPay di payment-options (tab Stripe / radio / button
 * yang mengandung teks "gopay"). Return label kalau berhasil diklik.
 */
async function selectGoPayMethodOption(page) {
  const hit = await page
    .evaluate(() => {
      const els = [...document.querySelectorAll("button, a, label, [role='tab'], [role='radio'], [data-e2e]")];
      const t = els.find((el) => {
        if (el.offsetParent === null || el.disabled) return false;
        const s = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-e2e") || ""} ${el.getAttribute("value") || ""}`;
        return /gopay/i.test(s) && s.trim().length < 120;
      });
      if (!t) return null;
      try {
        t.scrollIntoView({ block: "center" });
        t.click();
        return ((t.innerText || t.getAttribute("aria-label") || "GoPay").trim().slice(0, 50));
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (hit) {
    console.log(`   Metode: pilih "${hit}"`);
    await sleep(1500);
    return true;
  }
  return false;
}

/**
 * Tunggu opsi GoPay muncul di payment-options (poll tiap 1 detik).
 * Section metode pembayaran loading belakangan — cek sekali langsung
 * pasti gagal. Return true kalau berhasil dipilih / sudah redirect Midtrans.
 */
async function waitForGoPayOption(page, timeoutMs = 10000) {
  console.log("   Tunggu opsi GoPay (max 10s)...");
  const end = Date.now() + timeoutMs;
  let lastLog = 0;
  let checks = 0;
  let goPaySelected = false;
  while (Date.now() < end) {
    checks++;
    if (await isMidtransGoPay(page)) return true;
    const picked = await selectGoPayMethodOption(page).catch(() => false);
    if (picked) {
      console.log(`   Opsi GoPay ketemu setelah ${checks}x cek`);
      goPaySelected = true;
      break;
    }
    if (Date.now() - lastLog > 5000) {
      console.log("   ... still loading, cek ulang...");
      lastLog = Date.now();
    }
    await sleep(800);
  }
  if (goPaySelected) {
    console.log("   GoPay sudah dipilih — langsung klik Start Trial");
    return false; // return false agar caller langsung klik Start Trial, bukan tunggu Midtrans redirect
  }
  console.log("   [!] GoPay: belum redirect — klik Start Trial");
  return false;
}

/**
 * Klik tombol "Start your free trial" (submit) di payment-options.
 * Tunggu sampai enabled (aktif setelah metode dipilih), max ~12 detik.
 */
async function clickStartTrialSubmit(page) {
  const end = Date.now() + 15000;
  let lastLog = 0;
  while (Date.now() < end) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(400);
    const hit = await page
      .evaluate(() => {
        const allBtns = [...document.querySelectorAll("button, a, [role='button']")];
        const b = allBtns.find(
          (el) =>
            el.offsetParent !== null &&
            !el.disabled &&
            /start your free trial|start free trial|start trial/i.test(el.innerText || "")
        );
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && r.top < window.innerHeight;
        if (!visible) return null;
        try {
          b.scrollIntoView({ block: "center" });
          b.click();
          return (b.innerText || "").trim().slice(0, 50);
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (hit) {
      console.log(`   Klik: "${hit}" [main-page]`);
      return true;
    }
    if (Date.now() - lastLog > 5000) {
      const debug = await page.evaluate(() => {
        const btns = [...document.querySelectorAll("button")];
        return btns
          .filter((b) => b.offsetParent !== null)
          .map((b) => b.innerText?.trim().slice(0, 40))
          .filter(Boolean);
      }).catch(() => []);
      console.log(`   ... nunggu tombol Start trial... (btns visible: ${debug.join(" | ") || "(none)"}`);
      lastLog = Date.now();
    }
    await sleep(600);
  }
  console.log("   [!] Tombol Start trial tidak ditemukan");
  return false;
}

/** Tunggu spinner/loading di checkout hilang (halaman Scribd sering "muter" dulu). */
async function waitCheckoutSettled(page, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  let lastLog = 0;

  while (Date.now() < end) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    } catch {
      // ignore
    }

    const info = await page
      .evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const low = text.toLowerCase();
        const spinners = document.querySelectorAll(
          '[class*="spinner"], [class*="Spinner"], [class*="loading"], [class*="Loading"], [aria-busy="true"], .circular, progress'
        ).length;
        const anim = [...document.querySelectorAll("*")].filter((el) => {
          const s = getComputedStyle(el);
          return (
            (s.animationName && s.animationName !== "none" && /spin|rotate|load/i.test(s.animationName)) ||
            (s.borderTopColor && el.className && /spin|load|circle/i.test(String(el.className)))
          );
        }).length;
        const busy =
          spinners > 0 ||
          anim > 2 ||
          /loading|please wait|just a moment|sedang memuat/i.test(low);
        // payment method hints already on page?
        const hasMethodHint =
          /credit|debit|card|paypal|apple pay|google pay|payment method/i.test(low);
        const snippets = text.slice(0, 220);
        return { busy, hasMethodHint, snippets, spinners, len: text.length };
      })
      .catch(() => ({ busy: true, hasMethodHint: false, snippets: "", spinners: 0, len: 0 }));

    if (!info.busy && (info.hasMethodHint || info.len > 80)) {
      console.log("   Checkout UI ready");
      return info;
    }

    if (Date.now() - lastLog > 7000) {
      console.log(
        `   ... nunggu halaman payment settle (spinner=${info.spinners}, text=${info.len})`
      );
      if (info.snippets) console.log(`   preview: ${info.snippets.slice(0, 120)}...`);
      lastLog = Date.now();
    }
    await sleep(700);
  }

  console.warn("   [!] Timeout settle — lanjut paksa");
  return null;
}



/**
 * Alur checkout GoPay-only:
 * plan → continue trial → payment-options → klik GoPay → redirect Midtrans Snap.
 * Tidak ada flow kartu/VCC.
 */
async function goThroughCheckoutFlow(page) {
  const checkoutUrl = config.payment_url || "https://www.scribd.com/checkout";
  const current = page.url();

  if (/\/checkout/i.test(current)) {
    console.log(`   Sudah di checkout: ${current}`);
  } else {
    console.log(`   → ${checkoutUrl}`);
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded" });
    await randomDelay(800, 1200);
    console.log(`   Checkout: ${page.url()}`);
  }

  await waitCheckoutSettled(page, 20000);

  if (await isMidtransGoPay(page)) {
    console.log("   Metode: GoPay via Midtrans Snap (auto-redirect)");
    return "gopay";
  }

  if (!/payment-options|payment\//i.test(page.url())) {
    try {
      const planPicked = await selectTrialPlan(page).catch(() => false);
      if (!planPicked) {
        await clickCheckoutContinueTrial(page);
      }
      await page.waitForURL(/payment|checkout|midtrans/i, { timeout: 15000 }).catch(() => {});
      await randomDelay(1000, 1600);
    } catch (err) {
      console.warn(`   [!] Continue trial: ${err.message}`);
    }
  }

  console.log(`   Payment page: ${page.url()}`);
  await waitCheckoutSettled(page, 20000);
  try {
    await waitCloudflareClear(page, "checkout");
  } catch (err) {
    if (err.message === "CLOUDFLARE_BLOCKED") throw err;
  }

  if (await isMidtransGoPay(page)) {
    console.log("   Metode: GoPay via Midtrans Snap");
    return "gopay";
  }

  // Klik GoPay option
  const picked = await selectGoPayMethodOption(page).catch(() => false);
  if (picked) {
    console.log("   GoPay dipilih — klik Start Trial...");
    await sleep(500);
  }

  // Klik Start Trial button
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(400);
  const started = await clickStartTrialSubmit(page);
  if (started) {
    await page.waitForURL(/midtrans|checkout|payment/i, { timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 1500);
    if (await isMidtransGoPay(page)) {
      console.log("   Metode: GoPay via Midtrans Snap");
      return "gopay";
    }
  }

  // Cek apakah sudah di Midtrans
  if (await isMidtransGoPay(page)) {
    console.log("   Metode: GoPay via Midtrans Snap");
    return "gopay";
  }

  // Tunggu redirect ke Midtrans
  console.log("   Tunggu redirect ke Midtrans...");
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await isMidtransGoPay(page)) {
      console.log("   Metode: GoPay via Midtrans Snap");
      return "gopay";
    }
    await sleep(1000);
  }

  console.warn("   [!] Tidak redirect ke Midtrans — kamu pilih GoPay manual di browser");
  return "gopay";
}

async function collectFillScopes(page) {
  const scopes = [page];
  const seen = new Set();
  let main;
  try { main = page.mainFrame(); } catch { return scopes; }
  const allFrames = collectAllFrames(main);
  for (const frame of allFrames) {
    try {
      if (frame === main) continue;
      const key = (frame.url() || "") + frame.name();
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push(frame);
    } catch {
      // frame keburu detached — skip
    }
  }
  return scopes;
}

function pageLooksSuccess(source, url) {
  const lowSource = String(source || "").toLowerCase();
  const lowUrl = String(url || "").toLowerCase();
  const textHit = (config.success_contains ?? []).some((k) =>
    lowSource.includes(k.toLowerCase())
  );
  const urlHit = (config.success_url_contains ?? []).some((k) =>
    lowUrl.includes(k.toLowerCase())
  );
  return textHit && urlHit;
}

function pageLooksVerify(url) {
  const lowUrl = String(url || "").toLowerCase();
  return (config.verify_url_contains ?? []).some((k) =>
    lowUrl.includes(k.toLowerCase())
  );
}

/** Halaman Midtrans Snap untuk linking GoPay (tokenization). */
async function isMidtransGoPay(page) {
  try {
    const url = page.url();
    if (/midtrans\.com/i.test(url)) return true;
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    return /link gopay|gopay-tokenization|link and pay/i.test(text);
  } catch {
    return false;
  }
}

function normalizeGoPayPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = d.slice(1); // +62 sudah tercetak di form
  else if (d.startsWith("62") && d.length > 11) d = d.slice(2);
  return d;
}

/** Dump struktur halaman Midtrans (input/button/iframe) untuk debug selector. */
async function dumpGoPayDebug(page) {
  try {
    const scopes = await collectFillScopes(page);
    console.log(`   [gopay-debug] scopes=${scopes.length} url=${page.url().slice(0, 100)}`);
    for (const [si, scope] of scopes.slice(0, 6).entries()) {
      const info = await scope
        .evaluate(() => ({
          inputs: [...document.querySelectorAll("input")].map((el) => ({
            type: el.type,
            name: el.name || "",
            ph: (el.placeholder || "").slice(0, 30),
            mode: el.getAttribute("inputmode") || "",
            vis: el.offsetParent !== null,
          })),
          digitBtns: [...document.querySelectorAll("button, a, [role='button']")]
            .map((el) => (el.innerText || "").trim())
            .filter((t) => /^\d$/.test(t)),
          shortBtns: [...document.querySelectorAll("button, a, [role='button']")]
            .map((el) => (el.innerText || "").trim().slice(0, 40))
            .filter((t) => t && t.length <= 40)
            .slice(0, 12),
        }))
        .catch(() => null);
      if (info) console.log(`   [gopay-debug] frame#${si}: ${JSON.stringify(info).slice(0, 400)}`);
    }
  } catch (err) {
    console.warn(`   [gopay-debug] gagal: ${err.message}`);
  }
}

/**
 * Cari ELEMEN PERTAMA yang cocok di main page + SEMUA iframe (Snap UI
 * Midtrans sering render form di dalam iframe — versi lama hanya cek
 * main page sehingga timeout 15 detik sia-sia).
 * check = (locator) => "css:..." untuk findVisible, atau {role...} untuk teks.
 */
async function findInAnyScope(page, cssCsv, timeoutMs = 10000) {
  const list = cssCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const scopes = await collectFillScopes(page);
    for (const scope of scopes) {
      for (const sel of list) {
        try {
          const loc = scope.locator(sel).first();
          if ((await loc.count().catch(() => 0)) === 0) continue;
          if (await loc.isVisible().catch(() => false)) return loc;
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width > 10 && box.height > 5) return loc;
        } catch {
          // next
        }
      }
    }
    await sleep(400);
  }
  return null;
}

/** Isi cepat field numerik: fill() instan + dispatch event + verifikasi. */
async function fastFillNumeric(locator, value) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});
  await locator.press("Control+a").catch(() => {});
  await locator.fill(value).catch(() => {});
  const handle = await locator.elementHandle().catch(() => null);
  if (handle) {
    await handle
      .evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => {});
  }
  await sleep(250);
  const actual = await locator.inputValue().catch(() => "");
  return actual.replace(/\D/g, "") === String(value).replace(/\D/g, "");
}

/** Klik tombol digit di papan PIN custom (tombol 0-9, bukan input). */
async function clickPinPadDigit(page, digit) {
  const scopes = await collectFillScopes(page);
  for (const scope of scopes) {
    const hit = await scope
      .evaluate((d) => {
        const els = [...document.querySelectorAll("button, a, [role='button'], div[role='button']")];
        const btn = els.find((el) => (el.innerText || "").trim() === d);
        if (!btn) return false;
        try {
          btn.click();
          return true;
        } catch {
          return false;
        }
      }, String(digit))
      .catch(() => false);
    if (hit) return true;
  }
  return false;
}

/**
 * Isi OTOMATIS di Midtrans Snap: nomor HP → klik Link → isi PIN.
 * Return true kalau semua field terisi; false → serahkan ke manual.
 * PIN support 3 mode: input tunggal, multi-box, papan PIN custom (0-9).
 */
async function autoFillGoPay(page) {
  const g = config.gopay ?? {};
  if (g.auto_fill === false) return false;
  const phone = normalizeGoPayPhone(g.phone);
  const pin = String(g.pin || "").replace(/\D/g, "");
  if (!phone) {
    console.log("   [!] gopay.phone kosong di config — nomor diisi manual");
    return false;
  }

  console.log(`   [GoPay 1/3] Isi nomor: +62${phone}`);

  const filled = await page.evaluate((phoneDigits) => {
    // Midtrans Snap: cari input dalam .phone-number-input
    const wrappers = document.querySelectorAll(".phone-number-input");
    let input = null;
    for (const w of wrappers) {
      const el = w.querySelector("input[type='tel'], input[type='text']");
      if (el) { input = el; break; }
    }
    if (!input) {
      // Fallback: cari semua input tel dalam linking-container
      const all = document.querySelectorAll(".linking-container input");
      for (const el of all) {
        if (el.type === "tel" || el.inputMode === "tel" || el.type === "text") {
          input = el; break;
        }
      }
    }
    if (!input) return false;

    // Clear existing value
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // Type digit-by-digit (React controlled input — must fire input events)
    for (const digit of phoneDigits) {
      input.value += digit;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("keydown", { bubbles: true, key: digit }));
      input.dispatchEvent(new Event("keypress", { bubbles: true, key: digit }));
      input.dispatchEvent(new Event("keyup", { bubbles: true, key: digit }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();

    return input.value.replace(/\D/g, "") === phoneDigits;
  }, phone).catch(() => false);

  if (!filled) {
    // Fallback: click field then type
    const phoneField = await findInAnyScope(page, "input[type='tel']", 5000).catch(() => null);
    if (phoneField) {
      try {
        await phoneField.click({ timeout: 3000 });
        await phoneField.pressSequentially(phone, { delay: 80 });
        await page.waitForTimeout(500);
        const val = (await phoneField.inputValue().catch(() => "")).replace(/\D/g, "");
        if (val === phone) {
          console.log("   ✓ nomor terisi (pressSequentially)");
          await sleep(400);
          // proceed to click Link
        } else {
          console.log("   [!] nomor meragukan — isi manual");
          return false;
        }
      } catch {
        console.log("   [!] Field nomor HP tak bisa diisi — isi manual");
        await dumpGoPayDebug(page);
        return false;
      }
    } else {
      console.log("   [!] Field nomor HP tak ketemu — isi manual");
      return false;
    }
  } else {
    console.log("   ✓ nomor terisi (evaluate)");
    await sleep(400);
  }

  // 2. Klik Link and pay — tunggu button ENABLED (nomor sudah valid)
  console.log("   [GoPay 2/3] Klik Link and pay...");

  const linkHit = await page.evaluate(() => {
    // Disabled button ada di dalam .button-cta
    const btn = document.querySelector(".button-cta button");
    if (!btn) return null;
    const isDisabled = btn.disabled || btn.classList.contains("disabled") || btn.classList.contains("inactive");
    return { text: (btn.innerText || "").trim().slice(0, 40), isDisabled };
  }).catch(() => null);

  if (linkHit && !linkHit.isDisabled) {
    const clicked = await page.locator(".button-cta button").click({ timeout: 5000 }).catch(() => null);
    if (clicked !== null) {
      console.log(`   Klik: "${linkHit.text}" [button-cta]`);
      await sleep(1200);
      console.log("   [GoPay] Link diklik — lanjut stage driver...");
      return true;
    }
  }

  // Tunggu button enabled (React re-render setelah nomor terisi)
  const btnEnabled = await page.locator(".button-cta button:not(.disabled):not(.inactive)").waitFor({ state: "visible", timeout: 10000 }).catch(() => null);
  if (btnEnabled) {
    await btnEnabled.click({ timeout: 5000 }).catch(() => {});
    console.log("   Klik: Link and pay [enabled]");
    await sleep(1200);
    return true;
  }

  // Last resort: clickByTexts
  const loose = await clickByTexts(page, ["link and pay", "link", "hubungkan"], 6000).catch(() => null);
  if (!loose) {
    console.log("   [!] Tombol Link and pay tak bisa diklik — isi manual");
    return false;
  }
  console.log(`   Klik: "${loose}"`);
  await sleep(1200);
  console.log("   [GoPay] Link diklik — lanjut stage driver...");
  return true;
}

/** Kotak kode visible (multi-box OTP/PIN), sudah terisi atau masih kosong. */
async function inspectCodeBoxes(page) {
  const scopes = await collectFillScopes(page);
  for (const scope of scopes) {
    try {
      const loc = scope.locator(
        "input[data-pin], input.pin-input, div[class*='pin' i] input, div[class*='otp' i] input, input[inputmode='numeric'], input[type='tel']"
      );
      const n = await loc.count().catch(() => 0);
      if (n < 4) continue;
      const boxes = Array.from({ length: n }, (_, i) => loc.nth(i));
      const vis = [];
      for (const b of boxes) {
        if (await b.isVisible().catch(() => false)) vis.push(b);
      }
      if (vis.length < 4) continue;
      let filled = 0;
      for (const b of vis) {
        const v = await b.inputValue().catch(() => "");
        if (v) filled++;
      }
      return { boxes: vis, filled, total: vis.length };
    } catch {
      // next scope
    }
  }
  return null;
}

/** Isi kode ke multi-box (satu digit per kotak). */
async function fillCodeBoxes(boxes, code) {
  for (let i = 0; i < Math.min(boxes.length, code.length); i++) {
    try {
      await boxes[i].click({ timeout: 3000 }).catch(() => {});
      await boxes[i].fill(code[i] || "").catch(() => {});
      await sleep(100 + Math.floor(Math.random() * 100));
    } catch {
      // next box
    }
  }
}

/**
 * Cari 6 box PIN GoPay via selector EXAKT (input[data-testid="pin-input-N"]).
 * Kenapa perlu: pencari generik kadang salah ambil field lain (mis. nomor HP
 * yang masih nyangkut) sehingga PIN "tidak terdeteksi" padahal ada.
 */
async function inspectExactPinBoxes(page) {
  const scopes = await collectFillScopes(page);
  for (const scope of scopes) {
    try {
      const loc = scope.locator('input[data-testid^="pin-input-"]');
      const n = await loc.count().catch(() => 0);
      if (n < 4) continue;
      const boxes = Array.from({ length: n }, (_, i) => loc.nth(i));
      const vis = [];
      for (const b of boxes) {
        if (await b.isVisible().catch(() => false)) vis.push(b);
      }
      if (vis.length < 4) continue;
      const filled = await countFilledBoxes(vis);
      return { boxes: vis, filled, total: vis.length };
    } catch {
      // next scope
    }
  }
  return null;
}

async function countFilledBoxes(boxes) {
  let filled = 0;
  for (const b of boxes) {
    const v = await b.inputValue().catch(() => "");
    if (v) filled++;
  }
  return filled;
}

/** Isi PIN secepat mungkin: fill() instan per kotak + verifikasi hitungan. */
async function fillCodeBoxesFast(boxes, code) {
  for (let i = 0; i < Math.min(boxes.length, code.length); i++) {
    try {
      await boxes[i].fill(code[i] || "").catch(() => {});
    } catch {
      // next box
    }
  }
  await sleep(300);
}

/**
 * Isi PIN GoPay — 3 mode: multi-box → input tunggal → papan PIN custom.
 * Return true kalau terisi (atau sudah balik ke Scribd).
 * Prioritas: direct DOM evaluate (React dispatchEvent) sebelum locator.
 */
async function fillGoPayPin(page, pin, timeoutMs = 45000) {
  if (!pin) {
    console.log("   [!] gopay.pin kosong — PIN isi manual di browser");
    return false;
  }
  const end = Date.now() + timeoutMs;
  let dumped = false;
  while (Date.now() < end) {
    try {
      const url = page.url();
      if (/scribd\.com/i.test(url) && !/midtrans/i.test(url)) {
        console.log("   (sudah balik ke Scribd — PIN tak diperlukan)");
        return true;
      }
    } catch {
      // ignore
    }

    // Try direct DOM evaluate multi-box (Midtrans React 6 kotak maxlength=1)
    const directMulti = await page
      .evaluate((pinDigits) => {
        const boxes = [...document.querySelectorAll('input[data-testid^="pin-input-"]')];
        if (boxes.length < 4) return null;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        const protoSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(boxes[0]), "value")?.set;
        const setVal = setter || protoSetter;
        let filled = 0;
        for (let i = 0; i < Math.min(boxes.length, pinDigits.length); i++) {
          const el = boxes[i];
          const ch = pinDigits[i] || "";
          el.focus();
          // React: must use native setter, not el.value =
          if (setVal) setVal.call(el, ch);
          else el.value = ch;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          // trigger auto-advance handler yang nunggu input event
          el.dispatchEvent(new KeyboardEvent("input", { bubbles: true }));
          if (el.value === ch) filled++;
        }
        // verify
        const ok = [...document.querySelectorAll('input[data-testid^="pin-input-"]')].filter((e) => e.value).length;
        return ok;
      }, pin)
      .catch(() => null);
    if (directMulti !== null && directMulti >= Math.min(4, pin.length)) {
      console.log(`   ✓ PIN terisi (direct multi-box: ${directMulti}/${pin.length})`);
      await sleep(600);
      return true;
    }
    // Fallback: focus kotak pertama + ketik berurutan (Midtrans auto-advance fokus)
    const typeThrough = await page
      .evaluate((pinDigits) => {
        const first = document.querySelector('input[data-testid="pin-input-0"]');
        if (!first) return false;
        first.focus();
        return true;
      }, pin)
      .catch(() => false);
    if (typeThrough) {
      await page.keyboard.type(pin, { delay: 90 }).catch(() => {});
      await sleep(400);
      const typedOk = await page
        .evaluate(() => [...document.querySelectorAll('input[data-testid^="pin-input-"]')].filter((e) => e.value).length)
        .catch(() => 0);
      if (typedOk >= Math.min(4, pin.length)) {
        console.log(`   ✓ PIN terisi (keyboard type: ${typedOk}/${pin.length})`);
        await sleep(600);
        return true;
      }
      // clear if partial then let locator paths retry
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('input[data-testid^="pin-input-"]')) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (s) s.call(el, "");
          else el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }).catch(() => {});
    }
    // Try single direct
    const directSingle = await page
      .evaluate((pinDigits) => {
        const el =
          document.querySelector('input[data-testid="pin-input-field"]') ||
          document.querySelector('input[type="password"]');
        if (!el || el.offsetParent === null) return null;
        if (el.value) return "filled";
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        for (const ch of pinDigits) {
          el.value += ch;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
        return el.value ? "ok" : null;
      }, pin)
      .catch(() => null);
    if (directSingle === "ok" || directSingle === "filled") {
      console.log(directSingle === "filled" ? "   (PIN sudah terisi — lanjut)" : "   ✓ PIN terisi (direct single)");
      await sleep(600);
      return true;
    }

    // Mode 1: multi-box — selector EXAKT: input[data-testid="pin-input-N"]
    const insp = await inspectExactPinBoxes(page);
    if (insp && insp.filled === 0) {
      console.log(`   Isi PIN ke ${insp.total} kotak (paste instan)...`);
      await fillCodeBoxesFast(insp.boxes, pin);
      const filledNow = await countFilledBoxes(insp.boxes);
      console.log(
        filledNow >= Math.min(insp.total, pin.length)
          ? "   ✓ PIN terisi penuh (multi-box)"
          : `   [!] PIN terisi ${filledNow}/${insp.total} — cek manual`
      );
      await sleep(600);
      return true;
    }
    if (insp && insp.filled > 0) {
      console.log("   (PIN sudah terisi — mungkin manual, lanjut)");
      return true;
    }

    // Mode 2: input tunggal — selector EXAKT: input[data-testid="pin-input-field"]
    const single = await findInAnyScope(
      page,
      'input[data-testid="pin-input-field"], input[type=\'password\'], input[name*=\'pin\' i], input[placeholder*=\'PIN\' i], input[autocomplete*=\'pin\' i]',
      1200
    );
    if (single) {
      const cur = await single.inputValue().catch(() => "");
      if (!cur) {
        const ok = await fastFillNumeric(single, pin).catch(() => false);
        console.log(ok ? "   ✓ PIN terisi (single, instan)" : "   [!] PIN meragukan — cek manual");
      } else {
        console.log("   (PIN sudah terisi — lanjut)");
      }
      await sleep(600);
      return true;
    }

    // Mode 3: papan PIN custom (tombol 0-9)
    const scopes = await collectFillScopes(page);
    let hasPad = false;
    for (const scope of scopes) {
      const n = await scope
        .evaluate(() => {
          const els = [...document.querySelectorAll("button, a, [role='button']")];
          return els.filter((el) => /^\d$/.test((el.innerText || "").trim())).length;
        })
        .catch(() => 0);
      if (n >= 10) {
        hasPad = true;
        break;
      }
    }
    if (hasPad) {
      console.log("   Papan PIN custom — klik digit...");
      for (const ch of pin) {
        await clickPinPadDigit(page, ch);
        await sleep(150 + Math.floor(Math.random() * 150));
      }
      console.log("   ✓ PIN diklik (pin-pad)");
      await sleep(1000);
      return true;
    }

    if (!dumped && Date.now() > end - 30000) {
      dumped = true;
      await dumpGoPayDebug(page);
    }
    await sleep(1200);
  }
  console.log("   [!] Field PIN tak muncul — isi manual / approve via aplikasi");
  await dumpGoPayDebug(page);
  return false;
}

/**
 * Klik Hubungkan — TUNGGU sampai enabled dulu (max timeoutMs).
 * Tombol consent Midtrans disabled sampai nomor HP lolos validasi;
 * klik saat disabled = no-op, makanya percobaan sekali langsung gagal.
 * Return label kalau terklik, null kalau tetap disabled/tak ketemu.
 */
async function clickConsentWhenEnabled(page, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const btn = await findInAnyScope(page, 'button[data-testid="consent-button"]', 1500);
    if (btn) {
      const st = await btn
        .evaluate((el) => ({ disabled: !!el.disabled, text: (el.innerText || "").trim().slice(0, 30) }))
        .catch(() => null);
      if (st && !st.disabled) {
        await humanClick(btn).catch(() => {});
        return `${st.text || "Hubungkan"} [consent-button]`;
      }
    }
    await sleep(500);
  }
  return null;
}

/**
 * Klik tombol via selector CSS — TUNGGU sampai visible + enabled dulu.
 * Midtrans pakai CLASS disabled/inactive, bukan attribute disabled.
 * Return label kalau terklik, null kalau timeout.
 */
async function clickCssWhenEnabled(page, cssSel, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < end) {
    const loc = await findInAnyScope(page, cssSel, 1500);
    if (loc) {
      const st = await loc
        .evaluate((el) => ({
          disabled:
            !!el.disabled ||
            el.getAttribute("aria-disabled") === "true" ||
            el.classList.contains("disabled") ||
            el.classList.contains("inactive") ||
            el.classList.contains("inactive2"),
          text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
        }))
        .catch(() => null);
      if (st && !st.disabled) {
        // Direct evaluate click — humanClick sering cuma scroll kalau overlay/animasi
        const clicked = await loc
          .evaluate((el) => {
            try {
              el.scrollIntoView({ block: "center" });
              el.click();
              return true;
            } catch {
              return false;
            }
          })
          .catch(() => false);
        if (clicked) return `${st.text || cssSel} [css]`;
        await humanClick(loc).catch(() => {});
        return `${st.text || cssSel} [css]`;
      }
      if (Date.now() - lastLog > 5000) {
        console.log(`   ... tombol ${cssSel} masih disabled — tunggu aktif`);
        lastLog = Date.now();
      }
    }
    await sleep(500);
  }
  return null;
}

/**
 * Klik tombol stage — prioritas: selector CSS exakt dulu (kalau diberi),
 * baru teks exact pendek, terakhir teks longgar. Cek semua scope (iframe).
 */
async function clickStageButton(page, cssSel, exactRes, looseRes) {
  if (cssSel) {
    const loc = await findInAnyScope(page, cssSel, 4000);
    if (loc) {
      const label = ((await loc.innerText().catch(() => "")) || cssSel).trim().slice(0, 40);
      await humanClick(loc).catch(() => {});
      await sleep(400);
      return `${label} [css]`;
    }
  }
  const scopes = await collectFillScopes(page);
  for (const scope of scopes) {
    const hit = await scope
      .evaluate(
        ({ exacts, looses }) => {
          const els = [...document.querySelectorAll("button, a, [role='button'], input[type='submit']")].filter(
            (el) => el.offsetParent !== null && !el.disabled
          );
          const txt = (el) => (el.innerText || el.value || "").trim();
          const exRe = new RegExp(exacts, "i");
          const loRe = new RegExp(looses, "i");
          const t =
            els.find((el) => exRe.test(txt(el))) || els.find((el) => loRe.test(txt(el)));
          if (!t) return null;
          try {
            t.scrollIntoView({ block: "center" });
            t.click();
            return txt(t).slice(0, 40);
          } catch {
            return null;
          }
        },
        { exacts: exactRes, looses: looseRes }
      )
      .catch(() => null);
    if (hit) return hit;
  }
  return null;
}

/** Deteksi stage GoPay saat ini — agregat main page + SEMUA iframe. */
async function detectGoPayStage(page) {
  let url = "";
  try {
    url = page.url();
  } catch {
    return { stage: "gone" };
  }
  const agg = { text: "", hasBackBtn: false, hasPayNow: false, hasBayar: false, boxes: 0, telEmpty: false };
  try {
    const scopes = await collectFillScopes(page);
    for (const scope of scopes.slice(0, 8)) {
      const info = await scope
        .evaluate(() => {
          const t = (document.body?.innerText || "").replace(/\s+/g, " ");
          const btns = [...document.querySelectorAll("button, a, [role='button'], input[type='submit']")]
            .filter((el) => el.offsetParent !== null && !el.disabled)
            .map((el) => (el.innerText || el.value || "").trim());
          const inputs = [...document.querySelectorAll("input")].filter(
            (el) => el.offsetParent !== null && !["hidden", "submit", "button", "checkbox"].includes(el.type)
          );
          const numeric = inputs.filter(
            (el) =>
              ["numeric", "tel"].includes(el.getAttribute("inputmode")) ||
              el.type === "tel" ||
              /otp|code|pin/i.test(el.name || "") ||
              /otp|code|pin/i.test(el.placeholder || "")
          );
          // NOTE: tombol final berteks "Bayar Rp 1" (bukan "Bayar" saja) +
          // punya data-testid="pay-button" — cocokkan keduanya.
          // \bbayar\b (word boundary) agar "Pembayaran" tidak ikut cocok.
          const payBtn = document.querySelector('button[data-testid="pay-button"]');
          return {
            text: t.slice(0, 600),
            hasBackBtn: btns.some((b) => /back to|kembali ke|return to/i.test(b)),
            hasPayNow: btns.some((b) => /^\s*pay now\s*$/i.test(b)),
            hasBayar:
              btns.some((b) => /\bbayar\b/i.test(b)) ||
              (payBtn && payBtn.offsetParent !== null && !payBtn.disabled),
            boxes: numeric.length,
            telEmpty: inputs.some(
              (el) => (el.type === "tel" || (el.name || "").toLowerCase().includes("phone")) && !el.value
            ),
          };
        })
        .catch(() => null);
      if (!info) continue;
      agg.text += ` ${info.text}`;
      agg.hasBackBtn ||= info.hasBackBtn;
      agg.hasPayNow ||= info.hasPayNow;
      agg.hasBayar ||= info.hasBayar;
      agg.boxes = Math.max(agg.boxes, info.boxes);
      agg.telEmpty ||= info.telEmpty;
      if (agg.text.length > 1500) break;
    }
  } catch {
    // abaikan — pakai apa yang terkumpul
  }
  const { text, hasBackBtn, hasPayNow, hasBayar, telEmpty } = agg;
  const otpBoxes = agg.boxes;

  const low = text.toLowerCase();
  if (/scribd\.com/i.test(url) && !/midtrans/i.test(url) && pageLooksSuccess(text, url)) {
    return { stage: "done", url };
  }
  // Halaman nomor HP: tombol Hubungkan sering DISABLED sampai nomor valid —
  // driver harus retry klik, bukan diam di "wait".
  if (
    /midtrans/i.test(url) &&
    (telEmpty || /phone number|nomor (hp|telepon)|link and pay|hubungkan/i.test(low))
  ) {
    return { stage: "phone", url, text };
  }
  if (hasBackBtn) return { stage: "back", url, text };
  if (hasPayNow) return { stage: "paynow", url, text };
  if (hasBayar && !hasPayNow) return { stage: "bayar", url, text };
  if (/otp|verification code|kode verifikasi|kode otp/i.test(low) && otpBoxes > 0) {
    return { stage: "otp", url, text };
  }
  if (/pin|masukkan pin|enter.*pin/i.test(low) && !telEmpty) {
    return { stage: "pin", url, text };
  }
  return { stage: "wait", url, text };
}

/**
 * Stage driver GoPay — jalan berurutan sampai sukses/timeout:
 * OTP (ketik via terminal) → PIN → Back → Pay Now → Bayar → PIN lagi → done.
 */
async function driveGoPayStages(page, timeoutMs) {
  const g = config.gopay ?? {};
  const pin = String(g.pin || "").replace(/\D/g, "");
  const end = Date.now() + timeoutMs;
  let lastStage = "";
  let otpAskedFor = "";
  let lastLog = 0;

  console.log("   Stage driver GoPay aktif (OTP → PIN → Back → Pay → Bayar → PIN)...\n");

  while (Date.now() < end) {
    const st = await detectGoPayStage(page);
    if (st.stage === "gone") throw new Error("Browser ditutup oleh user");
    if (st.stage === "done") {
      console.log("   ✓ GoPay linked + payment beres — trial aktif!");
      return true;
    }

    if (st.stage !== lastStage) {
      console.log(`   [stage] ${lastStage || "-"} → ${st.stage} | ${(st.url || "").slice(0, 80)}`);
      lastStage = st.stage;
      otpAskedFor = "";
    }

    try {
      const source = st.text || "";
      if (source && pageLooksError(source)) throw new Error("Midtrans/Scribd menunjukkan error payment");
      if (/please use another phone number|use a different phone|nomor sudah terdaftar/i.test(source)) {
        console.log("\n   ⚠ GoPay sudah terhubung ke akun Scribd lain!");
        console.log("   >>> 30 DETIK: Buka aplikasi GoPay → Settings → Connected Apps → Unlink Scribd <<<");
        console.log("   >>> Setelah unlink, bot akan retry otomatis <<<\n");
        const waitEnd = Date.now() + 30000;
        let countdown = 30;
        while (Date.now() < waitEnd) {
          if (Date.now() % 10000 < 500) {
            console.log(`   ... tunggu ${countdown}s lagi untuk unlink...`);
            countdown -= 10;
          }
          await sleep(500);
        }
        console.log("   Lanjut retry...");
        throw new Error("GOPAY_ALREADY_LINKED");
      }
    } catch (err) {
      if (/error payment|gopay_already_linked/i.test(err.message)) throw err;
    }

    if (st.stage === "phone") {
      // Masih di halaman nomor: pastikan nomor terisi, lalu klik Hubungkan
      // (tunggu enabled). Loop terus sampai halaman pindah.
      const g2 = config.gopay ?? {};
      const wantPhone = normalizeGoPayPhone(g2.phone);
      if (wantPhone) {
        const pf = await findInAnyScope(
          page,
          ".phone-number-input input, input.valid-input-value[type='tel'], input[type='tel']",
          3000
        ).catch(() => null);
        if (pf) {
          const cur = await pf.inputValue().catch(() => "").then((v) => v.replace(/\D/g, ""));
          if (cur !== wantPhone) {
            await fastFillNumeric(pf, wantPhone).catch(() => {});
            console.log("   [stage-phone] nomor diisi ulang (paste instan)");
            await sleep(800);
          }
        }
      }
      const hit = await clickConsentWhenEnabled(page, 8000).catch(() => null);
      console.log(
        hit ? `   Klik: "${hit}"` : "   ... tombol Hubungkan masih disabled/tak ketemu — retry"
      );
      await sleep(2000);
      continue;
    }

    if (st.stage === "otp") {
      // OTP selalu manual di browser (SMS ada di HP user).
      // Bot diam sampai halaman pindah sendiri setelah OTP di-submit.
      const insp = await inspectCodeBoxes(page);
      if (insp && insp.filled >= insp.total) {
        // sudah diisi di browser — klik Verify/Lanjut kalau ada tombolnya
        const v = await clickStageButton(
          page,
          null,
          "^\\s*(verify|verifikasi|ok|lanjut|confirm)\\s*$",
          "verify|verifikasi|lanjut|confirm|submit"
        ).catch(() => null);
        if (v) console.log(`   Klik: "${v}"`);
        await sleep(2500);
        continue;
      }
      if (!otpAskedFor) {
        otpAskedFor = st.url + st.text.slice(0, 50);
        console.log("\n   >>> OTP: isi manual di browser (cek SMS) — bot menunggu pindah halaman <<<\n");
      } else if (Date.now() - lastLog > 20000) {
        console.log("   ... nunggu OTP diisi di browser");
        lastLog = Date.now();
      }
      await sleep(2500);
      continue;
    }

    if (st.stage === "pin") {
      console.log("   [stage-pin] Isi PIN otomatis...");
      await fillGoPayPin(page, pin, 60000);
      await sleep(2500);
      continue;
    }

    if (st.stage === "back") {
      const hit = await clickStageButton(
        page,
        null,
        "^\\s*(back to .+|kembali ke .+|return to .+)\\s*$",
        "back to|kembali ke|return to"
      ).catch(() => null);
      console.log(hit ? `   Klik: "${hit}" → redirect payment final...` : "   [!] Tombol back tak terklik — klik manual");
      await sleep(4000);
      continue;
    }

    if (st.stage === "paynow") {
      // EXAKT: <button class="btn full primary btn-theme">Pay now</button>
      // Tunggu enabled dulu — klik ke tombol disabled = no-op (scroll doang).
      let hit = await clickCssWhenEnabled(page, "button.btn-theme", 12000).catch(() => null);
      if (!hit) {
        hit = await clickStageButton(page, null, "^\\s*pay now\\s*$", "pay now").catch(() => null);
      }
      console.log(hit ? `   Klik: "${hit}" (Rp1 final)...` : "   [!] Pay Now tak terklik — klik manual");
      await sleep(4000);
      continue;
    }

    if (st.stage === "bayar") {
      // EXAKT: <button data-testid="pay-button">Bayar Rp 1</button>
      // Tunggu enabled dulu — klik ke tombol disabled = no-op (scroll doang).
      let hit = await clickCssWhenEnabled(page, 'button[data-testid="pay-button"]', 15000).catch(
        () => null
      );
      if (!hit) {
        hit = await clickStageButton(page, null, "^\\s*bayar[\\s\\S]*$", "bayar").catch(() => null);
      }
      console.log(hit ? `   Klik: "${hit}"...` : "   [!] Bayar tak terklik — klik manual");
      await sleep(4000);
      continue;
    }

    if (Date.now() - lastLog > 15000) {
      console.log(`   ... nunggu stage lanjut | ${(st.url || "").slice(0, 80)}`);
      lastLog = Date.now();
    }
    await sleep(3000);
  }
  throw new Error("Timeout menunggu linking GoPay");
}

/**
 * Linking GoPay di Midtrans Snap (semi-otomatis):
 * bot isi nomor + PIN → kamu approve di aplikasi GoPay → bot deteksi sukses.
 * Selesai kalau: kembali ke scribd.com + teks sukses, atau error.
 * Kalau GOPAY_ALREADY_LINKED → 30d pause → retry (max 3x).
 */
async function waitForManualGoPay(page) {
  const timeout = (config.manual_payment?.timeout_seconds ?? 300) * 1000;
  const maxRetries = 3;

  console.log("\n>>> GOPAY (semi-otomatis) - linking via Midtrans Snap <<<");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n   [-- GoPay attempt ${attempt}/${maxRetries} --]`);

    const auto = await autoFillGoPay(page).catch((err) => {
      console.warn(`   [!] Auto-fill GoPay: ${err.message} — lanjut manual`);
      return false;
    });
    if (!auto) {
      console.log("    MODE MANUAL:");
      console.log("    1. Isi nomor HP GoPay (+62...) di halaman Midtrans");
      console.log("    2. Isi PIN kalau diminta");
    }
    console.log("    3. Buka aplikasi GoPay → approve/link akun");
    console.log("    4. Tunggu balik otomatis ke Scribd (bot deteksi sukses)\n");

    try {
      const ok = await driveGoPayStages(page, timeout);
      if (ok) return true;
    } catch (err) {
      if (err.message === "GOPAY_ALREADY_LINKED") {
        console.log(`   [!] GOPAY_ALREADY_LINKED — retry ${attempt}/${maxRetries}`);
        if (attempt < maxRetries) continue;
        throw new Error("GoPay sudah terhubung ke akun lain (max retries exceeded)");
      }
      if (/Browser ditutup|error payment/i.test(err.message)) throw err;
      throw new Error("Browser ditutup oleh user");
    }
    throw new Error("Timeout menunggu linking GoPay");
  }
}

function pageLooksError(source) {
  const low = source.toLowerCase();
  return (config.error_contains ?? []).some((k) => low.includes(k.toLowerCase()));
}

function saveResult(row) {
  const file = join(__dirname, config.results_file || "results-scribd.jsonl");
  appendFileSync(file, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");
}

async function registerOne(account, index) {
  L.title(`Akun #${index + 1}: ${account.name}`);

  let attempt = 0;
  const maxRetries = config.max_retries_per_account ?? 2;
  let captchaRestarts = 0;
  const rcfg = captchaRestartCfg();

  let lastUsedEmail = "";
  let lastUsedPassword = "";
  let lastUsedProvider = "";

  while (attempt < maxRetries) {
    attempt++;
    let session = null;

    try {
      console.log(`\n--- Attempt ${attempt} ---`);
      const tempBox = await createTempEmail(config);
      const email = tempBox.email;
      const password = genPassword();
      lastUsedEmail = email;
      lastUsedPassword = password;
      lastUsedProvider = tempBox.provider;

      const noBotTouch = config.captcha_safe?.no_bot_touch_signup === true;
      const manualTrialClick = config.captcha_safe?.manual_entry_click !== false;

      console.log("\n── FLOW ──");
      console.log("  Engine: Camoufox (anti-detect Firefox profile)");
      console.log("  Bot : buka Scribd");
      if (manualTrialClick) {
        console.log("  Kamu: klik trial link sendiri");
      } else {
        console.log("  Bot : klik trial link");
      }
      if (isManualFormFill()) {
        console.log("  Kamu: isi email + password + captcha + Continue");
      } else {
        console.log("  Bot : isi email + password + klik Continue");
        console.log("  Kamu: captcha saja");
      }
      console.log("  Bot : checkout + pilih plan → GoPay");
      console.log("  Bot : isi nomor + PIN GoPay otomatis");
      console.log("  Kamu: captcha + approve GoPay di aplikasi\n");

      // Retry launch browser (fingerprint random kadang cacat → error screenX)
      let lastLaunchErr = null;
      for (let li = 1; li <= 3; li++) {
        try {
          session = await createCamoufoxBrowser(config, __dirname);
          lastLaunchErr = null;
          break;
        } catch (err) {
          lastLaunchErr = err;
          console.warn(`   [!] Launch browser gagal (coba ${li}/3): ${err.message}`);
          await destroyCamoufoxBrowser(session, config).catch(() => {});
          session = null;
          await sleep(1500);
        }
      }
      if (lastLaunchErr) throw lastLaunchErr;
      let page = session.page;

      console.log("[1] Bot buka halaman Scribd...");
      const entryUsed = await goToSignupViaTrialLink(session, { email, password });
      page = session.page;
      console.log(`   Entry: ${entryUsed}`);

      if (noBotTouch) {
        console.log("[2] Signup 100% manual selesai — bot lanjut otomasi...");
      } else if (isManualFormFill()) {
        console.log("[2] Kamu isi form + captcha (bot tidak sentuh form)...");
        await waitForManualSignup(page, email, password);
      } else {
        console.log("[2] Bot isi email + password otomatis...");
        await autoFillSignupForm(page, email, password);
        console.log("[3] Bot klik Continue otomatis...");
        const continueClicked = await clickSignupContinue(page);
        if (!continueClicked) {
          console.log("   [!] Tombol Continue tak bisa diklik bot — klik manual di browser");
        }
        console.log("[3b] Kamu: captcha saja (klik Continue lagi jika masih ada)...");
        await waitForManualContinue(page);
      }
      const postSignupUrl = page.url();
      console.log(`   Post-signup: ${postSignupUrl}`);

      const alreadyCheckout = /\/checkout/i.test(postSignupUrl);

      if (alreadyCheckout) {
        console.log("[4] Sudah di /checkout — skip verifikasi");
      } else if (await needsEmailVerification(page)) {
        console.log("[4] Verifikasi email...");
        await handleEmailVerification(session, tempBox);
        page = session.page;
      } else {
        console.log("[4] Verifikasi tidak perlu");
      }

      L.step(5, "Checkout — GoPay");
      const paymentMethod = await goThroughCheckoutFlow(page);

      if (paymentMethod === "gopay") {
        L.step(6, "GoPay — isi nomor + PIN, approve di aplikasi");
        await waitForManualGoPay(page);
      }
      await sleep(1500);

      const url = page.url();
      const source = await page.evaluate(() => document.body.innerText).catch(() => "");

      if (pageLooksError(source)) {
        throw new Error("Halaman menunjukkan error payment/signup");
      }

      const success = pageLooksSuccess(source, url);
      const result = {
        name: account.name,
        email,
        password,
        email_provider: tempBox.provider,
        payment_method: paymentMethod,
        status: success ? "success" : "unknown",
        url,
        engine: "camoufox",
      };

      saveResult(result);
      if (success) L.ok(`BERHASIL — ${email} / ${password}`);
      else L.warn(`SELESAI (cek manual) — ${email}`);
      L.dim(`  Saved → ${config.results_file}`);

      console.log("\n   [DEBUG MODE] Proses selesai atau berhenti. Browser TIDAK AKAN ditutup otomatis.");
      console.log("   -> Silakan tutup jendela browser secara manual untuk melanjutkan ke akun berikutnya.\n");
      while (true) {
        try {
          await page.title();
          await sleep(2000);
        } catch {
          break;
        }
      }

      await destroyCamoufoxBrowser(session, config);
      return result;
    } catch (err) {
      console.error(`   Gagal: ${err.message}`);

      // Captcha/Cloudflare tak selesai → ULANG OTOMATIS (email + fingerprint baru)
      const restartable =
        (err.message === "CAPTCHA_UNSOLVED" || err.message === "CLOUDFLARE_BLOCKED") &&
        rcfg.enabled &&
        captchaRestarts < rcfg.maxRestarts;
      if (restartable) {
        captchaRestarts++;
        attempt--; // jangan makan jatah retry akun
        console.log(
          `   ↻ ULANG OTOMATIS (${captchaRestarts}/${rcfg.maxRestarts}) — browser + email baru...\n`
        );
        await destroyCamoufoxBrowser(session, config).catch(() => {});
        session = null;
        await sleep(2500);
        continue;
      }

      if (session && session.page) {
        console.log("\n   [DEBUG MODE] Terjadi error. Browser dibiarkan terbuka untuk debug.");
        console.log("   -> Silakan tutup jendela browser secara manual jika sudah selesai mengecek.\n");
        while (true) {
          try {
            await session.page.title();
            await sleep(2000);
          } catch {
            break;
          }
        }
      }
      
      await destroyCamoufoxBrowser(session, config);
      if (attempt < maxRetries) {
        console.log(`   Retry dalam ${config.retry_delay_ms}ms...`);
        await sleep(config.retry_delay_ms ?? 8000);
      }
    }
  }

  const fail = {
    name: account.name,
    email: lastUsedEmail,
    password: lastUsedPassword,
    email_provider: lastUsedProvider,
    status: "failed",
    engine: "camoufox",
  };
  saveResult(fail);
  return fail;
}

async function main() {
  const accounts = loadAccounts();

  console.log(`\n${C.b}${C.cyan}┌─────────────────────────────────────┐${C.r}`);
  console.log(`${C.b}${C.cyan}│  Scribd Auto Trial — GoPay Only     │${C.r}`);
  console.log(`${C.b}${C.cyan}│  Camoufox • Midtrans Snap           │${C.r}`);
  console.log(`${C.b}${C.cyan}└─────────────────────────────────────┘${C.r}`);
  L.info(`Akun   : ${accounts.length}  (run_count di config-scribd.json)`);
  L.info(`Hasil  : ${config.results_file}`);
  L.dim(`Browser: Camoufox / ${config.browser?.camoufox?.os || "windows"} fingerprint`);

  let ok = 0;
  for (let i = 0; i < accounts.length; i++) {
    const res = await registerOne(accounts[i], i);
    if (res.status === "success" || res.status === "unknown") ok++;
    if (i < accounts.length - 1) {
      await sleep(config.delay_between_accounts_ms ?? 10000);
    }
  }

  console.log(`\n${ok ? C.green : C.yellow}${C.b} Selesai — ${ok}/${accounts.length} diproses. Cek ${config.results_file} ${C.r}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
