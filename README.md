# starcoplay-dsh

DeepSeek Harness plugin that lets DSH play Stardew Valley with you.

Status: early preview. The plugin loads in DSH, starts a local route, exposes
12 native game tools, installs the StarCoPlay mod after a native confirmation
dialog, and can launch a second SMAPI instance for co-op. Automatic co-op join
is not enabled yet; Windows is not verified.

## What it does

    DSH
      -> starcoplay-dsh plugin
           -> local WebSocket route (127.0.0.1)
           <- StarCoPlay mod (SMAPI)

The plugin speaks the mod's Local Direct V2 JSON protocol, so it does not need
Python, MCP, or protobuf codegen.

## Requirements

- Stardew Valley
- SMAPI 4.x (the plugin detects it but does not install it)
- The StarCoPlay mod (the plugin can install/update it from the GitHub Release
  asset StarCoPlay.zip)

## Install

1. Open DSH -> Plugins.
2. Add https://github.com/xiaofenggan01/starcoplay-dsh
3. Enable starcoplay-dsh. The StarCoPlay mod asset is published at the
   mod-latest release tag (currently mod v2.5.0).
4. Talk to DSH. On the first turn it calls starcoplay_status. If the mod is
   missing, it calls starcoplay_install_mod, which shows a native confirmation
   dialog. Choose 安装最新版.
5. Load a save. The mod connects to the local route and the game tools appear.

## Tools

Setup:
- starcoplay_status: game, SMAPI, mod version, route and launcher state.
- starcoplay_install_mod: download/install the mod after a native confirmation.
- starcoplay_launch_game: launch a second Stardew Valley instance via SMAPI
  (no Steam single-instance lock). The player joins the co-op game in the new
  window manually until automatic join lands.

Game:
- starcoplay_observe
- starcoplay_say
- starcoplay_emote
- starcoplay_face
- starcoplay_move_to
- starcoplay_go_to
- starcoplay_do
- starcoplay_use_tool
- starcoplay_equip
- starcoplay_go_bed
- starcoplay_water_crops
- starcoplay_harvest_crops

## Co-op second window (V1)

1. Open your own co-op save as the host (Steam/SMAPI).
2. Ask DSH to open a second window; it calls starcoplay_launch_game.
3. In the new window choose Co-op -> Join LAN -> your farm -> a cabin.
4. Once the mod loads, the local route connects and the game tools work.

Automatic co-op join and automatic AI target selection are V2; the second
window still needs the one-time join click.

## Development

    pnpm install
    pnpm test
    pnpm typecheck
    pnpm build

Commit lib/index.js when publishing: DSH installs from GitHub without running
build scripts, so the built bundle must be in the repository.

Install the published package into a DSH profile:

    dsh plugin --profile desktop add github:xiaofenggan01/starcoplay-dsh

Load a local checkout instead:

    dsh plugin --profile desktop add file:/absolute/path/to/starcoplay-dsh

For a local mod zip without a GitHub release, set STARCOPLAY_MOD_ZIP to the
zip path before starting DSH. The installer will use that file instead of the
latest release asset.

After rebuilding, remove the profile's node_modules copy and re-add the package
(pnpm caches file: dependencies by content).

## Architecture

- src/route: rendezvous file, WebSocket server, local_direct handshake,
  V2 JSON command/result frames, capability digest, serial command queue.
- src/game: Steam/game/Mods/SMAPI detection, mod install, and the second
  SMAPI instance launcher.
- src/tools: DSH native tools, including the install confirmation flow.
- src/prompt.ts: companion system prompt.

## Releasing

The plugin and the mod are released separately:

1. Build the mod from the main repository (Build & Release workflow).
2. Upload the zip to the stable mod-latest tag:

    gh release upload mod-latest /path/StarCoPlay.zip \
      --repo xiaofenggan01/starcoplay-dsh --clobber

3. Bump package.json and src/version.ts, run pnpm build, commit lib/index.js.
4. Tag the plugin and create a GitHub release for the source snapshot.

## Known limitations

- SMAPI is detected, not auto-installed.
- The mod asset is published at the mod-latest release tag; upload a new
  StarCoPlay.zip there with --clobber when the mod updates.
- Version comparison/update prompts are basic; the installer always installs
  the latest asset.
- Windows paths and file locks are not verified yet.
- The first-run prompt happens on the first chat turn, not at plugin activation.
- Automatic co-op join is deferred; the second window starts at the title screen.
- TargetPlayerId is inferred from an existing bridge_* directory; a new AI
  farmhand with a different player id still needs V2 target automation.

## Security

- The route binds 127.0.0.1 only.
- The rendezvous file is 0600 and contains a random proof.
- The installer rejects unsafe zip paths and preserves config.json, bridge_*,
  logs, and test-reports.
- The plugin never installs SMAPI automatically and never executes shell
  commands from the model.

## License

MIT
