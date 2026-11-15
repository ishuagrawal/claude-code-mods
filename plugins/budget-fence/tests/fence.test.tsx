import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  DEFAULT_LIMITS as DEFAULTS,
  MAIN,
  loopShare,
  meterOf,
  newRun,
  describe,
  parseArgs,
  pct,
  usedOf,
  withLimitChanged,
  parseLimitInput,
  limitLabel,
  ratesOf,
  shareOf,
  shareText,
  withCalibrated,
  tripOf,
  withAllowed,
  withLoop,
  withLoopDone,
  withPaused,
  withReading,
  withStep,
} from '../hooks/fence'

const DEFAULT_LIMITS = { ...DEFAULTS, isOn: true, share: 10, weeklyShare: 2 }

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

test('a prompt measures the 5-hour window from where it started', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-15T15:40:00Z' }])
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 43.5, resetsAt: '2026-11-15T15:40:00Z' }])
  expect(usedOf(run.five)).toBe(3.5)
  expect(pct(usedOf(run.five))).toBe('3.5%')
})

test('a window that resets mid-prompt keeps what was spent before it', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 95, resetsAt: 'A' }])
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 98, resetsAt: 'A' }])
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 2, resetsAt: 'B' }])
  expect(usedOf(run.five)).toBe(5)
})

test('the share splits between loops by the weight of their requests', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 10 }])
  run = withLoop(run, { id: 'a1', label: 'Explore', toolUseId: 'tu1', units: 0, steps: 0, isRunning: true, isBackground: false })
  run = withStep(run, MAIN, 'claude-opus-5-5', usage(1000, 100))
  run = withStep(run, 'a1', 'claude-opus-5-5', usage(1000, 100))
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 14 }])
  expect(loopShare(run, MAIN)).toBe(2)
  expect(loopShare(run, 'a1')).toBe(2)
})

test('the fence trips at the per-prompt share, and an Allow gives half again', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 20 }])
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 30 }])
  const trip = tripOf(run, DEFAULT_LIMITS, 0)
  expect(trip?.kind).toBe('share')
  run = withAllowed(withPaused(run, trip!, 'tu9', 0), DEFAULT_LIMITS, trip!, 1000)
  expect(tripOf(run, DEFAULT_LIMITS, 1000)).toBe(null)
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 35 }])
  expect(tripOf(run, DEFAULT_LIMITS, 1000)?.kind).toBe('share')
})

test('the working line names the closest limit, amber past 80%', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 50 }])
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 53.4 }])
  expect(meterOf(run, DEFAULT_LIMITS, 0)?.text).toBe('3.4% session of 10% session')
  expect(meterOf(run, DEFAULT_LIMITS, 0)?.isWarning).toBe(false)
  run = withReading(run, [{ kind: 'five_hour', percentUsed: 58.6 }])
  expect(meterOf(run, DEFAULT_LIMITS, 0)?.text).toBe('8.6% session of 10% session')
})

test('a run ends when every loop it started has ended', async () => {
  let run = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 0 }])
  run = withLoop(run, { id: 'a1', label: 'Build', toolUseId: null, units: 0, steps: 0, isRunning: true, isBackground: true })
  run = withLoopDone(run, MAIN, 5)
  expect(run.status).toBe('running')
  run = withLoopDone(run, 'a1', 9)
  expect(run.status).toBe('done')
  expect(run.endedAt).toBe(9)
})

test('/fence arguments set the limits', async () => {
  const parsed = parseArgs('15% 20m', DEFAULT_LIMITS)
  expect('limits' in parsed && parsed.limits).toEqual({ isOn: true, share: 15, weeklyShare: 2, minutes: 20, tokens: 0 })
  expect('error' in parseArgs('window 85', DEFAULT_LIMITS)).toBe(true)
  expect('error' in parseArgs('bananas', DEFAULT_LIMITS)).toBe(true)
})

test('/fence says when the session limit cannot apply to the plan', async () => {
  const sessionOnly = { ...DEFAULT_LIMITS, weeklyShare: 0 }
  expect(describe(sessionOnly)).toBe('Each prompt pauses at 10% of the session limit.')
  expect(describe(sessionOnly, false)).toBe(
    'Budget fence is on, but no limit is set that applies to your plan. Your plan has no session limit, so the 10% session limit does nothing; /fence session off clears it.',
  )
  expect(describe(DEFAULT_LIMITS, false)).toContain('Each prompt pauses at 2.0% of the weekly limit.')
  const parsed = parseArgs('session off', sessionOnly, false)
  expect('said' in parsed && parsed.said).toBe('Budget fence is on, but no limit is set that applies to your plan.')
})

