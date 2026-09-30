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
    <!-- 两个页签：待调度（queued，尚未提交到任何实例）/ 已提交（已真实提交到具体实例） -->
    <v-card>
      <v-tabs v-model="activeTab" color="primary" density="comfortable">
        <v-tab value="pending-dispatch">
          <v-icon start>mdi-timer-sand</v-icon>
          待调度
          <v-chip v-if="queuedTasks.length > 0" size="x-small" class="ml-2" color="blue">
            {{ queuedTasks.length }}
          </v-chip>
        </v-tab>
        <v-tab value="submitted">
          <v-icon start>mdi-cloud-upload-outline</v-icon>
          已提交
          <v-chip v-if="submittedTasks.length > 0" size="x-small" class="ml-2" color="orange">
            {{ submittedTasks.length }}
          </v-chip>
        </v-tab>
      </v-tabs>
      <v-divider />

      <!-- 待调度：等待匹配的执行提供商空闲后按顺序提交 -->
      <v-data-table
        v-if="activeTab === 'pending-dispatch'"
        :headers="queuedHeaders"
        :items="queuedTasks"
        :loading="loading"
        item-value="id"
        no-data-text="暂无待调度任务"
        @click:row="handleRowClick"
      >
        <template #[`item.providerName`]="{ item }">
          <div class="d-flex align-center ga-2">
            <span v-if="providerLabel(item)" class="text-body-2">
              {{ providerLabel(item) }}
            </span>
            <span v-else class="text-caption text-grey">-</span>
            <!-- 目标为分组：等待分组内成员释放并发槽位 -->
            <v-chip v-if="item.actualProviderId == null" size="x-small" variant="text" color="blue">
              分组
            </v-chip>
          </div>
        </template>
        <template #[`item.createdAt`]="{ value }">
          {{ formatTime(value) }}
        </template>
        <template #[`item.status`]="{ item }">
          <div class="d-flex align-center ga-2">
            <v-chip :color="statusColor(item.status)" size="small">
              {{ statusText(item.status) }}
            </v-chip>
            <v-chip size="small" variant="text" color="blue">
              等待可用实例
            </v-chip>
          </div>
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn
            color="primary"
            size="small"
            variant="tonal"
            class="mr-1"
            prepend-icon="mdi-swap-horizontal"
            @click.stop="openReassign(item)"
          >
            修改实例
          </v-btn>
          <v-btn
            color="orange-darken-2"
            size="small"
            variant="tonal"
            class="mr-1"
            prepend-icon="mdi-flash"
            @click.stop="openForceSubmit(item)"
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

      <!-- 已提交：已真实提交到具体执行提供商实例（含执行中与已结束） -->
      <v-data-table
        v-else
        :headers="submittedHeaders"
        :items="submittedTasks"
        :loading="loading"
        item-value="id"
        no-data-text="暂无已提交任务"
        @click:row="handleRowClick"
      >
        <template #[`item.providerName`]="{ item }">
          <span v-if="providerLabel(item)" class="text-body-2">
            {{ providerLabel(item) }}
          </span>
          <span v-else class="text-caption text-grey">-</span>
        </template>
        <!-- 实际执行实例：分组任务展示调度器选定并提交的成员实例，并标注来源 -->
        <template #[`item.actualProviderName`]="{ item }">
          <div v-if="actualProviderLabel(item)" class="d-flex align-center ga-2">
            <span class="text-body-2">{{ actualProviderLabel(item) }}</span>
            <v-chip
              v-if="isGroupDispatched(item)"
              size="x-small"
              variant="text"
              color="blue"
            >
              自动分配
            </v-chip>
          </div>
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
        <template #[`item.duration`]="{ item }">
          {{ executionDuration(item) }}
        </template>
        <template #[`item.completedAt`]="{ value }">
          {{ value ? formatTime(value) : '-' }}
        </template>
        <template #[`item.actions`]="{ item }">
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

    <!-- 修改执行实例：仅影响自动调度逻辑，不会立即提交 -->
    <v-dialog v-model="reassignDialog" max-width="560">
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon>mdi-swap-horizontal</v-icon>
          <span>修改执行实例</span>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">
            仅调整该任务的调度归属（自动调度按新目标的空闲情况提交），不会立即提交工作流。
            若需要插队立即执行，请使用「立即提交」。
          </p>
          <v-select
            v-model="reassignProviderId"
            :items="providerOptions"
            item-title="label"
            item-value="value"
            label="执行提供商实例"
            density="comfortable"
            variant="outlined"
            hide-details="auto"
          />
          <!-- 目标分组无可用成员：明确提示任务将持续排队（前端预判 + 后端归因） -->
          <v-alert
            v-if="reassignDialogWarning"
            type="warning"
            variant="tonal"
            density="comfortable"
            class="mt-3"
            :text="reassignDialogWarning"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="reassignDialog = false">
            取消
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="reassignSubmitting"
            :disabled="!reassignProviderId"
            @click="handleReassignConfirm"
          >
            确认修改
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 立即提交（插队）：必须选择具体实例，分组目标不可直接提交 -->
    <v-dialog v-model="forceSubmitDialog" max-width="600">
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon>mdi-flash</v-icon>
          <span>立即提交（插队）</span>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">
            无视目标实例的并发上限直接提交工作流，并将该任务的归属改为所选实例。
            仅当实例可正常连通时才会提交，失败时任务保持待调度。
          </p>
          <!-- 区分展示当前分组的成员与其他实例，便于就近选择 -->
          <v-select
            v-model="forceSubmitProviderId"
            :items="forceSubmitOptions"
            item-title="label"
            item-value="value"
            label="提交到执行实例"
            density="comfortable"
            variant="outlined"
            hide-details="auto"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-subheader v-if="item.raw.header">
                {{ item.raw.header }}
              </v-list-subheader>
              <v-list-item v-else v-bind="itemProps" :title="item.raw.label" />
            </template>
          </v-select>
          <!-- 提交失败（实例不可达等）：任务保持待调度，可改选实例重试 -->
          <v-alert
            v-if="forceSubmitError"
            type="error"
            variant="tonal"
            density="comfortable"
            class="mt-3"
            :text="forceSubmitError"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="forceSubmitDialog = false">
            取消
          </v-btn>
          <v-btn
            color="orange-darken-2"
            variant="flat"
            :loading="forceSubmitSubmitting"
            :disabled="!forceSubmitProviderId"
            @click="handleForceSubmitConfirm"
          >
            立即提交
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
            <!-- 选择的提供商：入队时的目标，或最近一次人工改派后的目标（可能为分组） -->
            <v-list-item v-if="providerLabel(selectedTask)">
              <v-list-item-subtitle>选择的提供商</v-list-item-subtitle>
              <v-list-item-title>{{ providerLabel(selectedTask) }}</v-list-item-title>
              <v-list-item-subtitle v-if="selectedTask.providerId" class="text-caption text-grey">
                ID: {{ selectedTask.providerId }}
              </v-list-item-subtitle>
            </v-list-item>
            <!-- 实际执行实例：仅在任务已真实提交后展示；分组目标由调度器选定成员后写入 -->
            <v-list-item v-if="selectedTask.status !== 'queued' && actualProviderLabel(selectedTask)">
              <v-list-item-subtitle>实际执行实例</v-list-item-subtitle>
              <v-list-item-title>
                {{ actualProviderLabel(selectedTask) }}
                <v-chip
                  v-if="isGroupDispatched(selectedTask)"
                  size="x-small"
                  variant="text"
                  color="blue"
                  class="ml-2"
                >
                  由分组自动分配
                </v-chip>
              </v-list-item-title>
              <v-list-item-subtitle v-if="selectedTask.actualProviderId" class="text-caption text-grey">
                ID: {{ selectedTask.actualProviderId }}
              </v-list-item-subtitle>
            </v-list-item>
            <v-list-item v-else-if="selectedTask.status === 'queued'">
              <v-list-item-subtitle>实际执行实例</v-list-item-subtitle>
              <v-list-item-title class="text-grey">
                待调度（尚未提交到具体实例）
              </v-list-item-title>
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
            <v-list-item>
              <v-list-item-subtitle>开始执行</v-list-item-subtitle>
              <v-list-item-title>
                {{ selectedTask.startedAt ? formatTime(selectedTask.startedAt) : '-' }}
              </v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>执行耗时</v-list-item-subtitle>
              <v-list-item-title>{{ executionDuration(selectedTask) }}</v-list-item-title>
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
import {
  listTasks,
  clearCompletedTasks,
  submitTask,
  cancelTask,
  updateTaskProvider,
  fetchTaskOutputFiles,
  type TaskLog,
  type OutputFile,
} from '@/api/tasks';
import { listProviders } from '@/api/providers';
import type { ProviderSummary } from '@/types';
import WorkflowCanvas from '@/components/workflow-canvas/WorkflowCanvas.vue';
import NodeDetailsDialog from '@/components/build-script/NodeDetailsDialog.vue';
import { parseWorkflowGraph, type GraphNode } from '@/components/workflow-canvas/workflowGraph';

