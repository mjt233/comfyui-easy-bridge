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
    <v-btn to="/admin/tags" variant="text" prepend-icon="mdi-tag-multiple">
      标签管理
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

    <!-- 标签筛选条：多选 chips，AND 语义（父/子标签分组展示） -->
    <!-- 注意：不绑定 model-value/filter（v-chip 的 modelValue=false 会使整个 chip 不渲染；
         无 v-chip-group 时 filter 的选中勾也无效），选中态由 :color 表达 -->
    <v-row v-if="tagTree.length > 0" class="mb-2 align-center">
      <v-col cols="auto" class="text-subtitle-2">
        按标签筛选：
      </v-col>
      <v-col>
        <div class="d-flex flex-wrap ga-1">
          <template v-for="parent in tagTree" :key="parent.id">
            <v-chip
              :color="selectedTagIds.has(parent.id) ? 'primary' : ''"
              variant="tonal"
              @click="toggleFilterTag(parent.id)"
            >
              {{ parent.name }}
            </v-chip>
            <v-chip
              v-for="child in parent.children"
              :key="child.id"
              :color="selectedTagIds.has(child.id) ? 'secondary' : ''"
              variant="flat"
              size="small"
              class="ml-1"
              @click="toggleFilterTag(child.id)"
            >
              {{ child.name }}
            </v-chip>
          </template>
          <v-btn
            v-if="selectedTagIds.size > 0"
            size="small"
            variant="text"
            @click="clearFilter"
          >
            清空
          </v-btn>
        </div>
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
        <!-- 有筛选条件时空态提示：新建的工作流无标签，不会出现在当前筛选下 -->
        <template v-if="selectedTagIds.size > 0">
          没有匹配所选标签的工作流
          <v-btn size="small" variant="text" color="primary" @click="clearFilter">
            清空筛选
          </v-btn>
        </template>
        <template v-else>
          暂无工作流，点击上方按钮新建
        </template>
      </v-card-text>
    </v-card>

    <v-list v-else lines="two">
      <v-list-item
        v-for="wf in workflows"
        :key="wf.id"
        :subtitle="`ID: ${wf.id} | 创建: ${wf.createdAt}`"
        @click="router.push(`/admin/workflow/${wf.id}`)"
      >
        <!-- 标题行：标签 chips 位于工作流名称之前，与名称同一行展示 -->
        <template #title>
          <div class="d-flex align-center flex-wrap ga-1">
            <template v-if="wf.tags && wf.tags.length > 0">
              <template v-for="group in wf.tags" :key="group.id">
                <v-chip size="x-small" color="primary" variant="tonal">
                  {{ group.name }}
                </v-chip>
                <v-chip
                  v-for="child in group.tags"
                  :key="child.id"
                  size="x-small"
                  color="secondary"
                  variant="flat"
                >
                  {{ child.name }}
                </v-chip>
              </template>
            </template>
            <span>{{ wf.name }}</span>
          </div>
        </template>
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
        <!-- 标签 chips 已移到 #title 槽（与工作流名称同行，位于名称之前） -->
        <template #append>
          <!-- 打标签入口 -->
          <v-btn
            icon
            variant="text"
            size="small"
            class="mr-2"
            @click.stop="openTagDialog(wf)"
          >
            <v-icon>mdi-tag-outline</v-icon>
          </v-btn>
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
            @click.stop="handleDuplicate(wf.id)"
          >
            <v-icon>mdi-content-copy</v-icon>
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

    <v-dialog v-model="executeDialog" max-width="760" :loading="executeLoading">
      <v-card>
        <v-card-title>执行工作流</v-card-title>
        <v-card-text>
          <!-- 备注说明：有内容时提供展开/收起，渲染 Markdown -->
          <template v-if="executeDescription">
            <div class="d-flex align-center mb-1">
              <span class="text-subtitle-2">备注说明</span>
              <v-spacer />
              <v-btn
                size="small"
                variant="text"
                color="primary"
                :prepend-icon="showExecuteDescription ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                @click="showExecuteDescription = !showExecuteDescription"
              >
                {{ showExecuteDescription ? '收起说明' : '展开说明' }}
              </v-btn>
            </div>
            <v-expand-transition>
              <div v-show="showExecuteDescription" class="mb-3">
                <MarkdownView :source="executeDescription" />
              </div>
            </v-expand-transition>
          </template>
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
            <!-- 单行布局：输入控件（自带 label）+ 字段类型下拉（覆盖仅本次有效，不写回配置） -->
            <div class="d-flex align-center ga-3 mb-2">
              <!-- 输入控件（弹性宽度，label 即字段名称） -->
              <v-switch
                v-if="field.overrideType === 'boolean'"
                v-model="executeForm[field.alias]"
                :label="field.label || field.alias"
                :hint="fieldHint(field)"
                persistent-hint
                color="primary"
                density="compact"
                class="flex-grow-1"
                hide-details="auto"
              />
              <v-file-input
                v-else-if="isMediaType(field.overrideType)"
                :label="field.label || field.alias"
                :hint="fieldHint(field)"
                persistent-hint
                variant="outlined"
                density="compact"
                class="flex-grow-1"
                multiple
                :accept="acceptType(field.overrideType)"
                @update:model-value="(v: File | File[] | null) => {
                  if (v) {
                    executeFiles[field.alias] = Array.isArray(v) ? v : [v];
                  } else {
                    delete executeFiles[field.alias];
                  }
                }"
              />
              <v-textarea
                v-else
                v-model="executeForm[field.alias]"
                :label="field.label || field.alias"
                :hint="fieldHint(field)"
                persistent-hint
                variant="outlined"
                density="compact"
                class="flex-grow-1"
                :rows="1"
                max-rows="4"
                auto-grow
              />
              <!-- 字段类型下拉（固定宽度） -->
              <v-select
                v-model="field.overrideType"
                :items="paramTypeOptions"
                label="类型"
                density="compact"
                variant="outlined"
                hide-details
                style="width: 130px; flex-shrink: 0"
                @update:model-value="onOverrideTypeChange(field)"
              />
            </div>
          </template>

          <!-- 手动添加的自定义字段 -->
          <template v-if="!executeLoading">
            <v-divider class="my-2" />
            <div class="d-flex align-center mb-2">
              <span class="text-subtitle-2">自定义字段</span>
              <v-spacer />
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-plus"
                @click="addManualField"
              >
                添加自定义字段
              </v-btn>
            </div>
            <div
              v-for="(f, i) in manualFields"
              :key="i"
              class="d-flex align-center ga-2 mb-2"
            >
              <v-text-field
                v-model="f.key"
                label="字段名"
                density="compact"
                variant="outlined"
                hide-details
                style="max-width: 170px"
              />
              <v-select
                v-model="f.type"
                :items="['text', 'number', 'boolean', 'image', 'video', 'audio']"
                label="类型"
                density="compact"
                variant="outlined"
                hide-details
                style="max-width: 120px"
              />
              <!-- 布尔类型：开关；媒体类型：单文件选择；其余：文本输入 -->
              <v-switch
                v-if="f.type === 'boolean'"
                v-model="f.booleanValue"
                label="值"
                density="compact"
                hide-details
              />
              <v-file-input
                v-else-if="['image', 'video', 'audio'].includes(f.type)"
                :accept="acceptType(f.type)"
                density="compact"
                variant="outlined"
                hide-details
                class="flex-grow-1"
                @update:model-value="(v: File | File[] | null) => {
                  if (v) {
                    manualFiles[f.key] = Array.isArray(v) ? v : [v];
                  } else {
                    delete manualFiles[f.key];
                  }
                }"
              />
              <v-text-field
                v-else
                v-model="f.value"
                label="值"
                density="compact"
                variant="outlined"
                hide-details
                class="flex-grow-1"
              />
              <v-btn
                icon="mdi-close"
                size="small"
                variant="text"
                @click="manualFields.splice(i, 1)"
              />
            </div>
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

    <!-- 打标签弹窗：保存成功后由父组件关闭并刷新列表 -->
    <WorkflowTagEditorDialog
      v-model="tagDialog"
      :all-tags="tagTree"
      :current-tags="tagDialogWorkflow?.tags ?? []"
      :saving="savingTags"
      @save="handleSaveTags"
    />
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
  duplicateWorkflow,
} from '@/api/workflows';
import { listTags, setWorkflowTags } from '@/api/tags';
import type { TagTreeNode, Workflow, WorkflowParam, WorkflowTagInput } from '@/types';
import { authEnabled } from '@/api/auth-status';
import ApiDocsDialog from '@/components/ApiDocsDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import WorkflowTagEditorDialog from '@/components/WorkflowTagEditorDialog.vue';

