// The fence's arithmetic, kept free of `$` so tests can call it directly.

import type { FenceBonus, FenceCalibration, FenceHistoryEntry, FenceRates, FenceTally, FenceLimits, FenceLoop, FenceMeasure, FenceRun } from '../types'

export const MAIN = 'main'

/** Off until the person turns it on; the limits below are kept either way. */
export const DEFAULT_LIMITS: FenceLimits = {
  isOn: false,
  minutes: 0,
  tokens: 0,
  share: 0,
  weeklyShare: 0,
}

const NO_BONUS: FenceBonus = { minutes: 0, tokens: 0, share: 0, weeklyShare: 0 }

/** How much room one Allow adds, as a fraction of the limit itself. */
const RAISE = 0.5

/** At this fraction of a limit the meter turns amber. */
export const WARN_AT = 0.8

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** Tokens a request counts toward the token limit; cache reads are left out, they repeat the context. */
export function tokensOf(usage: Usage): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
}

/**
 * A request's weight, for splitting a prompt's share between its loops.
 * Rough price ratios between model families; only the proportions matter.
 */
/** A request's token weight, the same for every model: input, cache writes, a little for cache reads, output most. */
export function rawUnitsOf(usage: Usage): number {
  return usage.input_tokens + 1.25 * usage.cache_creation_input_tokens + 0.1 * usage.cache_read_input_tokens + 5 * usage.output_tokens
}

/** A model's name with its date and context-size tags dropped, so one model keeps one rate. */
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '').trim() || 'unknown'
}

export function unitsOf(model: string, usage: Usage): number {
  const family = /haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 3 : /opus|fable/i.test(model) ? 5 : 3
  return (
    family *
    (usage.input_tokens +
      1.25 * usage.cache_creation_input_tokens +
      0.1 * usage.cache_read_input_tokens +
      5 * usage.output_tokens)
  )
}

export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

export function planOf(readings: readonly Reading[]): { hasSession: boolean; hasWeekly: boolean } | null {
  if (readings.length === 0) return null
  return {
    hasSession: readings.some(r => r.kind === 'five_hour'),
    hasWeekly: readings.some(r => r.kind === 'seven_day'),
  }
}

export function newRun(id: string, now: number, readings: readonly Reading[], prompt = '', rates: FenceRates = {}): FenceRun {
  return withReading(
    {
      id,
      prompt: promptLine(prompt),
      startedAt: now,
      endedAt: null,
      pausedMs: 0,
      pauseStartedAt: null,
      five: null,
      week: null,
      tokens: 0,
      rates,
      modelUnits: {},
      loops: [mainLoop()],
      bonus: NO_BONUS,
      status: 'running',
      reason: null,
      pausedToolUseId: null,
      pauses: 0,
    },
    readings,
  )
}

function mainLoop(): FenceLoop {
  return { id: MAIN, label: 'Main session', toolUseId: null, units: 0, steps: 0, isRunning: true, isBackground: false }
}

/** The first line of a prompt, short enough for a history row. */
export function promptLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

export const HISTORY_SIZE = 30

/** A finished run as the history keeps it. */
export function historyEntryOf(run: FenceRun, reply = ''): FenceHistoryEntry {
  return {
    id: run.id,
    prompt: run.prompt,
    reply: promptLine(reply),
    startedAt: run.startedAt,
    activeMs: activeMs(run, run.endedAt ?? run.startedAt),
    tokens: run.tokens,
    sessionPct: run.five ? shareOf(run, 'five').value : null,
    weeklyPct: run.week ? shareOf(run, 'week').value : null,
    sessionIsExact: shareOf(run, 'five').isExact,
    weeklyIsExact: shareOf(run, 'week').isExact,
    sessionNowPct: run.five?.nowPct ?? null,
    weeklyNowPct: run.week?.nowPct ?? null,
    agents: run.loops.filter(l => l.id !== MAIN).length,
    pauses: run.pauses,
    wasStopped: run.status === 'denied' || run.pausedToolUseId !== null,
  }
}

export function withHistory(history: readonly FenceHistoryEntry[], entry: FenceHistoryEntry): FenceHistoryEntry[] {
  return [entry, ...history.filter(h => h.id !== entry.id)].slice(0, HISTORY_SIZE)
}

