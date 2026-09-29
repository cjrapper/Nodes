# 动画系统

> 状态：**大纲（未填内容）**。客户端每天用，本库目前零覆盖。

## 1. Animator / Animation Clip / 动画状态机

- 一个 Animator 的内部结构（State / Transition / Parameter）
- `StateMachineBehaviour` 是什么，能不能拿来改逻辑状态

## 2. 逻辑状态机 vs 动画状态机：谁是权威

- 两套状态机不一致 = 「走路时能开枪但动画还在走」这类 bug 的根源
- 常见做法：逻辑驱动动画参数，动画事件回调逻辑
- 面试会问：「逻辑状态和 Animator 状态谁是权威？」

## 3. 过渡、混合树、Layer、Avatar Mask

- Blend Tree 的适用场景（走/跑/冲刺的速度混合）
- Layer + Mask：上半身和下半身分开

## 4. Root Motion vs 代码位移

- Root Motion 的原理，什么时候用
- 和代码位移 / 物理位移冲突怎么办
- 面试会问：「Root Motion 和代码位移冲突怎么办？」

## 5. IK（OnAnimatorIK）

- 手扶墙 / 脚踩地面高度对齐
- 与 LateUpdate 的配合（接《Unity 生命周期与时序坑点》）

## 6. Playable API / Timeline

- 什么时候需要越过 Animator 直接用 Playable

## 7. 性能

- Culling Mode、Optimize GameObject
- Animator 数量对主线程的开销
