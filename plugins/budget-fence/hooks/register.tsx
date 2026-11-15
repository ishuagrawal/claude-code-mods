import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, RenderInput, Space } from 'claude-code'

import type { FenceCalibration, FenceHistoryEntry, FenceLimits, FenceRun, FenceTally } from '../types'
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
} from './fence'
import type { Gauge, Reading, Trip } from './fence'
import { drawPrompt, promptContent } from './live'
import type { PromptPart, PromptStat, PromptView } from './live'

const PANE = 'budget-fence'
const TITLE = 'Budget fence'
const STORE_KEY = 'limits'

const limitsAtom = atom({ plugin: 'budget-fence', key: 'limits' } as const, DEFAULT_LIMITS, { shape: 'limits-1' })
const runAtom = atom({ plugin: 'budget-fence', key: 'run' } as const, null, { shape: 'run-1' })
const historyAtom = atom({ plugin: 'budget-fence', key: 'history' } as const, [], { shape: 'history-1' })
const HISTORY_PANE = 'budget-fence-history'
const HISTORY_KEY = 'history'
// What each model has learned about its rate, keyed by model.
const CALIBRATION_KEY = 'calibration'
const editingAtom = atom({ plugin: 'budget-fence', key: 'editing' } as const, null, { shape: 'editing-1' })
const recentOpenAtom = atom({ plugin: 'budget-fence', key: 'recentOpen' } as const, false, { shape: 'recent-1' })
const planAtom = atom({ plugin: 'budget-fence', key: 'plan' } as const, null, { shape: 'plan-1' })

/**
 * Keep the run and history here so reading them while drawing the pane doesn't
 * subscribe it to every update. The live figures update through their Client.
 */
const pane = {
  run: null as FenceRun | null,
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
    // The pane draws each figure's icon and name itself, so a figure appearing or going redraws it.
    const before = figuresOf(pane.run).join()
    pane.run = await update($, runAtom, fn)
    if (pane.hasPlainSurface || figuresOf(pane.run).join() !== before) {
      $.ui.invalidate('ui.render')
    }
  })
  pane.changing = changed.catch(() => undefined)
  return changed
}

/** Writes the history, for the pane to draw when it next can. */
async function changeHistory($: EngineInterface, fn: (list: FenceHistoryEntry[]) => FenceHistoryEntry[]) {
  pane.history = await update($, historyAtom, list => fn(list ?? []))
  $.ui.invalidate('ui.render')
  return pane.history
}

/** Custom… opens its field; any other pick saves the value and closes the editor. */
async function pickLimit($: EngineInterface, key: Gauge, picked: string, isDesktop: boolean) {
  const revision = desktop.focusRevision
  try {
    if (picked === CUSTOM) {
      await update($, editingAtom, () => ({ key, error: null }))
      return
    }
    const value = Number(picked)
    if (!Number.isFinite(value) || value < 0) return
    if ((await read($, editingAtom))?.key === key) await update($, editingAtom, () => null)
    await saveLimit($, key, value)
  } finally {
    // The render held behind the menu must see the new value (or custom field).
    if (isDesktop && desktop.focusRevision === revision) {
      desktop.isChoosing = false
      desktop.wake?.()
    }
  }
}