const PANE = {
  plugin: 'budget-fence',
  component: 'Pane',
  requestId: 'budget-fence',
  props: {
    title: 'Budget fence',
    isFocused: false,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('before any prompt the pane shows the limits to set', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Select', key: 'limit-minutes' }))?.props.value).toBe('0')
    expect((await ui.find({ type: 'Select', key: 'limit-share' }))?.props.value).toBe('0')
    expect(await ui.find({ type: 'Select', key: 'limit-window' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: 'ALSO PAUSE WHEN' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: 'Running' })).toBe(undefined)
    expect(await ui.findAll({ type: 'Client' })).toEqual([])
    await ui.unmount()
  }
})

test('a plan with only a weekly window is measured against it, with its own share', async () => {
  let run = newRun('t1', 0, [{ kind: 'seven_day', percentUsed: 85, resetsAt: '2026-11-16T16:00:00.000Z' }])
  expect(run.five).toBe(null)
  run = withReading(run, [{ kind: 'seven_day', percentUsed: 86.2 }])
  const shareOnly = DEFAULT_LIMITS
  expect(meterOf(run, shareOnly, 0)?.text).toBe('1.2% weekly of 2.0% weekly')
  run = withReading(run, [{ kind: 'seven_day', percentUsed: 87.1 }])
  expect(tripOf(run, shareOnly, 0)?.reason).toBe('This prompt has used 2.1% of your weekly limit')
})

test('the band shows a gauge per limit while a prompt runs', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: { isOn: true, share: 10 } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({
    plugin: 'budget-fence',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, bodyColumns: 80, maxRows: 4 },
  } as never)
  expect((await ui.find({ type: 'Text', text: /\/ 10/ }))?.text).toBe('<1% / 10%')
  expect((await ui.find({ type: 'Button', key: 'details' }))?.props.label).toBe('⋯')
  // The limit's full-size icon, then the lead's bar: Box sizes are cells, so the bar is an Svg.
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.map(x => [x.props.width, x.props.height])).toEqual([[16, 16], [40, 4]])
  expect((await ui.findAll({ type: 'Box' })).every(x => x.props.width === undefined && x.props.height === undefined)).toBe(true)
  await ui.unmount()
})

test('time and token limits trip on their own, and a changed limit drops earlier room', async () => {
  const limits = { ...DEFAULT_LIMITS, minutes: 10, tokens: 100_000 }
  let run = newRun('t1', 0, [])
  run = withStep(run, MAIN, 'claude-opus-5-5', usage(90_000, 5_000))
  expect(tripOf(run, limits, 60_000)).toBe(null)
  run = withStep(run, MAIN, 'claude-opus-5-5', usage(4_000, 2_000))
  const trip = tripOf(run, limits, 60_000)
  expect(trip?.kind).toBe('tokens')
  run = withAllowed(withPaused(run, trip!, 'tu1', 60_000), limits, trip!, 60_000)
  expect(run.bonus.tokens).toBe(51_000)
  expect(tripOf(run, limits, 60_000)).toBe(null)
  expect(tripOf(run, limits, 11 * 60_000)?.kind).toBe('minutes')
  expect(withLimitChanged(run, 'tokens').bonus.tokens).toBe(0)
  expect(parseArgs('tokens 250k time 30m session off', DEFAULT_LIMITS)).toEqual({
    limits: { ...DEFAULT_LIMITS, tokens: 250_000, minutes: 30, share: 0 },
    said: 'Each prompt pauses at 30m of work, 250k tokens, 2.0% of the weekly limit.',
  })
})

test('a weekly-only plan hides the session limit, and a pick changes the limit', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 85 }] },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Select', key: 'limit-share' })).toBe(undefined)
  expect((await ui.find({ type: 'Select', key: 'limit-weeklyShare' }))?.props.value).toBe('0')
  await ui.select({ key: 'limit-minutes', value: '30' })
  expect((await ui.find({ type: 'Select', key: 'limit-minutes' }))?.props.value).toBe('30')
  await ui.unmount()
})

