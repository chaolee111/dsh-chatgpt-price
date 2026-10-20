/**
 * A small, dependency-free rate limiter for outbound HTTP.
 *
 * OpenAI answers a burst of forty geo-localized pricing requests from one IP
 * with 429s that would then be recorded as a broken day, so every request the
 * board makes goes through one of these: `perSecond` caps the start rate and
 * `atOnce` caps the in-flight count. Both are simple semaphore-style tokens,
 * fulfilled in FIFO order.
 *
 * @module dsh-chatgpt-price/limiter
 */

/**
 * Create a limiter.
 * @param {{ atOnce?: number, perSecond?: number }} [options] - caps; alike requests share one limiter.
 * @returns {(task: () => Promise<T>) => Promise<T>} a scheduler that resolves with the task's value.
 * @template T
 */
export function createLimiter(options = {}) {
  const atOnce = Math.max(1, options.atOnce ?? 4)
  const perSecond = Math.max(0, options.perSecond ?? 8)
  const minGap = perSecond === 0 ? 0 : 1000 / perSecond
  let active = 0
  let lastStart = 0
  const queue = []

  const pump = () => {
    while (queue.length > 0 && active < atOnce) {
      const now = Date.now()
      const wait = Math.max(0, lastStart + minGap - now)
      if (wait > 0) {
        setTimeout(pump, wait)
        return
      }
      const job = queue.shift()
      active += 1
      lastStart = now
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    pump()
  })
}
