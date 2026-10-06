# SNIFF API — Scribd Trial GoPay (full HTTP)

Sumber: `sniff-20260930-012738.jsonl` (663 baris, hasil 1x alur manual
01:27:46 → 01:32:28, ~5 menit, sukses sampai `/home`).
Akun sampel: `xapiv94376@caps7.com` (temp email, **tanpa** verifikasi email —
langsung ke checkout). Order: `699826601`. Charge Rp1 settlement.

```
[1] SIGNUP (Auth0)          www.scribd.com/oauth/signup
                              -> auth.scribd.com/authorize?... (302)
                              -> auth.scribd.com/u/signup?state=... (200, form)
                              -> [MANUAL: Turnstile captcha]
                              -> POST /u/signup (302)
                              -> /authorize/resume?state= (302)
                              -> www.scribd.com/oauth/callback?code= (302, set session)
                              -> www.scribd.com/checkout?metadata= (200)
[2] CHECKOUT (server)       POST /csrf_token -> {csrf_token}
                            POST /checkout/cart {product_handle:65} -> cart
                            GET  /checkout/payments_configs?view=web -> stripe pk_live
[3] STRIPE (client API)     GET  elements/sessions (deferred_intent subscription, amount 0, idr, card+gopay)
                            POST confirmation_tokens {payment_method_data[type]=gopay} -> ctoken_
                            POST /payments/billing/create-subscription {confirmation_token_id} -> seti_ secret
                            POST setup_intents/<id>/confirm -> next_action.redirect_to_url
                              (https://pm-redirects.stripe.com/authorize/acct_.../sa_nonce_...)
[4] MIDTRANS SNAP           GET pm-redirects URL -> 302 app.midtrans.com/snap/v4/redirection/<SNAP>
                            POST snap/v3/accounts/<SNAP>/linking {type, country_code, phone}
                              201 -> {activation_link_url (reference=...), PENDING}
                              406 -> {"error_messages":["account already linked"]} => GANTI NOMOR / UNLINK
[5] GOPAY LINKING           POST gwa/v1/linking/validate-reference {reference_id}
                            POST gwa/v1/linking/user-consent {reference_id}
                            [MANUAL: OTP dari SMS/WhatsApp]
                            POST gwa/v1/linking/validate-otp {reference_id, otp}
                              -> {next_action: linking-validate-pin,
                                  challenge: {client_id (...-MGUPA), challenge_id,
                                              redirect_uri (pin-web-client...)}}
                            POST customer/api/v1/users/pin/tokens/nb {challenge_id, client_id, pin}
                              -> {token: JWT pin_token}
                            POST gwa/v1/linking/validate-pin {reference_id, token}
                              -> {next_action: linking-success,
                                  redirect_url: snap/v3/callback/gopay/linking/...?success=true}
[6] GOPAY CHARGE (Rp1)      POST snap/v2/transactions/<SNAP>/charge
                              {payment_type:gopay, tokenization:true}
                              -> 201 {gopay_verification_link_url (reference=A12...),
                                      finish_redirect_url, finish_200_redirect_url}
                            GET  gwa/v1/payment/validate?reference_id=<A12...>
                            POST gwa/v1/payment/confirm?reference_id=<A12...> {payment_instructions:[]}
                              -> challenge baru (client_id ...-GWC, challenge_id)
                            POST customer pin/tokens/nb (pin + challenge baru) -> JWT
                            POST gwa/v1/payment/process?reference_id=<A12...>
                              {challenge:{type:GOPAY_PIN_CHALLENGE, value:{pin_token}}}
                              -> {next_action: payment-success,
                                  redirect_url: snap/v3/callback/gopay/charge/<SNAP>?success=true}
                            GET  snap/v1/transactions/<SNAP>/status -> settlement (poll)
[7] SELESAI                 GET finish_200_redirect_url (pm-redirects return)
                              -> www.scribd.com/payments/billing/stripe/complete?... (302)
                              -> /payments/redirect_after_checkout?... (302)
                              -> /?order=699826601 -> /home
```

---

## 1. Signup — Auth0 Universal Login

