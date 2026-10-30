/**
 * Read ChatGPT's subscription prices out of Apple App Store product pages.
 *
 * WHY the App Store: chatgpt.com/pricing renders its price numbers client-side
 * (`<span class="…tabular-nums"></span>` is empty in the served HTML) and its
 * `/backend-api` price endpoints answer 404/401 to anyone without a session, so
 * a server-side scrape of OpenAI's own page cannot see a number at all. The App
 * Store page for the same app IS server-rendered, needs no login, and lists the
 * in-app purchase prices per storefront — one public page per country.
 *
 * WHY the legacy endpoint: since 2026-10 `apps.apple.com/<cc>/app/…` answers
 * `302 → /cn` for a Chinese egress IP, and the CN storefront does not sell this
 * app, so the request lands on Apple's "Today" page with no product data at all.
 * `itunes.apple.com/WebObjects/MZStore.woa/wa/viewSoftware` is not geo-redirected
 * and honours the `x-apple-store-front: <id>-<n>,29` header, which pins the
 * storefront regardless of the visitor's IP.
 *
 * THE TRAP: a wrong `<n>` in that header does NOT fail — it silently answers as
 * the US store. So every response is validated against the storefront the page
 * itself reports (`storePlatformData…storefront.cc`) and rejected on mismatch;
 * `frontCandidates()` walks a few suffixes when that happens. Measured
 * 2026-10-30: suffix 1 for US/JP, 5 for CA, 2 for the other 30 storefronts.
 *
 * WHAT a page holds: a JSON island beginning `{"storePlatformData"` with
 * `pageData.addOns` — a clean array of `{ name, price, buyParams }`. `price` is
 * display text (`"22,99 €"`); `buyParams` carries `price=<integer>` in
 * thousandths of the currency unit (US Plus `19990` → 19.990, JP Go `1400000` →
 * 1400). The integer is preferred and the display text is the cross-check.
 *
 * Two quirks the parser must absorb:
 *   - `ChatGPT Plus` appears TWICE, the second time at the Pro 200 price
 *     (`ChatGPT Plus = $200` next to `ChatGPT Pro 200 = $200`). It is a stale
 *     label on the top tier, so duplicates collapse to the LOWEST amount.
 *   - The block also lists consumables (`100 Credits = $4`). They are not
 *     subscriptions and are dropped by name.
 *
 * Everything here is pure: input is HTML, output is data. Network lives in
 * `board.js`, which records failures instead of guessing.
 *
 * @module dsh-chatgpt-price/scrape
 */

import { parsePrice, REGION_CURRENCY } from './money.js'

/** The ChatGPT iOS app; its in-app purchases are the prices this board tracks. */
const APP_ID = '6448311069'

/** Geo-redirect-free product endpoint. Storefront comes from a header. */
const LEGACY_PATH = 'https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewSoftware'

/**
 * Apple numeric storefront ids, measured 2026-10-30.
 * @type {Record<string, number>}
 */
const STOREFRONT_IDS = {
  US: 143441, JP: 143462, TW: 143470, SG: 143464, KR: 143466, MY: 143473,
  TH: 143475, PH: 143474, VN: 143471, ID: 143476, IN: 143467, PK: 143477,
  GB: 143444, DE: 143443, FR: 143442, NL: 143452, CH: 143459, SE: 143456,
  SK: 143496, CA: 143455, MX: 143468, BR: 143503, CO: 143501, CL: 143483,
  AR: 143505, AU: 143460, AE: 143481, SA: 143479, TR: 143480, EG: 143516,
  NG: 143561, ZA: 143472, UA: 143492,
}

/** The `-N` suffix each storefront needs; a wrong one silently answers as US. */
const STOREFRONT_SUFFIX = { US: 1, JP: 1, CA: 5 }

/** Suffixes tried, in order, when the preferred one is rejected. */
const SUFFIX_FALLBACK = [2, 1, 5, 3, 4, 6]