/** Saves one setting, applying it to the prompt already running. */
async function saveLimit($: EngineInterface, key: keyof FenceLimits, value: FenceLimits[keyof FenceLimits]) {
  const next = await update($, limitsAtom, l => ({ ...l, [key]: value }))
  await $.store.set(STORE_KEY, next)
  await changeRun($, r => (r && r.status !== 'done' ? withLimitChanged(r, key) : r))
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
export async function askToContinue($: EngineInterface, trip: Trip): Promise<{ go: true } | { go: false; said?: string }> {
  let hasOpened = false
  let note = ''
  for (;;) {
    const [run, limits, now] = await Promise.all([read($, runAtom), read($, limitsAtom), $.clock.now()])
    if (!run) return { go: true }
    const g = gaugeOf(run, limits, trip.kind, now)
    const used = g?.used ?? 0
    const raised = raisedLimit(trip.kind, limits[trip.kind], used)
    const raise = `Continue and raise the ${LIMIT_NAMES[trip.kind]} to ${limitLabel(trip.kind, raised)}`
    const question = `${note}This prompt has used ${formatUsed(trip.kind, used, g?.share)}, past its ${LIMIT_NAMES[trip.kind]} of ${limitLabel(trip.kind, g?.cap ?? limits[trip.kind])}. Keep working?`
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
      await changeRun($, r => (r ? withUnfenced(r) : r))
      return { go: true }
    }
    if (answer === raise) {
      await saveLimit($, trip.kind, raised)
      return { go: true }
    }
    if (answer === OPEN) {
      void $.ui.open({ id: PANE, title: TITLE })
      hasOpened = true
      continue
    }
    if (answer !== KEEP) {
      const typed = parseLimitInput(trip.kind, answer)
      if (typed === null) return { go: false, said: answer }
      if (typed !== 0 && typed <= used) {
        note = `${limitLabel(trip.kind, typed)} is no more than it has used. `
        continue
      }
      await saveLimit($, trip.kind, typed)
      return { go: true }
    }
    // Kept as set: go on unless the pane left this prompt over a limit.
    const [runNow, limitsNow, nowNow] = await Promise.all([read($, runAtom), read($, limitsAtom), $.clock.now()])
    const still = runNow ? tripOf(runNow, limitsNow, nowNow) : null
    if (!still) return { go: true }
    hasOpened = false
    note = 'Still over a limit. '
    trip = still
  }
}

