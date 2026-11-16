# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code). Each one is a plugin you install on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [Budget fence](#budget-fence) | Pauses a prompt or background agent before it runs too long, uses too many tokens, or uses too much of your usage limit. |

## Install

Install a mod by its name (`budget-fence`, say). At the prompt of a Claude Code session:

```
/plugin install <mod> --marketplace ishuagrawal/claude-code-mods
```

From a shell:

```bash
claude plugin install <mod> --marketplace ishuagrawal/claude-code-mods
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ishuagrawal/claude-code-mods`, then add the mod.

The first install asks to add the marketplace (`y`), then for a scope. To get updates later, run `claude plugin marketplace update claude-code-mods`, then `/reload-plugins` in a session.

---

## Budget fence

`budget-fence` · pauses work before it costs more than you meant to spend. It only watches and asks: Claude is never told about the budget, so it never cuts corners to fit.

### Use

1. Run `/fence` to open its pane, and **Turn on** the fence (it starts off).
2. Set **Pause each prompt after**: working time, tokens, and share of your session and weekly limits.
3. When a prompt reaches a limit, its next tool call waits on a question in the prompt box: continue with no limits, raise that limit, stop, or open the pane to change any limit.

| Where | What it shows |
| --- | --- |
| Pane (`/fence`, or **⋯** above the prompt) | The fence switch, the current prompt's time, tokens and shares, every limit, background agents, and recent prompts |
| Row above the prompt | While work runs: the limit closest to its cap as a bar and `used / limit`, one row per running prompt or agent |

### Background agents

Each background agent is fenced on its own, from when it starts. **Default limits for new agents** sets what each starts with; **Edit limits** on an agent's row changes that agent alone. An agent at its limit asks the same question, naming the agent. Stopped, it reports what it has and does nothing more.

### Limits

Each prompt is measured on its own, with any helper agents it starts in the foreground. Changes apply at once, including to the prompt that is running. Each session keeps its own limits; a new session starts from the ones you set last.

| Limit | Command | Pauses after |
| --- | --- | --- |
| Working time | `/fence time 20m` | 20 minutes of work |
| Tokens | `/fence tokens 500k` | 500k tokens (input, cache writes and output; cache reads are left out) |
| Session share | `/fence session 10%` | 10% of the 5-hour limit, on plans that have one |
| Weekly share | `/fence weekly 2%` | 2% of the weekly limit |

`/fence on`, `/fence off` and `/fence reset` switch and clear the fence. Start with `background` to set the limits for new agents: `/fence background time 10m tokens 200k`.

Usage limits are reported in whole percents. The fence learns how much each model's work costs from earlier prompts, and estimates finer shares once it has; estimates and rounded readings are marked `~`.

---

## Develop

Each mod lives in `plugins/<mod>` and is listed in `.claude-plugin/marketplace.json`.

```bash
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```

## License

[MIT](LICENSE)
