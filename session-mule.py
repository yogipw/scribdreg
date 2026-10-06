"""Helper browser untuk scribd-api.js (Camoufox, lolos FullStory).

Mode auth:
  python session-mule.py auth [timeout]
  Buka /oauth/signup, tunggu URL /u/signup.
  Cetak {"url","cookies","landed"}.

Mode checkout:
  python session-mule.py checkout "<callback_url>" '<cookies>' "<ctoken>" [timeout]
  Buka callback (inject cookie), tunggu /checkout, lalu di dalam halaman:
  POST csrf_token -> POST cart -> GET configs -> POST create-subscription.
  Cetak {"url","cookies","landed","csrf","cart","pk","client_secret"}.

Mode finish:
  python session-mule.py finish "<finish_url>" '<cookies>' '<markers_json>' [timeout]
  Buka finish URL, tunggu /home, cek teks sukses.
  Cetak {"url","cookies","landed","ok","snippet"}.

Exit 0 = sukses. Exit 2 = gagal (detail ke stderr + envelope stdout).
"""

import asyncio
import json
import os
import re
import sys
import uuid

from camoufox.async_api import AsyncCamoufox

HEADLESS = os.environ.get("MULE_HEADLESS", "").lower() in ("1", "true", "yes")


def say(msg: str) -> None:
    print(f"SESSION-MULE: {msg}", flush=True, file=sys.stderr)


async def wait_url(page, marker: str, timeout: float) -> str:
    deadline = asyncio.get_event_loop().time() + timeout
    last_beat = 0.0
    cur = ""
    while asyncio.get_event_loop().time() < deadline:
        try:
            cur = page.url or ""
        except Exception:
            break
        now = asyncio.get_event_loop().time()
        if now - last_beat > 10:
            say(f"posisi: {cur[:110]}")
            last_beat = now
        if marker in cur:
            return cur
        await asyncio.sleep(2)
    return ""


CHECKOUT_JS = """async ([ctoken, browserUuid]) => {
  const j = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify(body),
    });
    return {status: r.status, data: await r.json().catch(() => null)};
  };
  const href = location.href;
  const csrf = await j('/csrf_token', {href});
  const csrfToken = csrf.data && csrf.data.csrf_token;
  if (!csrfToken) return {error: 'csrf gagal: ' + JSON.stringify(csrf).slice(0, 200)};
  const H = {'Content-Type': 'application/json', 'Accept': 'application/json',
             'x-csrf-token': csrfToken, 'x-requested-with': 'XMLHttpRequest'};
  const cartR = await fetch('/checkout/cart', {method: 'POST', headers: H, body: JSON.stringify({
    product_handle: 65,
    metadata: JSON.stringify({context: 'pmp', action: 'start_trial', logged_in: false,
                              platform: 'web', browser_uuid: browserUuid}),
  })});
  const cart = {status: cartR.status, data: await cartR.json().catch(() => null)};
  if (cart.status !== 200 || !cart.data || cart.data.status !== 200) {
    return {error: 'cart gagal: ' + JSON.stringify(cart).slice(0, 300), csrf: csrfToken};
  }
  const cfgR = await fetch('/checkout/payments_configs?view=web', {headers: {'Accept': 'application/json'}});
  const cfg = await cfgR.json().catch(() => null);
  let pk = null;
  try { pk = JSON.stringify(cfg).match(/"publishableKey"\\s*:\\s*"(pk_[^"]+)"/)[1]; } catch (e) { pk = null; }
  const subR = await fetch('/payments/billing/create-subscription', {method: 'POST', headers: H, body: JSON.stringify({
    confirmation_token_id: ctoken, view: 'web',
  })});
  const sub = {status: subR.status, data: await subR.json().catch(() => null)};
  if (!sub.data || !sub.data.client_secret) {
    return {error: 'create-subscription gagal: ' + JSON.stringify(sub).slice(0, 300),
            csrf: csrfToken, cart: cart.data, pk};
  }
  return {csrf: csrfToken, cart: cart.data, pk, client_secret: sub.data.client_secret};
}"""


