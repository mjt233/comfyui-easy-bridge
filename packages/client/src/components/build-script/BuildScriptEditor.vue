<template>
  <div>
    <!-- 工具栏 -->
    <div class="d-flex align-center ga-3 mb-2 flex-wrap">
      <v-switch
        v-model="enabled"
        label="启用动态构建"
        density="compact"
        hide-details
        color="primary"
      />
      <span class="text-caption text-grey">
        保存后需启用，才会在真实执行时运行脚本
      </span>
      <v-spacer />
      <v-btn size="small" variant="tonal" @click="insertTemplate">
        插入模板
      </v-btn>
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-database-search"
        @click="nodeRefOpen = true"
      >
        节点速查
      </v-btn>
      <v-btn size="small" variant="tonal" @click="resetToSaved">
        重置
      </v-btn>
      <v-btn
        color="primary"
        variant="flat"
        :loading="saving"
        :disabled="!dirty"
        @click="save"
      >
        保存
      </v-btn>
      <v-btn color="secondary" variant="flat" @click="simulateOpen = true">
        模拟构建
      </v-btn>
    </div>

    <!-- Monaco 编辑器 -->
    <div ref="editorHost" class="build-script-editor" />

    <!-- 未保存提示 -->
    <div v-if="dirty" class="text-caption text-warning mt-1">
      有未保存的更改
    </div>

    <!-- 模拟构建对话框 -->
    <BuildSimulateDialog
      v-model="simulateOpen"
      :workflow="workflow"
      :script="editorValue"
    />

    <!-- 节点速查对话框：选择节点后插入 addNode 片段到光标处 -->
    <NodeReferenceDialog v-model="nodeRefOpen" @insert="insertAtCursor" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import type { WorkflowDetail } from '@/types';
import { getBuildApiTypes, saveBuildScript } from '@/api/workflows';
import { monaco, registerBuildApiTypes } from './monaco';
import { DEFAULT_BUILD_SCRIPT_TEMPLATE } from './buildScriptTemplate';
import BuildSimulateDialog from './BuildSimulateDialog.vue';
import NodeReferenceDialog from './NodeReferenceDialog.vue';

/** 组件 props：完整工作流详情（含 params 与 buildScript） */
const props = defineProps<{
  workflow: WorkflowDetail;
}>();

/** 组件事件：保存成功后上抛最新工作流详情 */
const emit = defineEmits<{
  saved: [workflow: WorkflowDetail];
}>();

/** 启用开关 */
const enabled = ref(props.workflow.buildScriptEnabled);
/** 编辑器当前内容 */
const editorValue = ref(props.workflow.buildScript);
/** 保存的脚本（用于重置与脏检查） */
const savedScript = ref(props.workflow.buildScript);
/** 保存的启用状态（用于重置与脏检查） */
const savedEnabled = ref(props.workflow.buildScriptEnabled);
/** 是否有未保存更改 */
const dirty = ref(false);
/** 保存中 */
const saving = ref(false);
/** 模拟构建对话框开关 */
const simulateOpen = ref(false);
/** 节点速查对话框开关 */
const nodeRefOpen = ref(false);

// 脚本内容或启用开关任一与已保存状态不一致即为未保存
watch([editorValue, enabled], ([val, en]) => {
  dirty.value = val !== savedScript.value || en !== savedEnabled.value;
});

/** 编辑器宿主元素 */
const editorHost = ref<HTMLDivElement | null>(null);
/** Monaco 编辑器实例 */
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

/** 插入默认模板（追加到当前内容尾部） */
function insertTemplate(): void {
  if (!editor) return;
  const current = editor.getValue();
  const next = current.trim() === '' ? DEFAULT_BUILD_SCRIPT_TEMPLATE : `${current}\n\n${DEFAULT_BUILD_SCRIPT_TEMPLATE}`;
  editor.setValue(next);
}

/** 重置为已保存内容 */
function resetToSaved(): void {
  if (!editor) return;
  editor.setValue(savedScript.value);
  enabled.value = savedEnabled.value;
  dirty.value = false;
}

