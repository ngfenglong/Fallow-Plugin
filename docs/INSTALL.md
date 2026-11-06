# Installing and updating Fallow

Fallow isn't on the Chrome Web Store in this version — it's loaded as an unpacked
extension straight from a build you make yourself. You don't need to know npm or Vite
to do this; you just need Node.js installed and one command.

## First-time install

1. Install [Node.js](https://nodejs.org/) (which brings `npm` with it) if you don't
   already have it.
2. Get the code: `git clone <this repository>` and `cd fallow` (the project root with
   `package.json` in it).
3. Build it: `npm run setup`. This installs the project's dependencies and produces a
   `dist/` folder — that one command is all you need, every time.
4. Open `chrome://extensions` in Chrome, turn on **Developer mode** (top-right toggle),
   click **Load unpacked**, and select the `dist/` folder you just built (inside the
   `fallow/` project directory, e.g. `fallow/dist`). Fallow now appears in your
   extensions list and toolbar.

## Updating after a `git pull`

1. From the `fallow/` directory: `git pull`, then `npm run setup` again. This rebuilds
   `dist/` in place with whatever changed.
2. Back on `chrome://extensions`, find Fallow's card and click its reload icon (the
   circular arrow). You do not need to repeat "Load unpacked" — it still points at the
   same `dist/` folder, which `npm run setup` just refreshed.

## Troubleshooting

- If `npm run setup` fails, re-run it after `git pull` — it's safe to run repeatedly,
  and it always leaves a clean `dist/` behind on success.
- If Chrome appears to be running an old version of the extension after an update, use
  the reload icon on its `chrome://extensions` card (not just closing and reopening the
  extensions page) — that's what picks up a freshly rebuilt `dist/`.
