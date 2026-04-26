/* ============================================================
   VALUATIO — Stock Valuation Engine
   Implements: DCF, CAPM, Relative Valuation, Monte Carlo
   Per Damodaran framework (intrinsic + relative + risk-adjusted)
   ============================================================ */

// ---------- STATE ----------
const state = {
  stock: null,          // raw fetched data
  inputs: {},           // editable assumptions (drives all calcs)
  results: {},          // computed valuations
  mcResults: null,      // monte carlo array
};

// ---------- CONSTANTS (defaults from Damodaran's framework) ----------
const DEFAULTS = {
  riskFreeRate: 0.045,        // ~10Y Treasury, can be overridden
  matureERP: 0.055,           // mature market equity risk premium
  marginalTaxRate: 0.21,      // US corporate
  terminalGrowth: 0.025,      // ≤ risk-free rate per Damodaran
  highGrowthYears: 5,
  defaultBeta: 1.0,
};

// Country Risk Premium table (additive to mature ERP)
// Sourced conceptually from Damodaran's CRP methodology
const COUNTRY_RISK = {
  'United States': 0.0, 'USA': 0.0, 'US': 0.0,
  'United Kingdom': 0.005, 'UK': 0.005, 'Germany': 0.0, 'France': 0.005,
  'Japan': 0.005, 'Canada': 0.0, 'Australia': 0.0, 'Switzerland': 0.0,
  'China': 0.0125, 'India': 0.025, 'Brazil': 0.035, 'Mexico': 0.025,
  'Russia': 0.06, 'South Africa': 0.04, 'Turkey': 0.055, 'Argentina': 0.10,
  'Other Emerging': 0.03, 'Other Developed': 0.005,
};

// ---------- UI: SET UP CLOCK ----------
function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    d.toISOString().slice(0,10) + ' · ' + d.toTimeString().slice(0,5);
}
tickClock();
setInterval(tickClock, 30000);

// ---------- DATA FETCHING ----------
// Yahoo Finance via a CORS-friendly proxy. No API key needed.
// We use query1.finance.yahoo.com via a public CORS proxy.
async function fetchStock(ticker) {
  ticker = ticker.toUpperCase().trim();
  if (!ticker) throw new Error('No ticker');

  const setStatus = (m, c='') => {
    const s = document.getElementById('status');
    s.textContent = m;
    s.className = 'status ' + c;
  };

  setStatus('Fetching ' + ticker + '…');

  // Use a free Yahoo Finance API proxy. We try multiple endpoints for resilience.
  // The "quoteSummary" endpoint gives us almost everything we need in one call.
  const modules = [
    'price','summaryDetail','defaultKeyStatistics','financialData',
    'incomeStatementHistory','cashflowStatementHistory','balanceSheetHistory',
    'assetProfile','earningsTrend'
  ].join(',');

  // Public CORS proxies that mirror Yahoo Finance:
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
  ];

  // We'll route through a free CORS proxy because Yahoo blocks browser CORS.
  // Using corsproxy.io which is free and reliable for this purpose.
  let data = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      const proxied = 'https://corsproxy.io/?' + encodeURIComponent(url);
      const r = await fetch(proxied);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]) {
        data = j.quoteSummary.result[0];
        break;
      }
      if (j.quoteSummary && j.quoteSummary.error) {
        throw new Error(j.quoteSummary.error.description || 'Ticker not found');
      }
    } catch (e) { lastErr = e; }
  }

  if (!data) throw new Error('Could not fetch data: ' + (lastErr?.message || 'unknown'));
  return data;
}

// Pull a numeric value out of Yahoo's nested {raw, fmt} structure
const num = (obj) => {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj.raw === 'number') return obj.raw;
  return null;
};

