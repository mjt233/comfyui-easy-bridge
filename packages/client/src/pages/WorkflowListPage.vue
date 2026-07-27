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
    <v-btn v-if="authEnabled !== false" variant="text" prepend-icon="mdi-logout" @click="handleLogout">
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
            <v-textarea
              v-if="field.paramType === 'text'"
              v-model="executeForm[field.alias]"
              :label="field.label || field.alias"
              :hint="`节点: ${field.nodeTitle} · ${field.fieldName}`"
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

    <v-dialog v-model="apiDialog" max-width="720">
      <v-card>
        <v-card-title>
          API 调用说明：{{ apiTargetName }}
        </v-card-title>
        <v-card-text>
          <v-tabs v-model="apiTab" color="primary">
            <v-tab value="curl">curl</v-tab>
            <v-tab value="powershell">PowerShell</v-tab>
            <v-tab value="python">Python</v-tab>
            <v-tab value="nodejs">Node.js</v-tab>
            <v-tab value="java">Java</v-tab>
          </v-tabs>
          <v-window v-model="apiTab" class="mt-4">
            <v-window-item value="curl">
              <pre class="code-block">{{ apiCode.curl }}</pre>
            </v-window-item>
            <v-window-item value="powershell">
              <pre class="code-block">{{ apiCode.powershell }}</pre>
            </v-window-item>
            <v-window-item value="python">
              <pre class="code-block">{{ apiCode.python }}</pre>
            </v-window-item>
            <v-window-item value="nodejs">
              <pre class="code-block">{{ apiCode.nodejs }}</pre>
            </v-window-item>
            <v-window-item value="java">
              <pre class="code-block">{{ apiCode.java }}</pre>
            </v-window-item>
          </v-window>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="apiDialog = false">
            关闭
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
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { listWorkflows, deleteWorkflow, getWorkflow, executeWorkflow } from '@/api/workflows';
import type { Workflow } from '@/types';
import { authEnabled } from '@/api/auth-status';

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
const executeForm = reactive<Record<string, string>>({});
const executeFiles = reactive<Record<string, File>>({});

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
const apiTab = ref('curl');

const apiCode = computed(() => ({
  curl: `curl -X POST http://localhost:10721/api/workflows/${apiTargetId.value}/execute \\
  -H "Content-Type: application/json" \\
  -d '{"param1":"value1","param2":"value2"}'`,
  powershell: `$body = @{ param1 = "value1"; param2 = "value2" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${apiTargetId.value}/execute" `
    + `-Method Post -Body $body -ContentType "application/json"`,
  python: `import requests

url = "http://localhost:10721/api/workflows/${apiTargetId.value}/execute"
payload = {"param1": "value1", "param2": "value2"}
resp = requests.post(url, json=payload)
print(resp.json())`,
  nodejs: `const url = "http://localhost:10721/api/workflows/${apiTargetId.value}/execute";
const payload = { param1: "value1", param2: "value2" };

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const data = await res.json();
console.log(data);`,
  java: `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

String url = "http://localhost:10721/api/workflows/${apiTargetId.value}/execute";
String json = "{\\"param1\\":\\"value1\\",\\"param2\\":\\"value2\\"}";

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(json))
    .build();

HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(res.body());`,
}));

function handleApiDocs(id: string, name: string) {
  apiTargetId.value = id;
  apiTargetName.value = name;
  apiTab.value = 'curl';
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

async function handleExecute(id: string) {
  executeTarget.value = id;
  executeDialog.value = true;
  executeLoading.value = true;
  executeFields.value = [];
  // 清空旧表单数据
  Object.keys(executeForm).forEach(k => delete executeForm[k]);

  try {
    const detail = await getWorkflow(id);
    const workflow = JSON.parse(detail.rawJson);

    const fields: ExecuteField[] = [];
    for (const param of detail.params) {
      // 从原始 JSON 中提取默认值
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
      // 设置默认值（转为字符串）
      executeForm[param.alias] = String(currentValue ?? '');
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
    const aliasValues: Record<string, string> = {};
    for (const field of executeFields.value) {
      aliasValues[field.alias] = executeForm[field.alias];
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
.code-block {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 16px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
}
</style>