test('the fence starts off, keeps its limits while off, and turns on with them', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(DEFAULTS.isOn).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'Fence is off' }))?.text).toBe('Fence is off')
  await ui.select({ key: 'limit-tokens', value: '500000' })
  await ui.press({ key: 'toggle' })
  expect((await ui.find({ type: 'Text', text: 'Fence is on' }))?.text).toBe('Fence is on')
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'toggle' })
  expect((await ui.find({ type: 'Select', key: 'limit-tokens' }))?.props.value).toBe('500000')
  await ui.unmount()
  expect(parseArgs('off', { ...DEFAULTS, tokens: 500_000 })).toEqual({
    limits: { ...DEFAULTS, tokens: 500_000 },
    said: 'Budget fence is off. Your limits are kept for when you turn it on.',
  })
})

test('a finished prompt shows its spend, the plan bars, icons, and lands in the history', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 40 },
        { kind: 'seven_day', percentUsed: 85 },
      ],
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: (e as { turnId: string }).turnId === 't2' ? 'Fixed the flaky login test.\nDetails follow.' : 'done' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'redesign the fence pane\nmore detail', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', text: 'done', isAborted: false, reason: 'answer', answer: 'done' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'LAST PROMPT', in: 'live-head' }))?.text).toBe('LAST PROMPT')
  expect(await ui.find({ type: 'Text', text: 'YOUR PLAN' })).toBe(undefined)
  expect((await ui.find({ type: 'Svg' }))?.props.width).toBe(16)
  expect((await ui.find({ type: 'Text', text: 'redesign the fence pane', in: 'live-head' }))?.text).toBe('redesign the fence pane')
  // Each figure keeps its icon, drawn by the pane, over a column of the same width as its number's.
  const svgs = (await ui.findAll({ type: 'Svg' })).map(x => x.props.alt as string)
  expect(['Time', 'Tokens', 'Session', 'Weekly'].every(name => svgs.includes(name))).toBe(true)
  // Each figure is its own column with a live block laid over it for the number and the fill.
  expect((await ui.findAll({ type: 'Client' })).map(x => x.key).sort()).toEqual(['live-Session', 'live-Time', 'live-Tokens', 'live-Weekly', 'live-head'])
  expect((await ui.find({ type: 'Text', text: /^0s$/, in: 'live-Time' }))?.text).toBe('0s')
  // A finished prompt with no limit in force has no ring.
  expect((await ui.findAll({ type: 'Svg' })).map(x => x.props.alt)).toContain('Time')
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: '#' }))?.text).toBe('#')
  await term.unmount()

  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', text: 'Fixed the flaky login test.', isAborted: false, reason: 'answer', answer: 'done' } as never)
  const hist = await $.ui.mount({ ...PANE, requestId: 'budget-fence-history', surface: 'desktop' })
  expect((await hist.find({ type: 'Text', text: /^Claude:/ }))?.text).toBe('Claude: Fixed the flaky login test.')
  // The totals read as labelled figures, and each row's details line never wraps.
  const texts = (await hist.findAll({ type: 'Text' })).map(x => x.text)
  expect(texts.slice(0, 6)).toEqual(['Prompts', '2', 'Time', '0s', 'Tokens', '0'])
  expect(texts).toContain('now')
  await hist.unmount()
})

test('each setting takes a custom value typed in its own field', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'limit-tokens', value: 'custom' })
  await ui.input({ key: 'custom-tokens', text: 'lots', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /^Didn't understand/ }))?.text).toContain('"lots"')
  await ui.input({ key: 'custom-tokens', text: '750k', kind: 'submit' })
  expect(await ui.find({ type: 'Input', key: 'custom-tokens' })).toBe(undefined)
  const tokensSelect = await ui.find({ type: 'Select', key: 'limit-tokens' })
  expect(tokensSelect?.props.value).toBe('750000')
  await ui.select({ key: 'limit-minutes', value: 'custom' })
  await ui.input({ key: 'custom-minutes', text: '1h 30m', kind: 'submit' })
  expect((await ui.find({ type: 'Select', key: 'limit-minutes' }))?.props.value).toBe('90')
  await ui.unmount()

  expect(parseLimitInput('minutes', '1.5h')).toBe(90)
  expect(parseLimitInput('minutes', '45 min')).toBe(45)
  expect(parseLimitInput('tokens', '1.5M')).toBe(1_500_000)
  expect(parseLimitInput('share', '7.5%')).toBe(7.5)
  expect(parseLimitInput('share', '150')).toBe(null)
  expect(limitLabel('minutes', 90)).toBe('1h 30m')
})