/** 待调度（queued）任务的表格列：不含输出/耗时/完成时间（尚未执行） */
const queuedHeaders = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '选择的提供商', key: 'providerName' },
  { title: '状态', key: 'status', sortable: false },
  { title: '操作', key: 'actions', sortable: false },
];

/** 已提交任务的表格列：含实际执行实例、输出文件与执行耗时 */
const submittedHeaders = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '选择的提供商', key: 'providerName' },
  // 实际执行实例：具体实例目标即该实例；分组目标为调度器选定并提交的成员实例
  { title: '实际执行实例', key: 'actualProviderName' },
  { title: '状态', key: 'status' },
  { title: '输出', key: 'outputFiles', sortable: false },
  { title: '执行耗时', key: 'duration', sortable: false },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

const tasks = ref<TaskLog[]>([]);
const loading = ref(true);
/** 当前激活的页签：pending-dispatch=待调度 / submitted=已提交 */
const activeTab = ref('pending-dispatch');
const detailDialog = ref(false);
/** 详情对话框当前激活的页签 */
const detailTab = ref('params');
/** 提交参数页签内的左侧子页签：form=原始表单 / submitted=提交参数 */
const paramsSubTab = ref('form');
const selectedTask = ref<TaskLog | null>(null);
const outputFiles = ref<OutputFile[]>([]);
const outputFilesLoading = ref(false);
const hasCompleted = ref(false);

