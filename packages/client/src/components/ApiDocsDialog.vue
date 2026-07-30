<template>
  <v-dialog :model-value="modelValue" max-width="800" @update:model-value="$emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center">
        <span>API 调用说明：{{ workflowName }}</span>
        <v-spacer />
        <v-chip
          v-if="apiHasMedia"
          size="small"
          color="warning"
          variant="tonal"
          class="mr-2"
        >
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
          <v-btn value="json" size="small">
            JSON
          </v-btn>
          <v-btn value="multipart" size="small">
            Multipart 文件上传
          </v-btn>
        </v-btn-toggle>
        <v-tabs v-model="apiTab" color="primary">
          <v-tab value="curl">
            curl
          </v-tab>
          <v-tab value="powershell">
            PowerShell
          </v-tab>
          <v-tab value="python">
            Python
          </v-tab>
          <v-tab value="nodejs">
            Node.js
          </v-tab>
          <v-tab value="java">
            Java
          </v-tab>
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
          <pre><code v-html="highlightedApiCode()" /></pre>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close">
          关闭
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { getWorkflow } from '@/api/workflows';
import type { WorkflowParam } from '@/types';
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

const props = defineProps<{
  workflowId: string;
  workflowName: string;
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

function close() {
  emit('update:modelValue', false);
}

// ---- API 代码生成状态 ----
const apiTab = ref('curl');
const apiFormat = ref('json');
const apiParams = ref<Array<WorkflowParam & { alias: string }>>([]);
const apiCodeRef = ref<Record<string, Record<string, string>>>({});
const apiCopying = ref(false);

/**
 * 判断是否为文件上传类参数（仅 image/video/audio 走文件上传）
 * @param paramType 参数类型
 */
function isMediaParam(paramType: string): boolean {
  return ['image', 'video', 'audio'].includes(paramType);
}

const apiHasMedia = computed(() => apiParams.value.some(p => isMediaParam(p.paramType)));

function q(s: string): string {
  return JSON.stringify(s);
}

function escDouble(s: string): string {
  return s.replace(/"/g, '\\"');
}

function hasAlias(p: WorkflowParam): p is WorkflowParam & { alias: string } {
  return p.alias != null && p.alias !== '';
}

/**
 * 生成 JSON/JS 格式的示例值
 * @param paramType 参数类型
 */
function sampleJsonValue(paramType: string): string {
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return 'true';
    default: return '"a string value"';
  }
}

/**
 * 生成 Python 格式的示例值
 * @param paramType 参数类型
 */
function samplePyValue(paramType: string): string {
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return 'True';
    default: return '"a string value"';
  }
}

/**
 * 生成 PowerShell 格式的示例值
 * @param paramType 参数类型
 */
function samplePSValue(paramType: string): string {
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return '$true';
    default: return '"a string value"';
  }
}

/**
 * 生成 JSON 请求体示例
 * @param id 工作流 ID
 * @param params 已配置别名的参数列表
 */
function genJsonSnippet(id: string, params: Array<WorkflowParam & { alias: string }>) {
  const pairs = params.map(p => `    ${q(p.alias)}: ${sampleJsonValue(p.paramType)}`).join(',\n');
  const jsonBody = `{\n${pairs}\n}`;
  return { jsonBody };
}

/**
 * 拆分文本与媒体参数
 * @param id 工作流 ID
 * @param params 已配置别名的参数列表
 */
function genMultipartSnippet(_id: string, params: Array<WorkflowParam & { alias: string }>) {
  // boolean/number/text 走 JSON 字段，仅 image/video/audio 走文件上传
  const textParams = params.filter(p => !isMediaParam(p.paramType));
  const mediaParams = params.filter(p => isMediaParam(p.paramType));
  return { textParams, mediaParams };
}

/**
 * 构建各语言 API 调用示例代码
 * @param id 工作流 ID
 * @param params 已配置别名的参数列表
 */
