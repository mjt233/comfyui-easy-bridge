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
 * @returns {object} BuildContext
 */
function createContext(workflow, params) {
  const wf = cloneWorkflow(workflow);
  return {
    workflow: wf,
    params,
    addNode(nodeId, classType, inputs) {
      if (Object.prototype.hasOwnProperty.call(wf, nodeId)) {
        throw new Error('addNode: node "' + nodeId + '" already exists');
      }
      wf[nodeId] = { inputs: Object.assign({}, inputs || {}), class_type: classType };
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
    const { jsCode, params, workflow } = workerData;
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
    const ctx = createContext(workflow, params);
    const result = await buildFn(ctx);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      parentPort.postMessage({ ok: false, error: '构建函数必须返回工作流对象' });
      return;
    }
    parentPort.postMessage({ ok: true, workflow: result });
  } catch (err) {
    // 使用完整 stack（首行已含 "Error: message"），避免消息重复
    const msg = (err && err.stack) ? err.stack : String(err);
    parentPort.postMessage({ ok: false, error: msg });
  }
}

run();
`;
