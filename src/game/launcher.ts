import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { detectGamePaths, type GamePaths } from './paths.js'

export interface GameLaunchResult {
  ok: boolean
  message: string
  pid?: number
}

export interface LauncherDeps {
  spawnImpl?: typeof spawn
  detectPaths?: () => GamePaths
  graceMs?: number
}

export class GameLauncher {
  private child?: ChildProcess
  private readonly spawnImpl: typeof spawn
  private readonly detectPaths: () => GamePaths
  private readonly graceMs: number

  constructor(deps: LauncherDeps = {}) {
    this.spawnImpl = deps.spawnImpl ?? spawn
    this.detectPaths = deps.detectPaths ?? (() => detectGamePaths())
    this.graceMs = Math.max(0, deps.graceMs ?? 1200)
  }

  status(): { running: boolean; pid?: number } {
    const running = Boolean(this.child && this.child.exitCode === null && !this.child.killed)
    return running
      ? { running: true, pid: this.child?.pid }
      : { running: false }
  }

  async launch(paths?: GamePaths): Promise<GameLaunchResult> {
    const current = paths ?? this.detectPaths()
    if (!current.gameDir) {
      return { ok: false, message: '没有找到星露谷安装目录。请先安装游戏，或设置 STARCOPLAY_GAME_PATH。' }
    }
    if (!current.smapiPath) {
      return { ok: false, message: '没有检测到 SMAPI。第二个实例需要通过 SMAPI 启动，请先安装 SMAPI 4.x。' }
    }
    const running = this.status()
    if (running.running) {
      return { ok: true, message: '第二个星露谷实例已经在运行（PID=' + running.pid + '）。', pid: running.pid }
    }

    let child: ChildProcess
    try {
      child = this.spawnImpl(current.smapiPath, [], {
        cwd: dirname(current.smapiPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (error) {
      return { ok: false, message: '启动 SMAPI 失败：' + (error instanceof Error ? error.message : String(error)) }
    }
    this.child = child

    return await new Promise<GameLaunchResult>((resolve) => {
      let settled = false
      const finish = (result: GameLaunchResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const timer = setTimeout(() => {
        try { child.unref() } catch { /* ignore */ }
        finish({
          ok: true,
          message: '已启动第二个星露谷实例（SMAPI）。请在新窗口里加入联机存档；加入后路线会自动连上。',
          pid: child.pid,
        })
      }, this.graceMs)
      timer.unref?.()

      child.once('error', (error) => {
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        finish({ ok: false, message: '启动 SMAPI 失败：' + error.message })
      })
      child.once('spawn', () => {
        try { child.unref() } catch { /* ignore */ }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        if (!settled && code !== null && code !== 0) {
          finish({ ok: false, message: 'SMAPI 启动后立即退出（code=' + code + '）。' })
        }
      })
    })
  }

  stop(): void {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = undefined
      return
    }
    try { child.kill() } catch { /* ignore */ }
    this.child = undefined
  }
}
