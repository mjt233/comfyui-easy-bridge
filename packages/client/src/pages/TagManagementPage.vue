<template>
  <v-app-bar color="primary">
    <v-app-bar-title>标签管理</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">
      返回
    </v-btn>
  </v-app-bar>

  <v-container>
    <!-- 列表加载失败提示 -->
    <v-alert
      v-if="error"
      type="error"
      closable
      class="mb-4"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>

    <!-- 初始加载进度条 -->
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-card>
      <v-card-title>标签树</v-card-title>
      <v-card-text>
        <!-- 顶层新建入口 -->
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateDialog(null)">
          新建标签
        </v-btn>

        <v-alert v-if="tags.length === 0 && !loading" type="info" class="mt-4">
          暂无标签，点击上方按钮新建。
        </v-alert>

        <!-- 标签树：顶层节点 + 可展开的子节点分组 -->
        <v-list v-if="tags.length > 0" class="mt-2">
          <template v-for="tag in tags" :key="tag.id">
            <!-- 有子标签的顶层节点：可展开的分组 -->
            <v-list-group v-if="tag.children.length > 0" :value="tag.id">
              <template #activator="{ props }">
                <v-list-item v-bind="props" :title="tag.name">
                  <template #prepend>
                    <v-icon color="primary">mdi-tag</v-icon>
                  </template>
                  <template #append>
                    <div class="d-flex align-center">
                      <v-chip v-if="tag.isPreset === 1" size="small" color="primary" variant="tonal" class="mr-2">
                        预设
                      </v-chip>
                      <span v-if="tag.metadataDef.length > 0" class="text-caption text-grey mr-2">
                        元数据 ×{{ tag.metadataDef.length }}
                      </span>
                      <v-btn size="small" variant="text" title="新建子标签" @click.stop="openCreateDialog(tag)">
                        <v-icon>mdi-plus</v-icon>
                      </v-btn>
                      <template v-if="tag.isPreset !== 1">
                        <v-btn size="small" variant="text" title="编辑" @click.stop="openEditDialog(tag)">
                          <v-icon>mdi-pencil</v-icon>
                        </v-btn>
                        <v-btn size="small" variant="text" color="error" title="删除" @click.stop="openDeleteDialog(tag)">
                          <v-icon>mdi-delete</v-icon>
                        </v-btn>
                      </template>
                    </div>
                  </template>
                </v-list-item>
              </template>
              <v-list-item v-for="child in tag.children" :key="child.id" :title="child.name">
                <template #prepend>
                  <v-icon>mdi-tag-outline</v-icon>
                </template>
                <template #append>
                  <div class="d-flex align-center">
                    <v-chip v-if="child.isPreset === 1" size="small" color="primary" variant="tonal" class="mr-2">
                      预设
                    </v-chip>
                    <span v-if="child.metadataDef.length > 0" class="text-caption text-grey mr-2">
                      元数据 ×{{ child.metadataDef.length }}
                    </span>
                    <template v-if="child.isPreset !== 1">
                      <v-btn size="small" variant="text" title="编辑" @click.stop="openEditDialog(child)">
                        <v-icon>mdi-pencil</v-icon>
                      </v-btn>
                      <v-btn size="small" variant="text" color="error" title="删除" @click.stop="openDeleteDialog(child)">
                        <v-icon>mdi-delete</v-icon>
                      </v-btn>
                    </template>
                  </div>
                </template>
              </v-list-item>
            </v-list-group>
            <!-- 无子标签的顶层节点 -->
            <v-list-item v-else :title="tag.name">
              <template #prepend>
                <v-icon color="primary">mdi-tag</v-icon>
              </template>
              <template #append>
                <div class="d-flex align-center">
                  <v-chip v-if="tag.isPreset === 1" size="small" color="primary" variant="tonal" class="mr-2">
                    预设
                  </v-chip>
                  <span v-if="tag.metadataDef.length > 0" class="text-caption text-grey mr-2">
                    元数据 ×{{ tag.metadataDef.length }}
                  </span>
                  <v-btn size="small" variant="text" title="新建子标签" @click.stop="openCreateDialog(tag)">
                    <v-icon>mdi-plus</v-icon>
                  </v-btn>
                  <template v-if="tag.isPreset !== 1">
                    <v-btn size="small" variant="text" title="编辑" @click.stop="openEditDialog(tag)">
                      <v-icon>mdi-pencil</v-icon>
                    </v-btn>
                    <v-btn size="small" variant="text" color="error" title="删除" @click.stop="openDeleteDialog(tag)">
                      <v-icon>mdi-delete</v-icon>
                    </v-btn>
                  </template>
                </div>
              </template>
            </v-list-item>
          </template>
        </v-list>
      </v-card-text>
    </v-card>

    <!-- 新建/编辑标签弹窗 -->
    <v-dialog v-model="dialog.show" max-width="760">
      <v-card>
        <v-card-title>{{ dialog.isEdit ? '编辑标签' : '新建标签' }}</v-card-title>
        <v-card-text>
          <!-- 弹窗内 API 错误提示 -->
          <v-alert
            v-if="dialogError"
            type="error"
            closable
            class="mb-4"
            @click:close="dialogError = ''"
          >
            {{ dialogError }}
          </v-alert>

          <v-text-field
            v-model="form.name"
            label="显示名"
            required
            variant="outlined"
            class="mb-4"
          />

          <!-- 父标签：顶层 + 二级子标签（缩进展示，子标签禁用——后端仅允许一级层级）；编辑时不可改 -->
          <v-select
            v-model="form.parentId"
            :items="parentOptions"
            label="父标签"
            hint="仅可选择顶层标签作为父标签；不选择则为顶层标签"
            persistent-hint
            variant="outlined"
            class="mb-4"
            clearable
            :disabled="dialog.isEdit"
          />

          <!-- 元数据字段编辑器 -->
          <div class="d-flex align-center mb-2">
            <span class="text-subtitle-1">元数据字段</span>
            <v-spacer />
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addField">
              添加字段
            </v-btn>
          </div>

          <div v-if="form.metadataDef.length > 0">
            <v-row
              v-for="(row, idx) in form.metadataDef"
              :key="idx"
              no-gutters
              align="center"
              class="mb-1"
            >
              <v-col cols="3" class="pr-2">
                <v-text-field
                  v-model="row.key"
                  label="键"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="3" class="pr-2">
                <v-text-field
                  v-model="row.label"
                  label="显示名"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="2" class="pr-2">
                <!-- 类型切换时重置默认值（onFieldTypeChange） -->
                <v-select
                  :model-value="row.type"
                  :items="FIELD_TYPE_OPTIONS"
                  label="类型"
                  variant="outlined"
                  density="compact"
                  hide-details
                  @update:model-value="(val) => onFieldTypeChange(row, val)"
                />
              </v-col>
              <v-col cols="3" class="pr-2">
                <!-- 默认值控件随类型切换：数字框 / 文本框 / 开关 -->
                <v-text-field
                  v-if="row.type === 'number'"
                  v-model.number="row.defaultValue"
                  label="默认值"
                  type="number"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
                <v-text-field
                  v-else-if="row.type === 'string'"
                  v-model="row.defaultValue"
                  label="默认值"
                  variant="outlined"
                  density="compact"
                  hide-details
                />
                <v-switch
                  v-else
                  v-model="row.defaultValue"
                  label="默认值"
                  density="compact"
                  hide-details
                  class="mt-1"
                />
              </v-col>
              <v-col cols="1">
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  color="error"
                  title="删除字段"
                  @click="removeField(idx)"
                >
                  <v-icon>mdi-delete</v-icon>
                </v-btn>
              </v-col>
            </v-row>
          </div>
          <p v-else class="text-caption text-grey">
            暂无元数据字段。
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeDialog">
            取消
          </v-btn>
          <v-btn color="primary" :loading="saving" @click="handleSave">
            保存
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 删除确认弹窗（需输入标签名称确认） -->
    <v-dialog v-model="deleteDialog.show" max-width="420">
      <v-card>
        <v-card-title>删除标签</v-card-title>
        <v-card-text>
          <!-- 弹窗内 API 错误提示（后端拒绝删除时展示原因） -->
          <v-alert
            v-if="deleteError"
            type="error"
            closable
            class="mb-4"
            @click:close="deleteError = ''"
          >
            {{ deleteError }}
          </v-alert>
          <p class="mb-4">
            确定删除标签「<strong>{{ deleteDialog.tag?.name }}</strong>」吗？删除后不可恢复。
          </p>
          <v-text-field
            v-model="deleteConfirmName"
            label="请输入标签名称以确认"
            variant="outlined"
            :disabled="deleting"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeDeleteDialog">
            取消
          </v-btn>
          <v-btn
            color="error"
            :disabled="deleteConfirmName !== deleteDialog.tag?.name"
            :loading="deleting"
            @click="handleDelete"
          >
            删除
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { createTag, deleteTag, listTags, updateTag } from '@/api/tags';
import type { TagMetadataFieldDef, TagMetadataFieldType, TagTreeNode } from '@/types';

