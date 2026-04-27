/**
 * ════════════════════════════════════════════════════════════
 * WARRANT PRO WORKER — Cloudflare Workers
 * Algorithme exact de warrant_pro.html
 *
 * ARCHITECTURE SPLIT-SCAN :
 * Cron A : 8h00 Paris → scan tickers 0-36  (batch A)
 * Cron B : 8h12 Paris → scan tickers 37-71 (batch B) + merge + Telegram
 *
 * CRON TRIGGERS (Settings → Triggers) :
 * 0 6 * * *    → Batch A — 8h00 Paris été  (UTC+2)
 * 12 6 * * *   → Batch B — 8h12 Paris été
 * 0 7 * * *    → Batch A — 8h00 Paris hiver (UTC+1)
 * 12 7 * * *   → Batch B — 8h12 Paris hiver
 *
 * VARIABLES D'ENVIRONNEMENT :
 * TG_TOKEN, TG_CHAT_ID, YF_COOKIE, CAPITAL_EUR, NB_ACCOUNTS, AV_KEY
 *
 * BINDINGS KV : TRADING_KV
 * ════════════════════════════════════════════════════════════
 */

// ─── UNIVERS SBF120 + DAX40 ───────────────────────────────────────────────────
const TK_CORE = [
  // CAC40 core
  {t:'AIR.PA',n:'Airbus',s:'Défense'},{t:'AI.PA',n:'Air Liquide',s:'Chimie'},
  {t:'ALO.PA',n:'Alstom',s:'Industrie'},{t:'CS.PA',n:'AXA',s:'Finance'},
  {t:'BNP.PA',n:'BNP Paribas',s:'Finance'},{t:'EN.PA',n:'Bouygues',s:'Conglomérat'},
  {t:'CA.PA',n:'Carrefour',s:'Distribution'},{t:'ACA.PA',n:'Crédit Agricole',s:'Finance'},
  {t:'BN.PA',n:'Danone',s:'Alimentaire'},{t:'RMS.PA',n:'Hermès',s:'Luxe'},
  {t:'KER.PA',n:'Kering',s:'Luxe'},{t:'LR.PA',n:'Legrand',s:'Industrie'},
  {t:'MC.PA',n:'LVMH',s:'Luxe'},{t:'OR.PA',n:"L'Oréal",s:'Consomm.'},
  {t:'ORA.PA',n:'Orange',s:'Télécom'},{t:'PUB.PA',n:'Publicis',s:'Média'},
  {t:'SAF.PA',n:'Safran',s:'Défense'},{t:'SGO.PA',n:'Saint-Gobain',s:'Matériaux'},
  {t:'SU.PA',n:'Schneider Electric',s:'Industrie'},{t:'GLE.PA',n:'Soc Gen',s:'Finance'},
  {t:'HO.PA',n:'Thales',s:'Défense'},{t:'TTE.PA',n:'TotalEnergies',s:'Énergie'},
  {t:'VIE.PA',n:'Veolia',s:'Utilities'},{t:'DG.PA',n:'Vinci',s:'Construction'},
  {t:'VIV.PA',n:'Vivendi',s:'Média'},
  // SBF120 extension liquide
  {t:'AC.PA',n:'Accor',s:'Hôtellerie'},{t:'ADP.PA',n:'ADP',s:'Infrastructure'},
  {t:'AMUN.PA',n:'Amundi',s:'Finance'},{t:'AKE.PA',n:'Arkema',s:'Chimie'},
  {t:'BVI.PA',n:'Bureau Veritas',s:'Services'},{t:'AM.PA',n:'Dassault Aviation',s:'Défense'},
  {t:'FGR.PA',n:'Eiffage',s:'Construction'},{t:'ELIS.PA',n:'Elis',s:'Services'},
  {t:'ENGI.PA',n:'Engie',s:'Énergie'},{t:'ENX.PA',n:'Euronext',s:'Finance'},
  {t:'GFC.PA',n:'Gecina',s:'Immobilier'},{t:'GET.PA',n:'Getlink',s:'Infrastructure'},
  {t:'GTT.PA',n:'GTT',s:'Industrie'},{t:'LI.PA',n:'Klepierre',s:'Immobilier'},
  {t:'NEX.PA',n:'Nexans',s:'Industrie'},{t:'RXL.PA',n:'Rexel',s:'Distribution'},
  {t:'SCR.PA',n:'Scor',s:'Finance'},{t:'SW.PA',n:'Sodexo',s:'Services'},
  {t:'SPIE.PA',n:'Spie',s:'Services'},{t:'TE.PA',n:'Technip',s:'Énergie'},
  {t:'MF.PA',n:'Wendel',s:'Finance'},{t:'VK.PA',n:'Vallourec',s:'Industrie'},
  {t:'EDEN.PA',n:'Edenred',s:'Fintech'},{t:'RF.PA',n:'Eurazeo',s:'Finance'},
  {t:'RI.PA',n:'Pernod Ricard',s:'Alimentaire'},{t:'CO.PA',n:'Rémy Cointreau',s:'Alimentaire'},
  {t:'SOP.PA',n:'Sopra Steria',s:'Tech'},
  // DAX40
  {t:'SAP.DE',n:'SAP',s:'Tech'},{t:'SIE.DE',n:'Siemens',s:'Industrie'},
  {t:'ALV.DE',n:'Allianz',s:'Finance'},{t:'DTE.DE',n:'Deutsche Telekom',s:'Télécom'},
  {t:'MUV2.DE',n:'Munich Re',s:'Finance'},{t:'MBG.DE',n:'Mercedes-Benz',s:'Auto'},
  {t:'BAS.DE',n:'BASF',s:'Chimie'},{t:'BMW.DE',n:'BMW',s:'Auto'},
  {t:'ADS.DE',n:'Adidas',s:'Consomm.'},{t:'BAYN.DE',n:'Bayer',s:'Santé'},
  {t:'DB1.DE',n:'Deutsche Bourse',s:'Finance'},{t:'IFX.DE',n:'Infineon',s:'Tech'},
  {t:'MRK.DE',n:'Merck KGaA',s:'Santé'},{t:'DBK.DE',n:'Deutsche Bank',s:'Finance'},
  {t:'DHL.DE',n:'DHL',s:'Services'},{t:'RWE.DE',n:'RWE',s:'Utilities'},
  {t:'CON.DE',n:'Continental',s:'Auto'},{t:'EOAN.DE',n:'E.ON',s:'Utilities'},
  {t:'FRE.DE',n:'Fresenius',s:'Santé'},{t:'VOW3.DE',n:'Volkswagen',s:'Auto'},
  {t:'RHM.DE',n:'Rheinmetall',s:'Défense'},{t:'MTX.DE',n:'MTU Aero',s:'Défense'},
  {t:'CBK.DE',n:'Commerzbank',s:'Finance'},{t:'BEI.DE',n:'Beiersdorf',s:'Consomm.'},
];

const BATCH_SIZE  = 36;
const TK_BATCH_A  = TK_CORE.slice(0, BATCH_SIZE);
const TK_BATCH_B  = TK_CORE.slice(BATCH_SIZE);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ─── Yahoo Finance — pool UA + session ───────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
let _uaIdx = 0;
function nextUA() { return UA_POOL[(_uaIdx++) % UA_POOL.length]; }

let SESSION = { crumb: null, cookie: null, ts: 0 };
const SESSION_TTL = 25 * 60 * 1000;
let SESSION_REQ_COUNT = 0;
const SESSION_REQ_MAX = 38;

async function getYahooSession(env, forceRefresh = false) {
  const now = Date.now();
  const expired = !SESSION.crumb || (now - SESSION.ts) >= SESSION_TTL;
  const tooManyReqs = SESSION_REQ_COUNT >= SESSION_REQ_MAX;
  if (!forceRefresh && !expired && !tooManyReqs) return SESSION;

  let cookie = '';
  if (env?.YF_COOKIE) {
    const raw = env.YF_COOKIE.trim();
    const m = raw.match(/A1=([^;,\s]+)/);
    cookie = m ? `A1=${m[1]}` : (raw.startsWith('A1=') ? raw : `A1=${raw}`);
  }
  if (!cookie) {
    console.warn('⚠️  YF_COOKIE non configuré');
    SESSION = { crumb: '', cookie: '', ts: now };
    SESSION_REQ_COUNT = 0;
    return SESSION;
  }

  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
        headers: {
          'User-Agent': nextUA(), 'Accept': 'text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://finance.yahoo.com/', 'Cookie': cookie,
        },
      });
      if (!r.ok) continue;
      const crumb = (await r.text()).trim();
      if (crumb && crumb.length > 2 && !crumb.includes('<') && !crumb.includes('{')) {
        SESSION = { crumb, cookie, ts: now };
        SESSION_REQ_COUNT = 0;
        console.log(`Session Yahoo OK — crumb=${crumb.slice(0, 6)}… host=${host}`);
        return SESSION;
      }
    } catch (e) {}
  }
  SESSION = { crumb: '', cookie, ts: now };
  SESSION_REQ_COUNT = 0;
  console.warn('⚠️  Crumb non obtenu — tentative sans crumb');
  return SESSION;
}

