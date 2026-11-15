import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, Space } from 'claude-code'

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
 * What the pane draws of the prompt, kept here rather than read while drawing:
 * a read subscribes the pane, every write then redraws it, and a redraw puts an
 * open dropdown's highlight back on its value. The run moves every step, so the
 * pane is redrawn by hand, and not while one of its settings has the focus.
 */
const pane = {
  run: null as FenceRun | null,
  history: [] as FenceHistoryEntry[],
  /** The setting whose dropdown holds the pane's focus ring. */
  focus: null as string | null,
  /** Whether the pane skipped a redraw while a setting had the focus. */
  isStale: false,
  /** The props of the last drawing, `isFocused` left out, and its `isFocused`. */
  drawnProps: null as string | null,
  wasFocused: false,
  /** Drawings held back while a setting's dropdown is open, each waiting for `releasePane`. */
  held: [] as (() => void)[],
  /** The pane's drawing in progress: each waits for the one before, so none answers out of turn. */
  drawing: Promise.resolve() as Promise<unknown>,
}

/**
 * Runs one drawing of the pane after the one before it has answered. An answer
 * that lands after a newer one leaves the surface pressing the older drawing's
 * dropdowns, so a pick goes nowhere; and a request repeated while one is held
 * back waits behind it instead of drawing over an open dropdown.
 */
function drawInTurn<T>(draw: () => Promise<T>): Promise<T> {
  const drawn = pane.drawing.then(draw)
  pane.drawing = drawn.catch(() => undefined)
  return drawn
}

/** Lets every held-back drawing answer. */
function releasePane() {
  for (const release of pane.held.splice(0)) release()
}

/** Redraws the pane for what changed, or leaves it for when the focus moves off a setting. */
function refreshPane($: EngineInterface) {
  if (pane.focus !== null) {
    pane.isStale = true
    return
  }
  pane.isStale = false
  $.ui.invalidate('ui.render')
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
  // Written only on a change: each write redraws the pane, which resets an open dropdown.
  const was = await read($, planAtom)
  if (was?.hasSession !== plan.hasSession || was?.hasWeekly !== plan.hasWeekly) await update($, planAtom, () => plan)
}

/** `update` for the run, writing nothing when `fn` hands back the run it was given. */
async function changeRun($: EngineInterface, fn: (run: FenceRun | null) => FenceRun | null) {
  const run = await read($, runAtom)
  if (fn(run) === run) return
  pane.run = await update($, runAtom, fn)
  refreshPane($)
}

/** Writes the history, for the pane to draw when it next can. */
async function changeHistory($: EngineInterface, fn: (list: FenceHistoryEntry[]) => FenceHistoryEntry[]) {
  pane.history = await update($, historyAtom, list => fn(list ?? []))
  refreshPane($)
  return pane.history
}

/**
 * A pick from a setting's dropdown: Custom… opens its field; any other value is
 * saved. A pick closes the dropdown, so a drawing held back for it answers.
 */
