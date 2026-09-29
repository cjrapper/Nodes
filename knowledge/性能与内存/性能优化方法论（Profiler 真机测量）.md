# 性能优化方法论

> 状态：**大纲（未填内容）**。本库所有性能结论（对象池、GC、Draw Call、动静分离）的公共地基就是这篇 —— 它们最后都会落到「你怎么知道」。优先级最高。

## 1. 帧预算

- 目标帧率 → 每帧预算：60fps ≈ 16.6ms，30fps ≈ 33.3ms
- 预算怎么切给逻辑 / 物理 / 动画 / UI / 渲染提交 / GC / 网络
- 面试会问：「这个功能你打算花几毫秒？」

## 2. Profiler 怎么读

- CPU / GPU / Memory / Rendering 各栏分别看什么
- `GC Alloc` 列 vs 原生内存分配（不要混为一谈）
- Timeline 视图：主线程 vs 工作线程 vs 渲染线程

## 3. Editor 数据为什么不可信

- Mono vs IL2CPP 的差异
- Profiler 附加开销（Deep Profile 的失真）
- 平台差异：PC vs 移动端降频 / 发热

## 4. 埋点

- `ProfilerMarker` / `CustomSampler` 的最小用法
- 什么时候需要自建计时（不要用 `Time.time` 卡点，粒度不够）

## 5. Memory Profiler

- 快照对比（snapshot diff）定位泄漏
- 托管堆 vs 原生内存 vs 显存，分别在哪看

## 6. 真机测试

- Development Build + Autoconnect Profiler
- 低端机 / 目标机型的选取

## 7. 优化的判据（这一节的结论要背）

- 三条同时成立才做：① 真机上定位到它；② 在总预算里占比显著；③ 改动风险与工期可接受
- 面试考的是**排序能力**，不是洁癖 —— 「知道是问题但排在版本之后」是合法答案

## 8. 常见误区

- 把算法复杂度当性能（游戏瓶颈常在 cache / draw call / 内存带宽 / GC / 主线程同步点）
- 不测就优化
- 过早优化