// ─── Source 1 : Yahoo Finance v8 ─────────────────────────────────────────────
async function fetchBarsFromYahoo(ticker, period, interval, env) {
  const end   = Math.floor(Date.now() / 1000);
  const days  = { '5y':1826,'3y':1095,'2y':730,'6mo':180,'3mo':90 }[period] ?? 365;
  const start = end - days * 86400;
  if (SESSION_REQ_COUNT >= SESSION_REQ_MAX) { await sleep(500); await getYahooSession(env, true); }
  const s = await getYahooSession(env);
  const crumbParam = s.crumb ? `&crumb=${encodeURIComponent(s.crumb)}` : '';
  const baseHeaders = {
    'User-Agent': nextUA(), 'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Referer': 'https://finance.yahoo.com/', 'Origin': 'https://finance.yahoo.com',
  };
  if (s.cookie) baseHeaders['Cookie'] = s.cookie;
  SESSION_REQ_COUNT++;
  for (const host of ['query2', 'query1']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&period1=${start}&period2=${end}&includePrePost=false${crumbParam}`;
      const resp = await fetch(url, { headers: baseHeaders, cf: { cacheTtl: 3600, cacheKey: `yf-${ticker}-${interval}-${period}` } });
      if (resp.status === 401 || resp.status === 403) { await getYahooSession(env, true); continue; }
      if (!resp.ok) continue;
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const bars = parseYahooResult(result);
      if (bars.length > 0) return bars;
    } catch (e) {}
  }
  return [];
}

// ─── Source 2 : Yahoo Spark (endpoint mobile) ────────────────────────────────
async function fetchBarsFromYahooSpark(ticker, period, env) {
  const end   = Math.floor(Date.now() / 1000);
  const days  = { '5y':1826,'3y':1095,'2y':730,'6mo':180,'3mo':90 }[period] ?? 365;
  const s = await getYahooSession(env);
  const headers = { 'User-Agent': UA_POOL[0], 'Accept': 'application/json', 'Referer': 'https://mobile.yahoo.com/' };
  if (s.cookie) headers['Cookie'] = s.cookie;
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(ticker)}&range=${days <= 365 ? '1y' : '2y'}&interval=1d`;
    const resp = await fetch(url, { headers, cf: { cacheTtl: 3600 } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const item = data?.spark?.result?.[0]?.response?.[0];
    if (!item) return [];
    return parseYahooResult(item);
  } catch (e) { return []; }
}

// ─── Parser commun Yahoo v8/v7 ────────────────────────────────────────────────
function parseYahooResult(result) {
  const ts  = result.timestamp || [];
  const q   = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = adj[i] ?? q.close?.[i];
    if (!c || !q.open?.[i] || !q.high?.[i] || !q.low?.[i]) continue;
    bars.push({
      t: ts[i],
      o: Math.round(q.open[i] * 10000) / 10000,
      h: Math.round(q.high[i] * 10000) / 10000,
      l: Math.round(q.low[i]  * 10000) / 10000,
      c: Math.round(c         * 10000) / 10000,
      v: q.volume?.[i] || 0,
    });
  }
  return bars;
}

// ─── Source 3 : Stooq (CSV gratuit) ──────────────────────────────────────────
async function fetchBarsFromStooq(ticker, period) {
  const stooqTicker = ticker.toLowerCase();
  const days = { '5y':1826,'3y':1095,'2y':730,'6mo':180,'3mo':90 }[period] ?? 365;
  const d2   = new Date();
  const d1   = new Date(d2.getTime() - days * 86400 * 1000);
  const fmt  = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url  = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&d1=${fmt(d1)}&d2=${fmt(d2)}&i=d`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://stooq.com/', 'Accept': 'text/csv, text/plain, */*' },
      cf: { cacheTtl: 3600 },
    });
    if (!resp.ok) return [];
    const csv   = await resp.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2 || lines[0].toLowerCase().includes('no data') || lines[1]?.toLowerCase().includes('no data')) return [];
    const bars = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 5) continue;
      const [date, o, h, l, c, v] = parts;
      const close = parseFloat(c);
      if (!close || close <= 0 || isNaN(close)) continue;
      bars.push({ t: Math.floor(new Date(date).getTime() / 1000), o: parseFloat(o)||close, h: parseFloat(h)||close, l: parseFloat(l)||close, c: close, v: parseInt(v)||0 });
    }
    bars.reverse();
    return bars;
  } catch (e) { return []; }
}

// ─── Source 4 : Alpha Vantage (optionnel) ────────────────────────────────────
async function fetchBarsFromAlphaVantage(ticker, env) {
  if (!env?.AV_KEY) return [];
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${env.AV_KEY}`;
    const resp = await fetch(url, { cf: { cacheTtl: 3600 } });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data['Note'] || data['Information']) { console.warn(`Alpha Vantage limite pour ${ticker}`); return []; }
    const ts = data['Time Series (Daily)'];
    if (!ts) return [];
    return Object.entries(ts)
      .map(([date, d]) => ({ t: Math.floor(new Date(date).getTime() / 1000), o: parseFloat(d['1. open']), h: parseFloat(d['2. high']), l: parseFloat(d['3. low']), c: parseFloat(d['5. adjusted close'])||parseFloat(d['4. close']), v: parseInt(d['6. volume'])||0 }))
      .filter(b => b.c > 0).sort((a, b) => a.t - b.t);
  } catch (e) { return []; }
}

// ─── fetchBars : cascade v8 → Spark → Stooq → Alpha Vantage ─────────────────
async function fetchBars(ticker, period = '1y', interval = '1d', env) {
  const y = await fetchBarsFromYahoo(ticker, period, interval, env);
  if (y.length > 0) return y;
  await sleep(80);
  const ys = await fetchBarsFromYahooSpark(ticker, period, env);
  if (ys.length > 0) { console.log(`Yahoo Spark OK pour ${ticker} (${ys.length} bougies)`); return ys; }
  await sleep(80);
  const st = await fetchBarsFromStooq(ticker, period);
  if (st.length > 0) { console.log(`Stooq OK pour ${ticker} (${st.length} bougies)`); return st; }
  if (env?.AV_KEY) {
    await sleep(12500);
    const av = await fetchBarsFromAlphaVantage(ticker, env);
    if (av.length > 0) { console.log(`Alpha Vantage OK pour ${ticker} (${av.length} bougies)`); return av; }
  }
  return [];
}

// ─── Constantes Régime K-means ────────────────────────────────────────────────
const REGIME_CENTROIDS = [
  [-0.65,-0.55,-0.10,+0.20,-0.55],  // CALM
  [+0.45,+0.40,+0.35,-0.40,+0.45],  // STRESS
  [+1.60,+1.40,+0.90,-1.50,+1.80],  // PANIC
];
const REGIME_PROFILES = [
  {id:0,name:'CALM',  profile:'TURBO',       kelly:1.00,capMult:1.00,allowEntry:true, zThreshAdd:0.0,emoji:'🟢'},
  {id:1,name:'STRESS',profile:'CONSERVATIVE',kelly:0.66,capMult:0.66,allowEntry:true, zThreshAdd:0.5,emoji:'🟡'},
  {id:2,name:'PANIC', profile:'OFF',         kelly:0.00,capMult:0.00,allowEntry:false,zThreshAdd:99, emoji:'🔴'},
];
const REGIME_REF_STATS = {
  sigma20:{median:0.180,mad:0.060}, sigma60:{median:0.190,mad:0.045},
  ratio:  {median:0.950,mad:0.180}, ret20:  {median:0.005,mad:0.040},
  absret5:{median:0.020,mad:0.015},
};

