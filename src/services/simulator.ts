import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ENGINE_MESSAGE_SOURCE } from '../constants'
import type {
  EngineRunResult,
  FleetInspectResult,
  SimFleetInput,
  SimulationInput,
} from '../types'

interface PendingRun {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onProgress?: (progress: number) => void
  timer: ReturnType<typeof setTimeout>
}

interface EngineMessage {
  source?: string
  type?: 'ready' | 'progress' | 'result' | 'error'
  id?: string
  progress?: number
  result?: unknown
  error?: string
}

class SimulatorBridge {
  private frame: HTMLIFrameElement | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private pending = new Map<string, PendingRun>()
  private nextId = 1
  private listening = false

  private handleMessage = (event: MessageEvent<EngineMessage>): void => {
    if (!this.frame || event.source !== this.frame.contentWindow) return
    const message = event.data
    if (message?.source !== ENGINE_MESSAGE_SOURCE) return
    if (message.type === 'ready') {
      this.resolveReady?.()
      this.resolveReady = null
      return
    }
    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.type === 'progress') {
      pending.onProgress?.(Math.max(0, Math.min(1, message.progress ?? 0)))
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.type === 'result' && message.result) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || '模拟器返回未知错误'))
    }
  }

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      const timer = setTimeout(() => reject(new Error('本地模拟器加载超时')), 15_000)
      const done = (): void => clearTimeout(timer)
      this.resolveReady = () => {
        done()
        resolve()
      }
    })
    if (!this.listening) {
      window.addEventListener('message', this.handleMessage)
      this.listening = true
    }
    this.frame = document.createElement('iframe')
    this.frame.setAttribute('aria-hidden', 'true')
    this.frame.style.display = 'none'
    this.frame.src = pathToFileURL(join(__dirname, 'engine', 'runner.html')).toString()
    document.body.appendChild(this.frame)
    return this.readyPromise
  }

  private async request<T>(
    type: 'run' | 'inspect',
    input: unknown,
    timeoutMs: number,
    onProgress?: (progress: number) => void,
  ): Promise<T> {
    await this.ensureReady()
    if (!this.frame?.contentWindow) throw new Error('本地模拟器窗口不可用')
    const id = `${type}-${Date.now()}-${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`模拟器请求超过 ${Math.round(timeoutMs / 1000)} 秒`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
        timer,
      })
      this.frame?.contentWindow?.postMessage(
        { source: 'poi-sortie-odds-plugin', type, id, input },
        '*',
      )
    })
  }

  run(
    input: SimulationInput,
    onProgress?: (progress: number) => void,
  ): Promise<EngineRunResult> {
    return this.request<EngineRunResult>('run', input, 120_000, onProgress)
  }

  inspect(input: {
    fleetF: SimFleetInput
    formations?: number[]
  }): Promise<FleetInspectResult> {
    return this.request<FleetInspectResult>('inspect', input, 15_000)
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('插件已卸载'))
    }
    this.pending.clear()
    this.frame?.remove()
    this.frame = null
    this.readyPromise = null
    this.resolveReady = null
    if (this.listening) window.removeEventListener('message', this.handleMessage)
    this.listening = false
  }
}

export const simulatorBridge = new SimulatorBridge()