/** 全部执行提供商实例（供改派/插队弹窗选择目标） */
const providers = ref<ProviderSummary[]>([]);

/** 修改执行实例弹窗 */
const reassignDialog = ref(false);
/** 改派目标实例 ID */
const reassignProviderId = ref<string | null>(null);
/** 改派提交中（防重复点击） */
const reassignSubmitting = ref(false);
/** 改派滞留风险提示（目标分组无可用成员时由后端返回） */
const reassignWarning = ref<string | null>(null);
/** 当前正在改派的任务 ID */
const reassignTaskId = ref<string | null>(null);

/** 立即提交（插队）弹窗 */
const forceSubmitDialog = ref(false);
/** 插队目标实例 ID */
const forceSubmitProviderId = ref<string | null>(null);
/** 插队提交中（防重复点击） */
const forceSubmitSubmitting = ref(false);
/** 当前正在插队提交的任务 ID */
const forceSubmitTaskId = ref<string | null>(null);
/** 插队目标弹窗的错误提示（实例不可达等） */
const forceSubmitError = ref<string | null>(null);

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

/** 待调度任务：尚未提交到任何具体执行实例 */
const queuedTasks = computed(() => tasks.value.filter(t => t.status === 'queued'));

/** 已提交任务：已真实提交到具体执行提供商实例（含执行中与已结束） */
const submittedTasks = computed(() => tasks.value.filter(t => t.status !== 'queued'));

/** 仅启用中的实例可作为改派/插队目标 */
const enabledProviders = computed(() => providers.value.filter(p => p.enabled));

/**
 * 改派目标下拉选项：全部启用实例（含分组）。
 * 分组目标标注「分组」，便于区分自动分配与直接指定。
 */
const providerOptions = computed(() => enabledProviders.value.map(p => ({
  value: p.id,
  label: p.type === 'group' ? `${p.name}（分组）` : p.name,
})));

/** 分组类型的目标：改派到分组时用于判断是否需要提示无成员 */
const selectedReassignProvider = computed(
  () => enabledProviders.value.find(p => p.id === reassignProviderId.value) ?? null,
);

