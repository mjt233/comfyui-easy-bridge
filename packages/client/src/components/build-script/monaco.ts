import * as monaco from 'monaco-editor';
import type { Environment } from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

// Vite worker 配置：Monaco 依赖 Web Worker 提供语法高亮与语言服务
// 注意：monaco-editor >= 0.52 的 exports 映射 `"./*": "./esm/vs/*.js"` 要求子路径不带 `esm/vs/` 前缀
const env: Environment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') {
      // TS/JS 走专用 worker
      return new tsWorker();
    }
    if (label === 'json') {
      // JSON 走专用 worker：提供校验/折叠/文档符号等语言服务
      return new jsonWorker();
    }
    return new editorWorker();
  },
};
(globalThis as unknown as { MonacoEnvironment?: Environment }).MonacoEnvironment = env;

/** 动态构建脚本 API 类型声明在编辑器中的文件名（同名覆盖） */
const BUILD_API_LIB_FILENAME = 'comfy-build-api.d.ts';

/**
 * 注册/更新动态构建脚本 API 类型声明到 Monaco（幂等，重复调用覆盖）。
 * @param dts 服务端下发的 d.ts 文本
 */
export function registerBuildApiTypes(dts: string): void {
  // monaco-editor >= 0.52 将 languages.typescript 提升为顶层 monaco.typescript 命名空间
  monaco.typescript.typescriptDefaults.addExtraLib(dts, BUILD_API_LIB_FILENAME);
}

export { monaco };
