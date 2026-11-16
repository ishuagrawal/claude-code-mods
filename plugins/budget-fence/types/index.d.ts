/** What the person sets in the pane or with /fence, per session. 0 turns a limit off. */
export type FenceLimits = {
  isOn: boolean
  /** Pause after this many minutes of work on one prompt. */
  minutes: number
  /** Pause once one prompt has used this many tokens (input, cache writes and output). */
  tokens: number
  /** Pause once one prompt has used this much of the 5-hour session limit (plans that have one). */
  share: number
  /** Pause once one prompt has used this much of the weekly limit. */
  weeklyShare: number
}

/** One loop a prompt runs: the main session or a subagent. */
export type FenceLoop = {
  id: string
  label: string
  toolUseId: string | null
  /** Token weight of its requests, used to split the prompt's share. */
  units: number
  steps: number
  isRunning: boolean
  isBackground: boolean
}

/** One usage window as this prompt has seen it. */
export type FenceMeasure = {
  startPct: number
  nowPct: number
  /** Share used before the window reset mid-prompt. */
  carriedPct: number
  resetsAt: string | null
}

/** Window percent per unit of token weight, for one model. */
export type FenceRate = { five: number | null; week: number | null }

/** Learned rates by model: a unit of Opus work and a unit of Haiku work cost the plan differently. */
export type FenceRates = Record<string, FenceRate>

/** Running totals for learning one model's rates: token weight spent against window points seen. */
export type FenceTally = { five: { units: number; pct: number }; week: { units: number; pct: number } }

export type FenceCalibration = Record<string, FenceTally>

export type FenceStatus = 'running' | 'paused' | 'denied' | 'done'

/** Room past a limit granted by each Allow, per limit. */
export type FenceBonus = { minutes: number; tokens: number; share: number; weeklyShare: number }

/** One prompt, measured from the moment it is sent until all it started ends. */
export type FenceRun = {
  id: string
  /** The prompt's text, trimmed to a line, for the history. */
  prompt: string
  startedAt: number
  endedAt: number | null
  pausedMs: number
  pauseStartedAt: number | null
  /** The 5-hour session window; null on plans without one. */
  five: FenceMeasure | null
  week: FenceMeasure | null
  tokens: number
  /**
   * Window percent per unit of request weight, learned from earlier prompts; null until
   * enough whole-point readings have been seen. Turns coarse readings into a finer estimate.
   */
  rates: FenceRates
  /** Token weight by model, without any guess at how models compare: what the rates are learned from. */
  modelUnits: Record<string, number>
  loops: FenceLoop[]
  bonus: FenceBonus
  status: FenceStatus
  reason: string | null
  pausedToolUseId: string | null
  pauses: number
  /** The person chose to go on with no limits: nothing trips for the rest of this prompt. */
  isUnfenced?: boolean
  /** The fence stopped one of its calls; kept once the run finishes and its status is `done`. */
  wasStopped?: boolean
  /** A background agent's own run, rather than a prompt's. */
  kind?: 'prompt' | 'agent'
  /**
   * Token weight spent by other work (a prompt, other background agents) while this run
   * went on: the usage windows move for all of it, so this run's share is its own part.
   */
  otherUnits?: number
}

/** A background agent, fenced on its own: its run and the limits it pauses at. */
export type FenceAgent = {
  run: FenceRun
  /** Its own limits; `isOn` is unused, the session's switch decides. */
  limits: FenceLimits
  /** Set in its own row, so a change to the background defaults leaves it alone. */
  isCustom: boolean
}

/** A finished prompt as the history keeps it. */
export type FenceHistoryEntry = {
  id: string
  prompt: string
  /** The first line of Claude's answer, for a prompt with no text of its own. */
  reply: string
  startedAt: number
  activeMs: number
  tokens: number
  /** How much of each window it used; null where the plan has no such window. */
  sessionPct: number | null
  weeklyPct: number | null
  /** Whether those shares are estimates or rounded readings (absent on entries from before, which were rounded). */
  sessionIsExact?: boolean
  weeklyIsExact?: boolean
  /** Where each window stood when it ended. */
  sessionNowPct: number | null
  weeklyNowPct: number | null
  agents: number
  pauses: number
  wasStopped: boolean
  /** A background agent's run rather than a prompt's (absent on prompts). */
  isAgent?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'budget-fence': {
      limits: Shaped<FenceLimits>
      run: Shaped<FenceRun | null>
      /** Which windows the plan has, from the latest reading; drives which limits the pane offers. */
      history: Shaped<FenceHistoryEntry[]>
      /** Whether Recent prompts is expanded; collapsed by default. */
      recentOpen: Shaped<boolean>
      /** Whether Background agents is expanded; collapsed by default. */
      agentsOpen: Shaped<boolean>
      /** The setting whose custom value is being typed, and why the last try was refused. */
      editing: Shaped<{ key: string; error: string | null } | null>
      plan: Shaped<{ hasSession: boolean; hasWeekly: boolean } | null>
      /** This session's background agents, each fenced on its own: running ones and the last few finished. */
      agents: Shaped<FenceAgent[]>
      /** The limits a new background agent of this session starts with. */
      agentLimits: Shaped<FenceLimits>
      /** The background agent whose limits are open in the pane. */
      agentOpen: Shaped<string | null>
      /** What this session is called in the pane: its folder and first prompt. */
      sessionName: Shaped<{ folder: string; prompt: string } | null>
    }
  }
}
