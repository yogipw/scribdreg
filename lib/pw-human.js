import { sleep, randomDelay } from "./camoufox-browser.js";
import { setClipboard } from "./native-input.js";

/**
 * Klik human-like:
 * 1. scroll tengah layar → jeda acak → klik normal (timeout panjang,
 *    karena navigasi Auth0 sering bikin click "gantung")
 * 2. force click
 * 3. DOM .click() via evaluate (paling tahan overlay/navigasi)
 */
export async function humanClick(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(150, 350);
  try {
    await locator.click({ timeout: 6000 });
    return;
  } catch {
    // Klik navigasi (Link/Hubungkan/Bayar) sering bikin click "gantung"
    // padahal event sudah terkirim → kalau elemen sudah detached, BERHASIL.
    const gone = await locator.count().catch(() => 0);
    if (!gone) {
      await sleep(600);
      return;
    }
    // lanjut fallback
  }
  try {
    await locator.click({ force: true, timeout: 3000 });
    return;
  } catch {
    const gone = await locator.count().catch(() => 0);
    if (!gone) {
      await sleep(600);
      return;
    }
    // fallback terakhir (DOM click di bawah)
  }
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) throw new Error("humanClick: elemen hilang/tidak bisa diklik");
  await handle
    .evaluate((el) => {
      el.scrollIntoView({ block: "center" });
      el.click();
    })
    .catch(() => {});
  await sleep(400);
}

/** Dispatch event input/change agar form React/Auth0 sadar ada nilai baru. */
async function dispatchInputEvents(locator) {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return;
  await handle
    .evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur?.();
    })
    .catch(() => {});
}

/**
 * Ketik human-like: fokus → Ctrl+A → Backspace (clear ala manusia) →
 * ketik per karakter dengan jeda acak 60–160ms → Tab/blur biar
 * validasi Auth0 jalan.
 */
export async function humanType(locator, text, minDelay = 60, maxDelay = 160) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(150, 400);
  await locator.click({ timeout: 10000 });
  await sleep(150 + Math.floor(Math.random() * 200));

  // Clear ala manusia (bukan fill("") instan yang bot-like)
  await locator.press("Control+a").catch(() => {});
  await sleep(60 + Math.floor(Math.random() * 80));
  await locator.press("Backspace").catch(() => {});
  await sleep(100 + Math.floor(Math.random() * 150));

  // Ketik per karakter, jeda tiap karakter beda (tidak metronom)
  for (const ch of String(text)) {
    await locator.pressSequentially(ch, { delay: 0 }).catch(() => {});
    await sleep(minDelay + Math.floor(Math.random() * Math.max(1, maxDelay - minDelay)));
  }
  await sleep(150 + Math.floor(Math.random() * 200));
  await locator.press("Tab").catch(() => {});
  await sleep(120);
}

/**
 * Paste via clipboard OS + Ctrl+V.
 * Dipakai hanya kalau config explicitly minta; default form signup
 * sekarang mengetik (lebih manusiawi & tahan deteksi paste).
 */
export async function pasteField(locator, text) {
  setClipboard(text);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await randomDelay(150, 400);
  await locator.click({ timeout: 10000 });
  await sleep(150);
  await locator.press("Control+a").catch(() => {});
  await sleep(80);
  await locator.press("Control+v").catch(() => {});
  await sleep(300);

  const actual = await locator.inputValue().catch(() => "");
  if (actual === text) {
    await locator.press("Tab").catch(() => {});
    return;
  }
  // Fallback: ketik manusiawi
  await humanType(locator, text);
}

/**
 * Isi field dengan verifikasi nilai.
 * @param {object} opts - { paste:false } → ketik human-like (default).
 *   paste:true → coba paste dulu, fallback ketik.
 */
export async function fillField(locator, text, { paste = false } = {}) {
  if (paste) {
    await pasteField(locator, text);
  } else {
    await humanType(locator, text);
  }

  let actual = await locator.inputValue().catch(() => "");
  if (actual === text) return;

  // Last resort: Playwright fill + dispatch event manual (form React)
  await locator.fill(text).catch(() => {});
  await dispatchInputEvents(locator);
  await sleep(200);

  actual = await locator.inputValue().catch(() => "");
  if (actual !== text) {
    throw new Error(
      `Field tidak terisi (diharapkan ${text.length} karakter, terisi ${actual.length})`
    );
  }
}
