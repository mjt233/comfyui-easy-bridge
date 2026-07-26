<template>
  <v-app-bar color="primary">
    <v-app-bar-title>{{ workflow?.name ?? '加载中...' }}</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
  </v-app-bar>

  <v-container>
      <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>

      <v-card class="mb-4">
        <v-card-text>
          <div><strong>ID:</strong> {{ workflow?.id }}</div>
          <div><strong>名称:</strong> {{ workflow?.name }}</div>
          <div><strong>创建时间:</strong> {{ workflow?.createdAt }}</div>
        </v-card-text>
        <v-card-actions>
          <v-btn :to="`/admin/workflow/${workflow?.id}/edit`" variant="text" prepend-icon="mdi-pencil">编辑</v-btn>
        </v-card-actions>
      </v-card>

      <v-card>
        <v-card-title>参数别名配置</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-grey mb-4">
            下方列出了工作流 JSON 中所有节点的可配置输入字段。选择需要暴露给外部调用的字段，设置别名。
          </p>

          <v-table v-if="nodes.length > 0">
            <thead>
              <tr>
                <th>节点 ID</th>
                <th>节点标题</th>
                <th>字段名</th>
                <th>当前值</th>
                <th>别名</th>
                <th>标签</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(node, ni) in nodes" :key="ni">
                <td>{{ node.nodeId }}</td>
                <td>{{ node.title }}</td>
                <td>
                  <v-select
                    v-model="node.selectedField"
                    :items="node.fields"
                    density="compact"
                    variant="outlined"
                    hide-details
                    @update:model-value="onFieldChange(node)"
                  />
                </td>
                <td class="text-caption text-grey" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
                  {{ node.fieldValue }}
                </td>
                <td>
                  <v-text-field
                    v-if="node.selectedField"
                    v-model="node.editAlias"
                    density="compact"
                    variant="outlined"
                    placeholder="alias"
                    hide-details
                  />
                </td>
                <td>
                  <v-text-field
                    v-if="node.selectedField"
                    v-model="node.editLabel"
                    density="compact"
                    variant="outlined"
                    placeholder="标签(可选)"
                    hide-details
                  />
                </td>
                <td>
                  <v-btn
                    v-if="node.selectedField && node.editAlias"
                    size="small"
                    color="primary"
                    variant="text"
                    :loading="node.saving"
                    :disabled="!node.editAlias"
                    @click="saveParam(node)"
                  >
                    {{ node.paramId ? '更新' : '添加' }}
                  </v-btn>
                  <v-btn
                    v-if="node.paramId"
                    size="small"
                    color="error"
                    variant="text"
                    @click="removeParam(node)"
                  >删除</v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>

          <p v-else class="text-grey text-center py-4">无法解析工作流 JSON，请检查原始数据</p>
        </v-card-text>
      </v-card>

      <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
    </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { getWorkflow, addParam, updateParam, deleteParam } from '@/api/workflows';
import type { WorkflowDetail, WorkflowParam } from '@/types';

interface NodeField {
  nodeId: string;
  title: string;
  fields: string[];
  selectedField: string;
  fieldValue: string;
  editAlias: string;
  editLabel: string;
  paramId: number | null;
  saving: boolean;
}

const route = useRoute();
const workflow = ref<WorkflowDetail | null>(null);
const nodes = ref<NodeField[]>([]);
const error = ref('');
const snackbar = ref({ show: false, text: '', color: 'success' });

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
      const fields: string[] = [];
      let selectedField = '';
      let fieldValue = '';
      let editAlias = '';
      let editLabel = '';
      let paramId: number | null = null;

      for (const [fieldName, fieldVal] of Object.entries(inputs)) {
        if (Array.isArray(fieldVal)) continue;
        fields.push(fieldName);
        const existing = paramMap.get(`${nodeId}:${fieldName}`);
        if (existing) {
          selectedField = fieldName;
          fieldValue = String(fieldVal);
          editAlias = existing.alias;
          editLabel = existing.label ?? '';
          paramId = existing.id;
        }
      }

      if (fields.length > 0) {
        result.push({
          nodeId,
          title,
          fields,
          selectedField,
          fieldValue,
          editAlias,
          editLabel,
          paramId,
          saving: false,
        });
      }
    }
  } catch {
    // JSON parse failed
  }

  nodes.value = result;
}

function onFieldChange(node: NodeField) {
  if (!node.selectedField) {
    node.editAlias = '';
    node.editLabel = '';
    node.paramId = null;
    return;
  }
  const key = `${node.nodeId}:${node.selectedField}`;
  const existing = workflow.value?.params.find(p => `${p.nodeId}:${p.fieldName}` === key);
  node.editAlias = existing?.alias ?? '';
  node.editLabel = existing?.label ?? '';
  node.paramId = existing?.id ?? null;
}

async function saveParam(node: NodeField) {
  if (!workflow.value || !node.selectedField || !node.editAlias) return;
  node.saving = true;
  try {
    if (node.paramId) {
      await updateParam(workflow.value.id, node.paramId, { alias: node.editAlias, label: node.editLabel });
    } else {
      await addParam(workflow.value.id, {
        nodeId: node.nodeId,
        fieldName: node.selectedField,
        alias: node.editAlias,
        label: node.editLabel,
      });
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '保存失败，别名可能重复', color: 'error' };
  } finally {
    node.saving = false;
  }
}

async function removeParam(node: NodeField) {
  if (!workflow.value || !node.paramId) return;
  try {
    await deleteParam(workflow.value.id, node.paramId);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
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