const tok = (input: number) => ({ input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

/** A finished prompt one model did alone, moving the weekly window from one reading to another. */
function solo(model: string, units: number, from: number, to: number) {
  return withReading(withStep(newRun('p', 0, [{ kind: 'seven_day', percentUsed: from }]), MAIN, model, tok(units)), [{ kind: 'seven_day', percentUsed: to }])
}

test('each model learns its own rate, and a prompt on an untaught model stays rounded', async () => {
  // Opus: 30 units moved the weekly window 3 points, so 0.1 point per unit.
  let cal = withCalibrated({}, solo('claude-opus-5-5', 30, 10, 13))
  // A dated id and a [1m] tag are the same model.
  expect(Object.keys(cal)).toEqual(['claude-opus-5-5'])
  expect(ratesOf(withCalibrated({}, solo('claude-opus-5-5-20261101[1m]', 30, 10, 13)))['claude-opus-5-5']?.week).toBe(0.1)
  expect(ratesOf(cal)['claude-opus-5-5']?.week).toBe(0.1)

  // An Opus prompt of 3 units that moved the reading 20 → 21 is about 0.3%, not 1%.
  let run = newRun('t', 0, [{ kind: 'seven_day', percentUsed: 20 }], 'go', ratesOf(cal))
  run = withReading(withStep(run, MAIN, 'claude-opus-5-5', tok(3)), [{ kind: 'seven_day', percentUsed: 21 }])
  expect(shareText(shareOf(run, 'week'))).toBe('~0.30%'.replace('0.30', '0.3'))

  // The same work on Haiku has no rate yet: the reading stands, marked approximate.
  let haiku = newRun('h', 0, [{ kind: 'seven_day', percentUsed: 20 }], 'go', ratesOf(cal))
  haiku = withReading(withStep(haiku, MAIN, 'claude-haiku-5-5', tok(3)), [{ kind: 'seven_day', percentUsed: 21 }])
  expect(shareOf(haiku, 'week').isEstimate).toBe(false)
  expect(shareText(shareOf(haiku, 'week'))).toBe('~1.0%')

  // A prompt that mixed models evenly teaches neither.
  let mixed = withStep(newRun('m', 0, [{ kind: 'seven_day', percentUsed: 30 }]), MAIN, 'claude-opus-5-5', tok(10))
  mixed = withReading(withStep(mixed, 'a1', 'claude-haiku-5-5', tok(10)), [{ kind: 'seven_day', percentUsed: 35 }])
  cal = withCalibrated(cal, mixed)
  expect(Object.keys(cal)).toEqual(['claude-opus-5-5'])

  // No "<" beside a sign: an unmoved rounded reading and a sliver both read as words or digits.
  expect(shareText(shareOf(newRun('z', 0, [{ kind: 'seven_day', percentUsed: 20 }]), 'week'))).toBe('<1%')
  expect(pct(0.04)).toBe('0.04%')
})

test('recent prompts start collapsed and open on a press', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) =>
    (e as { key: string }).key === 'history'
      ? { value: [{ id: 'h1', prompt: 'tidy the README', reply: '', startedAt: 0, activeMs: 60_000, tokens: 1200, sessionPct: null, weeklyPct: 0.3, sessionNowPct: null, weeklyNowPct: 85, agents: 0, pauses: 0, wasStopped: false }] }
      : { value: undefined },
  )
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 120_000 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'RECENT PROMPTS' }))?.text).toBe('RECENT PROMPTS')
  expect((await ui.find({ type: 'Button', key: 'recent-toggle' }))?.text).toBe('Show')
  expect((await ui.find({ type: 'Button', key: 'history' }))?.text).toBe('View all')
  expect(await ui.find({ type: 'Text', text: 'tidy the README' })).toBe(undefined)
  await ui.press({ key: 'recent-toggle' })
  expect((await ui.find({ type: 'Text', text: 'tidy the README' }))?.text).toBe('tidy the README')
  // Its figures each carry their own colored icon, the weekly share included even under 1%.
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(['1m', '1k'].every(v => texts.includes(v))).toBe(true)
  expect(texts.some(v => /^~?0\.3%$/.test(v))).toBe(true)
  const alts = (await ui.findAll({ type: 'Svg' })).map(x => x.props.alt)
  expect(['Time', 'Tokens', 'Weekly'].every(a => alts.includes(a))).toBe(true)
  await ui.unmount()
})

