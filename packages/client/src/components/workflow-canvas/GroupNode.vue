<script setup lang="ts">
import type { NodeProps } from '@vue-flow/core';
import type { WorkflowGroupData } from './useWorkflowGraph';

/** 组件 props（vue-flow 注入组节点数据） */
const props = defineProps<NodeProps<WorkflowGroupData>>();
</script>

<template>
  <div
    class="wf-group"
    :style="{
      background: props.data.color.background,
      borderColor: props.data.color.border,
    }"
  >
    <span class="wf-group__label" :style="{ color: props.data.color.text }">
      组 {{ props.data.title }}
    </span>
  </div>
</template>

<style scoped>
.wf-group {
  /* 组矩形：占满 vue-flow 包装容器，pointer-events 关闭以让点击穿透到画布/节点 */
  position: relative;
  width: 100%;
  height: 100%;
  border: 1px dashed;
  border-radius: 10px;
  box-sizing: border-box;
  pointer-events: none;
}
.wf-group__label {
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}
</style>
