/**
 * Currency knowledge and money conversion for the price board.
 *
 * The board reads Apple App Store product pages, which print a price the way a
 * local customer sees it — `$19.99`, `22,99 €`, `S$ 29.98`, `￥3,000`. Two
 * things follow from that:
 *
 *   - the page never names the ISO code, so `parsePrice` resolves the code from
 *     the symbol AND the storefront (one symbol is shared by many currencies);
 *   - number formatting is locale-specific (decimal comma, non-breaking
 *     spaces, dot grouping), so `parseAmount` normalises digits separately
 *     from the symbol.
 *
 * Conversion is deliberately forgiving: a missing rate degrades that one cell
 * instead of failing the scrape.
 *
 * @module dsh-chatgpt-price/money
 */

/**
 * Region (App Store storefront) -> the ISO currency Apple bills in. Used to
 * resolve an ambiguous symbol: `$` is USD for `us`, CAD for `ca`, AUD for
 * `au`, TWD for `tw`, MXN for `mx`…; `¥` is JPY for `jp`, CNY for `cn`.
 */
export const REGION_CURRENCY = {
  US: 'USD', CN: 'CNY', HK: 'HKD', TW: 'TWD', MO: 'MOP',
  JP: 'JPY', KR: 'KRW', SG: 'SGD', MY: 'MYR', TH: 'THB', ID: 'IDR',
  PH: 'PHP', VN: 'VND', IN: 'INR', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR',
  GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', NL: 'EUR', BE: 'EUR',
  AT: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR',
  LU: 'EUR', CY: 'EUR', MT: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR',
  SK: 'EUR', SI: 'EUR', HR: 'EUR',
  CH: 'CHF', NO: 'NOK', SE: 'SEK', DK: 'DKK', IS: 'ISK', PL: 'PLN',
  CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD', UA: 'UAH',
  RU: 'RUB', TR: 'TRY', IL: 'ILS', AE: 'AED', SA: 'SAR', QA: 'QAR',
  KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', LB: 'LBP', EG: 'EGP',
  MA: 'MAD', ZA: 'ZAR', NG: 'NGN', KE: 'KES', GH: 'GHS', TN: 'TND',
  DZ: 'DZD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP',
  CO: 'COP', PE: 'PEN', UY: 'UYU', CR: 'CRC', PA: 'USD', EC: 'USD',
  SV: 'USD', GT: 'GTQ', DO: 'DOP', AU: 'AUD', NZ: 'NZD', FJ: 'FJD',
  KZ: 'KZT', UZ: 'UZS', AM: 'AMD', GE: 'GEL', AZ: 'AZN', BY: 'BYN',
  MD: 'MDL', AL: 'ALL', BA: 'BAM', MK: 'MKD', MN: 'MNT',
  KH: 'USD', LA: 'LAK', MM: 'MMK', BN: 'BND', MV: 'MVR',
}

