import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CapabilityEntry } from './route/digest.js'
import { detectGamePaths, listBridgePlayerIds } from './game/paths.js'
import { StarCoPlayRouteServer } from './route/server.js'
import { registerStatusTool, type StatusSnapshot } from './tools/status.js'
import { registerGameTools } from './tools/game.js'
import { registerInstallModTool } from './tools/setup.js'
import { SYSTEM_PROMPT } from './prompt.js'
import { VERSION } from './version.js'

const V0_CAPABILITIES: CapabilityEntry[] = [
  ['observe_current_view', 'observe'],
  ['say', 'say'],
  ['emote', 'emote'],
  ['face', 'face'],
  ['move_to_target', 'move_to'],
  ['navigate_to_target', 'go_to'],
  ['act_on_target', 'do'],
  ['use_tool_at_target', 'use_tool'],
  ['equip_matching_item', 'equip'],
  ['sleep_for_night', 'go_bed'],
  ['water_crops', 'water_crops'],
  ['harvest_crops', 'harvest_crops'],
].map(([capability_id]) => ({
  source_surface: 'v2-compat',
  capability_id,
  capability_contract_version: '2.4.5',
}))

function logInfo(ctx: any, message: string): void {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('starcoplay-dsh') : ctx.logger
    if (logger?.info) {
      logger.info(message)
      return
    }
  } catch { /* fall through */ }
  console.error('[starcoplay-dsh] ' + message)
}

export const name = 'starcoplay-dsh'
export const inject = ['tools', 'systemPrompt', 'userQuestions']

export async function apply(ctx: any, config: any = {}): Promise<void> {
  const rendezvousPath = config.rendezvousPath ||
    join(homedir(), '.starcoplay', 'local-direct', 'rendezvous.json')
  const route = new StarCoPlayRouteServer({
    rendezvousPath,
    capabilityEntries: V0_CAPABILITIES,
    logger: (message) => logInfo(ctx, message),
  })
  let routeError: string | undefined
  try {
    await route.start()
  } catch (error) {
    routeError = error instanceof Error ? error.message : String(error)
    logInfo(ctx, 'route start failed: ' + routeError)
  }

  const getStatus = (): StatusSnapshot => {
    const game = detectGamePaths()
    return {
      pluginVersion: VERSION,
      route: { ...route.status(), lastError: routeError || route.status().lastError },
      game,
      bridgePlayerIds: listBridgePlayerIds(game.modsDir),
    }
  }

  registerStatusTool(ctx, getStatus)
  registerInstallModTool(ctx, getStatus)
  registerGameTools(ctx, route)

  try {
    if (typeof ctx.systemPrompt?.section === 'function') {
      ctx.systemPrompt.section({
        name: 'starcoplay',
        order: 100,
        text: SYSTEM_PROMPT,
      })
    }
  } catch (error) {
    logInfo(ctx, 'system prompt section failed: ' + String(error))
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { void route.stop() }, 'starcoplay-dsh')
  }
  logInfo(ctx, 'loaded v' + VERSION)
}