// ─── Router principal ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const isB = (event.cron || '').startsWith('12 ');
    ctx.waitUntil(isB ? runBatchB(env) : runBatchA(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/ping') {
      return new Response(JSON.stringify({
        ok: true, version: 'worker_v22',
        timestamp: new Date().toISOString(),
        env: {
          TG_TOKEN:    env.TG_TOKEN   ? `présent (${env.TG_TOKEN.slice(0,8)}...)` : '❌ MANQUANT',
          TG_CHAT_ID:  env.TG_CHAT_ID ? `présent (${env.TG_CHAT_ID})`             : '❌ MANQUANT',
          TRADING_KV:  env.TRADING_KV ? '✅ bindé'                                 : '❌ MANQUANT',
          CAPITAL_EUR: env.CAPITAL_EUR || '(défaut 10000)',
          NB_ACCOUNTS: env.NB_ACCOUNTS || '(défaut 1)',
        },
        regime_profiles_loaded: typeof REGIME_PROFILES !== 'undefined' && REGIME_PROFILES.length === 3,
      }, null, 2), { headers: CORS });
    }

    if (url.pathname === '/history') {
      const ticker   = url.searchParams.get('ticker') || '';
      const period   = url.searchParams.get('period')   || '1y';
      const interval = url.searchParams.get('interval') || '1d';
      const b = await fetchBars(ticker, period, interval, env);
      return new Response(JSON.stringify({ bars: b }), { headers: CORS });
    }

    if (url.pathname === '/news') {
      return proxyNews(url.searchParams.get('ticker') || '', env);
    }

    if (url.pathname === '/run') {
      const batch = url.searchParams.get('batch')?.toLowerCase();
      const force = url.searchParams.get('force') === '1';
      if (force) await env.TRADING_KV.delete('last_notif_day').catch(() => {});
      let result;
      if (batch === 'a')      result = await runBatchA(env);
      else if (batch === 'b') result = await runBatchB(env);
      else                    result = await runWarrantScan(env, TK_CORE, true);
      return new Response(JSON.stringify(result, null, 2), { headers: CORS });
    }

    if (url.pathname === '/test-telegram') {
      const mode = url.searchParams.get('mode') || 'calm';
      if (!env.TG_TOKEN)   return new Response(JSON.stringify({ ok: false, error: 'TG_TOKEN manquant' }), { status: 500, headers: CORS });
      if (!env.TG_CHAT_ID) return new Response(JSON.stringify({ ok: false, error: 'TG_CHAT_ID manquant' }), { status: 500, headers: CORS });
      const fakeRegime  = { regimeName:'CALM', profile:REGIME_PROFILES[0], confidence:2.1, features:{sigma20:0.15,sigma60:0.16,ratio:0.94,ret20:0.02,absret5:0.012}, proxy:'^FCHI' };
      const fakeVix     = { current:16.5, regime:'normal', mult:1.0, dailyCap:0.6 };
      const fakeCapital = { total:Number(env.CAPITAL_EUR)||10000, nbAccounts:Number(env.NB_ACCOUNTS)||1, perAccount:Number(env.CAPITAL_EUR)||10000, dailyCapPct:0.6 };
      let alerts = [], exits = { toSell:[], toHold:[], errors:[] };
      if (mode === 'buy' || mode === 'mixed') {
        alerts = [{
          ticker:'AIR.PA', name:'Airbus', sector:'Défense', price:155.20,
          direction:'CALL', confidence:'H', reason:'Test signal',
          indicators:{ z:-2.6, rsi:22, vol60:20, ret5:-4.5, ret63:0, sq:true, ivRatio:1.4, gapRisk:'none', gapPct:0, aboveMM200:false, mm200:160.5 },
          sizing:{ szPct:18, szPctAdj:18, amountEur:1800, warrantPrice:0.85, qty:2100, vixMult:1.0, account:'A', overflow:false, requestedEur:1800, capitalTotal:10000, capitalSource:'env_fixe', nbAccounts:1, isFriday:false, sectorCapped:false },
          warrant:{ strike:155.20, delta:0.52, lever:6.3, parity:1 },
          matu:'3M', isFlash:false,
          issuer:'Societe Generale (SG leader spreads CAC40)',
          entryDate: new Date().toISOString().slice(0,10),
          exitRules:{ tpWarrant:1.02, tpWarrantUltra:1.105, tpUnderlying:159.86, slUnderlying:147.44, minHoldDays:3, maxHoldDays:90, thetaCritical:'15 jours restants' },
          sectorCorr:{ status:'neutral', reason:'Neutre' },
        }];
      }
      if (mode === 'sell' || mode === 'mixed') {
        exits.toSell = [{ ticker:'OR.PA', type:'CALL', strike:380, matu:'3M', date:'2026-04-10', price:0.95, entryS:392.50, recommendation:{ action:'VENDRE', color:'G', reason:'✅ TP WARRANT : +27.0% atteint', currentPrice:1.21, warrantPnL:0.27, underlyingPnL:0.018, daysHeld:7 } }];
      }
      try {
        await sendTelegram(alerts, fakeVix, [], env, fakeCapital, mode==='panic'?{regimeName:'PANIC',profile:REGIME_PROFILES[2],confidence:1.8,features:{sigma20:0.45,sigma60:0.30,ratio:1.5,ret20:-0.18,absret5:0.07},proxy:'^FCHI'}:fakeRegime, exits);
        return new Response(JSON.stringify({ ok:true, mode, sent:'check Telegram' }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok:false, error:e.message }), { status:500, headers: CORS });
      }
    }

    if (url.pathname === '/signals') {
      const raw  = await env.TRADING_KV.get('last_result').catch(() => null);
      const data = raw ? JSON.parse(raw) : { signals:[], timestamp:null };
      return new Response(JSON.stringify(data), { headers: CORS });
    }

    if (url.pathname === '/history-kv' || url.pathname === '/history-data') {
      const raw  = await env.TRADING_KV.get('history').catch(() => null);
      return new Response(JSON.stringify(raw ? JSON.parse(raw) : []), { headers: CORS });
    }

    if (url.pathname === '/positions') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const open = (Array.isArray(body.positions) ? body.positions : []).filter(p => p.status === 'open');
          await env.TRADING_KV.put('user_positions', JSON.stringify({ positions:open, updatedAt:new Date().toISOString(), count:open.length }));
          return new Response(JSON.stringify({ ok:true, stored:open.length }), { headers: CORS });
        } catch (e) {
          return new Response(JSON.stringify({ ok:false, error:e.message }), { status:400, headers: CORS });
        }
      }
      const raw = await env.TRADING_KV.get('user_positions').catch(() => null);
      return new Response(JSON.stringify(raw ? JSON.parse(raw) : { positions:[], updatedAt:null, count:0 }), { headers: CORS });
    }

    // Indicateurs bruts des 10 premiers tickers (sans filtre signal) — diagnostic
    if (url.pathname === '/debug') {
      await getYahooSession(env);
      const sample = TK_CORE.slice(0, 10);
      const rows   = [];
      for (const tk of sample) {
        try {
          const b   = await fetchBars(tk.t, '1y', '1d', env);
          const ind = b.length > 70 ? scanIndicators(b) : null;
          rows.push({ ticker:tk.t, bars:b.length, z:ind?.z??null, rsi:ind?.rsi??null, sq:ind?.sq??null, ret5:ind?Math.round(ind.ret5*1000)/10:null, ret63:ind?.ret63??null, vol60:ind?.vol60??null, signal:ind?(detectSignal(ind)?.dir??'none'):'no_data' });
        } catch (e) { rows.push({ ticker:tk.t, error:e.message }); }
        await sleep(100);
      }
      return new Response(JSON.stringify(rows, null, 2), { headers: CORS });
    }

    return new Response(JSON.stringify({ status:'ok', worker:'WarrantPro', batches:{ a:TK_BATCH_A.length, b:TK_BATCH_B.length } }), { headers: CORS });
  },
};

// ─── Batch A ──────────────────────────────────────────────────────────────────
async function runBatchA(env) {
  console.log('[BatchA] Démarrage…');
  const result = await runWarrantScan(env, TK_BATCH_A, false);
  await env.TRADING_KV.put('batch_a', JSON.stringify({
    bars_meta: result._barsMeta,
    errors:    result.errors,
    vix:       result.vix,
    regime:    result.regime || null,
    ts:        result.timestamp,
  })).catch(() => {});
  console.log(`[BatchA] Terminé : ${result.scanned} tickers, ${result.errors.length} erreurs`);
  return { batch:'A', scanned:result.scanned, errors:result.errors };
}

// ─── Batch B ──────────────────────────────────────────────────────────────────
async function runBatchB(env) {
  console.log('[BatchB] Démarrage…');
  const resultB = await runWarrantScan(env, TK_BATCH_B, false);
  let batchA = null;
  try { const rawA = await env.TRADING_KV.get('batch_a'); if (rawA) batchA = JSON.parse(rawA); } catch (e) {}

  const allErrors  = [...(batchA?.errors || []), ...resultB.errors];
  const vix        = batchA?.vix || resultB.vix;
  const regime     = resultB.regime || batchA?.regime || null;

  let regimeForBuild = null;
  if (regime) {
    if (regime.profile && typeof regime.profile === 'object' && 'kelly' in regime.profile) {
      regimeForBuild = regime;
    } else if (regime.profile && typeof regime.profile === 'string') {
      const profileObj = REGIME_PROFILES.find(p => p.profile === regime.profile);
      regimeForBuild = { regimeName: regime.name || regime.regimeName, regimeId: profileObj?.id ?? 0, profile: profileObj || REGIME_PROFILES[0], confidence: regime.confidence || 1, features: regime.features || {}, proxy: regime.proxy };
    }
  }

  let netLiquidity = null;
  try {
    const posRaw = await env.TRADING_KV.get('user_positions');
    if (posRaw) {
      const posData = JSON.parse(posRaw);
      const openPositions = posData.positions || [];
      const CAPITAL_ENV = Number(env?.CAPITAL_EUR) > 0 ? Number(env.CAPITAL_EUR) : 10000;
      const allBarsMeta  = { ...(batchA?.bars_meta || {}), ...resultB._barsMeta };
      const invested = openPositions.reduce((s, p) => s + (p.price||0) * (p.qty||0), 0);
      let latentPnL = 0;
      for (const p of openPositions) {
        const meta = allBarsMeta[p.ticker];
        if (meta?.ind) { const lp = meta.ind.price||0; const es = p.entryS||lp; const lev = 5; latentPnL += (p.price||0)*(p.qty||0)*lev*(lp/Math.max(0.01,es)-1); }
      }
      const freeCash = CAPITAL_ENV - invested;
      netLiquidity = Math.max(CAPITAL_ENV * 0.1, freeCash + latentPnL + invested);
      console.log(`[runBatchB] Net Liquidity: ${netLiquidity.toFixed(0)}€`);
    }
  } catch (e) { console.warn('[runBatchB] Net Liquidity impossible:', e.message); }

  const allBarsMeta = { ...(batchA?.bars_meta || {}), ...resultB._barsMeta };
  const fullResult  = buildFinalResult(allBarsMeta, vix, allErrors, resultB.timestamp, env, regimeForBuild, netLiquidity);

  await env.TRADING_KV.put('last_result', JSON.stringify(fullResult)).catch(() => {});
  const raw = await env.TRADING_KV.get('history').catch(() => null);
  const history = raw ? JSON.parse(raw) : [];
  history.unshift({ date:fullResult.timestamp, count:fullResult.signals.length, tickers:fullResult.signals.map(a=>a.ticker) });
  if (history.length > 30) history.length = 30;
  await env.TRADING_KV.put('history', JSON.stringify(history)).catch(() => {});

  // Dédup 7 jours achats
  const notifiedRaw = await env.TRADING_KV.get('notified').catch(() => null);
  const notified = notifiedRaw ? JSON.parse(notifiedRaw) : {};
  const nowTs = Date.now();
  const COOLDOWN_MS = 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(notified)) if (nowTs - notified[k] > COOLDOWN_MS) delete notified[k];
  const newSignals = fullResult.signals.filter(s => !notified[s.ticker]);
  for (const s of newSignals) notified[s.ticker] = nowTs;
  await env.TRADING_KV.put('notified', JSON.stringify(notified)).catch(() => {});

  const exits = await checkPositionsForExits(env);

  // Cooldown 24h ventes
  const sellRaw = await env.TRADING_KV.get('notified_sells').catch(() => null);
  const sellNotified = sellRaw ? JSON.parse(sellRaw) : {};
  const SELL_COOLDOWN_MS = 24 * 3600 * 1000;
  for (const k of Object.keys(sellNotified)) if (nowTs - sellNotified[k] > SELL_COOLDOWN_MS) delete sellNotified[k];
  const newToSell = exits.toSell.filter(p => !sellNotified[p.ticker]);
  for (const p of newToSell) sellNotified[p.ticker] = nowTs;
  await env.TRADING_KV.put('notified_sells', JSON.stringify(sellNotified)).catch(() => {});

  // Garde 1 Telegram/jour (skip week-end)
  const todayParis = new Date().toLocaleDateString('en-CA', { timeZone:'Europe/Paris' });
  const dowParis   = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Paris' })).getDay();
  const isWeekend  = dowParis === 0 || dowParis === 6;
  const lastNotifDay = await env.TRADING_KV.get('last_notif_day').catch(() => null);

  if (isWeekend) {
    console.log(`[BatchB] Week-end (${dowParis}) — pas de notification`);
  } else if (lastNotifDay === todayParis) {
    console.log(`[BatchB] Déjà notifié aujourd'hui (${todayParis}) — skip`);
  } else {
    try {
      await sendTelegram(newSignals, vix, allErrors, env, fullResult.capital, fullResult.regime, { ...exits, toSell:newToSell });
      await env.TRADING_KV.put('last_notif_day', todayParis).catch(() => {});
      const summary = newSignals.length > 0 || newToSell.length > 0 ? `${newSignals.length} achat(s) + ${newToSell.length} vente(s)` : 'marché calme';
      console.log(`[BatchB] ✅ Telegram envoyé : ${summary}`);
    } catch (e) { console.error('[BatchB] Telegram failed:', e.message); }
  }

  console.log(`[BatchB] Terminé : ${fullResult.scanned} tickers, ${fullResult.signals.length} signaux`);
  return fullResult;
}

