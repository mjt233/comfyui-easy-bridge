<template>
  <v-app-bar color="primary">
    <v-app-bar-title>{{ workflow?.name ?? '加载中...' }}</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">
      返回
    </v-btn>
  </v-app-bar>

  <v-container>
    <v-alert
      v-if="error"
      type="error"
      closable
      class="mb-4"
    >
      {{ error }}
    </v-alert>

    <v-card class="mb-4">
      <v-card-text>
        <div><strong>ID:</strong> {{ workflow?.id }}</div>
        <div><strong>名称:</strong> {{ workflow?.name }}</div>
        <div><strong>创建时间:</strong> {{ workflow?.createdAt }}</div>
      </v-card-text>
      <v-card-actions>
        <v-btn :to="`/admin/workflow/${workflow?.id}/edit`" variant="text" prepend-icon="mdi-pencil">
          编辑
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- rawJson 变更后仍残留在 DB 中的参数配置，优先展示在参数配置前 -->
    <v-card v-if="orphanedParams.length > 0" class="mb-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <span>失效配置</span>
        <v-chip size="small" color="warning" variant="tonal">
          {{ orphanedParams.length }}
        </v-chip>
        <v-spacer />
        <v-btn
          color="error"
          variant="tonal"
          size="small"
          :loading="clearingOrphans"
          @click="clearAllOrphans"
        >
          全部删除
        </v-btn>
      </v-card-title>
      <v-card-text>
        <p class="text-body-2 text-grey mb-4">
          以下参数对应的节点或字段已不在当前工作流 JSON 中，无法再编辑，但仍占用别名。请删除后重新配置。
        </p>
        <v-table>
          <thead>
            <tr>
              <th>节点 ID</th>
              <th>字段名</th>
              <th>别名</th>
              <th>类型</th>
              <th>默认值覆盖</th>
              <th style="width: 100px">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in orphanedParams" :key="p.id">
              <td>{{ p.nodeId }}</td>
              <td>{{ p.fieldName }}</td>
              <td>
                <v-chip
                  v-if="p.alias"
                  size="small"
                  color="warning"
                  variant="flat"
                >
                  {{ p.alias }}
                </v-chip>
                <span v-else class="text-caption text-grey">仅默认值</span>
              </td>
              <td>
                <span class="text-caption">{{ p.paramType }}</span>
              </td>
              <td class="text-caption text-grey" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                {{ p.defaultValue ?? '-' }}
              </td>
              <td>
                <v-btn
                  icon="mdi-delete"
                  size="small"
                  variant="text"
                  color="error"
                  :loading="deletingOrphanId === p.id"
                  @click="deleteOrphan(p.id)"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-title>
        参数别名配置
        <v-btn-toggle
          v-model="viewMode"
          variant="outlined"
          density="compact"
          color="primary"
          class="ml-4"
          mandatory
        >
          <v-btn value="chip" size="small">
            字段
          </v-btn>
          <v-btn value="list" size="small">
            列表
          </v-btn>
        </v-btn-toggle>
      </v-card-title>
      <v-card-text>
        <p v-if="viewMode === 'chip'" class="text-body-2 text-grey mb-4">
          下方列出了工作流 JSON 中所有节点的可配置输入字段。点击字段名标签配置别名和标签。
        </p>
        <p v-else class="text-body-2 text-grey mb-4">
          下方按字段平铺列出所有可配置输入。点击行可配置别名和标签。
        </p>

        <template v-if="nodes.length > 0">
          <v-table v-show="viewMode === 'chip'">
            <thead>
              <tr>
                <th style="min-width: 100px">
                  节点 ID
                </th>
                <th style="min-width: 140px">
                  节点标题
                </th>
                <th>字段名</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(node, ni) in nodes" :key="ni">
                <td style="min-width: 100px">
                  {{ node.nodeId }}
                </td>
                <td style="min-width: 140px">
                  {{ node.title }}
                </td>
                <td>
                  <div class="d-flex flex-wrap ga-2 align-center">
                    <v-chip
                      v-for="(info, fi) in node.fields"
                      :key="fi"
                      :color="info.paramId ? 'primary' : undefined"
                      :variant="info.paramId ? 'flat' : 'outlined'"
                      size="small"
                      @click="openDialog(node, info)"
                    >
                      <span v-if="info.paramId && info.label">{{ info.alias || info.name }}</span>
                      <span v-else-if="info.paramId && !info.alias">{{ info.name }}</span>
                      <span v-else>{{ info.name }}</span>
                      <template #append>
                        <span v-if="info.paramType !== 'text'" class="text-caption ml-1 opacity-70">{{ info.paramType }}</span>
                        <span v-if="info.paramId" class="text-caption ml-1" :class="info.label ? 'opacity-60' : 'opacity-80'">{{ info.label || info.alias || '仅默认值' }}</span>
                      </template>
                    </v-chip>
                  </div>
                </td>
              </tr>
            </tbody>
          </v-table>

          <v-table v-show="viewMode === 'list'">
            <thead>
              <tr>
                <th style="min-width: 100px">
                  节点 ID
                </th>
                <th style="min-width: 140px">
                  节点标题
                </th>
                <th style="min-width: 120px">
                  字段名
                </th>
                <th>默认值</th>
                <th>类型</th>
                <th style="min-width: 120px">
                  别名
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, i) in flatFields"
                :key="i"
                style="cursor: pointer"
                @click="openDialog(getNode(item.nodeId)!, item)"
              >
                <td>{{ item.nodeId }}</td>
                <td>{{ item.title }}</td>
                <td>{{ item.name }}</td>
                <td class="text-caption text-grey" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  {{ item.value }}
                </td>
                <td>
                  <v-chip
                    v-if="item.paramType !== 'text'"
                    size="x-small"
                    color="primary"
                    variant="tonal"
                  >
                    {{ item.paramType }}
                  </v-chip>
                  <span v-else class="text-caption text-grey">text</span>
                </td>
                <td>
                  <v-chip
                    v-if="item.paramId"
                    size="small"
                    color="primary"
                    variant="flat"
                  >
                    {{ item.alias || '仅默认值' }}
                    <template v-if="item.paramId" #append>
                      <span class="text-caption ml-1" :class="item.label ? 'opacity-60' : 'opacity-80'">
                        {{ item.label || item.alias || '仅默认值' }}
                      </span>
                    </template>
                  </v-chip>
                </td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <p v-else class="text-grey text-center py-4">
          无法解析工作流 JSON，请检查原始数据
        </p>
      </v-card-text>
    </v-card>

    <v-dialog v-model="dialog.show" max-width="500">
      <v-card>
        <v-card-title>编辑参数</v-card-title>
        <v-card-text>
          <v-text-field
            :model-value="dialog.fieldName"
            label="字段名"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-3"
            readonly
          />
          <v-textarea
            v-model="dialog.fieldValue"
            label="默认值"
            density="compact"
            variant="outlined"
            class="mb-3"
            max-rows="3"
            :rows="1"
            auto-grow
            hint="与原始值相同则清除覆盖"
            persistent-hint
          />
          <v-text-field
            v-model="dialog.alias"
            label="接口字段别名（可选）"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-3"
          />
          <v-text-field
            v-model="dialog.label"
            label="标签(可选)"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-3"
          />
          <v-select
            v-model="dialog.paramType"
            label="参数类型"
            :items="paramTypeItems"
            density="compact"
            variant="outlined"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-btn color="error" variant="text" @click="deleteFromDialog">
            删除
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="dialog.show = false">
            取消
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!dialog.fieldName || dialog.saving || !canSaveDialog"
            :loading="dialog.saving"
            @click="saveDialog"
          >
            保存
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getWorkflow, addParam, updateParam, deleteParam } from '@/api/workflows';
import type { WorkflowDetail, WorkflowParam } from '@/types';