function buildApiCode(id: string, params: Array<WorkflowParam & { alias: string }>) {
  const { jsonBody } = genJsonSnippet(id, params);
  const { textParams, mediaParams } = genMultipartSnippet(id, params);

  const textPairs = textParams.map(p => `${q(p.alias)}: ${sampleJsonValue(p.paramType)}`).join(', ');
  const textJsonObj = `{ ${textPairs} }`;
  const textPyPairs = textParams.map(p => `${q(p.alias)}: ${samplePyValue(p.paramType)}`).join(', ');
  const textPyObj = `{ ${textPyPairs} }`;

  return {
    curl: {
      json: `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -H "Content-Type: application/json" \\
  -d '${jsonBody}'`,
      multipart: mediaParams.length > 0
        ? `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -F 'params=${textJsonObj}' \\
${mediaParams.map(p => `  -F "${p.alias}=@/path/to/${p.alias}.png"`).join(' \\\n')}`
        : '',
    },
    powershell: {
      json: `$body = @{
${params.map(p => `  ${p.alias} = ${samplePSValue(p.paramType)}`).join('\n')}
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + '-Method Post -Body $body -ContentType "application/json"',
      multipart: mediaParams.length > 0
        ? `$params = @{
${textParams.map(p => `  ${p.alias} = ${samplePSValue(p.paramType)}`).join('\n')}
} | ConvertTo-Json

$form = @{
  params = $params
${mediaParams.map(p => `  ${p.alias} = Get-Item -Path "C:\\path\\to\\${p.alias}.png"`).join('\n')}
}

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + '-Method Post -Form $form'
        : '',
    },
    python: {
      json: `import requests

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = {
${params.map(p => `    ${q(p.alias)}: ${samplePyValue(p.paramType)},`).join('\n')}
}
resp = requests.post(url, json=payload)
print(resp.json())`,
      multipart: mediaParams.length > 0
        ? `import requests
import json

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = ${textPyObj}
files = {}
${mediaParams.map(p => `files[${q(p.alias)}] = (${q(p.alias + '.png')}, open("/path/to/${p.alias}.png", "rb"), "application/octet-stream")`).join('\n')}
resp = requests.post(url, data={"params": json.dumps(payload)}, files=files)
print(resp.json())`
        : '',
    },
    nodejs: {
      json: `const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = {
${params.map(p => `  ${q(p.alias)}: ${sampleJsonValue(p.paramType)},`).join('\n')}
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const data = await res.json();
console.log(data);`,
      multipart: mediaParams.length > 0
        ? `import { readFile } from 'fs/promises';

const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = ${textJsonObj};
const formData = new FormData();
formData.append("params", JSON.stringify(payload));
${mediaParams.map(p => `const ${p.alias}Buffer = await readFile("/path/to/${p.alias}.png");
formData.append(${q(p.alias)}, new Blob([${p.alias}Buffer]), ${q(p.alias + '.png')});`).join('\n')}

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
String json = "${escDouble(jsonBody.replace(/\n {4}/g, '\\n    ').replace(/\n/g, '\\n'))}";

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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

String boundary = UUID.randomUUID().toString();
String url = "http://localhost:10721/api/workflows/${id}/execute";
String paramsJson = "${escDouble(textJsonObj)}";

// Build multipart body
var bos = new java.io.ByteArrayOutputStream();
// params field
bos.write(("--" + boundary + "\\r\\n").getBytes());
bos.write("Content-Disposition: form-data; name=\\"params\\"\\r\\n\\r\\n".getBytes());
bos.write(paramsJson.getBytes());
bos.write("\\r\\n".getBytes());

// File fields
${mediaParams.map(p => `bos.write(("--" + boundary + "\\r\\n").getBytes());
bos.write(("Content-Disposition: form-data; name=\\"${p.alias}\\"; filename=\\"${p.alias}.png\\"\\r\\n").getBytes());
bos.write("Content-Type: application/octet-stream\\r\\n\\r\\n".getBytes());
bos.write(Files.readAllBytes(Path.of("/path/to/${p.alias}.png")));
bos.write("\\r\\n".getBytes());`).join('\n')}
bos.write(("--" + boundary + "--\\r\\n").getBytes());

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
    .POST(HttpRequest.BodyPublishers.ofByteArray(bos.toByteArray()))
    .build();

HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(res.body());`
        : '',
    },
  };
}

/**
 * 高亮当前选中的 API 示例代码
 */
function highlightedApiCode(): string {
  const lang = apiTab.value;
  const fmt = apiFormat.value;
  const code = apiCodeRef.value?.[lang]?.[fmt];
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

/**
 * 复制当前 API 示例代码到剪贴板
 */
async function copyApiCode() {
  const lang = apiTab.value;
  const fmt = apiFormat.value;
  const code = apiCodeRef.value?.[lang]?.[fmt];
  if (!code) return;
  apiCopying.value = true;
  try {
    await navigator.clipboard.writeText(code);
    setTimeout(() => { apiCopying.value = false; }, 1500);
  } catch {
    apiCopying.value = false;
  }
}

/**
 * 加载工作流详情并构建 API 示例代码
 */
async function loadApiDocs() {
  if (!props.workflowId) return;
  apiTab.value = 'curl';
  apiFormat.value = 'json';
  try {
    const detail = await getWorkflow(props.workflowId);
    const callableParams = (detail.params ?? []).filter(hasAlias);
    apiParams.value = callableParams;
    apiCodeRef.value = buildApiCode(props.workflowId, callableParams);
  } catch {
    apiParams.value = [];
    apiCodeRef.value = buildApiCode(props.workflowId, []);
  }
  await nextTick();
  document.querySelectorAll('.api-code-block pre code').forEach(el => {
    hljs.highlightElement(el as HTMLElement);
  });
}

// 打开对话框时自动加载
watch(() => props.modelValue, (val) => {
  if (val) {
    loadApiDocs();
  }
});
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