// ─── proxyNews ────────────────────────────────────────────────────────────────
async function proxyNews(ticker, env) {
  try {
    const session    = await getYahooSession(env);
    const crumbParam = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
    const headers = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept':'application/json', 'Referer':'https://finance.yahoo.com/' };
    if (session.cookie) headers['Cookie'] = session.cookie;
    const r    = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=8${crumbParam}`, { headers, cf:{ cacheTtl:1800 } });
    const d    = await r.json();
    const items = (d?.news ?? []).slice(0,8).map(n => ({ title:n.title, publisher:n.publisher, date:n.providerPublishTime ? new Date(n.providerPublishTime*1000).toISOString().slice(0,10):'N/A', link:n.link||'' }));
    return new Response(JSON.stringify({ items }), { headers: CORS });
  } catch (e) { return new Response(JSON.stringify({ items:[] }), { headers: CORS }); }
}

// ─── runWarrantScan ───────────────────────────────────────────────────────────
async function runWarrantScan(env, tickers = TK_CORE, sendTg = true) {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] Scan de ${tickers.length} tickers...`);
  await getYahooSession(env);

  const vix    = await fetchVSTOXX(env);
  const regime = await fetchRegime(env);
  if (regime) console.log(`Régime: ${regime.profile.emoji} ${regime.regimeName} / ${regime.profile.profile} (kelly×${regime.profile.kelly})`);

  const bars = {}, errors = [];
  for (let i = 0; i < tickers.length; i++) {
    const tk = tickers[i];
    try {
      const b = await fetchBars(tk.t, '1y', '1d', env);
      if (b.length > 70) bars[tk.t] = b;
      else errors.push(`${tk.t}: données insuffisantes (${b.length} bougies)`);
    } catch (e) { errors.push(`${tk.t}: ${e.message}`); }
    await sleep(100);
  }

  const barsMeta = {};
  for (const tk of tickers) {
    if (!bars[tk.t]) continue;
    const ind = scanIndicators(bars[tk.t]);
    const sig = ind ? detectSignal(ind) : null;
    const bs  = ind ? blackScholes(ind.price, ind.price, 90/365, ind.vol60/100) : null;
    barsMeta[tk.t] = { tk, ind, sig, bs };
  }

  const result     = buildFinalResult(barsMeta, vix, errors, new Date().toISOString(), env, regime);
  result._barsMeta = barsMeta;
  result.regime    = regime;
  result.duration  = Date.now() - started;

  if (sendTg) {
    await env.TRADING_KV.put('last_result', JSON.stringify(result)).catch(() => {});
    const raw = await env.TRADING_KV.get('history').catch(() => null);
    const history = raw ? JSON.parse(raw) : [];
    history.unshift({ date:result.timestamp, count:result.signals.length, tickers:result.signals.map(a=>a.ticker) });
    if (history.length > 30) history.length = 30;
    await env.TRADING_KV.put('history', JSON.stringify(history)).catch(() => {});

    const notRaw = await env.TRADING_KV.get('notified').catch(() => null);
    const notified = notRaw ? JSON.parse(notRaw) : {};
    const nowTs = Date.now();
    const COOLDOWN_MS = 7*24*3600*1000;
    for (const k of Object.keys(notified)) if (nowTs - notified[k] > COOLDOWN_MS) delete notified[k];
    const newSigs = result.signals.filter(s => !notified[s.ticker]);
    for (const s of newSigs) notified[s.ticker] = nowTs;
    await env.TRADING_KV.put('notified', JSON.stringify(notified)).catch(() => {});

    const exits = await checkPositionsForExits(env);
    const sellRaw = await env.TRADING_KV.get('notified_sells').catch(() => null);
    const sellNotified = sellRaw ? JSON.parse(sellRaw) : {};
    const SELL_COOLDOWN_MS = 24*3600*1000;
    for (const k of Object.keys(sellNotified)) if (nowTs - sellNotified[k] > SELL_COOLDOWN_MS) delete sellNotified[k];
    const newToSell = exits.toSell.filter(p => !sellNotified[p.ticker]);
    for (const p of newToSell) sellNotified[p.ticker] = nowTs;
    await env.TRADING_KV.put('notified_sells', JSON.stringify(sellNotified)).catch(() => {});

    await sendTelegram(newSigs, vix, errors, env, result.capital, regime, { ...exits, toSell:newToSell }).catch(e => console.error('Telegram:', e.message));
  }

  console.log(`Scan terminé : ${result.scanned}/${tickers.length} OK, ${result.signals.length} signaux, ${result.duration}ms`);
  return result;
}