/** A prompt running for 2 minutes against a 1-minute limit, its question answered by `answers` in turn. */
async function trippedPrompt(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  answers: string[],
  verdict: 'allow' | 'ask' = 'allow',
) {
  const asked: { question: string; options: string[] }[] = []
  const opened: string[] = []
  const saved: unknown[] = []
  let t = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, minutes: 1 } : undefined }))
  on('store.set', (_, e) => {
    if ((e as { key: string }).key === 'limits') saved.push((e as { value: unknown }).value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('ui.open', (_, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('tool.check', { tool: 'Bash' }, () => ({ decision: verdict }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
    asked.push({ question: q.question, options: q.options.map(o => o.label) })
    return { result: { questions: [q], answers: { [q.question]: answers.shift() ?? 'Stop here' } } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  t = 120_000
  const result = await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', approver: 'person' } as never)
  return { result, asked, opened, saved }
}

test('a tripped limit asks in the prompt box, and Continue raises that setting', async ($, on) => {
  const { result, asked, saved } = await trippedPrompt($, on, ['Continue and raise the time limit to 3 min'])
  expect(asked).toEqual([
    {
      question: 'This prompt has used 2m, past its time limit of 1 min. Keep working?',
      options: ['Continue with no limits', 'Continue and raise the time limit to 3 min', 'Stop here', 'Open Budget fence'],
    },
  ])
  expect(result.decision).toBe('allow')
  expect(saved).toEqual([{ isOn: true, minutes: 3, tokens: 0, share: 0, weeklyShare: 0 }])
})

test('Continue with no limits lets the rest of the prompt run without asking, and leaves the settings alone', async ($, on) => {
  const { result, asked, saved } = await trippedPrompt($, on, ['Continue with no limits'])
  expect(result.decision).toBe('allow')
  expect(saved).toEqual([])
  const later = await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u2', approver: 'person' } as never)
  expect(later.decision).toBe('allow')
  expect(asked.length).toBe(1)
})

test('a limit changed after going on unlimited fences the prompt again', () => {
  const run = { ...newRun('r', 0, []), isUnfenced: true }
  expect(withLimitChanged(run, 'minutes').isUnfenced).toBe(false)
})

test('continuing keeps the app’s own permission check for the call', async ($, on) => {
  const { result } = await trippedPrompt($, on, ['Continue and raise the time limit to 3 min'], 'ask')
  expect(result.decision).toBe('ask')
})

test('Open Budget fence opens the pane and asks again; Stop denies the call', async ($, on) => {
  const { result, asked, opened, saved } = await trippedPrompt($, on, ['Open Budget fence', 'Stop here'])
  expect(opened).toEqual(['budget-fence'])
  expect(asked.map(a => a.options)).toEqual([
    ['Continue with no limits', 'Continue and raise the time limit to 3 min', 'Stop here', 'Open Budget fence'],
    ['Continue with no limits', 'Continue with the limits as set', 'Continue and raise the time limit to 3 min', 'Stop here'],
  ])
  expect(result.decision).toBe('deny')
  expect(saved).toEqual([])
})

test('a value typed under Other sets the limit; other words go to Claude', async ($, on) => {
  const typed = await trippedPrompt($, on, ['1m', '10m'])
  expect(typed.asked[1]?.question).toBe('1 min is no more than it has used. This prompt has used 2m, past its time limit of 1 min. Keep working?')
  expect(typed.result.decision).toBe('allow')
  expect(typed.saved).toEqual([{ isOn: true, minutes: 10, tokens: 0, share: 0, weeklyShare: 0 }])
})

test('words typed under Other stop the call and reach Claude', async ($, on) => {
  const { result } = await trippedPrompt($, on, ['wrap up the tests first'])
  expect(result.decision).toBe('deny')
  expect(result.reason).toContain('saying: wrap up the tests first')
})

test('a finished prompt keeps its numbers when usage moves later', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', () => ({ changed: [] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 0, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const session = async () => (await ui.find({ type: 'Text', text: /%$/, in: 'live-Session' }))?.text
  const before = await session()
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 70 }], changed: ['rateLimits'] } as never)
  await ui.advance(1000)
  expect(await session()).toBe(before)
  expect(before).toBe('<1%')
  await ui.unmount()
})

test('every band state reads "used / limit", with an icon on each status, on both surfaces', async ($, on) => {
  let t = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, minutes: 10, tokens: 1_000_000 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!
    return { result: { questions: [q], answers: { [q.question]: 'Stop here' } } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const band = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({
      plugin: 'budget-fence',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, isCollapsed: false, bodyColumns: 80, maxRows: 4 },
    } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    const svgs = surface === 'desktop' ? (await ui.findAll({ type: 'Svg' })).map(x => x.props.alt as string) : []
    const fig = texts.find(x => / \/ /.test(x))
    const word = texts.find(x => x === 'Paused' || x === 'Stopped')
    const icons = svgs.filter(x => x && x !== 'Divider')
    const dividers = surface === 'desktop' ? svgs.filter(x => x === 'Divider').length : texts.filter(x => x === '│').length
    await ui.unmount()
    return { fig, word, icons, dividers }
  }

  t = 2 * 60_000
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await band(surface)).toEqual({
      fig: '2m / 10m',
      word: undefined,
      icons: surface === 'desktop' ? ['Time', '20% of the limit', 'Tokens'] : [],
      dividers: 1,
    })
  }
  t = 9 * 60_000
  expect((await band('desktop')).fig).toBe('9m / 10m')

  t = 11 * 60_000
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', approver: 'host' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await band(surface)).toEqual({
      fig: '11m / 10m',
      word: 'Paused',
      icons: surface === 'desktop' ? ['Paused', 'Time', '100% of the limit'] : [],
      dividers: 1,
    })
  }

  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u2', approver: 'person' } as never)
  const stopped = await band('desktop')
  expect([stopped.word, stopped.icons[0], stopped.fig]).toEqual(['Stopped', 'Stopped', '11m / 10m'])
})

