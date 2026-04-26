// netlify/functions/analyze-image.js
// EmpfÃ¤ngt: { image: base64string, mediaType: "image/jpeg" }
// Gibt zurÃ¼ck: { words: [...] }

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let image, mediaType;
  try {
    ({ image, mediaType } = JSON.parse(event.body || '{}'));
    if (!image) throw new Error('Kein Bild');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'UngÃ¼ltige Anfrage' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API Key fehlt' }) };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: `Du bist ein Lexikon-Assistent. Analysiere das Bild und extrahiere ALLE FremdwÃ¶rter, Fachbegriffe oder ungewÃ¶hnlichen WÃ¶rter.

Antworte NUR mit einem JSON-Array. Kein Markdown, keine ErklÃ¤rungen.

Format:
[{"wort":"...","aussprache":"...","rubrik":"Medizin|Recht|Philosophie|Wirtschaft|Latein|Griechisch|Allgemein","definition":"...","herkunft":"...","beispiel":"..."}]

Falls keine FremdwÃ¶rter: []`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Extrahiere alle FremdwÃ¶rter aus diesem Screenshot.' }
          ]
        }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `API Fehler ${res.status}`);

    const raw = data.content?.[0]?.text || '[]';
    let clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    // Nur den JSON-Array extrahieren
    const match = clean.match(/\[[\s\S]*\]/);
    clean = match ? match[0] : '[]';
    let words;
    try { words = JSON.parse(clean); }
    catch { words = []; }

    return { statusCode: 200, headers, body: JSON.stringify({ words }) };

  } catch(err) {
    console.error('analyze-image Fehler:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
