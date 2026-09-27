/**
 * 测试用模块解析钩子。
 *
 * 解决两个 Node 原生跑不了的问题：
 *
 *  1. **无扩展名导入** —— 源码里用的是 Next.js 风格（`from "../tokens"`），
 *     而 Node 的 ESM 解析要求显式扩展名。补上 `.ts` / `.tsx` / `/index.ts` 候选，
 *     让同一份源码既能被 Next 打包，也能被 node 直接跑测试。
 *
 *  2. **`.tsx` 里的 JSX** —— Node 的 strip-only 类型擦除不支持 JSX
 *     （会报 ERR_UNKNOWN_FILE_EXTENSION）。这里用项目里已装的 TypeScript
 *     编译器把 `.tsx` 转译成 JS，走 react-jsx 运行时。
 *
 *     为什么值得做这件事：没有这一步，就**无法对 React 组件写测试**，
 *     而"渲染循环"这类缺陷恰恰只能靠渲染组件才能发现 —— 它不会让类型检查
 *     报错、也不会让纯函数测试失败，只会在浏览器里疯狂闪烁。
 *     项目里真实发生过一次（内联回调被当成 useEffect 依赖），所以补上了。
 *
 * 用法：`node --experimental-strip-types --import ./tests/ts-resolve.mjs <entry>`
 *     （`.ts` 仍走 Node 原生擦除，只有 `.tsx` 才过 TS 转译器）
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const CANDIDATES = [".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];

/** 项目根目录：本文件在 <root>/tests/ 下 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 把 file: URL 还原成磁盘路径，**丢掉查询串与片段**。
 *
 * `fileURLToPath` 会把 `?x=1` 当成路径的一部分（`/a/b.ts?x=1`），于是
 * `existsSync` 永远为假，解析会静默回退到 Node 的默认逻辑。
 *
 * 为什么会在意：迁移测试用 `import("...index.ts?legacy=1")` 来强制拿到
 * 一份**独立的模块实例**（ESM 把不同 URL 视为不同模块），借此在同一个
 * 进程里换工作目录跑真实的生产代码。钩子若不剥掉 query，这个技巧就失效 ——
 * 表现是"拿到了另一个测试已经 seed 过的模块"，排查起来非常绕。
 */
function urlToPath(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return fileURLToPath(parsed.href);
}

/**
 * 展开 Next.js 的路径别名 `@/*` → `<root>/src/*`。
 *
 * 源码里用的是 `import { api } from "@/lib/ui/client"`，这个别名由 Next 的
 * tsconfig paths 解析，Node 不认识。不处理的话无法对组件做测试。
 */
function expandAlias(specifier) {
  if (specifier === "@") return repoRoot;
  if (specifier.startsWith("@/")) {
    // 注意用 path.resolve 而不是 path.join：path.join 遇到绝对路径段会被
    // 折叠掉，反而得到错误结果
    return path.resolve(repoRoot, "src", specifier.slice(2));
  }
  return null;
}

/** 只转译一次；同一个文件在一次测试进程里可能被多次 import */
const transpileCache = new Map();

function transpileTsx(source, fileName) {
  const output = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      // react-jsx 会注入 `import { jsx } from "react/jsx-runtime"`，
      // 不需要在文件顶部手写 React import
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // isolatedModules 语义：单文件转译，不做跨文件类型推导
      isolatedModules: true,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });

  const errors = (output.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const detail = errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
      .join("; ");
    throw new Error(`转译 ${fileName} 失败：${detail}`);
  }

  return output.outputText;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    /*
     * 0) 已经带扩展名的相对导入：直接放行给 Node。
     *
     * 但要**保留查询串** —— 它是"强制拿一份独立模块实例"的唯一手段
     * （ESM 视不同 URL 为不同模块）。迁移测试靠它换 cwd 跑真实代码。
     */
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const resolved = new URL(specifier, context.parentURL ?? import.meta.url);

      // 直接在 href 字符串上操作扩展名：绝对路径与查询串都能保住。
      // 拆成 pathname/origin 再拼回来在相对 URL 上会直接抛 Invalid URL。
      if (path.extname(resolved.pathname) !== "") {
        return { url: resolved.href, shortCircuit: true };
      }

      const base = resolved.href;
      const query = base.includes("?") ? base.slice(base.indexOf("?")) : "";
      const bare = query ? base.slice(0, base.indexOf("?")) : base;

      // 无扩展名 → 补 .ts / .tsx 候选
      for (const ext of CANDIDATES) {
        const candidate = `${bare}${ext}${query}`;
        if (existsSync(urlToPath(candidate))) {
          // 只改写 url，不指定 format —— 让 Node 按扩展名决定处理流程
          // （.ts 走原生类型擦除，.tsx 由下面的 load 钩子接管）
          return { url: candidate, shortCircuit: true };
        }
      }
    }

    // 1) `@/...` 别名 → 绝对路径，然后按扩展名候选解析
    const aliased = expandAlias(specifier);
    if (aliased !== null) {
      for (const ext of CANDIDATES) {
        const candidate = `${aliased}${ext}`;
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`无法解析别名导入：${specifier}（已尝试 ${aliased}{${CANDIDATES.join(",")}}）`);
    }

    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    // 注意用 pathname 判断扩展名：URL 可能带 ?query，直接 endsWith 会漏掉
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(".tsx")) {
      const fileName = urlToPath(url);
      let code = transpileCache.get(fileName);
      if (code === undefined) {
        code = transpileTsx(readFileSync(fileName, "utf8"), fileName);
        transpileCache.set(fileName, code);
      }
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
