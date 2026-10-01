/**
 * 前端批量任务的并发控制工具。
 *
 * 背景：一次「批量探测」类操作（例如系统设置页的一键测试）可能同时命中十几条远端请求，
 * 既会给执行端带来瞬时压力，也会让单个请求的超时更容易被放大。
 * 因此需要把一批任务按固定并发上限投递，同时保证某个条目失败不影响其余条目。
 */

/**
 * 按固定并发上限执行一批任务。
 *
 * 语义要点：
 * - 投递顺序与 `items` 顺序一致（先启动的 worker 先领取前面的条目）；
 * - 单个条目失败**不会**中断整批任务，也不会让本函数 reject（同 `Promise.allSettled` 的容错口径），
 *   失败信息由调用方在自己的 worker 内部记录；
 * - `items` 为空时立即 resolve。
 * @param items 待处理条目（只读数组，函数不会修改它）
 * @param limit 并发上限（非法值按 1 处理，即退化为串行）
 * @param worker 单条目处理函数（建议内部自行 try/catch 并记录失败）
 * @returns 全部条目处理结束后 resolve 的 Promise
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  // 并发上限兜底：0 / 负数 / NaN 一律按 1 处理，避免出现 0 个 worker 而永久等待
  const concurrency = Math.max(1, Math.floor(limit) || 1);
  // 下一个待领取的条目下标；多个 worker 共享，靠 JS 单线程模型保证同一条目不会被领取两次
  let cursor = 0;

  /**
   * 单个 worker 的执行循环：不断领取下一条目直到全部取完。
   */
  async function drain(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index]);
      } catch {
        // 单条目异常不应影响其余条目：此处吞掉，失败原因由 worker 自身负责记录
      }
    }
  }

  // 按并发上限启动 worker（条目少于上限时只需与条目数相同的 worker），等待全部结束
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => drain()));
}