// ─── buildFinalResult ─────────────────────────────────────────────────────────
function buildFinalResult(barsMeta, vix, errors, timestamp, env, regime, netLiquidity) {
  const CAPITAL_ENV = Number(env?.CAPITAL_EUR) > 0 ? Number(env.CAPITAL_EUR) : 10000;
  let CAPITAL = CAPITAL_ENV, capitalSource = 'env_fixe';
  if (netLiquidity && netLiquidity > 0) {
    CAPITAL = Math.max(netLiquidity, CAPITAL_ENV * 0.50);
    capitalSource = netLiquidity >= CAPITAL_ENV * 0.50 ? 'net_liquidity' : 'floor_50pct';
  }

  const NB_ACC      = Number(env?.NB_ACCOUNTS) === 2 ? 2 : 1;
  const CAP_PER_ACC = CAPITAL / NB_ACC;

  const regKellyMult  = regime ? regime.profile.kelly     : 1.00;
  const regCapMult    = regime ? regime.profile.capMult   : 1.00;
  const regAllowEntry = regime ? regime.profile.allowEntry : true;
  const regZThreshAdd = regime ? regime.profile.zThreshAdd : 0;

  const allResults = Object.values(barsMeta).map(({ tk, ind, sig, bs }) => ({ ...tk, ind, sig, bs }));
  for (const r of allResults) r.sectorCorr = r.sig ? sectorCorrelation(r, allResults) : null;

  const vixAmplitude = env?.VIX_AMPLITUDE || 'normal';
  const vixMult      = vix ? vixMultiplier(vix.current, vixAmplitude) : 1.0;
  const vixDailyCap  = vix ? (vix.current<15?0.50:vix.current<20?0.60:vix.current<25?0.70:vix.current<30?0.80:0.90) : 0.60;

  let capA = 0, capB = 0;
  const MAX_A = CAP_PER_ACC * vixDailyCap * regCapMult;
  const MAX_B = NB_ACC === 2 ? CAP_PER_ACC * vixDailyCap * regCapMult : 0;
  const MAX_SECTOR_PCT = 0.35;
  const sectorExposure = {};

  const alerts = allResults
    .filter(r => r.sig)
    .sort((a, b) => Math.abs(b.ind.z) - Math.abs(a.ind.z))
    .map(al => {
      const isFlash = al.ind.z < -3.0 && al.ind.rsi < 20 && al.ind.sqFresh;
      let regimeBlocked = !regAllowEntry;
      let regimeFiltered = !regimeBlocked && regZThreshAdd > 0 && Math.abs(al.ind.z) < (2.5 + regZThreshAdd);

      let szPct = computeSizing(al.ind.z, al.ind.rsi, al.ind.sq, al.ind.ret63, isFlash, al.s, vixMult);
      szPct *= regKellyMult;
      let szAdj = szPct;

      // mm200Mult désactivé (Test v24.1 — filtre rejeté OOS)
      const mm200Mult = 1;

      const scanDate = new Date(timestamp);
      const isFriday = scanDate.getDay() === 5;
      const projectedMatu = Math.abs(al.ind.z) >= SCAN_CFG.oneMonthZ ? '1M' : '3M';
      if (isFriday) szAdj *= projectedMatu === '1M' ? 0.80 : 0.95;

      if (al.sectorCorr?.status === 'idiosyncratic') szAdj *= 0.7;
      else if (al.sectorCorr?.status === 'sectorial') szAdj *= 1.1;

      szAdj = Math.min(0.25, szAdj);
      if (regimeBlocked || regimeFiltered) szAdj = 0;

      const warrantPrice  = al.bs?.price || 0;
      const requestedEur  = Math.round(CAPITAL * szAdj);

      let account = 'A', amountEur = 0, overflow = false;
      if (regimeBlocked || regimeFiltered) { account = 'OFF'; amountEur = 0; }
      else if (NB_ACC === 1) {
        const avail = MAX_A - capA;
        amountEur = Math.min(requestedEur, Math.max(0, avail));
        if (amountEur > 0) capA += amountEur; else overflow = true;
      } else {
        const availA = MAX_A - capA;
        if (availA >= requestedEur) { amountEur = requestedEur; capA += amountEur; account = 'A'; }
        else if (availA > 0) {
          const toA = availA, toB = Math.min(requestedEur - toA, MAX_B - capB);
          amountEur = toA + toB; capA += toA; capB += toB;
          account = toB > 0 ? 'A+B' : 'A';
          if (toB === 0 && toA < requestedEur) overflow = true;
        } else {
          const availB = MAX_B - capB;
          amountEur = Math.min(requestedEur, Math.max(0, availB));
          if (amountEur > 0) { capB += amountEur; account = 'B'; } else overflow = true;
        }
      }

      const qty  = warrantPrice > 0 ? Math.floor(amountEur / warrantPrice / 100) * 100 : 0;
      const matu = Math.abs(al.ind.z) >= SCAN_CFG.oneMonthZ ? '1M' : '3M';

      // Cap sectoriel 35%
      const sector = al.s || 'Divers';
      const maxSectorEur = CAPITAL * MAX_SECTOR_PCT;
      let sectorCapped = false;
      if (amountEur > 0 && (sectorExposure[sector]||0) + amountEur > maxSectorEur) {
        const allowed = Math.max(0, maxSectorEur - (sectorExposure[sector]||0));
        if (allowed < amountEur) {
          const surplus = amountEur - allowed;
          if (account==='A') capA-=surplus; else if (account==='B') capB-=surplus; else { capA-=surplus/2; capB-=surplus/2; }
          amountEur = Math.round(allowed); sectorCapped = true;
        }
      }
      if (amountEur > 0) sectorExposure[sector] = (sectorExposure[sector]||0) + amountEur;

      const maturityDays = matu === '1M' ? 30 : 90;
      const exitRules = {
        tpUnderlying:   al.sig.dir==='CALL' ? al.ind.price*1.03 : al.ind.price*0.97,
        slUnderlying:   al.sig.dir==='CALL' ? al.ind.price*0.95 : al.ind.price*1.05,
        tpWarrant:      warrantPrice*1.20,
        tpWarrantUltra: warrantPrice*1.30,
        minHoldDays:    3,
        maxHoldDays:    maturityDays,
        thetaCritical:  matu==='1M' ? '7 jours restants' : '15 jours restants',
      };

      return {
        ticker:     al.t,
        name:       al.n,
        sector:     al.s,
        price:      al.ind.price,
        direction:  al.sig.dir,
        confidence: al.sig.conf,
        reason:     al.sig.reason,
        indicators: {
          z:al.ind.z, rsi:al.ind.rsi, vol60:al.ind.vol60,
          ret5:Math.round(al.ind.ret5*1000)/10,
          ret63:al.ind.ret63, sq:al.ind.sq, ivRatio:al.ind.ivRatio,
          aboveMM200:al.ind.aboveMM200, mm200:al.ind.mm200,
          gapRisk:al.ind.gapRisk, gapPct:al.ind.gapPct,
        },
        sizing: {
          szPct:        Math.round(szAdj*1000)/10,
          amountEur,    requestedEur,
          account,      overflow,
          warrantPrice: Math.round(warrantPrice*10000)/10000,
          qty,          vixMult,
          capitalTotal: CAPITAL, capitalSource,
          nbAccounts:   NB_ACC,
          mm200Mult:    Math.round(mm200Mult*100)/100,
          isFriday,     sectorCapped,
        },
        // ── Infos warrant pour Telegram ──
        warrant: {
          strike: Math.round(al.ind.price * 100) / 100,  // ATM = cours actuel
          delta:  al.bs?.delta ?? null,
          lever:  al.bs?.lever ?? null,
          parity: 1,  // parité unitaire (modèle BS brut)
        },
        sectorCorr: al.sectorCorr ? { status:al.sectorCorr.status, reason:al.sectorCorr.reason } : null,
        matu, isFlash,
        issuer:    recommendIssuer(al.t),
        entryDate: new Date(timestamp).toISOString().slice(0,10),
        exitRules,
      };
    })
    .filter(a => a.sizing.amountEur > 0 || a.sizing.overflow);

  return {
    signals: alerts,
    vix:     vix ? { current:vix.current, regime:vix.regime, mult:vixMult, dailyCap:vixDailyCap, amplitude:vixAmplitude } : null,
    regime:  regime ? {
      name:regime.regimeName, profile:regime.profile.profile,
      kelly:regime.profile.kelly, capMult:regime.profile.capMult,
      allowEntry:regime.profile.allowEntry, zThreshAdd:regime.profile.zThreshAdd,
      emoji:regime.profile.emoji, confidence:Math.round(regime.confidence*100)/100,
      proxy:regime.proxy,
      features:{ sigma20:Math.round(regime.features.sigma20*1000)/1000, sigma60:Math.round(regime.features.sigma60*1000)/1000, ratio:Math.round(regime.features.ratio*100)/100, ret20:Math.round(regime.features.ret20*1000)/1000, absret5:Math.round(regime.features.absret5*1000)/1000 },
    } : null,
    capital:  { total:CAPITAL, nbAccounts:NB_ACC, perAccount:CAP_PER_ACC, dailyCapPct:vixDailyCap, dailyCapEffective:vixDailyCap*regCapMult },
    scanned:  Object.keys(barsMeta).length,
    errors,   timestamp,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INDICATEURS TECHNIQUES
// ═══════════════════════════════════════════════════════════════════════════════
function precompute(bars) {
  const n = bars.length;
  if (n < 70) return null;
  const c = bars.map(b => b.c);
  const lr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i-1]);

  function rv(w) {
    const o = new Array(n).fill(0);
    for (let i = w; i < n; i++) {
      let s = 0, s2 = 0;
      for (let j = i-w+1; j <= i; j++) { s += lr[j]; s2 += lr[j]*lr[j]; }
      o[i] = Math.sqrt(Math.max(0, (s2/w - (s/w)**2) * 252));
    }
    return o;
  }

  const v5 = rv(5), v21 = rv(21), v60 = rv(60);

  const rsi = new Array(n).fill(50);
  const P = 14;
  let ag = 0, al = 0;
  for (let i = 1; i <= P && i < n; i++) { const d = c[i]-c[i-1]; if (d>0) ag+=d; else al-=d; }
  ag /= P; al /= P;
  if (P < n) rsi[P] = al===0 ? 100 : 100 - 100/(1+ag/al);
  for (let i = P+1; i < n; i++) {
    const d = c[i]-c[i-1];
    ag = (ag*(P-1) + (d>0?d:0)) / P;
    al = (al*(P-1) + (d<0?-d:0)) / P;
    rsi[i] = al===0 ? 100 : 100 - 100/(1+ag/al);
  }

  const avgVol = new Array(n).fill(0);
  for (let i = 21; i < n; i++) {
    let sv = 0;
    for (let j = i-20; j <= i; j++) sv += (bars[j].v||0)*c[j];
    avgVol[i] = sv/21;
  }
  return { c, v5, v21, v60, rsi, n, avgVol };
}

function scanIndicators(bars) {
  const ind = precompute(bars);
  if (!ind) return null;
  const d = ind.n - 1;
  const vol60 = ind.v60[d];
  if (vol60 < 0.01) return null;

  const ret5 = (ind.c[d] - ind.c[d-5]) / ind.c[d-5];
  const z    = ret5 / (vol60 / Math.sqrt(252) * Math.sqrt(5));
  const rsi  = ind.rsi[d] || 50;

  let gapRisk = 'none', gapPct = 0;
  if (d >= 2 && ind.c[d-1] > 0) {
    gapPct = (ind.c[d] - ind.c[d-1]) / ind.c[d-1];
    if (gapPct < -0.03)      gapRisk = 'high';
    else if (gapPct < -0.01) gapRisk = 'moderate';
  }

  let sq = false, sqFresh = false;
  for (let k = 1; k <= 10; k++) {
    const i2 = d - k;
    if (i2 < 21) break;
    if (ind.v21[i2] > 0.01 && ind.v5[i2]/ind.v21[i2] < 0.8) {
      sq = true;
      if (k <= 3) sqFresh = true;
      break;
    }
  }

  const ret63 = d >= 63 ? (ind.c[d] - ind.c[d-63]) / ind.c[d-63] : 0;

  let ivRatio = null;
  const v5d = ind.v5[d], v21d = ind.v21[d];
  if (v5d > 0.005 && v21d > 0.005) ivRatio = Math.round(v5d/v21d*100)/100;

  let mm200 = null, aboveMM200 = null;
  if (ind.n >= 200) {
    let s = 0;
    for (let i = d-199; i <= d; i++) s += ind.c[i];
    mm200 = s/200;
    aboveMM200 = ind.c[d] >= mm200;
  }

  return {
    price:  ind.c[d],
    ret5,
    z:      Math.round(z*100)/100,
    rsi:    Math.round(rsi),
    vol60:  Math.round(vol60*1000)/10,
    sq, sqFresh,
    ret63:  Math.round(ret63*1000)/10,
    ivRatio, gapRisk,
    gapPct: Math.round(gapPct*1000)/10,
    mm200:  mm200 ? Math.round(mm200*100)/100 : null,
    aboveMM200,
  };
}

