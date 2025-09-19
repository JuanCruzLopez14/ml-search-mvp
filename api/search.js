// api/search.js
// Serverless function para Vercel
// - Recibe POST { prompt, locale }
// - (Opcional) Usa OPENAI_API_KEY para parsear el prompt y extraer criterios (mejor interpretación).
// - Busca en MercadoLibre (sitio MLA por defecto) y devuelve resultados ordenados.
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors()); // <---- Esto permite conexiones desde cualquier web
app.use(express.json());

// tu código de rutas aquí...

export default async function handler(req, res) {
  // CORS (permite llamadas desde CodePen / tu frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || (await getJsonBody(req));
    const prompt = (body.prompt || '').toString().trim();
    const locale = (body.locale || 'AR').toString().toUpperCase(); // 'AR' por defecto

    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // 1) Interpretación del prompt: OpenAI si está disponible, sino heurística local
    let criteria = null;
    if (process.env.OPENAI_API_KEY) {
      try {
        criteria = await parsePromptWithOpenAI(prompt);
      } catch (e) {
        console.warn('OpenAI parse failed, falling back to heuristic:', e.message);
        criteria = heuristicParse(prompt);
      }
    } else {
      criteria = heuristicParse(prompt);
    }

    // 2) Armar query para Mercado Libre (sitio por país)
    // Sitios comunes: AR => MLA (Argentina). Si necesitás otro país avisame.
    const site = locale === 'AR' ? 'MLA' : 'MLA'; // por MVP usamos MLA (Argentina). Cambiar si hace falta.
    const q = encodeURIComponent(criteria.keywords || criteria.category || prompt);

    const searchUrl = `https://api.mercadolibre.com/sites/${site}/search?q=${q}&limit=8`;
    const mlResp = await fetch(searchUrl);
    if (!mlResp.ok) {
      const txt = await mlResp.text();
      console.error('ML search error', mlResp.status, txt);
      return res.status(500).json({ error: 'MercadoLibre search error', detail: txt });
    }
    const mlJson = await mlResp.json();
    const items = Array.isArray(mlJson.results) ? mlJson.results : [];

    // 3) Enriquecer (intentamos obtener info del vendedor para confianza)
    const results = await Promise.all(items.map(async item => {
      let sellerInfo = null;
      try {
        if (item.seller && item.seller.id) {
          const s = await fetch(`https://api.mercadolibre.com/users/${item.seller.id}`);
          if (s.ok) sellerInfo = await s.json();
        }
      } catch (e) { /* ignore */ }

      return {
        id: item.id,
        title: item.title,
        price: item.price,
        currency: item.currency_id,
        thumbnail: item.thumbnail,
        permalink: item.permalink,
        condition: item.condition,
        free_shipping: item.shipping?.free_shipping || false,
        seller: sellerInfo ? {
          id: sellerInfo.id,
          nickname: sellerInfo.nickname,
          registration_date: sellerInfo.registration_date,
          permalink: sellerInfo.permalink
        } : { id: item.seller?.id || null },
        raw: item // devolvemos el raw por si querés inspeccionar en frontend
      };
    }));

    // 4) Score simple (precio + envío gratis + antigüedad vendedor)
    // Normalizamos precio a [0..1] (más barato -> más alto)
    const prices = results.map(r => r.price || 0).filter(Boolean);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : minPrice || 1;
    results.forEach(r => {
      const p = r.price || maxPrice;
      const scorePrice = maxPrice === minPrice ? 1 : 1 - ((p - minPrice) / (maxPrice - minPrice));
      const scoreShipping = r.free_shipping ? 1 : 0.45;
      let scoreSeller = 0.5;
      if (r.seller && r.seller.registration_date) {
        const year = new Date(r.seller.registration_date).getFullYear();
        const age = new Date().getFullYear() - year;
        scoreSeller = Math.min(1, 0.4 + 0.06 * Math.min(age, 10)); // vendedores antiguos ganan algo de score
      }
      r.score = Math.round((0.6 * scorePrice + 0.2 * scoreShipping + 0.2 * scoreSeller) * 100);
    });

    // 5) Ordenar por score descendente y devolver
    results.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Si el criterio pide entrega rápida y no podemos evaluarlo automáticamente,
    // podemos incluir una "repregunta" en el response.
    const repregunta = (!criteria.latest_delivery_date && results.some(r => r.free_shipping === false))
      ? '¿Quieres priorizar envío rápido aunque cueste un poco más?' : null;

    return res.json({ ok: true, criteria, results, repregunta });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error', detail: err.message });
  }
}

// -------------------- helpers --------------------

async function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
  });
}

async function parsePromptWithOpenAI(prompt) {
  // Usa Chat Completions (gpt-3.5-turbo recomendado para menor costo)
  const system = `Eres un extractor. Dado un prompt en español, devuelve SOLO UN JSON válido con estos campos:
  { "keywords": "...", "category":"...", "must_have":[], "nice_to_have":[], "avoid":[], "budget_min":null, "budget_max":null, "latest_delivery_date": null, "condition_preference":"new|used|either", "priority_weights": {"price":0.0,"delivery_time":0.0,"reviews":0.0,"seller_reputation":0.0 }, "extra_instructions": "..." }.
  Si no hay dato, usa null o lista vacía. Responde SOLO con JSON.`;
  const body = {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: 350
  };

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '{}';
  // Extraer el primer objeto JSON que encuentre en la respuesta
  const match = text.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : text;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error('OpenAI returned non-JSON or malformed JSON');
  }
}

function heuristicParse(prompt) {
  // Heurística simple gratis: saca keywords, detecta "barato/rápido", extrae número de precio y plazos relativos
  const p = prompt.toLowerCase();
  const categories = ['auricular', 'auriculares','celular','notebook','zapatilla','zapatillas','monitor','televisor','tv'];
  let category = null;
  for (const c of categories) if (p.includes(c)) { category = c; break; }

  // buscar precio en dólares o pesos (ej: $300, 300 dolares, 300 usd)
  let budget_max = null;
  const priceMatch = p.match(/\$?\s?([0-9]{2,6})(?:\s?(usd|dólares|dolares|ars|pesos))?/);
  if (priceMatch) budget_max = parseInt(priceMatch[1].replace(/\D/g, ''), 10);

  // entrega en "semana/dias"
  const latest_delivery_date = p.includes('semana') || p.includes('una semana') || p.includes('dentro de una semana') ? 
    new Date(Date.now() + 7*24*3600*1000).toISOString().split('T')[0] : null;

  const keywords = (category ? category : '') + ' ' + (p.match(/auricular|auriculares|celular|notebook|monitor|zapatilla|zapatillas|televisor|tv/)?.[0] || '');
  const priority_weights = {
    price: p.includes('barato') || p.includes('lo mas barato') ? 0.7 : 0.4,
    delivery_time: p.includes('rápido') || p.includes('entrega rápida') || latest_delivery_date ? 0.3 : 0.15,
    reviews: p.includes('reseñas') || p.includes('opiniones') ? 0.25 : 0.1,
    seller_reputation: 0.05
  };

  return {
    keywords: keywords.trim() || null,
    category: category || null,
    must_have: [],
    nice_to_have: [],
    avoid: [],
    budget_min: null,
    budget_max,
    latest_delivery_date,
    condition_preference: null,
    priority_weights,
    extra_instructions: prompt
  };
}
{
  "name": "buscador-backend",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^3.3.2",
    "cors": "^2.8.5"
  },
  "scripts": {
    "start": "node server.js"
  }
}