/** Display name per region, so the table reads as countries rather than codes. */
export const REGION_NAMES = {
  US: '美国', CN: '中国', HK: '中国香港', TW: '中国台湾', MO: '中国澳门',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国',
  ID: '印度尼西亚', PH: '菲律宾', VN: '越南', IN: '印度', PK: '巴基斯坦',
  BD: '孟加拉国', LK: '斯里兰卡', NP: '尼泊尔', GB: '英国', IE: '爱尔兰',
  DE: '德国', FR: '法国', NL: '荷兰', BE: '比利时', AT: '奥地利',
  ES: '西班牙', IT: '意大利', PT: '葡萄牙', FI: '芬兰', GR: '希腊',
  LU: '卢森堡', CY: '塞浦路斯', MT: '马耳他', EE: '爱沙尼亚',
  LV: '拉脱维亚', LT: '立陶宛', SK: '斯洛伐克', SI: '斯洛文尼亚',
  HR: '克罗地亚', CH: '瑞士', NO: '挪威', SE: '瑞典', DK: '丹麦',
  IS: '冰岛', PL: '波兰', CZ: '捷克', HU: '匈牙利', RO: '罗马尼亚',
  BG: '保加利亚', RS: '塞尔维亚', UA: '乌克兰', RU: '俄罗斯', TR: '土耳其',
  IL: '以色列', AE: '阿联酋', SA: '沙特阿拉伯', QA: '卡塔尔',
  KW: '科威特', BH: '巴林', OM: '阿曼', JO: '约旦', LB: '黎巴嫩',
  EG: '埃及', MA: '摩洛哥', ZA: '南非', NG: '尼日利亚', KE: '肯尼亚',
  GH: '加纳', TN: '突尼斯', DZ: '阿尔及利亚', CA: '加拿大', MX: '墨西哥',
  BR: '巴西', AR: '阿根廷', CL: '智利', CO: '哥伦比亚', PE: '秘鲁',
  UY: '乌拉圭', CR: '哥斯达黎加', PA: '巴拿马', EC: '厄瓜多尔',
  SV: '萨尔瓦多', GT: '危地马拉', DO: '多米尼加', AU: '澳大利亚',
  NZ: '新西兰', FJ: '斐济', KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦',
  AM: '亚美尼亚', GE: '格鲁吉亚', AZ: '阿塞拜疆', BY: '白俄罗斯',
  MD: '摩尔多瓦', AL: '阿尔巴尼亚', BA: '波黑', MK: '北马其顿',
  MN: '蒙古', KH: '柬埔寨', LA: '老挝', MM: '缅甸', BN: '文莱',
  MV: '马尔代夫',
}

/** English display name per region (the `en` half of the table's country column). */
export const REGION_NAMES_EN = {
  US: 'United States', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', MO: 'Macao',
  JP: 'Japan', KR: 'South Korea', SG: 'Singapore', MY: 'Malaysia', TH: 'Thailand',
  ID: 'Indonesia', PH: 'Philippines', VN: 'Vietnam', IN: 'India', PK: 'Pakistan',
  BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal', GB: 'United Kingdom',
  IE: 'Ireland', DE: 'Germany', FR: 'France', NL: 'Netherlands', BE: 'Belgium',
  AT: 'Austria', ES: 'Spain', IT: 'Italy', PT: 'Portugal', FI: 'Finland',
  GR: 'Greece', LU: 'Luxembourg', CY: 'Cyprus', MT: 'Malta', EE: 'Estonia',
  LV: 'Latvia', LT: 'Lithuania', SK: 'Slovakia', SI: 'Slovenia', HR: 'Croatia',
  CH: 'Switzerland', NO: 'Norway', SE: 'Sweden', DK: 'Denmark', IS: 'Iceland',
  PL: 'Poland', CZ: 'Czechia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  RS: 'Serbia', UA: 'Ukraine', RU: 'Russia', TR: 'Türkiye', IL: 'Israel',
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', LB: 'Lebanon', EG: 'Egypt',
  MA: 'Morocco', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana',
  TN: 'Tunisia', DZ: 'Algeria', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
  AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru', UY: 'Uruguay',
  CR: 'Costa Rica', PA: 'Panama', EC: 'Ecuador', SV: 'El Salvador',
  GT: 'Guatemala', DO: 'Dominican Republic', AU: 'Australia', NZ: 'New Zealand',
  FJ: 'Fiji', KZ: 'Kazakhstan', UZ: 'Uzbekistan', AM: 'Armenia',
  GE: 'Georgia', AZ: 'Azerbaijan', BY: 'Belarus', MD: 'Moldova',
  AL: 'Albania', BA: 'Bosnia and Herzegovina', MK: 'North Macedonia',
  MN: 'Mongolia', KH: 'Cambodia', LA: 'Laos', MM: 'Myanmar', BN: 'Brunei',
  MV: 'Maldives',
}

