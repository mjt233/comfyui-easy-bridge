<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import {
  NODE_BORDER,
  BODY_PAD,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  type WorkflowNodeData,
} from './useWorkflowGraph';

const props = defineProps<NodeProps<WorkflowNodeData>>();

/**
 * 计算指定行中心点的 Y 偏移（px），用于 Handle 与行对齐
 * @param rowIndex 行索引（输入行从 0 开始，输出行排在输入行之后）
 */
function handleTop(rowIndex: number): number {
  return NODE_BORDER + HEADER_HEIGHT + BODY_PAD + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** 目标（输入）Handle：每个连线输入一个，按输入顺序对齐到对应行 */
const targetHandles = computed(() => {
  return props.data.inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => input.connected)
    .map(({ input, index }) => ({
      id: `in-${input.name}`,
      top: handleTop(index),
    }));
});

/** 源（输出）Handle：每个输出槽一个，排在所有输入行之后 */
const sourceHandles = computed(() => {
  return props.data.outputSlots.map((slot, index) => ({
    id: `out-${slot}`,
    top: handleTop(props.data.inputs.length + index),
  }));
});
</script>

<template>
  <div class="wf-node" :class="{ 'wf-node--selected': props.selected }">
    <!-- 左侧输入 Handle -->
    <Handle
      v-for="handle in targetHandles"
      :id="handle.id"
      :key="handle.id"
      type="target"
      :position="Position.Left"
      class="wf-node__handle wf-node__handle--target"
      :style="{ top: `${handle.top}px` }"
    />
    <!-- 右侧输出 Handle -->
    <Handle
      v-for="handle in sourceHandles"
      :id="handle.id"
      :key="handle.id"
      type="source"
      :position="Position.Right"
      class="wf-node__handle wf-node__handle--source"
      :style="{ top: `${handle.top}px` }"
    />

    <!-- 节点头部：标题 + class_type / 节点 ID -->
    <div class="wf-node__header">
      <div class="wf-node__title" :title="props.data.title">
        {{ props.data.title }}
      </div>
      <div class="wf-node__sub">
        <span class="wf-node__class">{{ props.data.classType || '未知节点' }}</span>
        <span class="wf-node__id">{{ props.data.nodeId }}</span>
      </div>
    </div>

    <!-- 节点主体：输入行 + 输出行 -->
    <div class="wf-node__body">
      <div
        v-for="input in props.data.inputs"
        :key="input.name"
        class="wf-node__row"
        :class="{ 'wf-node__row--conn': input.connected }"
      >
        <span class="wf-node__field" :title="input.name">
          {{ input.name }}
        </span>
        <span
          v-if="input.connected"
          class="wf-node__conn"
          :title="`← ${input.source} [${input.sourceSlot}]`"
        >
          连线
        </span>
        <span v-else class="wf-node__value" :title="input.displayValue ?? ''">
          {{ input.displayValue }}
        </span>
      </div>
      <div v-for="slot in props.data.outputSlots" :key="slot" class="wf-node__row wf-node__row--output">
        <span class="wf-node__field">输出 {{ slot }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-node {
  width: 240px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  color: #e2e8f0;
  font-size: 12px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  box-sizing: border-box;
  cursor: pointer;
}
.wf-node--selected {
  border-color: #1565c0;
  box-shadow: 0 0 0 2px rgba(21, 101, 192, 0.6);
}
.wf-node__header {
  height: 58px;
  padding: 8px 10px;
  box-sizing: border-box;
  background: #0f172a;
  border-bottom: 1px solid #334155;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}
.wf-node__title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-node__sub {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: #94a3b8;
  min-width: 0;
}
.wf-node__class {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-node__id {
  flex-shrink: 0;
  color: #64748b;
}
.wf-node__body {
  padding: 4px 10px;
  box-sizing: border-box;
}
.wf-node__row {
  height: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
}
.wf-node__field {
  color: #cbd5e1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 90px;
  flex-shrink: 0;
}
.wf-node__value {
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
}
.wf-node__conn {
  color: #38bdf8;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-node__handle {
  width: 10px;
  height: 10px;
  border: 2px solid #1e293b;
}
.wf-node__handle--target {
  background: #38bdf8;
}
.wf-node__handle--source {
  background: #4ade80;
}
</style>
