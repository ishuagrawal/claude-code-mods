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
  withDenied,
  historyEntryOf,
  isAgentArgs,
  newAgentRun,
  parseAgentArgs,
  unitsOf,
  withOther,
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

test('a run the fence stopped is still marked stopped once it finishes', () => {
  let run = newAgentRun('bg1', 'Long test', null, 0, [])
  run = withLoopDone(withDenied(run, 1000), 'bg1', 2000)
  expect(run.status).toBe('done')
  expect(historyEntryOf(run).wasStopped).toBe(true)
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
  // The prompt is the pane's own row, under the heading, led by the prompt icon as in the history.
  expect((await ui.find({ type: 'Text', text: 'redesign the fence pane' }))?.text).toBe('redesign the fence pane')
  expect(await ui.find({ type: 'Text', text: 'redesign the fence pane', in: 'live-head' })).toBe(undefined)
  expect((await ui.findAll({ type: 'Svg' })).map(x => x.props.alt)).toContain('Prompt')
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

test('a question left with no choice stops the call without quoting the app’s placeholder', async ($, on) => {
  const { result } = await trippedPrompt($, on, ['[No preference]'])
  expect(result.decision).toBe('deny')
  expect(result.reason).toContain('chose to stop here')
  expect(result.reason).not.toContain('No preference')
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

test('a background agent counts its own steps, and each run takes its own part of the windows', () => {
  let main = newRun('t1', 0, [{ kind: 'five_hour', percentUsed: 10 }])
  let agent = newAgentRun('bg1', 'Audit deps', null, 0, [{ kind: 'five_hour', percentUsed: 10 }])
  main = withOther(withStep(main, MAIN, 'claude-opus-5-5', usage(1000, 100)), unitsOf('claude-opus-5-5', usage(3000, 300)))
  agent = withStep(withOther(agent, unitsOf('claude-opus-5-5', usage(1000, 100))), 'bg1', 'claude-opus-5-5', usage(3000, 300))
  main = withReading(main, [{ kind: 'five_hour', percentUsed: 18 }])
  agent = withReading(agent, [{ kind: 'five_hour', percentUsed: 18 }])
  // Eight points moved; the agent did three quarters of the work.
  expect(shareOf(main, 'five').value).toBe(2)
  expect(shareOf(agent, 'five').value).toBe(6)
  expect(agent.tokens).toBe(3300)
  expect(tripOf(agent, { ...DEFAULT_LIMITS, share: 5 }, 0)?.reason).toBe('This agent has used ~6.0% of your session limit')
  // A reading shared with this much other work teaches no rate.
  expect(withCalibrated({}, { ...agent, status: 'done' })).toEqual(withCalibrated({}, { ...agent, status: 'done', modelUnits: {} }))
})

test('/fence background sets the limits each background agent starts with', () => {
  expect(isAgentArgs('agents 10m')).toBe(true)
  expect(isAgentArgs('time 10m')).toBe(false)
  expect(parseAgentArgs('background tokens 200k time 10m', DEFAULTS)).toEqual({
    limits: { ...DEFAULTS, tokens: 200_000, minutes: 10 },
    said: 'Each new background agent pauses at 10m of work, 200k tokens.',
  })
  expect('error' in parseAgentArgs('background off', DEFAULTS)).toBe(true)
  expect(parseAgentArgs('bg session off', { ...DEFAULTS, share: 5 })).toEqual({ limits: DEFAULTS, said: 'Background agents have no limits.' })
})

test('a background agent is fenced on its own, asks by name, and raising it changes only its limit', async ($, on) => {
  let t = 0
  const asked: string[] = []
  const saved: string[] = []
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: key === 'limits' ? { isOn: true, minutes: 30 } : key === 'agent-limits' ? { isOn: true, minutes: 1 } : undefined }
  })
  on('store.set', (_, e) => {
    saved.push((e as { key: string }).key)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'bg1' }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
    asked.push(q.question)
    return { result: { questions: [q], answers: { [q.question]: 'Continue and raise the time limit to 3 min' } } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  t = 30_000
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'audit', description: 'Audit deps', subagentType: 'general-purpose', background: true, fork: false } as never)
  t = 150_000

  // The prompt is well under its 30m; the agent, measured from its spawn, is past its own 1m.
  expect((await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u0', approver: 'person' } as never)).decision).toBe('allow')
  expect(asked).toEqual([])
  const result = await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', agentId: 'bg1' } as never)
  expect(asked).toEqual(['Background agent “Audit deps” has used 2m, past its time limit of 1 min. Keep working?'])
  expect(result.decision).toBe('allow')
  // Its own limit changed: not this session's, not the background defaults.
  expect(saved.filter(k => k === 'limits' || k === 'agent-limits')).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'BACKGROUND AGENTS' }))?.text).toBe('BACKGROUND AGENTS')
  // Collapsed by default, with how many are running beside its Show.
  expect(await ui.find({ type: 'Text', text: 'Audit deps' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: '1 running' }))?.text).toBe('1 running')
  await ui.press({ key: 'agents-toggle' })
  expect((await ui.find({ type: 'Text', text: 'Audit deps' }))?.text).toBe('Audit deps')
  expect((await ui.find({ type: 'Text', text: /\/ 3m$/, in: 'live-a-bg1' }))?.text).toBe('2m / 3m')
  // The background agents sit under the prompt's own limits, each with its limits on one line.
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(texts.indexOf('PAUSE EACH PROMPT AFTER')).toBeLessThan(texts.indexOf('BACKGROUND AGENTS'))
  expect(texts).toContain('Default limits for new agents')
  expect(texts).toContain('1 min')
  // The defaults read as settings, not an agent: under a settings icon, with no border of their own.
  expect((await ui.findAll({ type: 'Box' })).some(x => x.props.borderStyle !== undefined)).toBe(false)
  expect((await ui.findAll({ type: 'Svg' })).map(x => x.props.alt)).toContain('Settings')
  expect((await ui.find({ type: 'Button', key: 'agent-limits-bg1' }))?.props.label).toBe('Edit limits')
  expect((await ui.find({ type: 'Select', key: 'limit-minutes' }))?.props.value).toBe('30')
  // The new-agent limits open as the section's last card.
  expect(await ui.find({ type: 'Select', key: 'limit-bg-minutes' })).toBe(undefined)
  await ui.press({ key: 'agent-limits-new-agents' })
  expect((await ui.find({ type: 'Select', key: 'limit-bg-minutes' }))?.props.value).toBe('1')
  await ui.press({ key: 'agent-limits-bg1' })
  expect((await ui.find({ type: 'Select', key: 'limit-a-bg1-minutes' }))?.props.value).toBe('3')
  await ui.select({ key: 'limit-a-bg1-minutes', value: '30' })
  expect((await ui.find({ type: 'Select', key: 'limit-a-bg1-minutes' }))?.props.value).toBe('30')
  // Opening one card closes the other.
  expect(await ui.find({ type: 'Select', key: 'limit-bg-minutes' })).toBe(undefined)
  await ui.press({ key: 'agent-limits-bg1' })
  // An agent's row carries no label of where its limits came from.
  const labels = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(labels).not.toContain('Custom limits')
  expect(labels).not.toContain('Default limits')
  expect(await ui.find({ type: 'Button', key: 'agent-reset-bg1' })).toBe(undefined)
  await ui.unmount()

  // Once the prompt is done, the band follows the agent still going, by name.
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 0, isAborted: false })
  const band = await $.ui.mount({
    plugin: 'budget-fence',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'terminal',
    props: { hasSurvey: false, isCollapsed: false, bodyColumns: 100, maxRows: 4 },
  } as never)
  expect((await band.find({ type: 'Text', text: /\/ 30m$/ }))?.text).toBe('2m / 30m')
  expect((await band.find({ type: 'Text', text: 'Audit deps' }))?.text).toBe('Audit deps')
  await band.unmount()

  // Finished, it stays in the pane until the next prompt, then lives on in the history alone,
  // marked with the agent icon.
  await $.turn.complete({ turnId: 't1', agentId: 'bg1', reason: 'answer', answer: '', durationMs: 0, isAgent: true } as never)
  const afterDone = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await afterDone.find({ type: 'Text', text: 'Audit deps' }))?.text).toBe('Audit deps')
  await afterDone.unmount()
  await $.turn.start({ text: 'next', turnId: 't2' })
  const nextTurn = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await nextTurn.find({ type: 'Button', key: 'agent-limits-bg1' })).toBe(undefined)
  expect(await nextTurn.find({ type: 'Client', key: 'live-a-bg1' })).toBe(undefined)
  await nextTurn.press({ key: 'recent-toggle' })
  const svgs = (await nextTurn.findAll({ type: 'Svg' })).map(x => x.props.alt)
  expect(svgs).toContain('Background agent')
  // Prompts lead with an icon of their own, so every row lines up the same way.
  expect(svgs).toContain('Prompt')
  await nextTurn.unmount()
  // A turn the agent's report starts is titled by the agent, not by the report's markup.
  await $.turn.start({ text: '<agent-message from="bg1">\nDone.\n</agent-message>', turnId: 't3' })
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)
  const reported = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await reported.find({ type: 'Text', text: 'Report from “Audit deps”' }))?.text).toBe('Report from “Audit deps”')
  await reported.unmount()
})

