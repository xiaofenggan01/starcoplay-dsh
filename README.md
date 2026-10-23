# starcoplay-dsh

DeepSeek Harness plugin that lets DSH play Stardew Valley with you.

Status: early preview. The plugin loads in DSH, starts a local route, exposes
12 native game tools, and can install the StarCoPlay mod after a native
confirmation dialog. Windows is not verified yet.

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
3. Enable starcoplay-dsh. The latest release of this repository carries the
   StarCoPlay mod asset StarCoPlay.zip (currently mod v2.5.0).
4. Talk to DSH. On the first turn it calls starcoplay_status. If the mod is
   missing, it calls starcoplay_install_mod, which shows a native confirmation
   dialog. Choose 安装最新版.
5. Load a save. The mod connects to the local route and the game tools appear.

## Tools

Setup:
- starcoplay_status: game, SMAPI, mod version, route state.
- starcoplay_install_mod: download/install the mod after a native confirmation.

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
- src/game: Steam/game/Mods/SMAPI detection and mod install.
- src/tools: DSH native tools, including the install confirmation flow.
- src/prompt.ts: companion system prompt.

## Known limitations

- SMAPI is detected, not auto-installed.
- The mod release must publish StarCoPlay.zip at the latest release URL.
- Version comparison/update prompts are basic; the installer always installs
  the latest asset.
- Windows paths and file locks are not verified yet.
- The first-run prompt happens on the first chat turn, not at plugin activation.

## Security

- The route binds 127.0.0.1 only.
- The rendezvous file is 0600 and contains a random proof.
- The installer rejects unsafe zip paths and preserves config.json, bridge_*,
  logs, and test-reports.
- The plugin never installs SMAPI automatically and never executes shell
  commands from the model.

## License

MIT
