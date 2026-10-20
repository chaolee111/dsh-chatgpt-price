/**
 * Browser half of dsh-chatgpt-price.
 *
 * Two extension points, one component:
 *   - a Settings page (`settings.section`) that is always available — the board
 *     lives there when nothing else is installed;
 *   - a sidebar tab through `dsh-better-sidebar` when that plugin is present.
 *
 * The half talks to its host half over one plain HTTP route resolved against
 * the PAGE base, so a reverse-proxy prefix works — see better-sidebar's
 * `host-route-url.ts` for why the injected transport origin must not be used
 * (host plugin routes send no CORS headers).
 *
 * @module dsh-chatgpt-price/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-chatgpt-price',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const ROUTE_PREFIX = '/plugins/dsh-chatgpt-price'
    const SNAPSHOT_ROUTE = `${ROUTE_PREFIX}/snapshot`
    const REFRESH_ROUTE = `${ROUTE_PREFIX}/refresh`
    const PLANS = ['go', 'plus', 'pro_100', 'pro_200', 'pro_500']

    const NS = 'chatgptPrice'
    const STYLE_ID = 'dsh-chatgpt-price-styles'
    const POLL_MS = 4000

    /** Plan ids → display labels (the same in every language). */
    const PLAN_LABELS = {
      go: 'Go',
      plus: 'Plus',
      pro_100: 'Pro 100',
      pro_200: 'Pro 200',
      pro_500: 'Pro 500',
    }

    const REGION_NAMES = {
      US: '美国', JP: '日本', TW: '台湾', SG: '新加坡', KR: '韩国', MY: '马来西亚', TH: '泰国',
      IN: '印度', GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', CH: '瑞士', SE: '瑞典',
      CA: '加拿大', MX: '墨西哥', BR: '巴西', AU: '澳大利亚', AE: '阿联酋', TR: '土耳其', ZA: '南非',
      HK: '香港', CN: '中国大陆', IT: '意大利', ES: '西班牙', NZ: '新西兰', PH: '菲律宾',
      ID: '印度尼西亚', VN: '越南', PL: '波兰', BE: '比利时', AT: '奥地利', IE: '爱尔兰',
      DK: '丹麦', NO: '挪威', FI: '芬兰', PT: '葡萄牙', SA: '沙特阿拉伯',
    }

    const REGION_NAMES_EN = {
      US: 'United States', JP: 'Japan', TW: 'Taiwan', SG: 'Singapore', KR: 'South Korea', MY: 'Malaysia',
      TH: 'Thailand', IN: 'India', GB: 'United Kingdom', DE: 'Germany', FR: 'France', NL: 'Netherlands',
      CH: 'Switzerland', SE: 'Sweden', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AU: 'Australia',
      AE: 'United Arab Emirates', TR: 'Türkiye', ZA: 'South Africa', HK: 'Hong Kong', CN: 'Mainland China',
    }

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------

    const zh = {
      'meta.title': 'ChatGPT 各区价格',
      'page.title': 'ChatGPT 各区订阅价格',
      'page.subtitle': '每天自动更新 · 价格取自各区 App Store 内购项目（含当地税）',
      'state.fresh': '已更新',
      'state.partial': '部分更新',
      'state.stale': '更新失败',
      'state.empty': '暂无数据',
      'state.loading': '读取中…',
      'state.refreshing': '正在更新…',
      'action.refresh': '立即更新',
      'label.updatedAt': '更新于',
      'label.price': '本地价',
      'label.cny': '人民币',
      'label.usd': '美元',
      'label.region': '地区',
      'label.vsUs': '对比美国',
      'label.staleRow': '沿用上次价格',
      'label.failed': '未取到',
      'label.rate': '汇率',
      'note.source': '价格取自 Apple App Store 的内购项目（ChatGPT Go / Plus / Pro），已含当地税；网页端结账价可能略有差异，以结账页为准。',
      'note.rate': '人民币价 = 本地价按美元汇率折算后再乘汇率设置；OpenAI 官方按 1 美元 = 7.2 元人民币计价。',
      'note.hkcn': '香港、中国大陆的 App Store 未上架 ChatGPT，因此没有本地订阅价。',
      'note.noSidebar': '装上 dsh-better-sidebar 后，这里还会多出一个侧边栏标签页。',
      'label.focusHint': '点档位可以只看这一档；摘要与排序都跟着当前档位走。',
      'empty.title': '还没有价格数据',
      'empty.body': '后台每天会自动抓取一次，也可以现在点「立即更新」。',
      'error.title': '暂时读不到价格',
      'sum.cheapest': '最低',
      'sum.expensive': '最高',
      'sum.spread': '价差',
      'label.focus': '当前档位',
      'label.sort': '排序',
      'sort.default': '默认顺序',
      'sort.cheap': '价格从低到高',
      'sort.dear': '价格从高到低',
      'sort.ratio': '相对美国从低到高',
      'label.cheapestFirst': '最便宜',
      'state.allPlans': '再点一次显示全部档位',
    }

    const en = {
      'meta.title': 'ChatGPT Prices',
      'page.title': 'ChatGPT subscription prices by country',
      'page.subtitle': 'Refreshed daily · in-app prices per App Store storefront (taxes included)',
      'state.fresh': 'Updated',
      'state.partial': 'Partly updated',
      'state.stale': 'Update failed',
      'state.empty': 'No data',
      'state.loading': 'Loading…',
      'state.refreshing': 'Refreshing…',
      'action.refresh': 'Refresh now',
      'label.updatedAt': 'Updated',
      'label.price': 'Local price',
      'label.cny': 'CNY',
      'label.usd': 'USD',
      'label.region': 'Country',
      'label.vsUs': 'vs. US',
      'label.staleRow': 'Last known price',
      'label.failed': 'Unavailable',
      'label.rate': 'Rate',
      'note.source': 'Prices come from the Apple App Store in-app purchase list (ChatGPT Go / Plus / Pro) and include local tax. Web checkout may differ slightly; the checkout page is authoritative.',
      'note.rate': 'CNY = local price converted to USD, then multiplied by your CNY/USD setting. OpenAI itself bills CNY at 7.2 per USD.',
      'note.hkcn': 'The ChatGPT app is not sold in the Hong Kong or mainland China storefronts, so there is no local price there.',
      'note.noSidebar': 'Install dsh-better-sidebar to also get this board as a sidebar tab.',
      'label.focusHint': 'Pick a plan to show only that column; the summary line and sorting follow the selected plan.',
      'empty.title': 'No prices yet',
      'empty.body': 'The host refreshes once a day; you can also press “Refresh now”.',
      'error.title': 'Cannot read prices right now',
      'sum.cheapest': 'Lowest',
      'sum.expensive': 'Highest',
      'sum.spread': 'Spread',
      'label.focus': 'Plan',
      'label.sort': 'Sort',
      'sort.default': 'Default order',
      'sort.cheap': 'Price: low to high',
      'sort.dear': 'Price: high to low',
      'sort.ratio': 'vs. US: low to high',
      'label.cheapestFirst': 'Cheapest',
      'state.allPlans': 'Pick again for all plans',
    }

    // ---------------------------------------------------------------------
    // Styles: only theme tokens, so light/dark follow the shell.
    // ---------------------------------------------------------------------

    const CSS = `
.dcp-root { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 16px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dcp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dcp-title { font-size: 15px; font-weight: 600; margin: 0; }
.dcp-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dcp-actions { display: flex; align-items: center; gap: 8px; }
.dcp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.dcp-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dcp-btn:disabled { opacity: .55; cursor: default; }
.dcp-btn--primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); }
.dcp-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dcp-dot--fresh { background: var(--dsw-alias-state-success-primary); }
.dcp-dot--partial { background: var(--dsw-alias-state-warn-primary); }
.dcp-dot--stale { background: var(--dsw-alias-state-error-primary); }
.dcp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.dcp-chip { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.dcp-chip--on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dcp-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: space-between; }
.dcp-control { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dcp-select { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 24px 5px 10px; font-size: 12px; cursor: pointer; }
.dcp-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dcp-rank { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; display: inline-block; min-width: 12px; }
.dcp-best { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
.dcp-plan-tag { margin-left: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcp-tablewrap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: auto; background: var(--dsw-alias-bg-layer-1); }
.dcp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dcp-table th, .dcp-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; vertical-align: top; }
.dcp-table th { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
.dcp-table tr:last-child td { border-bottom: none; }
.dcp-num { font-variant-numeric: tabular-nums; }
.dcp-region { display: flex; align-items: center; gap: 8px; }
.dcp-flag { width: 20px; height: 15px; border-radius: 2px; object-fit: cover; background: var(--dsw-alias-bg-layer-2); }
.dcp-region-name { font-weight: 500; }
.dcp-region-code { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcp-amount { font-weight: 600; font-variant-numeric: tabular-nums; }
.dcp-cur { color: var(--dsw-alias-label-secondary); font-size: 10px; margin-left: 4px; }
.dcp-muted { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcp-up { color: var(--dsw-alias-state-error-primary); }
.dcp-down { color: var(--dsw-alias-state-success-primary); }
.dcp-stale { opacity: .6; }
.dcp-notes { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.6; }
.dcp-summary { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dcp-summary b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dcp-empty { border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dcp-empty strong { display: block; color: var(--dsw-alias-label-primary); margin-bottom: 6px; font-size: 13px; }
.dcp-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 8px 10px; font-size: 12px; }
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------------
    // Host route helpers
    // ---------------------------------------------------------------------

    /** Resolve one host route against the page base, keeping a proxy prefix. */
    function routeUrl(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://dsh.internal/'
      const url = new URL(base)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return new URL(String(path).replace(/^\/+/, ''), url.href)
    }

    /** Read the snapshot; throws a readable error. */
    async function readSnapshot(signal) {
      const response = await fetch(routeUrl(SNAPSHOT_ROUTE).href, { cache: 'no-store', credentials: 'same-origin', signal })
      const payload = await response.json()
      if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** Force a refresh on the host; resolves with the new snapshot. */
    async function requestRefresh(signal) {
      const response = await fetch(routeUrl(REFRESH_ROUTE).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      const payload = await response.json()
      if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'TWD', 'HKD', 'VND', 'IDR', 'CLP', 'COP', 'HUF'])

    function formatLocal(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
      const digits = ZERO_DECIMAL.has(currency) ? 0 : 2
      try {
        return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
      } catch {
        return String(amount)
      }
    }

    function formatFixed(value, digits = 2) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toFixed(digits)
    }

    function formatTime(iso, locale) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return '—'
      try {
        return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(at)
      } catch {
        return at.toISOString()
      }
    }

    /** The previous day's CNY price for a row, to mark a rise or a fall. */
    function previousCny(snapshot, region, plan) {
      const history = snapshot?.history ?? []
      if (history.length < 2) return undefined
      const earlier = history[history.length - 2]
      const row = (earlier?.prices ?? []).find((item) => item.region === region && item.plan === plan)
      return typeof row?.cny === 'number' ? row.cny : undefined
    }

    // ---------------------------------------------------------------------
    // Data hook
    // ---------------------------------------------------------------------

    /** Initial read plus a manual refresh; polls while a refresh is pending. */
    function useBoard() {
      const [snapshot, setSnapshot] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [loading, setLoading] = useState(true)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = async () => {
        try {
          const payload = await readSnapshot()
          if (!alive.current) return
          setSnapshot(payload.snapshot)
          setError(undefined)
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause))
        } finally {
          if (alive.current) setLoading(false)
        }
      }

      useEffect(() => {
        load()
      }, [])

      // While the host is mid-refresh (its own schedule, or another window)
      // poll so the table fills in without a reload.
      useEffect(() => {
        const status = snapshot?.status
        const pending = busy || status === undefined || status === 'empty'
        if (!pending) return undefined
        const timer = setInterval(() => {
          load()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [busy, snapshot])

      const refresh = async () => {
        setBusy(true)
        setError(undefined)
        try {
          const payload = await requestRefresh()
          if (alive.current) setSnapshot(payload.snapshot)
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      return { snapshot, error, busy, loading, refresh, reload: load }
    }

    // ---------------------------------------------------------------------
    // Pieces
    // ---------------------------------------------------------------------

    function StatusBadge({ t, snapshot, busy }) {
      const status = busy ? undefined : snapshot?.status ?? 'loading'
      const key = busy ? 'state.refreshing' : `state.${status ?? 'loading'}`
      const tone = busy ? 'idle' : status === 'fresh' ? 'fresh' : status === 'partial' ? 'partial' : status === 'stale' ? 'stale' : 'idle'
      return h('span', { className: 'dcp-badge' },
        h('span', { className: `dcp-dot dcp-dot--${tone}` }),
        t(key))
    }

    function RegionCell({ region, locale }) {
      const isEn = locale.toLowerCase().startsWith('en')
      const name = (isEn ? REGION_NAMES_EN[region] : REGION_NAMES[region]) ?? region
      return h('div', { className: 'dcp-region' },
        h('img', {
          className: 'dcp-flag',
          alt: '',
          loading: 'lazy',
          src: `https://flagcdn.com/w40/${region.toLowerCase()}.png`,
          onError: (event) => {
            event.currentTarget.style.visibility = 'hidden'
          },
        }),
        h('span', { className: 'dcp-region-name' }, name),
        h('span', { className: 'dcp-region-code' }, region))
    }

    /** One cell: local price, CNY conversion (with day-over-day mark), USD. */
    function PriceCell({ t, row, snapshot, best }) {
      if (row === undefined) return h('td', { className: 'dcp-num dcp-muted' }, '—')
      const before = previousCny(snapshot, row.region, row.plan)
      const delta = typeof before === 'number' && typeof row.cny === 'number' ? row.cny - before : undefined
      const tone = delta === undefined || Math.abs(delta) < 0.01 ? '' : delta > 0 ? 'dcp-up' : 'dcp-down'
      return h('td', { className: 'dcp-num', title: row.stale === true ? t('label.staleRow') : undefined },
        h('div', { className: best ? 'dcp-amount dcp-best' : row.stale === true ? 'dcp-amount dcp-stale' : 'dcp-amount' },
          formatLocal(row.amount, row.currency),
          h('span', { className: 'dcp-cur' }, row.currency),
          best ? h('span', { className: 'dcp-plan-tag' }, t('label.cheapestFirst')) : null),
        h('div', { className: `dcp-muted ${tone}` },
          '¥', formatFixed(row.cny, row.currency === 'JPY' || row.currency === 'KRW' ? 0 : 1),
          tone === '' ? null : (delta > 0 ? ' ↑' : ' ↓')),
        h('div', { className: 'dcp-muted' }, '$', formatFixed(row.usd, 2)))
    }

    /** A labelled native select — keyboard- and screen-reader-friendly. */
    function Select({ label, value, options, onChange }) {
      return h('label', { className: 'dcp-control' },
        label,
        h('select', {
          className: 'dcp-select',
          value,
          onChange: (event) => onChange(event.target.value),
        }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))))
    }

    const SORTS = ['cheap', 'dear', 'ratio', 'default']

    /**
     * The table: one row per region, one column per plan.
     *
     * `focus` is the plan the summary line and every sort order read from —
     * picking a different plan moves the "lowest / highest / spread" figures,
     * the per-plan competition cue and the sort key together.
     */
    function PriceTable({ t, snapshot, locale, plans, focus, sort }) {
      const byKey = useMemo(() => {
        const map = new Map()
        for (const row of snapshot?.prices ?? []) map.set(`${row.region}:${row.plan}`, row)
        return map
      }, [snapshot])

      const defaultOrder = useMemo(() => {
        const seen = []
        for (const row of snapshot?.prices ?? []) if (!seen.includes(row.region)) seen.push(row.region)
        const order = (snapshot?.regions ?? []).map((region) => (typeof region === 'string' ? region : region?.code))
        return seen.sort((a, b) => {
          const ia = order.indexOf(a)
          const ib = order.indexOf(b)
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
        })
      }, [snapshot])

      const focusLabel = PLAN_LABELS[focus] ?? focus
      const usRow = byKey.get(`US:${focus}`)
      const ratioOf = (region) => {
        const row = byKey.get(`${region}:${focus}`)
        return typeof row?.cny === 'number' && typeof usRow?.cny === 'number' && usRow.cny > 0 ? row.cny / usRow.cny : undefined
      }
      const priceOf = (region) => {
        const row = byKey.get(`${region}:${focus}`)
        return typeof row?.cny === 'number' ? row.cny : undefined
      }

      // Sorted view. Missing prices always sink to the bottom; ties keep the
      // configured storefront order so the table never jitters between loads.
      const regions = useMemo(() => {
        const rank = new Map(defaultOrder.map((region, index) => [region, index]))
        if (sort === 'default') return defaultOrder
        const key = sort === 'ratio' ? ratioOf : priceOf
        return [...defaultOrder].sort((a, b) => {
          const ka = key(a)
          const kb = key(b)
          if (ka === undefined && kb === undefined) return rank.get(a) - rank.get(b)
          if (ka === undefined) return 1
          if (kb === undefined) return -1
          const delta = sort === 'dear' ? kb - ka : ka - kb
          return delta === 0 ? rank.get(a) - rank.get(b) : delta
        })
      }, [snapshot, sort, focus])

      const focusRows = defaultOrder.map(priceOf).filter((value) => typeof value === 'number')
      const cheapestCny = focusRows.length > 1 ? Math.min(...focusRows) : undefined
      const summary = focusRows.length > 1 ? (() => {
        const sorted = [...focusRows].sort((a, b) => a - b)
        const cheap = sorted[0]
        const dear = sorted[sorted.length - 1]
        const cheapRegions = defaultOrder.filter((region) => priceOf(region) === cheap)
        const dearRegions = defaultOrder.filter((region) => priceOf(region) === dear)
        return [
          h('span', { key: 'focus' }, `${t('label.focus')}: `, h('b', null, focusLabel)),
          h('span', { key: 'cheap' }, `${t('sum.cheapest')} ${focusLabel}: `, h('b', null, `${cheapRegions.join(' / ')} ¥${formatFixed(cheap, 0)}`)),
          h('span', { key: 'dear' }, `${t('sum.expensive')} ${focusLabel}: `, h('b', null, `${dearRegions.join(' / ')} ¥${formatFixed(dear, 0)}`)),
          h('span', { key: 'spread' }, `${t('sum.spread')}: `, h('b', null, `${(dear / cheap).toFixed(2)}×`)),
        ]
      })() : null

      const failed = new Map((snapshot?.failedRegions ?? []).map((item) => [item.region, item]))

      return h(React.Fragment, null,
        summary === null ? null : h('div', { className: 'dcp-summary' }, summary),
        h('div', { className: 'dcp-tablewrap' },
          h('table', { className: 'dcp-table' },
            h('thead', null, h('tr', null,
              h('th', null, '#'),
              h('th', null, t('label.region')),
              plans.map((plan) => h('th', { key: plan, className: 'dcp-num' }, PLAN_LABELS[plan] ?? plan)),
              h('th', { className: 'dcp-num' }, `${t('label.vsUs')} · ${focusLabel}`))),
            h('tbody', null, regions.map((region, index) => {
              const ratio = ratioOf(region)
              const miss = failed.get(region)
              return h('tr', { key: region },
                h('td', null, h('span', { className: 'dcp-rank' }, String(index + 1))),
                h('td', null,
                  h(RegionCell, { region, locale }),
                  miss === undefined ? null : h('div', { className: 'dcp-muted', title: miss.error }, t('label.failed'))),
                plans.map((plan) => {
                  const row = byKey.get(`${region}:${plan}`)
                  const best = plan === focus && cheapestCny !== undefined && row?.cny === cheapestCny
                  return h(PriceCell, { key: plan, t, row, snapshot, best })
                }),
                h('td', { className: 'dcp-num dcp-muted' }, ratio === undefined ? '—' : `${ratio.toFixed(2)}×`))
            })))))
    }

    const SORT_KEY = 'dsh-chatgpt-price:sort'

    function rememberSort(sort) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, sort)
      } catch {
        // Private mode or a blocked storage partition — the choice just is not sticky.
      }
    }

    function recallSort() {
      try {
        const value = typeof localStorage !== 'undefined' ? localStorage.getItem(SORT_KEY) : null
        return SORTS.includes(value) ? value : 'default'
      } catch {
        return 'default'
      }
    }

    /** The whole board. */
    function PriceBoard({ t, locale }) {
      const board = useBoard()
      const snapshot = board.snapshot
      const [only, setOnly] = useState(undefined)
      const [sort, setSort] = useState(recallSort)

      const available = useMemo(() => new Set((snapshot?.prices ?? []).map((row) => row.plan)), [snapshot])
      const used = PLANS.filter((plan) => available.has(plan))
      const shown = used.length > 0 ? used : ['plus']
      const plans = only !== undefined && available.has(only) ? [only] : shown
      // The plan the summary line and the sort orders read from: the one the
      // reader picked, else Plus (the plan most comparisons are about).
      const fallbackFocus = shown.includes('plus') ? 'plus' : shown[0] ?? 'plus'
      const focus = only !== undefined && available.has(only) ? only : fallbackFocus
      const hasPrices = (snapshot?.prices ?? []).length > 0

      const changeSort = (value) => {
        const next = SORTS.includes(value) ? value : 'default'
        setSort(next)
        rememberSort(next)
      }

      const planOptions = shown.map((plan) => ({ value: plan, label: PLAN_LABELS[plan] ?? plan }))
      const sortOptions = [
        { value: 'default', label: t('sort.default') },
        { value: 'cheap', label: t('sort.cheap') },
        { value: 'dear', label: t('sort.dear') },
        { value: 'ratio', label: t('sort.ratio') },
      ]

      return h('div', { className: 'dcp-root' },
        h('div', { className: 'dcp-head' },
          h('div', null,
            h('h3', { className: 'dcp-title' }, t('page.title')),
            h('p', { className: 'dcp-sub' }, t('page.subtitle'))),
          h('div', { className: 'dcp-actions' },
            h(StatusBadge, { t, snapshot, busy: board.busy }),
            h('button', {
              className: 'dcp-btn dcp-btn--primary',
              disabled: board.busy,
              onClick: board.refresh,
            }, board.busy ? t('state.refreshing') : t('action.refresh')))),
        typeof board.error === 'string' ? h('div', { className: 'dcp-error' }, `${t('error.title')}: ${board.error}`) : null,
        snapshot === undefined && board.loading ? h('div', { className: 'dcp-empty' }, t('state.loading')) : null,
        snapshot !== undefined && !hasPrices
          ? h('div', { className: 'dcp-empty' },
            h('strong', null, t('empty.title')),
            h('span', null, snapshot.error ?? t('empty.body')))
          : null,
        hasPrices
          ? h('div', { className: 'dcp-controls' },
            planOptions.length > 1
              ? h('div', { className: 'dcp-chips', role: 'group', 'aria-label': t('label.focus') },
                planOptions.map((option) => h('button', {
                  key: option.value,
                  type: 'button',
                  className: `dcp-chip ${focus === option.value ? 'dcp-chip--on' : ''}`,
                  title: t('label.focusHint'),
                  'aria-pressed': focus === option.value ? 'true' : 'false',
                  onClick: () => {
                    // Picking a plan narrows the table to that column, and
                    // picks it again to get every column back.
                    setOnly(only === option.value ? undefined : option.value)
                  },
                }, option.label)),
                h('span', { className: 'dcp-muted' }, t('state.allPlans')))
              : null,
            h(Select, {
              label: t('label.sort'),
              value: sort,
              options: sortOptions,
              onChange: changeSort,
            }))
          : null,
        hasPrices ? h(PriceTable, { t, snapshot, locale, plans, focus, sort }) : null,
        snapshot !== undefined && hasPrices
          ? h('div', { className: 'dcp-notes' },
            h('span', null,
              `${t('label.updatedAt')} ${formatTime(snapshot.fetchedAt, locale)}`,
              snapshot.status === 'partial' || snapshot.status === 'stale' ? ` · ${snapshot.message ?? ''}` : ''),
            h('span', null,
              `${t('label.rate')}: $1 = ¥${formatFixed(snapshot.cnyPerUsd, 2)}`,
              (snapshot.failedRegions ?? []).length > 0
                ? ` · ${t('label.failed')}: ${snapshot.failedRegions.map((item) => item.region).join(', ')}`
                : ''),
            h('span', null, t('note.source')),
            h('span', null, t('note.rate')),
            h('span', null, t('note.hkcn')))
          : null)
    }

    // ---------------------------------------------------------------------
    // Extension points
    // ---------------------------------------------------------------------

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chatgpt-price: dictionaries')
      const t = ctx.locale.bind(NS)
      const activeLocale = () => {
        try {
          return ctx.locale.getSnapshot?.().active ?? 'zh-CN'
        } catch {
          return 'zh-CN'
        }
      }

      // The reliable home: a Settings page of its own.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chatgpt-price',
        order: 120,
        label: () => t('meta.title'),
      }, () => h('div', { style: { padding: '8px 18px 24px', maxWidth: '1040px' } },
        h(PriceBoard, { t, locale: activeLocale() }))))

      // Optional: a sidebar tab when dsh-better-sidebar is installed.
      ctx.inject(['betterSidebar'], (sideCtx) => {
        const service = sideCtx.betterSidebar ?? sideCtx.get?.('betterSidebar')
        if (service === undefined || typeof service.registerTab !== 'function') return
        const dispose = service.registerTab({
          id: 'chatgpt-price:board',
          title: () => t('meta.title'),
          description: t('page.subtitle'),
          icon: h('svg', {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('path', { d: 'M3 17l5-5 4 3 4-6 5 4' }),
          h('path', { d: 'M3 21h18' })),
          order: 90,
          component: () => h('div', { style: { padding: '10px 12px' } }, h(PriceBoard, { t, locale: activeLocale() })),
        })
        if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-chatgpt-price: sidebar tab')
      })
    }

    return { inject, apply }
  },
})