/**
 * 改派表单内的即时警告：目标分组当前没有可参与自动分配的成员时提示会滞留队列。
 * 与后端返回的 warning 相互独立（前端预判，后端兜底）。
 */
const reassignDialogWarning = computed(() => {
  if (reassignWarning.value) return reassignWarning.value;
  const provider = selectedReassignProvider.value;
  if (provider && provider.type === 'group' && provider.memberCount === 0) {
    return '该分组当前没有可参与自动分配的成员实例，任务将持续排队等待，直到分组配置成员或再次调整执行实例';
  }
  return null;
});

/**
 * 插队目标下拉选项：仅具体实例（分组无自有提交端点，后端会拒绝）。
 * 目标实例为分组时按「当前分组的成员 / 其他实例」分组展示，便于就近选择。
 */
const forceSubmitOptions = computed(() => {
  const groupId = forceSubmitTask.value?.providerId ?? null;
  const group = groupId ? providers.value.find(p => p.id === groupId) ?? null : null;
  const memberIds = new Set(
    group && group.type === 'group' ? group.members.map(m => m.providerId) : [],
  );
  const options: Array<{ value?: string; label?: string; header?: string; props?: { disabled: boolean } }> = [];
  const instances = enabledProviders.value.filter(p => p.type !== 'group');
  // 当前分组的成员优先展示（插队到同组成员通常最省事）
  const groupMembers = instances.filter(p => memberIds.has(p.id));
  const others = instances.filter(p => !memberIds.has(p.id));
  if (groupMembers.length > 0) {
    options.push({ header: '当前分组的成员实例' });
    for (const p of groupMembers) options.push({ value: p.id, label: p.name });
  }
  if (others.length > 0) {
    options.push({ header: groupMembers.length > 0 ? '其他实例' : '可用实例' });
    for (const p of others) options.push({ value: p.id, label: p.name });
  }
  return options;
});

/** 当前正在插队提交的任务（用于解析其归属分组） */
const forceSubmitTask = computed(
  () => queuedTasks.value.find(t => t.id === forceSubmitTaskId.value) ?? null,
);

/**
 * 任务关联的执行提供商展示文案：名称优先，缺失（如历史任务）时回退实例 ID。
 * @param task 任务日志
 * @returns 展示文案；提供商信息完全缺失时为 null
 */
function providerLabel(task: TaskLog): string | null {
  if (task.providerName) return task.providerName;
  return task.providerId ?? null;
}

/**
 * 判断任务是否由分组自动分配（选择的提供商为分组，实际执行的是其成员实例）。
 * @param task 任务日志
 * @returns 是否为分组自动分配的任务
 */
function isGroupDispatched(task: TaskLog): boolean {
  return task.providerId != null
    && task.actualProviderId != null
    && task.actualProviderId !== task.providerId;
}

/**
 * 实际执行该任务的实例名称（提交成功后由调度器写入 actual_* 字段）。
 * 待调度任务尚未提交到任何实例，返回 null（详情中展示为待调度提示）。
 * @param task 任务日志
 * @returns 实例名称；尚无实际执行实例时为 null
 */
