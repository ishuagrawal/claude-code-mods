# claude-code-mods

Mods for Claude Code that make a session easier to read and steer.

## budget-fence

Pauses a prompt, or a background agent, before it runs too long, uses too many tokens, or eats too much of your usage limit, without changing how Claude works. It starts **off**; turn it on in its pane.

Each session has its own fence: its pane is headed with that session's folder and first prompt, and changing a limit there changes only that session. A new session starts from the limits you set last, in any session.

- **The pane** (`/fence`, or **⋯** on the row above the prompt) holds everything:
  - an on/off switch; your limits are kept while it is off
  - **This prompt / Last prompt**: time, tokens, and its share of the session and weekly limits, amber near a limit and red at it
  - **Pause each prompt after**: one dropdown per limit, each with presets, **No limit**, and **Custom…** for any value you type. Changes apply to the prompt already running.
  - **Background agents**, under the prompt's limits, collapsed by default (**Show** opens it; it opens by itself while an agent waits on a limit): one row per background agent this session started, with its live time, tokens and shares against its limits. **Edit limits** opens that agent's own dropdowns. A finished agent leaves the list at your next prompt and stays in **Recent prompts**, marked with the agent icon. Below the agents, **Default limits for new agents**, in gray under a settings icon, holds what each new agent starts with: no limits until you set some, then what you set, in later sessions too. Agents still on default limits follow changes there.
  - **Recent prompts**, collapsed by default, and **View all** for the full history (kept across sessions)
- **While Claude works**, one row above the prompt shows the limit closest to its cap as its icon, a bar, and `used / limit` (amber from 80%, red at the limit; when a limit trips, a Paused or Stopped status with its own icon leads the row in the same color as the pane shows it), and each other limit as its icon and a percent. On a narrow window the other limits drop off first. With the prompt and background agents going at once, each gets a row of its own like that one (the prompt's marked with its icon, each agent's with its name), halted ones first, up to four rows, the last saying how many more are running. **⋯** opens the pane.
- **Background agents are fenced on their own**, measured from when they start, separately from the prompt that started them. When usage windows move for several things at once, each run's share is its part of the token weight spent. When an agent reaches a limit, it asks the same question as a prompt, naming the agent; if nothing can show the question, it stops and reports back.
- **When a limit is reached**, the next tool call waits on a question in the prompt box: **Continue and raise** that limit (by half, past what the prompt has used), **Stop here**, or **Open Budget fence** to change any limit, then continue or stop. Type a value under Other to set the limit yourself, or anything else to stop and tell Claude why. Stopping tells Claude it hit your fence, and it wraps up.

The fence never tells Claude about the budget, so it never cuts corners to fit. It only watches and asks.

### Limits

| Setting | `/fence` | Pauses when one prompt, with everything it started, has |
| --- | --- | --- |
| Working time | `/fence time 20m` | worked for 20 minutes |
| Tokens | `/fence tokens 500k` | used 500k tokens (input, cache writes and output) |
| Share of session limit | `/fence session 10%` | used 10% of the 5-hour session limit (plans that have one) |
| Share of weekly limit | `/fence weekly 2%` | used 2% of the weekly limit |

Every limit starts at **No limit**. `/fence off` and `/fence on` switch the fence; `/fence reset` clears the limits. Put `background` first to set the background agents' limits instead: `/fence background time 10m tokens 200k`.

### How the usage shares are measured

The app reports each usage limit as a whole percent, so a prompt's raw share is the difference of two rounded readings and can be off by up to a point. To do better, the fence learns, **per model**, how many points a unit of token weight costs, from earlier prompts that model did alone. Once a model has seen three points move, a prompt's share is estimated from its own work and kept within a point of the readings. Until then the rounded reading is shown. Anything estimated or rounded is marked `~`; a reading that did not move shows `<1%`.

### Install

```bash
claude plugin marketplace add ishuagrawal/claude-code-mods
claude plugin install budget-fence@claude-code-mods
```

### Develop

```bash
claude plugin validate plugins/budget-fence
claude plugin test plugins/budget-fence
```