/**
 * The human-facing product page. Used for the snapshot's `url` field and links,
 * not for fetching (that path is geo-redirected).
 * @param {string} region - storefront code.
 */
export function appStoreUrl(region) {
  return `https://apps.apple.com/${String(region).toLowerCase()}/app/chatgpt/id${APP_ID}`
}

/** Legacy alias kept for callers that expect a source list. */
export const DEFAULT_SOURCES = [appStoreUrl('us')]

/**
 * The URL actually fetched: the legacy product endpoint, which is not
 * geo-redirected. The storefront is chosen by the `x-apple-store-front` header.
 */
export function storefrontUrl() {
  return `${LEGACY_PATH}?id=${APP_ID}&mt=8`
}

/**
 * Build one `x-apple-store-front` value.
 * @param {string} region - storefront code.
 * @param {number} suffix - the storefront's `-N` index.
 * @returns {string | undefined} e.g. `143441-1,29`, or undefined for an unknown storefront.
 */
export function storefrontFront(region, suffix) {
  const id = STOREFRONT_IDS[String(region).toUpperCase()]
  if (id === undefined) return undefined
  return `${id}-${suffix},29`
}

/**
 * Storefront headers to try for a region, best first.
 *
 * `cached` (a previously accepted front) wins, so a warm board makes exactly one
 * request per region; the configured suffix is next, then the fallbacks.
 * @param {string} region - storefront code.
 * @param {string} [cached] - a front that worked before.
 * @returns {string[]} candidate header values.
 */
export function frontCandidates(region, cached) {
  const code = String(region).toUpperCase()
  const id = STOREFRONT_IDS[code]
  if (id === undefined) return []
  const preferred = STOREFRONT_SUFFIX[code] ?? 2
  const suffixes = [preferred, ...SUFFIX_FALLBACK.filter((value) => value !== preferred)]
  const fronts = suffixes.map((suffix) => `${id}-${suffix},29`)
  if (typeof cached === 'string' && cached.startsWith(`${id}-`)) {
    return [cached, ...fronts.filter((front) => front !== cached)]
  }
  return fronts
}

/**
 * Subscription products, keyed by this plugin's plan id. `endsWith` matches the
 * product name case-insensitively; consumables (`100 Credits`) never match.
 */
const PRODUCT_MATCHERS = [
  ['pro_500', /chatgpt\s*pro\s*(500|5x|max)/i],
  ['pro_200', /chatgpt\s*pro\s*(200|20x|pro)/i],
  ['pro_100', /chatgpt\s*pro\s*100/i],
  ['plus', /chatgpt\s*plus/i],
  ['go', /chatgpt\s*go/i],
]

/** Products that are not subscriptions. */
const NON_SUBSCRIPTION = /credit|token|top[\s-]?up|bundle/i

/**
 * Map one product label onto a plan id.
 * @param {string} label - e.g. `ChatGPT Pro 200`.
 * @returns {string | undefined} `go`/`plus`/`pro_100`/`pro_200`/`pro_500`, or undefined.
 */
export function planOfLabel(label) {
  if (typeof label !== 'string') return undefined
  if (NON_SUBSCRIPTION.test(label)) return undefined
  for (const [plan, pattern] of PRODUCT_MATCHERS) {
    if (pattern.test(label)) return plan
  }
  return undefined
}

/**
 * Slice out the balanced JSON object that starts at `start`.
 *
 * The island is embedded in HTML, so `JSON.parse` needs the exact end offset;
 * counting braces is the only reliable way (a regex stops at the first `}`).
 * @param {string} text - the page source.
 * @param {number} start - index of the opening `{`.
 * @returns {string | undefined} the object source, or undefined when unbalanced.
 */
function balancedObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Parse the `{"storePlatformData"` JSON island out of a legacy page.
 * @param {string} html - the page source.
 * @returns {any | undefined} the parsed island, or undefined when absent.
 */
