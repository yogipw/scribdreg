"""Sniff harness: buka Camoufox (headed), user input MANUAL semua,
semua request/response API tercatat ke sniff-<timestamp>.jsonl.

Cara pakai:
  1. python sniff-manual.py
  2. Di browser yang terbuka: lakukan ALUR MANUAL sampai akhir
     (trial link -> signup -> captcha -> verifikasi email ->
      checkout -> GoPay/Midtrans -> PIN/OTP -> sukses).
  3. Tutup browser kalau sudah selesai -> file sniff-*.jsonl jadi.
  4. Laporkan ke saya, saya analisis jadi SNIFF-API.md.

Field sensitif (password/PIN/OTP/nomor kartu) nilainya di-mask XXX,
nama field-nya tetap tercatat (perlu buat dokumentasi).
"""

import asyncio
import datetime
import json
import os
import re
import sys

from camoufox.async_api import AsyncCamoufox

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TS = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
OUT_FILE = os.path.join(BASE_DIR, f"sniff-{TS}.jsonl")

SKIP_TYPES = {"image", "media", "font", "stylesheet"}
MAX_BODY = 200_000

MASK_KEY_RE = re.compile(
    r"password|passwd|pin\b|otp|card.?num|pan\b|cvv|cvc|cvv2|secret",
    re.IGNORECASE,
)


def mask_value(key: str | None, value):
    if isinstance(value, str) and key and MASK_KEY_RE.search(key):
        if len(value) <= 2:
            return "**"
        return value[:1] + "X" * (len(value) - 2) + value[-1:]
    return value


def mask_obj(obj):
    if isinstance(obj, dict):
        return {k: mask_obj(v) if not MASK_KEY_RE.search(str(k)) else mask_value(k, v)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_obj(v) for v in obj]
    return obj


def mask_form(text: str) -> str:
    def repl(m):
        k, v = m.group(1), m.group(2)
        return f"{k}={mask_value(k, v)}" if MASK_KEY_RE.search(k) else m.group(0)
    return re.sub(r"([^=&?]+)=([^&]*)", repl, text)


def emit(rec: dict) -> None:
    rec["t"] = datetime.datetime.now().isoformat(timespec="milliseconds")
    with open(OUT_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


async def on_request(req) -> None:
    try:
        rtype = req.resource_type
    except Exception:
        rtype = "?"
    if rtype in SKIP_TYPES:
        return
    rec = {
        "dir": "REQ",
        "type": rtype,
        "method": req.method,
        "url": req.url,
    }
    try:
        headers = await req.all_headers()
        rec["headers"] = mask_obj(
            {k: v for k, v in headers.items()
             if k.lower() in ("content-type", "authorization", "x-csrf-token",
                              "x-requested-with", "origin", "referer", "accept",
                              "x-midtrans", "x-api-key")}
        )
    except Exception:
        pass
    try:
        post = req.post_data
        if post:
            ctype = (rec.get("headers", {}).get("content-type", "") or "").lower()
            if "json" in ctype:
                try:
                    rec["post_json"] = mask_obj(json.loads(post))
                except Exception:
                    rec["post"] = mask_form(post[:MAX_BODY])
            else:
                rec["post"] = mask_form(post[:MAX_BODY])
    except Exception:
        pass
    emit(rec)


async def on_response(resp) -> None:
    try:
        req = resp.request
        rtype = req.resource_type
    except Exception:
        return
    if rtype in SKIP_TYPES:
        return
    rec = {
        "dir": "RES",
        "type": rtype,
        "status": resp.status,
        "url": resp.url,
    }
    try:
        headers = await resp.all_headers()
        ctype = headers.get("content-type", "")
        rec["content_type"] = ctype
        if any(k in ctype.lower() for k in ("json", "text", "html", "javascript", "xml", "urlencoded")):
            body = await resp.text()
            if len(body) > MAX_BODY:
                body = body[:MAX_BODY] + f"...[TRUNCATED {len(body)}]"
            rec["body"] = body
        else:
            rec["body"] = f"<binary {ctype}>"
    except Exception as exc:
        rec["body"] = f"<unreadable: {exc}>"
    emit(rec)


async def main() -> None:
    print("=" * 64)
    print("SNIFF MANUAL — browser Camoufox (headed) akan terbuka.")
    print(f"Log: {OUT_FILE}")
    print()
    print("TUGAS KAMU (manual di browser):")
    print("  1. Klik trial link ('Download free for 30 days')")
    print("  2. Isi signup + selesaikan captcha")
    print("  3. Verifikasi email")
    print("  4. Checkout -> plan monthly -> GoPay")
    print("  5. Midtrans: nomor HP -> PIN -> OTP -> Back -> Pay Now -> Bayar")
    print("  6. Sampai sukses -> TUTUP browser")
    print("Lalu laporkan ke saya untuk dianalisis.")
    print("=" * 64)

    async with AsyncCamoufox(headless=False) as browser:
        page = await browser.new_page()
        page.on("request", lambda r: asyncio.ensure_future(on_request(r)))
        page.on("response", lambda r: asyncio.ensure_future(on_response(r)))
        await page.goto("https://www.scribd.com/", wait_until="domcontentloaded")
        print("Browser terbuka. Silakan lakukan alur manual sampai akhir...")
        print("(boleh buka tab baru; sniff berhenti saat SEMUA jendela ditutup)")
        done = asyncio.Event()
        browser.on("disconnected", lambda _b: done.set())
        await done.wait()

    print(f"\nSelesai. File sniff: {OUT_FILE}")
    try:
        n = sum(1 for _ in open(OUT_FILE, encoding="utf-8"))
        print(f"Total baris tercatat: {n}")
    except OSError:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nDibatalkan (Ctrl+C). File sniff tetap tersimpan.")
        sys.exit(0)
