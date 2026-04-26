# trading# Valuatio — Stock Valuation Engine

A browser-based valuation tool that runs four valuation methods side-by-side, following the framework in your finance notes (Damodaran-style intrinsic + relative + risk-adjusted).

## How to run it

1. Put `index.html` and `app.js` in the same folder.
2. Double-click `index.html` to open it in your browser.

That's it. No install, no server, no API key, no database. Saved valuations live in your browser's `localStorage`.

## What it does

You type a ticker (e.g. `AAPL`, `MSFT`, `BRK-B`, `TSLA`). The app:

1. **Fetches** financial data from Yahoo Finance (via a free CORS proxy)
2. **Auto-fills** every assumption — but you can override any of them
3. **Runs four valuation methods** simultaneously
4. **Shows a blended fair value** and margin of safety vs. market price
5. **Lets you save** the valuation locally for later reference

## The four methods

### 1. Discounted Cash Flow (Intrinsic)
Two-stage FCF model. Cash flows fade linearly from your year-1 growth rate down to terminal growth over the high-growth period, then perpetuity. Falls back to a revenue-and-margin model when FCF is negative.

Per your notes: *"Less is more"* — this is a deliberately simple two-stage model, not a black-box 50-line one.

### 2. CAPM Justified Price
Uses cost of equity (Rf + β·(Mature ERP + CRP)) as the discount rate on FCF/share. Implements **Damodaran's Approach #2**: country risk treated like other market risk, scaled by beta.

### 3. Relative Valuation
Blends two multiples:
- **P/E × EPS** — price you'd pay if the market priced this company at its sector multiple
- **EV/EBITDA implied per share** — same idea, but capital-structure neutral

### 4. Monte Carlo (Probability Bands)
10,000 DCF simulations with normal-distribution shocks to growth rate, operating margin, and beta. Outputs:
- Median estimate
- 5th–95th percentile band
- **P(undervalued)** — share of simulations where intrinsic > market

## Foreign revenue & country risk

The app implements Damodaran's **operation-based CRP** instead of the (cruder) location-based one:

```
Blended CRP = (1 - foreign%) × Domestic CRP + foreign% × Foreign CRP
Cost of Equity = Rf + β × (Mature ERP + Blended CRP)
```

Yahoo doesn't expose foreign revenue % directly, so this defaults to 30% — adjust it for the company you're valuing (Apple ~60%, Walmart ~25%, Coca-Cola ~65%, etc).

The country dropdown reflects **Damodaran's CRP table** — emerging markets carry higher additive premiums.

## How macro factors flow through the model

| Macro variable | Where it shows up |
|---|---|
| Treasury yields ↑ | Risk-free rate ↑ → cost of equity ↑ → DCF value ↓ |
| Market volatility ↑ | Implied via Monte Carlo σ inputs → wider distribution |
| Country risk ↑ | CRP ↑ → cost of equity ↑ for that exposure |
| Tax policy | Marginal tax rate input → after-tax cost of debt, NOPAT |
| Growth expectations | Year-1 growth + terminal growth |

## Why methods disagree

This is **a feature, not a bug**, and your notes say so directly:

- **DCF** assumes markets fix mistakes over long horizons — needs a long view
- **Relative** assumes markets are right *on average* but wrong on individuals
- **CAPM justified** is a clean cost-of-equity check using only forward FCF/share

When all three converge, you have high conviction. When they diverge, you've found something interesting to investigate — usually about growth assumptions or whether peers really *are* peers.

## Storage

Saved valuations live in `localStorage` under the key `valuatio.savedValuations.v1`. Up to 100 entries are kept; saving the same ticker twice replaces the prior entry. Click any saved item to reload that ticker.

To clear everything: open browser DevTools → Application → Local Storage → delete the key.

## Limitations to know about

- **CORS proxy dependency**: uses `corsproxy.io` for Yahoo Finance. If they change or rate-limit, the fetch fails. The fallback is to manually enter every input — every field is editable.
- **Yahoo data quality**: TTM figures, beta, and sector multiples come from Yahoo. Cross-check before betting real money.
- **Country detection** uses Yahoo's `assetProfile.country` — usually the country of incorporation, not operations. Override the foreign revenue % manually for accuracy.
- **Bottom-up beta** isn't computed automatically (would need peer sector betas). The Yahoo regression beta is used; you can manually enter a bottom-up beta in the Beta field.
- **No API rate limiting**: don't hammer the corsproxy or you'll get throttled.

## Extending it

The code is plain HTML + JS, ~700 lines total, no build step. Common extensions:

- Add bottom-up beta: fetch beta for sector peers, average + unlever + relever
- Add more valuation methods (option-based / liquidation / asset-based)
- Add a portfolio view across saved valuations
- Add CSV export of saved valuations

## A word from your notes

> "The numbers are always going to be wrong because you're valuing the future."

Treat every output as a *range* of plausibility, not a price target. The Monte Carlo histogram is the most honest output here — that wide distribution is what valuation actually looks like.
