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
        <template #[`item.providerName`]="{ item }">
          <span v-if="providerLabel(item)" class="text-body-2">
            {{ providerLabel(item) }}
          </span>
          <span v-else class="text-caption text-grey">-</span>
        </template>
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
            v-if="item.status === 'pending'"
            color="error"
            size="small"
            variant="tonal"
            class="mr-1"
            @click.stop="handleCancelTask(item.id)"
          >
            中断
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

    <v-dialog v-model="detailDialog" max-width="960">
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
            <v-list-item v-if="providerLabel(selectedTask)">
              <v-list-item-subtitle>执行提供商</v-list-item-subtitle>
              <v-list-item-title>{{ providerLabel(selectedTask) }}</v-list-item-title>
              <v-list-item-subtitle v-if="selectedTask.providerId" class="text-caption text-grey">
                ID: {{ selectedTask.providerId }}
              </v-list-item-subtitle>
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

          <v-tabs v-model="detailTab" color="primary" class="mt-4">
            <v-tab value="params">
              提交参数
            </v-tab>
            <v-tab value="url">
              请求 URL
            </v-tab>
            <v-tab value="body">
              请求体
            </v-tab>
            <v-tab value="canvas">
              Prompt 画布
            </v-tab>
            <v-tab value="response">
              ComfyUI 响应
            </v-tab>
            <v-tab value="output">
              输出文件
            </v-tab>
          </v-tabs>

          <v-window v-model="detailTab" class="mt-2">
            <v-window-item value="params">
              <div class="d-flex align-start">
                <!-- 左侧页签：切换查看原始表单 / 提交参数 -->
                <v-tabs
                  v-model="paramsSubTab"
                  direction="vertical"
                  color="primary"
                  class="params-sub-tabs mr-3"
                >
                  <v-tab value="form">
                    原始表单
                  </v-tab>
                  <v-tab value="submitted">
                    提交参数
                  </v-tab>
                </v-tabs>
                <v-window v-model="paramsSubTab" class="flex-grow-1">
                  <v-window-item value="form">
                    <!-- 原始表单：展示用户提交的参数与上传文件元数据 -->
                    <template v-if="originalFormData">
                      <template v-if="hasFormParams">
                        <p class="text-subtitle-2 text-primary mb-1">
                          表单参数
                        </p>
                        <pre class="detail-pre">{{ formatJson(JSON.stringify(originalFormData.params)) }}</pre>
                      </template>
                      <template v-if="originalFormData.files.length > 0">
                        <p class="text-subtitle-2 text-primary mt-3 mb-1">
                          上传文件（{{ originalFormData.files.length }}）
                        </p>
                        <v-table density="compact">
                          <thead>
                            <tr>
                              <th style="min-width: 120px">
                                表单 Key
                              </th>
                              <th>
                                文件名
                              </th>
                              <th style="width: 100px">
                                大小
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr v-for="(file, index) in originalFormData.files" :key="index">
                              <td>
                                <code>{{ file.alias }}</code>
                              </td>
                              <td class="text-body-2">
                                {{ file.filename }}
                              </td>
                              <td class="text-body-2">
                                {{ formatFileSize(file.size) }}
                              </td>
                            </tr>
                          </tbody>
                        </v-table>
                      </template>
                      <p
                        v-if="!hasFormParams && originalFormData.files.length === 0"
                        class="text-body-2 text-grey"
                      >
                        无原始表单数据
                      </p>
                    </template>
                    <p v-else class="text-body-2 text-grey">
                      无原始表单数据
                    </p>
                  </v-window-item>
                  <v-window-item value="submitted">
                    <pre class="detail-pre">{{ formatJson(selectedTask.aliasValues) }}</pre>
                  </v-window-item>
                </v-window>
              </div>
            </v-window-item>
            <v-window-item value="url">
              <pre class="detail-pre">{{ selectedTask.comfyuiUrl }}</pre>
            </v-window-item>
            <v-window-item value="body">
              <pre class="detail-pre">{{ selectedTask.comfyuiRequestBody ? formatJson(selectedTask.comfyuiRequestBody) : '-' }}</pre>
            </v-window-item>
            <v-window-item value="canvas">
              <!-- 仅画布 Tab 激活时挂载：保证 vue-flow viewport 以真实尺寸初始化，避免隐藏挂载触发警告（项目既有约定） -->
              <WorkflowCanvas
                v-if="detailTab === 'canvas' && promptJson"
                :raw-json="promptJson"
                :height="'440px'"
                @node-click="handleCanvasNodeClick"
              />
              <p v-else class="text-grey text-center py-6 ma-0">
                请求体中没有可展示的 prompt 结构
              </p>
            </v-window-item>
            <v-window-item value="response">
              <pre class="detail-pre">{{ selectedTask.comfyuiResponse ? formatJson(selectedTask.comfyuiResponse) : '-' }}</pre>
            </v-window-item>
            <v-window-item value="output">
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
            </v-window-item>
          </v-window>
        </v-card-text>
        <v-card-actions>
          <v-btn
            v-if="selectedTask?.status === 'pending'"
            color="error"
            variant="tonal"
            @click="handleCancelTask(selectedTask!.id); detailDialog = false"
          >
            中断任务
          </v-btn>
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
    <!-- 节点详情对话框：点击画布节点时展示该节点全部参数 -->
    <NodeDetailsDialog v-model="nodeDetailsOpen" :node="selectedNode" />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { listTasks, clearCompletedTasks, submitTask, cancelTask, fetchTaskOutputFiles, type TaskLog, type OutputFile } from '@/api/tasks';
