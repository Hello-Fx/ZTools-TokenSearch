import type { BrowserWindow, WebContentsView } from 'electron'
import { setPluginInstanceContext } from '../core/commands/pluginLaunchContext'

// 装配会话状态
export type AssemblyStatus =
  | 'idle'
  | 'assembling'
  | 'domReady'
  | 'readyToDisplay'
  | 'displayed'
  | 'aborted'

// 单次插件装配会话
export interface AssemblySession {
  /** 装配会话唯一 ID */
  id: string
  /** 插件路径 */
  pluginPath: string
  /** 功能码 */
  featureCode: string
  /** 当前装配状态 */
  status: AssemblyStatus
  /** 会话创建时间戳（毫秒） */
  createdAt: number
}

// 插件进入事件基础参数
export interface EnterPayload {
  /** 插件功能码 */
  code: string
  /** 启动类型（如 text/files/img 等） */
  type: string
  /** 启动负载数据 */
  payload: any
  /** 可选扩展参数 */
  option?: any
}

// 带装配元信息的进入参数
export interface EnterPayloadWithAssembly extends EnterPayload {
  /** 关联的装配会话 ID */
  __assemblyId?: string
  /** 进入事件生成时间戳（毫秒） */
  __ts: number
}

// 统一生命周期事件名
export type LifecycleEventName = 'PluginReady' | 'PluginEnter' | 'PluginOut' | 'PluginDetach'

export class PluginAssemblyCoordinator {
  // 当前有效装配会话
  private currentSession: AssemblySession | null = null
  // 按 webContents 维度串行化生命周期事件，避免交错
  private lifecycleChains = new Map<number, Promise<void>>()
  // 已触发 dom-ready 的视图集合
  private domReadyViews = new Set<number>()

  /**
   * 统一装配链路日志
   */
  public trace(
    stage: string,
    info: { assemblyId?: string; pluginPath?: string; featureCode?: string; [key: string]: any }
  ): void {
    console.log('[插件][装配][追踪]', {
      stage,
      ...info
    })
  }

