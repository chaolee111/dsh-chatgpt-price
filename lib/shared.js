/**
 * Shared wire contract of dsh-chatgpt-price.
 *
 * Both halves import this module, so the host writer and the browser reader
 * can never drift apart. It is plain ES2022 with no imports — the client
 * bundle inlines it, the host loads it directly.
 *
 * @module dsh-chatgpt-price/shared
 */

/** Route family for this plugin (everything below is served by the webServer). */
export const ROUTE_PREFIX = '/plugins/dsh-chatgpt-price'

/** The document the settings page and the sidebar tab read (`GET`). */
export const SNAPSHOT_ROUTE = `${ROUTE_PREFIX}/snapshot`

/** The route that forces a re-scrape (`POST`). */
export const REFRESH_ROUTE = `${ROUTE_PREFIX}/refresh`

/**
 * Plan identifiers, in display order. The keys are this plugin's own ids; the
 * Apple App Store product names each plan matches are in `scrape.js`
 * (`ChatGPT Plus`, `ChatGPT Go`, `ChatGPT Pro 100/200/500`).
 */
export const PLANS = ['go', 'plus', 'pro_100', 'pro_200', 'pro_500']

/** Stable columns of the price table, mirrored by the client's plan chips. */
export const PLAN_LABELS = {
  go: 'Go',
  plus: 'Plus',
  pro_100: 'Pro 100',
  pro_200: 'Pro 200',
  pro_500: 'Pro 500',
}

/** Locale namespaces the browser half registers. */
export const LOCALE_NAMESPACE = 'chatgptPrice'

/**
 * The App Store storefronts followed by default, in display order. The
 * storefront code doubles as the region code shown in the table.
 *
 * HK and CN are deliberately absent: the ChatGPT app is not sold in those
 * storefronts (the page answers 404), which matches OpenAI's unsupported-region
 * policy — there is no local subscription price to show.
 *
 * The list errs towards breadth: every storefront that publishes app prices
 * gets followed, since the cheapest Plus is often a market people would not
 * guess (PH ₱999, PK Rs 4,900). SK/VN/ID/EG/AR/CO/CL are followed for the local
 * number rather than for their USD/CNY conversion: several of them are billed
 * in USD or in a nominal (mis-priced) local tier, and the conversion makes that
 * visible instead of hiding it.
 */
export const DEFAULT_REGIONS = [
  'US', 'JP', 'TW', 'SG', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN', 'PK',
  'GB', 'DE', 'FR', 'NL', 'CH', 'SE', 'SK',
  'CA', 'MX', 'BR', 'CO', 'CL', 'AR', 'AU',
  'AE', 'SA', 'TR', 'EG', 'NG', 'ZA', 'UA',
]

/** One plan's price in one region, as scraped. */
export function priceRow(region, plan, amount, currency, kind = 'appstore') {
  return { region, plan, amount, currency, kind, usd: undefined, cny: undefined }
}

/** A snapshot as the host writes it; the client reads this exact shape. */
export function snapshotShape() {
  return {
    version: 2,
    date: '',
    fetchedAt: '',
    status: 'empty',
    message: '',
    source: '',
    usdRatesAt: '',
    usdRates: {},
    regions: [],
    prices: [],
    failedRegions: [],
    history: [],
  }
}
