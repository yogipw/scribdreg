import { createRequire } from "module";
import { existsSync, rmSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

const require = createRequire(import.meta.url);
const { Camoufox } = require("camoufox");

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(10, Math.floor(ms))));
}

export function randomDelay(min = 500, max = 1500) {
  const lo = Math.max(10, Math.floor(min));
  const hi = Math.max(20, Math.floor(max));
  return sleep(lo + Math.floor(Math.random() * Math.max(1, hi - lo)));
}

export function genPassword() {
  return `Sc${randomUUID().replace(/-/g, "").slice(0, 14)}!1`;
}

function wipeDir(path) {
  if (!existsSync(path)) return true;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    return !existsSync(path);
  } catch {
    return false;
  }
}

/** Resolve DataImpulse-style templates: {country} / {cc} */
function resolveProxyString(proxy, config = {}) {
  if (!proxy || typeof proxy !== "string") return proxy;
  const country = String(config.proxy_country || config.browser?.camoufox?.country || "us")
    .trim()
    .toLowerCase();
  return proxy
    .replaceAll("{country}", country)
    .replaceAll("{cc}", country)
    .replaceAll("{COUNTRY}", country.toUpperCase());
}

function parseProxy(proxy, config = {}) {
  if (!proxy) return undefined;
  if (typeof proxy === "object") return proxy;

  // http://user:pass@host:port  |  host:port  |  socks5://host:port
  // DataImpulse: user__cr.{country}:pass@gw.dataimpulse.com:823
  const raw = resolveProxyString(String(proxy).trim(), config);
  if (!raw) return undefined;

  try {
    const hasScheme = /^[a-z]+:\/\//i.test(raw);
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
    const out = { server };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: raw };
  }
}

const COMMON_WINDOWS = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [1600, 900],
];

function pickWindow(camoufoxCfg = {}) {
  if (camoufoxCfg.window) return camoufoxCfg.window;
  if (camoufoxCfg.random_window === false) return undefined;
  const list = camoufoxCfg.windows || COMMON_WINDOWS;
  return list[Math.floor(Math.random() * list.length)];
}

function resolveHumanize(camoufoxCfg = {}) {
  const h = camoufoxCfg.humanize;
  if (h === false || h === 0) return false;
  if (typeof h === "number") return h;
  if (h === true || h === undefined) return 2.5;
  return h;
}

export async function logFingerprint(page, label = "Fingerprint") {
  try {
    const fp = await page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      lang: navigator.language,
      langs: navigator.languages,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date().getTimezoneOffset(),
      cores: navigator.hardwareConcurrency,
      mem: navigator.deviceMemory || "n/a",
      webdriver: navigator.webdriver,
      screen: `${screen.width}x${screen.height} avail=${screen.availWidth}x${screen.availHeight} dpr=${window.devicePixelRatio}`,
      canvas2d: (() => {
        try {
          const c = document.createElement("canvas");
          c.width = 200; c.height = 30;
          const x = c.getContext("2d");
          x.fillText("fp-test", 10, 20);
          return c.toDataURL().length;
        } catch { return -1; }
      })(),
    }));
    console.log(`   [${label}] UA       : ${fp.ua}`);
    console.log(`   [${label}] Platform : ${fp.platform} | Lang: ${fp.lang} | TZ: ${fp.tz} (offset ${fp.tzOffset})`);
    console.log(`   [${label}] Cores/Mem: ${fp.cores}/${fp.mem} | Screen: ${fp.screen}`);
    console.log(`   [${label}] webdriver: ${String(fp.webdriver)} | canvas_len: ${fp.canvas2d}`);
    if (fp.webdriver === true) console.warn("   [!] navigator.webdriver=true — terdeteksi bot!");
    return fp;
  } catch (err) {
    console.warn(`   [${label}] gagal baca: ${err.message}`);
    return null;
  }
}

/**
 * Launch Camoufox (Firefox anti-detect) with a solid Windows fingerprint.
 * - Fresh BrowserForge fingerprint tiap run (ephemeral profile)
 * - GeoIP=true agar timezone/locale ikut exit IP (anti mismatch)
 * - Humanize cursor agar gerakan mouse natural
 * - Window/screen realistis ala laptop Windows
 * Returns { browser, context, page, profileDir }.
 */
