# Unity 渲染管线（SRP / URP）

> 状态：**大纲（未填内容）**。与《Unity 渲染管线基础》的区别：那篇是 Built-in 时代的概念（Draw Call / Batch / Overdraw），这篇补 SRP 之后的架构与选型。

## 1. 渲染管线是什么，为什么有 SRP

- 从 Built-in 的硬编码管线到可编程管线（Scriptable Render Pipeline）
- 一个 `ScriptableRenderer` 的调用顺序（概念层即可）

## 2. Built-in vs URP vs HDRP

- 各自定位：移动端 / 中高端 / 3A
- 切换代价：Shader 要重写、Asset 要迁移、第三方插件兼容性

## 3. 前向 vs 延迟渲染

- 各自适用场景（光源数量、带宽、MRT）
- 移动端几乎只用前向，为什么

## 4. Draw Call 与合批

- 静态合批 / 动态合批 / SRP Batcher / GPU Instancing
- 各自的条件与失效场景（材质、顶点数、缩放）
- 面试会问：「Draw Call 怎么降？合批为什么会失效？」

## 5. 渲染状态切换、材质、图集

- SetPass Call 才是真正的指标（不是 Draw Call 本身）
- 图集打得好不好，怎么判断

## 6. Overdraw / 透明排序 / ZWrite / ZTest

- 半透明的排序问题
- UI 的 Overdraw 与 UGUI 的关系（接《UGUI 渲染原理与性能刺客》）

## 7. Shader Variant 与变体爆炸

- 变体从哪来、怎么爆、怎么控制（`shader_feature` vs `multi_compile`）
- 打包体积的影响

## 8. URP 下的常见坑（待补充，先留位）