/** Folds one window's reading into what the prompt saw, carrying over a reset. */
function measured(prev: FenceMeasure | null, reading: Reading | undefined): FenceMeasure | null {
  if (!reading) return prev
  const resetsAt = reading.resetsAt ?? prev?.resetsAt ?? null
  if (!prev) return { startPct: reading.percentUsed, nowPct: reading.percentUsed, carriedPct: 0, resetsAt }
  const hasReset = prev.resetsAt !== null && resetsAt !== prev.resetsAt && reading.percentUsed < prev.nowPct
  const base = hasReset ? { ...prev, carriedPct: usedOf(prev), startPct: 0 } : prev
  return { ...base, nowPct: reading.percentUsed, resetsAt }
}

export function withReading(run: FenceRun, readings: readonly Reading[]): FenceRun {
  return {
    ...run,
    five: measured(run.five, readings.find(r => r.kind === 'five_hour')),
    week: measured(run.week, readings.find(r => r.kind === 'seven_day')),
  }
}

/** How much of a window this prompt has used. */
export function usedOf(m: FenceMeasure | null): number {
  if (!m) return 0
  return m.carriedPct + Math.max(0, m.nowPct - m.startPct)
}

export const NO_TALLY: FenceTally = { five: { units: 0, pct: 0 }, week: { units: 0, pct: 0 } }

/** Whole points of a window seen for a model before its learned rate is trusted. */
const MIN_POINTS = 3
/** Past this many points the totals are halved, so recent prompts weigh more than old ones. */
const MAX_POINTS = 40
/** A prompt teaches a model's rate only when that model did at least this much of its work. */
const SOLE_MODEL = 0.9

/** Request weight across every loop of the prompt. */
export function totalUnits(run: FenceRun): number {
  return run.loops.reduce((sum, l) => sum + l.units, 0)
}

/** How finely a window's readings come: whole points in practice, tenths where the plan reports them. */
function grainOf(m: FenceMeasure): number {
  return Number.isInteger(m.startPct) && Number.isInteger(m.nowPct) ? 1 : 0.1
}

export type Share = { value: number; isExact: boolean; isEstimate: boolean }

/**
 * This prompt's share of a window, as finely as can be known.
 *
 * The plan reports whole points, so the measured difference between two readings
 * can be off by up to one point either way. Each model's rate (window points per
 * unit of token weight) is learned from earlier prompts that model did alone; when
 * every model this prompt used has one, the share is estimated from its work and
 * kept within a point of the readings. Otherwise the readings stand, rounded.
 */
export function shareOf(run: FenceRun, which: 'five' | 'week'): Share {
  const m = run[which]
  if (!m) return { value: 0, isExact: true, isEstimate: false }
  const measured = usedOf(m)
  const grain = grainOf(m)
  if (grain < 1) return { value: measured, isExact: true, isEstimate: false }
  const used = Object.entries(run.modelUnits ?? {}).filter(([, units]) => units > 0)
  const rated = used.map(([model, units]) => {
    const rate = run.rates?.[model]?.[which] ?? null
    return rate === null ? null : units * rate
  })
  if (used.length === 0 || rated.some(x => x === null)) return { value: measured, isExact: false, isEstimate: false }
  const estimate = (rated as number[]).reduce((a, b) => a + b, 0)
  return { value: Math.min(measured + grain, Math.max(Math.max(0, measured - grain), estimate)), isExact: false, isEstimate: true }
}

/** Folds a finished prompt into its model's learning totals, when one model did nearly all of it. */
export function withCalibrated(cal: FenceCalibration, run: FenceRun): FenceCalibration {
  const entries = Object.entries(run.modelUnits ?? {})
  const total = entries.reduce((sum, [, u]) => sum + u, 0)
  const top = entries.reduce<[string, number] | null>((a, b) => (a === null || b[1] > a[1] ? b : a), null)
  if (!top || total === 0 || top[1] / total < SOLE_MODEL) return cal
  const [model, units] = top
  const fold = (prev: { units: number; pct: number }, m: FenceMeasure | null) => {
    if (!m) return prev
    const next = { units: prev.units + units, pct: prev.pct + usedOf(m) }
    return next.pct > MAX_POINTS ? { units: next.units / 2, pct: next.pct / 2 } : next
  }
  const prev = cal[model] ?? NO_TALLY
  return { ...cal, [model]: { five: fold(prev.five, run.five), week: fold(prev.week, run.week) } }
}