```
GET https://www.scribd.com/oauth/signup
  -> 302 https://auth.scribd.com/authorize
       ?client_id=gyc7yrfzsvJfiwylseau8cx9uVaoaNSP
       &response_type=code
       &redirect_uri=https://www.scribd.com/oauth/callback
       &state=<32hex>                 (acak tiap run)
       &scope=openid+profile+email+offline_access
       &nway_experiment=require_email_verification_and_mfa
       &ui_locales=en
       &correlation_id=<uuid>
       &audience=https://api.scribd.com/api/v3/
       &ext-ul-analytics=enabled
       &screen_hint=signup
  -> 302 https://auth.scribd.com/u/signup?state=hKFo... (transaction state, ikut cookie)
  -> 200 HTML form (127 KB, ada Turnstile widget)
```

### CAPTCHA (titik manual #1 — PALING KERAS)

- Widget: **Cloudflare Turnstile**, sitekey `0x4AAAAAACwSuI5jPtwnNwc5`
  (milik Auth0 UL, render=explicit).
- Challenge interaktif (`/cdn-cgi/challenge-platform/h/b/fo/...`, proof-of-work +
  checkbox). Di sniff: challenge 01:28:05, user selesai, POST 01:30:47 (~2.5 mnt).
- Hasil: token `cf-turnstile-response`, format `1.xxxxx...` (single-use, ~5 mnt).

```
POST https://auth.scribd.com/u/signup?state=<state>   (form-urlencoded)
  state=<state>
  &passwordPolicy.isFlexible=false
  &strengthPolicy=good
  &complexityOptions.minLength=10
  &email=<email>
  &password=<password, min 10 char>
  &captcha=<TURNSTILE_TOKEN>          <- dari solve manual
  -> 302 /authorize/resume?state=... -> 302 /oauth/callback?code=...&state=<32hex>
  -> 302 /checkout?metadata={"context":"pmp","action":"start_trial",
        "logged_in":false,"platform":"web","browser_uuid":"<uuid>"}
```

Tanpa token valid: POST ditolak (ulangi widget). **Replay full-API butuh token
fresh tiap akun** — urutan di `scribd-api.js`:
1. solver service (`turnstile_solver.provider`: `2captcha` pakai
   `TurnstileTaskProxyless` websiteURL=/u/signup URL, websiteKey=`0x4AAAA...`;
   `nopecha` pakai POST `/token/` type=turnstile lalu poll),
2. fallback jendela Camoufox (`captcha-token.py`, cookie sesi di-inject,
   token diambil otomatis),
3. fallback `--paste-token` (paste manual).
Catatan: NopeCHA menyarankan proxy-nya sama dengan IP submit token
(Auth0 bisa cek kecocokan IP). Kalau token solver ditolak Auth0,
jatuh ke fallback browser.

## 2. Checkout — API server Scribd (butuh cookie sesi OAuth)

```
POST https://www.scribd.com/csrf_token        (JSON {"href": "<url halaman>"})
  -> {"csrf_token": "<64char>"}
  Header wajib utk POST berikut:  x-csrf-token: <token>
  + accept, origin https://www.scribd.com, referer halaman, x-requested-with

POST https://www.scribd.com/checkout/cart      (JSON)
  {"product_handle": 65,
   "metadata": "{\"context\":\"pmp\",\"action\":\"start_trial\",\"logged_in\":false,
                 \"platform\":\"web\",\"browser_uuid\":\"<uuid>\"}"}
  -> {"data":{"cart":{"wordUserId":1028667863,
        "items":[{"name":"Premium","productHandle":65,"type":"subscription",
                   "billingPeriods":[{..."price":{"amountInCents":70000,
                     "currency":"IDR"},"defaultTrialDays":30,...}]}],
        "pricing":{...},"zeroAmount":"Rp0",...}},"status":200}

GET https://www.scribd.com/checkout/payments_configs?view=web
  -> {... "stripeConfig":{"paymentElementMode":"subscription",
        "publishableKey":"pk_live_51PsB5HP5U6Cf0VJbRlTah0lxhrA98JVMUneMeVfCN5Nq20uXYU7sM5uXZKOe2iQolCDA5J1lKM0974rcDNo9U5d000sIvsUogG",
        ...}}
```

Catatan: `product_handle=65` (Premium Monthly IDR), trial 30 hari, Rp70.000/bln.
`browser_uuid`: uuid acak tiap run.

## 3. Stripe — client API publik (key = pk_live di atas)

