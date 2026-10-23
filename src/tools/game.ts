import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LocalCommandResult } from '../route/protocol.js'
import type { StarCoPlayRouteServer } from '../route/server.js'

const EMOTES = ['happy', 'sad', 'angry', 'heart', 'exclamation', 'question', 'sleep', 'sick', 'laugh', 'note', 'music', 'blush']
const DIRECTIONS = ['up', 'down', 'left', 'right']
const FACE_DIRECTIONS = ['north', 'south', 'east', 'west']

export function compactValue(value: unknown, limit = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!text) return ''
  return text.length > limit ? text.slice(0, limit) + '\n... (truncated)' : text
}

export function formatGameResult(result: LocalCommandResult): string {
  const output = result.output as Record<string, unknown> | undefined
  if (result.state !== 'SUCCEEDED') {
    const error = output && typeof output.error === 'object' && output.error !== null
      ? output.error as Record<string, unknown>
      : undefined
    const code = result.error_code || (error && typeof error.code === 'string' ? error.code : result.state)
    const observation = output && typeof output.observation === 'string' ? output.observation : ''
    return '操作失败（' + code + '）' + (observation ? '\n' + observation : '')
  }
  if (output && typeof output === 'object') {
    if (typeof output.observation === 'string' && output.observation.trim()) {
      return output.observation
    }
    if (output.success === false) {
      return '操作未成功：' + compactValue(output)
    }
  }
  return compactValue(output ?? result)
}

interface ToolSpec {
  name: string
  description: string
  capability: string
  timeoutMs: number
  parameters: Record<string, any>
  normalize?: (args: Record<string, unknown>) => string | Record<string, unknown>
}

function registerGameTool(
  ctx: any,
  route: StarCoPlayRouteServer,
  spec: ToolSpec,
): void {
  ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: Record<string, unknown>) {
      const normalized = spec.normalize ? spec.normalize(args) : args
      if (typeof normalized === 'string') return normalized
      const params: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(normalized)) {
        if (value !== undefined && value !== null && value !== '') params[key] = value
      }
      try {
        const result = await route.command(spec.capability, params, spec.timeoutMs)
        return formatGameResult(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return '游戏还没有连接：' + message + '\n请先读档，并确认 StarCoPlay Mod 已启用、BridgeMode 为 auto 或 local_direct。'
      }
    },
  }))
}

export function registerGameTools(ctx: any, route: StarCoPlayRouteServer): void {
  registerGameTool(ctx, route, {
    name: 'starcoplay_observe',
    description: '查看当前游戏状态：角色位置、时间、天气、体力、手持物品、附近 NPC/作物/动物/可交互物。做任何决定前先调用它。只读。',
    capability: 'observe',
    timeoutMs: 30000,
    parameters: {},
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_say',
    description: '在游戏内聊天框说话，玩家才能听见。普通回复玩家看不到；需要让玩家听见时必须调用它。',
    capability: 'say',
    timeoutMs: 15000,
    parameters: {
      message: { type: 'string', required: true, description: '要说的话' },
    },
    normalize(args) {
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      return message ? { message } : 'message 不能为空'
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_emote',
    description: '在角色头顶显示表情气泡，不说话。用于补充情绪反馈。',
    capability: 'emote',
    timeoutMs: 15000,
    parameters: {
      type: { type: 'string', required: true, enum: EMOTES, description: '表情类型' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_face',
    description: '原地转向，不移动。用于交互或使用工具前调整朝向。',
    capability: 'face',
    timeoutMs: 15000,
    parameters: {
      direction: { type: 'string', required: true, enum: DIRECTIONS, description: '方向' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_move_to',
    description: '在当前地图内走到指定 tile。跨地图请用 starcoplay_go_to。',
    capability: 'move_to',
    timeoutMs: 60000,
    parameters: {
      x: { type: 'number', required: true, description: '目标 tile X' },
      y: { type: 'number', required: true, description: '目标 tile Y' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_go_to',
    description: '走向一个语义目标：NPC 名、动物名、地图名、建筑名、坐标（25,60 或 Town:25,60）或 player。会跨地图寻路。',
    capability: 'go_to',
    timeoutMs: 120000,
    parameters: {
      target: { type: 'string', required: true, description: '目标标识' },
      face_direction: { type: 'string', enum: FACE_DIRECTIONS, description: '到达后朝向' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_do',
    description: '按交互键（对话、开门、开箱、收获、抚摸动物等），游戏引擎根据上下文决定效果。不传 xy 时对面前的 tile 生效。',
    capability: 'do',
    timeoutMs: 30000,
    parameters: {
      x: { type: 'number', description: '目标 tile X' },
      y: { type: 'number', description: '目标 tile Y' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_use_tool',
    description: '使用当前手持工具（浇水、砍树、敲石头、锄地等）。不传 xy 时对面前的 tile 生效。',
    capability: 'use_tool',
    timeoutMs: 30000,
    parameters: {
      x: { type: 'number', description: '目标 tile X' },
      y: { type: 'number', description: '目标 tile Y' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_equip',
    description: '切换手持物品。item 和 slot 二选一。',
    capability: 'equip',
    timeoutMs: 30000,
    parameters: {
      item: { type: 'string', description: '物品名（模糊匹配）' },
      slot: { type: 'number', description: '背包槽位（0 起）' },
    },
    normalize(args) {
      if (typeof args.item !== 'string' && typeof args.slot !== 'number') {
        return 'item 和 slot 至少要提供一个'
      }
      return args
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_go_bed',
    description: '回家并睡觉，推进到下一天。会寻路、找床、交互并确认睡觉对话。',
    capability: 'go_bed',
    timeoutMs: 180000,
    parameters: {
      force_tp: { type: 'boolean', description: '是否直接传送回家（默认 false）' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_water_crops',
    description: '给当前地图上所有未浇水的作物浇水，自动装备水壶、寻路、补水。返回浇水数量和停止原因。',
    capability: 'water_crops',
    timeoutMs: 180000,
    parameters: {
      max_count: { type: 'number', description: '最多浇多少株，默认 50' },
    },
  })

  registerGameTool(ctx, route, {
    name: 'starcoplay_harvest_crops',
    description: '收获当前地图上所有成熟作物，可选自动补种。返回收获数量和停止原因。',
    capability: 'harvest_crops',
    timeoutMs: 180000,
    parameters: {
      max_count: { type: 'number', description: '最多收多少株，默认 50' },
      replant_seed: { type: 'string', description: '收获后补种的种子名（可选）' },
    },
  })
}