export function ratesOf(cal: FenceCalibration): FenceRates {
  const rate = (c: { units: number; pct: number }) => (c.pct >= MIN_POINTS && c.units > 0 ? c.pct / c.units : null)
  return Object.fromEntries(Object.entries(cal).map(([model, t]) => [model, { five: rate(t.five), week: rate(t.week) }]))
}

/**
 * A share as it is said: exact readings plainly, everything else with "~".
 * A rounded reading that did not move reads "<1%", alone: never two signs side by side ("~<", "+<").
 */
export function shareText(s: Share): string {
  if (s.isExact) return pct(s.value)
  if (!s.isEstimate && s.value === 0) return '<1%'
  return `~${pct(s.value)}`
}

/** A loop's slice of the prompt's primary share, by the weight of its requests. */
export function loopShare(run: FenceRun, loopId: string): number {
  const total = run.loops.reduce((sum, l) => sum + l.units, 0)
  const loop = run.loops.find(l => l.id === loopId)
  if (!loop || total === 0) return 0
  return (shareOf(run, run.five ? 'five' : 'week').value * loop.units) / total
}

export function activeMs(run: FenceRun, now: number): number {
  const paused = run.pausedMs + (run.pauseStartedAt === null ? 0 : now - run.pauseStartedAt)
  return Math.max(0, (run.endedAt ?? now) - run.startedAt - paused)
}

export function withStep(run: FenceRun, loopId: string, model: string, usage: Usage | null): FenceRun {
  const loops = run.loops.some(l => l.id === loopId) ? run.loops : [...run.loops, orphanLoop(loopId)]
  return {
    ...run,
    tokens: run.tokens + (usage ? tokensOf(usage) : 0),
    modelUnits: usage
      ? { ...(run.modelUnits ?? {}), [modelKey(model)]: (run.modelUnits?.[modelKey(model)] ?? 0) + rawUnitsOf(usage) }
      : run.modelUnits,
    loops: loops.map(l =>
      l.id === loopId ? { ...l, steps: l.steps + 1, units: l.units + (usage ? unitsOf(model, usage) : 0) } : l,
    ),
  }
}

function orphanLoop(id: string): FenceLoop {
  return { id, label: 'Subagent', toolUseId: null, units: 0, steps: 0, isRunning: true, isBackground: false }
}

export function withLoop(run: FenceRun, loop: FenceLoop): FenceRun {
  const others = run.loops.filter(l => l.id !== loop.id)
  const prior = run.loops.find(l => l.id === loop.id)
  return { ...run, loops: [...others, prior ? { ...loop, units: prior.units, steps: prior.steps } : loop] }
}

export function withLoopDone(run: FenceRun, loopId: string, now: number): FenceRun {
  const loops = run.loops.map(l => (l.id === loopId ? { ...l, isRunning: false } : l))
  const isDone = loops.every(l => !l.isRunning)
  return isDone ? { ...run, loops, status: 'done', endedAt: now } : { ...run, loops }
}

/** The four limits that measure a prompt against a cap. */
export type Gauge = keyof FenceBonus

export type Trip = { kind: Gauge; reason: string }

/** Where a prompt stands against one gauge: used, the cap in force (0 = off), and whether it applies. */
export type GaugeReading = { used: number; cap: number; base: number; share?: Share }

export function gaugeOf(run: FenceRun, limits: FenceLimits, gauge: Gauge, now: number): GaugeReading | null {
  const base = limits[gauge]
  const cap = base === 0 ? 0 : base + run.bonus[gauge]
  switch (gauge) {
    case 'minutes':
      return { used: activeMs(run, now) / 60_000, cap, base }
    case 'tokens':
      return { used: run.tokens, cap, base }
    case 'share':
      return run.five ? (s => ({ used: s.value, cap, base, share: s }))(shareOf(run, 'five')) : null
    case 'weeklyShare':
      return run.week ? (s => ({ used: s.value, cap, base, share: s }))(shareOf(run, 'week')) : null
  }
}

const GAUGES: Gauge[] = ['share', 'weeklyShare', 'tokens', 'minutes']

