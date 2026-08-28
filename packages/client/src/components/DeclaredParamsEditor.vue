<template>
  <div class="declared-params-editor">
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <v-chip
        v-if="props.workflow.buildScriptEnabled"
        size="small"
        color="primary"
        variant="tonal"
      >
        动态构建已启用
      </v-chip>
      <span v-if="dirty" class="text-caption text-warning">
        有未保存更改
      </span>
      <v-spacer />
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-plus"
        :disabled="saving"
        @click="addRow"
      >
        添加字段
      </v-btn>
      <v-btn
        size="small"
        variant="text"
        :disabled="!dirty || saving"
        @click="resetToSaved"
      >
        重置
      </v-btn>
      <v-btn
        size="small"
        color="primary"
        variant="flat"
        :disabled="!dirty || saving"
        :loading="saving"
        @click="save"
      >
        保存
      </v-btn>
    </div>

    <p class="text-body-2 text-grey mb-3">
      静态声明工作流运行时才会出现的动态字段（如构建脚本内部处理的媒体上传字段）。
      这些声明仅用于【执行工作流】对话框自动构建表单与【API 调用说明】示例生成（含 Multipart
      文件上传），不参与脚本参数注入。
    </p>

    <v-table>
      <thead>
        <tr>
          <th style="min-width: 140px">
            别名（必填）
          </th>
          <th style="min-width: 130px">
            标签
          </th>
          <th style="width: 110px">
            类型
          </th>
          <th style="min-width: 170px">
            候选项（仅 text）
          </th>
          <th style="width: 90px">
            多选
          </th>
          <th>默认值</th>
          <th style="width: 80px">
            操作
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td>
            <v-text-field
              v-model="row.alias"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="如 input_image"
            />
          </td>
          <td>
            <v-text-field
              v-model="row.label"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="展示标签（可选）"
            />
          </td>
          <td>
            <v-select
              v-model="row.paramType"
              :items="paramTypeItems"
              density="compact"
              variant="outlined"
              hide-details
            />
          </td>
          <td>
            <!-- 候选项表格：仅 text 类型生效；每项配置展示名(label)与提交值(value) -->
            <div v-if="row.paramType === 'text'">
              <div
                v-for="(c, ci) in row.candidates"
                :key="ci"
                class="d-flex align-center ga-1 mb-1"
              >
                <v-text-field
                  v-model="c.label"
                  placeholder="展示名"
                  density="compact"
                  variant="outlined"
                  hide-details
                  style="min-width: 90px"
                />
                <v-text-field
                  v-model="c.value"
                  placeholder="提交值"
                  density="compact"
                  variant="outlined"
                  hide-details
                  style="min-width: 90px"
                />
                <v-btn
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  :disabled="saving"
                  @click="row.candidates.splice(ci, 1)"
                />
              </div>
              <v-btn
                size="x-small"
                variant="text"
                prepend-icon="mdi-plus"
                :disabled="saving"
                @click="addCandidateRow(row)"
              >
                添加候选项
              </v-btn>
            </div>
            <span v-else class="text-caption text-grey">仅 text</span>
          </td>
          <td>
            <!-- 多选开关：仅有有效候选项且 text 类型时可开启；提交时各提交值以英文逗号拼接 -->
            <v-switch
              v-model="row.multiple"
              :disabled="row.paramType !== 'text' || effectiveCandidatesOf(row).length === 0"
              density="compact"
              color="primary"
              hide-details
              class="ml-2"
            />
          </td>
          <td>
            <!-- 布尔：开关；媒体：无默认值；其余：文本输入 -->
            <v-switch
              v-if="row.paramType === 'boolean'"
              v-model="row.booleanValue"
              label="默认开启"
              density="compact"
              hide-details
            />
            <v-text-field
              v-else
              v-model="row.defaultValue"
              :disabled="isMediaType(row.paramType)"
              density="compact"
              variant="outlined"
              hide-details
              :placeholder="isMediaType(row.paramType) ? '媒体字段无默认值' : ''"
            />
          </td>
          <td>
            <v-btn
              icon="mdi-close"
              size="small"
              variant="text"
              :disabled="saving"
              @click="rows.splice(i, 1)"
            />
          </td>
        </tr>
        <tr v-if="rows.length === 0">
          <td colspan="7" class="text-center text-grey py-4">
            暂无动态字段声明，点击右上角「添加字段」开始配置
          </td>
        </tr>
      </tbody>
    </v-table>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { WorkflowDetail, DeclaredParam, CandidateOption } from '@/types';
import { saveDeclaredParams } from '@/api/workflows';

/** 组件 props：完整工作流详情（含 declaredParams） */
const props = defineProps<{
  workflow: WorkflowDetail;
}>();

/** 组件事件：保存成功后上抛最新工作流详情 */
const emit = defineEmits<{
  saved: [workflow: WorkflowDetail];
}>();

/** 提示条状态 */
const snackbar = ref({ show: false, text: '', color: 'success' });

/**
 * 可编辑声明行
 */
interface DeclaredRow {
  /** 对外参数别名 */
  alias: string;
  /** 展示标签 */
  label: string;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 文本/数字默认值（空串表示未配置） */
  defaultValue: string;
  /** 布尔默认值（仅 boolean 类型生效） */
  booleanValue: boolean;
  /** 候选项编辑行（label 展示名 / value 提交值；仅 text 类型生效） */
  candidates: Array<{ label: string; value: string }>;
  /** 是否多选（仅 text 且有候选项时生效） */
  multiple: boolean;
}