import WorkflowCanvas from '@/components/workflow-canvas/WorkflowCanvas.vue';
import NodeDetailsDialog from '@/components/build-script/NodeDetailsDialog.vue';
import { parseWorkflowGraph, type GraphNode } from '@/components/workflow-canvas/workflowGraph';

const headers = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '提供商', key: 'providerName' },
  { title: '状态', key: 'status' },
  { title: '输出', key: 'outputFiles', sortable: false },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

const tasks = ref<TaskLog[]>([]);
const loading = ref(true);
const detailDialog = ref(false);
/** 详情对话框当前激活的页签 */
const detailTab = ref('params');
/** 提交参数页签内的左侧子页签：form=原始表单 / submitted=提交参数 */
const paramsSubTab = ref('form');
const selectedTask = ref<TaskLog | null>(null);
const outputFiles = ref<OutputFile[]>([]);
const outputFilesLoading = ref(false);
const hasCompleted = ref(false);

const previewDialog = ref(false);
const previewFile = ref<OutputFile | null>(null);
const previewError = ref(false);

/** 节点详情对话框是否打开（画布节点点击时展示） */
const nodeDetailsOpen = ref(false);
/** 当前选中的节点（供节点详情对话框展示） */
const selectedNode = ref<GraphNode | null>(null);

const listOutputDialog = ref(false);
const listOutputTaskId = ref<string | null>(null);
const listOutputFiles = ref<OutputFile[]>([]);
const listOutputLoading = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * 任务关联的执行提供商展示文案：名称优先，缺失（如历史任务）时回退实例 ID。
 * @param task 任务日志
 * @returns 展示文案；提供商信息完全缺失时为 null
 */
function providerLabel(task: TaskLog): string | null {
  if (task.providerName) return task.providerName;
  return task.providerId ?? null;
}

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

/** 原始表单中的上传文件条目 */
interface OriginalFormFile {
  /** 表单 key（别名） */
  alias: string;
  /** 用户上传的原始文件名 */
  filename: string;
  /** 文件字节数 */
  size: number;
  /** MIME 类型 */
  mimetype?: string;
}

/** 原始请求表单数据（解析自 originalForm JSON） */
interface OriginalFormData {
  /** 用户提交的非文件参数 */
  params: Record<string, unknown>;
  /** 上传文件元数据列表 */
  files: OriginalFormFile[];
}

/**
 * 解析任务原始请求表单 JSON（保留用户提交的原始值，含动态字段别名字段）。
 * @returns 原始表单数据；字段缺失或解析失败时为 null
 */
const originalFormData = computed<OriginalFormData | null>(() => {
  const raw = selectedTask.value?.originalForm;
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const params =
      obj.params !== null && typeof obj.params === 'object' && !Array.isArray(obj.params)
        ? (obj.params as Record<string, unknown>)
        : {};
    const files = Array.isArray(obj.files) ? (obj.files as OriginalFormFile[]) : [];
    return { params, files };
  } catch {
    return null;
  }
});

/** 原始表单是否包含参数 */
const hasFormParams = computed(() => {
  const data = originalFormData.value;
  return data !== null && Object.keys(data.params).length > 0;
});

/**
 * 格式化文件大小为人类可读文本
 * @param bytes 字节数
 * @returns 如 "1.2 KB"
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 从请求体 JSON 中提取 prompt 子结构字符串（用于画布视图渲染）。
 * ComfyUI /prompt 请求体结构为 { prompt: {...}, client_id: '...' }，
 * 画布组件只接收 prompt 子结构，因此此处剥离外层字段。
 * @returns prompt 子结构 JSON 字符串；请求体缺失、解析失败或结构不符时返回空字符串
 */
const promptJson = computed(() => {
  const body = selectedTask.value?.comfyuiRequestBody;
  if (!body) return '';
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const prompt = obj.prompt;
    if (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) {
      return JSON.stringify(prompt);
    }
    return '';
  } catch {
    return '';
  }
});

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
  detailTab.value = 'params';
  paramsSubTab.value = 'form';
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

/**
 * 画布节点点击 → 打开节点详情对话框（与工作流详情页画布行为一致）
 * @param nodeId 节点 ID
 */
function handleCanvasNodeClick(nodeId: string): void {
  if (!promptJson.value) return;
  // 从请求体中的 prompt 结构解析节点图，按被点击的节点 ID 查找节点
  const parsed = parseWorkflowGraph(promptJson.value);
  const node = parsed.nodes.find(n => n.id === nodeId);
  if (!node) return;
  selectedNode.value = node;
  nodeDetailsOpen.value = true;
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

async function handleCancelTask(taskId: string) {
  try {
    await cancelTask(taskId);
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

.params-sub-tabs {
  min-width: 96px;
}
</style>
