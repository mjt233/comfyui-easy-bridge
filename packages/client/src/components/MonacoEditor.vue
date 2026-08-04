<template>
  <div class="monaco-editor-wrap">
    <div ref="editorHost" class="monaco-editor-host" :style="{ height: currentHeight }" />
    <!-- 拖拽手柄：resizable 开启时可上下拖动调整编辑器高度 -->
    <div
      v-if="resizable"
      ref="resizeHandle"
      class="monaco-resize-handle"
      title="拖拽调整高度"
      @pointerdown="onResizeStart"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
// 复用 build-script 的 monaco 单例：worker env 只初始化一次，注册的 JSON/TS 语言服务全局生效
import { monaco } from './build-script/monaco';

/**
 * 组件 props：v-model 绑定值、语言、只读、高度与拖拽调整
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
    /** 是否显示拖拽手柄，允许用户动态调整高度，默认关闭 */
    resizable?: boolean;
    /** 拖拽调整时的最小高度（CSS 值） */
    minHeight?: string;
    /** 拖拽调整时的最大高度（CSS 值，支持 vh 单位） */
    maxHeight?: string;
  }>(),
  {
    language: 'json',
    readonly: false,
    height: '360px',
    resizable: false,
    minHeight: '120px',
    maxHeight: '80vh',
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
/** 当前编辑器高度（初始为 props.height，拖拽时实时更新） */
const currentHeight = ref(props.height);
/** 是否正在拖拽调整高度 */
let resizing = false;
/** 拖拽起始的指针 Y 坐标 */
let startY = 0;
/** 拖拽起始高度（px） */
let startHeight = 0;

/**
 * 将 CSS 长度值解析为像素数；vh 单位按当前视口高度换算
 * @param value CSS 长度，如 "240px" / "80vh"
 * @returns 对应的像素数
 */
function parseCssLength(value: string): number {
  const num = parseFloat(value);
  if (value.endsWith('vh')) {
    return (num / 100) * window.innerHeight;
  }
  return num;
}

/**
 * 开始拖拽调整高度：记录起始位置并监听全局指针移动/抬起
 * @param e 指针按下事件
 */
function onResizeStart(e: PointerEvent) {
  resizing = true;
  startY = e.clientY;
  startHeight = parseFloat(currentHeight.value);
  // 捕获指针，保证拖出组件范围后仍能收到移动事件
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    // 指针捕获失败（如合成事件场景）时忽略，仍依赖 window 全局监听
  }
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', onResizeEnd);
}

/**
 * 拖拽过程中按指针位移实时更新高度，并限制在最小/最大范围内
 * @param e 指针移动事件
 */
function onResizeMove(e: PointerEvent) {
  if (!resizing) return;
  const delta = e.clientY - startY;
  const next = Math.min(
    Math.max(startHeight + delta, parseCssLength(props.minHeight)),
    parseCssLength(props.maxHeight),
  );
  currentHeight.value = `${next}px`;
}

/**
 * 结束拖拽：移除全局监听
 */
function onResizeEnd() {
  resizing = false;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', onResizeEnd);
}

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
  // 销毁编辑器实例，避免内存泄漏；并清理可能的拖拽监听
  editor?.dispose();
  editor = null;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', onResizeEnd);
});

// 外部高度变化（如 props 动态调整）时同步到当前高度
watch(
  () => props.height,
  (h) => {
    currentHeight.value = h;
  },
);

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

/* 拖拽手柄：位于编辑器底部，悬停/按下时显示纵向拉伸光标 */
.monaco-resize-handle {
  height: 6px;
  cursor: ns-resize;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.monaco-resize-handle::before {
  content: '';
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: #bdbdbd;
}

.monaco-resize-handle:hover::before {
  background: #757575;
}
</style>
