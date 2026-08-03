/**
 * 动态构建脚本执行 worker 的源码。
 * 以纯 JS 字符串内嵌（无 import/export），经 eval:true 模式运行，
 * 仅依赖 Node 内建模块（worker 内无法解析第三方包，转译在主线程完成）。
 * 辅助函数实现必须与 build-script-api.ts 的 d.ts 声明保持一致。
 */
export const BUILD_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 判断值是否为 ComfyUI 连线引用 [nodeId, slot] */
function isConnection(value) {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/** 深拷贝工作流 */
function cloneWorkflow(workflow) {
  return JSON.parse(JSON.stringify(workflow));
}

/**
 * 创建构建上下文：深拷贝 workflow + 辅助函数。
 * @param {object} workflow 原始工作流
 * @param {object} params 用户提交参数
 * @param {object} files 上传文件元数据（按别名分组）
 * @param {Array} baseParams DB 静态参数配置副本（可作为声明返回的起点）
 * @returns {object} BuildContext
 */
function createContext(workflow, params, files, baseParams) {
  const wf = cloneWorkflow(workflow);
  return {
    workflow: wf,
    params,
    files,
    baseParams,
    addNode(nodeId, classType, inputs, title) {
      if (Object.prototype.hasOwnProperty.call(wf, nodeId)) {
        throw new Error('addNode: node "' + nodeId + '" already exists');
      }
      const node = { inputs: Object.assign({}, inputs || {}), class_type: classType };
      // 第 4 个参数 title 可选：一并设置 _meta.title，免去二次 setTitle
      if (title !== undefined) {
        node._meta = { title };
      }
      wf[nodeId] = node;
      // 返回节点实例，方便脚本继续修改该节点
      return node;
    },
    removeNode(nodeId) {
      if (!wf[nodeId]) throw new Error('removeNode: node "' + nodeId + '" not found');
      for (const node of Object.values(wf)) {
        for (const [field, value] of Object.entries(node.inputs)) {
          if (isConnection(value) && value[0] === nodeId) {
            node.inputs[field] = null;
          }
        }
      }
      delete wf[nodeId];
    },
    connect(sourceNodeId, sourceSlot, targetNodeId, targetField) {
      if (!wf[sourceNodeId]) throw new Error('connect: source node "' + sourceNodeId + '" not found');
      if (!wf[targetNodeId]) throw new Error('connect: target node "' + targetNodeId + '" not found');
      if (typeof sourceSlot !== 'number') throw new Error('connect: source slot must be a number');
      wf[targetNodeId].inputs[targetField] = [sourceNodeId, sourceSlot];
    },
    disconnect(targetNodeId, targetField, fallbackValue) {
      if (!wf[targetNodeId]) throw new Error('disconnect: node "' + targetNodeId + '" not found');
      wf[targetNodeId].inputs[targetField] = fallbackValue === undefined ? null : fallbackValue;
    },
    setInput(nodeId, field, value) {
      if (!wf[nodeId]) throw new Error('setInput: node "' + nodeId + '" not found');
      wf[nodeId].inputs[field] = value;
    },
    getInput(nodeId, field) {
      const node = wf[nodeId];
      return node ? node.inputs[field] : undefined;
    },
    findNodesByClass(classType) {
      return Object.keys(wf).filter((id) => wf[id].class_type === classType);
    },
    getNode(nodeId) {
      return wf[nodeId];
    },
    setTitle(nodeId, title) {
      const node = wf[nodeId];
      if (!node) throw new Error('setTitle: node "' + nodeId + '" not found');
      if (!node._meta) node._meta = {};
      node._meta.title = title;
    },
  };
}

/** 运行用户脚本并回传结果 */
async function run() {
  try {
    const { jsCode, params, workflow, baseParams, filesMeta } = workerData;
    const tmpFile = path.join(
      os.tmpdir(),
      'comfy-build-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.cjs',
    );
    fs.writeFileSync(tmpFile, jsCode, 'utf8');
    let buildFn = null;
    try {
      const mod = require(tmpFile);
      buildFn = typeof mod.default === 'function' ? mod.default : (typeof mod === 'function' ? mod : null);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (err) { /* 忽略清理失败 */ }
    }
    if (typeof buildFn !== 'function') {
      parentPort.postMessage({ ok: false, error: '脚本必须通过 export default 导出一个构建函数' });
      return;
    }
    const ctx = createContext(workflow, params, filesMeta, baseParams);
    const result = await buildFn(ctx);
    // 声明式返回：{ workflow, params }；workflow 必须对象，params 缺省时保持 undefined（由主线程回退 DB 参数）
    const workflowResult = result && typeof result === 'object' && !Array.isArray(result) ? result.workflow : null;
    if (!workflowResult || typeof workflowResult !== 'object' || Array.isArray(workflowResult)) {
      parentPort.postMessage({ ok: false, error: '构建函数必须返回 { workflow, params }，且 workflow 必须是工作流对象' });
      return;
    }
    // params 必须是数组；脚本省略时返回 undefined，由主线程回退 baseParams（避免误丢全部静态参数）
    const paramsResult = Array.isArray(result.params) ? result.params : undefined;
    parentPort.postMessage({ ok: true, workflow: workflowResult, params: paramsResult });
  } catch (err) {
    // 使用完整 stack（首行已含 "Error: message"），避免消息重复
    const msg = (err && err.stack) ? err.stack : String(err);
    parentPort.postMessage({ ok: false, error: msg });
  }
}

run();
`;