SNAP_CHARGE_JS = """async ([snap]) => {
  const r = await fetch(`/snap/v2/transactions/${snap}/charge`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
    body: JSON.stringify({payment_type: 'gopay', tokenization: 'true', promo_details: null}),
  });
  return {status: r.status, data: await r.json().catch(() => null)};
}"""

SNAP_STATUS_JS = """async ([snap]) => {
  const r = await fetch(`/snap/v1/transactions/${snap}/status`, {
    headers: {'Accept': 'application/json'},
  });
  return {status: r.status, data: await r.json().catch(() => null)};
}"""


async def snap_ready(page, timeout: float = 20.0) -> None:
    await asyncio.sleep(8)
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            ok = await page.evaluate(
                "() => !!(window.snap || document.querySelector('script[src*=snap]'))"
            )
            if ok:
                return
        except Exception:
            pass
        await asyncio.sleep(2)


async def run_checkout(page, ctoken: str) -> dict:
    browser_uuid = str(uuid.uuid4())
    try:
        return await page.evaluate(CHECKOUT_JS, [ctoken, browser_uuid])
    except Exception as exc:
        return {"error": f"evaluate gagal: {str(exc)[:200]}"}


CAP_JS = """(() => {
  window.__cap = [];
  const keep = (url, status, body) => {
    try {
      if (/\\/snap\\/(v3\\/accounts|v2\\/transactions|v1\\/transactions)/.test(url)) {
        window.__cap.push({url, status, body: String(body || '').slice(0, 4000)});
      }
    } catch (e) {}
  };
  const _f = window.fetch;
  window.fetch = function (u, o) {
    return _f.apply(this, arguments).then((r) => {
      try {
        const url = typeof u === 'string' ? u : (u && u.url) || '';
        r.clone().text().then((t) => keep(url, r.status, t)).catch(() => {});
      } catch (e) {}
      return r;
    });
  };
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this._url = u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    this.addEventListener('load', function () {
      try { keep(this._url, this.status, this.responseText); } catch (e) {}
    });
    return _send.apply(this, arguments);
  };
})();"""

async def snaplink_uidrive(page, phone: str, timeout: float = 90.0) -> dict:
    try:
        await page.wait_for_selector(
            ".phone-number-input input, input[type='tel']", timeout=30000
        )
    except Exception:
        return {"status": 0, "data": {"error": "phone input tak ketemu"}}
    try:
        inp = page.locator(".phone-number-input input, input[type='tel']").first
        await inp.click(timeout=10000)
        await inp.press_sequentially(phone, delay=90)
        await asyncio.sleep(1.5)
        filled = await inp.input_value()
        say(f"nomor terisi: {filled[:4]}***{filled[-2:] if len(filled) > 2 else ''}")
        if re.sub(r"\D", "", filled) != phone:
            await inp.fill(phone)
            await asyncio.sleep(1.0)
    except Exception as exc:
        return {"status": 0, "data": {"error": f"isi nomor gagal: {str(exc)[:120]}"}}

    deadline = asyncio.get_event_loop().time() + timeout
    clicked = False
    beats = 0
    while asyncio.get_event_loop().time() < deadline:
        try:
            cur = page.url or ""
        except Exception:
            break
        m = re.search(r"[?&]reference=([0-9a-f-]{36})", cur or "")
        if m:
            return {"status": 201,
                    "data": {"activation_link_url": cur, "reference": m.group(1)}}
        try:
            cap = await page.evaluate(
                "() => (window.__cap || []).filter("
                "e => /accounts.*linking/.test(e.url)).slice(-1)[0] || null"
            )
        except Exception:
            cap = None
        if cap:
            try:
                body = json.loads(cap.get("body") or "{}")
            except Exception:
                body = {"raw": (cap.get("body") or "")[:200]}
            st = cap.get("status") or 0
            if st == 201:
                ref = body.get("activation_link_url", "")
                mm = re.search(r"[?&]reference=([0-9a-f-]{36})", ref)
                return {"status": 201,
                        "data": {"activation_link_url": ref,
                                 "reference": mm.group(1) if mm else ""}}
            s = json.dumps(body)
            if st == 406 or re.search(r"already linked", s, re.IGNORECASE):
                return {"status": 406, "data": {"error": "account already linked"}}
            if st and st not in (200, 201):
                return {"status": st, "data": body}
        try:
            txt = await page.evaluate(
                "() => (document.body ? document.body.innerText : '').slice(0, 2000)"
            )
        except Exception:
            txt = ""
        if re.search(r"already linked", txt or "", re.IGNORECASE):
            return {"status": 406, "data": {"error": "account already linked (teks UI)"}}
        beats += 1
        if beats % 3 == 0:
            say(f"watch: url={cur[:80]} | teks={((txt or '').replace(chr(10), ' ')[:150])}")
        if not clicked:
            for sel in (".button-cta button", "button:has-text('Hubungkan')",
                        "button:has-text('Link')", "button[type='submit']"):
                try:
                    btn = page.locator(sel).first
                    if await btn.is_visible(timeout=2000):
                        dis = await btn.evaluate(
                            "(el) => !!(el.disabled || el.classList.contains('disabled') "
                            "|| el.classList.contains('inactive'))"
                        )
                        if not dis:
                            await btn.click(timeout=5000)
                            say(f"klik tombol [{sel}]")
                            clicked = True
                            break
                except Exception:
                    continue
            if not clicked:
                await asyncio.sleep(3)
                continue
        await asyncio.sleep(2)
    try:
        cur = page.url or ""
    except Exception:
        cur = ""
    try:
        await page.screenshot(path="dbg_snaplink.png")
        say("screenshot: dbg_snaplink.png")
    except Exception:
        pass
    try:
        btns = await page.evaluate(
            """() => [...document.querySelectorAll('button')].filter(
                 el => el.offsetParent !== null).map(
                 el => (el.innerText || '').trim().slice(0, 40)
                   + (el.disabled ? ' [disabled]' : '')).slice(0, 12)"""
        )
        say(f"tombol visible: {btns}")
    except Exception:
        pass
    return {"status": 0, "data": {"error": f"timeout (url: {cur[:100]})"}}