/** 元数据字段类型下拉选项 */
const FIELD_TYPE_OPTIONS: Array<{ title: string; value: TagMetadataFieldType }> = [
  { title: '数字', value: 'number' },
  { title: '文本', value: 'string' },
  { title: '布尔', value: 'boolean' },
];

/** 后端错误响应体（{error, code}） */
interface ApiErrorBody {
  /** 错误消息 */
  error?: string;
  /** 业务错误码 */
  code?: string;
}

/** 弹窗内元数据字段编辑行 */
interface MetadataFieldRow {
  /** 字段键 */
  key: string;
  /** 显示名 */
  label: string;
  /** 字段类型 */
  type: TagMetadataFieldType;
  /** 默认值（数字/文本/布尔，随类型切换控件） */
  defaultValue: number | string | boolean;
}

/** 标签树 */
const tags = ref<TagTreeNode[]>([]);
/** 列表加载中 */
const loading = ref(true);
/** 列表区错误提示 */
const error = ref('');

/** 新建/编辑弹窗状态 */
const dialog = ref<{
  /** 是否显示弹窗 */
  show: boolean;
  /** 是否为编辑模式 */
  isEdit: boolean;
  /** 编辑中的标签 ID */
  id: string;
}>({ show: false, isEdit: false, id: '' });