/** Whether the next tool call should wait for the person, and why. */
export function tripOf(run: FenceRun, limits: FenceLimits, now: number): Trip | null {
  if (!limits.isOn || run.status === 'done') return null
  for (const gauge of GAUGES) {
    const g = gaugeOf(run, limits, gauge, now)
    if (g && g.cap > 0 && g.used >= g.cap) return { kind: gauge, reason: `This prompt has used ${formatUsed(gauge, g.used, g.share)}` }
  }
  return null
}

/** What allowing a paused call grants: room past the limit that tripped. */
export function withAllowed(run: FenceRun, limits: FenceLimits, trip: Trip, now: number): FenceRun {
  const resumed = { ...run, ...endPause(run, now), status: 'running' as const, reason: null, pausedToolUseId: null }
  const g = gaugeOf(run, limits, trip.kind, now)
  if (!g) return resumed
  return { ...resumed, bonus: { ...run.bonus, [trip.kind]: g.used - g.base + g.base * RAISE } }
}

/** A limit the person just changed takes effect as set, dropping room an earlier Allow gave. */
export function withLimitChanged(run: FenceRun, key: keyof FenceLimits): FenceRun {
  if (key in run.bonus) return { ...run, bonus: { ...run.bonus, [key]: 0 } }
  return run
}

export function withPaused(run: FenceRun, trip: Trip, toolUseId: string | null, now: number): FenceRun {
  return {
    ...run,
    status: 'paused',
    reason: trip.reason,
    pausedToolUseId: toolUseId,
    pauseStartedAt: run.pauseStartedAt ?? now,
    pauses: run.pauses + 1,
  }
}

export function withDenied(run: FenceRun, now: number): FenceRun {
  return { ...run, ...endPause(run, now), status: 'denied', pausedToolUseId: null }
}

function endPause(run: FenceRun, now: number): Pick<FenceRun, 'pausedMs' | 'pauseStartedAt'> {
  const extra = run.pauseStartedAt === null ? 0 : now - run.pauseStartedAt
  return { pausedMs: run.pausedMs + extra, pauseStartedAt: null }
}

/** What an Allow will raise the tripped limit to, said in the prompt. */
export function raiseNote(limits: FenceLimits, trip: Trip): string {
  return `Allowing gives it ${formatCap(trip.kind, limits[trip.kind] * RAISE)} more.`
}

/** A gauge's amount as the pane and band say it. */
export function formatUsed(gauge: Gauge, n: number, share?: Share): string {
  const p = share ? shareText(share) : pct(n)
  switch (gauge) {
    case 'minutes':
      return duration(n * 60_000)
    case 'tokens':
      return `${tokens(n)} tokens`
    case 'share':
      return `${p} of your session limit`
    case 'weeklyShare':
      return `${p} of your weekly limit`
  }
}

function formatCap(gauge: Gauge, n: number): string {
  return gauge === 'share' || gauge === 'weeklyShare' ? pct(n) : formatUsed(gauge, n)
}

/** The one figure the working line shows: whichever limit is closest. */
export type Meter = { text: string; ratio: number; isWarning: boolean }

export function meterOf(run: FenceRun, limits: FenceLimits, now: number): Meter | null {
  if (!limits.isOn) return null
  const candidates: Meter[] = []
  for (const gauge of GAUGES) {
    const g = gaugeOf(run, limits, gauge, now)
    if (!g || g.cap === 0) continue
    const ratio = g.used / g.cap
    candidates.push({ ratio, isWarning: ratio >= WARN_AT, text: `${shortUsed(gauge, g.used, g.share)} of ${shortUsed(gauge, g.cap)}` })
  }
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.ratio > a.ratio ? b : a))
}

function shortUsed(gauge: Gauge, n: number, share?: Share): string {
  const p = share ? shareText(share) : pct(n)
  switch (gauge) {
    case 'minutes':
      return duration(n * 60_000)
    case 'tokens':
      return tokens(n)
    case 'share':
      return `${p} session`
    case 'weeklyShare':
      return `${p} weekly`
  }
}

export function pct(n: number): string {
  // A sliver shows its own digits ("0.04%") rather than a "<" sign.
  if (n > 0 && n < 0.1) return `${Math.max(0.01, Math.round(n * 100) / 100).toFixed(2)}%`
  return n < 10 ? `${(Math.round(n * 10) / 10).toFixed(1)}%` : `${Math.round(n)}%`
}

