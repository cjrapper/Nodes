# 物理系统

> 状态：**大纲（未填内容）**。《堆栈内存与 GC 卡顿溯源》里已出现 `RaycastNonAlloc` 一段，是最好的引子 —— 但那篇讲的是 GC，没把物理系统成篇。

## 1. Rigidbody 与运动学

- Dynamic / Kinematic / Static 的区别
- 什么时候用 Kinematic（不走物理模拟，只要碰撞检测）
- 面试会问：「Kinematic 和 Dynamic 区别？」

## 2. Collider

- 各种 Collider 的开销差异（Box < Sphere < Capsule < Mesh）
- Mesh Collider 的代价与 Convex 的用途
- Trigger vs Collision

## 3. 射线检测

- `Raycast` / `RaycastAll` / `RaycastNonAlloc` 的分配差异
- 为什么热路径要用 NonAlloc（接《对象池》§2 的 GC 模型）
- Layer Mask 与 `Physics.queriesHitTriggers`

## 4. 物理帧

- `FixedUpdate` 与 `Time.fixedDeltaTime`（接《Unity 生命周期与时序坑点》）
- 输入与物理分离（按键不能被 FixedUpdate 吞）

## 5. Layer 碰撞矩阵

- 碰撞矩阵怎么配，为什么比代码里 `if` 判断更高效

## 6. 常见坑（待补充，先留位）

- 物理与动画 / Root Motion 打架
- 高速物体穿透（连续检测）
