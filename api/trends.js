/**
 * Sterrenstof Trendradar — /api/trends
 *
 * Haalt de dagelijkse trending searches voor Nederland op uit de OFFICIËLE
 * Google Trends RSS-feed (een echt, stabiel databestand — geen gescrapete
 * pagina). Genereert er per klant een inhaak-invalshoek bij via Claude.
 *
 * Niets wordt verzonnen: geen feed = lege lijst met eerlijke melding.
 *
 * Vereist: ACCESS_KEY, ANTHROPIC_API_KEY (env vars, zoals /api/generate).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
// Google Trends RSS kent meerdere endpoint-vormen; we proberen ze op volgorde.
const TRENDS_URLS = [
  "https://trends.google.com/trends/trendingsearches/daily/rss?geo=NL",
  "https://trends.google.com/trending/rss?geo=NL&hl=nl",
  "https://trends.google.nl/trends/trendingsearches/daily/rss?geo=NL",
  "https://trends.google.com/trending/rss?geo=NL",
];

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  // Snelle route-check in de browser: GET zonder toegangscode bevestigt dat de functie bestaat
  if (req.method === "GET" && !req.headers["x-access-key"]) {
    return res.status(200).json({ ok: true, endpoint: "trends", hint: "Gebruik POST met x-access-key om trends op te halen." });
  }
  if (!process.env.ACCESS_KEY) {
    return res.status(500).json({ error: "ACCESS_KEY ontbreekt in de Vercel environment variables" });
  }
  if (String(req.headers["x-access-key"] || "").trim() !== String(process.env.ACCESS_KEY).trim()) {
    return res.status(401).json({ error: "Ongeldige toegangscode" });
  }

  try {
    // 1) Officiële trends-feed ophalen
    const trends = await fetchTrends();
    if (!trends.length) {
      return res.status(200).json({ trends: [], note: "Geen trending onderwerpen gevonden in de Google Trends-feed." });
    }

    // 2) Optioneel: per klant een inhaak-invalshoek genereren
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const raw = (body && body.client) || null;
    let client = null;
    if (raw && raw.name) {
      client = {
        name: String(raw.name).slice(0, 120).trim(),
        sector: String(raw.sector || "").slice(0, 160).trim(),
      };
    }

    if (!client || !process.env.ANTHROPIC_API_KEY) {
      // Zonder klant of key: alleen de kale trends teruggeven
      return res.status(200).json({ trends: trends.map((t) => ({ ...t, invalshoek: "" })) });
    }

    const top = trends.slice(0, 8);
    const lijst = top.map((t, i) => `${i + 1}. ${t.titel}${t.verkeer ? " (" + t.verkeer + ")" : ""}`).join("\n");
    const prompt = `Dit zijn de trending zoekopdrachten in Nederland vandaag (Google Trends):
${lijst}

Bedrijf: ${client.name}${client.sector ? " — " + client.sector : ""}

Geef voor ELK trending onderwerp een korte inhaak-invalshoek: hoe zou dit merk hier met social content op kunnen inspelen? Concreet, mag speels of licht humoristisch, passend bij de sector. Als een onderwerp zich totaal niet leent, geef dan een lege string voor "invalshoek".

MERKVEILIG: geef GEEN invalshoek bij onderwerpen over rampen, ongevallen, overlijden, ziekte, oorlog, misdaad of politiek beladen zaken — dan "invalshoek": "" en "ongeschikt": true.

Antwoord met ALLEEN geldige JSON, geen andere tekst:
{"items":[{"titel":"exacte trending term","invalshoek":"","ongeschikt":false}]}`;

    let angles = {};
    try {
      const txt = await callClaude(prompt);
      angles = parseAny(txt);
    } catch (e) { /* invalshoeken mislukt: kale trends blijven bruikbaar */ }

    const byTitle = {};
    (Array.isArray(angles.items) ? angles.items : []).forEach((a) => {
      if (a && a.titel) byTitle[String(a.titel).toLowerCase().trim()] = a;
    });

    const out = top.map((t) => {
      const a = byTitle[t.titel.toLowerCase().trim()] || {};
      return {
        titel: t.titel,
        verkeer: t.verkeer || "",
        url: t.url || "",
        invalshoek: a.ongeschikt ? "" : (typeof a.invalshoek === "string" ? a.invalshoek : ""),
      };
    });

    return res.status(200).json({ trends: out });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Onbekende serverfout" });
  }
};

// ---- Google Trends RSS ophalen en parsen (meerdere varianten proberen) ----
async function fetchTrends() {
  for (const url of TRENDS_URLS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
        },
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const parsed = parseTrendsXml(xml);
      if (parsed.length) return parsed;
    } catch (e) {
      /* volgende variant proberen */
    } finally {
      clearTimeout(t);
    }
  }
  return [];
}

function parseTrendsXml(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const titel = pick(b, "title");
    if (!titel) continue;
    const verkeer = pick(b, "ht:approx_traffic");
    // eerste nieuwslink als bron-URL, indien aanwezig
    const url = pick(b, "ht:news_item_url");
    items.push({
      titel: decodeEntities(titel),
      verkeer: verkeer ? decodeEntities(verkeer) : "",
      url: url ? decodeEntities(url) : "",
    });
    if (items.length >= 12) break;
  }
  return items;
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ---- Claude-call (geen websearch nodig; puur tekstredactie) ----
async function callClaude(prompt) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API-fout");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function parseAny(text) {
  let clean = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("Geen leesbaar antwoord");
  const end = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}
