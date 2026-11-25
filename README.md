# CasparCG Advanced Client

A CasparCG client with playlists, takes between any two channels, and local clip preview. Works with an unmodified CasparCG Server.

Up to 1.2.0 it was called CasparCG Client. Settings are copied from the old folder (`%APPDATA%\Caspar VT`) the first time it starts. It installs next to the old version, so quit and uninstall that one.

## Download

Run [CasparCG-Advanced-Client-Setup.exe](https://github.com/internal-events-support/casparcg-advanced-client/releases/latest/download/CasparCG-Advanced-Client-Setup.exe). It installs for your Windows account without needing an administrator, adds shortcuts and opens the app. It is not code-signed, so Windows SmartScreen may warn.

1.3.0 and earlier cannot update themselves, so run the installer once by hand. It replaces an installed 1.3.0 and settings are kept. If you use the portable exe, delete it. If 1.3.0 was installed for all users of the PC, uninstall it first.

## Updates

- The app looks for a new version when it starts and every six hours, but not while a playlist is playing. It downloads it in the background and installs it when you quit.
- It never updates while it is running or as it starts, so reopening it during a show gives the version you had.
- When a version is ready an Update button appears in the top bar, to install it straight away. The app closes and opens again about 10 seconds later. Clips on air are not touched.
- Settings > Updates has the version, a button to check now, and a switch. With it off the app only looks when you press the button and only installs when you press Update. They are on the show PC only, not in the web interface.

## Features

- Same tools, keys and rundown files (.xml) as the original CasparCG Client. A playlist is saved as an auto play group and a Channel Take as a custom command, so the original client can still open the file.
- **Playlists** loop or stop on the last clip, play the next clip by themselves or wait for Next, step forwards and back, can be edited while they play, carry on through a take, and are picked up again after a restart.
- **Channels** shows every layer on every channel with transport controls. No channel has a fixed role.
- **Takes** (cut / fade, with or without play) swap any two layers on any two channels of the same format. Use the Channels tab, a Channel Take item in a rundown, HTTP or OSC. A take from an empty layer takes the other one off: it moves to the empty layer and leaves nothing.
- **Preview** plays the clip file on this PC and sends the server nothing, so it works with the server off. Clips the app cannot play directly (ProRes, DNxHD, MKV …) get a small copy made with ffmpeg first. Set in and Set out fill in the item's seek and length. It needs to reach the media folder: found automatically for a server on this PC, otherwise set it in Settings > Servers.
- **Missing clips** are marked on their rows. The media list is checked every 8 seconds, so a renamed file is noticed by itself and its new name suggested (same size and length = same file). Relinking keeps everything else about the entry.
- **Copy template** (Ctrl+Shift+C) and apply (Ctrl+Shift+V) copy an entry's settings onto others, except the clip, label, remote ID and story ID.
- **Shell Command** items run programs on this PC. Off until allowed in Settings > Rundown.
- **Web interface** (port 8126) is the whole client in a browser, on a computer, tablet or phone, sharing the same open rundowns. Edits made on several screens at once are merged. It needs the access code from Settings > Web Interface, and is limited to this computer until other devices are allowed there. Another device cannot write Shell Commands, change settings that name programs or folders on the show PC, or change the web interface itself.
- **Remote control** over HTTP (127.0.0.1:8125) and OSC (3250, same addresses as the original client).
- **Channel names**, set in the Channels tab, are shown next to the number wherever a channel is chosen or named.
- **Playback overlay**: the clip that is playing and the time left on it, shown on any channel as graphics. Turned on and set up for each channel in the Channels tab. Its page is served on port 8123.

## Remote control

    /layer/1-10/play | pause | stop | back | forward | next | prev
    /take/2-10/1-10/cut | cutplay | fade | fadeplay      from, to; add /25 for a fade length in frames
    /playlist/1/load | play | next | prev                number or name; load/2 starts at the second clip
    /item/<remote id>/play | stop | load | …
    /overlay/5/show | hide | toggle                     the playback overlay of a channel
    /status

The same over OSC under /control, e.g. /control/take/2-10/1-10/cutplay.

## Run

    node scripts/build.js
    node_modules/electron/dist/electron.exe .

## Release

    npm version <patch|minor|major|x.y.z>
    git push --follow-tags

A version tag makes GitHub build the installer and add it to that release with the files installed copies update from (.github/workflows/release.yml):
latest.yml, which the app looks in, and a .blockmap, so that only what changed is downloaded.
**A release is sent to every installed copy.** Pre-releases (v1.2.3-beta.1) are not.

To try an update without releasing: `npm run dist`, serve `release/` over HTTP, and start an installed older copy with CASPARCG_ADVANCED_UPDATES set to its address.

## Test

    node test/unit.mjs                       # rundown files and every tool's commands
    python test/hidden.py 300 node test/e2e.mjs <work dir> <media dir> <log>   # the real app on an isolated server
    python test/hidden.py 120 node test/renamed.mjs <log>                      # settings from before the app was renamed
    python test/hidden.py 300 node test/web.mjs <work dir> <chrome.exe> <rundown.xml>      # the client in browsers next to the app

## Layout

    src/main/device.ts    AMCP connection and OSC status of one server
    src/main/engine.ts    playlists, takes, transport
    src/main/runner.ts    rundown items, groups, delays
    src/main/preview.ts   local clip preview
    src/main/commands.ts  the AMCP each tool sends
    src/main/api.ts       HTTP and OSC control
    src/main/overlay.ts   the playback overlay; static/overlay.html is its page
    src/main/update.ts    updating an installed copy
    src/main/migrate.ts   settings from before the app was renamed
    src/main/web.ts       web interface server; src/web/ runs the client in a browser
    src/shared/merge.ts   two screens editing one rundown
    src/shared/relink.ts  missing clips and finding their new names
    src/shared/tools.ts   every tool and its properties (the inspector is built from this)
    src/ui/               interface, built from Google Meet ISO's kit and tokens

Takes deliberately avoid BEGIN/COMMIT: the server runs batches on a queue shared by all clients, so another client
loading thumbnails can hold them up for seconds.
