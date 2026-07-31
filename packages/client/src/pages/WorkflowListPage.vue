<template>
  <v-app-bar color="primary">
    <v-app-bar-title>ComfyUI Easy Bridge</v-app-bar-title>
    <v-spacer />
    <v-btn to="/admin/tasks" variant="text" prepend-icon="mdi-clipboard-text">
      任务日志
    </v-btn>
    <v-btn to="/admin/settings" variant="text" prepend-icon="mdi-cog">
      设置
    </v-btn>
    <v-btn
      v-if="authEnabled !== false"
      variant="text"
      prepend-icon="mdi-logout"
      @click="handleLogout"
    >
      退出
    </v-btn>
  </v-app-bar>

  <v-container>
    <v-row class="mb-4 align-center">
      <v-col>
        <h2 class="text-h5">
          工作流列表
        </h2>
      </v-col>
      <v-col cols="auto">
        <v-btn color="primary" to="/admin/workflow/new" prepend-icon="mdi-plus">
          新建工作流
        </v-btn>
      </v-col>
    </v-row>

    <!-- 多选导出 / 批量导入工具栏 -->
    <v-row v-if="workflows.length > 0" class="mb-2 align-center">
      <v-col cols="auto">
        <v-checkbox
          label="全选"
          :model-value="allSelected"
          hide-details
          density="compact"
          @update:model-value="toggleSelectAll"
        />
      </v-col>
      <v-col cols="auto">
        <span class="text-caption text-grey">已选 {{ selectedIds.size }} 项</span>
      </v-col>
      <v-spacer />
      <v-col cols="auto">
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-export"
          :disabled="selectedIds.size === 0"
          :loading="exporting"
          @click="handleExport"
        >
          导出选中
        </v-btn>
        <v-btn
          class="ml-2"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-import"
          :loading="importing"
          @click="triggerImport"
        >
          导入
        </v-btn>
        <!-- 隐藏的文件选择框，用于导入 ZIP -->
        <input
          ref="importInput"
          type="file"
          accept=".zip,application/zip"
          class="d-none"
          @change="handleImportFile"
        >
      </v-col>
    </v-row>

    <v-card v-if="workflows.length === 0">
      <v-card-text class="text-center py-8 text-grey">
        暂无工作流，点击上方按钮新建
      </v-card-text>
    </v-card>

    <v-list v-else lines="two">
      <v-list-item
        v-for="wf in workflows"
        :key="wf.id"
        :title="wf.name"
        :subtitle="`ID: ${wf.id} | 创建: ${wf.createdAt}`"
        @click="router.push(`/admin/workflow/${wf.id}`)"
      >
        <template #prepend>
          <v-checkbox
            :model-value="selectedIds.has(wf.id)"
            hide-details
            density="compact"
            class="mr-1"
            @click.stop
            @update:model-value="toggleSelect(wf.id)"
          />
          <v-icon :color="getColor(wf.id)" class="mr-2">
            mdi-graph-outline
          </v-icon>
        </template>
        <template #append>
          <v-btn
            icon
            variant="text"
            color="primary"
            size="small"
            class="mr-2"
            @click.stop="handleExecute(wf.id)"
          >
            <v-icon>mdi-play</v-icon>
          </v-btn>
          <v-btn
            icon
            variant="text"
            size="small"
            class="mr-2"
            @click.stop="handleApiDocs(wf.id, wf.name)"
          >
            <v-icon>mdi-code-tags</v-icon>
          </v-btn>
          <v-btn icon variant="text" @click.stop="handleDelete(wf.id)">
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-list-item>
    </v-list>

    <v-dialog v-model="executeDialog" max-width="500" :loading="executeLoading">
      <v-card>
        <v-card-title>执行工作流</v-card-title>
        <v-card-text>
          <v-alert
            v-if="executeFields.length === 0 && !executeLoading"
            type="info"
            variant="tonal"
            class="mb-3"
          >
            该工作流没有已配置别名的参数，可直接执行。
          </v-alert>
          <v-progress-linear
            v-if="executeLoading"
            indeterminate
            color="primary"
            class="mb-3"
          />
          <template v-for="field in executeFields" :key="field.alias">
            <v-switch
              v-if="field.paramType === 'boolean'"
              v-model="executeForm[field.alias]"
              :label="field.label || field.alias"
              :hint="`节点: ${field.nodeTitle} · ${field.fieldName} · boolean`"
              persistent-hint
              color="primary"
              density="compact"
              class="mb-2"
              hide-details="auto"
            />
            <v-textarea
              v-else-if="isTextLikeParam(field.paramType)"
              v-model="executeForm[field.alias]"
              :label="field.label || field.alias"
              :hint="`节点: ${field.nodeTitle} · ${field.fieldName} · ${field.paramType}`"
              persistent-hint
              variant="outlined"
              density="compact"
              class="mb-2"
              :rows="1"
              max-rows="6"
              auto-grow
            />
            <v-file-input
              v-else
              :label="field.label || field.alias"
              :hint="`节点: ${field.nodeTitle} · ${field.fieldName}`"
              persistent-hint
              variant="outlined"
              density="compact"
              class="mb-2"
              :accept="acceptType(field.paramType)"
              @update:model-value="(v: File | File[] | null) => {
                if (v) {
                  executeFiles[field.alias] = Array.isArray(v) ? v[0] : v;
                } else {
                  delete executeFiles[field.alias];
                }
              }"
            />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="submitting" @click="executeDialog = false">
            取消
          </v-btn>
          <v-btn color="primary" :loading="submitting" @click="confirmExecute">
            执行
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>确认删除</v-card-title>
        <v-card-text>确定要删除该工作流吗？此操作不可撤销。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">
            取消
          </v-btn>
          <v-btn color="error" @click="confirmDelete">
            删除
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <api-docs-dialog
      v-model="apiDialog"
      :workflow-id="apiTargetId"
      :workflow-name="apiTargetName"
    />

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import {
  listWorkflows,
  deleteWorkflow,
  getWorkflow,
  executeWorkflow,
  exportWorkflows,
  importWorkflows,
} from '@/api/workflows';
import type { Workflow, WorkflowParam } from '@/types';
import { authEnabled } from '@/api/auth-status';
import ApiDocsDialog from '@/components/ApiDocsDialog.vue';

