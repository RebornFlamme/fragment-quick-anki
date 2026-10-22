# Fragment Sample Plugin

A starter plugin for [Fragment](https://github.com/RebornFlamme/Fragment), an
Obsidian-style knowledge app. It mirrors the official
[`obsidian-sample-plugin`](https://github.com/obsidianmd/obsidian-sample-plugin)
but targets Fragment's public type contract,
[`@usefragment/core`](https://www.npmjs.com/package/@usefragment/core).

## What it demonstrates

| Feature | API used |
| --- | --- |
| A ribbon icon that shows a notice and counts clicks | `Plugin.addRibbonIcon`, `Notice` |
| A command that opens a modal | `Plugin.addCommand` (`callback`), `Modal` |
| An editor command (wrap selection in `**bold**`) | `Plugin.addCommand` (`editorCallback`), `Editor` |
| A conditional command that hides when the view is open | `Plugin.addCommand` (`checkCallback`) |
| A custom side view | `Plugin.registerView`, `ItemView`, `setIcon` |
| A global DOM listener, auto-removed on unload | `Component.registerDomEvent` |
| A repeating interval, auto-cleared on unload | `Component.registerInterval` |
| Persisted settings | `Plugin.loadData` / `Plugin.saveData` |

## How Fragment plugins work

`@usefragment/core` is a **types-only** package — it ships no JavaScript. At
runtime the Fragment host injects the real implementation through a require shim
(just like the `obsidian` package). Your code imports from the virtual
`fragment` module (the alias `obsidian` also works), and the bundler marks it as
**external** so it is resolved by the host, not bundled in.

```ts
import { Plugin, Notice } from "fragment";

export default class MyPlugin extends Plugin {
  async onload() {
    this.addCommand({ id: "hello", name: "Say hello", callback: () => new Notice("👋") });
  }
}
```

### Not yet in 0.1.0

The type contract is intentionally minimal at `0.1.0`. These Obsidian APIs are
**not** available yet, so this sample avoids them:

- `Setting` / `PluginSettingTab` and `Plugin.addSettingTab` (settings persist via
  `loadData`/`saveData`, but there is no built-in settings UI yet).
- `Plugin.addStatusBarItem`.
- Obsidian's DOM sugar (`el.createEl`, `el.addClass`, `el.empty`, `el.setText`).
  Use standard DOM APIs (`document.createElement`, `el.classList`,
  `el.replaceChildren`, `el.textContent`) instead.

The only global augmentation Fragment adds is `window.app`.

## Getting started

```bash
npm install        # install dev dependencies
npm run dev        # bundle src/main.ts -> main.js and watch for changes
npm run build      # type-check, then produce a minified production main.js
```

The plugin's loadable files are `main.js`, `manifest.json` and `styles.css`.
Place this folder in your vault's plugins directory (it already lives under
`.fragment/plugins/`), then enable **Sample Plugin** in Fragment.

## Releasing

`npm version patch|minor|major` runs `version-bump.mjs`, which writes the new
version into `manifest.json` and records the compatible `minAppVersion` in
`versions.json`.

## Project layout

```
manifest.json        Plugin metadata (id, name, version, minAppVersion, …)
package.json         Scripts and dev dependencies
tsconfig.json        Loads @usefragment/core via "types"
esbuild.config.mjs   Bundles to main.js, marks `fragment` external
src/main.ts          The plugin
styles.css           Plugin styles (prefer theme CSS variables)
versions.json        plugin version -> minimum Fragment version
version-bump.mjs      Release helper
```

## License

MIT
