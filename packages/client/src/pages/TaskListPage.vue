<template>
  <v-app-bar color="primary">
    <v-app-bar-title>任务日志</v-app-bar-title>
    <template #append>
      <v-btn variant="text" prepend-icon="mdi-delete-sweep" :disabled="!hasCompleted" @click="handleClear">
        清空已完成
      </v-btn>
      <v-btn icon to="/admin">
        <v-icon>mdi-chevron-left</v-icon>
      </v-btn>
    </template>
  </v-app-bar>

  <v-container>
    <v-card>
      <v-data-table
        :headers="headers"
        :items="tasks"
        :loading="loading"
        item-value="id"
        @click:row="handleRowClick"
      >
        <template #item.createdAt="{ value }">
          {{ formatTime(value) }}
        </template>
        <template #item.status="{ item }">
          <div class="d-flex align-center ga-2">
            <v-chip :color="statusColor(item.status)" size="small">
              {{ statusText(item.status) }}
            </v-chip>
            <v-progress-circular
              v-if="item.status === 'pending' && item.progress != null"
              :model-value="item.progress"
              color="primary"
              size="20"
              width="3"
            >
              <template #default>
                <span class="text-caption font-weight-bold">{{ item.progress }}</span>
              </template>
            </v-progress-circular>
          </div>
        </template>
        <template #item.completedAt="{ value }">
          {{ value ? formatTime(value) : '-' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="item.status === 'queued'"
            color="primary"
            size="small"
            variant="tonal"
            class="mr-1"
            @click.stop="handleSubmitTask(item.id)"
          >
            立即提交
          </v-btn>
          <v-btn icon="mdi-information-outline" size="small" variant="text" @click.stop="openDetail(item)" />
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="detailDialog" max-width="800">
      <v-card v-if="selectedTask">
        <v-card-title>任务详情</v-card-title>
        <v-card-text>
          <v-list>
            <v-list-item>
              <v-list-item-subtitle>任务 ID</v-list-item-subtitle>
              <v-list-item-title class="text-body-2">{{ selectedTask.id }}</v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>工作流</v-list-item-subtitle>
              <v-list-item-title>{{ selectedTask.workflowName }}</v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>状态</v-list-item-subtitle>
              <v-list-item-title>
                <v-chip :color="statusColor(selectedTask.status)" size="small">
                  {{ statusText(selectedTask.status) }}
                </v-chip>
              </v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>提交时间</v-list-item-subtitle>
              <v-list-item-title>{{ formatTime(selectedTask.createdAt) }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.completedAt">
              <v-list-item-subtitle>完成时间</v-list-item-subtitle>
              <v-list-item-title>{{ formatTime(selectedTask.completedAt) }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.promptId">
              <v-list-item-subtitle>ComfyUI Prompt ID</v-list-item-subtitle>
              <v-list-item-title class="text-body-2">{{ selectedTask.promptId }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.errorMessage">
              <v-list-item-subtitle class="text-error">错误信息</v-list-item-subtitle>
              <v-list-item-title class="text-error">{{ selectedTask.errorMessage }}</v-list-item-title>
            </v-list-item>
          </v-list>

          <v-expansion-panels class="mt-4">
            <v-expansion-panel title="提交参数">
              <v-expansion-panel-text>
                <pre class="detail-pre">{{ formatJson(selectedTask.aliasValues) }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="请求 URL">
              <v-expansion-panel-text>
                <pre class="detail-pre">{{ selectedTask.comfyuiUrl }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="请求体">
              <v-expansion-panel-text>
                <pre class="detail-pre">{{ selectedTask.comfyuiRequestBody ? formatJson(selectedTask.comfyuiRequestBody) : '-' }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="ComfyUI 响应">
              <v-expansion-panel-text>
                <pre class="detail-pre">{{ selectedTask.comfyuiResponse ? formatJson(selectedTask.comfyuiResponse) : '-' }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="detailDialog = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { listTasks, clearCompletedTasks, submitTask, type TaskLog } from '@/api/tasks';

const headers = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '状态', key: 'status' },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

const tasks = ref<TaskLog[]>([]);
const loading = ref(true);
const detailDialog = ref(false);
const selectedTask = ref<TaskLog | null>(null);
const hasCompleted = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'queued': return 'blue';
    case 'pending': return 'orange';
    case 'completed': return 'green';
    case 'failed': return 'red';
    default: return 'grey';
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'pending': return '处理中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return status;
  }
}

function openDetail(item: TaskLog) {
  selectedTask.value = item;
  detailDialog.value = true;
}

/** Vuetify v-data-table 行点击事件处理：从事件数据中提取 item */
function handleRowClick(_event: PointerEvent, data: { item: TaskLog }) {
  openDetail(data.item);
}

async function fetchTasks() {
  try {
    tasks.value = await listTasks();
    hasCompleted.value = tasks.value.some(t => t.status === 'completed' || t.status === 'failed');
  } catch {
    // ignore
  } finally {
    loading.value = false;
  }
}

async function handleClear() {
  try {
    await clearCompletedTasks();
    await fetchTasks();
  } catch {
    // ignore
  }
}

async function handleSubmitTask(taskId: string) {
  try {
    await submitTask(taskId);
    await fetchTasks();
  } catch {
    // ignore
  }
}

onMounted(() => {
  fetchTasks();
  pollTimer = setInterval(fetchTasks, 1000);
});

onUnmounted(() => {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
  }
});
</script>

<style scoped>
.detail-pre {
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  background: rgb(var(--v-theme-surface-light));
  padding: 12px;
  border-radius: 4px;
  font-size: 0.8rem;
  line-height: 1.4;
}
</style>
