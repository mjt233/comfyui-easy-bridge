<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { VueFlow, useVueFlow, type Edge, type Node, type NodeMouseEvent } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import WorkflowNode from './WorkflowNode.vue';
import { useWorkflowGraph } from './useWorkflowGraph';

/** 组件 props */
const props = defineProps<{
  /** 工作流原始 JSON 字符串 */
  rawJson: string;
  /** 画布可视区高度 */
  height?: string;
}>();

/** 组件事件 */
const emit = defineEmits<{
  /** 点击节点（携带节点 ID） */
  'node-click': [nodeId: string];
}>();

/** vue-flow store（用于 Tab 切换后重新适配视口） */
const { fitView } = useVueFlow();

/** 自定义节点类型映射 */
const nodeTypes = { comfy: WorkflowNode };

/** 响应式 rawJson */
const rawJsonRef = computed(() => props.rawJson);
const { nodes, edges, parseError, isEmpty } = useWorkflowGraph(rawJsonRef);

/**
 * vue-flow 所需的节点/边。
 * 组合函数返回自定义 FlowNode/FlowEdge 类型（避免 vue-flow 递归类型触发 TS2589），
 * 此处通过 unknown 中间转换一次性转成 vue-flow 的 Node/Edge 类型。
 */
const flowNodes = ref<Node[]>([]);
const flowEdges = ref<Edge[]>([]);
watch(
  [nodes, edges],
  () => {
    flowNodes.value = nodes.value as unknown as Node[];
    flowEdges.value = edges.value as unknown as Edge[];
  },
  { immediate: true },
);

/**
 * 节点点击 → 上抛节点 ID
 * @param event vue-flow 节点点击事件
 */
function onNodeClick(event: NodeMouseEvent): void {
  emit('node-click', event.node.id);
}

/**
 * 重新适配视口（供父组件在画布 Tab 变为可见后调用，避免隐藏状态尺寸为 0）
 */
function fitCanvasView(): void {
  // 等待一帧，确保容器完成布局后再适配
  requestAnimationFrame(() => {
    fitView({ padding: 0.15 });
  });
}

defineExpose({ fitCanvasView });
</script>

<template>
  <div class="workflow-canvas" :style="{ height: height ?? '540px' }">
    <VueFlow
      v-if="!parseError && !isEmpty"
      v-model:nodes="flowNodes"
      v-model:edges="flowEdges"
      :node-types="nodeTypes"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      :min-zoom="0.1"
      :max-zoom="2.5"
      :fit-view-on-init="true"
      :fit-view-options="{ padding: 0.15 }"
      class="workflow-canvas__flow"
      @node-click="onNodeClick"
    >
      <Background :gap="18" :size="1" pattern-color="#e2e8f0" />
      <Controls position="bottom-right" :show-interactive="false" />
      <MiniMap
        position="bottom-left"
        :node-color="() => '#1565C0'"
        :node-stroke-color="() => '#1565C0'"
        :mask-color="'rgba(245, 247, 250, 0.75)'"
        pannable
        zoomable
      />
    </VueFlow>

    <!-- 解析失败 / 空图占位 -->
    <div v-else class="workflow-canvas__empty">
      <v-alert
        v-if="parseError"
        type="error"
        variant="tonal"
        density="compact"
      >
        {{ parseError }}
      </v-alert>
      <p v-else class="text-grey text-center py-6 ma-0">
        工作流中没有可展示的节点
      </p>
    </div>
  </div>
</template>

<style scoped>
.workflow-canvas {
  position: relative;
  width: 100%;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
}
.workflow-canvas__flow {
  width: 100%;
  height: 100%;
}
.workflow-canvas__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
