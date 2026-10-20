/**
 * Host half of the ChatGPT price board.
 *
 * Three responsibilities, all server-side so one scrape per day serves every
 * window and no browser ever talks to Apple's store:
 *   1. a `PriceBoard` that refreshes the snapshot on a daily schedule;
 *   2. a pair of JSON routes the browser half polls (`/snapshot`) and calls
 *      when the user clicks refresh (`/refresh`), both loopback-only;
 *   3. two agent tools so a conversation can read or refresh the board.
 *
 * @module dsh-chatgpt-price
 */

import { join } from 'node:path'

import { DEFAULT_REGIONS, PLANS, REFRESH_ROUTE, SNAPSHOT_ROUTE } from './shared.js'
import { DEFAULT_RATE_SOURCES, localDate, PriceBoard, resolveConfig } from './board.js'

export const name = 'dsh-chatgpt-price'

/** The snapshot path chosen for this profile (diagnostics only). */
let dataFile = ''

export const inject = ['tools']

/** How often the scheduler looks at the clock; cheap, and tolerant of sleep. */
const TICK_MS = 15 * 60 * 1000

/** Response cap for one route call, mirroring the plugin contract's default. */
const ROUTE_TIMEOUT_MS = 120_000

/**
 * Config entry; the loader's `config:` row parses through this.
 * An optional import keeps the plugin loadable where schemastery is absent, in
 * which case the loader passes the raw object straight through.
 */
let Schema
try {
  const module = await import('@deepseek-ai/schemastery')
  Schema = module.default ?? module
} catch {
  Schema = undefined
}

const DESCRIPTIONS = {
  regions: '要展示的国家/地区（App Store 商店区代码，如 US、JP、TW、SG），默认 21 个；HK/CN 未上架 ChatGPT，抓取会失败',
  cnyPerUsd: '人民币汇率（人民币/美元）。官方按 7.2 定价，填 7.2 可得官方折算价；用实时汇率则改这里',
  timeZone: '每日更新所用时区',
  refreshHour: '每日更新时刻（该时区的 0-23 点）',
  rateSources: '汇率数据源，按顺序尝试（后台每天只取一次）',
  requestTimeoutMs: '单次请求超时（毫秒）',
  concurrency: '并发请求数',
  requestsPerSecond: '每秒请求上限，避免被限流',
  autoRefreshOnBoot: '启动时若上次更新已超过 20 小时，立即刷新一次',
  maxHistoryDays: '保留多少天的历史价格，用于显示涨跌和 Sparkline',
}

/** The config surface as a plain descriptor (used when schemastery is absent). */
const configShape = {
  regions: { kind: 'array', default: [...DEFAULT_REGIONS] },
  cnyPerUsd: { kind: 'number', default: 7.2 },
  timeZone: { kind: 'string', default: 'Asia/Shanghai' },
  refreshHour: { kind: 'number', default: 9 },
  rateSources: { kind: 'array', default: [...DEFAULT_RATE_SOURCES] },
  requestTimeoutMs: { kind: 'number', default: 20000 },
  concurrency: { kind: 'number', default: 4 },
  requestsPerSecond: { kind: 'number', default: 6 },
  autoRefreshOnBoot: { kind: 'boolean', default: true },
  maxHistoryDays: { kind: 'number', default: 90 },
}

export const Config = Schema === undefined
  ? configShape
  : Schema.object({
    regions: Schema.array(Schema.string()).default([...DEFAULT_REGIONS]).description(DESCRIPTIONS.regions),
    cnyPerUsd: Schema.number().default(7.2).description(DESCRIPTIONS.cnyPerUsd),
    timeZone: Schema.string().default('Asia/Shanghai').description(DESCRIPTIONS.timeZone),
    refreshHour: Schema.number().default(9).description(DESCRIPTIONS.refreshHour),
    rateSources: Schema.array(Schema.string()).default([...DEFAULT_RATE_SOURCES]).description(DESCRIPTIONS.rateSources),
    requestTimeoutMs: Schema.number().default(20000).description(DESCRIPTIONS.requestTimeoutMs),
    concurrency: Schema.number().default(4).description(DESCRIPTIONS.concurrency),
    requestsPerSecond: Schema.number().default(6).description(DESCRIPTIONS.requestsPerSecond),
    autoRefreshOnBoot: Schema.boolean().default(true).description(DESCRIPTIONS.autoRefreshOnBoot),
    maxHistoryDays: Schema.number().default(90).description(DESCRIPTIONS.maxHistoryDays),
  })