// ─── Config TURBO + VIX-INV (profil validé PF=2.03) ──────────────────────────
const SCAN_CFG = {
  flashBoost:  1.5,
  weakSectors: [],
  weakMonths:  [],
  weakMult:    0.4,
  goodBoost:   1.3,
  sizingCap:   0.25,
  oneMonthZ:   2.5,
};

function detectSignal(a) {
  if (!a) return null;
  if (a.z < -2.5 && a.rsi < 25 && a.sq && Math.abs(a.ret63) < 15) return { dir:'CALL', conf:'H', reason:`Chute extrême ${a.z}σ · RSI ${a.rsi} · squeeze` };
  if (a.z < -2.0 && a.rsi < 30 && a.sq && Math.abs(a.ret63) < 15) return { dir:'CALL', conf:'M', reason:`Chute forte ${a.z}σ · RSI ${a.rsi} · squeeze confirmé J+1` };
  if (a.z >  3.0 && a.rsi > 75 && a.sq && Math.abs(a.ret63) < 15) return { dir:'PUT',  conf:'M', reason:`Hausse extrême ${a.z}σ · RSI ${a.rsi}` };
  return null;
}

function sectorCorrelation(target, allResults) {
  const peers = allResults.filter(r => r.s === target.s && r.t !== target.t && r.ind?.ret5 != null);
  if (peers.length < 2) return { status:'unknown', reason:'Moins de 2 peers' };
  const peerMean = peers.reduce((s, p) => s + p.ind.ret5, 0) / peers.length * 100;
  const myRet5   = target.ind.ret5 * 100;
  const diff     = myRet5 - peerMean;
  if (diff < -3 && peerMean > -2) return { status:'idiosyncratic', reason:`Chute idiosyncratique : ${myRet5.toFixed(1)}% vs secteur ${peerMean.toFixed(1)}%` };
  if (peerMean < -2 && diff > -1) return { status:'sectorial',     reason:`Chute sectorielle : secteur ${peerMean.toFixed(1)}%` };
  return { status:'neutral', reason:`Secteur mixte : action ${myRet5.toFixed(1)}% vs peers ${peerMean.toFixed(1)}%` };
}

function computeSizing(z, rsi, sq, ret63, isFlash, sector, vixMult, cfg = SCAN_CFG) {
  const absZ = Math.abs(z);
  let sz = absZ >= 4 ? 0.18 : absZ >= 3.5 ? 0.15 : absZ >= 3 ? 0.12 : Math.min(0.10, 0.07*absZ/2.5);
  if (isFlash) sz *= (cfg.flashBoost || 1.5);
  const month = new Date().getMonth();
  const wS = (cfg.weakSectors||[]).includes(sector);
  const wM = (cfg.weakMonths||[]).includes(month);
  if (wS || wM) sz *= (cfg.weakMult || 0.4);
  const good = !wS && !wM && absZ >= 2.5;
  if (good) sz *= (cfg.goodBoost || 1.3);
  sz *= (vixMult || 1);
  return Math.min(cfg.sizingCap||0.25, Math.max(0.03, sz));
}