```
GET https://api.stripe.com/v1/elements/sessions
  ?deferred_intent[mode]=subscription
  &deferred_intent[amount]=0
  &deferred_intent[currency]=idr
  &deferred_intent[setup_future_usage]=off_session
  &deferred_intent[payment_method_types][0]=card
  &deferred_intent[payment_method_types][1]=gopay
  &currency=idr&key=<pk_live>&elements_init_source=stripe.elements
  &referrer_host=www.scribd.com&stripe_js_id=<uuid>&locale=en
  &browser_timezone=Asia/Singapore&type=deferred_intent
  -> {..., "config_id":"83aefe98-...", "elements_session_id":"elements_session_...",
        "account_id":"acct_1PsB5HP5U6Cf0VJb", ...}

POST https://api.stripe.com/v1/confirmation_tokens   (form-urlencoded)
  payment_method_data[type]=gopay
  &payment_method_data[payment_user_agent]=stripe.js/...;stripe-js-v3/...;payment-element;deferred-intent
  &payment_method_data[referrer]=https://www.scribd.com
  &payment_method_data[time_on_page]=<ms>
  &payment_method_data[client_attribution_metadata][client_session_id]=<stripe_js_id>
  &...[merchant_integration_source]=elements & ...[subtype]=payment-element
  &...[version]=2021 & ...[payment_intent_creation_flow]=deferred
  &...[payment_method_selection_flow]=merchant_specified
  &...[elements_session_id]=<dari sessions> & ...[elements_session_config_id]=<config_id>
  &...[guid]=<uuid>&...[muid]=<uuid>&...[sid]=<uuid>
  &payment_method_data[radar_options][hcaptcha_token]=   (kosong — invisible lolos)
  &key=<pk_live>
  -> {"id":"ctoken_...","payment_method_preview":{"gopay":{},"type":"gopay"},...}

POST https://www.scribd.com/payments/billing/create-subscription   (JSON + x-csrf-token)
  {"confirmation_token_id":"ctoken_...","view":"web"}
  -> {"setup":true,"client_secret":"seti_..._secret_..."}

POST https://api.stripe.com/v1/setup_intents/<seti_id>/confirm   (form-urlencoded)
  return_url=https://www.scribd.com/payments/billing/stripe/complete?view=web
  &payment_method_data[type]=gopay&... (atribusi sama, key=<pk_live>)
  -> {"status":"requires_action",
      "payment_method":"pm_...",
      "next_action":{"redirect_to_url":{
        "return_url":"https://www.scribd.com/payments/billing/stripe/complete?view=web",
        "url":"https://pm-redirects.stripe.com/authorize/acct_1PsB5HP5U6Cf0VJb/sa_nonce_..."}}}
```

hCaptcha Stripe (sitekey `463b917e-...`, `24ed0064-...`): invisible.
`confirmation_tokens` lolos TANPA field `radar_options[hcaptcha_token]`
(JANGAN kirim kosong — Stripe balas `parameter_invalid_empty`).
`setup_intents/.../confirm` di browser membawa `radar_options[hcaptcha_token]`
asli (JWT P1_); replay tanpa field ini — kalau Stripe menuntut, fallback:
solve hCaptcha via 2captcha lalu isi field tersebut. Wajib ada di confirm:
`client_secret` (full), `expected_payment_method_type=gopay`,
blok `client_context[...]`, `client_attribution_metadata[...]` top-level,
`mandate_data[customer_acceptance][type]=online`.

## 4. Midtrans Snap (WAJIB via browser — butuh X-Snap-Signature dari JS snap)

Semua endpoint `app.midtrans.com/snap/...` menolak fetch langsung dengan
`401 Missing X-Snap-Signature header` (signature dihitung JS snap yang
obfuscated + device fingerprint; in-page `fetch()` mentah ikut ditolak
karena interceptor hanya di HTTP-client milik snap.js).
Pola `scribd-api.js` (`session-mule.py` mode `snaplink`): buka
`/snap/v4/redirection/<SNAP>` di browser, ketik nomor digit-by-digit
(`press_sequentially` — `fill()` instan tidak mengupdate React state),
klik tombol UI milik snap, lalu baca hasil dari fetch/XHR yang di-intercept
(`add_init_script` wrap sebelum load): linking 201 → reference (halaman
consent muncul TANPA navigasi!), 406 → "account already linked".