test('each session keeps its own limits: a reload does not take what another session saved', async ($, on) => {
  let stored: unknown = { isOn: true, minutes: 10 }
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? stored : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const minutes = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const value = (await ui.find({ type: 'Select', key: 'limit-minutes' }))?.props.value
    expect(await ui.find({ type: 'Text', text: /^This session/ })).toBe(undefined)
    await ui.unmount()
    return value
  }
  expect(await minutes()).toBe('10')
  // New agents start with no limits until some are set, whatever the prompts' limits are.
  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await fresh.press({ key: 'agents-toggle' })
  expect((await fresh.find({ type: 'Text', text: 'No limits' }))?.text).toBe('No limits')
  expect((await fresh.find({ type: 'Text', text: 'Each background agent pauses at its own limits.' }))?.text).toBeDefined()
  await fresh.unmount()
  // Another session saves its own; this one, reloaded, keeps its 10 minutes.
  stored = { isOn: true, minutes: 60 }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await minutes()).toBe('10')
})

test('Done closes an agent’s limits even while the desktop still reports focus on its dropdown', async ($, on) => {
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', () => ({ changed: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'bg1' }) as never)
  on('ui.focus', { plugin: '*' }, () => ({}) as never)
  // A held drawing waits on the clock; hold it for good, so a stuck press shows as a stuck test.
  on('clock.sleep', () => new Promise(() => undefined) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'audit', description: 'Audit deps', subagentType: 'general-purpose', background: true, fork: false } as never)
  const focus = (element: string) =>
    $.ui.focus({ requestId: 'budget-fence', key: element, component: 'Pane', plugin: 'budget-fence', element, origin: { kind: 'person' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, isFocused: true } })
  await ui.press({ key: 'agents-toggle' })
  await ui.press({ key: 'agent-limits-bg1' })
  await focus('limit-a-bg1-tokens')
  await ui.select({ key: 'limit-a-bg1-tokens', value: '100000' })
  // The menu closes, but the dropdown keeps the focus, and the desktop says so again.
  await focus('limit-a-bg1-tokens')
  // Done is pressed: the button takes no focus event of its own.
  await ui.press({ key: 'agent-limits-bg1' })
  expect(await ui.find({ type: 'Select', key: 'limit-a-bg1-tokens' })).toBe(undefined)
  expect((await ui.find({ type: 'Button', key: 'agent-limits-bg1' }))?.props.label).toBe('Edit limits')
  await ui.unmount()
})

