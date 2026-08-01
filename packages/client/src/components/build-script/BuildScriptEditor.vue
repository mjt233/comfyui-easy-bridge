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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import type { WorkflowDetail } from '@/types';
import { getBuildApiTypes, saveBuildScript } from '@/api/workflows';
import { monaco, registerBuildApiTypes } from './monaco';
import { DEFAULT_BUILD_SCRIPT_TEMPLATE } from './buildScriptTemplate';
import BuildSimulateDialog from './BuildSimulateDialog.vue';

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