/**
 * Where the snapshot lives: the DSH data folder when the host exposes it
 * (`ctx.baseDir` / `ctx.dataDir`), else `DSH_DATA_DIR`, else `~/.dsh`, so the
 * file survives restarts and plugin upgrades.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {string} absolute path of the snapshot file.
 */
function resolveDataFile(ctx) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  // `ctx.baseDir` is access-guarded by cordis: reading it without declaring it
  // in `inject` throws, so read defensively.
  const guarded = (name) => {
    try {
      return ctx[name]
    } catch {
      return undefined
    }
  }
  const candidates = [guarded('baseDir'), guarded('dataDir'), process.env.DSH_DATA_DIR, join(home, '.dsh')]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return join(candidate, 'chatgpt-price.json')
    }
  }
  return join(home, '.dsh', 'chatgpt-price.json')
}

/**
 * Where the snapshot can also live. The host process may be sandboxed to a
 * subset of the disk, in which case writing the primary file fails with EPERM;
 * the board then falls back to these places in order instead of losing a
 * scrape it already paid for.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} primary - the preferred path.
 * @returns {string[]} writable candidates, primary first.
 */
function fallbackDataFiles(ctx, primary) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  const list = [primary]
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !list.includes(value)) list.push(value)
  }
  try {
    if (typeof ctx?.cwd === 'string') push(join(ctx.cwd, '.dsh-chatgpt-price.json'))
  } catch {}
  if (typeof process.cwd === 'function') push(join(process.cwd(), '.dsh-chatgpt-price.json'))
  push(join(home, '.dsh', 'chatgpt-price.json'))
  return list
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} rawConfig - the loader's `config:` row.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  const disposers = []
  /** @type {PriceBoard} */
  let board
  let lastRunKey = ''
  dataFile = resolveDataFile(ctx)

  const ready = (async () => {
    board = new PriceBoard({
      dataFile,
      config: { ...config, spillFiles: fallbackDataFiles(ctx, dataFile).slice(1) },
      logger: ctx.logger,
    })
    await board.load()
    ctx.logger?.info?.(`chatgpt-price: 数据文件 ${board.dataFile}`)
  })()
  /** The local date+hour key the scheduler compares against. */
  const runKey = (at = new Date()) => `${localDate(at, config.timeZone)}#${config.refreshHour}`

  /** Refresh once, swallowing errors: the timer must never throw. */
  const refreshQuietly = async (trigger) => {
    try {
      await board.refresh(trigger)
    } catch (error) {
      ctx.logger?.warn?.(`chatgpt-price: 更新失败 ${String(error)}`)
    }
  }

  /** One scheduler tick: refresh when the day's slot has passed unserved. */
  const tick = async () => {
    await ready
    const now = new Date()
    const key = runKey(now)
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23',
    }).format(now))
    if (hour < config.refreshHour) return
    if (lastRunKey === key && !board.needsRefresh()) return
    lastRunKey = key
    await refreshQuietly('schedule')
  }

  /** Boot: load, then refresh when the snapshot is stale. */
  const boot = async () => {
    await ready
    if (config.autoRefreshOnBoot === false) return
    if (!board.needsRefresh()) {
      ctx.logger?.info?.(`chatgpt-price: 快照仍新鲜（${board.snapshot?.date ?? '?'}）`)
      return
    }
    await refreshQuietly('schedule')
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
  }, TICK_MS)
  timer.unref?.()
  disposers.push(() => clearInterval(timer))

  boot().catch(() => {})

  // --- Routes -------------------------------------------------------------

  const allowLoopback = (req) => {
    const host = String(req.headers.host ?? '')
    const origin = String(req.headers.origin ?? '')
    const local = (value) => {
      const name = value.split(':')[0].replace(/^\[|\]$/g, '')
      return name === '127.0.0.1' || name === 'localhost' || name === '::1'
    }
    if (host !== '' && !local(host)) return false
    if (origin !== '') {
      try {
        return local(new URL(origin).host)
      } catch {
        return false
      }
    }
    return true
  }

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /** Read at most `limit` bytes of a request body as JSON (or undefined). */
  const readJsonBody = async (req, limit = 4096) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (size === 0) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** Read a service from the context without tripping the access guard. */
  const pick = (context, name) => {
    try {
      const direct = context?.[name]
      if (direct !== undefined && direct !== null) return direct
    } catch {}
    try {
      return typeof context?.get === 'function' ? context.get(name) : undefined
    } catch {
      return undefined
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = pick(webCtx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('chatgpt-price: webServer 不可用，看板界面读不到数据')
      return
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: SNAPSHOT_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!allowLoopback(req)) {
          sendJson(res, 403, { ok: false, error: 'loopback only' })
          return
        }
        try {
          await ready
          sendJson(res, 200, {
            ok: true,
            snapshot: board.getSnapshot(),
            refreshing: board.inFlight !== undefined,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-chatgpt-price: /snapshot route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: REFRESH_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!allowLoopback(req)) {
          sendJson(res, 403, { ok: false, error: 'loopback only' })
          return
        }
        try {
          await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) })
          return
        }
        try {
          await ready
          const snapshot = await board.refresh('manual')
          sendJson(res, 200, { ok: true, snapshot })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-chatgpt-price: /refresh route')
  })

  // --- Tools --------------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    const tools = pick(toolCtx, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') return

    ctx.effect(() => tools.register({
      name: 'chatgpt_price_board',
      description: '读取 ChatGPT 各国订阅价格看板（由 dsh-chatgpt-price 每天自动更新，数据取自各区 App Store 内购价）。返回各地 Go/Plus/Pro 100/Pro 200/Pro 500 的本地价、美元价、人民币价和按天成本，可按地区或套餐过滤。',
      parameters: {
        type: 'object',
        properties: {
          regions: { type: 'array', items: { type: 'string' }, description: '只看这些地区代码，如 ["US","JP"]；省略表示全部' },
          plans: { type: 'array', items: { type: 'string', enum: [...PLANS] }, description: '只看这些套餐（go/plus/pro_100/pro_200/pro_500）；省略表示全部' },
          limit: { type: 'number', description: '最多返回多少行，默认 60' },
        },
      },
      timeoutMs: ROUTE_TIMEOUT_MS,
      async execute(args) {
        await ready
        const snapshot = board.getSnapshot()
        const wantedRegions = new Set((args?.regions ?? []).map((code) => String(code).toUpperCase()))
        const wantedPlans = new Set(args?.plans ?? [])
        const rows = (snapshot.prices ?? []).filter((row) =>
          (wantedRegions.size === 0 || wantedRegions.has(row.region))
          && (wantedPlans.size === 0 || wantedPlans.has(row.plan)),
        ).slice(0, Math.max(1, Math.min(200, Number(args?.limit) || 60)))
        return {
          date: snapshot.date,
          fetchedAt: snapshot.fetchedAt,
          status: snapshot.status,
          message: snapshot.message,
          error: snapshot.error,
          cnyPerUsd: snapshot.cnyPerUsd,
          usdRatesAt: snapshot.usdRatesAt,
          rows,
          failedRegions: snapshot.failedRegions,
          hint: snapshot.status === 'empty' ? '还没有数据，可调用 refresh_chatgpt_prices 立即抓取一次' : undefined,
        }
      },
    }), 'dsh-chatgpt-price: chatgpt_price_board tool')

    ctx.effect(() => tools.register({
      name: 'refresh_chatgpt_prices',
      description: '立即抓取一次 ChatGPT 各国订阅价格并写回看板（正常情况下后台每天自动更新，无需手动调用）。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: ROUTE_TIMEOUT_MS,
      async execute() {
        await ready
        const snapshot = await board.refresh('tool')
        return {
          date: snapshot.date,
          fetchedAt: snapshot.fetchedAt,
          status: snapshot.status,
          message: snapshot.message,
          error: snapshot.error,
          rows: (snapshot.prices ?? []).length,
          failedRegions: snapshot.failedRegions,
        }
      },
    }), 'dsh-chatgpt-price: refresh_chatgpt_prices tool')
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch {}
    }
  }
}

/** The snapshot path chosen for this profile (exported for diagnostics). */
export function snapshotPath() {
  return dataFile
}
