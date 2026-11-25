# Development

You need [Node.js](https://nodejs.org/) 22 or later. To build and run:

```bash
npm ci
npm start
```

Set the environment variable `CASPARCG_ADVANCED_USERDATA` to a folder to keep its settings apart from your own copy's.

## Tests

```bash
node test/unit.mjs
python test/hidden.py 300 node test/e2e.mjs <work dir> <media dir> <log>
python test/hidden.py 120 node test/renamed.mjs <log>
python test/hidden.py 300 node test/web.mjs <work dir> <chrome.exe> <rundown.xml>
```

- `unit.mjs` checks rundown files and the commands each tool sends.
- `e2e.mjs` runs the real app on a server of its own.
- `renamed.mjs` checks that settings from before the app was renamed are copied.
- `web.mjs` runs the client in browsers next to the app.

`hidden.py` runs a command on a separate desktop, so the test windows don't get in your way. The server is expected in `../server/build/casparcg_server`, or wherever `CASPAR_DIR` says.

## Where things are

| File | What's in it |
|---|---|
| `src/main/device.ts` | The connection to one server: AMCP commands and OSC status |
| `src/main/engine.ts` | Playlists, takes and transport |
| `src/main/runner.ts` | Rundown entries, groups and delays |
| `src/main/commands.ts` | The AMCP each tool sends |
| `src/main/preview.ts` | Clip preview |
| `src/main/overlay.ts` | The playback overlay. Its page is `static/overlay.html` |
| `src/main/api.ts` | HTTP and OSC control |
| `src/main/web.ts` | The web interface's server. `src/web/` runs the client in a browser |
| `src/main/update.ts` | Updating an installed copy |
| `src/main/migrate.ts` | Settings from before the app was renamed |
| `src/shared/tools.ts` | Every tool and its properties, which the inspector is built from |
| `src/shared/merge.ts` | Several screens editing one rundown |
| `src/shared/relink.ts` | Missing clips and finding their new names |
| `src/ui/` | The interface, built from Google Meet ISO's kit and tokens |

Takes don't use BEGIN and COMMIT. The server runs batches on a queue shared by all clients, so another client loading thumbnails can hold them up for seconds.

The overlay's page is served on port 8123. CasparCG loads it like any other HTML page, so a server on another computer has to be able to reach it.

## Cutting a release

```bash
npm version <patch|minor|major|x.y.z>
git push --follow-tags
```

The Release workflow builds a tag like `v1.2.3` and adds these to its release a few minutes later:

- `CasparCG-Advanced-Client-Setup.exe`, the installer
- its `.blockmap`, so installed copies only download what's changed
- `latest.yml`, where they look for updates

A release goes to every installed copy as soon as `latest.yml` is there. Pre-releases (`v1.2.3-beta.1`) aren't offered as updates. Running the workflow by hand without a tag makes a trial build, which is kept on the run.

To try an update without releasing, run `npm run dist`, serve `release/` over HTTP, and start an older installed copy with the environment variable `CASPARCG_ADVANCED_UPDATES` set to its address.