test('the prompt section keeps updating while a dropdown has focus, without drawing the pane again', async ($, on) => {
  let draws = 0
  let isDrawing = false
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, share: 10 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  // The pane asks the time once per drawing; the test counts drawings by it.
  on('clock.now', () => {
    if (isDrawing) draws += 1
    return { value: 0 }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] },
  }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.focus', { plugin: '*' }, () => ({}) as never)
  // A ring stepping asks for a drawing, which waits on the clock while a dropdown is open.
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, isFocused: true } })
  // The session figure against its limit, as the prompt's section shows it.
  const hint = async () => (await ui.find({ type: 'Text', text: /^\S+ \/ 10%$/, in: 'live-Session' }))?.text
  const measure = (percentUsed: number) =>
    $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed }], changed: ['rateLimits'] } as never)
  expect(await hint()).toBe('<1% / 10%')

  // Only the figures' own ticks ask for the clock from here on; drawings are counted apart.
  const drawsOf = async (act: () => Promise<unknown>) => {
    isDrawing = true
    draws = 0
    await act()
    // A read waits for any drawing the act asked for.
    await ui.find({ type: 'Button', key: 'toggle' })
    isDrawing = false
    return draws
  }
  expect(await drawsOf(() => measure(42))).toBe(0)
  await ui.advance(1000)
  expect(await hint()).toBe('~2.0% / 10%')

  const focus = (element: string) =>
    $.ui.focus({ requestId: 'budget-fence', key: element, component: 'Pane', plugin: 'budget-fence', element, origin: { kind: 'person' } } as never)
  await focus('limit-share')
  expect(await drawsOf(() => measure(44))).toBe(0)
  await ui.advance(1000)
  expect(await hint()).toBe('~4.0% / 10%')
  // The session figure's ring around its icon has stepped to 40%, in the figure's own color.
  const ring = (await ui.findAll({ type: 'Svg' })).find(x => (x.props.alt as string).startsWith('Session,'))
  expect(ring?.props.alt).toBe('Session, 40% of the limit')
  expect(ring?.props.source as string).toContain('#2fa7a0')
  expect((await ui.find({ type: 'Select', key: 'limit-share' }))?.props.value).toBe('10')
  await ui.unmount()
})


