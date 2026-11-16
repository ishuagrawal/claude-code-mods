# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code). Each one is a plugin you install on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [Budget fence](plugins/budget-fence) | Pauses a prompt or background agent before it runs too long, uses too many tokens, or uses too much of your usage limit. |

## Install

Install a mod by its name (`budget-fence`, say); each mod's README covers how to use it. At the prompt of a Claude Code session:

```
/plugin install <mod> --marketplace ishuagrawal/claude-code-mods
```

From a shell:

```bash
claude plugin install <mod> --marketplace ishuagrawal/claude-code-mods
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ishuagrawal/claude-code-mods`, then add the mod.

The first install asks to add the marketplace (`y`), then for a scope. To get updates later, run `claude plugin marketplace update claude-code-mods`, then `/reload-plugins` in a session.

## Develop

Each mod lives in `plugins/<mod>`, with its own README, and is listed in `.claude-plugin/marketplace.json`.

```bash
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```

## License

[MIT](LICENSE)