/** 标签表单模型 */
const form = ref<{
  /** 显示名 */
  name: string;
  /** 父标签 ID；null=顶层 */
  parentId: string | null;
  /** 元数据字段编辑行 */
  metadataDef: MetadataFieldRow[];
}>({ name: '', parentId: null, metadataDef: [] });

/** 弹窗内保存中 */
const saving = ref(false);
/** 弹窗内错误提示 */
const dialogError = ref('');

/** 删除确认弹窗状态 */
const deleteDialog = ref<{ show: boolean; tag: TagTreeNode | null }>({ show: false, tag: null });
/** 删除确认输入的名称 */
const deleteConfirmName = ref('');
/** 删除进行中 */
const deleting = ref(false);
/** 删除弹窗内错误提示 */
const deleteError = ref('');

/**
 * 父标签下拉选项：顶层标签 + 二级子标签（缩进展示；子标签禁用——后端仅允许一级层级）。
 * 子标签仅作层级展示，选择父标签时不可选。
 */
const parentOptions = computed<Array<{ title: string; value: string; disabled: boolean }>>(() => {
  const options: Array<{ title: string; value: string; disabled: boolean }> = [];
  for (const top of tags.value) {
    options.push({ title: top.name, value: top.id, disabled: false });
    for (const child of top.children) {
      options.push({ title: `　└ ${child.name}`, value: child.id, disabled: true });
    }
  }
  return options;
});

/**
 * 加载标签树；失败时在页面顶部展示错误。
 */
async function loadTags(): Promise<void> {
  try {
    tags.value = await listTags();
    error.value = '';
  } catch {
    error.value = '加载标签列表失败';
  } finally {
    loading.value = false;
  }
}

/**
 * 从任意异常中提取后端错误体；非 API 错误返回 null。
 * @param err 捕获到的异常
 */
function extractApiError(err: unknown): ApiErrorBody | null {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: unknown } }).response;
    const data = resp?.data;
    if (data && typeof data === 'object') {
      const body = data as ApiErrorBody;
      return {
        error: typeof body.error === 'string' ? body.error : undefined,
        code: typeof body.code === 'string' ? body.code : undefined,
      };
    }
  }
  return null;
}

/**
 * 将 API 错误转为展示消息：已知错误码映射为中文文案，其余回退为后端原始错误文本。
 * @param err 捕获到的异常
 * @param codeMap 错误码 → 中文文案映射
 */
function friendlyApiError(err: unknown, codeMap: Record<string, string>): string {
  const body = extractApiError(err);
  if (body?.code && codeMap[body.code]) return codeMap[body.code];
  if (body?.error) return body.error;
  return '操作失败，请重试';
}

/**
 * 打开新建标签弹窗。
 * @param parentTag 父标签（从「新建子标签」进入时预填；null=顶层新建）
 */
function openCreateDialog(parentTag: TagTreeNode | null): void {
  dialog.value = { show: true, isEdit: false, id: '' };
  form.value = {
    name: '',
    parentId: parentTag ? parentTag.id : null,
    metadataDef: [],
  };
  dialogError.value = '';
}

/**
 * 打开编辑标签弹窗（预设标签只读，防御性跳过）。
 * @param tag 待编辑的标签
 */
