import type { ClientModule } from 'claude-code'

/**
 * One figure in the pane that changes while a prompt runs: its text and look,
 * worked out by the hooks module. Empty text draws nothing.
 */
export type LiveText = {
  text: string
  color: string | null
  isFootnote: boolean
  isMedium: boolean
  isTabular: boolean
  isTruncated: boolean
}

/** How often a figure asks for its latest value. */
const TICK_MS = 1000

/**
 * A figure that refreshes itself: each tick it posts to the hooks module, whose
 * answer hands it new props. The pane around it is not drawn again, so its
 * dropdowns and buttons stay put while the numbers move.
 */
const Live: ClientModule<LiveText, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState(true)
    surface.every(TICK_MS, () => surface.post(null))
  }
  const { Box, Text } = surface.elements
  if (!props.text) return Box({})
  return Text({
    ...(props.color ? { color: props.color as never } : {}),
    ...(props.isFootnote ? { size: 'footnote' } : {}),
    ...(props.isMedium ? { weight: 'medium' } : {}),
    ...(props.isTabular ? { tabular: true } : {}),
    ...(props.isTruncated ? { wrap: 'truncate-end' } : {}),
    children: props.text,
  })
}

export default Live