test('a pane drawn before the module has its values back is drawn again once it does, with no click', async ($, on) => {
  const entry = {
    id: 'h1', prompt: 'an earlier prompt', reply: '', startedAt: 0, activeMs: 1000, tokens: 10,
    sessionPct: null, weeklyPct: null, sessionNowPct: null, weeklyNowPct: null, agents: 0, pauses: 0, wasStopped: false,
  }
  let history: unknown[] = []
  let held: Promise<void> = Promise.resolve()
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', async (_, e) => {
    if ((e as { key: string }).key !== 'history') return { value: undefined }
    await held
    return { value: history }
  })
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'first prompt', toolUses: [] }] }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'RECENT PROMPTS' })).toBe(undefined)

  // A reload: the session's limits and name are kept, so nothing the pane reads is written,
  // and the history comes back after the pane was drawn.
  let release!: () => void
  held = new Promise<void>(resolve => { release = resolve })
  history = [entry]
  const started = $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  release()
  await started
  expect((await ui.find({ type: 'Text', text: 'RECENT PROMPTS' }))?.text).toBe('RECENT PROMPTS')
  await ui.unmount()
})

test('two background agents started at once are both fenced and listed', async ($, on) => {
  let next = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'limits' ? { isOn: true } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: `bg${++next}` }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const spawn = (description: string) =>
    $.agent.spawn({ tool_use_id: description, prompt: 'p', description, subagentType: 'general-purpose', background: true, fork: false } as never)
  await Promise.all([spawn('Long test A'), spawn('Long test B')])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '2 running' }))?.text).toBe('2 running')
  await ui.press({ key: 'agents-toggle' })
  expect((await ui.find({ type: 'Text', text: 'Long test A' }))?.text).toBe('Long test A')
  expect((await ui.find({ type: 'Text', text: 'Long test B' }))?.text).toBe('Long test B')
  await ui.unmount()
})