async function pickLimit($: EngineInterface, key: Gauge, picked: string) {
  try {
    if (picked === CUSTOM) {
      await update($, editingAtom, () => ({ key, error: null }))
      return
    }
    const value = Number(picked)
    if (!Number.isFinite(value) || value < 0) return
    // Closes this setting's custom field, writing nothing when it was not open.
    if ((await read($, editingAtom))?.key === key) await update($, editingAtom, () => null)
    await saveLimit($, key, value)
  } finally {
    releasePane()
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
    // A reload starts the module over; the session's values outlive it.
    pane.run = await read($, runAtom)
    pane.history = await read($, historyAtom)
    pane.focus = null
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
    // Halted, the whole row takes the state's color, as the pane does: amber waiting, red stopped.
    const leadLevel: Level = isPaused ? 'warning' : isStopped ? 'error' : levelOf(lead.g.used, lead.g.cap)

    // One spacing scale for every state: an icon sits tight to what it labels,
    // the bar a step from its figure, and groups well apart.
    const tight: Space = isTerminal ? 1 : 'xs'
    const item: Space = isTerminal ? 1 : 'sm'
    const group: Space = isTerminal ? 2 : 'md'
    const between: Space = isTerminal ? 3 : 'lg'

    const bar = (ratio: number) => {
      const r = Math.min(1, Math.max(0, ratio))
      const fill = leadLevel === 'error' ? ERROR_HEX : leadLevel === 'warning' ? WARNING_HEX : ACCENT_HEX
      if (!Svg) {
        const filled = r > 0 ? Math.max(1, Math.round(r * BAR_CELLS)) : 0
        return (
          <Box key="bar" flexDirection="row">
            <Text color={leadLevel ?? 'suggestion'}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(BAR_CELLS - filled)}</Text>
          </Box>
        )
      }
      const w = Math.round(r * BAR_PX)
      return (
        <Svg
          key="bar"
          alt={`${Math.round(r * 100)}% of the limit`}
          width={BAR_PX}
          height={BAR_HEIGHT}
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_PX} ${BAR_HEIGHT}"><rect width="${BAR_PX}" height="${BAR_HEIGHT}" rx="2" fill="${TRACK}"/>${w > 0 ? `<rect width="${w}" height="${BAR_HEIGHT}" rx="2" fill="${fill}"/>` : ''}</svg>`}
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
    const divider = (key: string) =>
      Svg ? (
        <Svg
          key={key}
          alt=""
          width={1}
          height={DIVIDER_HEIGHT}
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 ${DIVIDER_HEIGHT}"><rect width="1" height="${DIVIDER_HEIGHT}" fill="${DIVIDER}"/></svg>`}
        />
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
    const room = Math.max(0, Math.floor((columns - 30) / 9))
    const others = isHalted ? [] : rest.slice(0, room)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={group}>
        {status}
        {status ? divider('status-divider') : null}
        {pair('lead', [icon(BAND_ICONS[lead.gauge], GAUGE_NAMES[lead.gauge]), pair('meter', [bar(lead.ratio), figure], item)])}
        {others.length > 0 ? divider('others-divider') : null}
        {others.length > 0 ? (
          <Box key="others" flexDirection="row" alignItems="center" columnGap={between}>
            {others.map(o => {
              const level = levelOf(o.g.used, o.g.cap)
              return pair(
                o.gauge,
                [
                  icon(BAND_ICONS[o.gauge], GAUGE_NAMES[o.gauge]),
                  <Text key="pct" size="footnote" tabular color={level ?? 'subtle'}>
                    {`${Math.min(999, Math.round(o.ratio * 100))}%`}
                  </Text>,
                ],
              )
            })}
          </Box>
        ) : null}
        <Box key="spacer" flexGrow={1} />
        <Button key="details" plain dimColor label="⋯" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  // Which setting's dropdown has the pane's focus, kept in memory: a write here
  // would redraw the pane as the dropdown takes the focus.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny !== undefined) return moved
    pane.focus = e.element?.startsWith('limit-') ? e.element : null
    if (pane.focus === null) releasePane()
    // Off the settings: draw what changed meanwhile.
    if (pane.focus === null && pane.isStale) refreshPane($)
    return moved
  }).catch(($, e, next) => next(e))

  // The pane: what this prompt is spending, the settings, recent prompts.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawInTurn(async () => {
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    // A pane without the keyboard has no setting in focus, whatever the last move said:
    // the live figures never stay frozen behind a focus that left without a word.
    if (!e.props.isFocused) pane.focus = null
    // The desktop asks for a drawing when the pane takes the focus, which a click on a
    // setting's dropdown does, and only once the button is up: the drawing lands with the
    // dropdown open, rebuilds it and puts its highlight back on its value under the
    // pointer. Nothing drawn reads `isFocused`, so a drawing asked for that alone, with a
    // dropdown in focus, waits for the pick or the focus to move on (or 30s at most).
    // What was drawn is noted before any wait, so a later drawing is compared with itself.
    const drawnProps = JSON.stringify({ ...e.props, isFocused: undefined })
    const isFocusMoveAlone = drawnProps === pane.drawnProps && e.props.isFocused !== pane.wasFocused
    pane.drawnProps = drawnProps
    pane.wasFocused = e.props.isFocused
    if (e.surface === 'desktop' && isFocusMoveAlone && pane.focus !== null) {
      await Promise.race([new Promise<void>(release => pane.held.push(release)), $.clock.sleep(30_000)])
    } else {
      // A drawing for anything else stands in for one held back.
      releasePane()
    }
    // The run and the history come from memory, not a read (see `pane`), and after any
    // wait, so a held drawing shows the prompt as it stands.
    const { run, history } = pane
    pane.isStale = false
    const [limits, plan, editing, isRecentOpen] = await Promise.all([
      read($, limitsAtom),
      read($, planAtom),
      read($, editingAtom),
      read($, recentOpenAtom),
    ])
    const now = await $.clock.now()
    const icon = iconFor($, e)
    const isLive = run !== null && run.status !== 'done'
    const columns = e.props.bodyColumns ?? 60

    const setLimit = (key: keyof FenceLimits, value: FenceLimits[keyof FenceLimits]) => saveLimit($, key, value)

    const heading = (text: string, trailing?: RenderChildren) => (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="md">
        <Text size="footnote" weight="medium" color="subtle">
          {text.toUpperCase()}
        </Text>
        {trailing ?? null}
      </Box>
    )

    // One setting: its icon and name, the dropdown, and under the name what this prompt has used.
    // "Custom…" opens a field under the row for any value the presets miss.
    const row = (key: Gauge, glyph: IconName, name: string, choices: readonly number[], hint: Hint | null) => {
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
              {hint ? (
                <Text size="footnote" tabular wrap="truncate-end" color={hint.color ?? 'subtle'}>
                  {hint.text}
                </Text>
              ) : null}
            </Box>
            <Select
              key={`limit-${key}`}
              options={optionsFor(key, choices, value)}
              value={isEditing ? CUSTOM : String(value)}
              onSelect={v => void pickLimit($, key, v)}
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

    const gaugeHint = (gauge: Gauge): Hint | null => {
      if (!isLive || !limits.isOn) return null
      const g = gaugeOf(run, limits, gauge, now)
      if (!g || g.cap === 0) return null
      const raised = g.cap > g.base ? ` · raised to ${shortAmount(gauge, g.cap)}` : ''
      const used = g.share ? shareText(g.share) : shortAmount(gauge, g.used)
      return { text: `${used} of ${shortAmount(gauge, g.cap)} used${raised}`, color: levelOf(g.used, g.cap) }
    }

    // Ultra plans have no 5-hour session window; offer only the windows the plan has.
    const hasSession = plan?.hasSession ?? true
    const hasWeekly = plan?.hasWeekly ?? true

    // A figure with its icon above its name: time, tokens, and the share of each window.
    const stat = (glyph: IconName, name: string, value: string, level: Level) => (
      <Box key={name} flexDirection="column" rowGap="xs" flexGrow={1} flexShrink={1} minWidth={10}>
        <Box flexDirection="row" alignItems="center" columnGap="xs">
          {icon(glyph, name)}
          <Text size="footnote" color="subtle" wrap="truncate-end">
            {name}
          </Text>
        </Box>
        <Text weight="medium" tabular color={level}>
          {value}
        </Text>
      </Box>
    )

    const near = (gauge: Gauge): Level => {
      if (!run || !limits.isOn) return undefined
      const g = gaugeOf(run, limits, gauge, now)
      return g ? levelOf(g.used, g.cap) : undefined
    }

    const promptSection = run ? (
      <Box flexDirection="column" rowGap="sm">
        {heading(
          isLive ? 'This prompt' : 'Last prompt',
          <Text size="footnote" weight="medium" color={STATUS_COLORS[run.status]}>
            {statusWord(run, now)}
          </Text>,
        )}
        {run.prompt ? (
          <Text wrap="truncate-end" color="subtle">
            {run.prompt}
          </Text>
        ) : null}
        {run.status === 'paused' ? (
          <Text size="footnote" color="warning">
            {run.reason ?? 'A limit was reached'}. Waiting for your OK.
          </Text>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap="lg" rowGap="sm">
          {stat('clock', 'Time', duration(activeMs(run, now)), near('minutes'))}
          {stat('tokens', 'Tokens', tokens(run.tokens), near('tokens'))}
          {run.five ? stat('session', 'Session', shareText(shareOf(run, 'five')), near('share')) : null}
          {run.week ? stat('weekly', 'Weekly', shareText(shareOf(run, 'week')), near('weeklyShare')) : null}
        </Box>
        {run.loops.length > 1 ? (
          <Text size="footnote" color="subtle" wrap="truncate-end">
            {run.loops.length - 1} {run.loops.length === 2 ? 'subagent' : 'subagents'} ·{' '}
            {[...run.loops]
              .sort((x, y) => y.units - x.units)
              .map(l => `${l.label} ~${pct(loopShare(run, l.id))}`)
              .join(', ')}
          </Text>
        ) : null}
      </Box>
    ) : null

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
          {row('minutes', 'clock', 'Working time', MINUTES, gaugeHint('minutes'))}
          {row('tokens', 'tokens', 'Tokens', TOKENS, gaugeHint('tokens'))}
          {hasSession ? row('share', 'session', 'Share of session limit', SESSION, gaugeHint('share')) : null}
          {hasWeekly ? row('weeklyShare', 'weekly', 'Share of weekly limit', WEEKLY, gaugeHint('weeklyShare')) : null}
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
            {isRecentOpen ? recent.map(entry => historyRow(Box, Text, entry, now, columns)) : null}
          </Box>
        ) : null}
      </Box>
    )
  }))

  // The history: every recent prompt, newest first, with what it spent.
  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [history, now] = await Promise.all([read($, historyAtom), $.clock.now()])
    const columns = e.props.bodyColumns ?? 60
    if (history.length === 0) {
      return <Text color="subtle">Finished prompts show here, with the time, tokens and limits each used.</Text>
    }
    const totals = history.reduce(
      (t, x) => ({ ms: t.ms + x.activeMs, tokens: t.tokens + x.tokens, weekly: t.weekly + (x.weeklyPct ?? 0) }),
      { ms: 0, tokens: 0, weekly: 0 },
    )

    return (
      <Box flexDirection="column" rowGap="lg">
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="md">
          <Text size="footnote" color="subtle" tabular wrap="truncate-end">
            {history.length} prompts · {duration(totals.ms)} · {tokens(totals.tokens)} tokens
            {totals.weekly > 0 ? ` · ~${pct(totals.weekly)} of weekly limit` : ''}
          </Text>
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
          {history.map(entry => historyRow(Box, Text, entry, now, columns))}
        </Box>
      </Box>
    )
  })
}

