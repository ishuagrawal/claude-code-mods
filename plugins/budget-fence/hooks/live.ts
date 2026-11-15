import type { ClientElements, ClientModule, RenderElement } from 'claude-code'

/**
 * One figure of the prompt: what it measures, how much is used, its limit ('' for
 * none) and the number's color. How full its limit is shows as a ring the pane
 * draws around the figure's icon.
 */
export type PromptStat = { name: string; used: string; limit: string; color: string | null }

/**
 * One live block of the pane's prompt section, as the hooks module works it out.
 * `at` is when: a block keeps whichever view is newest, so a repaint of the pane
 * that hands it an older drawing's view never sets its numbers back. `load` names
 * the hooks module's load, so views of two sessions are never compared.
 */
export type PromptView = {
  /**
   * `head`: the heading, status, prompt, pause note and subagents. `figure`: one
   * figure's number, under the icon and name the pane draws for it and beside its
   * ring (images a block cannot draw).
   */
  part: PromptPart
  /** The figure a `figure` block shows; '' for the head. */
  figure: string
  load: string
  at: number
  heading: string
  status: string
  statusColor: string
  prompt: string
  note: string
  stats: PromptStat[]
  loops: string
}

export type PromptPart = 'head' | 'figure'

/** What is drawn, without the timestamp used to order replies. */
export function promptContent(view: PromptView): string {
  return JSON.stringify([
    view.part, view.figure, view.load, view.heading, view.status, view.statusColor, view.prompt, view.note, view.loops,
    view.stats.map(s => [s.name, s.used, s.limit, s.color]),
  ])
}

/** How often a block asks for its latest view. */
const TICK_MS = 1000

/** One block, drawn here and, on surfaces without `Client`, by the hooks module. */
export function drawPrompt({ Box, Text }: Pick<ClientElements, 'Box' | 'Text'>, view: PromptView): RenderElement {
  const color = (c: string | null) => (c ? { color: c as never } : {})
  if (view.part === 'head') {
    return Box({
      flexDirection: 'column',
      rowGap: 'sm',
      children: [
        Box({
          key: 'heading',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          columnGap: 'md',
          children: [
            Text({ size: 'footnote', weight: 'medium', color: 'subtle', children: view.heading }),
            Text({ size: 'footnote', weight: 'medium', ...color(view.statusColor), children: view.status }),
          ],
        }),
        view.prompt ? Text({ wrap: 'truncate-end', color: 'subtle', children: view.prompt }) : null,
        view.note ? Text({ size: 'footnote', color: 'error', children: view.note }) : null,
        view.loops ? Text({ size: 'footnote', color: 'subtle', wrap: 'truncate-end', children: view.loops }) : null,
      ],
    })
  }
  // A figure's number, as wide as it draws, so the ring the pane draws beside it follows it.
  const s = view.stats[0]
  return Box({
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 'xs',
    children: [
      s
        ? Text({
            weight: 'medium',
            tabular: true,
            wrap: 'truncate-end',
            children: [
              Text({ ...color(s.color), children: s.used }),
              s.limit ? Text({ color: 'subtle', children: ` / ${s.limit}` }) : null,
            ],
          })
        : null,
    ],
  })
}

/**
 * The newest view seen, per load of the hooks module and block. Kept at module level, not
 * in the instance: the desktop may build a block afresh when it repaints the
 * pane, handing it that drawing's older view, and a new instance has no state.
 */
const newest = new Map<string, PromptView>()

/**
 * A block that refreshes itself: it asks for its view as soon as it appears and
 * then every tick, and the hooks module answers with new props when what it shows
 * has changed. The pane around it, with its dropdowns and buttons, is not drawn
 * again for the numbers, and whatever view arrives, the newest one seen is shown.
 */
const LivePrompt: ClientModule<PromptView, true> = (props, surface) => {
  const id = `${props.load}:${props.part}:${props.figure}`
  const seen = newest.get(id)
  const view = seen !== undefined && seen.at > props.at ? seen : props
  newest.set(id, view)
  if (surface.state === undefined) {
    surface.setState(true)
    const post = () => {
      const shown = newest.get(id) ?? view
      surface.post(promptContent(shown))
    }
    post()
    surface.every(TICK_MS, post)
  }
  return drawPrompt(surface.elements, view)
}

export default LivePrompt