/**
 * 节点字段展示信息
 */
interface FieldInfo {
  /** 字段名 */
  name: string;
  /** rawJson 中的原始默认值（字符串化） */
  rawValue: string;
  /** 当前生效展示值（覆盖优先） */
  value: string;
  /** 别名 */
  alias: string;
  /** 标签 */
  label: string;
  /** 已保存参数 ID */
  paramId: number | null;
  /** 参数类型 */
  paramType: string;
  /** 已保存的默认值覆盖 */
  defaultValue: string | null;
}

/**
 * 节点及其可配置字段
 */
interface NodeField {
  /** 节点 ID */
  nodeId: string;
  /** 节点标题 */
  title: string;
  /** 字段列表 */
  fields: FieldInfo[];
}

const route = useRoute();
const workflow = ref<WorkflowDetail | null>(null);
const nodes = ref<NodeField[]>([]);
/**
 * 当前 rawJson 中已不存在对应节点/字段的参数配置
 */
const orphanedParams = ref<WorkflowParam[]>([]);
const error = ref('');
const snackbar = ref({ show: false, text: '', color: 'success' });
/** 正在删除的失效参数 ID */
const deletingOrphanId = ref<number | null>(null);
/** 是否正在批量清理失效参数 */
const clearingOrphans = ref(false);

