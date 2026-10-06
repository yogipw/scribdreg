"""Helper untuk scribd-api.js: buka halaman /u/signup Auth0 di Camoufox
(visible) DENGAN cookie sesi dari API flow, tunggu user solve Turnstile,
lalu cetak isi cf-turnstile-response ke stdout (baris terakhir).

Pakai:
  python captcha-token.py "<url>" '<cookies_json>' [timeout_detik]

cookies_json: [{"name": "...", "value": "...", "domain": "auth.scribd.com"}]
Exit 0 = token dapat. Exit 2 = timeout/gagal (node fallback ke paste manual).
"""

import asyncio
import json
import sys

from camoufox.async_api import AsyncCamoufox


def say(msg: str) -> None:
    print(f"CAPTCHA-BROWSER: {msg}", flush=True, file=sys.stderr)


async def main() -> int:
    url = sys.argv[1]
    cookies = json.loads(sys.argv[2])
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 300

    say("buka halaman signup...")
    async with AsyncCamoufox(headless=False) as browser:
        ctx = await browser.new_context()
        if cookies:
            await ctx.add_cookies(cookies)
        page = await ctx.new_page()
        await page.goto(url, wait_until="domcontentloaded")

        try:
            await page.wait_for_selector(
                "iframe[src*='challenges.cloudflare']", timeout=30000
            )
            say("widget Turnstile muncul — selesaikan captcha,")
            say("token diambil otomatis setelah centang hijau.")
        except Exception:
            say("widget tidak ketemu, tetap tunggu token...")

        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                token = await page.evaluate(
                    """() => {
                        const el = document.querySelector('[name=cf-turnstile-response]');
                        return el && el.value ? el.value : '';
                    }"""
                )
            except Exception:
                token = ""
            if token:
                print(token, flush=True)
                await asyncio.sleep(1)
                return 0
            await asyncio.sleep(2)

    say("timeout, token tidak didapat.")
    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
