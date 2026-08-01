<template>
  <v-dialog v-model="show" max-width="980">
    <v-card>
      <v-card-title>模拟构建</v-card-title>
      <v-card-text>
        <p class="text-body-2 text-grey">
          模拟构建功能开发中...
        </p>
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
import type { WorkflowDetail } from '@/types';

/** 对话框显示控制（v-model） */
const show = defineModel<boolean>({ required: true });

/** 组件 props：工作流详情与当前脚本内容（Task 8 使用） */
const props = defineProps<{
  workflow: WorkflowDetail;
  script: string;
}>();
</script>
