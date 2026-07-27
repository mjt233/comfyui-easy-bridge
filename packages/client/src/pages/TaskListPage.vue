<template>
  <v-app-bar color="primary">
    <v-app-bar-title>任务日志</v-app-bar-title>
    <template #append>
      <v-btn
        variant="text"
        prepend-icon="mdi-delete-sweep"
        :disabled="!hasCompleted"
        @click="handleClear"
      >
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
        <template #[`item.createdAt`]="{ value }">
          {{ formatTime(value) }}
        </template>
        <template #[`item.status`]="{ item }">
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
            />
          </div>
        </template>
        <template #[`item.outputFiles`]="{ item, value }">
          <div v-if="value" class="d-flex align-center ga-1">
            <v-btn
              variant="text"
              size="small"
              color="primary"
              class="pa-0 text-caption font-weight-regular"
              density="comfortable"
              :prepend-icon="countOutputFiles(value) > 0 ? 'mdi-file-outline' : ''"
              @click.stop="openListOutputFiles(item)"
            >
              {{ countOutputFiles(value) }} 个文件
            </v-btn>
          </div>
          <span v-else class="text-caption text-grey">-</span>
        </template>
        <template #[`item.completedAt`]="{ value }">
          {{ value ? formatTime(value) : '-' }}
        </template>
        <template #[`item.actions`]="{ item }">
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
          <v-btn
            icon="mdi-information-outline"
            size="small"
            variant="text"
            @click.stop="openDetail(item)"
          />
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
              <v-list-item-title class="text-body-2">
                {{ selectedTask.id }}
              </v-list-item-title>
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
              <v-list-item-title class="text-body-2">
                {{ selectedTask.promptId }}
              </v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.errorMessage">
              <v-list-item-subtitle class="text-error">
                错误信息
              </v-list-item-subtitle>
              <v-list-item-title class="text-error">
                {{ selectedTask.errorMessage }}
              </v-list-item-title>
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
            <v-expansion-panel title="输出文件">
              <v-expansion-panel-text>
                <div v-if="outputFilesLoading" class="text-center pa-4">
                  <v-progress-circular indeterminate size="20" />
                </div>
                <div v-else-if="outputFiles.length === 0" class="text-body-2 text-grey">
                  无输出文件
                </div>
                <v-list v-else density="compact">
                  <v-list-item v-for="file in outputFiles" :key="file.filename">
                    <template #prepend>
                      <v-icon v-if="file.fileType === 'image'" color="primary">
                        mdi-image
                      </v-icon>
                      <v-icon v-else-if="file.fileType === 'video'" color="purple">
                        mdi-film
                      </v-icon>
                      <v-icon v-else color="orange">
                        mdi-music
                      </v-icon>
                    </template>
                    <v-list-item-title class="text-body-2">
                      {{ file.filename }}
                    </v-list-item-title>
                    <template #append>
                      <v-btn
                        icon="mdi-eye"
                        size="small"
                        variant="text"
                        @click.stop="openPreview(file)"
                      />
                      <v-btn
                        icon="mdi-download"
                        size="small"
                        variant="text"
                        :href="file.url"
                        target="_blank"
                        @click.stop
                      />
                    </template>
                  </v-list-item>
                </v-list>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="detailDialog = false">
            关闭
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <!-- 列表输出文件弹窗 -->
    <v-dialog v-model="listOutputDialog" max-width="500">
      <v-card v-if="listOutputTaskId">
        <v-card-title class="d-flex align-center ga-2">
          <v-icon>mdi-file-download-outline</v-icon>
          <span>输出文件</span>
          <v-spacer />
          <v-btn
            icon="mdi-close"
            size="small"
            variant="text"
            @click="listOutputDialog = false"
          />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <div v-if="listOutputLoading" class="text-center pa-4">
            <v-progress-circular indeterminate size="20" />
          </div>
          <div v-else-if="listOutputFiles.length === 0" class="text-body-2 text-grey text-center pa-4">
            无输出文件
          </div>
          <v-list v-else density="compact">
            <v-list-item v-for="file in listOutputFiles" :key="file.filename">
              <template #prepend>
                <v-icon v-if="file.fileType === 'image'" color="primary">
                  mdi-image
                </v-icon>
                <v-icon v-else-if="file.fileType === 'video'" color="purple">
                  mdi-film
                </v-icon>
                <v-icon v-else color="orange">
                  mdi-music
                </v-icon>
              </template>
              <v-list-item-title class="text-body-2">
                {{ file.filename }}
              </v-list-item-title>
              <template #append>
                <v-btn
                  icon="mdi-eye"
                  size="small"
                  variant="text"
                  @click.stop="openPreview(file)"
                />
                <v-btn
                  icon="mdi-download"
                  size="small"
                  variant="text"
                  :href="file.url"
                  target="_blank"
                  @click.stop
                />
              </template>
            </v-list-item>
          </v-list>
        </v-card-text>
      </v-card>
    </v-dialog>
    <!-- 文件预览弹窗 -->
    <v-dialog v-model="previewDialog" max-width="900" @click:outside="previewDialog = false">
      <v-card v-if="previewFile">
        <v-card-title class="d-flex align-center ga-2">
          <v-icon>mdi-file-eye-outline</v-icon>
          <span class="text-truncate">{{ previewFile.filename }}</span>
          <v-spacer />
          <v-btn
            icon="mdi-download"
            size="small"
            variant="text"
            :href="previewFile.url"
            target="_blank"
          />
          <v-btn
            icon="mdi-close"
            size="small"
            variant="text"
            @click="previewDialog = false"
          />
        </v-card-title>
        <v-divider />
        <v-card-text class="pa-0">
          <div class="preview-container">
            <!-- 图片预览 -->
            <img
              v-if="previewFile.fileType === 'image'"
              :src="previewFile.url"
              :alt="previewFile.filename"
              class="preview-media"
              @error="previewError = true"
            >
            <!-- 视频预览 -->
            <video
              v-else-if="previewFile.fileType === 'video'"
              :src="previewFile.url"
              class="preview-media"
              controls
              autoplay
            >
              您的浏览器不支持视频播放
            </video>
            <!-- 音频预览 -->
            <audio
              v-else-if="previewFile.fileType === 'audio'"
              :src="previewFile.url"
              class="preview-audio"
              controls
              autoplay
            >
              您的浏览器不支持音频播放
            </audio>
            <!-- 加载失败提示 -->
            <v-alert
              v-if="previewError"
              type="error"
              class="ma-4"
              title="加载失败"
              text="无法加载文件，请尝试下载查看"
            />
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { listTasks, clearCompletedTasks, submitTask, fetchTaskOutputFiles, type TaskLog, type OutputFile } from '@/api/tasks';

