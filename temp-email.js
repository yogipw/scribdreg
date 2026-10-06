import { sleep } from "./lib/camoufox-browser.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const LINK_PATTERNS = [
  /https?:\/\/[^\s"'<>]*auth\.scribd\.com[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]*scribd\.com[^\s"'<>]*(?:verify|confirm|callback|oauth)[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]+/gi,
];

const PROVIDERS = {
  async tempmaillol() {
    const res = await fetch("https://api.tempmail.lol/generate", {
      headers: FETCH_HEADERS,
    });
    if (!res.ok) throw new Error(`tempmail.lol HTTP ${res.status}`);
    const data = await res.json();
    if (!data.address) throw new Error("tempmail.lol response invalid");
    const [login, domain] = data.address.split("@");
    return { email: data.address, login, domain, provider: "tempmail.lol", token: data.token };
  },

  async guerrilla() {
    const res = await fetch(
      "https://api.guerrillamail.com/ajax.php?f=get_email_address",
      { headers: FETCH_HEADERS }
    );
    if (!res.ok) throw new Error(`guerrilla HTTP ${res.status}`);
    const data = await res.json();
    if (!data.email_addr) throw new Error("guerrilla response invalid");
    const [login, domain] = data.email_addr.split("@");
    return {
      email: data.email_addr,
      login,
      domain,
      provider: "guerrillamail",
      sid: data.sid_token,
    };
  },

  async mailgw() {
    const domainsRes = await fetch("https://api.mail.gw/domains", {
      headers: FETCH_HEADERS,
    });
    const text = await domainsRes.text();
    if (!text) throw new Error("mail.gw response kosong");
    const domainsData = JSON.parse(text);
    const domain = domainsData["hydra:member"]?.[0]?.domain;
    if (!domain) throw new Error("mail.gw domain kosong");

    const login = `nf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${login}@${domain}`;
    const pass = Math.random().toString(36).slice(2) + "A1!";

    const accRes = await fetch("https://api.mail.gw/accounts", {
      method: "POST",
      headers: { ...FETCH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ address: email, password: pass }),
    });
    if (!accRes.ok) throw new Error(`mail.gw account HTTP ${accRes.status}`);

    return { email, login, domain, provider: "mail.gw", password: pass };
  },
};

export async function createTempEmail(config = {}) {
  const cfg = config.temp_email ?? {};
  if (cfg.enabled === false) return null;

  const order = cfg.providers ?? ["tempmaillol", "guerrilla", "mailgw"];
  let lastErr;

  for (const name of order) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      const box = await fn();
      console.log(`   Temp email (${box.provider}): ${box.email}`);
      return box;
    } catch (err) {
      lastErr = err;
      console.warn(`   Provider ${name} gagal: ${err.message}`);
    }
  }

  throw lastErr ?? new Error("Semua provider temp email gagal");
}

function decodeHtml(text = "") {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function extractVerificationLink(text = "") {
  const decoded = decodeHtml(text);
  const candidates = [];

  for (const pattern of LINK_PATTERNS) {
    const matches = decoded.match(pattern) ?? [];
    for (let link of matches) {
      link = link.replace(/[),.;]+$/, "");
      if (/scribd\.com|auth\.scribd/i.test(link)) {
        candidates.push(link);
      }
    }
  }

  const ranked = candidates.sort((a, b) => {
    const score = (url) =>
      (/verify|confirm|callback|oauth/i.test(url) ? 10 : 0) +
      (/auth\.scribd/i.test(url) ? 5 : 0);
    return score(b) - score(a);
  });

  return ranked[0] ?? null;
}

async function fetchInbox(box) {
  if (box.provider === "tempmail.lol") {
    const res = await fetch(
      `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(box.token)}`,
      { headers: FETCH_HEADERS }
    );
    if (!res.ok) throw new Error(`tempmail.lol inbox HTTP ${res.status}`);
    const data = await res.json();
    return (data.emails ?? []).map((m) => ({
      subject: m.subject ?? "",
      body: `${m.subject ?? ""}\n${m.body ?? ""}\n${m.html ?? ""}`,
      from: m.from ?? "",
    }));
  }

  if (box.provider === "guerrillamail") {
    const res = await fetch(
      `https://api.guerrillamail.com/ajax.php?f=check_email&sid_token=${encodeURIComponent(box.sid)}&seq=0`,
      { headers: FETCH_HEADERS }
    );
    if (!res.ok) throw new Error(`guerrilla inbox HTTP ${res.status}`);
    const data = await res.json();
    const list = data.list ?? [];
    const out = [];

    for (const item of list.slice(0, 5)) {
      const detailRes = await fetch(
        `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(item.mail_id)}&sid_token=${encodeURIComponent(box.sid)}`,
        { headers: FETCH_HEADERS }
      );
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      out.push({
        subject: detail.mail_subject ?? item.mail_subject ?? "",
        body: `${detail.mail_subject ?? ""}\n${detail.mail_body ?? ""}`,
        from: detail.mail_from ?? item.mail_from ?? "",
      });
    }
    return out;
  }

  if (box.provider === "mail.gw") {
    const auth = Buffer.from(`${box.email}:${box.password}`).toString("base64");
    const res = await fetch("https://api.mail.gw/messages", {
      headers: { ...FETCH_HEADERS, Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`mail.gw inbox HTTP ${res.status}`);
    const data = await res.json();
    const out = [];

    for (const item of (data["hydra:member"] ?? []).slice(0, 5)) {
      const msgRes = await fetch(item["@id"] ?? `https://api.mail.gw/messages/${item.id}`, {
        headers: { ...FETCH_HEADERS, Authorization: `Basic ${auth}` },
      });
      if (!msgRes.ok) continue;
      const msg = await msgRes.json();
      const html = Array.isArray(msg.html)
        ? msg.html.map((p) => p).join("\n")
        : msg.html ?? "";
      out.push({
        subject: msg.subject ?? "",
        body: `${msg.subject ?? ""}\n${msg.intro ?? ""}\n${msg.text ?? ""}\n${html}`,
        from: msg.from?.address ?? "",
      });
    }
    return out;
  }

  return [];
}

export async function pollVerificationLink(box, options = {}) {
  const timeout = options.timeout_ms ?? 120000;
  const interval = options.interval_ms ?? 5000;
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    const messages = await fetchInbox(box);
    for (const msg of messages) {
      const blob = `${msg.subject}\n${msg.body}`;
      if (!/scribd|verify|confirm/i.test(blob)) continue;
      const link = extractVerificationLink(blob);
      if (link) {
        console.log(`   Link verifikasi ditemukan (${msg.subject || "no subject"})`);
        return link;
      }
    }
    await sleep(interval);
  }

  throw new Error("Email verifikasi Scribd tidak diterima dalam batas waktu");
}