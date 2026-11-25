# Remote control

Both HTTP and OSC only listen on this PC. Their ports can be changed in Settings → Remote Control. To control the app from another computer use the [Companion module](https://github.com/internal-events-support/companion-module-neriftafu-casparcgadvancedclient), which uses the web interface.

Layers are written as channel-layer, e.g. `1-10`. That's on the first server in the settings. For another one put its name in front, e.g. `Backup:1-10`.

## HTTP

The address is `http://127.0.0.1:8125`. If something can't be done, the reply starts with "Not done:" and says why.

| Address | What it does |
|---|---|
| `/layer/1-10/play`, `/pause`, `/toggle`, `/stop` | Control what's on a layer |
| `/layer/1-10/start`, `/back`, `/forward` | Go to the start, or skip back or forward |
| `/layer/1-10/next`, `/prev` | Next or previous clip, if it's a playlist |
| `/take/2-10/1-10/cut`, `/fade` | Take from the first layer to the second |
| `/take/2-10/1-10/cutplay`, `/fadeplay` | The same, and play it |
| `/take/2-10/1-10/fade/25` | A fade that lasts 25 frames, which is also the default |
| `/playlist/1/load`, `/play`, `/pause`, `/stop`, `/next`, `/prev` | Control a playlist, by its number, name or remote ID |
| `/playlist/1/load/2`, `/play/2` | Load or play from the second clip |
| `/item/<remote id>/play` | Control a rundown entry that has Allow remote turned on |
| `/overlay/5/show`, `/hide`, `/toggle` | The playback overlay of a channel |
| `/status` | What's on every layer, as JSON |

Entries can be sent `stop`, `play`, `playnow`, `load`, `pause`, `next`, `previous`, `back`, `forward`, `update`, `invoke`, `preview`, `clear`, `clearvideolayer` and `clearchannel`.

Web pages in a browser can't use these addresses, so that a site can't control your show.

## OSC

The port is 3250 and the addresses are the same as the original client's. Like the original, a message needs an argument, and does nothing if it's 0 or false.

| Address | What it does |
|---|---|
| `/control/play`, `/control/stop` and so on | Control what's selected in the rundown |
| `/control/up`, `/control/down` | Move the selection |
| `/control/playandautostep`, `/control/playnowandautostep` | Play what's selected and move to the next entry |
| `/control/<remote id>/play` | Control a rundown entry that has Allow remote turned on |
| `/control/layer/1-10/play` | Control what's on a layer, with the same words as over HTTP |
| `/control/take/2-10/1-10/cutplay` | A take, with the same words as over HTTP. Fades last 25 frames |

The first three rows only work if "Allow remote triggering" is on for the rundown, which is in the menu when you right-click its tab.