function normalCDF(x) {
  const a = [0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1/(1+p*x);
  const y = 1 - (((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t)*Math.exp(-x*x);
  return 0.5*(1+sign*y);
}

function blackScholes(S, K, T, sig) {
  if (T <= 0 || sig <= 0) return { price:Math.max(0,S-K), delta:S>K?1:0, lever:0 };
  const d1 = (Math.log(S/K) + (0.035-0.015+0.5*sig*sig)*T) / (sig*Math.sqrt(T));
  const d2 = d1 - sig*Math.sqrt(T);
  const price = S*Math.exp(-0.015*T)*normalCDF(d1) - K*Math.exp(-0.035*T)*normalCDF(d2);
  const delta = Math.exp(-0.015*T)*normalCDF(d1);
  return {
    price: Math.max(0, price),
    delta: Math.round(delta*1000)/1000,
    lever: price > 0.001 ? Math.round(delta*S/price*10)/10 : 0,
  };
}

function recommendIssuer(ticker) {
  const suffix = ticker.split('.').pop();
  const bigCap = ['AIR.PA','MC.PA','TTE.PA','SAN.PA','OR.PA','BNP.PA','SU.PA','AI.PA','RMS.PA','SAF.PA','CS.PA'].includes(ticker);
  switch (suffix) {
    case 'PA': return bigCap ? 'Société Générale (leader spreads CAC40)' : 'BNP Paribas (mid-caps SBF120)';
    case 'DE': return 'Unicredit (leader DAX, spreads serrés)';
    default:   return 'BNP Paribas';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════════
//  VIX / VSTOXX
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchVSTOXX(env) {
  for (const tk of ['V2TX.DE', '^VIX']) {
    try {
      const bars = await fetchBars(tk, '3mo', '1d', env);
      if (!bars.length) continue;
      const current = bars[bars.length-1].c;
      const avg60   = bars.slice(-60).reduce((s,b) => s+b.c, 0) / Math.min(60, bars.length);
      const regime  = current<15?'calme':current<20?'normal':current<25?'tension':current<30?'stress':'crise';
      return { ticker:tk, current, avg60, regime };
    } catch (e) {}
  }
  return null;
}

function vixMultiplier(vix, amplitude) {
  const amp = amplitude || 'normal';
  if (amp === 'extreme') {
    if (vix < 15) return 0.70;
    if (vix < 20) return 1.00;
    if (vix < 25) return 1.25;
    if (vix < 30) return 1.50;
    return 2.00;
  }
  if (vix < 15) return 0.85;
  if (vix < 20) return 1.00;
  if (vix < 25) return 1.15;
  if (vix < 30) return 1.30;
  return 1.50;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RÉGIME K-MEANS v22
// ═══════════════════════════════════════════════════════════════════════════════
function regimeComputeFeatures(bars) {
  if (!bars || bars.length < 60) return null;
  const n = bars.length;
  const c = bars.map(b => b.c);
  const lr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i]/c[i-1]);
  function rs(w) {
    if (w >= n) return null;
    let s = 0, s2 = 0;
    for (let i = n-w; i < n; i++) { s += lr[i]; s2 += lr[i]*lr[i]; }
    const m = s/w;
    return Math.sqrt(Math.max(0, (s2/w - m*m)*252));
  }
  const sig20 = rs(20), sig60 = rs(60);
  if (sig20 === null || sig60 === null) return null;
  return { sigma20:sig20, sigma60:sig60, ratio:sig60>1e-6?sig20/sig60:1, ret20:Math.log(c[n-1]/c[n-21]), absret5:Math.abs(Math.log(c[n-1]/c[n-6])) };
}

function regimeStandardize(f) {
  return [
    (f.sigma20 - REGIME_REF_STATS.sigma20.median) / (REGIME_REF_STATS.sigma20.mad * 1.4826),
    (f.sigma60 - REGIME_REF_STATS.sigma60.median) / (REGIME_REF_STATS.sigma60.mad * 1.4826),
    (f.ratio   - REGIME_REF_STATS.ratio.median)   / (REGIME_REF_STATS.ratio.mad   * 1.4826),
    (f.ret20   - REGIME_REF_STATS.ret20.median)   / (REGIME_REF_STATS.ret20.mad   * 1.4826),
    (f.absret5 - REGIME_REF_STATS.absret5.median) / (REGIME_REF_STATS.absret5.mad * 1.4826),
  ];
}

function regimeClassify(features) {
  if (!features) return null;
  const x = regimeStandardize(features);
  const dists = REGIME_CENTROIDS.map(ctr => {
    let d = 0;
    for (let j = 0; j < x.length; j++) { const dx = x[j]-ctr[j]; d += dx*dx; }
    return Math.sqrt(d);
  });
  let bestC = 0, bestD = Infinity;
  for (let c = 0; c < dists.length; c++) if (dists[c] < bestD) { bestD = dists[c]; bestC = c; }
  const sorted = [...dists].sort((a,b) => a-b);
  return { regimeId:bestC, regimeName:REGIME_PROFILES[bestC].name, profile:REGIME_PROFILES[bestC], distance:bestD, confidence:sorted[1]/Math.max(0.01,sorted[0]), features };
}

async function fetchRegime(env) {
  for (const proxy of ['^FCHI', '^GDAXI', '^STOXX50E']) {
    try {
      const bars = await fetchBars(proxy, '1y', '1d', env);
      if (!bars.length || bars.length < 70) continue;
      const features = regimeComputeFeatures(bars);
      if (!features) continue;
      const det = regimeClassify(features);
      if (det) { det.proxy = proxy; return det; }
    } catch (e) {}
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RECOMMANDATIONS DE SORTIE — positions ouvertes
// ═══════════════════════════════════════════════════════════════════════════════
function parseDateSafe(s) { const d = new Date(s); return isNaN(d) ? null : d; }
function daysBetween(d1, d2) { return Math.floor((d2-d1) / (24*3600*1000)); }

function recommendForPosition(position, bars) {
  if (!bars || !bars.length) return { action:'INCONNU', color:'D', reason:'Bars sous-jacent indisponibles' };
  const S   = bars[bars.length-1].c;
  const ind = precompute(bars);
  if (!ind) return { action:'INCONNU', color:'D', reason:'Historique insuffisant pour vol' };
  const sig        = ind.v60[ind.n-1] || 0.25;
  const entryDate  = parseDateSafe(position.date);
  const now        = new Date();
  const daysHeld   = entryDate ? daysBetween(entryDate, now) : 0;
  const maxDays    = position.matu === '1M' ? 30 : 90;
  const Tremaining = Math.max((maxDays - daysHeld)/365, 0.001);

  let currentPrice;
  if (position.type === 'CALL') currentPrice = blackScholes(S, position.strike, Tremaining, sig).price;
  else currentPrice = Math.max(0.001, blackScholes(position.strike, S, Tremaining, sig).price);

  const warrantPnL    = (currentPrice - position.price) / position.price;
  const underlyingPnL = (S - position.entryS) / position.entryS;

  if (warrantPnL >= 0.30 && daysHeld <= 5) return { action:'VENDRE', color:'G', reason:`🎯 TP ULTRA : warrant +${(warrantPnL*100).toFixed(1)}% en ${daysHeld}j`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (warrantPnL >= 0.25)                  return { action:'VENDRE', color:'G', reason:`✅ TP WARRANT : +${(warrantPnL*100).toFixed(1)}% atteint`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (position.type==='CALL' && underlyingPnL >= 0.03)  return { action:'VENDRE', color:'G', reason:`✅ TP SOUS-JACENT CALL : +${(underlyingPnL*100).toFixed(1)}%`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (position.type==='CALL' && underlyingPnL <= -0.05) return { action:'VENDRE', color:'R', reason:`🛑 STOP LOSS CALL : sous-jacent ${(underlyingPnL*100).toFixed(1)}%`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (position.type==='PUT'  && underlyingPnL <= -0.03) return { action:'VENDRE', color:'G', reason:`✅ TP SOUS-JACENT PUT : ${(underlyingPnL*100).toFixed(1)}%`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (position.type==='PUT'  && underlyingPnL >= 0.05)  return { action:'VENDRE', color:'R', reason:`🛑 STOP LOSS PUT : sous-jacent +${(underlyingPnL*100).toFixed(1)}%`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  const holdMax = position.matu === '1M' ? 10 : 14;
  if (daysHeld >= holdMax) return { action:'VENDRE', color:'Y', reason:`⏰ HOLD MAX (${holdMax}j) atteint`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  if (position.matu==='1M' && (maxDays-daysHeld) <= 7) return { action:'VENDRE', color:'Y', reason:`⏰ THETA CRITIQUE : ${maxDays-daysHeld}j avant expiration 1M`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
  return { action:'CONSERVER', color:'A', reason:`Position en cours — ${daysHeld}j détenu, warrant ${warrantPnL>=0?'+':''}${(warrantPnL*100).toFixed(1)}%`, currentPrice, warrantPnL, underlyingPnL, daysHeld };
}

async function checkPositionsForExits(env) {
  let stored = null;
  try { const raw = await env.TRADING_KV.get('user_positions'); if (raw) stored = JSON.parse(raw); }
  catch (e) { return { toSell:[], toHold:[], errors:['KV read failed: '+e.message] }; }
  if (!stored || !Array.isArray(stored.positions) || stored.positions.length === 0) {
    return { toSell:[], toHold:[], errors:[], note:"Aucune position synchronisée — utilisez le bouton 'Sync vers worker' dans l'app" };
  }
  const updateAge = stored.updatedAt ? (Date.now() - new Date(stored.updatedAt).getTime())/86400000 : null;
  const toSell = [], toHold = [], errors = [];
  for (const p of stored.positions) {
    try {
      const bars = await fetchBars(p.ticker, '6mo', '1d', env);
      if (!bars.length) { errors.push(`${p.ticker}: bars indisponibles`); continue; }
      const rec      = recommendForPosition(p, bars);
      const enriched = { ...p, recommendation:rec };
      if (rec.action === 'VENDRE')    toSell.push(enriched);
      else if (rec.action === 'CONSERVER') toHold.push(enriched);
    } catch (e) { errors.push(`${p.ticker}: ${e.message}`); }
    await sleep(150);
  }
  return { toSell, toHold, errors, updateAge, totalPositions:stored.positions.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TELEGRAM — sendTelegram
// ═══════════════════════════════════════════════════════════════════════════════
async function sendTelegram(alerts, vix, errors, env, capitalInfo, regime, exits) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) { console.log('[sendTelegram] SKIP : token/chat_id absent'); return; }

  exits  = exits  || { toSell:[], toHold:[], errors:[] };
  alerts = alerts || [];

  const date = new Date().toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', timeZone:'Europe/Paris' });
  const calls = alerts.filter(a => a.direction === 'CALL');
  const puts  = alerts.filter(a => a.direction === 'PUT');
  const nBuy  = alerts.length, nSell = exits.toSell.length, nHold = exits.toHold.length;
  const isPanic = regime && !regime.profile.allowEntry;

  const regimeLine = regime ? `\n🎯 *Régime* : ${regime.profile.emoji} ${regime.regimeName} → profil *${regime.profile.profile}* (kelly ×${regime.profile.kelly.toFixed(2)} · cap ×${regime.profile.capMult.toFixed(2)})` : '';
  const vixLine    = vix    ? `\n📡 *VSTOXX* : ${vix.current.toFixed(1)} _(${vix.regime.toUpperCase()})_ → sizing ×${(vix.mult||vixMultiplier(vix.current,'normal')).toFixed(2)} · cap ${Math.round((vix.dailyCap||0.6)*100)}%/compte` : '';
  const capLine    = capitalInfo ? `\n💼 *Capital* : ${capitalInfo.total.toLocaleString('fr-FR')}€ · ${capitalInfo.nbAccounts} compte(s)${capitalInfo.nbAccounts===2?' (A+B)':''}` : '';

  let msg;

  if (isPanic) {
    msg  = `⛔ *WARRANTPRO — RÉGIME ${regime.regimeName}*\n_${date}_\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔴 Régime : *${regime.regimeName}* (${regime.profile.profile})\n`;
    msg += `📊 Confiance K-means : ×${regime.confidence.toFixed(2)}\n`;
    msg += `📉 σ20=${(regime.features.sigma20*100).toFixed(0)}% · ret20=${(regime.features.ret20*100).toFixed(1)}%${vixLine}\n\n`;
    msg += `*🚫 Aucune nouvelle entrée recommandée aujourd'hui.*\n\n`;
    if (nSell > 0) { msg += `🟠 *${nSell} POSITION(S) À VENDRE* :\n━━━━━━━━━━━━━━━━━━━━━━\n`; for (const p of exits.toSell.slice(0,8)) msg += buildExitBlock(p); }
    else if (exits.toHold.length > 0) msg += `📌 ${exits.toHold.length} position(s) en CONSERVER.\n\n`;
    else if (exits.note) msg += `_${exits.note}_\n\n`;
    msg += `_Validation empirique v22 : régime-switching évite -36% MaxDD_`;

  } else if (nBuy === 0 && nSell === 0) {
    msg  = `😴 *WARRANTPRO — JOURNÉE CALME*\n_${date}_\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*Aucune action requise aujourd'hui.*${regimeLine}${vixLine}${capLine}\n\n`;
    msg += `📊 *Bilan du scan* :\n• Aucun signal nouveau (achat)\n`;
    if (nHold > 0) {
      msg += `• ${nHold} position(s) en CONSERVER (TP/SL/theta OK)\n\n`;
      msg += `📌 *Positions en cours* :\n`;
      for (const p of exits.toHold.slice(0,10)) {
        const pnl = ((p.recommendation.warrantPnL||0)*100).toFixed(1);
        msg += `• ${p.ticker} ${p.type} ${p.matu} : warrant ${Number(pnl)>=0?'+':''}${pnl}% · ${p.recommendation.daysHeld}j détenu\n`;
      }
      msg += `\n`;
    } else if (exits.note) { msg += `• _${exits.note}_\n`; }
    else { msg += `• Aucune position ouverte\n`; }
    msg += `\n_Prochain scan demain matin. Backtest PF=2.01 · cooldown 7j actif_`;

  } else if (nBuy === 0 && nSell > 0) {
    msg  = `🔔 *WARRANTPRO — VENTES À FAIRE*\n_${date}_\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*${nSell} position(s) à VENDRE aujourd'hui*${regimeLine}${vixLine}${capLine}\n\n`;
    msg += `🟠 *${nSell} POSITION(S) À VENDRE* :\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const p of exits.toSell.slice(0,10)) msg += buildExitBlock(p);
    if (nHold > 0) msg += `\n📌 ${nHold} autre(s) en CONSERVER.\n`;
    msg += `\n_Backtest validé · cooldown 7j actif_`;

  } else {
    msg  = `📈 *WARRANTPRO v22 — ${date.toUpperCase()}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*${nBuy} signal(s) ACHAT* : 🟢 ${calls.length} CALL · 🔴 ${puts.length} PUT`;
    if (nSell > 0) msg += ` · ⚠️ *${nSell} à VENDRE*`;
    msg += `${regimeLine}${vixLine}${capLine}\n`;
    msg += `_Backtest validé · 18 tests · PF=2.01 · cooldown 7j actif_\n\n`;

    if (nSell > 0) {
      msg += `🟠 *${nSell} POSITION(S) À VENDRE* (priorité) :\n━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const p of exits.toSell.slice(0,6)) msg += buildExitBlock(p);
      msg += `\n`;
    }
    if (calls.length > 0) {
      msg += `🟢 *CALL — REBOND ATTENDU* (${calls.length})\n━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const al of calls.slice(0,4)) msg += buildSignalBlock(al);
      if (calls.length > 4) msg += `_...et ${calls.length-4} autre(s) CALL (voir /signals)_\n\n`;
    }
    if (puts.length > 0) {
      msg += `🔴 *PUT — REPLI ATTENDU* (${puts.length})\n━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const al of puts.slice(0,2)) msg += buildSignalBlock(al);
      if (puts.length > 2) msg += `_...et ${puts.length-2} autre(s) PUT_\n\n`;
    }
    msg += `📋 *RAPPEL RÈGLES DE SORTIE*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `• ⚡ *TP Warrant +20%* → vendre (+30% si ≤5j = TP ULTRA)\n`;
    msg += `• ✅ *TP sous-jacent +3%* (CALL) → vendre\n`;
    msg += `• ⛔ *SL sous-jacent -5%* (CALL) → vendre impérativement\n`;
    msg += `• ⏱ *minHold 3 jours* avant vente volontaire\n`;
    msg += `• ⌛ *Theta critique* — 1M avec ≤7j restants → vendre\n\n`;
    if (errors.length > 0) msg += `⚠️ _${errors.length} ticker(s) inaccessibles ce scan_\n`;
    msg += `_Informatif uniquement — pas un conseil en investissement_`;
  }

  // Envoi en chunks ≤ 4000 chars
  const chunks = [];
  while (msg.length > 0) {
    if (msg.length <= 4000) { chunks.push(msg); break; }
    const cut = msg.lastIndexOf('\n\n', 4000);
    chunks.push(msg.slice(0, cut > 0 ? cut : 4000));
    msg = msg.slice(cut > 0 ? cut+2 : 4000);
  }
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id:env.TG_CHAT_ID, text:chunk, parse_mode:'Markdown' }),
    });
    if (!res.ok) console.error(`[sendTelegram] ❌ HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
    else console.log(`[sendTelegram] ✅ chunk envoyé (${chunk.length} chars)`);
    if (chunks.length > 1) await sleep(500);
  }
}

// ─── Bloc vente ───────────────────────────────────────────────────────────────
function buildExitBlock(p) {
  const r         = p.recommendation;
  const colorIcon = r.color==='G'?'🟢':r.color==='R'?'🔴':r.color==='Y'?'🟡':'⚪';
  const pnlW  = ((r.warrantPnL||0)*100).toFixed(1);
  const pnlS  = ((r.underlyingPnL||0)*100).toFixed(1);
  const signW = Number(pnlW)>=0?'+':'', signS = Number(pnlS)>=0?'+':'';
  let block  = `\n${colorIcon} *${p.ticker}* — ${p.type} ${p.matu} (strike ${p.strike})\n`;
  block     += `   ${r.reason}\n`;
  block     += `   📊 Warrant : ${signW}${pnlW}% · Sous-jacent : ${signS}${pnlS}% · ${r.daysHeld}j détenu\n`;
  return block;
}

// ─── Bloc achat — MODIFIÉ : valeur actuelle, strike, émetteur, parité ────────
function buildSignalBlock(al) {
  const isCall    = al.direction === 'CALL';
  const icon      = isCall ? '🟢' : '🔴';
  const conf      = al.confidence === 'H' ? '★★★ Signal Fort' : '★★ Signal Modéré';
  const flash     = al.isFlash ? ' ⚡ *FLASH*' : '';
  const urgency   = al.isFlash
    ? '🔴 *URGENT — EXÉCUTER DANS LES 2H*'
    : '🟡 Valide J+1 à l\'ouverture (si pas rebondi +2%)';

  const corrIcon = al.sectorCorr?.status==='idiosyncratic' ? '⚠️ Idiosyncratique'
    : al.sectorCorr?.status==='sectorial' ? '✅ Sectoriel (+10%)' : '➖ Neutre';

  const acctLbl = al.sizing?.account==='A+B' ? 'comptes A+B'
    : al.sizing?.account==='B' ? 'compte B' : 'compte A';

  const overflowWarn = al.sizing?.overflow
    ? `\n  ⚠️ _Cap 60%/compte dépassée — ${al.sizing.amountEur}€ sur ${al.sizing.requestedEur}€ alloués_`
    : '';

  let minHoldDate = '—', maxHoldDate = '—';
  try {
    const entry = new Date(al.entryDate);
    if (!isNaN(entry.getTime())) {
      const maxDays = al.exitRules?.maxHoldDays || 90;
      minHoldDate = new Date(entry.getTime() + 3*86400000).toISOString().slice(0,10);
      maxHoldDate = new Date(entry.getTime() + maxDays*86400000).toISOString().slice(0,10);
    }
  } catch (e) {}

  const wp   = al.sizing?.warrantPrice || 0;
  const tpW  = (al.exitRules?.tpWarrant      || wp*1.20).toFixed(4);
  const tpWU = (al.exitRules?.tpWarrantUltra || wp*1.30).toFixed(4);
  const tpU  = (al.exitRules?.tpUnderlying   || (al.price||0)*(isCall?1.03:0.97)).toFixed(2);
  const slU  = (al.exitRules?.slUnderlying   || (al.price||0)*(isCall?0.95:1.05)).toFixed(2);
  const theta   = al.exitRules?.thetaCritical || '7 jours restants';
  const maxDays = al.exitRules?.maxHoldDays || 90;

  // Infos warrant
  const strike  = al.warrant?.strike ?? al.price ?? 0;
  const delta   = al.warrant?.delta  != null ? al.warrant.delta.toFixed(3) : '~0.500';
  const lever   = al.warrant?.lever  != null ? al.warrant.lever.toFixed(1) : '?';
  const parity  = al.warrant?.parity ?? 1;

  let block = '';
  block += `${icon} *${al.name || al.ticker}* \`${al.ticker}\` — ${al.direction} ${al.matu || ''}${flash}\n`;
  block += `${conf} · ${corrIcon}\n`;
  block += `*${al.reason || ''}*\n\n`;

  // ── Section ACHAT enrichie ──
  block += `📥 *ACHAT*\n`;
  block += `• Valeur actuelle  : \`${(al.price || 0).toFixed(2)}€\` _(${al.name || al.ticker})_\n`;
  block += `• Strike           : \`${strike.toFixed(2)}€\` _(ATM)_\n`;
  block += `• Prix warrant ${al.matu || ''} : \`${wp.toFixed(4)}€\`\n`;
  block += `• Parité           : delta=${delta} · levier ×${lever} · ratio ${parity}:1\n`;
  block += `• Émetteur         : *${typeof al.issuer === 'string' ? al.issuer : (al.issuer?.recommended || 'voir courtier')}*\n`;
  block += `• *Montant : ${(al.sizing?.amountEur || 0).toLocaleString('fr-FR')}€* (${al.sizing?.szPct || 0}% du capital, ${acctLbl})\n`;
  block += `• Quantité estimée : ~${(al.sizing?.qty || 0).toLocaleString('fr-FR')} warrants${overflowWarn}\n`;
  block += `• ${urgency}\n\n`;

  // ── Seuils de sortie ──
  block += `📤 *SEUILS DE SORTIE*\n`;
  block += `• ✅ TP warrant   : \`${tpW}€\` (+20%) ou \`${tpWU}€\` (+30% si ≤5j)\n`;
  block += isCall
    ? `• ✅ TP sous-jacent : \`${tpU}€\` (+3%)\n• ⛔ SL sous-jacent : \`${slU}€\` (-5%)\n`
    : `• ✅ TP sous-jacent : \`${tpU}€\` (-3%)\n• ⛔ SL sous-jacent : \`${slU}€\` (+5%)\n`;
  block += `• ⏱ minHold : pas de vente avant *${minHoldDate}* (J+3)\n`;
  block += `• 📅 maxHold : vendre avant *${maxHoldDate}* (J+${maxDays})\n`;
  block += `• ⌛ Theta critique : ${theta}\n`;

  // ── Indicateurs techniques ──
  const ind = al.indicators || {};
  block += `📊 z=\`${ind.z??'?'}σ\` · RSI=\`${ind.rsi??'?'}\` · Vol60=\`${ind.vol60??'?'}%\` · Ret5=\`${ind.ret5??'?'}%\`\n`;

  if (ind.gapRisk==='high')     block += `⚠️ Gap élevé J-1 (${ind.gapPct!=null?(ind.gapPct>0?'+':'')+ind.gapPct:'?'}%) — vérifier news\n`;
  else if (ind.gapRisk==='moderate') block += `ℹ️ Gap modéré J-1 (${ind.gapPct!=null?(ind.gapPct>0?'+':'')+ind.gapPct:'?'}%)\n`;
  if (ind.aboveMM200===true)  block += `📈 Au-dessus MM200 (${ind.mm200??'?'}€)\n`;
  else if (ind.aboveMM200===false) block += `📉 Sous MM200 (${ind.mm200??'?'}€) — normal pour stratégie MR\n`;

  block += '\n';
  return block;
}
