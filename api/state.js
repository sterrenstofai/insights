/**
 * Sterrenstof Trendradar — /api/state
 *
 * Gedeelde opslag van de radar-data (klanten, rapporten, curatie) in Supabase,
 * zodat alle teamleden dezelfde data zien, op elk apparaat.
 *
 * GET  → haalt de gedeelde state op
 * POST → slaat de gedeelde state op (last-write-wins)
 *
 * Vereiste environment variables in Vercel:
 *  - ACCESS_KEY                : dezelfde toegangscode als /api/generate
 *  - SUPABASE_URL              : bijv. https://xxxx.supabase.co
 *  - SUPABASE_SERVICE_ROLE_KEY : de service_role key (Settings → API)
 *
 * Benodigde tabel (eenmalig aanmaken via Supabase SQL Editor):
 *
 *   create table if not exists radar_state (
 *     id text primary key,
 *     data jsonb,
 *     updated_at timestamptz default now()
 *   );
 *   alter table radar_state enable row level security;
 *
 * (RLS aan zonder policies = dicht voor de buitenwereld;
 *  de service_role key hieronder mag er wél bij.)
 */

const ROW_ID = "main";
const MAX_BYTES = 4 * 1024 * 1024; // 4MB veiligheidslimiet

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (!process.env.ACCESS_KEY) {
    return res.status(500).json({ error: "ACCESS_KEY ontbreekt in de Vercel environment variables" });
  }
  if ((req.headers["x-access-key"] || "") !== process.env.ACCESS_KEY) {
    return res.status(401).json({ error: "Ongeldige toegangscode" });
  }
  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !KEY) {
    return res.status(500).json({ error: "SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt in de Vercel environment variables" });
  }
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };

  try {
    if (req.method === "GET") {
      const r = await fetch(
        `${SUPA}/rest/v1/radar_state?id=eq.${ROW_ID}&select=data,updated_at`,
        { headers }
      );
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).json({ error: "Supabase-fout bij ophalen: " + t.slice(0, 200) });
      }
      const rows = await r.json();
      return res.status(200).json({
        state: rows[0] ? rows[0].data : null,
        updated_at: rows[0] ? rows[0].updated_at : null,
      });
    }

    if (req.method === "POST") {
      const st = req.body && req.body.state;
      if (!st || typeof st !== "object") {
        return res.status(400).json({ error: "Geen geldige state meegegeven" });
      }
      const payload = JSON.stringify({
        id: ROW_ID,
        data: st,
        updated_at: new Date().toISOString(),
      });
      if (payload.length > MAX_BYTES) {
        return res.status(413).json({ error: "State te groot voor opslag (verwijder oude rapporten)" });
      }
      const r = await fetch(`${SUPA}/rest/v1/radar_state`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: payload,
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).json({ error: "Supabase-fout bij opslaan: " + t.slice(0, 200) });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Alleen GET of POST toegestaan" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Onbekende serverfout" });
  }
};