async def run_snap_mode(mode: str, args: list) -> int:
    if mode == "snaplink":
        snap = args[0] if len(args) > 0 else ""
        phone = args[1] if len(args) > 1 else ""
        timeout = int(args[2]) if len(args) > 2 else 90
        inject = []
        if not snap or not phone:
            say("snaplink butuh snap + phone")
            return 2
    else:
        snap = args[0] if len(args) > 0 else ""
        try:
            inject = json.loads(args[1]) if len(args) > 1 else []
        except Exception:
            inject = []
        timeout = int(args[2]) if len(args) > 2 else 150
        phone = ""
        if not snap:
            say("snapcharge butuh snap")
            return 2
    url = f"https://app.midtrans.com/snap/v4/redirection/{snap}"

    say(f"mode={mode}, headless={HEADLESS}, buka snap...")
    async with AsyncCamoufox(headless=HEADLESS) as browser:
        ctx = await browser.new_context()
        try:
            await ctx.add_init_script(CAP_JS)
        except Exception:
            pass
        if inject:
            try:
                await ctx.add_cookies(inject)
                say(f"inject {len(inject)} cookie")
            except Exception as exc:
                say(f"inject cookie gagal: {str(exc)[:100]}")
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as exc:
            say(f"goto lambat ({str(exc)[:120]}), lanjut...")
        await snap_ready(page)
        cookies = []
        try:
            cookies = await ctx.cookies()
        except Exception:
            pass

        if mode == "snaplink":
            result = await snaplink_uidrive(page, phone, timeout)
            envelope = {"linking": result, "cookies": cookies}
            try:
                envelope["cookies"] = await ctx.cookies()
            except Exception:
                pass
            print(json.dumps(envelope), flush=True)
            st = result.get("status")
            say(f"linking UI-drive selesai status={st}")
            return 0 if st == 201 else 2

        try:
            charge = await page.evaluate(SNAP_CHARGE_JS, [snap])
        except Exception as exc:
            charge = {"status": 0, "data": {"error": str(exc)[:200]}}
        envelope = {"charge": charge, "settled": False, "cookies": cookies}
        if charge.get("status") not in (200, 201):
            print(json.dumps(envelope), flush=True)
            say(f"charge HTTP {charge.get('status')}")
            return 2
        say("charge OK, poll status di halaman...")
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                st = await page.evaluate(SNAP_STATUS_JS, [snap])
                tstat = (st.get("data") or {}).get("transaction_status", "")
                say(f"status: {tstat or st.get('status')}")
                if tstat == "settlement":
                    envelope["settled"] = True
                    envelope["status_data"] = st.get("data")
                    break
                if tstat in ("deny", "cancel", "expire", "failure"):
                    envelope["status_data"] = st.get("data")
                    break
            except Exception as exc:
                say(f"poll error: {str(exc)[:100]}")
            await asyncio.sleep(4)
        try:
            envelope["cookies"] = await ctx.cookies()
        except Exception:
            pass
        print(json.dumps(envelope), flush=True)
        say(f"selesai settled={envelope['settled']}")
        return 0