/**
 * Symbol prefixes the App Store prints, longest first so `CA$` wins over `$`.
 * Each entry lists the currencies that use it; `resolveCurrency` narrows that
 * down with the storefront.
 */
const SYMBOL_CURRENCIES = [
  ['US$', ['USD']],
  ['CA$', ['CAD', 'USD']],
  ['AU$', ['AUD', 'USD']],
  ['NZ$', ['NZD', 'USD']],
  ['MX$', ['MXN', 'USD']],
  ['S$', ['SGD']],
  ['HK$', ['HKD']],
  ['NT$', ['TWD']],
  ['R$', ['BRL']],
  ['A$', ['AUD']],
  ['C$', ['CAD']],
  ['$', ['USD', 'CAD', 'AUD', 'NZD', 'MXN', 'TWD', 'HKD', 'SGD', 'CLP', 'ARS', 'COP', 'USD']],
  ['£', ['GBP']],
  ['€', ['EUR']],
  ['¥', ['JPY', 'CNY']],
  ['￥', ['JPY', 'CNY']],
  ['₩', ['KRW']],
  ['￦', ['KRW']],
  ['₹', ['INR']],
  ['₺', ['TRY']],
  ['₽', ['RUB']],
  ['₴', ['UAH']],
  ['฿', ['THB']],
  ['₫', ['VND']],
  ['₱', ['PHP']],
  ['₪', ['ILS']],
  ['₦', ['NGN']],
  ['zł', ['PLN']],
  ['Kč', ['CZK']],
  ['kr', ['SEK', 'NOK', 'DKK', 'ISK']],
  ['CHF', ['CHF']],
  ['RM', ['MYR']],
  ['Rp', ['IDR']],
]

/** Three-letter codes the App Store sometimes prints instead of a symbol (`AED 79.99`). */
const ISO_CODES = new Set(Object.values(REGION_CURRENCY))

/** Currencies whose smallest unit is the whole unit (no decimals). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'KWD', 'ISK', 'HUF', 'TWD', 'NGN', 'COP', 'HKD', 'PKR', 'LKR', 'MNT', 'UZS', 'KZT', 'PYG', 'XAF', 'XOF'])

/** Three-decimal currencies. */
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'LBP', 'TND'])

/** Decimals a currency prints with (exact for the currencies Apple bills in). */
export function decimalsOf(currency) {
  if (THREE_DECIMAL.has(currency)) return 3
  if (ZERO_DECIMAL.has(currency)) return 0
  return 2
}

/**
 * Decide which ISO code a printed price belongs to.
 * @param {string} text - the price as printed, e.g. `22,99 €` or `AED 79.99`.
 * @param {string} [region] - the storefront, used to disambiguate a shared symbol.
 * @returns {string | undefined} the ISO code, or undefined when unknown.
 */