// ---------- NORMALIZE FETCHED DATA ----------
function normalizeStock(raw) {
  const price = raw.price || {};
  const detail = raw.summaryDetail || {};
  const kstats = raw.defaultKeyStatistics || {};
  const fin = raw.financialData || {};
  const profile = raw.assetProfile || {};
  const incomeHist = raw.incomeStatementHistory?.incomeStatementHistory || [];
  const cashHist = raw.cashflowStatementHistory?.cashflowStatements || [];
  const balanceHist = raw.balanceSheetHistory?.balanceSheetStatements || [];

  // Latest financials
  const inc = incomeHist[0] || {};
  const cf = cashHist[0] || {};
  const bs = balanceHist[0] || {};

  // Historical revenue growth
  let histRevGrowth = null;
  if (incomeHist.length >= 2) {
    const r0 = num(incomeHist[0].totalRevenue);
    const r1 = num(incomeHist[1].totalRevenue);
    if (r0 && r1 && r1 > 0) histRevGrowth = (r0 / r1) - 1;
  }

  // Country: Yahoo gives a country in profile
  let country = profile.country || 'United States';

  return {
    ticker: price.symbol,
    name: price.longName || price.shortName || price.symbol,
    sector: profile.sector || '—',
    industry: profile.industry || '—',
    country,
    currency: price.currency || 'USD',
    // Market data
    price: num(price.regularMarketPrice) || num(detail.previousClose),
    marketCap: num(price.marketCap),
    sharesOutstanding: num(kstats.sharesOutstanding) || num(price.sharesOutstanding),
    beta: num(detail.beta) || num(kstats.beta) || DEFAULTS.defaultBeta,
    pe: num(detail.trailingPE),
    forwardPE: num(detail.forwardPE),
    eps: num(kstats.trailingEps),
    // Financials
    revenue: num(fin.totalRevenue) || num(inc.totalRevenue),
    ebitda: num(fin.ebitda),
    operatingIncome: num(inc.operatingIncome),
    netIncome: num(inc.netIncome),
    capex: Math.abs(num(cf.capitalExpenditures) || 0),
    depreciation: num(cf.depreciation) || 0,
    operatingCashFlow: num(fin.operatingCashflow) || num(cf.totalCashFromOperatingActivities),
    freeCashFlow: num(fin.freeCashflow),
    totalDebt: num(fin.totalDebt) || (num(bs.shortLongTermDebt) || 0) + (num(bs.longTermDebt) || 0),
    cash: num(fin.totalCash) || num(bs.cash) || 0,
    totalEquity: num(bs.totalStockholderEquity),
    // Growth
    revenueGrowth: num(fin.revenueGrowth) || histRevGrowth,
    earningsGrowth: num(fin.earningsGrowth),
    // Margins
    grossMargin: num(fin.grossMargins),
    operatingMargin: num(fin.operatingMargins),
    profitMargin: num(fin.profitMargins),
    returnOnEquity: num(fin.returnOnEquity),
    returnOnAssets: num(fin.returnOnAssets),
    // Multiples for relative
    priceToBook: num(detail.priceToBook),
    enterpriseValue: num(kstats.enterpriseValue),
    evToRevenue: num(kstats.enterpriseToRevenue),
    evToEbitda: num(kstats.enterpriseToEbitda),
    // For dividend approach
    dividendYield: num(detail.dividendYield) || 0,
  };
}

