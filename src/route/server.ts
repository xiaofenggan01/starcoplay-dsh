import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { computeCapabilitySnapshotDigest, type CapabilityEntry } from './digest.js'
import {
  buildLocalCommand,
  isLocalCommandResult,
  isTerminalState,
  type LocalCommandResult,
  type RendezvousMaterial,
} from './protocol.js'

export class RouteUnavailableError extends Error {
  readonly code = 'route_unavailable'
  constructor(message = 'the Stardew Valley mod is not connected yet') {
    super(message)
    this.name = 'RouteUnavailableError'
  }
}

export class RouteTimeoutError extends Error {
  readonly code = 'route_timeout'
  constructor(message = 'the game did not answer in time') {
    super(message)
    this.name = 'RouteTimeoutError'
  }
}

export interface RouteServerOptions {
  rendezvousPath: string
  capabilityEntries: CapabilityEntry[]
  logger?: (message: string) => void
}

export interface RouteStatus {
  running: boolean
  connected: boolean
  endpoint?: string
  rendezvousPath: string
  lastError?: string
  connectedAt?: number
}

interface PendingCommand {
  resolve: (result: LocalCommandResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RouteConnection {
  socket: WebSocket
  ready: boolean
  helloDeadline: NodeJS.Timeout
}

export class StarCoPlayRouteServer {
  private readonly options: RouteServerOptions
  private readonly material: RendezvousMaterial
  private httpServer?: Server
  private wss?: WebSocketServer
  private connection?: RouteConnection
  private pending = new Map<string, PendingCommand>()
  private queue: Promise<unknown> = Promise.resolve()
  private running = false
  private lastError?: string
  private connectedAt?: number

  constructor(options: RouteServerOptions) {
    this.options = options
    const entries = options.capabilityEntries
    this.material = {
      endpoint: '',
      proof: randomBytes(32).toString('base64url'),
      context_ref: 'dsh-local',
      principal_ref: 'dsh-local',
      runtime_ref: 'dsh-local',
      game_session_ref: 'dsh-local',
      game_instance_nonce: randomBytes(16).toString('hex'),
      generation: 1,
      binding_ref: 'dsh-local',
      binding_version: 1,
      lease_epoch: 1,
      capability_digest: computeCapabilitySnapshotDigest(entries),
      capability_entries: entries,
    }
  }

  status(): RouteStatus {
    return {
      running: this.running,
      connected: Boolean(this.connection?.ready),
      endpoint: this.material.endpoint || undefined,
      rendezvousPath: this.options.rendezvousPath,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    await this.ensureRendezvousIsFree()
    const directory = dirname(this.options.rendezvousPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try { chmodSync(directory, 0o700) } catch { /* best effort */ }

    this.httpServer = createServer()
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = this.httpServer.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('failed to allocate a loopback port')
    }
    this.material.endpoint = 'ws://127.0.0.1:' + address.port
    this.publishRendezvous()
    this.running = true
    this.lastError = undefined
    this.log('route listening on ' + this.material.endpoint)
  }

  async stop(): Promise<void> {
    this.running = false
    this.connectedAt = undefined
    this.rejectAll(new RouteUnavailableError('the local game route stopped'))
    try { this.connection?.helloDeadline.unref() } catch { /* ignore */ }
    try { this.connection?.socket.close() } catch { /* ignore */ }
    this.connection = undefined
    try { this.wss?.close() } catch { /* ignore */ }
    this.wss = undefined
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        const server = this.httpServer!
        server.close(() => resolve())
        setTimeout(() => resolve(), 500).unref()
      })
    }
    this.httpServer = undefined
    this.removeOwnedRendezvous()
  }