interface ExecuteField {
  alias: string;
  label: string;
  /** 节点 inputs 字段名（动态声明字段为空串） */
  fieldName: string;
  /** 节点标题（动态声明字段为空串） */
  nodeTitle: string;
  paramType: string;
  /** 本次执行覆盖类型（默认 = paramType，仅本次执行有效，不写回配置） */
  overrideType: string;
  /** 是否为动态字段静态声明（无对应节点） */
  dynamic?: boolean;
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

// 标签筛选 / 打标签弹窗状态
/** 标签树（顶部筛选条与打标签弹窗共用） */
const tagTree = ref<TagTreeNode[]>([]);
/** 当前选中的筛选标签 ID 集合（AND 语义） */
const selectedTagIds = ref<Set<string>>(new Set());
/** 打标签弹窗目标工作流 */
const tagDialogWorkflow = ref<Workflow | null>(null);
/** 打标签弹窗可见性 */
const tagDialog = ref(false);
/** 打标签保存中（保存期间禁用弹窗按钮） */
const savingTags = ref(false);

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
/** 执行对话框中展示的工作流备注说明（Markdown 源文本） */
const executeDescription = ref('');
/** 执行对话框中备注说明是否展开 */
const showExecuteDescription = ref(false);
/** 执行表单值：boolean 为布尔，其余为字符串 */
const executeForm = reactive<Record<string, string | boolean>>({});
/** 已配置媒体参数的文件（key 为别名，支持多文件） */
const executeFiles = reactive<Record<string, File[]>>({});

/** 参数类型选项（执行对话框类型覆盖下拉） */
const paramTypeOptions = ['text', 'number', 'boolean', 'image', 'video', 'audio'];

/**
 * 执行字段提示文本：动态声明字段显示「动态字段」，静态参数显示节点/字段/类型
 * @param field 执行字段
 */
function fieldHint(field: ExecuteField): string {
  if (field.dynamic) {
    return `动态字段 · ${field.overrideType}`;
  }
  const base = `节点: ${field.nodeTitle} · ${field.fieldName}`;
  const isMedia = ['image', 'video', 'audio'].includes(field.overrideType);
  // 媒体字段提示：需要直接输入值时可将类型切换为 text
  return isMedia ? `${base} · 输入值请切换为 text 类型` : `${base} · ${field.overrideType}`;
}

/**
 * 手动添加的自定义字段行
 */
interface ManualField {
  /** 字段名 */
  key: string;
  /** 字段类型 text/number/boolean/image/video/audio */
  type: string;
  /** 文本/数字字段值 */
  value: string;
  /** 布尔字段值 */
  booleanValue: boolean;
}

/** 手动添加的自定义字段列表 */
const manualFields = ref<ManualField[]>([]);
/** 手动添加的媒体文件（key 为字段名，媒体自由字段单文件以数组承载） */
const manualFiles = ref<Record<string, File[]>>({});

/**
 * 添加一行手动自定义字段
 */
function addManualField(): void {
  manualFields.value.push({ key: '', type: 'text', value: '', booleanValue: false });
}

/**
 * 是否为媒体类型
 * @param paramType 参数类型
 */
function isMediaType(paramType: string): boolean {
  return ['image', 'video', 'audio'].includes(paramType);
}

/**
 * 切换字段类型覆盖后重置表单值（避免旧类型残留值污染新类型控件）
 * @param field 被切换类型的字段
 */
function onOverrideTypeChange(field: ExecuteField): void {
  // 清空已选文件，避免旧媒体文件残留
  delete executeFiles[field.alias];
  // 按新类型重置表单值：布尔用 false，其余清空
  if (field.overrideType === 'boolean') {
    executeForm[field.alias] = false;
  } else {
    executeForm[field.alias] = '';
  }
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

/**
 * 加载标签树（顶部筛选条与打标签弹窗共用）
 */
async function loadTags() {
  try {
    tagTree.value = await listTags();
  } catch (err) {
    console.warn('加载标签树失败', err);
    tagTree.value = [];
  }
}

/**
 * 切换筛选标签：选中/取消后按当前集合重新拉取列表（多标签 AND）
 * @param id 标签 ID
 */
function toggleFilterTag(id: string) {
  const next = new Set(selectedTagIds.value);
  // 已选中则移除，未选中则加入（切换后整体替换集合）
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedTagIds.value = next;
  load();
}

/**
 * 清空标签筛选并重新拉取完整列表
 */
function clearFilter() {
  selectedTagIds.value = new Set();
  load();
}

/**
 * 打开某工作流的打标签弹窗
 * @param wf 目标工作流
 */
function openTagDialog(wf: Workflow) {
  tagDialogWorkflow.value = wf;
  tagDialog.value = true;
}

/**
 * 保存标签：成功后关闭弹窗并刷新列表；失败时通过 snackbar 展示错误
 * @param tags 整组标签（tagId + 可选元数据）
 */
async function handleSaveTags(tags: WorkflowTagInput[]) {
  if (!tagDialogWorkflow.value) return;
  savingTags.value = true;
  try {
    await setWorkflowTags(tagDialogWorkflow.value.id, tags);
    // 先刷新列表，再关闭弹窗，避免保存后列表仍显示旧标签
    await load();
    tagDialog.value = false;
  } catch (err) {
    // 错误信息仅在当前作用域用于拼接 snackbar 文案，无需提升为组件状态
    const errorMessage = err instanceof Error ? err.message : String(err);
    snackbar.value = { show: true, text: `保存标签失败: ${errorMessage}`, color: 'error' };
  } finally {
    savingTags.value = false;
  }
}

async function load() {
  try {
    // 有选中的筛选标签时携带 tags 参数（AND 语义），否则拉取全部
    const ids = [...selectedTagIds.value];
    workflows.value = await listWorkflows(ids.length > 0 ? ids : undefined);
  } catch {
    snackbar.value = { show: true, text: '加载失败', color: 'error' };
  }
}

function handleDelete(id: string) {
  deleteTarget.value = id;
  deleteDialog.value = true;
}

/**
 * 复制工作流：调用后端克隆接口后刷新列表
 * @param id 工作流 ID
 */
async function handleDuplicate(id: string) {
  try {
    await duplicateWorkflow(id);
    snackbar.value = { show: true, text: '已复制', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '复制失败', color: 'error' };
  }
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
  executeDescription.value = '';
  showExecuteDescription.value = false;
  // 清空旧表单数据
  Object.keys(executeForm).forEach(k => delete executeForm[k]);
  Object.keys(executeFiles).forEach(k => delete executeFiles[k]);
  // 清空手动添加的自定义字段
  manualFields.value = [];
  manualFiles.value = {};

  try {
    const detail = await getWorkflow(id);
    const workflow = JSON.parse(detail.rawJson);
    // 填充备注说明（Markdown 源文本）
    executeDescription.value = detail.description ?? '';

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
        // 本次执行类型覆盖初始为持久化/声明类型（仅本次有效）
        overrideType: param.paramType || 'text',
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

    // 追加动态字段静态声明：与静态参数合并为一个表单（按 alias 去重，静态优先）
    const declaredAliases = new Set(fields.map((f) => f.alias));
    for (const dp of detail.declaredParams ?? []) {
      if (declaredAliases.has(dp.alias)) continue;
      declaredAliases.add(dp.alias);
      fields.push({
        alias: dp.alias,
        label: dp.label || dp.alias,
        fieldName: '',
        nodeTitle: '',
        paramType: dp.paramType || 'text',
        // 动态声明字段同样支持本次执行类型覆盖
        overrideType: dp.paramType || 'text',
        dynamic: true,
      });
      // 按声明的默认值预填表单（boolean 用开关布尔值）
      if ((dp.paramType || 'text') === 'boolean') {
        executeForm[dp.alias] = parseBooleanDefault(dp.defaultValue);
      } else {
        executeForm[dp.alias] = String(dp.defaultValue ?? '');
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
    const aliasValues: Record<string, string | number | boolean> = {};
    /** 本次执行类型覆盖（别名 → 类型），仅当与持久化类型不同时收集 */
    const paramTypeOverrides: Record<string, string> = {};
    const files: Record<string, File[]> = {};
    for (const field of executeFields.value) {
      // 收集本次执行类型覆盖（覆盖仅本次请求有效）
      if (field.overrideType !== field.paramType) {
        paramTypeOverrides[field.alias] = field.overrideType;
      }
      const type = field.overrideType;
      if (type === 'boolean') {
        aliasValues[field.alias] = Boolean(executeForm[field.alias]);
      } else if (type === 'image' || type === 'video' || type === 'audio') {
        // 媒体字段走文件上传；需要直接输入值时把类型切换为 text（走 aliasValues）
        const fileList = executeFiles[field.alias];
        if (fileList && fileList.length > 0) {
          files[field.alias] = fileList;
        }
      } else {
        // text / number：字符串提交，类型转换由后端按（覆盖后的）paramType 完成
        const val = executeForm[field.alias];
        aliasValues[field.alias] = String(val ?? '');
      }
    }
    // 手动添加的自定义字段：非媒体并入 aliasValues（boolean/number 转换），媒体并入 files
    for (const f of manualFields.value) {
      const key = f.key.trim();
      if (!key) continue;
      if (f.type === 'boolean') {
        aliasValues[key] = f.booleanValue;
      } else if (f.type === 'number') {
        aliasValues[key] = f.value === '' ? '' : Number(f.value);
      } else if (f.type === 'image' || f.type === 'video' || f.type === 'audio') {
        const fileList = manualFiles.value[key];
        if (fileList && fileList.length > 0) {
          files[key] = fileList;
        }
      } else {
        aliasValues[key] = f.value;
      }
    }
    const hasFiles = Object.keys(files).length > 0;
    const hasOverrides = Object.keys(paramTypeOverrides).length > 0;
    const result = await executeWorkflow(
      executeTarget.value,
      aliasValues,
      hasFiles ? files : undefined,
      hasOverrides ? paramTypeOverrides : undefined,
    );
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

onMounted(() => {
  load();
  loadTags();
});
</script>

<style scoped>
</style>
