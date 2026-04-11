exports.handler = async function (event, context) {

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let url, caption;
  try {
    const body = JSON.parse(event.body || '{}');
    url = body.url?.trim();
    caption = body.caption?.trim() || '';
    if (!url) throw new Error('Keine URL');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ungültige Anfrage' }) };
  }

  const isInstagram = url.includes('instagram.com');
  const isTikTok = url.includes('tiktok.com');
  if (!isInstagram && !isTikTok) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nur Instagram- und TikTok-Links werden unterstützt.' }) };
  }

  // oEmbed nur versuchen wenn keine Caption manuell eingegeben
  let thumbnailUrl = '';
  let authorName = '';
  if (!caption) {
    try {
      const oembedUrl = isInstagram
        ? `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}&omitscript=true`
        : `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      const oembedRes = await fetch(oembedUrl, { headers: { 'User-Agent': 'ReelRezepte/1.0' } });
      if (oembedRes.ok) {
        const d = await oembedRes.json();
        caption = d.title || '';
        thumbnailUrl = d.thumbnail_url || '';
        authorName = d.author_name || '';
      }
    } catch (e) {
      console.warn('oEmbed-Fehler:', e.message);
    }
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const systemPrompt = `Du bist ein präziser Rezept-Extraktor für eine Koch-App.
Analysiere den gegebenen Text und extrahiere das Rezept.
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

Falls KEIN Rezept: { "hatRezept": false, "grund": "kurze Erklärung" }
Mengenangaben immer metrisch. Schritte auf Deutsch.`;

  const userMessage = caption
    ? `Extrahiere das Rezept aus diesem Text:\n\n"${caption}"\n\nQuelle: ${url}`
    : `Keine Caption verfügbar. Bitte gib { "hatRezept": false, "grund": "Keine Caption – bitte manuell eingeben" } zurück.`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
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
    const cleanJson = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let recipe;
    try { recipe = JSON.parse(cleanJson); }
    catch { throw new Error('Claude hat kein valides JSON zurückgegeben'); }

    if (!recipe.hatRezept) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: `Kein Rezept gefunden: ${recipe.grund || ''}`, code: 'NO_RECIPE' }) };
    }

    recipe.id = Date.now();
    recipe.url = url;
    recipe.thumbnailUrl = thumbnailUrl || null;
    recipe.authorName = authorName || null;
    recipe.savedAt = new Date().toISOString();
    delete recipe.hatRezept;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, recipe }) };

  } catch (err) {
    console.error('extract-recipe Fehler:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Interner Fehler', code: 'SERVER_ERROR' }) };
  }
};