function openEditDialog(tag: TagTreeNode): void {
  // 预设标签只读，正常情况下不显示编辑按钮；此处防御
  if (tag.isPreset === 1) return;
  dialog.value = { show: true, isEdit: true, id: tag.id };
  form.value = {
    name: tag.name,
    parentId: tag.parentId,
    // 浅拷贝字段定义，避免直接修改标签树数据
    metadataDef: tag.metadataDef.map((f) => ({ ...f })),
  };
  dialogError.value = '';
}

/** 关闭新建/编辑弹窗（保存中不允许关闭） */
function closeDialog(): void {
  if (saving.value) return;
  dialog.value.show = false;
}

/** 追加一个空的元数据字段行 */
function addField(): void {
  form.value.metadataDef.push({ key: '', label: '', type: 'string', defaultValue: '' });
}

/** 删除指定下标的元数据字段行 */
function removeField(index: number): void {
  form.value.metadataDef.splice(index, 1);
}

/**
 * 字段类型选择变更：更新类型并重置默认值（保证默认值与类型匹配）。
 * @param row 字段编辑行
 * @param val 新类型（非法值回退为 string）
 */
function onFieldTypeChange(row: MetadataFieldRow, val: unknown): void {
  row.type = val === 'number' || val === 'boolean' ? val : 'string';
  row.defaultValue = row.type === 'number' ? 0 : row.type === 'boolean' ? false : '';
}

/**
 * 按类型规范化默认值（数字解析失败归 0；布尔仅接受 true；其余按文本处理）。
 * @param type 字段类型
 * @param v 表单原始默认值
 */
function normalizeDefaultValue(
  type: TagMetadataFieldType,
  v: number | string | boolean,
): number | string | boolean {
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
    return Number.isNaN(n) ? 0 : n;
  }
  if (type === 'boolean') return v === true;
  return typeof v === 'string' ? v : String(v);
}

/**
 * 保存标签（新建或编辑），成功后关闭弹窗并刷新列表。
 */
async function handleSave(): Promise<void> {
  const name = form.value.name.trim();
  if (!name) {
    dialogError.value = '请输入显示名';
    return;
  }
  // 过滤完全空白的字段行（误添加的空行），其余交由后端校验
  const metadataDef: TagMetadataFieldDef[] = form.value.metadataDef
    .filter((row) => row.key.trim() !== '' || row.label.trim() !== '')
    .map((row) => ({
      key: row.key.trim(),
      label: row.label,
      type: row.type,
      defaultValue: normalizeDefaultValue(row.type, row.defaultValue),
    }));

  saving.value = true;
  dialogError.value = '';
  try {
    if (dialog.value.isEdit) {
      await updateTag(dialog.value.id, { name, metadataDef });
    } else {
      await createTag({ name, parentId: form.value.parentId, metadataDef });
    }
    dialog.value.show = false;
    // 新建/更新返回的是 DB 行而非树节点，直接重新拉取标签树最可靠
    await loadTags();
  } catch (err) {
    // 后端拒绝时（重名/父标签不存在等）在弹窗内展示原因
    dialogError.value = friendlyApiError(err, {
      tag_conflict: '同层级下已存在同名标签',
      tag_not_found: '父标签不存在或已被删除',
      missing_parameter: '参数校验失败，请检查填写内容',
    });
  } finally {
    saving.value = false;
  }
}

/**
 * 打开删除确认弹窗（预设标签只读，防御性跳过）。
 * @param tag 待删除的标签
 */
function openDeleteDialog(tag: TagTreeNode): void {
  // 预设标签只读，正常情况下不显示删除按钮；此处防御
  if (tag.isPreset === 1) return;
  deleteDialog.value = { show: true, tag };
  deleteConfirmName.value = '';
  deleteError.value = '';
}

/** 关闭删除确认弹窗（删除中不允许关闭） */
function closeDeleteDialog(): void {
  if (deleting.value) return;
  deleteDialog.value.show = false;
}

/**
 * 确认删除标签（要求输入名称匹配）；后端拒绝时在弹窗内展示原因。
 */
async function handleDelete(): Promise<void> {
  const tag = deleteDialog.value.tag;
  if (!tag || deleteConfirmName.value !== tag.name) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await deleteTag(tag.id);
    deleteDialog.value.show = false;
    await loadTags();
  } catch (err) {
    // 后端拒绝删除（预设/有子/被引用）时展示友好原因
    deleteError.value = friendlyApiError(err, {
      tag_preset_readonly: '预设标签不可删除',
      tag_has_children: '该标签下存在子标签，无法删除',
      tag_in_use: '标签被工作流引用，无法删除',
      tag_not_found: '标签不存在或已被删除',
    });
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  loadTags();
});
</script>
