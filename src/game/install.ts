import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { detectGamePaths, listBridgePlayerIds, type GamePaths } from './paths.js'

export const DEFAULT_MOD_ZIP_URL =
  'https://github.com/xiaofenggan01/starcoplay-dsh/releases/download/mod-latest/StarCoPlay.zip'

export interface InstallModOptions {
  zipBuffer?: Buffer
  zipPath?: string
  url?: string
  gamePaths?: GamePaths
  fetchImpl?: typeof fetch
}

export interface InstallModResult {
  ok: boolean
  message: string
  modDir?: string
  installedVersion?: string
  warnings: string[]
}

interface ManifestHit {
  prefix: string
  version: string
  uniqueId: string
}

interface ZipEntryLike {
  entryName: string
  isDirectory: boolean
  getData(): Buffer
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/')
}

function findManifest(entries: ZipEntryLike[]): ManifestHit | null {
  const candidates = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ entry, name: normalizeEntryName(entry.entryName) }))
    .filter(({ name }) => name.endsWith('manifest.json'))
    .sort((a, b) => a.name.length - b.name.length)
  for (const { entry, name } of candidates) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(entry.getData().toString('utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    const uniqueId = typeof parsed.UniqueID === 'string' ? parsed.UniqueID : ''
    const entryDll = typeof parsed.EntryDll === 'string' ? parsed.EntryDll : ''
    if (!uniqueId.includes('StarCoPlay') && !entryDll.includes('StarCoPlay')) continue
    return {
      prefix: name.slice(0, -'manifest.json'.length),
      version: typeof parsed.Version === 'string' ? parsed.Version : 'unknown',
      uniqueId,
    }
  }
  return null
}

function isSkipRelative(relative: string): boolean {
  if (relative === 'config.json') return true
  if (relative.startsWith('bridge_')) return true
  if (relative.startsWith('logs/')) return true
  if (relative.startsWith('test-reports/')) return true
  return false
}

export function safeRelative(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/')
  if (!normalized) return false
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  return !normalized.split('/').includes('..')
}

function mergeConfig(modRoot: string, modsDir: string, warnings: string[]): void {
  const configPath = join(modRoot, 'config.json')
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') config = parsed
    } catch {
      warnings.push('已有 config.json 无法解析，将使用默认配置')
    }
  }
  config.BridgeMode = 'auto'
  config.EnableAIControl = true
  const existingTarget = config.TargetPlayerId
  if (typeof existingTarget !== 'string' || !existingTarget.trim()) {
    const ids = listBridgePlayerIds(modsDir)
    if (ids.length === 1) {
      config.TargetPlayerId = ids[0]
    } else if (ids.length > 1) {
      config.TargetPlayerId = ids[0]
      warnings.push('检测到多个玩家 ID，已选择 ' + ids[0] + '；如不对请在游戏内执行 /agent_control 重新设置')
    } else {
      warnings.push('还没有找到玩家 ID：首次读档后请在游戏内执行 /agent_control，或再次运行安装')
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

async function downloadZip(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error('下载失败：HTTP ' + response.status + ' ' + response.statusText)
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function installMod(options: InstallModOptions = {}): Promise<InstallModResult> {
  const warnings: string[] = []
  const paths = options.gamePaths ?? detectGamePaths()
  if (!paths.modsDir) {
    return {
      ok: false,
      message: '没有找到星露谷的 Mods 目录。请先安装游戏和 SMAPI，或设置 STARCOPLAY_GAME_PATH。',
      warnings,
    }
  }
  if (!paths.smapi) {
    warnings.push('没有检测到 SMAPI：Mod 不会被加载，请先安装 SMAPI 4.x。')
  }

  const envZip = process.env.STARCOPLAY_MOD_ZIP
  let buffer: Buffer
  try {
    if (options.zipBuffer) {
      buffer = options.zipBuffer
    } else if (options.zipPath) {
      buffer = readFileSync(options.zipPath)
    } else if (envZip) {
      buffer = readFileSync(envZip)
    } else {
      buffer = await downloadZip(
        options.url || DEFAULT_MOD_ZIP_URL,
        options.fetchImpl || fetch,
      )
    }
  } catch (error) {
    return {
      ok: false,
      message: '无法获取 Mod 安装包：' + (error instanceof Error ? error.message : String(error)),
      warnings,
    }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch (error) {
    return {
      ok: false,
      message: 'Mod 安装包不是有效的 zip：' + (error instanceof Error ? error.message : String(error)),
      warnings,
    }
  }

  const entries = zip.getEntries() as unknown as ZipEntryLike[]
  const manifest = findManifest(entries)
  if (!manifest) {
    return {
      ok: false,
      message: '安装包里没有找到 StarCoPlay 的 manifest.json。',
      warnings,
    }
  }

  const modRoot = join(paths.modsDir, 'StarCoPlay')
  mkdirSync(modRoot, { recursive: true })
  let skipped = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const entryName = normalizeEntryName(entry.entryName)
    if (!entryName.startsWith(manifest.prefix)) continue
    const relative = entryName.slice(manifest.prefix.length)
    if (isSkipRelative(relative)) continue
    if (!safeRelative(relative)) {
      warnings.push('跳过不安全的 zip 路径：' + entryName)
      skipped += 1
      continue
    }
    const target = resolve(modRoot, relative)
    if (target !== modRoot && !target.startsWith(modRoot + sep)) {
      warnings.push('跳过越界的 zip 路径：' + entryName)
      skipped += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
  if (skipped > 0) {
    warnings.push('有 ' + skipped + ' 个文件因路径不安全被跳过。')
  }

  mergeConfig(modRoot, paths.modsDir, warnings)
  return {
    ok: true,
    message: '已安装 StarCoPlay ' + manifest.version + ' 到 ' + modRoot + '。请重启游戏或重新读档。',
    modDir: modRoot,
    installedVersion: manifest.version,
    warnings,
  }
}
