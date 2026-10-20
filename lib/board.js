/**
 * The price board: fetch, parse, convert, cache, and remember the last N days.
 *
 * One board instance lives in the host half. It owns the ONLY network egress of
 * this plugin — every window reads its cached snapshot — and it is written so
 * that a bad day never destroys a good one:
 *
 *   - a refresh that reaches no storefront keeps the previous prices, flips
 *     `status` to `stale` (or `empty` when nothing was ever fetched) and
 *     records why, so the UI can say "上次成功是 X" instead of showing nothing;
 *   - a refresh that reads some storefronts keeps the freshly read rows and
 *     carries the previous amount forward for the ones that failed (each row's
 *     region records `stale: true`), so one flaky page cannot blank a column;
 *   - the snapshot file is written to a temp file and renamed, so a crash
 *     mid-write cannot leave a truncated JSON behind.
 *
 * @module dsh-chatgpt-price/board
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { createLimiter } from './limiter.js'
import { convert, parseRatePayload, REGION_CURRENCY, REGION_NAMES } from './money.js'
import { appStoreUrl, describeStatus, parseAppStorePage } from './scrape.js'
import { DEFAULT_REGIONS, PLANS } from './shared.js'

/** Exchange-rate endpoints tried in order (all keyless, all quote per USD). */
export const DEFAULT_RATE_SOURCES = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD',
  'https://api.frankfurter.app/latest?from=USD',
]

/** Days of history kept for the "price changed" column and the trend sparkline. */
export const HISTORY_LIMIT = 90

/** How long a snapshot is trusted before the scheduler refreshes it out of band. */
export const CACHE_TTL_MS = 20 * 60 * 60 * 1000

/** Upper bound on storefronts followed per refresh (each is one HTTP request). */
export const MAX_REGIONS = 40

/** A 1x1 transparent GIF, so a storefront without a favicon renders an empty icon. */
export const EMPTY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** Browser-ish request headers: the App Store serves its SSR page to plain GETs. */
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
}

/**
 * The calendar date in one time zone, as `2026-10-19`.
 * @param {Date} [at] - the instant (default now).
 * @param {string} [timeZone] - IANA zone.
 */
export function localDate(at = new Date(), timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * Fill defaults into a raw config object and normalise the region list.
 * @param {Record<string, unknown>} [input] - the loader's `config:` row.
 * @returns {{ regions: string[], cnyPerUsd: number, timeZone: string, refreshHour: number, rateSources: string[], requestTimeoutMs: number, concurrency: number, requestsPerSecond: number, maxHistoryDays: number }} the resolved config.
 */
export function resolveConfig(input = {}) {
  const rawRegions = Array.isArray(input.regions) && input.regions.length > 0 ? input.regions : DEFAULT_REGIONS
  const regions = []
  for (const value of rawRegions) {
    const code = String(value).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code) || regions.includes(code)) continue
    regions.push(code)
    if (regions.length >= MAX_REGIONS) break
  }
  const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    regions: regions.length > 0 ? regions : DEFAULT_REGIONS,
    cnyPerUsd: number(input.cnyPerUsd, 7.2) > 0 ? number(input.cnyPerUsd, 7.2) : 7.2,
    timeZone: typeof input.timeZone === 'string' && input.timeZone !== '' ? input.timeZone : 'Asia/Shanghai',
    refreshHour: Math.min(23, Math.max(0, Math.round(number(input.refreshHour, 9)))),
    rateSources: Array.isArray(input.rateSources) && input.rateSources.length > 0 ? input.rateSources : DEFAULT_RATE_SOURCES,
    requestTimeoutMs: Math.min(120_000, Math.max(2_000, number(input.requestTimeoutMs, 20000))),
    concurrency: Math.min(8, Math.max(1, Math.round(number(input.concurrency, 4)))),
    requestsPerSecond: Math.min(20, Math.max(1, number(input.requestsPerSecond, 6))),
    maxHistoryDays: Math.min(HISTORY_LIMIT, Math.max(1, Math.round(number(input.maxHistoryDays, HISTORY_LIMIT)))),
    /** @type {string[]} extra places to try when the primary snapshot file is not writable. */
    spillFiles: Array.isArray(input.spillFiles) ? input.spillFiles.filter((path) => typeof path === 'string' && path !== '') : [],
  }
}

