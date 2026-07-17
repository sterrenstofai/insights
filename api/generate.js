/**
 * Sterrenstof Trendradar — /api/generate
 *
 * Ontvangt klantgegevens, bouwt de prompts SERVER-SIDE (nooit client-side,
 * zie geleerde les uit AI Merk Spiegel), doet drie parallelle Anthropic-calls
 * met websearch en geeft één samengevoegd insight-rapport terug.
 *
 * Vereiste environment variables in Vercel:
 *  - ANTHROPIC_API_KEY : je Anthropic API-key
 *  - ACCESS_KEY        : zelfgekozen toegangscode (deel met Rajiv)
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Alleen POST toegestaan" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY ontbreekt in de Vercel environment variables" });
  }
  if (!process.env.ACCESS_KEY) {
    return res.status(500).json({ error: "ACCESS_KEY ontbreekt in de Vercel environment variables" });
  }
  if ((req.headers["x-access-key"] || "") !== process.env.ACCESS_KEY) {
    return res.status(401).json({ error: "Ongeldige toegangscode" });
  }

  // ---- input valideren en begrenzen (alleen klantgegevens, nooit prompts) ----
  const raw = (req.body && req.body.client) || {};
  const clean = (v, max) => String(v || "").replace(/[`]/g, "'").slice(0, max).trim();
  const cleanList = (v, maxItems, maxLen) =>
    (Array.isArray(v) ? v : []).slice(0, maxItems).map((s) => clean(s, maxLen)).filter(Boolean);

  const client = {
    name: clean(raw.name, 120),
    sector: clean(raw.sector, 160),
    site: clean(raw.site, 160),
    competitors: cleanList(raw.competitors, 4, 80),
    keywords: cleanList(raw.keywords, 8, 60),
    reviewSources: cleanList(raw.reviewSources, 4, 300),
  };
  if (!client.name) {
    return res.status(400).json({ error: "Klantnaam ontbreekt" });
  }

  // ---- prompts (server-side) ----
  const compList = client.competitors.join(", ") || "geen opgegeven";
  const kw = client.keywords.join(", ");
  const reviewSrc = client.reviewSources.join(", ");
  const vandaag = new Date().toLocaleDateString("nl-NL", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam",
  });

  const intro = `Je bent de research-engine van een monitoringstool. Vandaag is ${vandaag}.

Context:
- Bedrijf: ${client.name}${client.site ? " (" + client.site + ")" : ""}
- Sector/markt: ${client.sector || "onbekend"}
- Concurrenten om te monitoren: ${compList}
${reviewSrc ? "- Bekende reviewbronnen van dit bedrijf: " + reviewSrc : ""}
${kw ? "- Extra relevante thema's: " + kw : ""}

ALGEMENE REGELS:
- Doe websearches, focus op de afgelopen 7 dagen, liefst vandaag/gisteren.
- Rapporteer UITSLUITEND wat je daadwerkelijk in zoekresultaten vindt. Verzin NIETS. Geen resultaten voor een categorie = lege array.
- Elke insight bevat een echte bron (naam publicatie/site) en indien beschikbaar een URL.
- Schrijf in het Nederlands, zakelijk en to-the-point. "samenvatting" per item maximaal 20 woorden, "relevantie" maximaal 20 woorden.
- "prioriteit": jouw redactionele urgentie-inschatting: "hoog" (vraagt actie of aandacht vandaag), "middel" (relevant om te weten) of "laag" (achtergrond). Wees streng met "hoog".
- Antwoord met ALLEEN geldige JSON, geen andere tekst, geen markdown-codeblokken.`;

  const promptA = `${intro}

OPDRACHT DEEL 1 — zoek naar:
1. Recent nieuws over ${client.name} zelf (maximaal 3 items)
2. Actualiteiten en trends in de sector/markt (maximaal 2 items)

Exact dit JSON-formaat:
{
  "samenvatting": "2-3 zinnen: het belangrijkste van vandaag voor dit bedrijf",
  "nieuws": [{"titel":"","samenvatting":"","bron":"","url":"","relevantie":"","prioriteit":"hoog|middel|laag"}],
  "markt": [{"titel":"","samenvatting":"","bron":"","url":"","relevantie":"","prioriteit":"hoog|middel|laag"}]
}`;

  const promptR = `${intro}

OPDRACHT REVIEWS — zoek naar:
1. De meest recente INDIVIDUELE reviews over ${client.name}. ${reviewSrc ? "Zoek gericht op de opgegeven reviewbronnen (bijv. de platformnaam + bedrijfsnaam + reviews)." : "Zoek op reviewplatforms (Google, Trustpilot, branchespecifieke platforms)."} Geef de 3 meest recente reviews die je daadwerkelijk in de zoekresultaten vindt, elk als APART item: "datum" = de reviewdatum zoals vermeld, "titel" = korte typering, "samenvatting" = de kern van die ene review GEPARAFRASEERD (citeer niet letterlijk). Gebruik geen namen van reviewers.
2. Recente reviews van de concurrenten (${compList}) op dezelfde platforms, ter vergelijking (maximaal 2 items; mag een samenvattend beeld per concurrent zijn).
3. "reviewprofiel": indien vindbaar één regel met platform, gemiddelde score en totaal aantal reviews van ${client.name}. Verzin scores of aantallen NOOIT; niet gevonden = lege string.

Vind je geen individuele reviews, geef dan een lege array — verzin er GEEN.

Exact dit JSON-formaat:
{
  "reviewprofiel": "",
  "reviews": [{"bedrijf":"","type":"eigen|concurrent","datum":"","titel":"","samenvatting":"","bron":"","url":"","relevantie":"","prioriteit":"hoog|middel|laag"}]
}`;

  const promptC = `${intro}

OPDRACHT DEEL 2 — zoek naar:
1. Wat de concurrenten (${compList}) recent hebben gepubliceerd, gelanceerd of aangekondigd (maximaal 4 items)
2. INHAKERS (maximaal 3): algemene actualiteit en trending onderwerpen in Nederland van vandaag/deze week (zoek op grote nieuwssites zoals nu.nl en NOS) waar dit merk met social content op zou kunnen inspelen. Dit hoeft NIET uit de branche te komen — denk aan weer, sport, cultuur, feestdagen, luchtige landelijke gebeurtenissen.

Bij inhakers: het NIEUWSFEIT moet echt en gevonden zijn (met bron). De "invalshoek" (maximaal 20 woorden) is jouw creatieve contentsuggestie voor dit merk: concreet, mag speels of licht humoristisch, passend bij de sector. MERKVEILIG: haak NOOIT in op rampen, ongevallen, overlijden, ziekte, oorlog, misdaad of politiek beladen onderwerpen. Een inhaker is alleen "hoog" als het momentum vandaag is.

Sluit af met maximaal 3 "acties": concrete kansen of aanbevolen acties voor dit bedrijf op basis van wat je vond.

Exact dit JSON-formaat:
{
  "concurrentie": [{"concurrent":"","titel":"","samenvatting":"","bron":"","url":"","relevantie":"","prioriteit":"hoog|middel|laag"}],
  "inhakers": [{"titel":"","samenvatting":"","bron":"","url":"","invalshoek":"","prioriteit":"hoog|middel|laag"}],
  "acties": ["concrete kans of aanbevolen actie"]
}`;

  // ---- uitvoeren: drie parallelle calls, alles afwachten vóór de respons (Vercel-les) ----
  try {
    const results = await Promise.allSettled([
      callClaude(promptA),
      callClaude(promptR),
      callClaude(promptC),
    ]);
    if (results.every((r) => r.status === "rejected")) {
      const reason = results[0].reason && results[0].reason.message;
      return res.status(502).json({ error: reason || "Anthropic API niet bereikbaar" });
    }

    const parse = (r) => {
      try { return r.status === "fulfilled" ? parseAny(r.value) : {}; }
      catch (e) { return {}; }
    };
    const repA = parse(results[0]);
    const repR = parse(results[1]);
    const repC = parse(results[2]);

    const arr = (x) => (Array.isArray(x) ? x : []);
    const report = {
      samenvatting: typeof repA.samenvatting === "string" ? repA.samenvatting : "",
      nieuws: arr(repA.nieuws),
      markt: arr(repA.markt),
      reviews: arr(repR.reviews),
      reviewprofiel: typeof repR.reviewprofiel === "string" ? repR.reviewprofiel : "",
      concurrentie: arr(repC.concurrentie),
      inhakers: arr(repC.inhakers),
      acties: arr(repC.acties),
    };

    return res.status(200).json({ report });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Onbekende serverfout" });
  }
};

// ---- Anthropic-call met websearch ----
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
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API-fout");
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---- JSON-parsing met reparatie van afgebroken antwoorden ----
function parseAny(text) {
  let clean = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("Geen leesbaar rapport ontvangen");
  const end = clean.lastIndexOf("}");
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch (e) {
    return repairJson(clean.slice(start));
  }
}

/* Herstelt afgebroken JSON: knipt terug tot het laatste complete
   object/array-element en sluit alle nog openstaande haken. */
function repairJson(raw) {
  let inStr = false, escp = false, stack = [], candidates = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (escp) escp = false;
      else if (ch === "\\") escp = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") { stack.pop(); candidates.push(i); }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    const part = raw.slice(0, candidates[k] + 1);
    let st = [], ins = false, e2 = false;
    for (const ch of part) {
      if (ins) {
        if (e2) e2 = false;
        else if (ch === "\\") e2 = true;
        else if (ch === '"') ins = false;
        continue;
      }
      if (ch === '"') { ins = true; continue; }
      if (ch === "{" || ch === "[") st.push(ch);
      else if (ch === "}" || ch === "]") st.pop();
    }
    const closers = st.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
    try { return JSON.parse(part + closers); } catch (e) { /* volgende kandidaat */ }
  }
  throw new Error("Rapport was onvolledig en kon niet worden hersteld");
}
