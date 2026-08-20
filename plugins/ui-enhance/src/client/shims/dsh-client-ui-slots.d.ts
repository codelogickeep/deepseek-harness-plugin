/**
 * ui-enhance 本地类型 stub：@deepseek-ai/dsh-client-ui-slots
 *
 * 宿主全局包不含该包、DSH checkout 未构建其 lib 类型时，用本 stub 满足
 * type-only 引用（runtime 的 index.d.ts 引用了 SnapshotSelectorHook 等）。
 * 运行时由 DSH 宿主模块表提供真实实现，本 stub 仅用于类型检查。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SnapshotSelectorHook<T = any, Out = T> = (selector?: (snapshot: T) => Out) => Out
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MaybeSnapshotSelectorHook<T = any, Out = T> = (selector?: (snapshot: T) => Out) => Out | undefined

// slots 注册相关的核心类型（与 runtime slot registry 契约对齐的最小面）
export interface SlotInfo { [key: string]: unknown }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlotComponentProps = any

/** 向 runtime 的类型合并声明空座位（补充 runtime 的 declare module）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  // 座位由 ui-slots 在编译时声明；运行时由宿主提供。
}
