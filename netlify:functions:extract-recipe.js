// ═══════════════════════════════════════════════════════════════════════
// ReelRezepte – Netlify Serverless Function
// Datei: netlify/functions/extract-recipe.js
//
// Flow:
//   1. Frontend sendet POST { url: "https://instagram.com/reel/XYZ" }
//   2. Diese Function holt Metadaten via Instagram oEmbed API (kein API-Key nötig)
//   3. Caption + Thumbnail → Claude API → strukturiertes Rezept JSON
//   4. Fertig strukturiertes Rezept-Objekt zurück ans Frontend
//
// ENV-Variablen (in Netlify Dashboard setzen):
//   ANTHROPIC_API_KEY  → dein Claude API Key
// ═══════════════════════════════════════════════════════════════════════

exports.handler = async function (event, context) {

  // ── CORS Headers (für lokales Testen + Produktion) ──
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Input-Validierung ──
  let url;
  try {
    const body = JSON.parse(event.body || '{}');
    url = body.url?.trim();
    if (!url) throw new Error('Keine URL');
  } catch {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Ungültige Anfrage – bitte eine URL mitschicken.' })
    };
  }

  // ── Unterstützte Plattformen prüfen ──
  const isInstagram = url.includes('instagram.com');
  const isTikTok = url.includes('tiktok.com');

  if (!isInstagram && !isTikTok) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Nur Instagram- und TikTok-Links werden unterstützt.' })
    };
  }

  try {
    // ════════════════════════════════════════════════════════
    // SCHRITT 1: Metadaten via oEmbed holen
    // Instagram oEmbed gibt title (= Caption), thumbnail_url,
    // author_name zurück – kein Login nötig für öffentliche Posts.
    // ════════════════════════════════════════════════════════
    let caption = '';
    let thumbnailUrl = '';
    let authorName = '';

    try {
      let oembedUrl;
      if (isInstagram) {
        oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&fields=title,thumbnail_url,author_name`;
        // Hinweis: Instagram oEmbed benötigt seit 2020 einen Facebook App Token.
        // Alternativ: https://www.instagram.com/oembed/?url=... (inoffiziell, kann sich ändern)
        // Für den Start den inoffiziellen Endpoint verwenden:
        oembedUrl = `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}&omitscript=true`;
      } else {
        oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      }

      const oembedRes = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'ReelRezepte/1.0' }
      });

      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        caption = oembedData.title || '';
        thumbnailUrl = oembedData.thumbnail_url || '';
        authorName = oembedData.author_name || '';
      }
    } catch (oembedErr) {
      // oEmbed schlägt fehl → trotzdem weitermachen mit leerem Caption
      // Claude erkennt dann "kein Rezept gefunden"
      console.warn('oEmbed-Fehler:', oembedErr.message);
    }

    // ════════════════════════════════════════════════════════
    // SCHRITT 2: Claude API – Rezept extrahieren
    // ════════════════════════════════════════════════════════
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY nicht gesetzt');
    }

    const systemPrompt = `Du bist ein präziser Rezept-Extraktor für eine Koch-App.
Analysiere den gegebenen Instagram/TikTok-Post-Text und extrahiere das Rezept.

Antworte NUR mit einem validen JSON-Objekt – kein Markdown, keine Erklärungen.

JSON-Schema:
{
  "title": "Rezeptname auf Deutsch",
  "emoji": "passendes Emoji",
  "category": "pasta|fleisch|fisch|vegetarisch|vegan|backen|asiatisch|suppe|salat|sonstige",
  "dauer": "z.B. 30 Min",
  "portionen": "z.B. 4",
  "schwierigkeit": "Einfach|Mittel|Fortgeschritten",
  "zutaten": ["Zutat 1 mit Menge", "Zutat 2 mit Menge"],
  "schritte": ["Schritt 1", "Schritt 2"],
  "tags": ["tag1", "tag2", "tag3"],
  "hatRezept": true
}

Falls der Post KEIN Rezept enthält:
{ "hatRezept": false, "grund": "kurze Erklärung" }

Wichtig:
- Mengenangaben immer metrisch (g, ml, EL, TL)
- Schritte klar und verständlich auf Deutsch
- 3-6 relevante Tags (Küche, Hauptzutat, Zubereitungsart, Diät)`;

    const userMessage = caption
      ? `Extrahiere das Rezept aus diesem Social-Media-Post:\n\n"${caption}"\n\nQuell-URL: ${url}\nErsteller: ${authorName || 'unbekannt'}`
      : `Dieser Post hat keine lesbare Caption. URL: ${url}\n\nBitte gib { "hatRezept": false, "grund": "Caption nicht auslesbar – Instagram-Privatpost oder API-Limit" } zurück.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API Fehler ${claudeRes.status}: ${errText}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    // JSON sauber parsen (Markdown-Fences entfernen falls vorhanden)
    const cleanJson = rawText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let recipe;
    try {
      recipe = JSON.parse(cleanJson);
    } catch {
      throw new Error('Claude hat kein valides JSON zurückgegeben');
    }

    // ── Kein Rezept erkannt ──
    if (!recipe.hatRezept) {
      return {
        statusCode: 422, headers,
        body: JSON.stringify({
          error: `Kein Rezept gefunden: ${recipe.grund || 'Unbekannter Grund'}`,
          code: 'NO_RECIPE'
        })
      };
    }

    // ── Metadaten anreichern ──
    recipe.id = Date.now();
    recipe.url = url;
    recipe.thumbnailUrl = thumbnailUrl || null;
    recipe.authorName = authorName || null;
    recipe.savedAt = new Date().toISOString();
    delete recipe.hatRezept;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, recipe }),
    };

  } catch (err) {
    console.error('extract-recipe Fehler:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: err.message || 'Interner Fehler',
        code: 'SERVER_ERROR'
      }),
    };
  }
};