const headers = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '状态', key: 'status' },
  { title: '输出', key: 'outputFiles', sortable: false },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

const tasks = ref<TaskLog[]>([]);
const loading = ref(true);
const detailDialog = ref(false);
const selectedTask = ref<TaskLog | null>(null);
const outputFiles = ref<OutputFile[]>([]);
const outputFilesLoading = ref(false);
const hasCompleted = ref(false);

const previewDialog = ref(false);
const previewFile = ref<OutputFile | null>(null);
const previewError = ref(false);

const listOutputDialog = ref(false);
const listOutputTaskId = ref<string | null>(null);
const listOutputFiles = ref<OutputFile[]>([]);
const listOutputLoading = ref(false);

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

async function openDetail(item: TaskLog) {
  selectedTask.value = item;
  detailDialog.value = true;
  outputFiles.value = [];
  if (item.status === 'completed') {
    outputFilesLoading.value = true;
    try {
      const result = await fetchTaskOutputFiles(item.id);
      outputFiles.value = result.files;
    } catch {
      outputFiles.value = [];
    } finally {
      outputFilesLoading.value = false;
    }
  }
}

/** 解析 outputFiles JSON 并返回文件数量 */
function countOutputFiles(outputFilesJson: string): number {
  try {
    const files = JSON.parse(outputFilesJson);
    return Array.isArray(files) ? files.length : 0;
  } catch {
    return 0;
  }
}

/** 点击列表中的输出文件指示器，获取文件列表并弹窗 */
async function openListOutputFiles(task: TaskLog) {
  listOutputTaskId.value = task.id;
  listOutputDialog.value = true;
  listOutputLoading.value = true;
  listOutputFiles.value = [];
  try {
    const result = await fetchTaskOutputFiles(task.id);
    listOutputFiles.value = result.files;
  } catch {
    listOutputFiles.value = [];
  } finally {
    listOutputLoading.value = false;
  }
}

/** 打开文件预览弹窗 */
function openPreview(file: OutputFile) {
  previewFile.value = file;
  previewError.value = false;
  previewDialog.value = true;
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

.preview-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
  max-height: 80vh;
  background: rgb(var(--v-theme-surface-light));
}

.preview-media {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
}

.preview-audio {
  width: 100%;
  max-width: 600px;
  margin: 48px auto;
}
</style>