/**
 * GET one URL as text with a timeout; non-2xx is a result, not a throw.
 * @param {string} url - absolute http(s) URL.
 * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options] - request options.
 * @returns {Promise<{ statusCode: number, body: string }>} the response.
 */
export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    headers: { ...REQUEST_HEADERS, ...options.headers },
  })
  return { statusCode: response.status, body: await response.text() }
}

/**
 * An empty snapshot, in the exact shape the client reads.
 * @returns {ReturnType<typeof import('./shared.js').snapshotShape>} the snapshot skeleton.
 */
function emptySnapshot() {
  return {
    version: 2,
    date: '',
    fetchedAt: '',
    status: 'empty',
    message: '还没有数据',
    source: 'appstore',
    cnyPerUsd: 7.2,
    usdRatesAt: '',
    usdRates: { USD: 1 },
    regions: [],
    prices: [],
    failedRegions: [],
    history: [],
  }
}

/** The board. One per host process. */
export class PriceBoard {
  /**
   * @param {{ dataFile: string, config: ReturnType<typeof resolveConfig>, logger?: { info?: Function, warn?: Function } }} options - primary file (used for the first write), how to behave, where to log.
   */
  constructor({ dataFile, config, logger }) {
    /** @type {string[]} writable candidates, primary first; narrowed on failure. */
    this.dataFiles = [dataFile, ...(Array.isArray(config.spillFiles) ? config.spillFiles : [])]
      .filter((path) => typeof path === 'string' && path.length > 0)
    this.config = config
    this.logger = logger
    /** @type {ReturnType<typeof emptySnapshot>} */
    this.snapshot = emptySnapshot()
    this.snapshot.cnyPerUsd = config.cnyPerUsd
    /** @type {Promise<unknown> | undefined} */
    this.inFlight = undefined
    this.loaded = false
    /** Set once a candidate has been written successfully. */
    this.sticky = undefined
  }

  /** The file to read and write now: the sticky one, else the first candidate. */
  get dataFile() {
    return this.sticky ?? this.dataFiles[0] ?? ''
  }