export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n / 100_000) / 10}M`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${m}m` : `${m}m ${s % 60}s`
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function resetTime(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase()
}

const NUM = /^\d+(\.\d+)?%?$/

function tokenCount(word: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(word)
  if (!m) return null
  return Math.round(parseFloat(m[1]!) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1))
}

/** Parses `/fence` arguments; answers the new limits or a message. */
export function parseArgs(args: string, limits: FenceLimits, hasSession = true): { limits: FenceLimits; said: string } | { error: string } {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let next = { ...limits }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const value = words[i + 1]
    const isOff = value === 'off'
    if (word === 'off') next.isOn = false
    else if (word === 'on') next.isOn = true
    else if (word === 'reset') next = { ...DEFAULT_LIMITS, isOn: next.isOn }
    else if (/^\d+(\.\d+)?%$/.test(word)) next.share = parseFloat(word)
    else if (/^\d+m$/.test(word)) next.minutes = parseInt(word, 10)
    else if ((word === 'session' || word === 'weekly') && value && (isOff || NUM.test(value))) {
      const n = isOff ? 0 : parseFloat(value)
      if (word === 'session') next.share = n
      else next.weeklyShare = n
      i++
    } else if (word === 'tokens' && value && (isOff || tokenCount(value) !== null)) {
      next.tokens = isOff ? 0 : tokenCount(value)!
      i++
    } else if (word === 'time' && value && (isOff || /^\d+m?$/.test(value))) {
      next.minutes = isOff ? 0 : parseInt(value, 10)
      i++
    } else {
      return {
        error: `Didn't understand "${word}". Try: /fence time 20m, /fence tokens 500k, /fence session 10%, /fence weekly 2%, /fence off`,
      }
    }
  }
  return { limits: next, said: describe(next, hasSession) }
}

/** What the fence will do, in a sentence. `hasSession` is false when the plan has no 5-hour window to measure. */
export function describe(limits: FenceLimits, hasSession = true): string {
  if (!limits.isOn) return 'Budget fence is off. Your limits are kept for when you turn it on.'
  const parts = [
    limits.minutes > 0 ? `${duration(limits.minutes * 60_000)} of work` : null,
    limits.tokens > 0 ? `${tokens(limits.tokens)} tokens` : null,
    hasSession && limits.share > 0 ? `${pct(limits.share)} of the session limit` : null,
    limits.weeklyShare > 0 ? `${pct(limits.weeklyShare)} of the weekly limit` : null,
  ].filter(Boolean)
  const said = parts.length > 0 ? `Each prompt pauses at ${parts.join(', ')}.` : 'Budget fence is on, but no limit is set that applies to your plan.'
  return !hasSession && limits.share > 0
    ? `${said} Your plan has no session limit, so the ${pct(limits.share)} session limit does nothing; /fence session off clears it.`
    : said
}

/** Reads what the person typed as a custom value for one setting; null when it makes no sense. */
export function parseLimitInput(gauge: Gauge, text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '')
  if (t === '') return null
  if (['0', 'off', 'none', 'no limit'].includes(t)) return 0
  switch (gauge) {
    case 'minutes': {
      const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?/g)]
      if (parts.length === 0 || t.replace(/[\d.\s]|hours?|hrs|hr|h|minutes?|mins|min|m/g, '') !== '') return null
      const total = parts.reduce((sum, m) => sum + parseFloat(m[1]!) * (m[2]?.startsWith('h') ? 60 : 1), 0)
      return total > 0 ? Math.round(total * 10) / 10 : null
    }
    case 'tokens': {
      const n = tokenCount(t.replace(/\s*tokens?$/, '').replace(/\s+/g, ''))
      return n !== null && n > 0 ? n : null
    }
    default: {
      const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(t)
      if (!m) return null
      const n = parseFloat(m[1]!)
      return n > 0 && n <= 100 ? n : null
    }
  }
}

/** How a setting's value reads in its dropdown. */
export function limitLabel(gauge: Gauge, n: number): string {
  if (n === 0) return 'No limit'
  switch (gauge) {
    case 'minutes':
      return n >= 60 && n % 60 === 0 ? `${n / 60} ${n === 60 ? 'hour' : 'hours'}` : n > 60 ? duration(n * 60_000) : `${n} min`
    case 'tokens':
      return tokens(n)
    default:
      return `${n}%`
  }
}
