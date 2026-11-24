# CasparCG Client

A CasparCG client with playlists, takes between any two channels, and local clip preview. Works with an unmodified CasparCG Server.

- Same tools, keys and rundown files (.xml) as the original CasparCG Client. A playlist is saved as an auto play group and a Channel Take as a custom command, so the original client can still open the file.
- **Playlists** loop or stop on the last clip, play the next clip by themselves or wait for Next, step forwards and back, can be edited while they play, carry on through a take, and are picked up again after a restart.
- **Channels** shows every layer on every channel with transport controls. No channel has a fixed role.
- **Takes** (cut / fade, with or without play) swap any two layers on any two channels of the same format. Use the Channels tab, a Channel Take item in a rundown, HTTP or OSC. A take from an empty layer is refused.
- **Preview** plays the clip file on this PC and sends the server nothing, so it works with the server off. Clips the app cannot play directly (ProRes, DNxHD, MKV …) get a small copy made with ffmpeg first. Set in and Set out fill in the item's seek and length. It needs to reach the media folder: found automatically for a server on this PC, otherwise set it in Settings > Servers.
- **Missing clips** are marked on their rows. The media list is checked every 8 seconds, so a renamed file is noticed by itself and its new name suggested (same size and length = same file). Relinking keeps everything else about the entry.
- **Copy template** (Ctrl+Shift+C) and apply (Ctrl+Shift+V) copy an entry's settings onto others, except the clip, label, remote ID and story ID.
- **Shell Command** items run programs on this PC. Off until allowed in Settings > Rundown.
- **Web interface** (port 8126) controls the open rundowns and channels from a phone or another computer. It needs the access code from Settings > Web Interface, and is limited to this computer until other devices are allowed there.
- **Remote control** over HTTP (127.0.0.1:8125) and OSC (3250, same addresses as the original client), plus the countdown feed for monitor overlays (8123).

## Remote control

    /layer/1-10/play | pause | stop | back | forward | next | prev
    /take/2-10/1-10/cut | cutplay | fade | fadeplay      from, to; add /25 for a fade length in frames
    /playlist/1/load | play | next | prev                number or name; load/2 starts at the second clip
    /item/<remote id>/play | stop | load | …
    /status

The same over OSC under /control, e.g. /control/take/2-10/1-10/cutplay. The addresses of the earlier VT controller
(/pgm, /pvw, /take/cut …) still work while its vt_config.json is set in Settings > Remote Control.

## Run

    node scripts/build.js
    node_modules/electron/dist/electron.exe .

## Release

    npm version <patch|minor|major|x.y.z>
    git push --follow-tags

A version tag makes GitHub build the installer and portable exe and add them to that release (.github/workflows/release.yml).
The exes are not code-signed, so Windows SmartScreen warns the first time.

## Test

    node test/unit.mjs                       # rundown files and every tool's commands
    python test/hidden.py 300 node test/e2e.mjs <work dir> <media dir> <vt config> <log>   # the real app on an isolated server

## Layout

    src/main/device.ts    AMCP connection and OSC status of one server
    src/main/engine.ts    playlists, takes, transport
    src/main/runner.ts    rundown items, groups, delays
    src/main/preview.ts   local clip preview
    src/main/commands.ts  the AMCP each tool sends
    src/main/api.ts       HTTP, OSC and countdown services
    src/main/web.ts       web interface server; src/web/ is its page
    src/shared/relink.ts  missing clips and finding their new names
    src/shared/tools.ts   every tool and its properties (the inspector is built from this)
    src/ui/               interface, built from GMeet ISO's kit and tokens

Takes deliberately avoid BEGIN/COMMIT: the server runs batches on a queue shared by all clients, so another client
loading thumbnails can hold them up for seconds.
