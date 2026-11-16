import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, RenderInput, Space } from 'claude-code'

import type { FenceAgent, FenceCalibration, FenceHistoryEntry, FenceLimits, FenceRun, FenceTally } from '../types'
import {
  DEFAULT_LIMITS,
  MAIN,
  WARN_AT,
  activeMs,
  describe,
  formatUsed,
  duration,
  gaugeOf,
  loopShare,
  newRun,
  parseArgs,
  pct,
  planOf,
  raiseNote,
  resetTime,
  tokens,
  tripOf,
  ratesOf,
  shareOf,
  shareText,
  withCalibrated,
  withAllowed,
  withDenied,
  withLimitChanged,
  withLoop,
  withLoopDone,
  withPaused,
  withReading,
  withResumed,
  raisedLimit,
  withStep,
  withUnfenced,
  historyEntryOf,
  withHistory,
  limitLabel,
  parseLimitInput,
  promptLine,
  describeAgents,
  isAgentArgs,
  newAgentRun,
  ownerOf,
  parseAgentArgs,
  unitsOf,
  withOther,
} from './fence'
import type { Gauge, Reading, Trip } from './fence'
import { drawPrompt, promptContent } from './live'
import type { PromptPart, PromptStat, PromptView } from './live'

const PANE = 'budget-fence'
const TITLE = 'Budget fence'
const STORE_KEY = 'limits'

const limitsAtom = atom({ plugin: 'budget-fence', key: 'limits' } as const, DEFAULT_LIMITS, { shape: 'limits-1' })
// run-2: background agents left the prompt's run for runs of their own.
const runAtom = atom({ plugin: 'budget-fence', key: 'run' } as const, null, { shape: 'run-2' })
const agentsAtom = atom({ plugin: 'budget-fence', key: 'agents' } as const, [], { shape: 'agents-1' })
const agentLimitsAtom = atom({ plugin: 'budget-fence', key: 'agentLimits' } as const, DEFAULT_LIMITS, { shape: 'agent-limits-1' })
const agentOpenAtom = atom({ plugin: 'budget-fence', key: 'agentOpen' } as const, null, { shape: 'agent-open-1' })
const sessionNameAtom = atom({ plugin: 'budget-fence', key: 'sessionName' } as const, null, { shape: 'session-name-1' })
/** What a new session's background agents start with: the last set in any session. */
const AGENT_STORE_KEY = 'agent-limits'
/** Finished background agents kept in the pane until the next prompt, newest first, beside the running ones. */
const FINISHED_AGENTS = 5
const historyAtom = atom({ plugin: 'budget-fence', key: 'history' } as const, [], { shape: 'history-1' })
const HISTORY_PANE = 'budget-fence-history'
const HISTORY_KEY = 'history'
// What each model has learned about its rate, keyed by model.
const CALIBRATION_KEY = 'calibration'
const editingAtom = atom({ plugin: 'budget-fence', key: 'editing' } as const, null, { shape: 'editing-1' })
const recentOpenAtom = atom({ plugin: 'budget-fence', key: 'recentOpen' } as const, false, { shape: 'recent-1' })
const agentsOpenAtom = atom({ plugin: 'budget-fence', key: 'agentsOpen' } as const, false, { shape: 'agents-open-1' })
const planAtom = atom({ plugin: 'budget-fence', key: 'plan' } as const, null, { shape: 'plan-1' })

/**
 * Keep the run and history here so reading them while drawing the pane doesn't
 * subscribe it to every update. The live figures update through their Client.
 */
const pane = {
  run: null as FenceRun | null,
  agents: [] as FenceAgent[],
  history: [] as FenceHistoryEntry[],
  /** The pane's drawing in progress: each waits for the one before, so none answers out of turn. */
  drawing: Promise.resolve() as Promise<unknown>,
  /** Whether a surface without `Client` draws the pane: its live figures are plain text, so it redraws each step. */
  hasPlainSurface: false,
  /** The run's changes in progress: each waits for the one before, so `run` above is always the last one written. */
  changing: Promise.resolve() as Promise<unknown>,
  /** The rings the pane last drew around its figures' icons, to redraw it only when one steps. */
  rings: '',
}

// Desktop sometimes requests the focus redraw before it reports the focused
// element. Replacing the Select while its menu is open resets the highlight.
const desktop = {
  props: null as string | null,
  isFocused: false,
  limit: null as string | null,
  isChoosing: false,
  focusRevision: 0,
  wake: undefined as (() => void) | undefined,
  /**
   * The dropdown a value was just picked in. Its menu has closed, but the desktop may report the
   * focus on it again; that is no menu opening, so it holds no drawing back.
   */
  picked: null as string | null,
}

/**
 * A press on one of the pane's buttons: no dropdown menu can be open, whatever focus the desktop
 * last reported (a button sends none of its own), so a drawing held behind a menu goes ahead.
 */
function releaseHold() {
  desktop.focusRevision += 1
  desktop.limit = null
  desktop.isChoosing = false
  desktop.picked = null
  desktop.wake?.()
}

/** A pane button's handler, run once any drawing held behind a dropdown is let go. */
const pressed = (fn: () => unknown) => () => {
  releaseHold()
  void fn()
}

async function waitForDesktopFocus($: EngineInterface, ms: number) {
  let wake!: () => void
  const changed = new Promise<void>(resolve => { wake = resolve })
  desktop.wake = wake
  try {
    await Promise.race([changed, $.clock.sleep(ms)])
  } finally {
    if (desktop.wake === wake) desktop.wake = undefined
  }
}

/** This load of the module: the live block keeps the newest view per load, so another session's never mixes in. */
const LOAD = String(Math.random()).slice(2)

/** Wait for the focus event, and keep render replies in request order. */
function drawPaneInTurn<T>($: EngineInterface, e: RenderInput<'Pane'>, draw: () => Promise<T>): Promise<T> {
  const isDesktop = e.surface === 'desktop'
  const layout = isDesktop ? JSON.stringify({ ...e.props, isFocused: undefined }) : null
  const sameLayout = isDesktop && layout === desktop.props
  const gainedFocus = sameLayout && e.props.isFocused && !desktop.isFocused
  if (isDesktop) {
    desktop.props = layout
    desktop.isFocused = e.props.isFocused
    if (!e.props.isFocused) {
      // A blur can arrive behind the redraw it needs to unblock.
      desktop.focusRevision += 1
      desktop.limit = null
      desktop.isChoosing = false
      desktop.wake?.()
    }
  }
  const drawn = pane.drawing.then(async () => {
    if (gainedFocus && desktop.isFocused && !desktop.isChoosing) await waitForDesktopFocus($, 200)
    if (sameLayout && desktop.isFocused && desktop.isChoosing) await waitForDesktopFocus($, 30_000)
    return draw()
  })
  pane.drawing = drawn.catch(() => undefined)
  return drawn
}

/**
 * What the pane calls this session: its folder, and its first prompt once there is one
 * (read back from the transcript on a resume).
 */
async function sessionNameOf($: EngineInterface): Promise<{ folder: string; prompt: string }> {
  const root = await $.session.root().catch(() => '')
  const folder = root.split('/').filter(Boolean).pop() ?? ''
  const messages = await $.session.messages().catch(() => [])
  const first = Array.isArray(messages) ? messages.find(m => m.role === 'user' && m.text.trim() && !m.text.trim().startsWith('<')) : undefined
  return { folder, prompt: first ? promptLine(first.text) : '' }
}

/** The session's name on one line. */
function nameText(name: { folder: string; prompt: string } | null): string {
  return [name?.folder, name?.prompt].filter(Boolean).join(' · ')
}

/** Saved limits, checked key by key and filled out with the defaults. */
function savedLimits(value: unknown): FenceLimits | null {
  if (typeof value !== 'object' || value === null) return null
  // Only known keys of the right type are kept.
  const saved = value as Partial<FenceLimits>
  const v: FenceLimits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof FenceLimits)[]) {
    if (typeof saved[key] === typeof DEFAULT_LIMITS[key] && (typeof saved[key] !== 'number' || Number.isFinite(saved[key]))) {
      Object.assign(v, { [key]: saved[key] })
    }
  }
  return v
}

/** What earlier prompts taught about how much of each window a unit of work costs. */
async function calibration($: EngineInterface): Promise<FenceCalibration> {
  const saved = await $.store.get(CALIBRATION_KEY)
  if (typeof saved !== 'object' || saved === null) return {}
  const ok = (c: unknown) =>
    typeof c === 'object' && c !== null && Number.isFinite((c as { units: number }).units) && Number.isFinite((c as { pct: number }).pct)
  return Object.fromEntries(
    Object.entries(saved as Record<string, FenceTally>).filter(([, t]) => ok(t?.five) && ok(t?.week)),
  )
}

/** Keeps which windows the plan has, so the pane offers only those. */
async function notePlan($: EngineInterface, readings: readonly Reading[]) {
  const plan = planOf(readings)
  if (!plan) return
  // Written only on a change so stable plan details don't redraw the pane.
  const was = await read($, planAtom)
  if (was?.hasSession !== plan.hasSession || was?.hasWeekly !== plan.hasWeekly) await update($, planAtom, () => plan)
}

/**
 * `update` for the run, writing nothing when `fn` hands back the run it was given.
 * The prompt's section refreshes itself (`live.ts`), so the pane, and with it every
 * dropdown and button, is drawn again only when a run first appears; a surface
 * without `Client` draws the section as plain text and is drawn again each step.
 */
async function changeRun($: EngineInterface, fn: (run: FenceRun | null) => FenceRun | null) {
  const changed = pane.changing.then(async () => {
    const run = await read($, runAtom)
    if (fn(run) === run) return
    // The pane draws each figure's icon and name itself, and the prompt between the live blocks,
    // so a figure appearing or going, a new prompt or a pause redraws it.
    const before = runShapeKey(pane.run)
    pane.run = await update($, runAtom, fn)
    if (pane.hasPlainSurface || runShapeKey(pane.run) !== before) {
      $.ui.invalidate('ui.render')
    }
  })
  pane.changing = changed.catch(() => undefined)
  return changed
}

