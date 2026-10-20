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
 * WHAT a page looks like (2026-10): the "In-App Purchases" block appears twice,
 * once as escaped JSON in a `<script type="application/json">` island
 * (`{"$kind":"textPair","leadingText":"ChatGPT Plus","trailingText":"$19.99"}`)
 * and once as plain HTML (`<div class="text-pair"><span>ChatGPT Plus</span>
 * <span>$19.99</span></div>`). Both are read; the JSON island is preferred
 * because it never contains markup.
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

/** Storefronts whose page exists; HK/CN answer 404 (the app is not sold there). */
export function appStoreUrl(region) {
  return `https://apps.apple.com/${String(region).toLowerCase()}/app/chatgpt/id6448311069`
}

/** Legacy alias kept for callers that build one URL per plan (unused by default). */
export const DEFAULT_SOURCES = [appStoreUrl('us')]

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
 * Pull `[label, price]` pairs out of an App Store page.
 *
 * Both encodings are scanned because either can be missing (the JSON island is
 * emitted inside a script tag the page may lazily drop, and the HTML copy is
 * the part a layout change breaks first).
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
 * Find the storefront a page belongs to.
 * @param {string} html - the page source.
 * @param {string} [fallback] - the storefront we asked for.
 * @returns {string} an upper-case region code (`US`).
 */
export function detectStorefront(html, fallback = 'us') {
  const fromCanonical = /apps\.apple\.com\/([a-z]{2})\/app\//.exec(html ?? '')
  const fromJson = /\\{0,2}"storefront\\{0,2}"\s*:\s*\\{0,2}"([a-z]{2})\\{0,2}"/.exec(html ?? '')
  const code = fromCanonical?.[1] ?? fromJson?.[1] ?? String(fallback).toLowerCase()
  return code.toUpperCase()
}

/**
 * Parse one storefront page into plan prices.
 * @param {string} html - the page source.
 * @param {string} [region] - the storefront requested (`jp`), used for symbol disambiguation.
 * @returns {{ region: string, currency: string | undefined, prices: Array<{ plan: string, amount: number, currency: string, raw: string, label: string }>, pairs: number }} the parse result; `prices` is empty when nothing matched.
 */
export function parseAppStorePage(html, region = 'us') {
  const store = detectStorefront(html, region)
  const pairs = extractPairs(html)
  /** @type {Map<string, { plan: string, amount: number, currency: string, raw: string, label: string }>} */
  const best = new Map()
  for (const [label, raw] of pairs) {
    const plan = planOfLabel(label)
    if (plan === undefined) continue
    const parsed = parsePrice(raw, store)
    if (parsed === undefined || !(parsed.amount > 0)) continue
    const current = best.get(plan)
    if (current === undefined || parsed.amount < current.amount) {
      best.set(plan, { plan, amount: parsed.amount, currency: parsed.currency, raw, label })
    }
  }
  const prices = [...best.values()]
  return {
    region: store,
    currency: prices[0]?.currency ?? REGION_CURRENCY[store],
    prices,
    pairs: pairs.length,
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
  if (statusCode === 403) return '被 App Store 拒绝访问（403）'
  if (statusCode === 429) return '请求过于频繁（429），稍后自动重试'
  if (statusCode >= 500) return `App Store 服务异常（${statusCode}）`
  return `App Store 返回 ${statusCode}`
}