```
GET <pm-redirects url>  (jangan follow JS, ambil 302)
  -> 302 https://app.midtrans.com/snap/v4/redirection/<SNAP:uuid>

GET https://app.midtrans.com/snap/v1/transactions/<SNAP>            (info/long-poll)
POST https://app.midtrans.com/snap/v1/promos/<SNAP>/search          (boleh skip)
GET https://app.midtrans.com/snap/v3/experiment?id=<SNAP>           (boleh skip)

POST https://app.midtrans.com/snap/v3/accounts/<SNAP>/linking       (JSON)
  {"type":"gopay","country_code":"62","phone_number":"<tanpa 62/0>"}
  -> 201 {"status_code":"201",
          "activation_link_url":"https://merchants-gws-app.gopayapi.com/app/authorize?reference=<REF>&target=gwc",
          "account_status":"PENDING"}
  -> 406 {"error_messages":["account already linked"]}
        => nomor sudah terhubung ke Scribd lain: GANTI NOMOR, atau user UNLINK
           di aplikasi GoPay (Settings > Connected Apps) lalu retry.
```

SNAP token kedaluwarsa ~15 menit (`expiry_time`). Semua step GoPay harus
selesai sebelum itu.

## 5. GoPay linking (gopayapi.com — JSON biasa, replayable)

```
POST https://gwa.gopayapi.com/v1/linking/validate-reference
  {"reference_id":"<REF>"}
  -> {"success":true,"data":{"reference_id":"<REF>","next_action":"linking-user-consent",...}}

POST https://gwa.gopayapi.com/v1/linking/user-consent
  {"reference_id":"<REF>"}
  -> {"success":true,"data":{"next_action":"linking-validate-otp",...}}
  # OTP dikirim ke SMS/WhatsApp nomor itu

[MANUAL: baca OTP dari HP]  (titik manual #2)

POST https://gwa.gopayapi.com/v1/linking/validate-otp
  {"reference_id":"<REF>","otp":"<6 digit>"}
  -> {"success":true,"data":{"next_action":"linking-validate-pin",
      "challenge":{"action":{"type":"GOPAY_PIN_CHALLENGE",
        "value":{"client_id":"<...-MGUPA>","challenge_id":"<uuid>",
                 "redirect_uri":"https://pin-web-client.gopayapi.com/auth/pin/verify?...",
                 "callbackUrl":"https://merchants-gws-app.gopayapi.com/payment/provider-redirect?reference=<REF>&action=linking-validate-pin",...}}}}}
  # OTP salah -> error, ulangi (max coba wajar, jangan brute-force)

POST https://customer.gopayapi.com/api/v1/users/pin/tokens/nb
  {"challenge_id":"<uuid>","client_id":"<...-MGUPA>","pin":"<6 digit dari config>"}
  -> {"success":true,"data":{"token":"<JWT RS256: pin_verified:true, scope:GOPAY_ONLINE_LINKING>"}}
  # JWT kedaluwarsa ~2 menit (iat/exp) — langsung pakai.

POST https://gwa.gopayapi.com/v1/linking/validate-pin
  {"reference_id":"<REF>","token":"<JWT>"}
  -> {"success":true,"data":{"next_action":"linking-success",
      "redirect_url":"https://app.midtrans.com/snap/v3/callback/gopay/linking/<id>?success=true"}}
```

## 6. GoPay charge Rp1 (tokenisasi)

```
POST https://app.midtrans.com/snap/v2/transactions/<SNAP>/charge
  {"payment_type":"gopay","tokenization":"true","promo_details":null}
  -> 201 {"transaction_id":"...","order_id":"ufpi_...","gross_amount":"1",
          "transaction_status":"pending",
          "gopay_verification_link_url":"https://merchants-gws-app.gopayapi.com/app/challenge?reference=<A12...>",
          "finish_redirect_url":"https://pm-redirects.stripe.com/return/acct_...?order_id=...&status_code=201&...",
          "finish_200_redirect_url":"https://pm-redirects.stripe.com/return/acct_...?order_id=...&status_code=200&transaction_status=capture"}

GET https://gwa.gopayapi.com/v1/payment/validate?reference_id=<A12...>
  -> {...,"total_amount":{"value":1,"currency":"IDR"},"next_action":"payment-details",...}

POST https://gwa.gopayapi.com/v1/payment/confirm?reference_id=<A12...>
  {"payment_instructions":[]}
  -> {"success":true,"data":{"next_action":"payment-validate-pin",
      "challenge":{"action":{"type":"GOPAY_PIN_CHALLENGE",
        "value":{"client_id":"<...-GWC>","challenge_id":"<uuid>"}}},...}}
  # NOTE: client_id beda dari linking (GWC vs MGUPA) — ambil dari response,
  # jangan hardcode.

POST https://customer.gopayapi.com/api/v1/users/pin/tokens/nb
  {"pin":"<6 digit>","challenge_id":"<uuid>","client_id":"<...-GWC>"}
  -> {"token":"<JWT scope:CREATE_PAYMENT>"}

POST https://gwa.gopayapi.com/v1/payment/process?reference_id=<A12...>
  {"challenge":{"type":"GOPAY_PIN_CHALLENGE","value":{"pin_token":"<JWT>"}}}
  -> {"success":true,"data":{"next_action":"payment-success",
      "redirect_url":"https://app.midtrans.com/snap/v3/callback/gopay/charge/<SNAP>?success=true"}}

GET https://app.midtrans.com/snap/v1/transactions/<SNAP>/status   (poll)
  -> {...,"transaction_status":"settlement",...}   # Rp1 settlement
```

