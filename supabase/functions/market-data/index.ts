// Supabase Edge Function: market-data
//
// Recibe una lista de tickers/tipos y devuelve fundamentales de mercado
// (desde la caché market_cache si está fresca, o consultando Financial
// Modeling Prep en vivo). La clave FMP_API_KEY vive solo aquí.
//
// Deploy: supabase functions deploy market-data
// Secreto: supabase secrets set FMP_API_KEY=...

import { createClient } from "npm:@supabase/supabase-js@2.110.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

async function fmpGet(path: string, params: Record<string, string> = {}) {
  const apiKey = Deno.env.get("FMP_API_KEY");
  if (!apiKey) throw new Error("Falta configurar el secreto FMP_API_KEY en Supabase.");
  const url = new URL(`${FMP_BASE}${path}`);
  url.searchParams.set("apikey", apiKey);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) {
    console.error(`FMP ${path} -> ${res.status}`);
    return null;
  }
  return await res.json();
}
function pick(arr: any[] | null) {
  return arr && arr.length > 0 ? arr[0] : null;
}

// --- DCF ilustrativo (mismo enfoque simplificado de la app) ---
const DCF_PROFILES: Record<string, { growthRates: number[]; terminalGrowth: number; discountRate: number }> = {
  hyperGrowthAi: { growthRates: [0.4, 0.3, 0.22, 0.18, 0.15], terminalGrowth: 0.04, discountRate: 0.1 },
  matureQuality: { growthRates: [0.12, 0.1, 0.08, 0.07, 0.06], terminalGrowth: 0.035, discountRate: 0.085 },
  cyclicalCapex: { growthRates: [0.2, 0.18, 0.15, 0.12, 0.1], terminalGrowth: 0.04, discountRate: 0.095 },
  speculative: { growthRates: [0.5, 0.4, 0.32, 0.25, 0.2], terminalGrowth: 0.04, discountRate: 0.11 },
};
function pickProfile(revenueGrowthYoy: number | null) {
  if (revenueGrowthYoy === null) return DCF_PROFILES.matureQuality;
  if (revenueGrowthYoy >= 0.45) return DCF_PROFILES.speculative;
  if (revenueGrowthYoy >= 0.2) return DCF_PROFILES.hyperGrowthAi;
  if (revenueGrowthYoy >= 0.1) return DCF_PROFILES.cyclicalCapex;
  return DCF_PROFILES.matureQuality;
}
function computeDcf(opts: {
  baseFcfMillions: number | null;
  netDebtMillions: number;
  sharesOutstandingMillions: number | null;
  currentPrice: number | null;
  revenueGrowthYoy: number | null;
}) {
  const profile = pickProfile(opts.revenueGrowthYoy);
  const { growthRates, terminalGrowth, discountRate } = profile;
  const assumptions =
    `FCF base ${opts.baseFcfMillions !== null ? "US$" + opts.baseFcfMillions.toLocaleString() + "M" : "n/d"}; ` +
    `crecimiento ${growthRates.map((g) => (g * 100).toFixed(0) + "%").join(" → ")} a 5 años; ` +
    `terminal ${(terminalGrowth * 100).toFixed(1)}%; descuento ${(discountRate * 100).toFixed(1)}%; ` +
    `deuda neta US$${opts.netDebtMillions.toLocaleString()}M.`;

  if (
    opts.baseFcfMillions === null ||
    opts.baseFcfMillions <= 0 ||
    !opts.sharesOutstandingMillions ||
    opts.sharesOutstandingMillions <= 0
  ) {
    return {
      fairValuePerShare: null,
      upsideVsPrice: null,
      assumptions,
      applicable: false,
      note: "No se calcula un valor confiable: FCF negativo/insuficiente o faltan datos de acciones en circulación. Usa un enfoque de múltiplos en su lugar.",
    };
  }

  let fcf = opts.baseFcfMillions;
  let pvSum = 0;
  for (let y = 1; y <= growthRates.length; y++) {
    fcf *= 1 + growthRates[y - 1];
    pvSum += fcf / Math.pow(1 + discountRate, y);
  }
  const terminalValue = (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  const pvTerminal = terminalValue / Math.pow(1 + discountRate, growthRates.length);
  const enterpriseValue = pvSum + pvTerminal;
  const equityValue = enterpriseValue - opts.netDebtMillions;
  const fairValuePerShare = equityValue / opts.sharesOutstandingMillions;
  const upsideVsPrice =
    opts.currentPrice && opts.currentPrice > 0
      ? ((fairValuePerShare - opts.currentPrice) / opts.currentPrice) * 100
      : null;

  return {
    fairValuePerShare: Math.round(fairValuePerShare * 100) / 100,
    upsideVsPrice: upsideVsPrice !== null ? Math.round(upsideVsPrice * 100) / 100 : null,
    assumptions,
    applicable: true,
    note: "Estimación ilustrativa con supuestos simplificados definidos por esta app, no consenso de mercado.",
  };
}

async function getStockFundamentals(ticker: string) {
  const [quote, ratios, cashFlow, priceTarget, rating, profile] = await Promise.all([
    fmpGet(`/quote/${ticker}`).then(pick),
    fmpGet(`/ratios-ttm/${ticker}`).then(pick),
    fmpGet(`/cash-flow-statement/${ticker}`, { period: "annual", limit: "1" }).then(pick),
    fmpGet(`/price-target-consensus`, { symbol: ticker }).then(pick),
    fmpGet(`/rating/${ticker}`).then(pick),
    fmpGet(`/profile/${ticker}`).then(pick),
  ]);

  const price = quote?.price ?? null;
  const sharesOutstandingMillions = quote?.sharesOutstanding ? quote.sharesOutstanding / 1_000_000 : null;
  const revenueGrowthYoy = ratios?.revenueGrowthTTM ?? null;
  const freeCashFlowTtm = cashFlow?.freeCashFlow ? cashFlow.freeCashFlow / 1_000_000 : null;
  const netDebtMillions = cashFlow?.netDebt ? cashFlow.netDebt / 1_000_000 : 0;

  const dcf = computeDcf({
    baseFcfMillions: freeCashFlowTtm,
    netDebtMillions,
    sharesOutstandingMillions,
    currentPrice: price,
    revenueGrowthYoy,
  });

  return {
    ticker,
    companyName: profile?.companyName ?? ticker,
    sector: profile?.sector ?? null,
    price,
    peTrailing: ratios?.peRatioTTM ?? null,
    peForward: null,
    revenueGrowthYoy,
    grossMargin: ratios?.grossProfitMarginTTM ?? null,
    operatingMargin: ratios?.operatingProfitMarginTTM ?? null,
    netMargin: ratios?.netProfitMarginTTM ?? null,
    freeCashFlowTtm,
    roe: ratios?.returnOnEquityTTM ?? null,
    debtToEquity: ratios?.debtEquityRatioTTM ?? null,
    sharesOutstanding: sharesOutstandingMillions,
    netDebt: netDebtMillions,
    analyst: {
      rating: rating?.ratingRecommendation ?? null,
      priceTarget: priceTarget?.targetConsensus ?? null,
    },
    dcf,
    fetchedAt: new Date().toISOString(),
  };
}

async function getEtfFundamentals(ticker: string) {
  const [quote, etfInfo] = await Promise.all([
    fmpGet(`/quote/${ticker}`).then(pick),
    fmpGet(`/etf-info`, { symbol: ticker }),
  ]);
  return {
    ticker,
    name: etfInfo?.name ?? quote?.name ?? ticker,
    expenseRatio: etfInfo?.expenseRatio ?? null,
    yieldPct: etfInfo?.yield ?? null,
    aum: etfInfo?.aum ?? null,
    price: quote?.price ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Cliente de Supabase con el JWT del usuario que llama (respeta RLS).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { tickers, types, force } = await req.json();
    if (!Array.isArray(tickers) || !Array.isArray(types) || tickers.length !== types.length) {
      return new Response(JSON.stringify({ error: "'tickers' y 'types' deben ser arrays del mismo tamaño." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, unknown> = {};

    for (let i = 0; i < tickers.length; i++) {
      const ticker = String(tickers[i]).toUpperCase();
      const assetType = types[i] as "stock" | "etf";

      if (!force) {
        const { data: cached } = await supabase
          .from("market_cache")
          .select("payload, fetched_at")
          .eq("ticker", ticker)
          .maybeSingle();
        if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) {
          results[ticker] = cached.payload;
          continue;
        }
      }

      const fresh = assetType === "stock" ? await getStockFundamentals(ticker) : await getEtfFundamentals(ticker);
      await supabase.from("market_cache").upsert({
        ticker,
        asset_type: assetType,
        payload: fresh,
        fetched_at: new Date().toISOString(),
      });
      results[ticker] = fresh;
    }

    return new Response(JSON.stringify({ data: results, fetchedAt: new Date().toISOString() }), {
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