export const register: Register = on => {
  // One question at a time: calls that trip while it is open share its answer.
  let asking: ReturnType<typeof askToContinue> | null = null
  // Calls paused by the fence, by tool_use_id: what tripped, and in which loop.
  const pending = new Map<string, { trip: Trip; loopId: string }>()
  // Which limit holds the band's bar.
  let leadGauge: Gauge | null = null
  // The text of the prompt last sent, for the run it starts.
  let lastPrompt = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'fence',
      description: 'Pause a prompt before it uses too much of your usage limit',
      argumentHint: '[time 20m] [tokens 500k] [session 10%] [weekly 2%] [window 90] [loops 3] [on|off]',
    })
    const history = await $.store.get(HISTORY_KEY)
    if (Array.isArray(history)) await update($, historyAtom, () => history as FenceHistoryEntry[])
    // Debugging once kept a trace here; it is no longer written.
    await $.store.delete('debug-trace').catch(() => undefined)
    // A reload starts the module over; the session's values outlive it.
    pane.run = await read($, runAtom)
    pane.history = await read($, historyAtom)
    const saved = savedLimits(await $.store.get(STORE_KEY))
    if (saved) await update($, limitsAtom, () => saved)
    await notePlan($, (await $.session.usage()).rateLimits)

    return started
  })

  on('command.run', { command: 'fence' }, async ($, e) => {
    const [limits, plan] = await Promise.all([read($, limitsAtom), read($, planAtom)])
    const hasSession = plan?.hasSession ?? true
    if (e.args.trim() === '') {
      void $.ui.open({ id: PANE, title: TITLE })

      return { text: `${describe(limits, hasSession)} Adjust the limits in the Budget fence pane.` }
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
    return submitted
  }).catch(($, e, next) => next(e))

  // A prompt starts a run; background agents still going fold into it.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const fresh = newRun(e.turnId, now, usage.rateLimits, e.text.trim() || lastPrompt, ratesOf(await calibration($)))
    await notePlan($, usage.rateLimits)
    pending.clear()
    await changeRun($, prev => {
      const carried = (prev?.loops ?? []).filter(l => l.id !== MAIN && l.isRunning).map(l => ({ ...l, units: 0 }))
      return { ...fresh, loops: [...fresh.loops, ...carried] }
    })

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const loopId = e.agentId ?? MAIN
    // A new step in a loop whose call is still waiting means the person said no.
    const stale = [...pending].find(([, p]) => p.loopId === loopId)
    if (stale) {
      pending.delete(stale[0])
      const now = await $.clock.now()
      await changeRun($, run => (run?.status === 'paused' ? withDenied(run, now) : run))
    }
    const stepped = yield* next(e)
    // Readings arrive with each response; a plan with no cost ledger raises
    // session.measure only when a window moves a whole point, so read them here.
    const { rateLimits } = await $.session.usage()
    await notePlan($, rateLimits)
    await changeRun($, run =>
      run ? withReading(withStep(run, loopId, stepped.usage?.model ?? e.model, stepped.usage), rateLimits) : run,
    )

    return stepped
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.rateLimits.length > 0) {
      // A finished prompt keeps its last reading, and an unchanged one is not written:
      // every write redraws the pane, which puts an open dropdown's highlight back.
      const run = await read($, runAtom)
      if (run && run.status !== 'done') {
        const remeasured = withReading(run, e.rateLimits)
        if (JSON.stringify([remeasured.five, remeasured.week]) !== JSON.stringify([run.five, run.week])) {
          await changeRun($, r => (r && r.status !== 'done' ? withReading(r, e.rateLimits) : r))
        }
      }
      await notePlan($, e.rateLimits)
    }

    return measured
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.deny === undefined ? spawned.agentId : undefined
    if (agentId !== undefined) {
      await changeRun($, run =>
        run
          ? withLoop(run, {
              id: agentId,
              label: e.description || e.subagentType || 'Subagent',
              toolUseId: e.tool_use_id || null,
              units: 0,
              steps: 0,
              isRunning: true,
              isBackground: e.background,
            })
          : run,
      )
      }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    const loopId = e.agentId ?? MAIN
    const now = await $.clock.now()
    let finished: FenceRun | null = null
    await changeRun($, run => {
      if (!run || run.status === 'done') return run
      const after = withLoopDone(run, loopId, now)
      finished = after.status === 'done' ? after : null
      return after
    })
    if (finished) {
      await $.store.set(CALIBRATION_KEY, withCalibrated(await calibration($), finished))
      const entry = historyEntryOf(finished, e.agentId === undefined ? completed.text : '')
      const history = await changeHistory($, list => withHistory(list, entry))
      await $.store.set(HISTORY_KEY, history)
      const limits = await read($, limitsAtom)
      const receipt = receiptOf(finished, limits)
      if (receipt) $.ui.toast(receipt)
    }

    return completed
  })

  // The pause: the next tool call waits on the app's own approval prompt.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny' || e.tool_use_id === undefined) return verdict
    const [run, limits] = await Promise.all([read($, runAtom), read($, limitsAtom)])
    if (!run) return verdict
    const now = await $.clock.now()
    const trip = tripOf(run, limits, now)
    if (!trip) return verdict
    if (e.approver === undefined) {
      // A background agent has nobody to ask: it stops and reports back.
      return {
        decision: 'deny',
        reason: `Budget fence: ${trip.reason}. Stop here and report what you have so far.`,
      }
    }
    const toolUseId = e.tool_use_id
    if (e.approver === 'person') {
      // The question sits where the prompt box is; the call waits on it.
      await changeRun($, r => (r && r.status !== 'paused' ? withPaused(r, trip, toolUseId, now) : r))
      asking ??= askToContinue($, trip).finally(() => {
        asking = null
      })
      const answer = await asking
      const after = await $.clock.now()
      await changeRun($, r => (r && r.status === 'paused' ? (answer.go ? withResumed(r, after) : withDenied(r, after)) : r))
      if (answer.go) return verdict
      return {
        decision: 'deny',
        reason: answer.said
          ? `Budget fence: ${trip.reason}, and the person stopped it, saying: ${answer.said}`
          : `Budget fence: ${trip.reason}, and the person chose to stop here. Wrap up and report what you have so far.`,
      }
    }
    // A host answers asks with no question to show: it gets the plain approval, and Allow gives half again.
    pending.set(toolUseId, { trip, loopId: e.agentId ?? MAIN })
    await changeRun($, r => (r ? withPaused(r, trip, toolUseId, now) : r))

    return { decision: 'ask', reason: `Budget fence: ${trip.reason}. ${raiseNote(limits, trip)}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const paused = pending.get(e.tool_use_id)
    if (paused) {
      pending.delete(e.tool_use_id)
      const [limits, now] = await Promise.all([read($, limitsAtom), $.clock.now()])
      await changeRun($, run => {
        if (!run) return run
        return ran.deny !== undefined ? withDenied(run, now) : withAllowed(run, limits, paused.trip, now)
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The band: the limit closest to its cap gets a bar; the rest sit beside it as icon and percent.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [run, limits] = await Promise.all([read($, runAtom), read($, limitsAtom)])
    if (!run || run.status === 'done' || !limits.isOn) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // Box sizes and gaps are in cells on every surface; a graphical surface draws thin shapes as Svg, in CSS pixels.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? (table as Elements['desktop']).Svg : undefined
    const icon = iconFor($, e)
    const isTerminal = e.surface === 'terminal'
    const now = await $.clock.now()

    const gauges = BAND_GAUGES.flatMap(gauge => {
      const g = gaugeOf(run, limits, gauge, now)
      return g && g.cap > 0 ? [{ gauge, g, ratio: g.used / g.cap }] : []
    })
    if (gauges.length === 0) return next(e)
    // The lead only changes hands when another limit is clearly closer, so the bar does not flicker.
    const top = gauges.reduce((a, b) => (b.ratio > a.ratio ? b : a))
    const held = gauges.find(x => x.gauge === leadGauge)
    const lead = held && top.ratio - held.ratio < LEAD_MARGIN ? held : top
    leadGauge = lead.gauge
    const rest = gauges.filter(x => x !== lead)

    const isPaused = run.status === 'paused'
    const isStopped = run.status === 'denied'
    const isHalted = isPaused || isStopped
    // Halted, paused or stopped, the whole row turns red, as the pane does.
    const leadLevel: Level = isHalted ? 'error' : levelOf(lead.g.used, lead.g.cap)

    // One spacing scale for every state: an icon and the lead's bar sit tight to what they
    // label, and groups sit apart either side of a hairline (whose image is margin enough).
    const tight: Space = isTerminal ? 1 : 'xs'
    const group: Space = isTerminal ? 2 : 'sm'

    // The closest limit leads with a bar, so which one is nearest is plain at a glance, in its
    // own color, amber from 80% and red at the limit (and red while halted). The terminal draws
    // the bar in characters.
    const bar = (gauge: Gauge, ratio: number) => {
      const r = Math.min(1, Math.max(0, ratio))
      const level = isHalted ? leadLevel : levelOf(ratio, 1)
      const hex = level === 'error' ? ERROR_HEX : level === 'warning' ? WARNING_HEX : ICON_COLORS[BAND_ICONS[gauge]]
      if (!Svg) {
        const filled = r > 0 ? Math.max(1, Math.round(r * BAR_CELLS)) : 0
        return (
          <Box key="bar" flexDirection="row">
            <Text color={level ?? GLYPH_COLORS[BAND_ICONS[gauge]]}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(BAR_CELLS - filled)}</Text>
          </Box>
        )
      }
      // At least a short sliver once anything is used, so the bar never reads as empty.
      const w = r > 0 ? Math.max(BAR_HEIGHT, Math.round(r * BAR_PX)) : 0
      return (
        <Svg
          key="bar"
          alt={`${Math.round(r * 100)}% of the limit`}
          width={BAR_PX}
          height={BAR_HEIGHT}
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_PX} ${BAR_HEIGHT}"><rect width="${BAR_PX}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" fill="${BAR_TRACK}"/>${w > 0 ? `<rect width="${w}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" fill="${hex}"/>` : ''}</svg>`}
        />
      )
    }

    // Every state reads the same way, "used / limit", with the used part in the row's color.
    const figure = (
      <Text key="fig" size="footnote" tabular>
        <Text color={leadLevel}>{lead.g.share ? shareText(lead.g.share) : shortAmount(lead.gauge, lead.g.used)}</Text>
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
    // Halted, a status leads the row: its own icon, like every limit, and its word.
    const status = isHalted
      ? pair('status', [
          icon(isPaused ? 'pause' : 'stop', isPaused ? 'Paused' : 'Stopped'),
          <Text key="word" size="footnote" weight="medium" color={leadLevel}>
            {isPaused ? 'Paused' : 'Stopped'}
          </Text>,
        ])
      : null

    // What fits: the lead always; the others while there is room.
    const columns = e.props.bodyColumns ?? 80
    const room = Math.max(0, Math.floor((columns - 30) / 10))
    const others = isHalted ? [] : rest.slice(0, room)

    // Each group is tight inside (its icon, the lead's bar, its figure) and set apart from the
    // next by a divider with a wide gap either side, so which figure belongs to which icon is plain.
    const groups = [
      status,
      pair('lead', [icon(BAND_ICONS[lead.gauge], GAUGE_NAMES[lead.gauge]), bar(lead.gauge, lead.ratio), figure]),
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
      <Box flexDirection="row" alignItems="center" columnGap={group}>
        {groups.flatMap((g, n) => (n === 0 ? [g] : [divider(`divider-${n}`), g]))}
        <Box key="spacer" flexGrow={1} />
        <Button key="details" plain dimColor label="⋯" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const previous = desktop.limit
    const wasChoosing = desktop.isChoosing
    const revision = ++desktop.focusRevision
    const limit = e.element?.startsWith('limit-') ? e.element : null
    // Capture the move before calling next: it can ask for another drawing.
    desktop.limit = limit
    desktop.isChoosing = limit !== null
    if (limit === null ? previous !== null || e.element !== undefined : !wasChoosing) desktop.wake?.()
    const moved = await next(e)
    if (moved.deny !== undefined && desktop.focusRevision === revision) {
      desktop.limit = previous
      desktop.isChoosing = wasChoosing
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
    const view = promptView(run, limits, now, block.part, block.figure)
    return e.data === promptContent(view) ? {} : { props: view }
  }).catch(($, e, next) => next(e))

  // The pane: what this prompt is spending, the settings, recent prompts.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPaneInTurn($, e, async () => {
    const table = $.ui.resolve(e)
    const { Box, Button, Input, Select, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? (table as Elements['desktop']).Svg : undefined
    if (!Client) pane.hasPlainSurface = true
    const { run, history } = pane
    const [limits, plan, editing, isRecentOpen] = await Promise.all([
      read($, limitsAtom),
      read($, planAtom),
      read($, editingAtom),
      read($, recentOpenAtom),
    ])
    const now = await $.clock.now()
    const icon = iconFor($, e)
    // What this drawing's rings show, so the head's tick redraws only when one steps.
    if (run) pane.rings = ringsKey(run, limits, now)

    const setLimit = (key: keyof FenceLimits, value: FenceLimits[keyof FenceLimits]) => saveLimit($, key, value)

    const heading = (text: string, trailing?: RenderChildren) => (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="md">
        <Text size="footnote" weight="medium" color="subtle">
          {text.toUpperCase()}
        </Text>
        {trailing ?? null}
      </Box>
    )

    // Custom… opens a field under the row for values the presets don't cover.
    const row = (key: Gauge, glyph: IconName, name: string, choices: readonly number[]) => {
      const value = limits[key]
      const isEditing = editing?.key === key
      const submit = (text: string) =>
        void (async () => {
          const parsed = parseLimitInput(key, text)
          if (parsed === null) {
            await update($, editingAtom, () => ({ key, error: `Didn't understand "${text.trim()}". ${EXAMPLES[key]}` }))
            return
          }
          await update($, editingAtom, () => null)
          await setLimit(key, parsed)
        })()
      return (
        <Box key={key} flexDirection="column" rowGap="xs">
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            {icon(glyph, name)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" color={limits.isOn ? undefined : 'subtle'}>
                {name}
              </Text>
            </Box>
            <Select
              key={`limit-${key}`}
              options={optionsFor(key, choices, value)}
              value={isEditing ? CUSTOM : String(value)}
              onSelect={(v, event) => void pickLimit($, key, v, event.surface === 'desktop')}
            />
          </Box>
          {isEditing ? (
            <Box flexDirection="column" rowGap="xs">
              <Box flexDirection="row" alignItems="center" columnGap="sm">
                <Box flexGrow={1} flexShrink={1}>
                  <Input
                    key={`custom-${key}`}
                    placeholder={PLACEHOLDERS[key]}
                    value={value > 0 && !choices.includes(value) ? String(value) : ''}
                    submitLabel="set"
                    autoFocus
                    onSubmit={submit}
                  />
                </Box>
                <Button
                  key={`cancel-${key}`}
                  plain
                  dimColor
                  label="Cancel"
                  onPress={() => void update($, editingAtom, () => null)}
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
        <Client key={`${LIVE_PREFIX}${part === 'head' ? 'head' : figure}`} module="./live.ts" props={view} width={part === 'head' ? '100%' : undefined} />
      ) : (
        drawPrompt({ Box, Text }, view)
      )
    }
    const promptSection = !run ? null : (
      <Box flexDirection="column" rowGap="sm">
        {block('head')}
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

    const recent = history.slice(0, 3)

    return (
      <Box flexDirection="column" rowGap="lg">
        <Box flexDirection="row" alignItems="center" columnGap="sm">
          {icon(limits.isOn ? 'shield' : 'shieldOff', limits.isOn ? 'On' : 'Off')}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text weight="medium" color={limits.isOn ? 'success' : 'subtle'}>
              {limits.isOn ? 'Fence is on' : 'Fence is off'}
            </Text>
            <Text size="footnote" color="subtle" wrap="truncate-end">
              {limits.isOn ? 'Prompts pause at the limits below.' : 'Your limits are saved for when you turn it on.'}
            </Text>
          </Box>
          <Button
            key="toggle"
            variant={limits.isOn ? 'secondary' : 'primary'}
            label={limits.isOn ? 'Turn off' : 'Turn on'}
            onPress={() => void setLimit('isOn', !limits.isOn)}
          />
        </Box>

        {promptSection}

        <Box flexDirection="column" rowGap="sm">
          {heading('Pause a prompt after')}
          {row('minutes', 'clock', 'Working time', MINUTES)}
          {row('tokens', 'tokens', 'Tokens', TOKENS)}
          {hasSession ? row('share', 'session', 'Share of session limit', SESSION) : null}
          {hasWeekly ? row('weeklyShare', 'weekly', 'Share of weekly limit', WEEKLY) : null}
        </Box>

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
                  onPress={() => void update($, recentOpenAtom, open => !open)}
                />
                <Button
                  key="history"
                  plain
                  dimColor
                  label="View all"
                  onPress={() => void $.ui.open({ id: HISTORY_PANE, title: 'Prompt history' })}
                />
              </Box>,
            )}
            {isRecentOpen ? recent.map(entry => historyRow(Box, Text, icon, entry, now)) : null}
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
        <Box flexDirection="column" rowGap="md">
          {history.map(entry => historyRow(Box, Text, icon, entry, now))}
        </Box>
      </Box>
    )
  })
}

/** The `Client` keys of the prompt section's two blocks, and back. */
const LIVE_PREFIX = 'live-'

/** Which block a `Client` key names: the head, or one figure. */
function blockOf(key: string): { part: PromptPart; figure: Figure | '' } | null {
  if (!key.startsWith(LIVE_PREFIX)) return null
  const name = key.slice(LIVE_PREFIX.length)
  if (name === 'head') return { part: 'head', figure: '' }
  return name in FIGURE_ICONS ? { part: 'figure', figure: name as Figure } : null
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
function promptView(run: FenceRun, limits: FenceLimits, now: number, part: PromptPart, figure: Figure | '' = ''): PromptView {
  const stat = (name: Figure, gauge: Gauge, used: string): PromptStat => {
    const g = limits.isOn ? gaugeOf(run, limits, gauge, now) : null
    const isCapped = g !== null && g.cap > 0 && run.status !== 'done'
    const level = isCapped ? levelOf(g.used, g.cap) : undefined
    return { name, used, limit: isCapped ? shortAmount(gauge, g.cap) : '', color: level ?? null }
  }
  const stats = [
    stat('Time', 'minutes', duration(activeMs(run, now))),
    stat('Tokens', 'tokens', tokens(run.tokens)),
    ...(run.five ? [stat('Session', 'share', shareText(shareOf(run, 'five')))] : []),
    ...(run.week ? [stat('Weekly', 'weeklyShare', shareText(shareOf(run, 'week')))] : []),
  ]
  const subagents = run.loops.length - 1
  const loops =
    subagents > 0
      ? `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'} · ${[...run.loops]
          .sort((x, y) => y.units - x.units)
          .map(l => `${l.label} ~${pct(loopShare(run, l.id))}`)
          .join(', ')}`
      : ''
  // Each block carries only what it draws, so a block is sent nothing new while only
  // another's numbers move.
  const isHead = part === 'head'
  return {
    part,
    figure: isHead ? '' : figure,
    load: LOAD,
    at: now,
    heading: !isHead ? '' : run.status === 'done' ? 'LAST PROMPT' : 'THIS PROMPT',
    status: !isHead ? '' : run.isUnfenced && run.status === 'running' ? 'Running, no limits' : statusWord(run, now),
    statusColor: isHead ? STATUS_COLORS[run.status] : '',
    prompt: isHead ? run.prompt : '',
    note: isHead && run.status === 'paused' ? `${run.reason ?? 'A limit was reached'}. Waiting for your OK.` : '',
    stats: isHead ? [] : stats.filter(x => x.name === figure),
    loops: isHead ? loops : '',
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
  return (
    <Box key={entry.id} flexDirection="column" rowGap="xs">
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
  )
}

/** What a history row is called: the prompt, else what Claude answered, else when it ran. */
function titleOf(entry: FenceHistoryEntry): string {
  if (entry.prompt) return entry.prompt
  if (entry.reply) return `Claude: ${entry.reply}`
  const at = new Date(entry.startedAt)
  return `Untitled prompt, ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${resetTime(at.toISOString()) ?? ''}`.trim()
}

type IconName = 'clock' | 'tokens' | 'session' | 'weekly' | 'shield' | 'shieldOff' | 'pause' | 'stop'

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
}

/** The band's gauges in reading order, each with the pane's icon for it. */
const BAND_GAUGES: Gauge[] = ['minutes', 'tokens', 'share', 'weeklyShare']
const BAND_ICONS: Record<Gauge, IconName> = { minutes: 'clock', tokens: 'tokens', share: 'session', weeklyShare: 'weekly' }
const GAUGE_NAMES: Record<Gauge, string> = { minutes: 'Time', tokens: 'Tokens', share: 'Session', weeklyShare: 'Weekly' }
/** How much closer another limit must be before it takes the lead. */
const LEAD_MARGIN = 0.05
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
