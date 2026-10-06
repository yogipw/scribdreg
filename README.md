# Scribd Auto Trial — GoPay Only

Otomasi simpel daftar trial Scribd 30 hari via **GoPay (Midtrans Snap)** pakai **Camoufox** (Firefox anti-detect). Tidak pakai VCC/kartu.

> Proyek iseng — otomasi simpel aja. Mau dilanjut develop atau nggak terserah. Inti flow cuma: bikin 1 akun trial → lepas/hapus koneksi Scribd di aplikasi GoPay → ulangi.

## Fitur
- Buka Scribd → klik trial → isi email+password otomatis (temp email)
- Checkout → pilih plan Monthly → pilih GoPay → klik Start Trial → redirect Midtrans Snap
- Isi nomor HP + PIN GoPay otomatis (Midtrans 6 kotak PIN), stage driver: OTP manual → PIN → Back → Pay Now → Bayar Rp1 → PIN lagi
- Handle “Please use another phone number” → pause 30 detik suruh unlink GoPay
- Log terminal rapi pakai ANSI color + box header (no deps)

## Cara Pakai

```bash
npm install
# isi config dulu (lihat bawah)
npm run scribd
# atau: node scribd-register.js
```

1. Isi `config-scribd.json` bagian `gopay.phone` dan `gopay.pin` (tanpa +62, cth: `81234567890`, pin `123456`).
2. Tentukan jumlah akun: `run_count` di config (default 1).
3. Jalanin, selesaikan captcha manual kalau muncul, isi OTP manual dari SMS.
4. Approve linking di aplikasi GoPay kalau diminta.
5. Hasil kesimpan di `results-scribd.jsonl` — browser sengaja tidak auto-close, tutup manual untuk lanjut akun berikutnya.

## Konfigurasi penting

```json
"gopay": { "phone": "", "pin": "" },
"run_count": 1,
"results_file": "results-scribd.jsonl"
```

Kredensial di-repo sudah dikosongkan. Jangan commit nomor/pin asli.

## Alur (5 langkah di log)

```
[1] Buka Scribd
[2] Isi email+password
[3] Klik Continue + captcha manual
[4] Verifikasi email (temp inbox)
[5] Checkout GoPay
[6] Isi nomor+PIN → approve
```

## Tips GoPay (penting)

- 1 nomor GoPay = 1 akun Scribd terhubung. Kalau muncul error **“Please use another phone number”** bot akan pause 30 detik.
- **Solusi:** buka aplikasi GoPay → Settings → Connected Apps / Aplikasi Terhubung → **Hapus/Unlink Scribd** → bot auto-retry (max 3x).
- Atau: ganti nomor di `config-scribd.json` lalu ulangi.
- PIN yang diminta adalah PIN GoPay 6 digit, isi 2x di flow (awal linking + konfirmasi Rp1).

## Catatan

- Ini otomasi simpel, selector berbasis DOM Midtrans & Scribd yang bisa berubah sewaktu-waktu. Kalau UI berubah, update selector di `config-scribd.json` / `scribd-register.js`.
- VCC/kartu sudah dihapus total dari codebase. Kalau butuh, kembalikan dari git history.
- Log pakai ANSI escape — terlihat bagus di Windows Terminal / VS Code terminal. Di terminal jadul mungkin tanpa warna tapi tetap jalan.
- Lisensi: bebas pakai & modifikasi, risiko ditanggung sendiri.