## 7. Selesai (kembali ke Scribd)

```
GET <finish_200_redirect_url> (pm-redirects return)
  -> 302 https://www.scribd.com/payments/billing/stripe/complete?redirect_status=succeeded&setup_intent=seti_...&setup_intent_client_secret=...
  -> 302 https://www.scribd.com/payments/redirect_after_checkout?after_checkout_action_label=...&after_checkout_action_url=https://www.scribd.com/
  -> 302 https://www.scribd.com/?order=699826601
  -> 200 https://www.scribd.com/home   (trial aktif)
```

## 8. Captcha / risk-check — ringkasan

| # | Apa | Di mana | Status API |
|---|-----|---------|-----------|
| 1 | Cloudflare Turnstile (interaktif) | POST /u/signup (`captcha=`) | MANUAL — token fresh tiap akun (paste) |
| 2 | OTP SMS/WhatsApp GoPay | validate-otp | MANUAL — baca HP (paste) |
| 3 | hCaptcha invisible (Stripe) | confirmation/setup confirm | OTOMATIS (`hcaptcha_token=` kosong lolos) |
| 4 | Alibaba Captcha TRACELESS | GoPay web (InitCaptcha/UploadLog) | OTOMATIS (tanpa interaksi) |
| 5 | Device fingerprint (cloudauth-device) | GoPay web | OTOMATIS (boleh skip) |
| 6 | Cardinal/3DS songbird | Stripe | OTOMATIS |
| 7 | PIN GoPay | pin tokens nb | OTOMATIS (dari config) |

Abaikan (telemetri, tidak pengaruhi hasil): `*.stripe.com` r./m./q./b. (radar),
`merchant-ui-api`, `prodregistryv2.org`, `featureassets.org`,
`kg668dbov0.execute-api` (log), `snap-web-raccoon`/`gopay-web-raccoon` (events),
osano/fullstory/sentry/datadog, `gwc` static JS, applepay/googlepay asset.

## 9. Catatan replay

- Cookie: tiap host pegang jar sendiri (scribd, auth.scribd, stripe, midtrans,
  gopayapi). Jangan campur.
- PENTING: `GET www.scribd.com/oauth/signup` via fetch biasa dibalas HTTP 200
  halaman FullStory bot-check (`/_fs-ch-...`), BUKAN 302 — beda dari browser.
- PENTING 2: `state` oauth HARUS dari server (lewat `/oauth/signup` di browser,
  `session-mule.py` mode `auth`) + cookie sesi ikut. State generate-sendiri
  lolos Auth0 (code terbit!) tapi callback nyasar ke homepage — tidak ada
  konteks checkout.
- PENTING 3: semua endpoint `www.scribd.com` (document maupun XHR) kena
  FullStory bot-check kalau bukan dari browser asli — meski cookie lengkap.
  Pola `scribd-api.js`: browser (`session-mule.py`) untuk authorize,
  callback+csrf+cart+configs+create-subscription, dan finish-chain;
  fetch murni hanya untuk pihak ketiga (Auth0 POST, Stripe, Midtrans, GoPay).
- Header JSON GoPay/Midtrans: `Content-Type: application/json`,
  `Origin: https://app.midtrans.com` utk snap, UA browser biasa.
- Stripe: form-urlencoded + `Origin: https://www.scribd.com`.
- Scribd POST: `x-csrf-token` + `x-requested-with: XMLHttpRequest` + cookie sesi.
- UUID/session id Stripe (`stripe_js_id`, guid/muid/sid, `time_on_page`):
  generate fresh tiap run.
- Urutan ketat: signup > cart > configs > ctoken > create-sub >
  setup-confirm > snap > linking > otp > pin > charge > pin > status > complete.
- Trial/active check akhir: GET /home atau /account, cari teks sukses
  (`success_contains` di config).
```