const viewMode = ref<'chip' | 'list'>('chip');

/**
 * 将节点字段平铺为列表视图数据
 */
const flatFields = computed(() => {
  return nodes.value.flatMap(n => n.fields.map(f => ({ ...f, nodeId: n.nodeId, title: n.title })));
});

/**
 * 是否允许保存当前对话框
 */
const canSaveDialog = computed(() => {
  const alias = dialog.value.alias.trim();
  // 与原始值相同则视为清除覆盖
  const defaultValue = dialog.value.fieldValue === dialog.value.rawValue
    ? null
    : dialog.value.fieldValue;
  // 新建：至少 alias 或有效覆盖
  if (!dialog.value.paramId) {
    return alias !== '' || defaultValue != null;
  }
  // 已有配置：允许保存（若两者皆空则走删除提示）
  return true;
});

/**
 * 按节点 ID 查找节点
 * @param nodeId 节点 ID
 */
function getNode(nodeId: string): NodeField | undefined {
  return nodes.value.find(n => n.nodeId === nodeId);
}

const dialog = ref({
  show: false,
  node: null as NodeField | null,
  fieldName: '',
  /** 可编辑的默认值输入 */
  fieldValue: '',
  /** rawJson 原始值，用于比较是否清除覆盖 */
  rawValue: '',
  alias: '',
  label: '',
  paramId: null as number | null,
  paramType: 'text',
  saving: false,
});

/** 媒体类型（无别名时不可选） */
const MEDIA_PARAM_TYPES = ['image', 'video', 'audio'] as const;

/**
 * 参数类型下拉选项：无别名时仅 text/boolean/number
 */
const paramTypeItems = computed(() => {
  if (dialog.value.alias.trim()) {
    return ['text', 'boolean', 'number', 'image', 'video', 'audio'];
  }
  return ['text', 'boolean', 'number'];
});

// 无别名时若当前为媒体类型，回退为 text
watch(
  () => dialog.value.alias,
  (alias) => {
    if (!alias.trim() && (MEDIA_PARAM_TYPES as readonly string[]).includes(dialog.value.paramType)) {
      dialog.value.paramType = 'text';
    }
  },
);

/**
 * 解析工作流 JSON 与已保存参数，生成节点字段列表，并收集失效配置
 * @param wf 工作流详情
 */
function parseNodes(wf: WorkflowDetail) {
  const result: NodeField[] = [];
  const paramMap = new Map<string, WorkflowParam>();
  for (const p of wf.params) {
    paramMap.set(`${p.nodeId}:${p.fieldName}`, p);
  }

  /** 当前 JSON 中仍存在的可配置字段键 */
  const liveFieldKeys = new Set<string>();

  try {
    const json = JSON.parse(wf.rawJson);
    for (const [nodeId, node] of Object.entries(json)) {
      const n = node as Record<string, unknown>;
      const inputs = n.inputs as Record<string, unknown> ?? {};
      const title = ((n._meta as Record<string, unknown>)?.title as string) ?? nodeId;
      const fields: FieldInfo[] = [];

      for (const [fieldName, fieldVal] of Object.entries(inputs)) {
        // 跳过数组连接字段
        if (Array.isArray(fieldVal)) continue;
        const key = `${nodeId}:${fieldName}`;
        liveFieldKeys.add(key);
        const rawValue = String(fieldVal);
        const existing = paramMap.get(key);
        const override = existing?.defaultValue ?? null;
        fields.push({
          name: fieldName,
          rawValue,
          value: override != null ? override : rawValue,
          alias: existing?.alias ?? '',
          label: existing?.label ?? '',
          paramId: existing?.id ?? null,
          paramType: existing?.paramType ?? 'text',
          defaultValue: override,
        });
      }

      if (fields.length > 0) {
        result.push({ nodeId, title, fields });
      }
    }
  } catch {
    // JSON parse failed
  }

  // 已保存但 JSON 中已无对应字段的参数 → 失效配置
  orphanedParams.value = wf.params.filter(
    (p) => !liveFieldKeys.has(`${p.nodeId}:${p.fieldName}`),
  );

  nodes.value = result;
}