test('a figure ring steps in tens: the pane is drawn again only when one crosses a step', async ($, on) => {
  let t = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, minutes: 10 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const ring = async () => (await ui.findAll({ type: 'Svg' })).map(x => x.props.alt as string).find(a => a.startsWith('Time,'))
  expect(await ring()).toBe('Time, 0% of the limit')
  // 50s of a 10m limit is still under the first step: no new drawing.
  t = 50_000
  await ui.advance(1000)
  expect(await ring()).toBe('Time, 0% of the limit')
  // 2m crosses into the 20% step: the pane is drawn again with the ring a fifth full.
  t = 120_000
  await ui.advance(1000)
  expect(await ring()).toBe('Time, 20% of the limit')
  await ui.unmount()
})

test('the prompt section never goes back to older numbers when the pane is drawn from an older view', async ($, on) => {
  let t = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, minutes: 10 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const time = async () => (await ui.find({ type: 'Text', text: /^\d.* \/ 10m$/, in: 'live-Time' }))?.text
  expect(await time()).toBe('0s / 10m')
  t = 65_000
  await ui.advance(1000)
  expect(await time()).toBe('1m 5s / 10m')
  // A drawing worked out earlier than the block's last answer, as a repaint of the pane hands it.
  t = 5_000
  await ui.redraw({ ...PANE.props, bodyColumns: 71 })
  expect(await time()).toBe('1m 5s / 10m')
  t = 70_000
  await ui.advance(1000)
  expect(await time()).toBe('1m 10s / 10m')
  await ui.unmount()
})

test('readings that land together leave the prompt section on the last one', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, share: 10 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] },
  }))
  on('session.measure', () => ({ changed: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const measure = (percentUsed: number) =>
    $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed }], changed: ['rateLimits'] } as never)
  await Promise.all([measure(42), measure(43), measure(44)])
  await ui.advance(1000)
  expect((await ui.find({ type: 'Text', text: /^\S+ \/ 10%$/, in: 'live-Session' }))?.text).toBe('~4.0% / 10%')
  await ui.unmount()
})

test('desktop focus redraws wait when the dropdown focus event comes later', async ($, on) => {
  let waits = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true, share: 10 } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.measure', () => ({ changed: [] }))
  // Hold both timers so the test can deliver events in the host's order.
  on('clock.sleep', () => {
    waits += 1
    return new Promise(() => undefined) as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('ui.focus', { plugin: '*' }, () => ({}) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const focus = (element: string) =>
    $.ui.focus({ requestId: 'budget-fence', key: element, component: 'Pane', plugin: 'budget-fence', element, origin: { kind: 'person' } } as never)
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: [] } as never)
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The host requests the pane redraw before telling the mod which control gained focus.
  let isDrawn = false
  const drawn = ui.redraw({ ...PANE.props, isFocused: true }).then(() => {
    isDrawn = true
  })
  await settle()
  expect(waits).toBe(1)
  expect(isDrawn).toBe(false)
  await focus('limit-share')
  await settle()
  expect(waits).toBe(2)
  expect(isDrawn).toBe(false)
  // The focus moving off the settings lets it draw.
  await focus('toggle')
  await drawn
  expect(isDrawn).toBe(true)

  // Again, and this time a pick closes the dropdown: the held drawing carries it.
  await ui.redraw({ ...PANE.props, isFocused: false })
  await focus('limit-tokens')
  isDrawn = false
  const picked = ui.redraw({ ...PANE.props, isFocused: true }).then(() => {
    isDrawn = true
  })
  await settle()
  expect(isDrawn).toBe(false)
  // The desktop asks again as the button comes up, the same props: it waits its turn too.
  let isRepeatDrawn = false
  const repeated = ui.redraw({ ...PANE.props, isFocused: true }).then(() => {
    isRepeatDrawn = true
  })
  await settle()
  expect([isDrawn, isRepeatDrawn]).toEqual([false, false])
  // The pick lands on the dropdown on screen, and both drawings follow it, in turn.
  await ui.select({ key: 'limit-tokens', value: '250000' })
  await Promise.all([picked, repeated])
  expect((await ui.find({ type: 'Select', key: 'limit-tokens' }))?.props.value).toBe('250000')

  // A host blur must release a pending render even before any focus event.
  await ui.redraw({ ...PANE.props, isFocused: false })
  const pending = ui.redraw({ ...PANE.props, isFocused: true })
  await settle()
  await Promise.all([pending, ui.redraw({ ...PANE.props, isFocused: false })])
  await ui.unmount()

  // The terminal draws its own focus ring: it never waits.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await focus('limit-share')
  await term.redraw({ ...PANE.props, isFocused: true })
  await term.unmount()
})