  /**
   * 生成新的装配会话 ID
   */
  private newAssemblyId(): string {
    return `asm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * 开始新装配会话，并中断旧会话
   */
  public beginAssembly(pluginPath: string, featureCode: string): AssemblySession {
    const old = this.currentSession
    if (old) {
      // 新会话开始时，旧会话必须立即失效，避免异步回调串线
      old.status = 'aborted'
      this.trace('abort-previous', {
        assemblyId: old.id,
        pluginPath: old.pluginPath,
        featureCode: old.featureCode,
        previousStatus: old.status
      })
    }

    const session: AssemblySession = {
      id: this.newAssemblyId(),
      pluginPath,
      featureCode,
      status: 'assembling',
      createdAt: Date.now()
    }
    this.currentSession = session

    // 会话创建后立即写 trace，便于后续跨异步链路排查
    this.trace('begin', {
      assemblyId: session.id,
      pluginPath,
      featureCode,
      createdAt: session.createdAt
    })

    return session
  }

  /**
   * 是否存在当前装配会话
   */
  public hasCurrentSession(): boolean {
    return !!this.currentSession
  }

  /**
   * 获取当前会话（可能为空）
   */
  public getCurrentSession(): AssemblySession | null {
    return this.currentSession
  }

  /**
   * 判断回调是否仍属于当前活动会话
   */
  public isActiveSession(session: AssemblySession): boolean {
    return (
      !!this.currentSession &&
      this.currentSession.id === session.id &&
      this.currentSession.status !== 'aborted'
    )
  }

  /**
   * 更新当前会话状态
   */
  public markSessionStatus(session: AssemblySession, status: AssemblyStatus): void {
    if (!this.isActiveSession(session)) return
    const previousStatus = this.currentSession!.status
    this.currentSession!.status = status
    this.trace('status-change', {
      assemblyId: session.id,
      pluginPath: session.pluginPath,
      featureCode: session.featureCode,
      from: previousStatus,
      to: status
    })
  }

  /**
   * 仅标记当前会话为 aborted（不清空引用）
   */
  public abortCurrentSession(stage: string = 'abort-current-session'): void {
    if (!this.currentSession) return
    this.currentSession.status = 'aborted'
    this.trace(stage, {
      assemblyId: this.currentSession.id,
      pluginPath: this.currentSession.pluginPath,
      featureCode: this.currentSession.featureCode
    })
  }

  /**
   * 清空当前会话引用
   */
  public clearCurrentSession(): void {
    this.currentSession = null
  }

  /**
   * 生成用于渲染回执比对的 token
   */
  public getSessionToken(session: AssemblySession): string {
    return `${session.pluginPath}::${session.featureCode}::${session.id}`
  }

  /**
   * 构建带装配元信息的 PluginEnter 参数
   */
  public buildEnterPayload(
    action: EnterPayload,
    session?: AssemblySession
  ): EnterPayloadWithAssembly {
    const payload: EnterPayloadWithAssembly = {
      ...action,
      __assemblyId: session?.id,
      __ts: Date.now()
    }
    this.trace('build-enter-payload', {
      assemblyId: session?.id,
      enterTs: payload.__ts
    })
    return payload
  }

  /**
   * 向主渲染请求 ack，确认当前装配请求仍有效
   */
  public async requestRendererAck(
    mainWindow: BrowserWindow | null,
    session: AssemblySession
  ): Promise<boolean> {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) {
      this.trace('ack-skip-main-window-unavailable', {
        assemblyId: session.id,
        pluginPath: session.pluginPath,
        featureCode: session.featureCode
      })
      return false
    }

    const token = this.getSessionToken(session)
    const startAt = Date.now()
    this.trace('ack-request-start', {
      assemblyId: session.id,
      pluginPath: session.pluginPath,
      featureCode: session.featureCode,
      token
    })

    try {
      // 第一步：通知主渲染“当前装配目标 token”
      await mainWindow.webContents.executeJavaScript(
        `window.ztools?.setAssemblyTarget?.(${JSON.stringify(token)})`
      )
      // 第二步：读取主渲染回执 token，确保主/插件视图状态一致
      const returned = await mainWindow.webContents.executeJavaScript(
        `window.ztools?.endAssemblyPlugin?.()`
      )
      // 只有 token 一致才允许继续展示/进入插件
      const ok = returned === token
      this.trace('ack-request-finish', {
        assemblyId: session.id,
        pluginPath: session.pluginPath,
        featureCode: session.featureCode,
        token,
        returned,
        ok,
        durationMs: Date.now() - startAt
      })

      if (!ok) {
        console.warn('[插件][装配] 回执 token 不匹配:', {
          assemblyId: session.id,
          expected: token,
          returned
        })
      }
      return ok
    } catch (error) {
      console.error('[插件][装配] 请求回执失败:', error)
      return false
    }
  }

  /**
   * 串行派发生命周期事件，防止 PluginOut/PluginEnter 交错
   * @param view 接收事件的插件实例
   * @param eventName 生命周期名称
   * @param payload 本次调用的不可变进入参数或退出状态
   * @returns 事件派发完成的 Promise
   */
  public async dispatchLifecycleEvent(
    view: WebContentsView,
    eventName: LifecycleEventName,
    payload?: any
  ): Promise<void> {
    const webContents = view?.webContents
    if (!webContents || webContents.isDestroyed()) {
      console.warn('[插件][生命周期] 跳过派发：视图不可用或已销毁', { eventName })
      return
    }

    const id = webContents.id
    const prev = this.lifecycleChains.get(id) ?? Promise.resolve()
    const hasQueued = this.lifecycleChains.has(id)
    console.log('[插件][生命周期] 事件入队', {
      webContentsId: id,
      eventName,
      hasQueued
    })
    const next = prev
      .catch(() => {})
      .then(() => {
        if (webContents.isDestroyed()) return
        console.log('[插件][生命周期] 派发事件', { webContentsId: id, eventName })

        if (eventName === 'PluginEnter') {
          setPluginInstanceContext(webContents, payload)
          webContents.send('on-plugin-enter', payload)
          return
        }
        if (eventName === 'PluginOut') {
          webContents.send('plugin-out', !!payload)
          return
        }
        if (eventName === 'PluginDetach') {
          webContents.send('plugin-detach')
          return
        }
        webContents.send('plugin-ready', payload)
      })
    // 串行关键点：同一 webContents 的下一个事件必须等待上一个完成
    this.lifecycleChains.set(id, next)

    try {
      await next
      console.log('[插件][生命周期] 事件完成', { webContentsId: id, eventName })
    } finally {
      if (this.lifecycleChains.get(id) === next) {
        this.lifecycleChains.delete(id)
        console.log('[插件][生命周期] 队列清空', { webContentsId: id, eventName })
      }
    }
  }

  /**
   * 标记视图已完成 dom-ready
   */
  public markDomReady(webContentsId: number): void {
    this.domReadyViews.add(webContentsId)
  }

  /**
   * 清理视图 dom-ready 标记
   */
  public clearDomReady(webContentsId: number): void {
    this.domReadyViews.delete(webContentsId)
  }

  /**
   * 等待视图进入 dom-ready（含已就绪命中与超时兜底）
   */
  public async waitForDomReady(view: WebContentsView, timeoutMs: number = 5000): Promise<void> {
    const webContents = view.webContents
    if (webContents.isDestroyed()) {
      console.warn('[插件][DomReady] 跳过等待：webContents 已销毁')
      return
    }
    if (this.domReadyViews.has(webContents.id)) {
      console.log('[插件][DomReady] 命中已就绪缓存', {
        webContentsId: webContents.id
      })
      return
    }

    console.log('[插件][DomReady] 开始等待', {
      webContentsId: webContents.id,
      timeoutMs
    })

    await new Promise<void>((resolve) => {
      let done = false
      const startedAt = Date.now()
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timeout)
        console.log('[插件][DomReady] 等待结束', {
          webContentsId: webContents.id,
          durationMs: Date.now() - startedAt
        })
        resolve()
      }

      const timeout = setTimeout(() => {
        // 兜底：防止某些复用场景下 dom-ready 监听不到造成永久等待
        console.warn('[插件][DomReady] 触发超时兜底', {
          webContentsId: webContents.id,
          timeoutMs
        })
        finish()
      }, timeoutMs)

      webContents.once('dom-ready', () => {
        // 首次就绪后做缓存，后续可直接命中快速返回
        this.markDomReady(webContents.id)
        console.log('[插件][DomReady] 收到 dom-ready 事件', { webContentsId: webContents.id })
        finish()
      })
    })
  }
}