interface ExecuteField {
  alias: string;
  label: string;
  fieldName: string;
  nodeTitle: string;
  paramType: string;
}

const router = useRouter();
const workflows = ref<Workflow[]>([]);
const deleteDialog = ref(false);
const deleteTarget = ref<string | null>(null);
const snackbar = ref({ show: false, text: '', color: 'success' });

// 多选导出 / 批量导入状态
const selectedIds = ref<Set<string>>(new Set());
const exporting = ref(false);
const importing = ref(false);
/** 隐藏的导入文件选择框引用 */
const importInput = ref<HTMLInputElement | null>(null);
/** 是否已全选 */
const allSelected = computed(
  () => workflows.value.length > 0 && workflows.value.every((w) => selectedIds.value.has(w.id)),
);

/**
 * 切换全选状态
 * @param val 是否全选
 */
function toggleSelectAll(val: unknown) {
  if (val) {
    selectedIds.value = new Set(workflows.value.map((w) => w.id));
  } else {
    selectedIds.value = new Set();
  }
}

/**
 * 切换单个工作流选中状态
 * @param id 工作流 ID
 */
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

/**
 * 导出选中的工作流为 ZIP
 */
async function handleExport() {
  if (selectedIds.value.size === 0) return;
  exporting.value = true;
  try {
    await exportWorkflows([...selectedIds.value]);
    snackbar.value = { show: true, text: '已导出', color: 'success' };
  } catch {
    snackbar.value = { show: true, text: '导出失败', color: 'error' };
  } finally {
    exporting.value = false;
  }
}

/**
 * 触发隐藏文件选择框（导入 ZIP）
 */
function triggerImport() {
  importInput.value?.click();
}

/**
 * 处理导入文件选择：上传 ZIP 并展示结果摘要
 * @param event 文件选择事件
 */
async function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 重置 input，允许重复导入同一文件
  input.value = '';
  if (!file) return;
  importing.value = true;
  try {
    const result = await importWorkflows(file);
    let text = `导入成功 ${result.imported} 个工作流`;
    if (result.renamed.length > 0) {
      text += `，${result.renamed.length} 个因 ID 冲突已改名`;
    }
    if (result.failed.length > 0) {
      text += `，${result.failed.length} 个失败`;
    }
    snackbar.value = {
      show: true,
      text,
      color: result.failed.length > 0 ? 'warning' : 'success',
    };
    await load();
  } catch {
    snackbar.value = { show: true, text: '导入失败，请检查文件格式', color: 'error' };
  } finally {
    importing.value = false;
  }
}

// 每个工作流对应的图标颜色
const itemColors = ['primary', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#E91E63', '#607D8B', '#795548', '#3F51B5', '#009688'];
function getColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return itemColors[Math.abs(hash) % itemColors.length];
}

// 执行对话框状态
const executeDialog = ref(false);
const executeTarget = ref<string | null>(null);
const executeLoading = ref(false);
const submitting = ref(false);
const executeFields = ref<ExecuteField[]>([]);
/** 执行表单值：boolean 为布尔，其余为字符串 */
const executeForm = reactive<Record<string, string | boolean>>({});
const executeFiles = reactive<Record<string, File>>({});

/**
 * 是否为文本类参数（非媒体上传、非 boolean 开关）
 * @param paramType 参数类型
 */
