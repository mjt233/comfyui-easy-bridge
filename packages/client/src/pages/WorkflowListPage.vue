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

    <v-dialog v-model="apiDialog" max-width="800">
      <v-card>
        <v-card-title class="d-flex align-center">
          <span>API 调用说明：{{ apiTargetName }}</span>
          <v-spacer />
          <v-chip v-if="apiHasMedia" size="small" color="warning" variant="tonal" class="mr-2">
            含文件参数
          </v-chip>
        </v-card-title>
        <v-card-text>
          <v-btn-toggle
            v-if="apiHasMedia"
            v-model="apiFormat"
            color="primary"
            density="compact"
            class="mb-3"
            mandatory
          >
            <v-btn value="json" size="small">JSON</v-btn>
            <v-btn value="multipart" size="small">Multipart 文件上传</v-btn>
          </v-btn-toggle>
          <v-tabs v-model="apiTab" color="primary">
            <v-tab value="curl">curl</v-tab>
            <v-tab value="powershell">PowerShell</v-tab>
            <v-tab value="python">Python</v-tab>
            <v-tab value="nodejs">Node.js</v-tab>
            <v-tab value="java">Java</v-tab>
          </v-tabs>
          <div class="api-code-block mt-4">
            <div class="code-header d-flex align-center">
              <v-spacer />
              <v-tooltip text="复制代码" location="top">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon
                    variant="text"
                    density="compact"
                    size="small"
                    :color="apiCopying ? 'success' : undefined"
                    @click="copyApiCode"
                  >
                    <v-icon>{{ apiCopying ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
                  </v-btn>
                </template>
              </v-tooltip>
            </div>
            <pre><code v-html="highlightedApiCode()"></code></pre>
          </div>
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
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { listWorkflows, deleteWorkflow, getWorkflow, executeWorkflow } from '@/api/workflows';
import type { Workflow, WorkflowParam } from '@/types';
import { authEnabled } from '@/api/auth-status';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import 'highlight.js/styles/atom-one-dark.css';

hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);

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
const apiFormat = ref('json');
const apiParams = ref<WorkflowParam[]>([]);
const apiHasMedia = computed(() => apiParams.value.some(p => p.paramType !== 'text'));
const apiCodeRef = ref<Record<string, string>>({});
const apiCopying = ref(false);

function q(s: string): string {
  return JSON.stringify(s);
}

function escDouble(s: string): string {
  return s.replace(/"/g, '\\"');
}

function genJsonSnippet(id: string, params: WorkflowParam[]) {
  const pairs = params.map(p => `    ${q(p.alias)}: "value"`).join(',\n');
  const jsonBody = `{\n${pairs}\n}`;
  return { jsonBody };
}

function genMultipartSnippet(id: string, params: WorkflowParam[]) {
  const textParams = params.filter(p => p.paramType === 'text');
  const mediaParams = params.filter(p => p.paramType !== 'text');
  return { textParams, mediaParams };
}

function buildApiCode(id: string, params: WorkflowParam[]) {
  const { jsonBody } = genJsonSnippet(id, params);
  const { textParams, mediaParams } = genMultipartSnippet(id, params);

  const textPairs = textParams.map(p => `${q(p.alias)}: "value"`).join(', ');
  const textJsonObj = `{ ${textPairs} }`;

  return {
    curl: {
      json: `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -H "Content-Type: application/json" \\
  -d '${jsonBody}'`,
      multipart: mediaParams.length > 0
        ? `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -F "params=${textJsonObj}" \\
${mediaParams.map(p => `  -F "${p.alias}=@/path/to/${p.alias}.png"`).join(' \\\n')}`
        : '',
    },
    powershell: {
      json: `$body = @{
${params.map(p => `  ${p.alias} = "value"`).join('\n')}
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + `-Method Post -Body $body -ContentType "application/json"`,
      multipart: mediaParams.length > 0
        ? `$params = @{
${textParams.map(p => `  ${p.alias} = "value"`).join('\n')}
} | ConvertTo-Json

$form = @{
  params = $params
${mediaParams.map(p => `  ${p.alias} = Get-Item -Path "C:\\path\\to\\${p.alias}.png"`).join('\n')}
}

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + `-Method Post -Form $form`
        : '',
    },
    python: {
      json: `import requests

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = {
${params.map(p => `    ${q(p.alias)}: "value",`).join('\n')}
}
resp = requests.post(url, json=payload)
print(resp.json())`,
      multipart: mediaParams.length > 0
        ? `import requests
import json

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = ${textJsonObj}
files = {
${mediaParams.map(p => `    ${q(p.alias)}: open("/path/to/${p.alias}.png", "rb"),`).join('\n')}
}
resp = requests.post(url, data={"params": json.dumps(payload)}, files=files)
print(resp.json())`
        : '',
    },
    nodejs: {
      json: `const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = {
${params.map(p => `  ${q(p.alias)}: "value",`).join('\n')}
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const data = await res.json();
console.log(data);`,
      multipart: mediaParams.length > 0
        ? `const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = ${textJsonObj};
const formData = new FormData();
formData.append("params", JSON.stringify(payload));
${mediaParams.map(p => `formData.append(${q(p.alias)}, fs.createReadStream("/path/to/${p.alias}.png"));`).join('\n')}

const res = await fetch(url, {
  method: "POST",
  body: formData,
});
const data = await res.json();
console.log(data);`
        : '',
    },
    java: {
      json: `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

String url = "http://localhost:10721/api/workflows/${id}/execute";
String json = "${escDouble(jsonBody.replace(/\n    /g, '\\n    ').replace(/\n/g, '\\n'))}";

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(json))
    .build();

HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(res.body());`,
      multipart: mediaParams.length > 0
        ? `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

String boundary = "----Boundary";
String url = "http://localhost:10721/api/workflows/${id}/execute";
String body = "--" + boundary + "\\r\\n"
    + "Content-Disposition: form-data; name=\\"params\\"\\r\\n\\r\\n"
    + "${escDouble(textJsonObj)}\\r\\n"
${mediaParams.map(p => `    + "--" + boundary + "\\r\\n"
    + "Content-Disposition: form-data; name=\\"${p.alias}\\"; filename=\\"${p.alias}.png\\"\\r\\n"
    + "Content-Type: application/octet-stream\\r\\n\\r\\n"
    + "<file-bytes>" + "\\r\\n"`).join('\n')}
    + "--" + boundary + "--";

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(res.body());`
        : '',
    },
  };
}

async function handleApiDocs(id: string, name: string) {
  apiTargetId.value = id;
  apiTargetName.value = name;
  apiTab.value = 'curl';
  apiFormat.value = 'json';
  apiDialog.value = true;
  try {
    const detail = await getWorkflow(id);
    apiParams.value = detail.params;
    apiCodeRef.value = buildApiCode(id, detail.params);
  } catch {
    apiParams.value = [];
    apiCodeRef.value = buildApiCode(id, []);
  }
  await nextTick();
  document.querySelectorAll('.api-code-block pre code').forEach(el => {
    hljs.highlightElement(el as HTMLElement);
  });
}

function highlightedApiCode(): string {
  const lang = apiTab.value;
  const fmt = apiFormat.value;
  const code = (apiCodeRef.value as Record<string, Record<string, string>>)?.[lang]?.[fmt];
  if (!code) return '';
  const langMap: Record<string, string> = {
    curl: 'bash',
    powershell: 'powershell',
    python: 'python',
    nodejs: 'json',
    java: 'java',
  };
  const result = hljs.highlight(code, { language: langMap[lang] || 'plaintext' }).value;
  return result;
}

async function copyApiCode() {
  const lang = apiTab.value;
  const fmt = apiFormat.value;
  const code = (apiCodeRef.value as Record<string, Record<string, string>>)?.[lang]?.[fmt];
  if (!code) return;
  apiCopying.value = true;
  try {
    await navigator.clipboard.writeText(code);
    setTimeout(() => { apiCopying.value = false; }, 1500);
  } catch {
    apiCopying.value = false;
  }
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
.api-code-block {
  background: #1e1e1e;
  border-radius: 4px;
  overflow: hidden;
}
.code-header {
  background: #2d2d2d;
  padding: 4px 8px;
  border-bottom: 1px solid #3c3c3c;
}
.api-code-block pre {
  margin: 0;
  padding: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 400px;
}
.api-code-block code {
  background: transparent !important;
  color: #d4d4d4;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}
</style>
