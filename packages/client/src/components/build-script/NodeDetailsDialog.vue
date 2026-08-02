<template>
  <v-dialog v-model="show" max-width="680">
    <v-card v-if="node">
      <!-- 标题：节点标题 + 类型徽章 -->
      <v-card-title class="d-flex align-center ga-2 pr-2">
        <span class="text-h6 text-truncate">{{ node.title }}</span>
        <v-chip
          size="small"
          color="primary"
          variant="tonal"
          class="flex-shrink-0"
        >
          {{ node.classType || '未知节点' }}
        </v-chip>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          @click="show = false"
        />
      </v-card-title>

      <!-- 副标题：节点 ID -->
      <v-card-subtitle class="pb-1">
        节点 ID：<code>{{ node.id }}</code>
      </v-card-subtitle>

      <v-card-text>
        <!-- 输入参数明细 -->
        <p class="text-subtitle-2 text-primary mb-1">
          输入参数（{{ node.inputs.length }}）
        </p>
        <v-table v-if="node.inputs.length > 0" density="compact">
          <thead>
            <tr>
              <th style="min-width: 140px">
                字段名
              </th>
              <th style="width: 90px">
                类型
              </th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="input in node.inputs" :key="input.name">
              <td>
                <code>{{ input.name }}</code>
              </td>
              <td>
                <!-- 连线输入：来源自其他节点输出 -->
                <v-chip
                  v-if="input.connected"
                  size="x-small"
                  color="info"
                  variant="tonal"
                >
                  连线
                </v-chip>
                <!-- 普通输入：常量值 -->
                <span v-else class="text-caption text-grey">常量</span>
              </td>
              <td class="text-caption">
                <!-- 连线输入展示来源节点与输出槽 -->
                <template v-if="input.connected">
                  <code class="text-info">← {{ input.source }} [{{ input.sourceSlot }}]</code>
                </template>
                <!-- 常量输入展示具体值；空值显示占位符 -->
                <code v-else>{{ input.displayValue ?? '-' }}</code>
              </td>
            </tr>
          </tbody>
        </v-table>
        <p v-else class="text-caption text-grey mb-0">
          该节点没有输入参数
        </p>

        <!-- 输出槽 -->
        <template v-if="node.outputSlots.length > 0">
          <p class="text-subtitle-2 text-primary mt-4 mb-1">
            输出（{{ node.outputSlots.length }}）
          </p>
          <div class="d-flex flex-wrap ga-1">
            <v-chip
              v-for="slot in node.outputSlots"
              :key="slot"
              size="x-small"
              variant="tonal"
              color="success"
            >
              输出 {{ slot }}
            </v-chip>
          </div>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="show = false">
          关闭
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import type { GraphNode } from '../workflow-canvas/workflowGraph';

/** 对话框显示控制（v-model） */
const show = defineModel<boolean>({ required: true });

/** 组件 props：待展示的节点（null 时不渲染卡片内容） */
defineProps<{
  node: GraphNode | null;
}>();
</script>