export function resolveCurrency(text, region) {
  if (typeof text !== 'string') return undefined
  const local = REGION_CURRENCY[String(region ?? '').toUpperCase()]
  const codeMatch = text.toUpperCase().match(/(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/)
  if (codeMatch !== null && ISO_CODES.has(codeMatch[1])) {
    // A printed code is authoritative, except that `CHF`/`SEK`-style suffixes
    // are symbols as well — they still resolve to themselves.
    return codeMatch[1]
  }
  for (const [symbol, currencies] of SYMBOL_CURRENCIES) {
    if (!text.includes(symbol)) continue
    if (local !== undefined && currencies.includes(local)) return local
    return currencies[0]
  }
  return local
}

/**
 * Local shorthands for thousands: `Rp 349ribu`, `20 ngàn đ` — some storefronts
 * print the amount with a word instead of the zeroes. `\b` cannot be used next
 * to `đ`: JavaScript word boundaries are ASCII-only, so `đ` reads as a
 * non-word char and the boundary simply is not there.
 */
const SHORTHAND_SCALE = [
  // Only shorthands that cannot appear in ordinary thousands formatting belong
  // here: a short word boundary like `\b` would make `Rs` read as one of them.
  // `ribu`/`rb` may be glued to the number (`349ribu`), so they need no prefix;
  // a suffix check keeps `Rp` from matching.
  [/ribu(?=\s|$)/i, 1_000],
  [/(?:^|\s)rb(?=\s|$)/i, 1_000],
  [/(?:^|\s)ngàn(?=\s|$)/i, 1_000],
  [/(?:^|\s)nghìn(?=\s|$)/i, 1_000],
  [/juta(?=\s|$)/i, 1_000_000],
  [/(?:^|\s)triệu(?=\s|$)/i, 1_000_000],
  [/(?:^|\s)l(?=\s|$)/i, 100_000],
]

/**
 * Digits printed with a two-digit fraction, despite the currency having
 * zero-decimal units (`335.28`). A bare three-char token is never in here, so
 * `Rs 4,900.00` cannot be read as new-format.
 */
const DECIMAL_HINT = /[,.]\d{2}$/

/** Decimals implied by a shorthand word — `349ribu` is a whole number of thousand. */
const SHORTHAND_DECIMALS = 0

/**
 * Currencies whose storefront prints `,` as the decimal point (`Rp 1,889juta`
 * is 1.889 million). Only consulted on the shorthand path, where a fraction is
 * meaningful; the plain path reads separators positionally instead.
 */
const COMMA_DECIMAL = new Set(['IDR', 'VND', 'TRY', 'BRL', 'EUR', 'COP', 'CLP', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ZAR', 'NGN', 'EGP', 'UAH', 'RUB'])

/**
 * The number in front of a shorthand word.
 * @param {string} digits - the price with only digits and separators left.
 * @param {string | undefined} currency - ISO code.
 * @returns {number} the unscaled value.
 */
function shorthandAmount(digits, currency) {
  if (currency !== undefined && COMMA_DECIMAL.has(currency) && digits.includes(',')) {
    const [whole, fraction = ''] = digits.split(',')
    const value = Number(`${whole.replace(/[,.]/g, '')}.${fraction.replace(/[,.]/g, '')}`)
    if (Number.isFinite(value)) return value
  }
  return Number(digits.replace(/[,.]/g, ''))
}

/**
 * The multiplier a price's shorthand implies, if it uses one.
 * @param {string} text - the printed price.
 * @returns {number | undefined} 1000 / 1e6 / 1e5, or undefined for plain digits.
 */
function shorthandScale(text) {
  for (const [pattern, scale] of SHORTHAND_SCALE) {
    if (pattern.test(text)) return scale
  }
  return undefined
}

/**
 * Read the numeric part of a printed price.
 *
 * Handles every separator style Apple prints: `1,999`, `22,99`, `2.599,90`,
 * `1 120,00`, `$1,989.00`. The last separator followed by exactly three digits
 * is grouping when a later separator exists, otherwise it decides the decimals.
 * Zero-decimal currencies (`VND`, `IDR`, `CLP`…) never print fractions, so their
 * three-digit tail is grouping: `4.999.000đ` is 4 999 000, not 4999.0.
 * @param {string} text - the price as printed.
 * @param {string} [currency] - ISO code, used for the zero-decimal rule.
 * @returns {number | undefined} the amount, or undefined when no digits exist.
 */
export function parseAmount(text, currency) {
  if (typeof text !== 'string') return undefined
  const digits = text.replace(/[^\d.,\s\u00a0\u202f']/g, '').replace(/[\s\u00a0\u202f']/g, '')
  if (!/\d/.test(digits)) return undefined
  const scale = shorthandScale(text)
  if (scale !== undefined) {
    const value = shorthandAmount(digits, currency)
    return Number.isFinite(value) ? Number((value * scale).toFixed(SHORTHAND_DECIMALS)) : undefined
  }
  const last = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'))
  const whole = (currency === undefined || ZERO_DECIMAL.has(currency)) && !DECIMAL_HINT.test(digits)
  let normalized
  if (last === -1) {
    // No separator at all: `3000`.
    normalized = digits
  } else if (!whole && (digits.length - last - 1 !== 3 || /[,.]\d{3}[,.]/.test(digits))) {
    // `22,99` / `999,99` (two decimals) or `2.599,90` (grouping, then decimals):
    // the trailing separator introduces the fraction, every earlier one groups.
    normalized = `${digits.slice(0, last).replace(/[,.]/g, '')}.${digits.slice(last + 1)}`
  } else {
    // A lone three-digit tail is grouping — no storefront prints three
    // decimals (`1,989` is 1989 and `3.300` is 3300).
    normalized = digits.replace(/[,.]/g, '')
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Parse one printed price into `{ amount, currency }`.
 * @param {string} text - e.g. `S$ 29.98`.
 * @param {string} [region] - storefront code for symbol disambiguation.
 */
export function parsePrice(text, region) {
  const currency = resolveCurrency(text, region)
  const amount = parseAmount(text, currency)
  if (amount === undefined || currency === undefined) return undefined
  return { amount, currency }
}

/**
 * Format an amount in its own currency, using the platform's number
 * formatting (grouping, decimals) but NOT a currency symbol — the table
 * prints the ISO code itself so every row reads the same.
 * @param {number} amount - the amount to print.
 * @param {string} currency - ISO 4217 code.
 * @returns {string} e.g. "1,234.00".
 */
export function formatAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  const digits = decimalsOf(currency)
  try {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount)
  } catch {
    return amount.toFixed(digits)
  }
}

/**
 * Convert one price into USD/CNY and a daily cost.
 *
 * The CNY figure is a REAL money estimate: it uses the live CNY/USD rate
 * captured in the same refresh as the prices. When no live rate is available
 * the CNY figure is `undefined` rather than silently falling back to a fixed
 * 7.2 — a made-up rate is worse than an empty cell.
 *
 * @param {{ amount: number, currency: string }} row - a scraped price.
 * @param {Record<string, number>} usdRates - units of currency per 1 USD.
 * @returns {{ usd: number, cny: number, perDayUsd: number, perDayCny: number }} `undefined` fields when the rate is unknown.
 */
export function convert(row, usdRates) {
  const rate = row.currency === 'USD' ? 1 : usdRates?.[row.currency]
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return { usd: undefined, cny: undefined, perDayUsd: undefined, perDayCny: undefined }
  }
  const usd = row.amount / rate
  const cnyRate = usdRates?.CNY
  const cny = row.currency === 'CNY'
    ? row.amount
    : typeof cnyRate === 'number' && Number.isFinite(cnyRate) && cnyRate > 0
      ? usd * cnyRate
      : undefined
  return {
    usd,
    cny,
    perDayUsd: usd / 30.4,
    perDayCny: cny === undefined ? undefined : cny / 30.4,
  }
}

/**
 * Pull the USD rate table out of an exchange-rate service answer.
 * Accepts both shapes the board uses: `{ rates: {...} }` (open.er-api.com,
 * exchangerate.host) and a bare `{ USD: 1, CNY: 7.2 }` map.
 * @param {unknown} payload - parsed JSON.
 * @returns {Record<string, number> | undefined} the rates, or undefined when the shape is unusable.
 */
export function parseRatePayload(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const raw = 'rates' in payload && payload.rates && typeof payload.rates === 'object'
    ? payload.rates
    : payload
  const rates = {}
  for (const [code, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    if (!/^[A-Z]{3}$/.test(code)) continue
    rates[code] = value
  }
  // Every service quotes per USD; USD itself is 1.
  rates.USD = 1
  return Object.keys(rates).length > 1 ? rates : undefined
}
