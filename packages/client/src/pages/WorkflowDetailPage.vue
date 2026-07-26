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
                      <span v-if="info.paramId && info.label">{{ info.alias }}</span>
                      <span v-else>{{ info.name }}</span>
                      <template v-if="info.paramId" #append>
                        <span class="text-caption ml-1" :class="info.label ? 'opacity-60' : 'opacity-80'">{{ info.label || info.alias }}</span>
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
                    v-if="item.paramId"
                    size="small"
                    color="primary"
                    variant="flat"
                  >
                    {{ item.alias }}
                    <template v-if="item.paramId" #append>
                      <span class="text-caption ml-1" :class="item.label ? 'opacity-60' : 'opacity-80'">
                        {{ item.label || item.alias }}
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
            :model-value="dialog.fieldValue"
            label="默认值"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-3"
            readonly
            max-rows="3"
            :rows="1"
            auto-grow
          />
          <v-text-field
            v-model="dialog.alias"
            label="接口字段别名"
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
            :disabled="!dialog.fieldName || !dialog.alias || dialog.saving"
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
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { getWorkflow, addParam, updateParam, deleteParam } from '@/api/workflows';
import type { WorkflowDetail, WorkflowParam } from '@/types';

interface FieldInfo {
  name: string;
  value: string;
  alias: string;
  label: string;
  paramId: number | null;
}

interface NodeField {
  nodeId: string;
  title: string;
  fields: FieldInfo[];
}

const route = useRoute();
const workflow = ref<WorkflowDetail | null>(null);
const nodes = ref<NodeField[]>([]);
const error = ref('');
const snackbar = ref({ show: false, text: '', color: 'success' });

const viewMode = ref<'chip' | 'list'>('chip');

const flatFields = computed(() => {
  return nodes.value.flatMap(n => n.fields.map(f => ({ ...f, nodeId: n.nodeId, title: n.title })));
});

function getNode(nodeId: string): NodeField | undefined {
  return nodes.value.find(n => n.nodeId === nodeId);
}

const dialog = ref({
  show: false,
  node: null as NodeField | null,
  fieldName: '',
  fieldValue: '',
  alias: '',
  label: '',
  paramId: null as number | null,
  saving: false,
});

function parseNodes(wf: WorkflowDetail) {
  const result: NodeField[] = [];
  const paramMap = new Map<string, WorkflowParam>();
  for (const p of wf.params) {
    paramMap.set(`${p.nodeId}:${p.fieldName}`, p);
  }

  try {
    const json = JSON.parse(wf.rawJson);
    for (const [nodeId, node] of Object.entries(json)) {
      const n = node as Record<string, unknown>;
      const inputs = n.inputs as Record<string, unknown> ?? {};
      const title = ((n._meta as Record<string, unknown>)?.title as string) ?? nodeId;
      const fields: FieldInfo[] = [];

      for (const [fieldName, fieldVal] of Object.entries(inputs)) {
        if (Array.isArray(fieldVal)) continue;
        const existing = paramMap.get(`${nodeId}:${fieldName}`);
        fields.push({
          name: fieldName,
          value: String(fieldVal),
          alias: existing?.alias ?? '',
          label: existing?.label ?? '',
          paramId: existing?.id ?? null,
        });
      }

      if (fields.length > 0) {
        result.push({ nodeId, title, fields });
      }
    }
  } catch {
    // JSON parse failed
  }

  nodes.value = result;
}

function getNodeByField(node: NodeField, fieldName: string): FieldInfo | undefined {
  return node.fields.find(f => f.name === fieldName);
}

function openDialog(node: NodeField, info: FieldInfo) {
  dialog.value = {
    show: true,
    node,
    fieldName: info.name,
    fieldValue: info.value,
    alias: info.alias,
    label: info.label,
    paramId: info.paramId,
    saving: false,
  };
}

async function saveDialog() {
  if (!workflow.value || !dialog.value.node || !dialog.value.fieldName || !dialog.value.alias) return;
  dialog.value.saving = true;
  try {
    const node = dialog.value.node;
    const info = getNodeByField(node, dialog.value.fieldName);
    if (info?.paramId) {
      await updateParam(workflow.value.id, info.paramId, { alias: dialog.value.alias, label: dialog.value.label });
    } else {
      await addParam(workflow.value.id, {
        nodeId: node.nodeId,
        fieldName: dialog.value.fieldName,
        alias: dialog.value.alias,
        label: dialog.value.label,
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