// ---------- BUILD INPUT FORM FROM STOCK DATA ----------
function buildInputs(stock) {
  // Compute initial values (auto-derived, but user can override every one)
  const fcf = stock.freeCashFlow || ((stock.operatingCashFlow || 0) - stock.capex);

  // Foreign revenue: Yahoo doesn't directly expose it. Use heuristic:
  // - Default 0% for US-only signaling, user adjusts
  // - Many large caps are 30-50% international; we let the user dial it
  const foreignRevPct = 0.30; // sane starting default for large cap

  // CRP weighted by foreign revenue exposure
  const domesticCRP = COUNTRY_RISK[stock.country] ?? 0.0;
  const foreignCRPDefault = 0.015; // weighted average emerging+developed

  state.inputs = {
    // === MARKET / SHARES ===
    currentPrice: stock.price || 0,
    sharesOutstanding: stock.sharesOutstanding || 0,
    marketCap: stock.marketCap || 0,

    // === DCF: CASH FLOWS ===
    fcf: fcf || 0,
    revenue: stock.revenue || 0,
    operatingMargin: (stock.operatingMargin ?? 0.15) * 100, // as %
    taxRate: DEFAULTS.marginalTaxRate * 100,

    // === DCF: GROWTH ===
    growthRate: clamp((stock.revenueGrowth ?? stock.earningsGrowth ?? 0.08) * 100, -10, 40),
    growthYears: DEFAULTS.highGrowthYears,
    terminalGrowth: DEFAULTS.terminalGrowth * 100,

    // === COST OF EQUITY (CAPM) ===
    riskFreeRate: DEFAULTS.riskFreeRate * 100,
    beta: stock.beta || DEFAULTS.defaultBeta,
    matureERP: DEFAULTS.matureERP * 100,

    // === COUNTRY / FOREIGN EXPOSURE ===
    homeCountry: stock.country,
    domesticCRP: domesticCRP * 100,
    foreignRevenuePct: foreignRevPct * 100,
    foreignCRP: foreignCRPDefault * 100,

    // === COST OF DEBT ===
    preTaxCostOfDebt: 0.06 * 100,
    totalDebt: stock.totalDebt || 0,
    cash: stock.cash || 0,

    // === RELATIVE VALUATION ===
    sectorPE: stock.pe ? Math.max(8, Math.min(stock.pe * 0.9, 35)) : 18,
    sectorEvEbitda: stock.evToEbitda ? Math.max(6, Math.min(stock.evToEbitda * 0.9, 25)) : 12,
    eps: stock.eps || 0,
    ebitda: stock.ebitda || 0,

    // === MONTE CARLO ===
    growthVol: 3,        // ± percentage points
    marginVol: 2,        // ± percentage points
    discountVol: 1.5,    // ± percentage points
  };

  renderInputs();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- INPUT RENDERER ----------
const INPUT_GROUPS = [
  // [key, label, unit, tooltip]
  ['currentPrice', 'Current Price', '$', 'Latest market price per share'],
  ['sharesOutstanding', 'Shares Outstanding', '#', 'Diluted shares — used to convert enterprise value to per-share value'],
  ['fcf', 'Free Cash Flow (TTM)', '$', 'Trailing twelve-month free cash flow. The cash the business actually generates after reinvestment.'],
  ['growthRate', 'Growth Rate (Year 1)', '%', 'Expected near-term growth in cash flows. Damodaran: anchor to history but check feasibility at scale.'],
  ['growthYears', 'High-Growth Period', 'yrs', 'Years until the company reaches stable growth. Larger firms reach stability faster.'],
  ['terminalGrowth', 'Terminal Growth', '%', 'Perpetual growth after high-growth phase. CANNOT exceed risk-free rate (≈ economy growth).'],
  ['riskFreeRate', 'Risk-Free Rate', '%', '10-year US Treasury yield. The starting point for cost of equity (CAPM).'],
  ['beta', 'Beta', 'β', 'Sensitivity to market movements. >1 = more volatile than market. Bottom-up beta is more reliable than regression beta.'],
  ['matureERP', 'Mature Market ERP', '%', 'Equity risk premium for a mature market like the US (~5.5% historically per Damodaran).'],
  ['domesticCRP', 'Domestic CRP', '%', 'Country Risk Premium for the company\'s home country. Zero for US/developed markets.'],
  ['foreignRevenuePct', 'Foreign Revenue %', '%', 'Percent of revenue from outside the home country. Higher = more diversified country risk.'],
  ['foreignCRP', 'Avg Foreign CRP', '%', 'Weighted-average country risk premium for the company\'s foreign markets.'],
  ['operatingMargin', 'Operating Margin', '%', 'EBIT / Revenue. Used in efficiency-growth checks.'],
  ['taxRate', 'Marginal Tax Rate', '%', 'Long-run tax rate. Use marginal, not effective, for long-horizon models.'],
  ['preTaxCostOfDebt', 'Cost of Debt (pre-tax)', '%', 'What the company pays to borrow today. Risk-free + default spread.'],
  ['totalDebt', 'Total Debt', '$', 'Used in WACC weighting and net-debt adjustment.'],
  ['cash', 'Cash & Equivalents', '$', 'Subtracted as net debt — adds to per-share equity value.'],
  ['sectorPE', 'Sector P/E', 'x', 'Peer-group P/E multiple. The relative-valuation lens.'],
  ['eps', 'EPS (TTM)', '$', 'Trailing earnings per share. Multiplied by sector P/E for relative value.'],
  ['sectorEvEbitda', 'Sector EV/EBITDA', 'x', 'Peer-group EV/EBITDA multiple. Less manipulable than P/E.'],
  ['ebitda', 'EBITDA', '$', 'Earnings before interest, tax, depreciation, amortization.'],
  ['growthVol', 'MC: Growth σ', '±%', 'Standard deviation for growth rate in Monte Carlo simulation.'],
  ['marginVol', 'MC: Margin σ', '±%', 'Standard deviation for margins in Monte Carlo.'],
  ['discountVol', 'MC: Discount Rate σ', '±%', 'Standard deviation for discount rate in Monte Carlo.'],
];

function renderInputs() {
  const wrap = document.getElementById('inputs');
  wrap.innerHTML = INPUT_GROUPS.map(([key, label, unit, tip]) => {
    const v = state.inputs[key];
    const formatted = typeof v === 'number'
      ? (Math.abs(v) > 1e6 ? v.toExponential(3) : (v % 1 === 0 ? v.toString() : v.toFixed(2)))
      : v;
    return `
      <div class="input-cell">
        <label>
          <span data-tip="${tip}">${label}</span>
          <span class="unit">${unit}</span>
        </label>
        <input type="text" data-key="${key}" value="${formatted}" />
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const key = e.target.dataset.key;
      const val = parseFloat(e.target.value);
      if (!isNaN(val)) {
        state.inputs[key] = val;
        recalculate();
      }
    });
  });
}

// ============================================================
//   VALUATION METHODS
// ============================================================

// ---------- CAPM Cost of Equity (Damodaran's lambda approach #2) ----------
// E(Return) = Rf + Beta * (Mature ERP + CRP)
// Where CRP is weighted by domestic vs foreign revenue exposure
function costOfEquity(i) {
  const rf = i.riskFreeRate / 100;
  const beta = i.beta;
  const erp = i.matureERP / 100;

  // Operation-based CRP: weighted avg of domestic and foreign CRPs
  const fwt = i.foreignRevenuePct / 100;
  const dwt = 1 - fwt;
  const blendedCRP = dwt * (i.domesticCRP / 100) + fwt * (i.foreignCRP / 100);

  // Approach 2: company exposure to country risk like other market risk
  const coe = rf + beta * (erp + blendedCRP);
  return { coe, blendedCRP, rf, beta, erp };
}

// ---------- WACC ----------
function wacc(i) {
  const { coe } = costOfEquity(i);
  const cod = i.preTaxCostOfDebt / 100;
  const t = i.taxRate / 100;
  const E = i.marketCap;
  const D = i.totalDebt;
  const V = E + D;
  if (V <= 0) return coe; // pure equity fallback
  const we = E / V;
  const wd = D / V;
  return we * coe + wd * cod * (1 - t);
}

// ---------- DCF (FCF to firm, two-stage) ----------
function dcfValue(i) {
  const r = wacc(i);
  const g1 = i.growthRate / 100;
  const gT = Math.min(i.terminalGrowth / 100, i.riskFreeRate / 100); // cannot exceed Rf
  const years = Math.round(i.growthYears);
  const fcf0 = i.fcf;

  if (fcf0 <= 0 || r <= gT) {
    // Negative FCF or invalid spread — fall back to revenue * margin model
    return fallbackDcf(i, r, g1, gT, years);
  }

  let pvSum = 0;
  let fcf = fcf0;
  // Linear fade from g1 to gT over the high-growth period
  for (let y = 1; y <= years; y++) {
    const fade = (y - 1) / Math.max(years - 1, 1);
    const g = g1 + (gT - g1) * fade;
    fcf = fcf * (1 + g);
    pvSum += fcf / Math.pow(1 + r, y);
  }
  // Terminal value
  const tvCashFlow = fcf * (1 + gT);
  const tv = tvCashFlow / (r - gT);
  const tvPV = tv / Math.pow(1 + r, years);
  const enterpriseValue = pvSum + tvPV;
  const equityValue = enterpriseValue - i.totalDebt + i.cash;
  const perShare = equityValue / i.sharesOutstanding;

  return {
    enterpriseValue, equityValue, perShare,
    discountRate: r, terminalValue: tv, terminalPV: tvPV,
    pvOperatingCF: pvSum,
    tvFraction: tvPV / enterpriseValue,
  };
}

// Used when FCF isn't positive — derive from revenue & margin assumptions
function fallbackDcf(i, r, g1, gT, years) {
  let rev = i.revenue;
  const margin = i.operatingMargin / 100;
  const t = i.taxRate / 100;
  let pvSum = 0;
  let nopat = 0;
  for (let y = 1; y <= years; y++) {
    const fade = (y - 1) / Math.max(years - 1, 1);
    const g = g1 + (gT - g1) * fade;
    rev = rev * (1 + g);
    nopat = rev * margin * (1 - t);
    // Assume reinvestment rate of g/ROIC; rough ROIC of 12%
    const reinvest = nopat * Math.min(g / 0.12, 0.8);
    const fcf = nopat - reinvest;
    pvSum += fcf / Math.pow(1 + r, y);
  }
  const finalFcf = nopat * (1 - gT / 0.12);
  const tv = (finalFcf * (1 + gT)) / (r - gT);
  const tvPV = tv / Math.pow(1 + r, years);
  const ev = pvSum + tvPV;
  const eq = ev - i.totalDebt + i.cash;
  return {
    enterpriseValue: ev, equityValue: eq,
    perShare: eq / i.sharesOutstanding,
    discountRate: r, terminalValue: tv, terminalPV: tvPV,
    pvOperatingCF: pvSum,
    tvFraction: tvPV / ev,
    fallback: true,
  };
}

// ---------- Relative Valuation ----------
function relativeValue(i) {
  const peValue = i.eps > 0 ? i.eps * i.sectorPE : null;
  const evEbitda = i.ebitda > 0 ? i.ebitda * i.sectorEvEbitda : null;
  const ebitdaEquity = evEbitda != null
    ? (evEbitda - i.totalDebt + i.cash) / i.sharesOutstanding
    : null;

  // Blend the two if both available
  let blended = null;
  if (peValue != null && ebitdaEquity != null) {
    blended = (peValue + ebitdaEquity) / 2;
  } else {
    blended = peValue ?? ebitdaEquity;
  }
  return { peValue, evEbitdaPerShare: ebitdaEquity, blended };
}

// ---------- Pure CAPM Justified Price (using Gordon dividend) ----------
// A simpler check: what price is justified by the cost of equity alone?
// V = D1 / (r - g) — using FCF/share as proxy when no dividend
function capmJustified(i) {
  const { coe } = costOfEquity(i);
  const fcfPerShare = i.fcf / i.sharesOutstanding;
  const g = Math.min(i.terminalGrowth / 100, coe - 0.005);
  if (coe - g < 0.005) return { perShare: null, coe };
  const v = (fcfPerShare * (1 + g)) / (coe - g);
  return { perShare: v, coe };
}

// ---------- Monte Carlo ----------
// Simulate the DCF with random draws on growth, margin, discount rate
function monteCarlo(i, n = 10000) {
  const results = [];
  const inputs = { ...i };

  for (let k = 0; k < n; k++) {
    inputs.growthRate = i.growthRate + boxMuller() * i.growthVol;
    inputs.operatingMargin = Math.max(0, i.operatingMargin + boxMuller() * i.marginVol);
    // Discount rate vol applied via beta perturbation
    inputs.beta = Math.max(0.1, i.beta + boxMuller() * (i.discountVol / 5));
    inputs.terminalGrowth = Math.min(i.terminalGrowth, i.riskFreeRate - 0.5);

    const dcf = dcfValue(inputs);
    if (dcf && isFinite(dcf.perShare) && dcf.perShare > 0 && dcf.perShare < i.currentPrice * 20) {
      results.push(dcf.perShare);
    }
  }
  results.sort((a, b) => a - b);
  return results;
}

// Box-Muller transform for normal distribution
function boxMuller() {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ============================================================
//   MAIN RECALCULATION
// ============================================================
function recalculate() {
  const i = state.inputs;
  if (!i.sharesOutstanding || !i.currentPrice) return;

  const dcf = dcfValue(i);
  const rel = relativeValue(i);
  const capm = capmJustified(i);
  const coeData = costOfEquity(i);
  const w = wacc(i);

  state.results = { dcf, rel, capm, coeData, wacc: w };

  // Run Monte Carlo (debounced)
  clearTimeout(state.mcTimer);
  state.mcTimer = setTimeout(() => {
    state.mcResults = monteCarlo(i, 10000);
    renderMonteCarlo();
  }, 200);

  renderResults();
}

// ============================================================
//   RENDERING
// ============================================================
function fmt$(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  return '$' + n.toFixed(dec);
}
function fmtPct(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  return (n * 100).toFixed(dec) + '%';
}
function fmtNum(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(dec);
}

function renderSummary(s) {
  document.getElementById('s-name').textContent = s.name;
  document.getElementById('s-tic').textContent = s.ticker;
  document.getElementById('s-price').textContent = fmt$(s.price);
  document.getElementById('s-mcap').textContent = fmt$(s.marketCap);
  document.getElementById('s-pe').textContent = fmtNum(s.pe);
  document.getElementById('s-beta').textContent = fmtNum(s.beta);
  document.getElementById('s-eps').textContent = fmt$(s.eps);
  document.getElementById('s-sector').textContent = s.sector + ' · ' + s.country;
  document.getElementById('summary').classList.add('visible');
}

function renderResults() {
  const i = state.inputs;
  const { dcf, rel, capm, coeData, wacc: w } = state.results;
  const price = i.currentPrice;

  // Blended fair value: average of available estimates, weighted toward DCF
  const candidates = [];
  if (dcf?.perShare > 0) candidates.push({ v: dcf.perShare, weight: 2 });
  if (rel.blended > 0) candidates.push({ v: rel.blended, weight: 1 });
  if (capm.perShare > 0) candidates.push({ v: capm.perShare, weight: 1 });

  let blended = null;
  if (candidates.length) {
    const sumW = candidates.reduce((a, c) => a + c.weight, 0);
    blended = candidates.reduce((a, c) => a + c.v * c.weight, 0) / sumW;
  }

  document.getElementById('v-fair').textContent = fmt$(blended);
  document.getElementById('v-fair-sub').textContent =
    `DCF ${fmt$(dcf?.perShare)} · Relative ${fmt$(rel.blended)} · CAPM ${fmt$(capm.perShare)}`;

  if (blended && price) {
    const mos = (blended - price) / price;
    const el = document.getElementById('v-mos');
    const sub = document.getElementById('v-mos-sub');
    el.textContent = (mos >= 0 ? '+' : '') + (mos * 100).toFixed(1) + '%';
    el.style.color = mos > 0.10 ? 'var(--green)' : (mos < -0.10 ? 'var(--red)' : 'var(--amber)');
    sub.textContent = mos > 0.10 ? 'UNDERVALUED — market may be missing something'
                    : mos < -0.10 ? 'OVERVALUED — market expects more than fundamentals support'
                    : 'FAIRLY VALUED — market and model agree';
    sub.className = 'sub ' + (mos > 0 ? 'pos' : 'neg');
  }

  // Method cards
  const methodsHTML = [
    {
      num: '01',
      name: 'Discounted Cash Flow',
      sub: 'Intrinsic · two-stage',
      value: fmt$(dcf?.perShare),
      delta: deltaTag(dcf?.perShare, price),
      detail: `
        <strong>WACC:</strong> ${fmtPct(w)}<br>
        <strong>Terminal value share:</strong> ${fmtPct(dcf?.tvFraction)}<br>
        <strong>Method:</strong> ${dcf?.fallback ? 'Margin-based (FCF≤0)' : 'FCF-based'}<br>
        <em style="color:var(--ink-faint)">Cash flows projected ${i.growthYears} years, then perpetuity.</em>
      `
    },
    {
      num: '02',
      name: 'CAPM Justified',
      sub: 'Cost of equity model',
      value: fmt$(capm.perShare),
      delta: deltaTag(capm.perShare, price),
      detail: `
        <strong>Cost of Equity:</strong> ${fmtPct(coeData.coe)}<br>
        <strong>Risk-Free + β·ERP:</strong> ${fmtPct(coeData.rf)} + ${coeData.beta.toFixed(2)}·${fmtPct(coeData.erp + coeData.blendedCRP)}<br>
        <strong>Blended CRP:</strong> ${fmtPct(coeData.blendedCRP)}<br>
        <em style="color:var(--ink-faint)">Damodaran approach #2: country risk via beta.</em>
      `
    },
    {
      num: '03',
      name: 'Relative Valuation',
      sub: 'Multiples · sector peers',
      value: fmt$(rel.blended),
      delta: deltaTag(rel.blended, price),
      detail: `
        <strong>P/E × EPS:</strong> ${fmt$(rel.peValue)}<br>
        <strong>EV/EBITDA implied:</strong> ${fmt$(rel.evEbitdaPerShare)}<br>
        <em style="color:var(--ink-faint)">Markets right on average, wrong on individuals — Damodaran.</em>
      `
    },
    {
      num: '04',
      name: 'Monte Carlo',
      sub: '10,000 simulations',
      value: state.mcResults && state.mcResults.length
        ? fmt$(percentile(state.mcResults, 0.5))
        : '…',
      delta: state.mcResults && state.mcResults.length
        ? deltaTag(percentile(state.mcResults, 0.5), price)
        : '<span style="color:var(--ink-faint)">computing…</span>',
      detail: state.mcResults && state.mcResults.length ? `
        <strong>5th–95th pctile:</strong> ${fmt$(percentile(state.mcResults, 0.05))} – ${fmt$(percentile(state.mcResults, 0.95))}<br>
        <strong>P(undervalued):</strong> ${(state.mcResults.filter(v => v > price).length / state.mcResults.length * 100).toFixed(1)}%<br>
        <em style="color:var(--ink-faint)">Probability bands across uncertainty in growth, margin, discount.</em>
      ` : '<em style="color:var(--ink-faint)">Running simulations…</em>'
    },
  ].map(m => `
    <div class="method-card" data-num="${m.num}">
      <h3>${m.name}</h3>
      <div class="method-sub">${m.sub}</div>
      <div class="method-value">${m.value}</div>
      <div class="method-delta">${m.delta}</div>
      <div class="method-detail">${m.detail}</div>
    </div>
  `).join('');
  document.getElementById('methods').innerHTML = methodsHTML;
}

function deltaTag(estimate, price) {
  if (!estimate || !price) return '<span style="color:var(--ink-faint)">—</span>';
  const d = (estimate - price) / price;
  const cls = d > 0 ? 'pos' : 'neg';
  const color = d > 0 ? 'var(--green)' : 'var(--red)';
  return `<span style="color:${color}">${(d>=0?'+':'') + (d * 100).toFixed(1)}% vs market</span>`;
}

// ---------- MONTE CARLO HISTOGRAM ----------
function renderMonteCarlo() {
  const r = state.mcResults;
  if (!r || r.length === 0) return;

  const canvas = document.getElementById('mc-canvas');
  const ctx = canvas.getContext('2d');

  // Make the canvas hi-dpi
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  // Histogram
  const min = percentile(r, 0.01);
  const max = percentile(r, 0.99);
  const bins = 60;
  const range = max - min;
  const binW = range / bins;
  const counts = new Array(bins).fill(0);
  r.forEach(v => {
    if (v >= min && v <= max) {
      const idx = Math.min(Math.floor((v - min) / binW), bins - 1);
      counts[idx]++;
    }
  });
  const maxCount = Math.max(...counts);

  const padL = 40, padR = 20, padT = 20, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const price = state.inputs.currentPrice;
  const median = percentile(r, 0.5);
  const p5 = percentile(r, 0.05);
  const p95 = percentile(r, 0.95);

  // Draw bars
  counts.forEach((c, idx) => {
    const x = padL + (idx / bins) * plotW;
    const w = plotW / bins - 1;
    const h = (c / maxCount) * plotH;
    const valAtBin = min + (idx + 0.5) * binW;
    // Color by under/over current price
    const isUnder = valAtBin > price;
    ctx.fillStyle = isUnder ? 'rgba(107, 155, 111, 0.7)' : 'rgba(181, 104, 86, 0.7)';
    ctx.fillRect(x, padT + plotH - h, w, h);
  });

  // Vertical lines
  function vline(val, color, label, dashed = false) {
    if (val < min || val > max) return;
    const x = padL + ((val - min) / range) * plotW;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (dashed) ctx.setLineDash([4, 4]); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, padT - 6);
  }

  vline(price, '#e8dfc9', `MARKET $${price.toFixed(2)}`);
  vline(median, '#d4a24c', `MEDIAN $${median.toFixed(2)}`, true);
  vline(p5, '#8a8275', `P5`, true);
  vline(p95, '#8a8275', `P95`, true);

  // X-axis labels
  ctx.fillStyle = '#8a8275';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'left';
  ctx.fillText('$' + min.toFixed(0), padL, padT + plotH + 18);
  ctx.textAlign = 'right';
  ctx.fillText('$' + max.toFixed(0), W - padR, padT + plotH + 18);
  ctx.textAlign = 'center';
  ctx.fillText('Estimated Per-Share Value Distribution', W/2, H - 8);

  // Y label
  ctx.save();
  ctx.translate(12, padT + plotH/2);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center';
  ctx.fillText('Frequency', 0, 0);
  ctx.restore();

  // Stats grid
  const probUnder = r.filter(v => v > price).length / r.length;
  const stats = [
    { l: 'Mean', v: '$' + (r.reduce((a,b)=>a+b,0)/r.length).toFixed(2) },
    { l: 'Median', v: '$' + median.toFixed(2) },
    { l: 'P5', v: '$' + p5.toFixed(2) },
    { l: 'P95', v: '$' + p95.toFixed(2) },
    { l: 'P(undervalued)', v: (probUnder * 100).toFixed(1) + '%' },
  ];
  document.getElementById('mc-stats').innerHTML = stats.map(s =>
    `<div class="mc-stat"><div class="l">${s.l}</div><div class="v">${s.v}</div></div>`
  ).join('');
}

// ============================================================
//   PERSISTENCE (localStorage)
// ============================================================
const STORAGE_KEY = 'valuatio.savedValuations.v1';

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}
function writeSaved(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

function saveCurrent() {
  if (!state.stock) return;
  const arr = loadSaved();
  const entry = {
    id: Date.now(),
    ticker: state.stock.ticker,
    name: state.stock.name,
    price: state.inputs.currentPrice,
    fairValue: getBlendedFairValue(),
    inputs: { ...state.inputs },
    savedAt: new Date().toISOString(),
  };
  // Replace previous valuation for the same ticker
  const filtered = arr.filter(a => a.ticker !== entry.ticker);
  filtered.unshift(entry);
  writeSaved(filtered.slice(0, 100));
  renderSaved();
  flashStatus('Saved ' + entry.ticker, 'success');
}

function getBlendedFairValue() {
  const { dcf, rel, capm } = state.results;
  const cands = [];
  if (dcf?.perShare > 0) cands.push({ v: dcf.perShare, w: 2 });
  if (rel.blended > 0) cands.push({ v: rel.blended, w: 1 });
  if (capm.perShare > 0) cands.push({ v: capm.perShare, w: 1 });
  if (!cands.length) return null;
  const sw = cands.reduce((a, c) => a + c.w, 0);
  return cands.reduce((a, c) => a + c.v * c.w, 0) / sw;
}

function renderSaved() {
  const list = loadSaved();
  const el = document.getElementById('saved-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">No saved valuations yet. Run a valuation and click Save.</div>';
    return;
  }
  el.innerHTML = list.map(v => {
    const mos = v.fairValue && v.price ? ((v.fairValue - v.price) / v.price * 100) : null;
    const mosColor = mos == null ? 'var(--ink-faint)' : (mos > 10 ? 'var(--green)' : mos < -10 ? 'var(--red)' : 'var(--amber)');
    return `
      <div class="saved-item" data-id="${v.id}">
        <button class="s-del" data-del="${v.id}" title="Delete">×</button>
        <div class="s-tic">${v.ticker}</div>
        <div class="s-name">${v.name}</div>
        <div class="s-val">
          $${v.price?.toFixed(2)} → $${v.fairValue?.toFixed(2)}
          <span style="color:${mosColor}">(${mos >= 0 ? '+' : ''}${mos?.toFixed(1)}%)</span>
        </div>
        <div class="s-date">${new Date(v.savedAt).toLocaleString()}</div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.s-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(e.target.dataset.del);
      writeSaved(loadSaved().filter(v => v.id !== id));
      renderSaved();
    });
  });
  el.querySelectorAll('.saved-item').forEach(item => {
    item.addEventListener('click', e => {
      const id = parseInt(item.dataset.id);
      const v = loadSaved().find(x => x.id === id);
      if (v) {
        document.getElementById('ticker').value = v.ticker;
        loadValuation();
      }
    });
  });
}

// ============================================================
//   STATUS / EVENTS
// ============================================================
function flashStatus(msg, cls = '') {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.className = 'status ' + cls;
  setTimeout(() => { s.textContent = 'Ready'; s.className = 'status'; }, 3000);
}

async function loadValuation() {
  const ticker = document.getElementById('ticker').value.toUpperCase().trim();
  if (!ticker) {
    flashStatus('Enter a ticker', 'error');
    return;
  }
  const btn = document.getElementById('fetch-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const raw = await fetchStock(ticker);
    const stock = normalizeStock(raw);
    state.stock = stock;
    renderSummary(stock);
    buildInputs(stock);
    recalculate();
    document.getElementById('intro').style.display = 'none';
    document.getElementById('workspace').classList.add('visible');
    document.getElementById('save-btn').disabled = false;
    flashStatus('Loaded ' + stock.ticker, 'success');
  } catch (e) {
    flashStatus(e.message || 'Failed to load', 'error');
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch & Value';
  }
}

document.getElementById('fetch-btn').addEventListener('click', loadValuation);
document.getElementById('ticker').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadValuation();
});
document.getElementById('save-btn').addEventListener('click', saveCurrent);

// Initial render of saved list
renderSaved();