/** What the pane draws of the agents itself (rows, their status, open settings): a change there redraws it. */
function agentRowsKey(agents: readonly FenceAgent[]): string {
  return JSON.stringify(agents.map(a => [a.run.id, a.run.status, a.isCustom, a.limits]))
}

/**
 * `update` for the background agents, as `changeRun` is for the prompt: written only when
 * `fn` changes the list, and the pane drawn again only when a row would look different.
 */
async function changeAgents($: EngineInterface, fn: (agents: FenceAgent[]) => FenceAgent[]) {
  const changed = pane.changing.then(async () => {
    const list = await read($, agentsAtom)
    if (fn(list) === list) return
    const before = agentRowsKey(pane.agents)
    // `fn` is applied to the list as it stands when written, never to the read above: a read
    // answers this hook's moment, so a second agent spawned alongside the first would otherwise
    // write over it. `update` writes against the version it read and tries again on a clash.
    pane.agents = await update($, agentsAtom, l => fn(l ?? []))
    if (pane.hasPlainSurface || agentRowsKey(pane.agents) !== before) $.ui.invalidate('ui.render')
  })
  pane.changing = changed.catch(() => undefined)
  return changed
}

/** The run a scope names (the prompt's, or a background agent's) and the limits it answers to. */
async function fenceOf($: EngineInterface, scope: string): Promise<{ run: FenceRun | null; limits: FenceLimits; agent: FenceAgent | null }> {
  const limits = await read($, limitsAtom)
  if (scope === MAIN) return { run: await read($, runAtom), limits, agent: null }
  const agent = (await read($, agentsAtom)).find(a => a.run.id === scope) ?? null
  return { run: agent?.run ?? null, limits: agent ? agentLimitsOf(agent, limits) : limits, agent }
}

/** An agent's limits as they apply: its own, switched on and off with the session's fence. */
function agentLimitsOf(agent: FenceAgent, session: FenceLimits): FenceLimits {
  return { ...agent.limits, isOn: session.isOn }
}

/** Changes the run a scope names. */
function changeFence($: EngineInterface, scope: string, fn: (run: FenceRun) => FenceRun) {
  if (scope === MAIN) return changeRun($, run => (run ? fn(run) : run))
  return changeAgents($, list => {
    let isChanged = false
    const next = list.map(a => {
      if (a.run.id !== scope) return a
      const run = fn(a.run)
      if (run === a.run) return a
      isChanged = true
      return { ...a, run }
    })
    return isChanged ? next : list
  })
}

/** Keeps the running agents and the last few finished, newest first. */
function prunedAgents(agents: FenceAgent[]): FenceAgent[] {
  const running = agents.filter(a => a.run.status !== 'done')
  const finished = agents.filter(a => a.run.status === 'done').sort((x, y) => (y.run.endedAt ?? 0) - (x.run.endedAt ?? 0))
  return [...running, ...finished.slice(0, FINISHED_AGENTS)]
}

/**
 * Which limits a setting changes: this session's prompts, the defaults its background agents
 * start with, or one background agent's own (`agent:<id>`).
 */
type Target = 'session' | 'background' | `agent:${string}`
const agentTarget = (id: string): Target => `agent:${id}`
const agentIdOf = (target: Target) => (target.startsWith('agent:') ? target.slice('agent:'.length) : null)

/** The keys a target's controls carry: the session's keep the names they always had. */
function controlKey(target: Target, key: string): string {
  if (target === 'session') return key
  if (target === 'background') return `bg-${key}`
  return `a-${agentIdOf(target)}-${key}`
}

/** What the pane draws of a run itself, rather than through its live blocks. */
function runShapeKey(run: FenceRun | null): string {
  if (!run) return ''
  return JSON.stringify([run.id, run.prompt, run.status, run.loops.length > 1, figuresOf(run)])
}

/** Writes the history, for the pane to draw when it next can. */
async function changeHistory($: EngineInterface, fn: (list: FenceHistoryEntry[]) => FenceHistoryEntry[]) {
  pane.history = await update($, historyAtom, list => fn(list ?? []))
  $.ui.invalidate('ui.render')
  return pane.history
}

/** Custom… opens its field; any other pick saves the value and closes the editor. */
async function pickLimit($: EngineInterface, target: Target, key: Gauge, picked: string, isDesktop: boolean) {
  const revision = desktop.focusRevision
  const editKey = controlKey(target, key)
  try {
    if (picked === CUSTOM) {
      await update($, editingAtom, () => ({ key: editKey, error: null }))
      return
    }
    const value = Number(picked)
    if (!Number.isFinite(value) || value < 0) return
    if ((await read($, editingAtom))?.key === editKey) await update($, editingAtom, () => null)
    await saveLimit($, key, value, target)
  } finally {
    // The render held behind the menu must see the new value (or custom field).
    if (isDesktop && desktop.focusRevision === revision) {
      desktop.isChoosing = false
      desktop.picked = `limit-${editKey}`
      desktop.wake?.()
    }
  }
}

/**
 * Saves one setting, applying it to what is already running. This session's limits and its
 * background defaults are its own, and are also what the next session starts with; an
 * agent's own setting is that agent's alone.
 */
async function saveLimit($: EngineInterface, key: keyof FenceLimits, value: FenceLimits[keyof FenceLimits], target: Target = 'session') {
  if (target === 'session') {
    const next = await update($, limitsAtom, l => ({ ...l, [key]: value }))
    await $.store.set(STORE_KEY, next)
    await changeRun($, r => (r && r.status !== 'done' ? withLimitChanged(r, key) : r))
    return
  }
  if (target === 'background') {
    const next = await update($, agentLimitsAtom, l => ({ ...l, [key]: value }))
    await $.store.set(AGENT_STORE_KEY, next)
    // Running agents that have no settings of their own follow the defaults.
    await changeAgents($, list =>
      list.some(a => !a.isCustom && a.run.status !== 'done')
        ? list.map(a => (a.isCustom || a.run.status === 'done' ? a : { ...a, limits: { ...a.limits, [key]: value }, run: withLimitChanged(a.run, key) }))
        : list,
    )
    return
  }
  const id = agentIdOf(target)
  await changeAgents($, list =>
    list.map(a => (a.run.id === id ? { ...a, isCustom: true, limits: { ...a.limits, [key]: value }, run: withLimitChanged(a.run, key) } : a)),
  )
}

/** Each limit as the question names it. */
const LIMIT_NAMES: Record<Gauge, string> = {
  minutes: 'time limit',
  tokens: 'token limit',
  share: 'session share',
  weeklyShare: 'weekly share',
}
const STOP = 'Stop here'
const OPEN = 'Open Budget fence'
const KEEP = 'Continue with the limits as set'
const UNLIMITED = 'Continue with no limits'

/**
 * Asks, where the prompt box is, whether to go on past a tripped limit:
 * continue with no limits for the rest of this prompt, continue and raise
 * that setting, stop, or open the pane to change any of them. Text typed under Other is read as a new value for the tripped limit,
 * and otherwise handed to Claude as the person's words.
 */
export async function askToContinue($: EngineInterface, trip: Trip, scope: string = MAIN): Promise<{ go: true } | { go: false; said?: string }> {
  let hasOpened = false
  let note = ''
  const target: Target = scope === MAIN ? 'session' : agentTarget(scope)
  for (;;) {
    const [{ run, limits }, now] = await Promise.all([fenceOf($, scope), $.clock.now()])
    if (!run) return { go: true }
    const g = gaugeOf(run, limits, trip.kind, now)
    const used = g?.used ?? 0
    const raised = raisedLimit(trip.kind, limits[trip.kind], used)
    const raise = `Continue and raise the ${LIMIT_NAMES[trip.kind]} to ${limitLabel(trip.kind, raised)}`
    const who = scope === MAIN ? 'This prompt' : `Background agent “${run.prompt || 'Subagent'}”`
    const question = `${note}${who} has used ${formatUsed(trip.kind, used, g?.share)}, past its ${LIMIT_NAMES[trip.kind]} of ${limitLabel(trip.kind, g?.cap ?? limits[trip.kind])}. Keep working?`
    note = ''
    let answer: string
    try {
      answer = await $.ui.ask(question, {
        header: 'Budget fence',
        options: hasOpened ? [UNLIMITED, KEEP, raise, STOP] : [UNLIMITED, raise, STOP, OPEN],
      })
    } catch {
      // Dismissed: nobody said go on.
      return { go: false }
    }
    if (answer === STOP) return { go: false }
    if (answer === UNLIMITED) {
      await changeFence($, scope, withUnfenced)
      return { go: true }
    }
    if (answer === raise) {
      await saveLimit($, trip.kind, raised, target)
      return { go: true }
    }
    if (answer === OPEN) {
      // An agent's question opens the pane on that agent's own limits.
      if (scope !== MAIN) await update($, agentOpenAtom, () => scope)
      void $.ui.open({ id: PANE, title: TITLE })
      hasOpened = true
      continue
    }
    // The app's own stand-in for no choice ("[No preference]") is no answer: stop, and quote
    // nothing as if the person had said it.
    if (/^\[[^\]]*\]$/.test(answer.trim())) return { go: false }
    if (answer !== KEEP) {
      const typed = parseLimitInput(trip.kind, answer)
      if (typed === null) return { go: false, said: answer }
      if (typed !== 0 && typed <= used) {
        note = `${limitLabel(trip.kind, typed)} is no more than it has used. `
        continue
      }
      await saveLimit($, trip.kind, typed, target)
      return { go: true }
    }
    // Kept as set: go on unless the pane left this prompt over a limit.
    const [{ run: runNow, limits: limitsNow }, nowNow] = await Promise.all([fenceOf($, scope), $.clock.now()])
    const still = runNow ? tripOf(runNow, limitsNow, nowNow) : null
    if (!still) return { go: true }
    hasOpened = false
    note = 'Still over a limit. '
    trip = still
  }
}