async def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "callback"
    if mode in ("snaplink", "snapcharge"):
        return await run_snap_mode(mode, sys.argv[2:])
    inject = []
    out = {"url": "", "cookies": [], "landed": False}

    if mode == "auth":
        url = "https://www.scribd.com/oauth/signup"
        timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 90
        marker = "/u/signup"
        ctoken = ""
        markers = []
    elif mode == "checkout":
        url = sys.argv[2] if len(sys.argv) > 2 else ""
        try:
            inject = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
        except Exception:
            inject = []
        ctoken = sys.argv[4] if len(sys.argv) > 4 else ""
        timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 90
        marker = "/checkout"
        markers = []
        if not url or not ctoken:
            say("checkout butuh callback URL + ctoken")
            return 2
    elif mode == "finish":
        url = sys.argv[2] if len(sys.argv) > 2 else ""
        try:
            inject = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
        except Exception:
            inject = []
        try:
            markers = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
        except Exception:
            markers = []
        timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 90
        marker = "/home"
        ctoken = ""
        if not url:
            say("finish butuh URL")
            return 2
    else:
        say(f"mode tidak dikenal: {mode}")
        return 2
      

    say(f"mode={mode}, headless={HEADLESS}, buka browser...")
    async with AsyncCamoufox(headless=HEADLESS) as browser:
        ctx = await browser.new_context()
        if inject:
            try:
                await ctx.add_cookies(inject)
                say(f"inject {len(inject)} cookie")
            except Exception as exc:
                say(f"inject cookie gagal: {str(exc)[:100]}")
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as exc:
            say(f"goto lambat ({str(exc)[:120]}), lanjut tunggu URL...")
        landed = await wait_url(page, marker, timeout)
        await asyncio.sleep(2)
        try:
            cur_url = page.url or ""
        except Exception:
            cur_url = ""
        cookies = []
        try:
            cookies = await ctx.cookies()
        except Exception:
            pass
        envelope = {"url": cur_url if not landed else landed,
                    "cookies": cookies, "landed": bool(landed)}
        if not landed:
            print(json.dumps(envelope), flush=True)
            say(f"gagal (url terakhir: {cur_url[:110]})")
            return 2
        say(f"mendarat: {landed[:90]}")

        if mode == "checkout":
            say("jalanin csrf -> cart -> configs -> create-subscription di halaman...")
            result = await run_checkout(page, ctoken)
            envelope.update(result)
            try:
                envelope["cookies"] = await ctx.cookies()
            except Exception:
                pass
            print(json.dumps(envelope), flush=True)
            if result.get("error") or not result.get("client_secret"):
                say(f"gagal: {str(result.get('error'))[:200]}")
                return 2
            say("checkout chain OK (client_secret dapat)")
            return 0

        if mode == "finish":
            snippet = ""
            try:
                snippet = await page.evaluate(
                    "() => (document.body ? document.body.innerText : '').slice(0, 600)"
                )
            except Exception:
                pass
            low = (snippet or "").lower()
            ok = any(str(m).lower() in low for m in (markers or [])) if markers else True
            envelope["ok"] = ok
            envelope["snippet"] = snippet
            print(json.dumps(envelope), flush=True)
            say(f"finish ok={ok}")
            return 0 if ok else 2

        print(json.dumps(envelope), flush=True)
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