/**
 * 规范化某行的有效候选项：过滤空 value 行，label 留空回退为 value，并按 value 去重
 * @param row 声明编辑行
 * @returns 规范化后的候选项数组
 */
function effectiveCandidatesOf(row: DeclaredRow): CandidateOption[] {
  const out: CandidateOption[] = [];
  for (const c of row.candidates) {
    const value = c.value.trim();
    if (value === '' || out.some((x) => x.value === value)) continue;
    const label = c.label.trim() === '' ? value : c.label.trim();
    out.push({ label, value });
  }
  return out;
}

/**
 * 为某行添加一行空候选项
 * @param row 声明编辑行
 */
function addCandidateRow(row: DeclaredRow): void {
  row.candidates.push({ label: '', value: '' });
}

/** 可选参数类型列表 */
const paramTypeItems = ['text', 'number', 'boolean', 'image', 'video', 'audio'];

/** 当前编辑行（从 props 初始化） */
const rows = ref<DeclaredRow[]>([]);
/** 已保存的声明（用于脏检查与重置） */
const savedRows = ref<DeclaredRow[]>([]);
/** 是否有未保存更改 */
const dirty = computed(() => JSON.stringify(rows.value) !== JSON.stringify(savedRows.value));
/** 保存中 */
const saving = ref(false);

/**
 * 将声明列表转换为可编辑行
 * @param list 声明列表
 */
function toRows(list: DeclaredParam[]): DeclaredRow[] {
  return list.map((p) => ({
    alias: p.alias,
    label: p.label ?? '',
    paramType: p.paramType || 'text',
    defaultValue: p.defaultValue ?? '',
    booleanValue: parseBooleanDefault(p.defaultValue),
    // 候选项深拷贝为可编辑行（仅 text 保留）；多选仅在 text 且有候选时有效
    candidates: (p.paramType === 'text' ? (p.candidates ?? []) : [])
      .map((c) => ({ label: c.label, value: c.value })),
    multiple: p.multiple === true,
  }));
}

/**
 * 将布尔默认值字符串解析为布尔值
 * @param raw 原始默认值
 */
function parseBooleanDefault(raw: string | null): boolean {
  const s = String(raw ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(s);
}

/**
 * 是否为媒体类型（无默认值）
 * @param paramType 参数类型
 */
function isMediaType(paramType: string): boolean {
  return ['image', 'video', 'audio'].includes(paramType);
}

/**
 * 添加一行空声明
 */
function addRow(): void {
  rows.value.push({
    alias: '', label: '', paramType: 'text', defaultValue: '', booleanValue: false,
    candidates: [], multiple: false,
  });
}

/**
 * 重置为已保存内容
 */
function resetToSaved(): void {
  // 候选项数组需深拷贝，避免重置后编辑串改已保存快照
  rows.value = savedRows.value.map((r) => ({
    ...r,
    candidates: r.candidates.map((c) => ({ ...c })),
  }));
}

/**
 * 保存声明：客户端校验后调用接口并上抛最新详情
 */
async function save(): Promise<void> {
  // 客户端校验：alias 必填且不重复
  const seen = new Set<string>();
  for (const row of rows.value) {
    const alias = row.alias.trim();
    if (alias === '') {
      snackbar.value = { show: true, text: '别名不能为空', color: 'error' };
      return;
    }
    if (seen.has(alias)) {
      snackbar.value = { show: true, text: `别名重复：${alias}`, color: 'error' };
      return;
    }
    seen.add(alias);
  }
  saving.value = true;
  try {
    // 序列化为声明列表：布尔存 'true'/'false'，媒体无默认值，其余空串视为未配置；
    // 候选项仅 text 类型保留，无候选时强制单选
    const list: DeclaredParam[] = rows.value.map((row) => {
      const alias = row.alias.trim();
      const label = row.label.trim() === '' ? null : row.label.trim();
      let defaultValue: string | null;
      if (row.paramType === 'boolean') {
        defaultValue = String(row.booleanValue);
      } else if (isMediaType(row.paramType)) {
        defaultValue = null;
      } else {
        defaultValue = row.defaultValue.trim() === '' ? null : row.defaultValue;
      }
      const candidates = row.paramType === 'text' ? effectiveCandidatesOf(row) : [];
      return {
        alias,
        label,
        paramType: row.paramType || 'text',
        defaultValue,
        candidates,
        multiple: candidates.length > 0 && row.multiple,
      };
    });
    const updated = await saveDeclaredParams(props.workflow.id, list);
    // 保存成功后以规范化结果刷新本地编辑态
    savedRows.value = toRows(list);
    rows.value = toRows(list);
    emit('saved', updated);
  } catch {
    snackbar.value = { show: true, text: '保存失败，请检查输入', color: 'error' };
  } finally {
    saving.value = false;
  }
}

// 初始化与外部刷新同步
watch(
  () => props.workflow.declaredParams,
  (val) => {
    rows.value = toRows(val ?? []);
    savedRows.value = toRows(val ?? []);
  },
  { immediate: true },
);
</script>