/**
 * 将节点速查片段插入到光标处（当前行非空时先换行）。
 * @param text 要插入的代码片段
 */
function insertAtCursor(text: string): void {
  if (!editor) return;
  const position = editor.getPosition();
  if (!position) {
    // 无光标信息时追加到末尾
    editor.setValue(`${editor.getValue()}\n${text}\n`);
    return;
  }
  const model = editor.getModel();
  // 当前行非空时先换行，保证片段独占一行
  const currentLine = model?.getLineContent(position.lineNumber) ?? '';
  const prefix = currentLine.trim() === '' ? '' : '\n';
  editor.executeEdits('node-reference-insert', [{
    range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    text: `${prefix}${text}\n`,
  }]);
  editor.focus();
}

/** 保存脚本与启用状态 */
async function save(): Promise<void> {
  if (!editor) return;
  saving.value = true;
  try {
    const updated = await saveBuildScript(props.workflow.id, {
      script: editor.getValue(),
      enabled: enabled.value,
    });
    savedScript.value = updated.buildScript;
    savedEnabled.value = updated.buildScriptEnabled;
    editorValue.value = updated.buildScript;
    dirty.value = false;
    emit('saved', updated);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  // 拉取并注册脚本 API 类型声明（服务端单一来源）
  try {
    const dts = await getBuildApiTypes();
    registerBuildApiTypes(dts);
  } catch {
    // 类型声明拉取失败不阻塞编辑（仅缺失提示）
  }

  if (!editorHost.value) return;
  editor = monaco.editor.create(editorHost.value, {
    value: props.workflow.buildScript,
    language: 'typescript',
    theme: 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    tabSize: 2,
  });
  editor.onDidChangeModelContent(() => {
    editorValue.value = editor?.getValue() ?? '';
  });

  // 补全触发增强：TS 语言服务的补全 triggerCharacters 只有 "."，输入单引号不会自动弹出候选。
  // 这里在 addNode / findNodesByClass 调用内输入 ' 或 " 时手动触发补全，复用 TS 语言服务
  // 基于 d.ts 中 ComfyClassType 联合类型提供的节点类名候选（getCompletionsAtPosition 已实测返回类名）。
  // 注：onDidType 事件在运行时存在（codeEditorWidget 内部 _onDidType），但未暴露在 monaco 公开类型定义中，需类型断言。
  type TypingEmitter = { onDidType(listener: (text: string) => void): monaco.IDisposable };
  (editor as monaco.editor.IStandaloneCodeEditor & TypingEmitter).onDidType((text) => {
    if (text !== "'" && text !== '"') return;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!model || !position) return;
    // 光标前（不含刚输入的单引号）的文本尾部；最后一行是 // 注释时不触发（模板示例行）
    const offset = model.getOffsetAt(position) - text.length;
    const tail = model.getValue().slice(0, offset).slice(-800);
    const lineTail = tail.split('\n').pop() ?? '';
    if (lineTail.includes('//')) return;
    // 仍处于 addNode/findNodesByClass 调用语句内才触发：
    // - addNode 需已传入第一个参数（出现逗号），命中第二/后续参数（classType）位置
    // - findNodesByClass 仅一个 classType 参数，命中其首个参数位置
    // - 语句未以 ; 结束，说明仍在该调用语句内
    if (/(?:addNode\s*\([^;]*,[^;]*|findNodesByClass\s*\([^;]*)$/.test(tail)) {
      editor?.trigger('build-script-editor', 'editor.action.triggerSuggest', {});
    }
  });
});

onBeforeUnmount(() => {
  editor?.dispose();
  editor = null;
});

// 父组件刷新 workflow 后同步已保存脚本
watch(
  () => props.workflow.buildScript,
  (val) => {
    savedScript.value = val;
    savedEnabled.value = props.workflow.buildScriptEnabled;
    if (editor && !dirty.value) {
      editor.setValue(val);
    }
  },
);
</script>

<style scoped>
.build-script-editor {
  width: 100%;
  height: 520px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}
</style>
