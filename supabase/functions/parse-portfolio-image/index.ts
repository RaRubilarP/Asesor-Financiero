// Supabase Edge Function: parse-portfolio-image
//
// Recibe una imagen del portafolio (base64) y usa Gemini (Google, visión) para
// extraer las posiciones (ticker, monto invertido, % de ganancia). Gemini
// tiene un nivel gratuito (Google AI Studio), por eso se usa en vez de Claude.
// La clave GEMINI_API_KEY vive solo aquí (secreto de Supabase), nunca
// se expone al navegador.
//
// Deploy: supabase functions deploy parse-portfolio-image
// Secreto: supabase secrets set GEMINI_API_KEY=...
// (Consigue tu clave gratis en https://aistudio.google.com/apikey)

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `Eres un extractor de datos financieros. Recibirás una captura de pantalla de una app de
inversión (por ejemplo Racional, Robinhood, eToro, etc.) que muestra una lista de posiciones con su monto
invertido y su porcentaje de ganancia/pérdida. Devuelve SIEMPRE un único objeto JSON con esta forma exacta,
sin texto adicional antes o después:

{
  "positions": [
    { "ticker": "VOO", "name": "Vanguard S&P 500 ETF", "assetType": "etf", "investedUsd": 412.66, "gainPct": 9.13 }
  ],
  "warnings": ["texto opcional si algo no se pudo leer con certeza"]
}

Reglas:
- "assetType" es "etf" si es un fondo cotizado (ETF) conocido (ej. VOO, QQQ, SCHD, VXUS, SPY, IVV) y "stock" si es una acción individual de una empresa.
- "investedUsd" es el monto en dólares invertido/aportado en esa posición (quita el símbolo de moneda y separadores de miles).
- "gainPct" es el porcentaje de ganancia (positivo) o pérdida (negativo) mostrado, como número (ej. -14.18, no "-14.18%").
- Si no puedes leer un valor con confianza, omite esa posición y agrega una advertencia en "warnings" en vez de inventar un número.
- No agregues posiciones que no veas explícitamente en la imagen.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Requiere que el llamador esté autenticado (Supabase valida el JWT
    // automáticamente si la función se despliega sin --no-verify-jwt).
    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64 || !mediaType) {
      return new Response(JSON.stringify({ error: "Faltan 'imageBase64' o 'mediaType'." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("Falta configurar el secreto GEMINI_API_KEY en Supabase.");

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mediaType, data: imageBase64 } },
              { text: "Extrae las posiciones de esta captura de portafolio y devuelve solo el JSON pedido." },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      throw new Error(`Gemini respondió con error (${geminiRes.status}).`);
    }

    const geminiJson = await geminiRes.json();
    const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini no devolvió una respuesta de texto.");

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No se encontró un JSON en la respuesta de Gemini.");

    const parsed = JSON.parse(match[0]);

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message ?? "Error interno" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