export function readIsland(html) {
  if (typeof html !== 'string') return undefined
  const at = html.indexOf('{"storePlatformData"')
  if (at === -1) return undefined
  const source = balancedObject(html, at)
  if (source === undefined) return undefined
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

/**
 * The storefront a page reports for itself.
 * @param {any} island - the parsed island.
 * @returns {string | undefined} an upper-case code (`US`).
 */
function islandStorefront(island) {
  const product = island?.storePlatformData?.['product-dv']
  const code = product?.meta?.storefront?.cc ?? island?.pageData?.storefront?.cc
  return typeof code === 'string' ? code.toUpperCase() : undefined
}

/**
 * Pull `[label, price]` pairs out of a modern App Store page.
 *
 * Kept as a fallback: if Apple ever stops serving the legacy endpoint, the
 * `apps.apple.com` page still carries the same list in two encodings.
 * @param {string} html - the page source.
 * @returns {Array<[string, string]>} raw pairs in page order.
 */
export function extractPairs(html) {
  if (typeof html !== 'string' || html.length === 0) return []
  const pairs = []

  // 1) Escaped JSON island: \"$kind\":\"textPair\",\"leadingText\":\"…\",\"trailingText\":\"…\"
  const jsonPattern = /\\\\?"leadingText\\\\?"\s*:\s*\\{0,2}"((?:[^"\\]|\\.){0,120}?)\\{0,2}"\s*,\s*\\{0,2}"trailingText\\{0,2}"\s*:\s*\\{0,2}"((?:[^"\\]|\\.){0,60}?)\\{0,2}"/g
  for (const match of html.matchAll(jsonPattern)) {
    pairs.push([unescapeJsonString(match[1]), unescapeJsonString(match[2])])
  }
  if (pairs.length > 0) return pairs

  // 2) Plain HTML copy: <div class="text-pair…"><span>Label</span> <span>Price</span>
  const htmlPattern = /<div class="text-pair[^"]*"[^>]*>\s*<span[^>]*>([^<]{1,120})<\/span>\s*<span[^>]*>([^<]{1,60})<\/span>/g
  for (const match of html.matchAll(htmlPattern)) {
    pairs.push([decodeEntities(match[1]).trim(), decodeEntities(match[2]).trim()])
  }
  return pairs
}

/** Undo the JSON escaping the island applies (`\"`, `\u00a0`, `\\`). */
function unescapeJsonString(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim()
}

/** Minimal entity decoding for the HTML copy (`&nbsp;`, `&amp;`, numeric refs). */
function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (_, hex, digits) => {
      const code = hex === '' ? Number.parseInt(digits, 10) : Number.parseInt(digits, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

/**
 * The amount Apple charges, from a `buyParams` query string.
 *
 * `price` is an integer in thousandths of a currency unit (`19990` → `19.990`),
 * which is exact where the display string is localised text.
 * @param {string} buyParams - e.g. `productType=A&price=19990&salableAdamId=…`.
 * @returns {number | undefined} the amount in major units.
 */
function amountFromBuyParams(buyParams) {
  if (typeof buyParams !== 'string') return undefined
  const match = /(?:^|&)price=(\d+)(?:&|$)/.exec(buyParams)
  if (match === null) return undefined
  const thousandths = Number(match[1])
  if (!Number.isFinite(thousandths) || thousandths <= 0) return undefined
  return thousandths / 1000
}

/**
 * Find the storefront a page belongs to.
 * @param {string} html - the page source.
 * @param {string} [fallback] - the storefront we asked for.
 * @returns {string} an upper-case region code (`US`).
 */
export function detectStorefront(html, fallback = 'us') {
  const fromIsland = islandStorefront(readIsland(html))
  const fromCanonical = /apps\.apple\.com\/([a-z]{2})\/app\//.exec(html ?? '')
  const fromJson = /\\{0,2}"storefront\\{0,2}"\s*:\s*\\{0,2}"cc\\{0,2}"\s*:\s*\\{0,2}"([a-z]{2})\\{0,2}"/.exec(html ?? '')
  const code = fromIsland ?? fromCanonical?.[1] ?? fromJson?.[1] ?? String(fallback).toLowerCase()
  return code.toUpperCase()
}

/**
 * Parse one storefront page into plan prices.
 *
 * `storefront` is what the page says it is — the caller compares it with the
 * region it asked for, because a wrong storefront header answers as the US store
 * without any error.
 * @param {string} html - the page source.
 * @param {string} [region] - the storefront requested (`jp`), for symbol disambiguation.
 * @returns {{ region: string, storefront: string | undefined, currency: string | undefined, prices: Array<{ plan: string, amount: number, currency: string, raw: string, label: string }>, pairs: number }} the parse result; `prices` is empty when nothing matched.
 */
export function parseAppStorePage(html, region = 'us') {
  const requested = String(region).toUpperCase()
  const island = readIsland(html)
  const storefront = islandStorefront(island)
  const store = storefront ?? detectStorefront(html, requested)

  /** @type {Array<[string, string, number | undefined]>} label, display text, exact amount */
  const rows = []
  const addOns = island?.pageData?.addOns ?? island?.storePlatformData?.['product-dv']?.results?.[APP_ID]?.addOns
  if (Array.isArray(addOns)) {
    for (const addOn of addOns) {
      if (typeof addOn?.name !== 'string') continue
      rows.push([addOn.name, typeof addOn.price === 'string' ? addOn.price : '', amountFromBuyParams(addOn.buyParams)])
    }
  }
  if (rows.length === 0) {
    // Fallback: the modern page's text pairs (no exact integer available).
    for (const [label, raw] of extractPairs(html)) rows.push([label, raw, undefined])
  }

  /** @type {Map<string, { plan: string, amount: number, currency: string, raw: string, label: string }>} */
  const best = new Map()
  for (const [label, raw, exact] of rows) {
    const plan = planOfLabel(label)
    if (plan === undefined) continue
    const parsed = parsePrice(raw, store)
    // Prefer the exact integer; fall back to the localised display string.
    let amount = exact
    let currency = parsed?.currency ?? REGION_CURRENCY[store]
    if (amount === undefined) {
      amount = parsed?.amount
    } else if (parsed !== undefined && Math.abs(parsed.amount - amount) > Math.max(0.02, amount * 0.005)) {
      // Display text and the integer disagree — trust the display, which is what
      // a buyer is quoted, and keep the currency the symbol implies.
      amount = parsed.amount
      currency = parsed.currency
    }
    if (amount === undefined || !(amount > 0)) continue
    const current = best.get(plan)
    if (current === undefined || amount < current.amount) {
      best.set(plan, { plan, amount, currency, raw: raw === '' ? String(amount) : raw, label })
    }
  }
  const prices = [...best.values()]
  return {
    region: store,
    storefront,
    currency: prices[0]?.currency ?? REGION_CURRENCY[store],
    prices,
    pairs: rows.length,
  }
}

/**
 * Why a page could not be read, in words a user can act on.
 * @param {number} statusCode - the HTTP status.
 * @returns {string | undefined} a message, or undefined when the page is fine.
 */
export function describeStatus(statusCode) {
  if (statusCode === 200) return undefined
  if (statusCode === 404) return '该区 App Store 未上架 ChatGPT（OpenAI 未在这些地区提供订阅）'
  if (statusCode === 400) return '该区商店区标识被 App Store 拒绝（400）'
  if (statusCode === 403) return '被 App Store 拒绝访问（403）'
  if (statusCode === 429) return '请求过于频繁（429），稍后自动重试'
  if (statusCode >= 500) return `App Store 服务异常（${statusCode}）`
  return `App Store 返回 ${statusCode}`
}
