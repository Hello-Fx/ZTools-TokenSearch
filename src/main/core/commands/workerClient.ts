import type { Worker } from 'node:worker_threads'
import type {
  CommandCatalog,
  CommandCatalogInput,
  CommandSearchRequest,
  CommandSearchResult,
  CommandUserState
} from '../../../shared/commandService'

/**
 * 管理隔离搜索线程；超时销毁线程并在下次任务恢复目录。
 */
export class SearchWorkerClient {
  private worker: Worker | undefined
  private sequence = 0
  private ready: Promise<CommandCatalog> | undefined
  private input: CommandCatalogInput | undefined
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  /**
   * 注入线程工厂和计算预算，便于真实线程测试。
   * @param factory 创建 Worker 的函数
   * @param queryTimeout 查询超时毫秒数
   * @returns 客户端实例
   */
  constructor(
    private factory: () => Worker,
    private queryTimeout = 1000
  ) {}

  /**
   * 发布完整目录，调用方只在成功后替换可见快照。
   * @param input 原始目录来源
   * @returns 已完成索引的目录
   */
  publish(input: CommandCatalogInput): Promise<CommandCatalog> {
    this.input = input
    this.ready = this.call({ type: 'catalog', input }, 15000)
    return this.ready
  }

  /**
   * 等待索引恢复后计算查询。
   * @param request 查询快照
   * @param state 用户缓存快照
   * @param revision 目录版本
   * @returns 查询结果
   * @throws 线程超时、崩溃或未初始化时抛错
   */
  async query(
    request: CommandSearchRequest,
    state: CommandUserState,
    revision: number
  ): Promise<CommandSearchResult> {
    if (!this.ready && this.input)
      this.ready = this.call({ type: 'catalog', input: this.input }, 15000)
    await this.ready
    return this.call({ type: 'query', request, state, revision }, this.queryTimeout)
  }

  /**
   * 发送任务并用主线程定时器限制执行时间。
   * @param message 可序列化任务
   * @param timeout 执行预算
   * @returns 线程任务返回值
   */
  private call(message: object, timeout: number): Promise<any> {
    if (!this.worker) {
      const worker = this.factory()
      this.worker = worker
      worker.unref()
      worker.on('message', (response) => {
        const task = this.pending.get(response.id)
        if (!task) return
        clearTimeout(task.timer)
        this.pending.delete(response.id)
        if (response.error) task.reject(new Error(response.error))
        else task.resolve(response.value)
      })
      worker.on('error', (error) => {
        if (this.worker === worker) this.reset(error)
      })
      worker.on('exit', (code) => {
        if (this.worker === worker) this.reset(new Error(`搜索线程退出: ${code}`))
      })
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error('搜索计算超时，已终止搜索线程')), timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ ...message, id })
    })
  }

  /**
   * 释放线程并拒绝所有排队任务，不将阻塞正则带入恢复线程。
   * @param error 本批次失败原因
   * @returns 无返回值
   */
  private reset(error: Error): void {
    const worker = this.worker
    this.worker = undefined
    this.ready = undefined
    void worker?.terminate()
    for (const task of this.pending.values()) {
      clearTimeout(task.timer)
      task.reject(error)
    }
    this.pending.clear()
  }

  /**
   * 应用退出时结束线程和待处理任务。
   * @returns 无返回值
   */
  dispose(): void {
    this.reset(new Error('搜索服务已关闭'))
  }
}