function isTextLikeParam(paramType: string): boolean {
  return !['image', 'video', 'audio', 'boolean'].includes(paramType);
}

/**
 * 将默认值解析为 boolean（用于 v-switch）
 * @param raw 原始默认值
 * @returns 布尔值；无法识别时默认 false
 */
function parseBooleanDefault(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  return false;
}

/**
 * 媒体文件 accept 类型
 * @param paramType 参数类型
 */
function acceptType(paramType: string): string {
  switch (paramType) {
    case 'image': return 'image/*';
    case 'video': return 'video/*';
    case 'audio': return 'audio/*';
    default: return '*/*';
  }
}

// API 调用说明对话框
const apiDialog = ref(false);
const apiTargetName = ref('');
const apiTargetId = ref('');
/**
 * 判断参数是否配置了非空别名（可对外调用）
 * @param p 工作流参数
 */
function hasAlias(p: WorkflowParam): p is WorkflowParam & { alias: string } {
  return p.alias != null && p.alias !== '';
}

/**
 * 打开 API 调用说明对话框
 * @param id 工作流 ID
 * @param name 工作流名称
 */
function handleApiDocs(id: string, name: string) {
  apiTargetId.value = id;
  apiTargetName.value = name;
  apiDialog.value = true;
}

async function load() {
  try {
    workflows.value = await listWorkflows();
  } catch {
    snackbar.value = { show: true, text: '加载失败', color: 'error' };
  }
}

function handleDelete(id: string) {
  deleteTarget.value = id;
  deleteDialog.value = true;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  try {
    await deleteWorkflow(deleteTarget.value);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  } finally {
    deleteDialog.value = false;
    deleteTarget.value = null;
  }
}

/**
 * 打开执行工作流对话框
 * @param id 工作流 ID
 */
async function handleExecute(id: string) {
  executeTarget.value = id;
  executeDialog.value = true;
  executeLoading.value = true;
  executeFields.value = [];
  // 清空旧表单数据
  Object.keys(executeForm).forEach(k => delete executeForm[k]);
  Object.keys(executeFiles).forEach(k => delete executeFiles[k]);

  try {
    const detail = await getWorkflow(id);
    const workflow = JSON.parse(detail.rawJson);

    const fields: ExecuteField[] = [];
    // 仅展示可调用的非空别名参数（仅默认值覆盖不可传参）
    for (const param of (detail.params ?? []).filter(hasAlias)) {
      // 从原始 JSON 中提取默认值（覆盖优先）
      const node = workflow[param.nodeId];
      if (!node) continue;
      const currentValue = node.inputs?.[param.fieldName];
      // 跳过数组类型（连接引用）
      if (Array.isArray(currentValue)) continue;

      const nodeTitle = node._meta?.title || param.nodeId;
      fields.push({
        alias: param.alias,
        label: param.label || param.alias,
        fieldName: param.fieldName,
        nodeTitle,
        paramType: param.paramType || 'text',
      });
      // 设置默认值：覆盖优先，否则 rawJson 原值；boolean 用开关布尔值
      const effectiveDefault = param.defaultValue != null
        ? param.defaultValue
        : currentValue;
      if ((param.paramType || 'text') === 'boolean') {
        executeForm[param.alias] = parseBooleanDefault(effectiveDefault);
      } else {
        executeForm[param.alias] = String(effectiveDefault ?? '');
      }
    }

    executeFields.value = fields;
  } catch {
    snackbar.value = { show: true, text: '加载工作流详情失败', color: 'error' };
    executeDialog.value = false;
  } finally {
    executeLoading.value = false;
  }
}

async function confirmExecute() {
  if (!executeTarget.value) return;
  submitting.value = true;
  try {
    const aliasValues: Record<string, string | boolean> = {};
    for (const field of executeFields.value) {
      // 媒体参数由 files 承载；表单中可能无对应文本值
      if (field.paramType === 'image' || field.paramType === 'video' || field.paramType === 'audio') {
        continue;
      }
      const val = executeForm[field.alias];
      if (field.paramType === 'boolean') {
        aliasValues[field.alias] = Boolean(val);
      } else {
        aliasValues[field.alias] = String(val ?? '');
      }
    }
    const files = Object.keys(executeFiles).length > 0 ? { ...executeFiles } : undefined;
    const result = await executeWorkflow(executeTarget.value, aliasValues, files);
    snackbar.value = { show: true, text: `任务已提交 (${result.task_id.slice(0, 8)}...)`, color: 'success' };
    executeDialog.value = false;
  } catch {
    snackbar.value = { show: true, text: '执行失败', color: 'error' };
  } finally {
    submitting.value = false;
  }
}

function handleLogout() {
  localStorage.removeItem('token');
  router.push('/login');
}

onMounted(load);
</script>

<style scoped>
</style>