export const register: Register = on => {
  // One question at a time per run: calls that trip while it is open share its answer.
  const asking = new Map<string, ReturnType<typeof askToContinue>>()
  // Calls paused by the fence, by tool_use_id: what tripped, in which loop, and whose run.
  const pending = new Map<string, { trip: Trip; loopId: string; scope: string }>()
  // Which limit holds each run's bar in the band, by run.
  const leadGauges = new Map<string, Gauge>()
  // The text of the prompt last sent, for the run it starts.
  let lastPrompt = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'fence',
      description: 'Pause a prompt or background agent before it uses too much of your usage limit',
      argumentHint: '[background] [time 20m] [tokens 500k] [session 10%] [weekly 2%] [on|off]',
    })
    const history = await $.store.get(HISTORY_KEY)
    if (Array.isArray(history)) await update($, historyAtom, () => history as FenceHistoryEntry[])
    // Debugging once kept a trace here; it is no longer written.
    await $.store.delete('debug-trace').catch(() => undefined)
    // A reload starts the module over; the session's values outlive it.
    pane.run = await read($, runAtom)
    pane.agents = await read($, agentsAtom)
    pane.history = await read($, historyAtom)
    // Each session keeps its own limits: a new one starts from the last set in any session, and
    // a reload of this one keeps what it had, whatever another session has set since.
    if ((await $.state.get({ plugin: 'budget-fence', key: 'limits' })).version === 0) {
      const saved = savedLimits(await $.store.get(STORE_KEY))
      // The limits are this session's from here on, even left as they are.
      await update($, limitsAtom, l => saved ?? { ...l })
    }
    if ((await $.state.get({ plugin: 'budget-fence', key: 'agentLimits' })).version === 0) {
      // New agents start with no limits until the person sets some; what they set is kept for later sessions.
      const agentSaved = savedLimits(await $.store.get(AGENT_STORE_KEY)) ?? DEFAULT_LIMITS
      await update($, agentLimitsAtom, () => agentSaved)
    }
    if (!(await read($, sessionNameAtom))?.prompt) {
      const name = await sessionNameOf($)
      await update($, sessionNameAtom, () => name)
    }
    await notePlan($, (await $.session.usage()).rateLimits)
    // A pane already open (as after /reload-plugins) may have been drawn by this module before the
    // values above were back, with no prompt, agents or history: draw it again now that they are,
    // rather than leaving it to the next click.
    $.ui.invalidate('ui.render')

    return started
  })

  on('command.run', { command: 'fence' }, async ($, e) => {
    const [limits, plan] = await Promise.all([read($, limitsAtom), read($, planAtom)])
    const hasSession = plan?.hasSession ?? true
    if (e.args.trim() === '') {
      void $.ui.open({ id: PANE, title: TITLE })

      const agentLimits = await read($, agentLimitsAtom)
      const agents = limits.isOn ? ` ${describeAgents(agentLimits, hasSession)}` : ''
      return { text: `${describe(limits, hasSession)}${agents} Adjust the limits in the Budget fence pane.` }
    }
    if (isAgentArgs(e.args)) {
      const agentLimits = await read($, agentLimitsAtom)
      const parsedAgents = parseAgentArgs(e.args, agentLimits, hasSession)
      if ('error' in parsedAgents) return { text: parsedAgents.error }
      for (const key of ['minutes', 'tokens', 'share', 'weeklyShare'] as const) {
        if (parsedAgents.limits[key] !== agentLimits[key]) await saveLimit($, key, parsedAgents.limits[key], 'background')
      }
      return { text: parsedAgents.said }
    }
    const parsed = parseArgs(e.args, limits, hasSession)
    if ('error' in parsed) return { text: parsed.error }
    await update($, limitsAtom, () => parsed.limits)
    await $.store.set(STORE_KEY, parsed.limits)
    await changeRun($, run => {
      if (!run || run.status === 'done') return run
      const changed = (Object.keys(parsed.limits) as (keyof FenceLimits)[]).filter(k => parsed.limits[k] !== limits[k])
      return changed.reduce(withLimitChanged, run)
    })

    return { text: parsed.said }
  })

  // The prompt as the person sent it: a slash command keeps its name, so the history can tell them apart.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    if (!e.isMeta) lastPrompt = e.command ? `/${e.command.name}${e.command.args ? ` ${e.command.args}` : ''}` : (submitted.text ?? e.text)
    // A session with no name yet takes its first real prompt's.
    if (!e.isMeta && !e.command && lastPrompt.trim() && !(await read($, sessionNameAtom))?.prompt) {
      await update($, sessionNameAtom, name => ({ folder: name?.folder ?? '', prompt: promptLine(lastPrompt) }))
    }
    return submitted
  }).catch(($, e, next) => next(e))

  // A prompt starts a run; background agents still going fold into it.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    const now = await $.clock.now()
    const usage = await $.session.usage()
    // A background agent's name, from its card or, once cleared, from its row in the history.
    const labels = Object.fromEntries([
      ...(await read($, historyAtom)).filter(h => h.isAgent).map(h => [h.id, h.prompt]),
      ...(await read($, agentsAtom)).map(a => [a.run.id, a.run.prompt]),
    ])
    const fresh = newRun(e.turnId, now, usage.rateLimits, readableTitle(e.text.trim() || lastPrompt, labels), ratesOf(await calibration($)))
    await notePlan($, usage.rateLimits)
    for (const [id, p] of pending) if (p.scope === MAIN) pending.delete(id)
    // Background agents keep their own runs; the prompt's is fresh. Agents that finished before
    // this prompt leave the pane: the history keeps them.
    await changeRun($, () => fresh)
    await changeAgents($, list => (list.some(a => a.run.status === 'done') ? list.filter(a => a.run.status !== 'done') : list))

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const loopId = e.agentId ?? MAIN
    // A new step in a loop whose call is still waiting means the person said no.
    const stale = [...pending].find(([, p]) => p.loopId === loopId)
    if (stale) {
      pending.delete(stale[0])
      const now = await $.clock.now()
      await changeFence($, stale[1].scope, run => (run.status === 'paused' ? withDenied(run, now) : run))
    }
    const stepped = yield* next(e)
    // Readings arrive with each response; a plan with no cost ledger raises
    // session.measure only when a window moves a whole point, so read them here.
    const { rateLimits } = await $.session.usage()
    await notePlan($, rateLimits)
    const model = stepped.usage?.model ?? e.model
    // The step counts toward the run that owns its loop; every other run still going notes it as
    // other work, so the windows' movement is split between them.
    const units = stepped.usage ? unitsOf(model, stepped.usage) : 0
    const owner = ownerOf(await read($, agentsAtom), loopId)
    const stepOf = (run: FenceRun, id: string) =>
      run.status === 'done' ? run : withReading(id === owner ? withStep(run, loopId, model, stepped.usage) : withOther(run, units), rateLimits)
    await changeRun($, run => (run ? stepOf(run, MAIN) : run))
    await changeAgents($, list =>
      list.some(a => a.run.status !== 'done') ? list.map(a => (a.run.status === 'done' ? a : { ...a, run: stepOf(a.run, a.run.id) })) : list,
    )

    return stepped
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.rateLimits.length > 0) {
      // A finished prompt keeps its last reading, and an unchanged one is not written:
      // every write redraws the pane, which puts an open dropdown's highlight back.
      const run = await read($, runAtom)
      const moved = (r: FenceRun) => {
        const remeasured = withReading(r, e.rateLimits)
        return JSON.stringify([remeasured.five, remeasured.week]) !== JSON.stringify([r.five, r.week])
      }
      if (run && run.status !== 'done' && moved(run)) {
        await changeRun($, r => (r && r.status !== 'done' ? withReading(r, e.rateLimits) : r))
      }
      await changeAgents($, list =>
        list.some(a => a.run.status !== 'done' && moved(a.run))
          ? list.map(a => (a.run.status === 'done' ? a : { ...a, run: withReading(a.run, e.rateLimits) }))
          : list,
      )
      await notePlan($, e.rateLimits)
    }

    return measured
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.deny === undefined ? spawned.agentId : undefined
    if (agentId !== undefined) {
      const label = e.description || e.subagentType || 'Subagent'
      if (e.background) {
        // A background agent is fenced on its own, from its spawn, with this session's background limits.
        const [now, usage, cal, defaults] = await Promise.all([$.clock.now(), $.session.usage(), calibration($), read($, agentLimitsAtom)])
        const run = newAgentRun(agentId, label, e.tool_use_id || null, now, usage.rateLimits, ratesOf(cal))
        await changeAgents($, list => prunedAgents([{ run, limits: defaults, isCustom: false }, ...list.filter(a => a.run.id !== agentId)]))
      } else {
        // A helper counts toward whoever started it: a background agent, or the prompt.
        const parent = e.parentAgentId ? ownerOf(await read($, agentsAtom), e.parentAgentId) : MAIN
        await changeFence($, parent, run =>
          withLoop(run, { id: agentId, label, toolUseId: e.tool_use_id || null, units: 0, steps: 0, isRunning: true, isBackground: false }),
        )
      }
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    const loopId = e.agentId ?? MAIN
    const now = await $.clock.now()
    const scope = ownerOf(await read($, agentsAtom), loopId)
    let finished: FenceRun | null = null
    await changeFence($, scope, run => {
      if (run.status === 'done') return run
      const after = withLoopDone(run, loopId, now)
      finished = after.status === 'done' ? after : null
      return after
    })
    if (finished) {
      const done: FenceRun = finished
      await $.store.set(CALIBRATION_KEY, withCalibrated(await calibration($), done))
      const entry = historyEntryOf(done, scope !== MAIN || e.agentId === undefined ? completed.text : '')
      const history = await changeHistory($, list => withHistory(list, entry))
      await $.store.set(HISTORY_KEY, history)
      const { limits } = await fenceOf($, scope)
      const receipt = receiptOf(done, limits)
      if (receipt) $.ui.toast(scope === MAIN ? receipt : `Background agent “${done.prompt}”: ${receipt}`)
      if (scope !== MAIN) await changeAgents($, prunedAgents)
    }

    return completed
  })

  // The pause: the next tool call waits on the app's own approval prompt.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny' || e.tool_use_id === undefined) return verdict
    // The call counts against the run that owns its loop: a background agent's own, or the prompt's.
    const scope = ownerOf(await read($, agentsAtom), e.agentId ?? MAIN)
    const { run, limits } = await fenceOf($, scope)
    if (!run) return verdict
    // Once the person has stopped a run, it is not asked about again: its report back goes
    // through (else the person is asked a second time just to let it report, and a stop there
    // loses the report), and any further work is refused with the same word.
    if (run.status === 'denied') {
      if (REPORT_TOOLS.has(e.tool)) return verdict
      return { decision: 'deny', reason: 'Budget fence: the person stopped this here. Wrap up and report what you have so far.' }
    }
    const now = await $.clock.now()
    const trip = tripOf(run, limits, now)
    if (!trip) return verdict
    // A background agent's call has no approver of its own, but its question can still be put
    // to the person, in the prompt box, wherever the session is drawn.
    const canAsk = e.approver === 'person' || (scope !== MAIN && e.approver === undefined && (await $.session.surfaces()).length > 0)
    if (e.approver === undefined && !canAsk) {
      // Nobody to ask: it stops and reports back.
      return {
        decision: 'deny',
        reason: `Budget fence: ${trip.reason}. Stop here and report what you have so far.`,
      }
    }
    const toolUseId = e.tool_use_id
    if (canAsk) {
      // The question sits where the prompt box is; the call waits on it.
      await changeFence($, scope, r => (r.status !== 'paused' ? withPaused(r, trip, toolUseId, now) : r))
      let question = asking.get(scope)
      if (!question) {
        question = askToContinue($, trip, scope).finally(() => asking.delete(scope))
        asking.set(scope, question)
      }
      const answer = await question
      const after = await $.clock.now()
      await changeFence($, scope, r => (r.status === 'paused' ? (answer.go ? withResumed(r, after) : withDenied(r, after)) : r))
      if (answer.go) return verdict
      return {
        decision: 'deny',
        reason: answer.said
          ? `Budget fence: ${trip.reason}, and the person stopped it, saying: ${answer.said}`
          : `Budget fence: ${trip.reason}, and the person chose to stop here. Wrap up and report what you have so far.`,
      }
    }
    // A host answers asks with no question to show: it gets the plain approval, and Allow gives half again.
    pending.set(toolUseId, { trip, loopId: e.agentId ?? MAIN, scope })
    await changeFence($, scope, r => withPaused(r, trip, toolUseId, now))

    return { decision: 'ask', reason: `Budget fence: ${trip.reason}. ${raiseNote(limits, trip)}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const paused = pending.get(e.tool_use_id)
    if (paused) {
      pending.delete(e.tool_use_id)
      const [{ limits }, now] = await Promise.all([fenceOf($, paused.scope), $.clock.now()])
      await changeFence($, paused.scope, run => (ran.deny !== undefined ? withDenied(run, now) : withAllowed(run, limits, paused.trip, now)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The band: the limit closest to its cap gets a bar; the rest sit beside it as icon and percent.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [mainRun, sessionLimits, agents, now] = await Promise.all([read($, runAtom), read($, limitsAtom), read($, agentsAtom), $.clock.now()])
    if (!sessionLimits.isOn) return next(e)
    // Every run going with a limit in force: halted ones first, then the prompt, then the agents
    // nearest their limits.
    const runs = bandRuns(mainRun, sessionLimits, agents, now, leadGauges)
    if (runs.length === 0) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // Box sizes and gaps are in cells on every surface; a graphical surface draws thin shapes as Svg, in CSS pixels.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? (table as Elements['desktop']).Svg : undefined
    const icon = iconFor($, e)
    const isTerminal = e.surface === 'terminal'

    // One spacing scale for every state: an icon and the lead's bar sit tight to what they
    // label, and groups sit apart either side of a hairline (whose image is margin enough).
    const tight: Space = isTerminal ? 1 : 'xs'
    const group: Space = isTerminal ? 2 : 'sm'

    // The closest limit leads with a bar, so which one is nearest is plain at a glance, in its
    // own color, amber from 80% and red at the limit (and red while halted). The terminal draws
    // the bar in characters.
    const bar = (key: string, gauge: Gauge, ratio: number, haltedLevel: Level) => {
      const r = Math.min(1, Math.max(0, ratio))
      const level = haltedLevel ?? levelOf(ratio, 1)
      const hex = level === 'error' ? ERROR_HEX : level === 'warning' ? WARNING_HEX : ICON_COLORS[BAND_ICONS[gauge]]
      if (!Svg) {
        const filled = r > 0 ? Math.max(1, Math.round(r * BAR_CELLS)) : 0
        return (
          <Box key={key} flexDirection="row">
            <Text color={level ?? GLYPH_COLORS[BAND_ICONS[gauge]]}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(BAR_CELLS - filled)}</Text>
          </Box>
        )
      }
      // At least a short sliver once anything is used, so the bar never reads as empty.
      const w = r > 0 ? Math.max(BAR_HEIGHT, Math.round(r * BAR_PX)) : 0
      return (
        <Svg
          key={key}
          alt={`${Math.round(r * 100)}% of the limit`}
          width={BAR_PX}
          height={BAR_HEIGHT}
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_PX} ${BAR_HEIGHT}"><rect width="${BAR_PX}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" fill="${BAR_TRACK}"/>${w > 0 ? `<rect width="${w}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" fill="${hex}"/>` : ''}</svg>`}
        />
      )
    }

    // Every state reads the same way, "used / limit", with the used part in the row's color.
    const figure = (key: string, lead: BandGauge, level: Level) => (
      <Text key={key} size="footnote" tabular>
        <Text color={level}>{lead.g.share ? shareText(lead.g.share) : shortAmount(lead.gauge, lead.g.used)}</Text>
        <Text dimColor>{` / ${shortAmount(lead.gauge, lead.g.cap)}`}</Text>
      </Text>
    )

    const pair = (key: string, children: RenderChildren, gap: Space = tight) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={gap}>
        {children}
      </Box>
    )
    // Between groups, a hairline, as status bars divide their items. On a graphical surface
    // it is an image the size of the icons with the line drawn in its middle, so the row
    // centers it exactly as it centers the icons (text sits on the font's baseline, a little
    // low, and a 1px-wide image did not show). The terminal draws a box-drawing line.
    const divider = (key: string) =>
      Svg ? (
        <Svg key={key} alt="Divider" width={16} height={16} source={DIVIDER_SVG} />
      ) : (
        <Text key={key} dimColor>
          │
        </Text>
      )
    const nameOf = (label: string, max: number) => (label.length > max ? `${label.slice(0, max - 1)}…` : label)
    const columns = e.props.bodyColumns ?? 80
    const details = <Button key="details" plain dimColor label="⋯" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />

    // One row per run: its name when an agent's, a status when halted, its lead limit with a bar,
    // and each other limit as its icon and a percent while there is room.
    const rowOf = (x: BandRun, isFirst: boolean) => {
      const { run, label, lead, rest } = x
      const isPaused = run.status === 'paused'
      const isHalted = isPaused || run.status === 'denied'
      // Halted, paused or stopped, the whole row turns red, as the pane does.
      const leadLevel: Level = isHalted ? 'error' : levelOf(lead.g.used, lead.g.cap)
      // Halted, a status leads the row: its own icon, like every limit, and its word.
      const status = isHalted
        ? pair('status', [
            icon(isPaused ? 'pause' : 'stop', isPaused ? 'Paused' : 'Stopped'),
            <Text key="word" size="footnote" weight="medium" color={leadLevel}>
              {isPaused ? 'Paused' : 'Stopped'}
            </Text>,
          ])
        : null
      // A background agent's row is named, and with several rows the prompt's is too, by its icon,
      // so no row is read as another's.
      const who = label
        ? pair('who', [
            icon('agent', 'Background agent'),
            <Text key="name" size="footnote" color="subtle" wrap="truncate-end">
              {nameOf(label, 24)}
            </Text>,
          ])
        : runs.length > 1
          ? pair('who', [icon('prompt', 'Prompt')])
          : null
      // What fits: the lead always; the others while there is room.
      const room = Math.max(0, Math.floor((columns - 30 - (label ? 26 : runs.length > 1 ? 4 : 0)) / 10))
      const others = isHalted ? [] : rest.slice(0, room)
      // Each group is tight inside (its icon, the lead's bar, its figure) and set apart from the
      // next by a divider with a wide gap either side, so which figure belongs to which icon is plain.
      const groups = [
        who,
        status,
        pair('lead', [
          icon(BAND_ICONS[lead.gauge], GAUGE_NAMES[lead.gauge]),
          bar('bar', lead.gauge, lead.ratio, isHalted ? leadLevel : undefined),
          figure('fig', lead, leadLevel),
        ]),
        ...others.map(o =>
          pair(o.gauge, [
            icon(BAND_ICONS[o.gauge], GAUGE_NAMES[o.gauge]),
            <Text key="pct" size="footnote" tabular color={levelOf(o.g.used, o.g.cap) ?? 'subtle'}>
              {`${Math.min(999, Math.round(o.ratio * 100))}%`}
            </Text>,
          ]),
        ),
      ].filter(g => g !== null)
      return (
        <Box key={`run-${run.id}`} flexDirection="row" alignItems="center" columnGap={group}>
          {groups.flatMap((g, n) => (n === 0 ? [g] : [divider(`divider-${n}`), g]))}
          <Box key="spacer" flexGrow={1} />
          {isFirst ? details : null}
        </Box>
      )
    }

    if (runs.length === 1) return rowOf(runs[0]!, true)

    // Several going: a row each, halted ones first, then the prompt, then the agents nearest
    // their limits, up to a few rows so the band never crowds the prompt; the rest are counted.
    const limit = Math.max(1, Math.min(BAND_ROWS, (e.props.maxRows ?? BAND_ROWS + 1) - 1))
    const shown = runs.length > limit ? runs.slice(0, limit - 1) : runs
    const hidden = runs.length - shown.length
    return (
      <Box flexDirection="column" rowGap={isTerminal ? 0 : 'xs'}>
        {shown.map((x, n) => rowOf(x, n === 0))}
        {hidden > 0 ? (
          <Box key="more" flexDirection="row" alignItems="center" columnGap={tight}>
            {icon('agent', 'Background agents')}
            <Text size="footnote" color="subtle">
              {`${hidden} more running · ⋯ shows all`}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const previous = desktop.limit
    const wasChoosing = desktop.isChoosing
    const revision = ++desktop.focusRevision
    const limit = e.element?.startsWith('limit-') ? e.element : null
    // The dropdown just picked in, reported focused again, is not a menu opening.
    const isRepeat = limit !== null && limit === desktop.picked
    if (!isRepeat) desktop.picked = null
    // Capture the move before calling next: it can ask for another drawing.
    desktop.limit = limit
    desktop.isChoosing = limit !== null && !isRepeat
    if (limit === null ? previous !== null || e.element !== undefined : !wasChoosing) desktop.wake?.()
    const moved = await next(e)
    if (moved.deny !== undefined && desktop.focusRevision === revision) {
      desktop.limit = previous
      desktop.isChoosing = wasChoosing && !isRepeat
      if (!wasChoosing) desktop.wake?.()
    }
    return moved
  }).catch(($, e, next) => next(e))

  // A block of the prompt section asking for its latest view. New props go out only when
  // what it shows has changed, since the desktop can repaint the controls on a Client update;
  // they go out whatever has the focus, so the numbers never stop moving.
  on('ui.message', async ($, e, next) => {
    const block = blockOf(e.element)
    if (e.requestId !== PANE || block === null) return next(e)
    if (block.part === 'line') {
      const [agents, sessionLimits, at] = await Promise.all([read($, agentsAtom), read($, limitsAtom), $.clock.now()])
      const agent = agents.find(a => a.run.id === block.figure)
      if (!agent) return {}
      const view = agentView(agent, sessionLimits, at)
      return e.data === promptContent(view) ? {} : { props: view }
    }
    const [run, limits, now] = await Promise.all([read($, runAtom), read($, limitsAtom), $.clock.now()])
    if (!run) return {}
    // The rings around the figures' icons are the pane's own drawing, in 10% steps: the head's
    // tick, once a second, redraws the pane when one has stepped, and at no other time.
    if (block.part === 'head') {
      const rings = ringsKey(run, limits, now)
      if (rings !== pane.rings) {
        pane.rings = rings
        $.ui.invalidate('ui.render')
      }
    }
    const view = promptView(run, limits, now, block.part, block.figure as Figure | '')
    return e.data === promptContent(view) ? {} : { props: view }
  }).catch(($, e, next) => next(e))

  // The pane: what this prompt is spending, the settings, recent prompts.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPaneInTurn($, e, async () => {
    const table = $.ui.resolve(e)
    const { Box, Button, Input, Select, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? (table as Elements['desktop']).Svg : undefined
    if (!Client) pane.hasPlainSurface = true
    const { run, history, agents } = pane
    const [limits, plan, editing, isRecentOpen, isAgentsOpen, agentLimits, agentOpen, sessionName] = await Promise.all([
      read($, limitsAtom),
      read($, planAtom),
      read($, editingAtom),
      read($, recentOpenAtom),
      read($, agentsOpenAtom),
      read($, agentLimitsAtom),
      read($, agentOpenAtom),
      read($, sessionNameAtom),
    ])
    const now = await $.clock.now()
    const icon = iconFor($, e)
    // What this drawing's rings show, so the head's tick redraws only when one steps.
    if (run) pane.rings = ringsKey(run, limits, now)

    const setLimit = (key: keyof FenceLimits, value: FenceLimits[keyof FenceLimits], target: Target = 'session') =>
      saveLimit($, key, value, target)

    const heading = (text: string, trailing?: RenderChildren) => (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="md">
        <Text size="footnote" weight="medium" color="subtle">
          {text.toUpperCase()}
        </Text>
        {trailing ?? null}
      </Box>
    )

    // Custom… opens a field under the row for values the presets don't cover.
    const row = (target: Target, from: FenceLimits, key: Gauge, glyph: IconName, name: string, choices: readonly number[]) => {
      const value = from[key]
      const ck = controlKey(target, key)
      const isEditing = editing?.key === ck
      const submit = (text: string) =>
        void (async () => {
          const parsed = parseLimitInput(key, text)
          if (parsed === null) {
            await update($, editingAtom, () => ({ key: ck, error: `Didn't understand "${text.trim()}". ${EXAMPLES[key]}` }))
            return
          }
          await update($, editingAtom, () => null)
          await setLimit(key, parsed, target)
        })()
      return (
        <Box key={ck} flexDirection="column" rowGap="xs">
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            {icon(glyph, name)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" color={limits.isOn ? undefined : 'subtle'}>
                {name}
              </Text>
            </Box>
            <Select
              key={`limit-${ck}`}
              options={optionsFor(key, choices, value)}
              value={isEditing ? CUSTOM : String(value)}
              onSelect={(v, event) => void pickLimit($, target, key, v, event.surface === 'desktop')}
            />
          </Box>
          {isEditing ? (
            <Box flexDirection="column" rowGap="xs">
              <Box flexDirection="row" alignItems="center" columnGap="sm">
                <Box flexGrow={1} flexShrink={1}>
                  <Input
                    key={`custom-${ck}`}
                    placeholder={PLACEHOLDERS[key]}
                    value={value > 0 && !choices.includes(value) ? String(value) : ''}
                    submitLabel="set"
                    autoFocus
                    onSubmit={submit}
                  />
                </Box>
                <Button
                  key={`cancel-${ck}`}
                  plain
                  dimColor
                  label="Cancel"
                  onPress={pressed(() => update($, editingAtom, () => null))}
                />
              </Box>
              <Text size="footnote" color={editing?.error ? 'warning' : 'subtle'}>
                {editing?.error ?? EXAMPLES[key]}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    // Ultra plans have no 5-hour session window; offer only the windows the plan has.
    const hasSession = plan?.hasSession ?? true
    const hasWeekly = plan?.hasWeekly ?? true

    // What this prompt is spending. The heading and each figure's number are blocks
    // that refresh themselves where the surface has them, so they move without the pane, its
    // dropdowns and buttons, being drawn. For each figure the pane draws its icon and name,
    // and its block sits under them.
    const block = (part: PromptPart, figure: Figure | '' = '') => {
      const view = promptView(run!, limits, now, part, figure)
      return Client ? (
        <Client
          key={`${LIVE_PREFIX}${part === 'figure' ? figure : part}`}
          module="./live.ts"
          props={view}
          width={part === 'figure' ? undefined : '100%'}
        />
      ) : (
        drawPrompt({ Box, Text }, view)
      )
    }
    // The prompt itself, as its row in the history reads: the prompt icon, then its words in full
    // strength, so it is plain this is what was asked and not a caption.
    const promptRow = run?.prompt ? (
      <Box key="prompt" flexDirection="row" alignItems="center" columnGap="sm">
        <Box flexDirection="row" alignItems="center" height={1} flexShrink={0}>
          {icon('prompt', 'Prompt')}
        </Box>
        <Box flexGrow={1} flexShrink={1} width={0} minWidth={0}>
          <Text wrap="truncate-end">{readableTitle(run.prompt)}</Text>
        </Box>
      </Box>
    ) : null
    const hasNotes = run !== null && (run.status === 'paused' || run.loops.length > 1)
    const promptSection = !run ? null : (
      <Box flexDirection="column" rowGap="sm">
        {block('head')}
        {promptRow}
        {hasNotes ? block('notes') : null}
        <Box key="figures" flexDirection="row" flexWrap="wrap" columnGap="lg" rowGap="sm">
          {figuresOf(run).map(f => (
            <Box key={f} flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} minWidth={10}>
              <Box flexDirection="row" alignItems="center" columnGap="xs">
                {icon(FIGURE_ICONS[f], f)}
                <Text size="footnote" color="subtle" wrap="truncate-end">
                  {f}
                </Text>
              </Box>
              {/* The number, then a ring of how full its limit is; no ring with no limit. */}
              <Box key="value" flexDirection="row" alignItems="center" columnGap="xs">
                {block('figure', f)}
                {Svg && ringOf(run, limits, now, f).step !== null ? (
                  <Svg key={`ring-${f}`} alt={ringAlt(f, ringOf(run, limits, now, f))} width={RING_PX} height={RING_PX} source={ringSvg(ringOf(run, limits, now, f))} />
                ) : null}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )

    // The four settings of one target, each a dropdown, offering only the windows the plan has.
    const rows = (target: Target, from: FenceLimits) => [
      row(target, from, 'minutes', 'clock', 'Working time', MINUTES),
      row(target, from, 'tokens', 'tokens', 'Tokens', TOKENS),
      hasSession ? row(target, from, 'share', 'session', 'Share of session limit', SESSION) : null,
      hasWeekly ? row(target, from, 'weeklyShare', 'weekly', 'Share of weekly limit', WEEKLY) : null,
    ]

    // The button that opens a card's limits, or closes them again.
    const editButton = (id: string, isOpen: boolean) => (
      <Button
        key={`agent-limits-${id}`}
        plain
        dimColor
        label={isOpen ? 'Done' : 'Edit limits'}
        onPress={pressed(() => update($, agentOpenAtom, open => (open === id ? null : id)))}
      />
    )

    // A row laid out as a history row is: its icon in a column of its own on the title's line,
    // and beside it the title (with anything trailing) over the rest, so each reads as one block.
    const iconRow = (key: string, glyph: IconName, alt: string, title: RenderChildren, trailing: RenderChildren, body: RenderChildren) => (
      <Box key={key} flexDirection="row" alignItems="flex-start" columnGap="sm">
        <Box flexDirection="row" alignItems="center" height={1} flexShrink={0}>
          {icon(glyph, alt)}
        </Box>
        <Box flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} width={0} minWidth={0}>
          <Box flexDirection="row" alignItems="center" columnGap="md">
            <Box flexGrow={1} flexShrink={1} width={0} minWidth={0}>
              {title}
            </Box>
            {trailing}
          </Box>
          {body}
        </Box>
      </Box>
    )

    // Each background agent: its name, a live line of its figures against its own limits, whether
    // those are its own or the new-agent ones, and the dropdowns when opened. Running ones only
    // until the next prompt clears the finished.
    const agentRow = (agent: FenceAgent) => {
      const id = agent.run.id
      const isRunning = agent.run.status !== 'done'
      const isOpen = isRunning && agentOpen === id
      const view = agentView(agent, limits, now)
      return iconRow(
        `agent-${id}`,
        'agent',
        'Background agent',
        <Text wrap="truncate-end" color={isRunning ? undefined : 'subtle'}>
          {agent.run.prompt || 'Background agent'}
        </Text>,
        isRunning ? editButton(id, isOpen) : null,
        [
          Client ? (
            <Client key={`${LIVE_PREFIX}a-${id}`} module="./live.ts" props={view} width="100%" />
          ) : (
            drawPrompt({ Box, Text }, view)
          ),
          isOpen ? (
            <Box key="limits" flexDirection="column" rowGap="sm">
              {rows(agentTarget(id), agent.limits)}
            </Box>
          ) : null,
        ],
      )
    }

    // The limits new agents start with: settings, not an agent, so they read as settings do,
    // in gray under a settings icon with no status or figures, set a step apart from the agents.
    const isNewOpen = agentOpen === NEW_AGENTS
    const newAgentsTile = (
      <Box key="agent-new" flexDirection="column" marginTop={agents.length > 0 ? 'sm' : undefined}>
        {iconRow(
          'agent-new-row',
          'sliders',
          'Settings',
          <Text color="subtle" wrap="truncate-end">
            Default limits for new agents
          </Text>,
          editButton(NEW_AGENTS, isNewOpen),
          isNewOpen ? (
            <Box key="limits" flexDirection="column" rowGap="sm">
              {rows('background', agentLimits)}
            </Box>
          ) : (
            <Text key="summary" size="footnote" color="subtle" wrap="truncate-end">
              {limitsSummary(agentLimits, hasSession, hasWeekly)}
            </Text>
          ),
        )}
      </Box>
    )

    const running = agents.filter(a => a.run.status !== 'done').length
    // Collapsed by default, as Recent prompts is; it opens by itself while an agent waits on a limit.
    const isAgentWaiting = agents.some(a => a.run.status === 'paused')
    const isAgentsShown = isAgentsOpen || isAgentWaiting
    const agentsSection = (
      <Box flexDirection="column" rowGap="md">
        {heading(
          'Background agents',
          <Box flexDirection="row" alignItems="center" columnGap="md">
            {running > 0 ? (
              <Text key="running" size="footnote" color={isAgentWaiting ? 'error' : 'subtle'}>
                {isAgentWaiting ? 'waiting for you' : `${running} running`}
              </Text>
            ) : null}
            {isAgentWaiting ? null : (
              <Button
                key="agents-toggle"
                plain
                dimColor
                label={isAgentsOpen ? 'Hide' : 'Show'}
                onPress={pressed(() => update($, agentsOpenAtom, open => !open))}
              />
            )}
          </Box>,
        )}
        {isAgentsShown ? (
          <Box key="agents-body" flexDirection="column" rowGap="md">
            <Text size="footnote" color="subtle">
              Each background agent pauses at its own limits.
            </Text>
            {agents.map(agentRow)}
            {newAgentsTile}
          </Box>
        ) : null}
      </Box>
    )

    const recent = history.slice(0, 3)
    const name = nameText(sessionName)

    return (
      <Box flexDirection="column" rowGap="lg">
        <Box flexDirection="row" alignItems="center" columnGap="sm">
          {icon(limits.isOn ? 'shield' : 'shieldOff', limits.isOn ? 'On' : 'Off')}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text weight="medium" color={limits.isOn ? 'success' : 'subtle'}>
              {limits.isOn ? 'Fence is on' : 'Fence is off'}
            </Text>
            <Text size="footnote" color="subtle" wrap="truncate-end">
              {`This session${name ? ` · ${name}` : ''}`}
            </Text>
          </Box>
          <Button
            key="toggle"
            variant={limits.isOn ? 'secondary' : 'primary'}
            label={limits.isOn ? 'Turn off' : 'Turn on'}
            onPress={pressed(() => setLimit('isOn', !limits.isOn))}
          />
        </Box>

        {promptSection}

        <Box flexDirection="column" rowGap="sm">
          {heading('Pause each prompt after')}
          <Text size="footnote" color="subtle">
            Every prompt in this session gets these limits.
          </Text>
          {rows('session', limits)}
        </Box>

        {agentsSection}

        {recent.length > 0 ? (
          <Box flexDirection="column" rowGap="sm">
            {heading(
              'Recent prompts',
              <Box flexDirection="row" alignItems="center" columnGap="md">
                <Button
                  key="recent-toggle"
                  plain
                  dimColor
                  label={isRecentOpen ? 'Hide' : 'Show'}
                  onPress={pressed(() => update($, recentOpenAtom, open => !open))}
                />
                <Button
                  key="history"
                  plain
                  dimColor
                  label="View all"
                  onPress={pressed(() => $.ui.open({ id: HISTORY_PANE, title: 'Prompt history' }))}
                />
              </Box>,
            )}
            {isRecentOpen ? (
              // Entries sit further apart than a title sits from its figures, so each reads as one.
              <Box key="recent-list" flexDirection="column" rowGap="md">
                {recent.map(entry => historyRow(Box, Text, icon, entry, now))}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }))

  // The history: every recent prompt, newest first, with what it spent.
  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [history, now] = await Promise.all([read($, historyAtom), $.clock.now()])
    const icon = iconFor($, e)
    if (history.length === 0) {
      return <Text color="subtle">Finished prompts show here, with the time, tokens and limits each used.</Text>
    }
    const totals = history.reduce(
      (t, x) => ({ ms: t.ms + x.activeMs, tokens: t.tokens + x.tokens, weekly: t.weekly + (x.weeklyPct ?? 0) }),
      { ms: 0, tokens: 0, weekly: 0 },
    )

    return (
      <Box flexDirection="column" rowGap="lg">
        <Box flexDirection="row" alignItems="flex-end" columnGap="lg">
          {[
            ['Prompts', String(history.length)],
            ['Time', duration(totals.ms)],
            ['Tokens', tokens(totals.tokens)],
            ...(totals.weekly > 0 ? [['Weekly', `~${pct(totals.weekly)}`]] : []),
          ].map(([name, value]) => (
            <Box key={name} flexDirection="column">
              <Text size="footnote" color="subtle">
                {name}
              </Text>
              <Text weight="medium" tabular>
                {value}
              </Text>
            </Box>
          ))}
          <Box key="spacer" flexGrow={1} />
          <Button
            key="clear-history"
            plain
            dimColor
            label="Clear"
            onPress={() =>
              void (async () => {
                await changeHistory($, () => [])
                await $.store.set(HISTORY_KEY, [])
              })()
            }
          />
        </Box>
        <Box flexDirection="column" rowGap="lg">
          {history.map(entry => historyRow(Box, Text, icon, entry, now))}
        </Box>
      </Box>
    )
  })
}

/** The `Client` keys of the prompt section's two blocks, and back. */
const LIVE_PREFIX = 'live-'

/** The background section's last card, the limits new agents start with: never an agent's id. */
const NEW_AGENTS = 'new-agents'

/** A target's limits on one line, as its card says them when closed. */
function limitsSummary(limits: FenceLimits, hasSession: boolean, hasWeekly: boolean): string {
  const parts = [
    limits.minutes > 0 ? limitLabel('minutes', limits.minutes) : null,
    limits.tokens > 0 ? `${limitLabel('tokens', limits.tokens)} tokens` : null,
    hasSession && limits.share > 0 ? `${limitLabel('share', limits.share)} session` : null,
    hasWeekly && limits.weeklyShare > 0 ? `${limitLabel('weeklyShare', limits.weeklyShare)} weekly` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'No limits'
}

/** Which block a `Client` key names: the head, one figure, or a background agent's line (`a-<id>`). */
function blockOf(key: string): { part: PromptPart; figure: string } | null {
  if (!key.startsWith(LIVE_PREFIX)) return null
  const name = key.slice(LIVE_PREFIX.length)
  if (name === 'head') return { part: 'head', figure: '' }
  if (name === 'notes') return { part: 'notes', figure: '' }
  if (name.startsWith('a-')) return { part: 'line', figure: name.slice(2) }
  return name in FIGURE_ICONS ? { part: 'figure', figure: name } : null
}

/** One limit as the band reads it: which, where it stands, and how full. */
type BandGauge = { gauge: Gauge; g: NonNullable<ReturnType<typeof gaugeOf>>; ratio: number }

/** One run the band shows: the prompt's (no label) or an agent's, its lead limit and the others. */
type BandRun = { run: FenceRun; label: string | null; lead: BandGauge; rest: BandGauge[] }

/** How much closer another limit must be before it takes a run's lead, so its bar does not flicker. */
function leadOf(gauges: BandGauge[], held: Gauge | undefined): BandGauge {
  const top = gauges.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  const kept = gauges.find(x => x.gauge === held)
  return kept && top.ratio - kept.ratio < LEAD_MARGIN ? kept : top
}

/**
 * What the band shows, in order: halted runs first (paused, then stopped), then the prompt while
 * it runs, then background agents nearest their limits. Only runs with a limit in force count.
 * `leads` keeps each run's lead limit between drawings.
 */
function bandRuns(
  mainRun: FenceRun | null,
  session: FenceLimits,
  agents: readonly FenceAgent[],
  now: number,
  leads: Map<string, Gauge>,
): BandRun[] {
  const candidates = [
    ...(mainRun && mainRun.status !== 'done' ? [{ run: mainRun, limits: session, label: null as string | null }] : []),
    ...agents
      .filter(a => a.run.status !== 'done')
      .map(a => ({ run: a.run, limits: agentLimitsOf(a, session), label: a.run.prompt || 'Background agent' })),
  ]
  const runs = candidates.flatMap(c => {
    const gauges = BAND_GAUGES.flatMap(gauge => {
      const g = gaugeOf(c.run, c.limits, gauge, now)
      return g && g.cap > 0 ? [{ gauge, g, ratio: g.used / g.cap }] : []
    })
    if (gauges.length === 0) return []
    const lead = leadOf(gauges, leads.get(c.run.id))
    leads.set(c.run.id, lead.gauge)
    return [{ run: c.run, label: c.label, lead, rest: gauges.filter(x => x !== lead) }]
  })
  // Forget the leads of runs no longer going.
  for (const id of leads.keys()) if (!candidates.some(c => c.run.id === id)) leads.delete(id)
  const rank = (x: BandRun) => (x.run.status === 'paused' ? 0 : x.run.status === 'denied' ? 1 : x.label === null ? 2 : 3)
  return runs.sort((x, y) => rank(x) - rank(y) || y.lead.ratio - x.lead.ratio)
}

/** The figures a run has, in order: time and tokens always, each usage window the plan has. */
type Figure = 'Time' | 'Tokens' | 'Session' | 'Weekly'
const FIGURE_ICONS: Record<Figure, IconName> = { Time: 'clock', Tokens: 'tokens', Session: 'session', Weekly: 'weekly' }
function figuresOf(run: FenceRun | null): Figure[] {
  if (!run) return []
  return ['Time', 'Tokens', ...(run.five ? (['Session'] as const) : []), ...(run.week ? (['Weekly'] as const) : [])]
}

const FIGURE_GAUGES: Record<Figure, Gauge> = { Time: 'minutes', Tokens: 'tokens', Session: 'share', Weekly: 'weeklyShare' }

/**
 * A figure's ring: how full its limit is in 10% steps, and its color (the figure's own,
 * amber from 80%, red at the limit or while the prompt is halted); no step with no limit.
 */
type Ring = { step: number | null; color: string }
function ringOf(run: FenceRun, limits: FenceLimits, now: number, f: Figure): Ring {
  const color = ICON_COLORS[FIGURE_ICONS[f]]
  const g = limits.isOn && run.status !== 'done' ? gaugeOf(run, limits, FIGURE_GAUGES[f], now) : null
  if (!g || g.cap <= 0) return { step: null, color }
  const isHalted = run.status === 'paused' || run.status === 'denied'
  const level = isHalted ? 'error' : levelOf(g.used, g.cap)
  return {
    step: Math.floor(Math.min(1, g.used / g.cap) * 10) / 10,
    color: level === 'error' ? ERROR_HEX : level === 'warning' ? WARNING_HEX : color,
  }
}

/** Every figure's ring, to compare what the pane drew with what it would draw now. */
function ringsKey(run: FenceRun, limits: FenceLimits, now: number): string {
  return JSON.stringify(figuresOf(run).map(f => ringOf(run, limits, now, f)))
}

function ringAlt(f: Figure, ring: Ring): string {
  return ring.step === null ? f : `${f}, ${Math.round(ring.step * 100)}% of the limit`
}

/** A figure's ring beside its number: an empty ring that fills clockwise from the top. */
const RING_PX = 14
const RING_TRACK = 'rgba(139, 145, 156, 0.35)'
function ringSvg(ring: Ring): string {
  const r = 9
  const length = 2 * Math.PI * r
  const filled = (ring.step ?? 0) * length
  const arc =
    filled > 0
      ? `<circle cx="12" cy="12" r="${r}" stroke="${ring.color}" stroke-width="3.5" stroke-dasharray="${filled.toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 12 12)"/>`
      : ''
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linecap="butt">' +
    `<circle cx="12" cy="12" r="${r}" stroke="${RING_TRACK}" stroke-width="3.5"/>${arc}` +
    '</svg>'
  )
}

/** The pane's prompt section for the run as it stands now: status, figures against their limits, subagents. */
/** A run's figures against the limits it answers to, in the pane's order. */
function statsOf(run: FenceRun, limits: FenceLimits, now: number): PromptStat[] {
  const stat = (name: Figure, gauge: Gauge, used: string, unit: string): PromptStat => {
    const g = limits.isOn ? gaugeOf(run, limits, gauge, now) : null
    const isCapped = g !== null && g.cap > 0 && run.status !== 'done'
    const level = isCapped ? levelOf(g.used, g.cap) : undefined
    return { name, used, limit: isCapped ? shortAmount(gauge, g.cap) : '', color: level ?? null, unit }
  }
  return [
    stat('Time', 'minutes', duration(activeMs(run, now)), ''),
    stat('Tokens', 'tokens', tokens(run.tokens), 'tokens'),
    ...(run.five ? [stat('Session', 'share', shareText(shareOf(run, 'five')), 'session')] : []),
    ...(run.week ? [stat('Weekly', 'weeklyShare', shareText(shareOf(run, 'week')), 'weekly')] : []),
  ]
}

/** A background agent's line: its status and figures against its own limits. */
function agentView(agent: FenceAgent, session: FenceLimits, now: number): PromptView {
  const run = agent.run
  return {
    part: 'line',
    figure: run.id,
    load: LOAD,
    at: now,
    heading: '',
    status: run.isUnfenced && run.status === 'running' ? 'Running, no limits' : statusWord(run, now),
    statusColor: STATUS_COLORS[run.status],
    prompt: '',
    note: run.status === 'paused' ? `${run.reason ?? 'A limit was reached'}. Waiting for your OK.` : '',
    stats: statsOf(run, agentLimitsOf(agent, session), now),
    loops: '',
  }
}

function promptView(run: FenceRun, limits: FenceLimits, now: number, part: PromptPart, figure: Figure | '' = ''): PromptView {
  // The prompt's figures carry no unit: the pane names each under its icon.
  const stats = statsOf(run, limits, now).map(({ unit: _, ...s }) => s)
  const subagents = run.loops.length - 1
  const loops =
    subagents > 0
      ? `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'} · ${[...run.loops]
          .sort((x, y) => y.units - x.units)
          .map(l => `${l.label} ~${pct(loopShare(run, l.id))}`)
          .join(', ')}`
      : ''
  // Each block carries only what it draws, so a block is sent nothing new while only
  // another's numbers move. The prompt's words are the pane's own row, between head and notes.
  const isHead = part === 'head'
  const isNotes = part === 'notes'
  return {
    part,
    figure: isHead ? '' : figure,
    load: LOAD,
    at: now,
    heading: !isHead ? '' : run.status === 'done' ? 'LAST PROMPT' : 'THIS PROMPT',
    status: !isHead ? '' : run.isUnfenced && run.status === 'running' ? 'Running, no limits' : statusWord(run, now),
    statusColor: isHead ? STATUS_COLORS[run.status] : '',
    prompt: '',
    note: isNotes && run.status === 'paused' ? `${run.reason ?? 'A limit was reached'}. Waiting for your OK.` : '',
    stats: isHead || isNotes ? [] : stats.filter(x => x.name === figure),
    loops: isNotes ? loops : '',
  }
}

/** How close a figure is to its limit, as a color: plain, amber from 80%, red at the limit. */
type Level = 'warning' | 'error' | undefined
function levelOf(used: number, cap: number): Level {
  if (cap <= 0) return undefined
  return used >= cap ? 'error' : used / cap >= WARN_AT ? 'warning' : undefined
}

const CUSTOM = 'custom'

const MINUTES = [0, 1, 5, 30, 60, 120, 300]
const TOKENS = [0, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000]
const SESSION = [0, 2, 5, 10, 15, 20, 30]
const WEEKLY = [0, 1, 2, 5, 10, 25, 50]

const PLACEHOLDERS: Record<Gauge, string> = {
  minutes: 'Minutes, e.g. 45 or 1h 30m',
  tokens: 'Tokens, e.g. 750k or 1.5M',
  share: 'Percent, e.g. 7.5',
  weeklyShare: 'Percent, e.g. 3',
}

const EXAMPLES: Record<Gauge, string> = {
  minutes: 'Type minutes (45), hours (1.5h) or both (1h 30m), then Enter.',
  tokens: 'Type a count (750000) or use k and M (750k, 1.5M), then Enter.',
  share: 'Type a percent of the 5-hour session limit (7.5), then Enter.',
  weeklyShare: 'Type a percent of the weekly limit (3), then Enter.',
}

/** The presets, the value in force when it is not one of them, and Custom… last. */
function optionsFor(gauge: Gauge, choices: readonly number[], value: number) {
  const values = choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b)
  return [
    ...values.map(v => ({ value: String(v), label: limitLabel(gauge, v) })),
    { value: CUSTOM, label: 'Custom…' },
  ]
}

function shortAmount(gauge: Gauge, n: number): string {
  switch (gauge) {
    case 'minutes':
      return duration(n * 60_000)
    case 'tokens':
      return tokens(n)
    default:
      return pct(n)
  }
}

/** Running in blue, paused or stopped in red, finished quiet. */
const STATUS_COLORS = { running: 'suggestion', paused: 'error', denied: 'error', done: 'subtle' } as const

function statusWord(run: FenceRun, now: number): string {
  switch (run.status) {
    case 'paused':
      return 'Paused'
    case 'denied':
      return 'Stopped at your fence'
    case 'running':
      return 'Running'
    case 'done':
      return `Finished ${ago(run.endedAt ?? now, now)}`
  }
}

/** How long ago, in one short form for every row: "now", "2m ago", "4h ago", "3d ago". */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** The time column's width, in cells: room for "59m ago" without wrapping. */
const AGO_CELLS = 7

type Table = ReturnType<EngineInterface['ui']['resolve']>

/** A share the history kept: an estimate has decimals, a rounded reading is whole; both get "~". */
function savedShare(value: number, isExact: boolean | undefined): string {
  return shareText({ value, isExact: isExact === true, isEstimate: !Number.isInteger(value) })
}

/**
 * One finished prompt: its title on one line, cut off at the edge, with when it finished in a
 * fixed column on the right; under it, what it spent, each figure with its own colored icon as
 * in the pane (time, tokens, the session limit where the plan has one, the weekly limit), and
 * anything unusual. Nothing wraps.
 */
function historyRow(
  Box: Table['Box'],
  Text: Table['Text'],
  icon: (name: IconName, alt: string) => RenderChildren,
  entry: FenceHistoryEntry,
  now: number,
) {
  const figure = (key: string, glyph: IconName, name: string, value: string) => (
    <Box key={key} flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0}>
      {icon(glyph, name)}
      <Text size="footnote" tabular color="subtle">
        {value}
      </Text>
    </Box>
  )
  // What went differently, in red: a prompt the fence stopped, or one it paused.
  const flag = entry.wasStopped ? 'Stopped' : entry.pauses > 0 ? `Paused ${entry.pauses}×` : null
  // Two columns: what ran it (its icon, on the title's line) and the entry itself, so the
  // figures line up under the title they belong to rather than under the icon.
  return (
    <Box key={entry.id} flexDirection="row" alignItems="flex-start" columnGap="sm">
      <Box flexDirection="row" alignItems="center" height={1} flexShrink={0}>
        {entry.isAgent ? icon('agent', 'Background agent') : icon('prompt', 'Prompt')}
      </Box>
      <Box flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} width={0} minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap="md">
          <Box flexGrow={1} flexShrink={1} width={0} minWidth={0}>
            <Text wrap="truncate-end" color={entry.prompt ? undefined : 'subtle'}>
              {titleOf(entry)}
            </Text>
          </Box>
          <Box flexShrink={0} minWidth={AGO_CELLS} justifyContent="flex-end">
            <Text size="footnote" color="subtle" tabular wrap="truncate-end">
              {ago(entry.startedAt + entry.activeMs, now)}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap="md" overflow="hidden">
          {figure('time', 'clock', 'Time', duration(entry.activeMs))}
          {figure('tokens', 'tokens', 'Tokens', tokens(entry.tokens))}
          {entry.sessionPct !== null ? figure('session', 'session', 'Session', savedShare(entry.sessionPct, entry.sessionIsExact)) : null}
          {entry.weeklyPct !== null ? figure('weekly', 'weekly', 'Weekly', savedShare(entry.weeklyPct, entry.weeklyIsExact)) : null}
          {entry.agents > 0 ? (
            <Text key="agents" size="footnote" color="subtle" wrap="truncate-end">
              {`${entry.agents} ${entry.agents === 1 ? 'subagent' : 'subagents'}`}
            </Text>
          ) : null}
          {flag ? (
            <Text key="flag" size="footnote" color="error" wrap="truncate-end">
              {flag}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}

/**
 * A turn the engine started with a message of its own (a background agent's report, a task's
 * notification) reads as what it is, not as its markup: a report names the agent when the
 * fence knew it.
 */
function readableTitle(text: string, labels: Record<string, string> = {}): string {
  const report = /^<agent-message from="([^"]*)"/.exec(text)
  if (report) {
    const label = labels[report[1]!]
    return label ? `Report from “${label}”` : 'Report from a background agent'
  }
  if (text.startsWith('<task-notification')) return 'Background task finished'
  if (/^<[a-z-]+[\s>]/.test(text)) {
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return plain || 'Message from the app'
  }
  return text
}

/** What a history row is called: the prompt, else what Claude answered, else when it ran. */
function titleOf(entry: FenceHistoryEntry): string {
  if (entry.prompt) return readableTitle(entry.prompt)
  if (entry.reply) return `Claude: ${entry.reply}`
  const at = new Date(entry.startedAt)
  return `Untitled prompt, ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${resetTime(at.toISOString()) ?? ''}`.trim()
}

type IconName = 'clock' | 'tokens' | 'session' | 'weekly' | 'shield' | 'shieldOff' | 'pause' | 'stop' | 'agent' | 'prompt' | 'sliders'

/** A neutral gray that reads on light and dark backgrounds alike (an SVG image cannot take the theme's color). */
const ICON_STROKE = '#8b919c'

/**
 * Each limit keeps one color wherever its icon appears, so a glance tells them apart.
 * Mid-tone hues that read on light and dark backgrounds; the terminal uses the theme's nearest keys.
 */
const ICON_COLORS: Record<IconName, string> = {
  clock: '#4f8fe0',
  tokens: '#9a72e6',
  session: '#2fa7a0',
  weekly: '#e0874f',
  shield: '#3fa65f',
  shieldOff: ICON_STROKE,
  pause: '#e0524f',
  stop: '#e0524f',
  agent: '#c06fb0',
  prompt: ICON_STROKE,
  sliders: ICON_STROKE,
}
const GLYPH_COLORS: Record<IconName, 'suggestion' | 'merged' | 'planMode' | 'claude' | 'success' | 'subtle' | 'warning' | 'error'> = {
  clock: 'suggestion',
  tokens: 'merged',
  session: 'planMode',
  weekly: 'claude',
  shield: 'success',
  shieldOff: 'subtle',
  pause: 'error',
  stop: 'error',
  agent: 'merged',
  prompt: 'subtle',
  sliders: 'subtle',
}

/** The band's gauges in reading order, each with the pane's icon for it. */
const BAND_GAUGES: Gauge[] = ['minutes', 'tokens', 'share', 'weeklyShare']
const BAND_ICONS: Record<Gauge, IconName> = { minutes: 'clock', tokens: 'tokens', share: 'session', weeklyShare: 'weekly' }
const GAUGE_NAMES: Record<Gauge, string> = { minutes: 'Time', tokens: 'Tokens', share: 'Session', weeklyShare: 'Weekly' }
/** How much closer another limit must be before it takes the lead. */
const LEAD_MARGIN = 0.05
/** The tools a subagent reports back with: let through once the person has stopped it. */
const REPORT_TOOLS = new Set(['SubagentHandback'])

/** The most rows the band takes when several runs are going, its "more" row included. */
const BAND_ROWS = 4
const WARNING_HEX = '#e0a32f'
const ERROR_HEX = '#e0524f'
/**
 * The band's divider: a line 2 wide and 12 high, on whole pixels, in the middle of an
 * icon-sized image, in the bar's track gray made a little stronger. Like every image the
 * band draws, it has alt text: the two that had none, and a hairline on a half pixel, never showed.
 */
const DIVIDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="7" y="2" width="2" height="12" rx="1" fill="rgba(139, 145, 156, 0.6)"/></svg>'

/** The lead's bar: short enough that a little use doesn't read as a long empty track. */
const BAR_PX = 40
const BAR_HEIGHT = 4
const BAR_CELLS = 8
const BAR_TRACK = 'rgba(139, 145, 156, 0.3)'

/**
 * The usage gauge, shrunk to the top-left, with the window's length set in the
 * bottom-right corner like a subscript: one family of icon for both limits.
 */
function badgedGauge(badge: string, color: string): string {
  return (
    '<g transform="translate(0 -1) scale(0.78)"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></g>' +
    `<text x="24" y="23.5" text-anchor="end" font-family="-apple-system, system-ui, sans-serif" font-size="11" font-weight="700" fill="${color}" stroke="none">${badge}</text>`
  )
}

/** Lucide-style outline paths, 24×24, drawn at 16px. */
const ICON_PATHS: Record<IconName, string> = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tokens: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  session: badgedGauge('5h', '#2fa7a0'),
  weekly: badgedGauge('7d', '#e0874f'),
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  shieldOff: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 9l6 6M15 9l-6 6"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  stop: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  agent: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  prompt: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
}

/** The terminal draws no SVG: a glyph of the same idea stands in. */
const ICON_GLYPHS: Record<IconName, string> = {
  clock: '◷',
  tokens: '#',
  session: '◔ˢ',
  weekly: '◔ʷ',
  shield: '◆',
  shieldOff: '◇',
  pause: '‖',
  stop: '■',
  agent: '⧉',
  prompt: '›',
  sliders: '≡',
}


function iconFor($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const table = $.ui.resolve(e)
  const { Text } = table
  const Svg = e.surface !== 'terminal' && 'Svg' in table ? (table as Elements['desktop']).Svg : undefined
  return (name: IconName, alt: string) =>
    Svg ? (
      <Svg
        key={`icon-${name}-${alt}`}
        alt={alt}
        width={16}
        height={16}
        source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ICON_COLORS[name]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`}
      />
    ) : (
      <Text key={`icon-${name}-${alt}`} color={GLYPH_COLORS[name]}>
        {ICON_GLYPHS[name]}
      </Text>
    )
}

/** A line at the end of a prompt, only when something worth knowing happened. */
function receiptOf(run: FenceRun, limits: FenceLimits): string | null {
  const share = shareOf(run, run.five ? 'five' : 'week').value
  const base = run.five ? limits.share : limits.weeklyShare
  const isLarge = base > 0 && share >= base * 0.5
  if (run.pauses === 0 && !isLarge) return null
  const parts = [
    run.five || run.week ? `That prompt used ~${pct(share)} of your ${run.five ? 'session' : 'weekly'} limit` : null,
    run.pauses > 0 ? `paused ${run.pauses === 1 ? 'once' : `${run.pauses} times`}` : null,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' · ') : null
}