type Hint = { text: string; color: Level }

/** How close a figure is to its limit, as a color: plain, amber from 80%, red at the limit. */
type Level = 'warning' | 'error' | undefined
function levelOf(used: number, cap: number): Level {
  if (cap <= 0) return undefined
  return used >= cap ? 'error' : used / cap >= WARN_AT ? 'warning' : undefined
}

const CUSTOM = 'custom'

const MINUTES = [0, 5, 10, 15, 30, 60, 120]
const TOKENS = [0, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000]
const SESSION = [0, 2, 5, 10, 15, 20, 30]
const WEEKLY = [0, 0.5, 1, 2, 5, 10]

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

/** Running in blue, paused in amber, stopped in red, finished quiet. */
const STATUS_COLORS = { running: 'suggestion', paused: 'warning', denied: 'error', done: 'subtle' } as const

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

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** "3:00pm" for a reset today, "Mon 11:00am" for one later. */
function resetLabel(iso: string | null, now: number): string | null {
  const time = resetTime(iso)
  if (!time || !iso) return null
  const d = new Date(iso)
  const isSoon = d.getTime() - now < 20 * 3_600_000
  return isSoon ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

type Table = ReturnType<EngineInterface['ui']['resolve']>

/** A share the history kept: an estimate has decimals, a rounded reading is whole; both get "~". */
function savedShare(value: number, isExact: boolean | undefined): string {
  return shareText({ value, isExact: isExact === true, isEstimate: !Number.isInteger(value) })
}

function historyRow(Box: Table['Box'], Text: Table['Text'], entry: FenceHistoryEntry, now: number, columns: number) {
  const parts = [
    duration(entry.activeMs),
    `${tokens(entry.tokens)} tokens`,
    entry.sessionPct !== null ? `${savedShare(entry.sessionPct, entry.sessionIsExact)} of session` : null,
    entry.weeklyPct !== null ? `${savedShare(entry.weeklyPct, entry.weeklyIsExact)} of weekly` : null,
    entry.agents > 0 ? `${entry.agents} ${entry.agents === 1 ? 'agent' : 'agents'}` : null,
    entry.pauses > 0 ? `paused ${entry.pauses}×` : null,
  ].filter(Boolean)
  return (
    <Box key={entry.id} flexDirection="column">
      <Box flexDirection="row" columnGap="md">
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" color={entry.prompt ? undefined : 'subtle'}>{titleOf(entry)}</Text>
        </Box>
        <Text size="footnote" color="subtle">
          {ago(entry.startedAt + entry.activeMs, now)}
        </Text>
      </Box>
      <Text size="footnote" tabular color="subtle" wrap={columns < 50 ? 'truncate-end' : undefined}>
        {parts.join(' · ')}
      </Text>
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
  pause: '#e0a32f',
  stop: '#e0524f',
}
const GLYPH_COLORS: Record<IconName, 'suggestion' | 'merged' | 'planMode' | 'claude' | 'success' | 'subtle' | 'warning' | 'error'> = {
  clock: 'suggestion',
  tokens: 'merged',
  session: 'planMode',
  weekly: 'claude',
  shield: 'success',
  shieldOff: 'subtle',
  pause: 'warning',
  stop: 'error',
}

/** The band's gauges in reading order, each with the pane's icon for it. */
const BAND_GAUGES: Gauge[] = ['minutes', 'tokens', 'share', 'weeklyShare']
const BAND_ICONS: Record<Gauge, IconName> = { minutes: 'clock', tokens: 'tokens', share: 'session', weeklyShare: 'weekly' }
const GAUGE_NAMES: Record<Gauge, string> = { minutes: 'Time', tokens: 'Tokens', share: 'Session', weeklyShare: 'Weekly' }
const BAR_CELLS = 10
const BAR_PX = 64
const BAR_HEIGHT = 4
const ACCENT_HEX = '#4f8fe0'
/** How much closer another limit must be before it takes the bar. */
const LEAD_MARGIN = 0.05
const TRACK = 'rgba(139, 145, 156, 0.25)'
/** Darker than the bar's track: a 1px line at the track's alpha disappears on a dark backdrop. */
const DIVIDER = 'rgba(139, 145, 156, 0.45)'
const DIVIDER_HEIGHT = 12
const WARNING_HEX = '#e0a32f'
const ERROR_HEX = '#e0524f'

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