test('with the prompt and agents going, the band gives each a row of its own, a few at most', async ($, on) => {
  let next = 0
  let t = 0
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: key === 'limits' ? { isOn: true, minutes: 10 } : key === 'agent-limits' ? { isOn: true, minutes: 1 } : undefined }
  })
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: `bg${++next}` }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const spawn = (description: string) =>
    $.agent.spawn({ tool_use_id: description, prompt: 'p', description, subagentType: 'general-purpose', background: true, fork: false } as never)
  await Promise.all([spawn('Long test A'), spawn('Long test B')])
  t = 30_000
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = async (maxRows: number) => {
      const ui = await $.ui.mount({
        plugin: 'budget-fence',
        component: 'AbovePrompt',
        requestId: 'band',
        surface,
        props: { hasSurvey: false, isCollapsed: false, bodyColumns: 100, maxRows },
      } as never)
      const rows = await Promise.all(['run-t1', 'run-bg1', 'run-bg2'].map(async key => (await ui.find({ type: 'Box', key })) !== undefined))
      const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
      const more = (await ui.find({ type: 'Text', text: /more running/ }))?.text
      const details = (await ui.findAll({ type: 'Button' })).filter(x => x.key === 'details').length
      await ui.unmount()
      return { rows, texts, more, details }
    }
    // Room for all: the prompt's row, then each agent's, each against its own limit, with one ⋯.
    const all = await band(8)
    expect(all.rows).toEqual([true, true, true])
    expect(all.texts).toContain('30s / 10m')
    expect(all.texts.filter(x => x === '30s / 1m').length).toBe(2)
    expect(all.texts).toContain('Long test A')
    expect(all.texts).toContain('Long test B')
    expect(all.more).toBe(undefined)
    expect(all.details).toBe(1)
    // Little room: the prompt's row, and the rest counted on a row of their own.
    const tight = await band(3)
    expect(tight.rows).toEqual([true, false, false])
    expect(tight.texts).toContain('30s / 10m')
    expect(tight.more).toBe('2 more running · ⋯ shows all')
  }
})

test('a background agent the person stopped reports back without being asked again, and does nothing more', async ($, on) => {
  let t = 0
  const asked: string[] = []
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: key === 'limits' ? { isOn: true } : key === 'agent-limits' ? { isOn: true, minutes: 1 } : undefined }
  })
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: t }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'bg1' }) as never)
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'SubagentHandback' }, () => ({ decision: 'allow' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!
    asked.push(q.question)
    return { result: { questions: [q], answers: { [q.question]: 'Stop here' } } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'Long test', subagentType: 'general-purpose', background: true, fork: false } as never)
  t = 70_000
  const check = (tool: string, id: string) => $.tool.check({ tool, input: {}, tool_use_id: id, agentId: 'bg1' } as never)
  expect((await check('Bash', 'u1')).decision).toBe('deny')
  expect(asked.length).toBe(1)
  // Its report goes back with no second question; more work is refused, still without one.
  expect((await check('SubagentHandback', 'u2')).decision).toBe('allow')
  const more = await check('Bash', 'u3')
  expect(more.decision).toBe('deny')
  expect(more.reason).toContain('stopped this here')
  expect(asked.length).toBe(1)
})

test('every /fence opens the pane, with or without settings after it', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'fence' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('ui.open', (_, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const args of ['', 'on', 'tokens 500k', 'background time 10m', 'bananas']) await $.command.run({ command: 'fence', args } as never)
  expect(opened).toEqual(['budget-fence', 'budget-fence', 'budget-fence', 'budget-fence', 'budget-fence'])
})