  /** Read the persisted snapshot, if any. Never throws. */
  async load() {
    this.loaded = true
    for (const path of this.dataFiles) {
      try {
        const text = await readFile(path, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.prices)) {
          this.snapshot = { ...emptySnapshot(), ...parsed }
          this.sticky = path
          this.logger?.info?.(`chatgpt-price: 载入快照 ${this.snapshot.date || '(无日期)'}，${this.snapshot.prices.length} 条价格（${path}）`)
          return this.snapshot
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger?.warn?.(`chatgpt-price: 读取快照失败 ${path} ${String(error)}`)
        }
      }
    }
    return this.snapshot
  }

  /**
   * Write the snapshot atomically (temp file + rename), trying each writable
   * candidate in turn: the primary location may be blocked by the host's file
   * sandbox, and losing the data is worse than storing it somewhere else.
   */
  async persist() {
    for (const path of this.dataFiles) {
      if (this.sticky !== undefined && path !== this.sticky) continue
      const temp = `${path}.${process.pid}.tmp`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temp, JSON.stringify(this.snapshot, null, 1), 'utf8')
        await rename(temp, path)
        if (this.sticky !== path) {
          this.sticky = path
          this.logger?.info?.(`chatgpt-price: 快照写入 ${path}`)
        }
        return
      } catch (error) {
        this.logger?.warn?.(`chatgpt-price: 写入快照失败 ${path} ${String(error)}`)
        await rm(temp, { force: true }).catch(() => {})
      }
    }
  }

  /** The current snapshot, always safe to serialise. */
  getSnapshot() {
    return this.snapshot
  }

  /** Whether the snapshot is old enough (or failed enough) to refresh now. */
  needsRefresh() {
    const snapshot = this.snapshot
    if (snapshot.status === 'empty') return true
    if (snapshot.date !== localDate(new Date(), this.config.timeZone)) return true
    const fetched = Date.parse(snapshot.fetchedAt)
    if (!Number.isFinite(fetched)) return true
    return Date.now() - fetched > CACHE_TTL_MS
  }

  /**
   * Fetch the USD rate table. Returns undefined when every source fails — the
   * board then falls back to the configured CNY rate and shows USD at face
   * value, which is right for the US row and flagged for the others.
   * @param {(task: () => Promise<unknown>) => Promise<unknown>} limit - the shared limiter.
   */
  async fetchRates(limit) {
    for (const url of this.config.rateSources) {
      try {
        const { statusCode, body } = await limit(() => fetchText(url, { timeoutMs: this.config.requestTimeoutMs }))
        if (statusCode !== 200) continue
        const rates = parseRatePayload(JSON.parse(body))
        if (rates !== undefined) {
          this.logger?.info?.(`chatgpt-price: 汇率来自 ${url}`)
          return rates
        }
      } catch (error) {
        this.logger?.warn?.(`chatgpt-price: 汇率源失败 ${url} ${String(error)}`)
      }
    }
    return undefined
  }

  /**
   * Read one storefront.
   * @param {string} region - upper-case storefront code.
   * @param {(task: () => Promise<unknown>) => Promise<unknown>} limit - the shared limiter.
   * @returns {Promise<{ region: string, prices: any[], error?: string }>} the storefront result.
   */
  async scrapeRegion(region, limit) {
    const url = appStoreUrl(region)
    try {
      const { statusCode, body } = await limit(() => fetchText(url, { timeoutMs: this.config.requestTimeoutMs }))
      const failure = describeStatus(statusCode)
      if (failure !== undefined) return { region, prices: [], error: failure }
      const parsed = parseAppStorePage(body, region.toLowerCase())
      if (parsed.prices.length === 0) {
        return { region, prices: [], error: '页面里没有找到订阅价格（可能未在售或页面改版）' }
      }
      return { region, prices: parsed.prices }
    } catch (error) {
      return { region, prices: [], error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /**
   * Refresh once. Concurrent calls share the in-flight run.
   * @param {string} [trigger] - who asked (`schedule`/`manual`/`tool`), for logs and the message.
   * @returns {Promise<ReturnType<typeof emptySnapshot>>} the new snapshot.
   */
  async refresh(trigger = 'manual') {
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.runRefresh(trigger).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /** The body of {@link refresh}; separated so `inFlight` bookkeeping stays obvious. */
  async runRefresh(trigger) {
    const startedAt = Date.now()
    const previous = this.snapshot
    const limit = createLimiter({ atOnce: this.config.concurrency, perSecond: this.config.requestsPerSecond })
    this.logger?.info?.(`chatgpt-price: 开始刷新（${trigger}），${this.config.regions.length} 个区`)

    const [rates, settled] = await Promise.all([
      this.fetchRates(limit),
      Promise.all(this.config.regions.map((region) => this.scrapeRegion(region, limit))),
    ])

    /** @type {Record<string, { amount: number, currency: string, raw: string }>} */
    const previousByKey = {}
    for (const row of previous.prices ?? []) {
      previousByKey[`${row.region}:${row.plan}`] = { amount: row.amount, currency: row.currency, raw: row.raw }
    }

    const prices = []
    const regions = []
    const failedRegions = []
    for (const result of settled) {
      const ok = result.error === undefined && result.prices.length > 0
      if (!ok) failedRegions.push({ region: result.region, error: result.error ?? '没有价格' })
      const seen = new Set()
      for (const price of result.prices) {
        seen.add(price.plan)
        prices.push({ ...price, region: result.region, stale: false })
      }
      if (!ok) {
        // Carry the previous amounts forward so one bad page cannot blank a column.
        for (const plan of PLANS) {
          const before = previousByKey[`${result.region}:${plan}`]
          if (before === undefined || seen.has(plan)) continue
          prices.push({
            plan,
            region: result.region,
            amount: before.amount,
            currency: before.currency,
            raw: before.raw,
            label: plan,
            stale: true,
          })
        }
      }
      regions.push({
        code: result.region,
        name: REGION_NAMES[result.region] ?? result.region,
        currency: result.prices[0]?.currency ?? REGION_CURRENCY[result.region],
        ok,
        error: result.error,
        url: appStoreUrl(result.region),
      })
    }

    const rateTable = rates ?? previous.usdRates ?? { USD: 1 }
    const cnyPerUsd = this.config.cnyPerUsd
    const converted = prices.map((row) => ({ ...row, ...convert(row, rateTable, cnyPerUsd) }))
    const succeeded = regions.length - failedRegions.length
    const now = new Date()
    const today = localDate(now, this.config.timeZone)

    if (succeeded === 0 && (previous.prices?.length ?? 0) > 0) {
      // Nothing readable: keep yesterday's prices, but say so.
      this.snapshot = {
        ...previous,
        status: 'stale',
        message: `本次刷新失败，显示的是 ${previous.date || '上次'} 的价格`,
        error: failedRegions[0]?.error,
        fetchedAt: now.toISOString(),
        cnyPerUsd,
        usdRates: rateTable,
        failedRegions,
        regions: regions.length > 0 ? mergeRegionState(previous.regions ?? [], regions) : previous.regions,
      }
      await this.persist()
      this.logger?.warn?.(`chatgpt-price: 刷新失败，保留 ${previous.date} 的快照`)
      return this.snapshot
    }

    const status = succeeded === 0 ? 'empty' : failedRegions.length > 0 ? 'partial' : 'fresh'
    const history = appendHistory(previous.history ?? [], today, converted, this.config.maxHistoryDays)
    this.snapshot = {
      version: 2,
      date: today,
      fetchedAt: now.toISOString(),
      status,
      message: status === 'partial'
        ? `已更新 ${succeeded}/${regions.length} 个地区，${failedRegions.map((item) => `${item.region}：${item.error}`).join('；')}`
        : status === 'empty'
          ? '所有地区都没有取到价格'
          : `已更新 ${succeeded} 个地区`,
      error: status === 'empty' ? failedRegions[0]?.error : undefined,
      source: 'appstore',
      cnyPerUsd,
      usdRatesAt: rates === undefined ? previous.usdRatesAt ?? '' : now.toISOString(),
      usdRates: rateTable,
      regions,
      prices: converted,
      failedRegions,
      history,
    }
    await this.persist()
    this.logger?.info?.(`chatgpt-price: 刷新完成（${status}）${Date.now() - startedAt}ms，${converted.length} 条`)
    return this.snapshot
  }
}

/** Keep the previous currency of a region that failed this round. */
function mergeRegionState(previousRegions, nextRegions) {
  const byCode = new Map(previousRegions.map((region) => [region.code, region]))
  return nextRegions.map((region) => (region.ok ? region : { ...region, currency: region.currency ?? byCode.get(region.code)?.currency }))
}

/**
 * Append today's run to the history, replacing an earlier run from the same day.
 * History is what makes "涨了/降了" possible: one compact entry per date.
 * @param {Array<any>} history - previous entries.
 * @param {string} date - `2026-10-19`.
 * @param {Array<any>} prices - today's converted prices.
 * @param {number} limit - how many days to keep.
 */
function appendHistory(history, date, prices, limit) {
  const entry = { date, prices: prices.map((row) => ({ region: row.region, plan: row.plan, amount: row.amount, currency: row.currency, cny: row.cny })) }
  const kept = history.filter((item) => item?.date !== date)
  kept.push(entry)
  kept.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  return kept.slice(-limit)
}
