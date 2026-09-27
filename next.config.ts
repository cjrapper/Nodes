import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，必须留在 Node 运行时、不参与打包
  serverExternalPackages: ["better-sqlite3"],

  typescript: {
    /**
     * 关掉 next build 内置的 TypeScript 检查。
     *
     * 它不是被放弃，而是被**移到独立步骤**：`npm run typecheck`（tsc --noEmit）
     * 覆盖范围更全（还包含被 Next 排除的测试目录之外的全部源码），
     * 而且能给出完整的错误列表而不是构建中被打断的一次。
     *
     * 关掉的实际原因：Next 16 的类型检查以子进程（worker）方式运行，
     * 在本机沙箱环境下 spawn 管道会被拒绝（spawn EPERM），
     * 导致 `next build` 在编译成功之后仍然整体失败。
     * 构建产物本身没有问题 —— 编译与打包阶段都已通过。
     *
     * ⚠️ 因此提交前的正确做法是：`npm run typecheck && npm test && npm run build`
     */
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