  command(
    capability: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<LocalCommandResult> {
    const run = this.queue.then(
      () => this.executeCommand(capability, params, timeoutMs),
      () => this.executeCommand(capability, params, timeoutMs),
    )
    this.queue = run.catch(() => undefined)
    return run
  }

  private executeCommand(
    capability: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<LocalCommandResult> {
    const connection = this.connection
    if (!connection?.ready || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RouteUnavailableError())
    }
    const commandId = 'cmd_' + randomUUID()
    const frame = buildLocalCommand(
      this.material, capability, params, commandId, timeoutMs,
    )
    return new Promise<LocalCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(new RouteTimeoutError(capability + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      timer.unref()
      this.pending.set(commandId, { resolve, reject, timer })
      try {
        connection.socket.send(JSON.stringify(frame))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(commandId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleConnection(socket: WebSocket): void {
    if (this.connection?.ready) {
      socket.close(1008, 'another game route is already connected')
      return
    }
    const helloDeadline = setTimeout(() => {
      try { socket.close(1008, 'local_direct_hello timeout') } catch { /* ignore */ }
    }, 10000)
    helloDeadline.unref()
    const connection: RouteConnection = { socket, ready: false, helloDeadline }
    this.connection = connection

    socket.on('message', (data) => this.handleMessage(connection, data.toString()))
    socket.on('close', () => {
      clearTimeout(helloDeadline)
      if (this.connection === connection) {
        this.connection = undefined
        this.connectedAt = undefined
        this.rejectAll(new RouteUnavailableError('the game disconnected'))
      }
    })
    socket.on('error', (error) => {
      this.log('socket error: ' + error.message)
    })
  }

  private handleMessage(connection: RouteConnection, raw: string): void {
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }
    if (typeof frame !== 'object' || frame === null) return
    const value = frame as Record<string, unknown>
    if (!connection.ready) {
      if (value.type !== 'local_direct_hello') return
      if (value.proof !== this.material.proof) {
        this.log('rejected local_direct_hello: invalid proof')
        try { connection.socket.close(1008, 'invalid proof') } catch { /* ignore */ }
        return
      }
      clearTimeout(connection.helloDeadline)
      connection.ready = true
      this.connectedAt = Date.now()
      connection.socket.send(JSON.stringify({
        type: 'local_direct_ready',
        reconnect_proof: randomBytes(32).toString('base64url'),
      }))
      this.log('game connected via local_direct')
      return
    }
    if (isLocalCommandResult(value)) {
      const pending = this.pending.get(value.command_id)
      if (!pending) return
      const state = String(value.state ?? '')
      if (!isTerminalState(state)) return
      clearTimeout(pending.timer)
      this.pending.delete(value.command_id)
      pending.resolve({ ...value, state })
    }
  }

  private rejectAll(error: Error): void {
    for (const [commandId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(commandId)
    }
  }

  private publishRendezvous(): void {
    const temp = this.options.rendezvousPath + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify(this.material), { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* best effort */ }
    renameSync(temp, this.options.rendezvousPath)
    try { chmodSync(this.options.rendezvousPath, 0o600) } catch { /* best effort */ }
  }

  private async ensureRendezvousIsFree(): Promise<void> {
    if (!existsSync(this.options.rendezvousPath)) return
    try {
      const existing = JSON.parse(readFileSync(this.options.rendezvousPath, 'utf8')) as RendezvousMaterial
      const parsed = parseEndpoint(String(existing.endpoint ?? ''))
      if (parsed && await isPortOpen(parsed.host, parsed.port)) {
        throw new Error('another StarCoPlay route is already running')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('already running')) throw error
    }
    rmSync(this.options.rendezvousPath, { force: true })
  }

  private removeOwnedRendezvous(): void {
    try {
      if (!existsSync(this.options.rendezvousPath)) return
      const existing = JSON.parse(readFileSync(this.options.rendezvousPath, 'utf8')) as RendezvousMaterial
      if (existing.proof === this.material.proof) {
        rmSync(this.options.rendezvousPath, { force: true })
      }
    } catch { /* ignore */ }
  }

  private log(message: string): void {
    this.options.logger?.(message)
  }
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  try {
    const url = new URL(endpoint)
    const port = Number(url.port)
    if (url.hostname && Number.isInteger(port) && port > 0) {
      return { host: url.hostname, port }
    }
  } catch { /* try host:port */ }
  const parts = endpoint.split(':')
  const port = Number(parts[1])
  if (parts[0] && Number.isInteger(port) && port > 0) {
    return { host: parts[0], port }
  }
  return null
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