/**
 * 删除单条失效参数配置
 * @param paramId 参数行 ID
 */
async function deleteOrphan(paramId: number) {
  if (!workflow.value) return;
  deletingOrphanId.value = paramId;
  try {
    await deleteParam(workflow.value.id, paramId);
    snackbar.value = { show: true, text: '已删除失效配置', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  } finally {
    deletingOrphanId.value = null;
  }
}

/**
 * 批量删除全部失效参数配置
 */
async function clearAllOrphans() {
  if (!workflow.value || orphanedParams.value.length === 0) return;
  clearingOrphans.value = true;
  try {
    const id = workflow.value.id;
    // 逐条删除；任一条失败则中断并提示
    for (const p of orphanedParams.value) {
      await deleteParam(id, p.id);
    }
    snackbar.value = { show: true, text: '已清理全部失效配置', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '清理失败，请重试', color: 'error' };
    await load();
  } finally {
    clearingOrphans.value = false;
  }
}

/**
 * 在节点中按字段名查找字段信息
 * @param node 节点
 * @param fieldName 字段名
 */
function getNodeByField(node: NodeField, fieldName: string): FieldInfo | undefined {
  return node.fields.find(f => f.name === fieldName);
}

/**
 * 打开参数编辑对话框
 * @param node 节点
 * @param info 字段信息
 */
function openDialog(node: NodeField, info: FieldInfo) {
  dialog.value = {
    show: true,
    node,
    fieldName: info.name,
    fieldValue: info.value,
    rawValue: info.rawValue,
    alias: info.alias,
    label: info.label,
    paramId: info.paramId,
    paramType: info.paramType || 'text',
    saving: false,
  };
}

/**
 * 保存对话框中的参数配置
 */
async function saveDialog() {
  if (!workflow.value || !dialog.value.node || !dialog.value.fieldName) return;

  // 空别名存 null；与原始值相同则清除覆盖
  const alias = dialog.value.alias.trim() || null;
  const defaultValue = dialog.value.fieldValue === dialog.value.rawValue
    ? null
    : dialog.value.fieldValue;
  // 无别名时禁止媒体类型，允许 text/boolean/number
  let paramType = dialog.value.paramType || 'text';
  if (!alias && (MEDIA_PARAM_TYPES as readonly string[]).includes(paramType)) {
    paramType = 'text';
  }

  // 无有效配置：已有行则删除，新建则忽略
  if (alias == null && defaultValue == null) {
    if (dialog.value.paramId) {
      await deleteFromDialog();
      return;
    }
    snackbar.value = { show: true, text: '请填写别名或修改默认值', color: 'error' };
    return;
  }

  dialog.value.saving = true;
  try {
    const node = dialog.value.node;
    const info = getNodeByField(node, dialog.value.fieldName);
    if (info?.paramId) {
      await updateParam(workflow.value.id, info.paramId, {
        alias,
        label: dialog.value.label,
        paramType,
        defaultValue,
      });
    } else {
      await addParam(workflow.value.id, {
        nodeId: node.nodeId,
        fieldName: dialog.value.fieldName,
        alias,
        label: dialog.value.label,
        paramType,
        defaultValue,
      });
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    dialog.value.show = false;
    await load();
  } catch {
    snackbar.value = { show: true, text: '保存失败，别名可能重复', color: 'error' };
  } finally {
    dialog.value.saving = false;
  }
}

async function deleteFromDialog() {
  if (!workflow.value || !dialog.value.paramId) return;
  try {
    await deleteParam(workflow.value.id, dialog.value.paramId);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
    dialog.value.show = false;
    await load();
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  }
}

async function load() {
  try {
    const wf = await getWorkflow(route.params.id as string);
    workflow.value = wf;
    parseNodes(wf);
  } catch {
    error.value = '工作流不存在';
  }
}

onMounted(load);
</script>