function actualProviderLabel(task: TaskLog): string | null {
  if (!task.actualProviderId) return null;
  return task.actualProviderName ?? task.actualProviderId;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * 将总秒数格式化为执行耗时文案（段之间单空格）。
 * 省略前导为 0 的高位：`33s` / `1m 33s` / `1h 21m 33s`；有小时时保留 m/s。
 * @param totalSeconds 总秒数（向下取整；负值按 0）
 * @returns 如 `1h 21m 33s`
 */
function formatDuration(totalSeconds: number): string {
  // 保护：非法或负值按 0 秒展示
  const sec = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // 按有无小时/分钟拼接，保证段间单空格
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * 计算任务执行耗时展示文案（不含 Bridge 排队等待）。
 * - queued / 无 startedAt → `-`
 * - pending → 当前时间 − startedAt
 * - completed/failed → completedAt − startedAt
 * @param task 任务日志
 * @returns 耗时字符串或 `-`
 */
function executionDuration(task: TaskLog): string {
  // 未真正开始执行（排队或历史无开始时间）
  if (!task.startedAt || task.status === 'queued') return '-';
  const startMs = new Date(task.startedAt).getTime();
  if (!Number.isFinite(startMs)) return '-';

  // 进行中：用当前时间；终态：用完成时间
  let endMs: number;
  if (task.status === 'pending') {
    endMs = Date.now();
  } else if (task.completedAt) {
    endMs = new Date(task.completedAt).getTime();
    if (!Number.isFinite(endMs)) return '-';
  } else {
    return '-';
  }

  return formatDuration((endMs - startMs) / 1000);
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
    // 详情弹窗打开时，用最新列表数据回写 selectedTask，保证进行中耗时与状态同步
    if (detailDialog.value && selectedTask.value) {
      const latest = tasks.value.find(t => t.id === selectedTask.value!.id);
      if (latest) selectedTask.value = latest;
    }
  } catch {
    // ignore
  } finally {
    loading.value = false;
  }
}

/** 拉取执行提供商实例列表（供改派/插队弹窗选择目标；失败时静默保留上次结果） */
async function fetchProviders(): Promise<void> {
  try {
    providers.value = await listProviders();
  } catch {
    // ignore
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

/**
 * 打开「修改执行实例」弹窗。
 * 默认选中任务当前的目标实例，避免用户重复选择。
 * @param task 待调度任务
 */
function openReassign(task: TaskLog): void {
  reassignTaskId.value = task.id;
  reassignProviderId.value = task.providerId;
  reassignWarning.value = null;
  reassignSubmitting.value = false;
  reassignDialog.value = true;
  // 目标下拉需要最新的实例与成员信息（分组成员数用于滞留预判）
  void fetchProviders();
}

/** 提交「修改执行实例」：仅改写调度归属，不立即提交 */
async function handleReassignConfirm(): Promise<void> {
  const taskId = reassignTaskId.value;
  const providerId = reassignProviderId.value;
  if (!taskId || !providerId) return;
  reassignSubmitting.value = true;
  try {
    const result = await updateTaskProvider(taskId, providerId);
    reassignWarning.value = result.warning ?? null;
    // 后端返回滞留警告时保持弹窗打开，让用户确认后再关闭
    if (!result.warning) reassignDialog.value = false;
    await fetchTasks();
  } catch {
    // ignore
  } finally {
    reassignSubmitting.value = false;
  }
}

/**
 * 打开「立即提交（插队）」弹窗。
 * 默认选中任务当前的目标实例（若为具体实例），分组目标下不预选（必须由用户选择具体实例）。
 * @param task 待调度任务
 */
function openForceSubmit(task: TaskLog): void {
  forceSubmitTaskId.value = task.id;
  forceSubmitProviderId.value = task.actualProviderId ?? null;
  forceSubmitError.value = null;
  forceSubmitSubmitting.value = false;
  forceSubmitDialog.value = true;
  void fetchProviders();
}

/** 提交「立即提交（插队）」：无视并发上限提交到所选具体实例 */
async function handleForceSubmitConfirm(): Promise<void> {
  const taskId = forceSubmitTaskId.value;
  const providerId = forceSubmitProviderId.value;
  if (!taskId || !providerId) return;
  forceSubmitSubmitting.value = true;
  forceSubmitError.value = null;
  try {
    await submitTask(taskId, providerId);
    forceSubmitDialog.value = false;
    await fetchTasks();
  } catch (err: unknown) {
    // 实例不可达等失败：任务仍保持待调度，提示用户改选其他实例重试
    forceSubmitError.value = resolveSubmitError(err);
    await fetchTasks();
  } finally {
    forceSubmitSubmitting.value = false;
  }
}

/**
 * 从 axios 错误中提取可读的插队失败原因。
 * @param err 捕获到的异常
 * @returns 提示文案
 */
function resolveSubmitError(err: unknown): string {
  const response = (err as { response?: { data?: { error?: unknown } } } | null)?.response;
  const message = response?.data?.error;
  if (typeof message === 'string' && message !== '') return message;
  return '提交失败：目标实例不可达，任务仍处于待调度状态，可改选其他实例重试';
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
  fetchProviders();
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
