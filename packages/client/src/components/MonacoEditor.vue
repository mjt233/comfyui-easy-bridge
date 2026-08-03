<template>
  <div ref="editorHost" class="monaco-editor-host" :style="{ height }" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
// 复用 build-script 的 monaco 单例：worker env 只初始化一次，注册的 JSON/TS 语言服务全局生效
import { monaco } from './build-script/monaco';

/**
 * 组件 props：v-model 绑定值、语言、只读与高度
 */
const props = withDefaults(
  defineProps<{
    /** 编辑器绑定值（v-model） */
    modelValue: string;
    /** Monaco 语言标识，默认 json */
    language?: string;
    /** 是否只读（用于结果查看等场景） */
    readonly?: boolean;
    /** 编辑器高度（CSS 值），默认 360px */
    height?: string;
  }>(),
  {
    language: 'json',
    readonly: false,
    height: '360px',
  },
);

/** 组件事件：内容变更时上抛最新文本 */
const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

/** 编辑器宿主元素 */
const editorHost = ref<HTMLDivElement | null>(null);
/** Monaco 编辑器实例 */
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

onMounted(() => {
  if (!editorHost.value) return;
  // 创建编辑器：JSON 开启折叠与粘贴时自动格式化
  editor = monaco.editor.create(editorHost.value, {
    value: props.modelValue,
    language: props.language,
    theme: 'vs',
    automaticLayout: true,
    readOnly: props.readonly,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    tabSize: 2,
    folding: true,
    formatOnPaste: true,
    formatOnType: false,
  });
  // 编辑器内容变化 → 同步到 v-model
  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor?.getValue() ?? '');
  });
});

onBeforeUnmount(() => {
  // 销毁编辑器实例，避免内存泄漏
  editor?.dispose();
  editor = null;
});

// 外部值变化（如文件上传、模拟结果返回）时同步到编辑器；
// 内容相同时跳过，避免回写自身触发无意义的 setValue
watch(
  () => props.modelValue,
  (val) => {
    if (editor && editor.getValue() !== val) {
      editor.setValue(val);
    }
  },
);

// 语言切换：复用当前 model 直接更新语言
watch(
  () => props.language,
  (lang) => {
    const model = editor?.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, lang);
    }
  },
);

// 只读切换：动态更新编辑器选项
watch(
  () => props.readonly,
  (ro) => {
    editor?.updateOptions({ readOnly: ro });
  },
);
</script>

<style scoped>
.monaco-editor-host {
  width: 100%;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}
</style>