export async function createCamoufoxBrowser(config = {}, projectDir = process.cwd()) {
  const browserCfg = config.browser ?? {};
  const camoufoxCfg = browserCfg.camoufox ?? {};

  const reuse = browserCfg.reuse_profile === true;
  const profilesRoot = resolve(projectDir, browserCfg.profiles_root || "profiles");
  const profileDir = reuse
    ? resolve(projectDir, browserCfg.profile_dir || "camoufox-profile")
    : undefined;

  if (!reuse) {
    // clear leftover persistent profiles from older runs
    wipeDir(resolve(projectDir, browserCfg.profile_dir || "camoufox-profile"));
    wipeDir(profilesRoot);
  }

  const proxy = parseProxy(config.proxy || camoufoxCfg.proxy, config);
  const headless = config.headless === true || camoufoxCfg.headless === true;
  const disableCoop = camoufoxCfg.disable_coop !== false;
  const humanize = resolveHumanize(camoufoxCfg);
  const windowSize = pickWindow(camoufoxCfg);

  const launchOpts = {
    os: camoufoxCfg.os || "windows",
    headless,
    humanize,
    // NOTE: camoufox-js 0.1.19 crash kalau locale array saat geoip=false
    // → pakai string "en-US" (aman di semua mode)
    locale: camoufoxCfg.locale || "en-US",
    block_webrtc: camoufoxCfg.block_webrtc !== false,
    block_images: camoufoxCfg.block_images ?? false,
    // Stripe/card iframes sometimes need COOP disabled for cross-origin clicks
    disable_coop: disableCoop,
    // Required by camoufox when disable_coop is on
    i_know_what_im_doing: disableCoop || Boolean(camoufoxCfg.i_know_what_im_doing),
    // GeoIP helps timezone/locale match the exit IP (needs outbound network).
    // Default: true hanya kalau pakai proxy; tanpa proxy pakai false agar
    // tidak gagal IP-lookup (jaringan restricted). Bisa override via config.
    geoip: camoufoxCfg.geoip ?? Boolean(proxy),
    screen: camoufoxCfg.screen || {
      minWidth: 1366,
      maxWidth: 1920,
      minHeight: 768,
      maxHeight: 1080,
    },
    firefox_user_prefs: {
      "dom.webdriver.enabled": false,
      useAutomationExtension: false,
      // Kurangi sinyal automation Firefox, tanpa merusak Camoufox spoof
      "dom.webnotifications.enabled": false,
      ...(camoufoxCfg.firefox_user_prefs || {}),
    },
    ...(camoufoxCfg.fingerprint ? { fingerprint: camoufoxCfg.fingerprint } : {}),
    ...(camoufoxCfg.addons ? { addons: camoufoxCfg.addons } : {}),
    ...(camoufoxCfg.fonts ? { fonts: camoufoxCfg.fonts } : {}),
    ...(proxy ? { proxy } : {}),
    ...(windowSize ? { window: windowSize } : {}),
    ...(camoufoxCfg.debug ? { debug: true } : {}),
    ...(profileDir ? { data_dir: profileDir } : {}),
  };

  console.log("   Engine     : Camoufox (Firefox anti-detect, BrowserForge fingerprint)");
  console.log(`   OS fingerprint: ${JSON.stringify(launchOpts.os)}`);
  console.log(`   Humanize   : ${launchOpts.humanize}`);
  console.log(`   Locale     : ${JSON.stringify(launchOpts.locale)}`);
  console.log(`   GeoIP      : ${launchOpts.geoip}`);
  if (windowSize) console.log(`   Window     : ${windowSize[0]}x${windowSize[1]}`);
  if (proxy) {
    const userHint = proxy.username ? proxy.username.replace(/.(?=.{4})/g, "*") : "";
    console.log(`   Proxy      : ${proxy.server}${userHint ? ` (user ${userHint})` : ""}`);
    console.log(`   Country    : ${config.proxy_country || "us"}`);
  }
  if (profileDir) console.log(`   Profile    : ${profileDir}`);
  else console.log("   Profile    : ephemeral (fresh fingerprint tiap akun)");

  // BrowserForge kadang generate fingerprint cacat (mis. screenX float) —
  // retry dengan fingerprint fresh tiap gagal, max 4x.
  let browserOrCtx = null;
  let lastErr = null;
  for (let li = 1; li <= 4 && !browserOrCtx; li++) {
    try {
      browserOrCtx = await Camoufox(launchOpts);
    } catch (err) {
      lastErr = err;
      // geoip:true needs reachable IP lookup; fall back without geoip
      if (launchOpts.geoip) {
        console.warn(`   [!] GeoIP gagal (${err.message}) — retry tanpa geoip`);
        launchOpts.geoip = false;
      } else {
        console.warn(`   [!] Launch gagal (coba ${li}/4): ${err.message}`);
      }
      await sleep(1000);
    }
  }
  if (!browserOrCtx) throw lastErr ?? new Error("Camoufox gagal launch");

  // Camoufox may return Browser or persistent BrowserContext
  let browser = null;
  let context = null;
  let page = null;

  if (typeof browserOrCtx.contexts === "function") {
    // Browser
    browser = browserOrCtx;
    context = await browser.newContext({ viewport: null });
    page = await context.newPage();
  } else if (typeof browserOrCtx.pages === "function") {
    // BrowserContext (persistent)
    context = browserOrCtx;
    const pages = context.pages();
    page = pages[0] || (await context.newPage());
    // ensure no forced mobile viewport
    try {
      await page.setViewportSize(null);
    } catch {
      // some builds ignore null — ok
    }
  } else {
    throw new Error("Camoufox return type tidak dikenali");
  }

  // Soft defaults — don't inject stealth JS (Camoufox already handles it)
  page.setDefaultTimeout((config.timeout_seconds ?? 20) * 1000);
  page.setDefaultNavigationTimeout(60000);

  // Clear any residual session if reusing profile
  try {
    if (reuse) await context.clearCookies();
  } catch {
    // ignore
  }

  // Verifikasi fingerprint langsung (UA / webdriver / TZ / screen)
  await logFingerprint(page, "Fingerprint");

  return {
    browser,
    context,
    page,
    profileDir: profileDir || null,
    engine: "camoufox",
  };
}

export async function destroyCamoufoxBrowser(session, config = {}) {
  if (!session) return;

  const { page, context, browser, profileDir } = session;

  try {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  } catch {
    // ignore
  }

  try {
    if (context) await context.close().catch(() => {});
  } catch {
    // ignore
  }

  try {
    if (browser) await browser.close().catch(() => {});
  } catch {
    // ignore
  }

  await sleep(400);

  const reuse = config.browser?.reuse_profile;
  if (profileDir && !reuse) {
    wipeDir(profileDir);
  }
}
