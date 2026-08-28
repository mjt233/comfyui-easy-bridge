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

        <!-- 字段候选项说明：列出可下拉选择的字段、候选项（label 展示 / value 提交）与多选拼接规则 -->
        <div v-if="candidateParams.length > 0" class="mt-4">
          <p class="text-subtitle-2 mb-1">
            字段候选项
          </p>
          <div
            v-for="p in candidateParams"
            :key="p.alias"
            class="d-flex align-center flex-wrap ga-1 mb-1"
          >
            <code class="candidate-alias">{{ p.alias }}</code>
            <v-chip
              v-for="c in p.candidates"
              :key="c.value"
              size="x-small"
              variant="tonal"
              color="primary"
            >
              {{ c.label !== c.value ? `${c.label}（${c.value}）` : c.label }}
            </v-chip>
            <span class="text-caption text-grey">
              {{ p.multiple ? '多选：提交时将多个提交值（value）用英文逗号 "," 拼接为一个字符串' : '单选：提交其中一个提交值（value）' }}
            </span>
          </div>
          <p class="text-caption text-grey mt-2 mb-0">
            获取候选项数据：携带登录 Token 调用
            <code>GET /api/workflows/{{ workflowId }}</code>，
            响应中 <code>params[]</code>（静态参数）与 <code>declaredParams[]</code>（动态声明字段）的
            <code>candidates</code> 为候选项数组（元素为 <code>{"label": 展示名, "value": 提交值}</code>）、
            <code>multiple</code> 为是否多选。
          </p>
          <div class="api-code-block mt-2">
            <pre><code>{{ candidatesFetchSnippet }}</code></pre>
          </div>
        </div>

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

/**
 * 配置了候选项的参数列表（仅 text 类型；供「字段候选项」说明区展示）
 */
const candidateParams = computed(() =>
  apiParams.value.filter((p) => isCandidateParam(p)),
);

/**
 * 判断参数是否配置了候选项（仅 text 类型生效）
 * @param p 参数
 */
function isCandidateParam(p: WorkflowParam): boolean {
  return p.paramType === 'text' && (p.candidates ?? []).length > 0;
}

/**
 * 获取候选项数据的示例请求（带 Token 调用工作流详情接口）
 */
const candidatesFetchSnippet = computed(() =>
  `# 获取字段候选项（需登录 Token）：响应 params[]/declaredParams[] 含 candidates 与 multiple\n`
  + `curl -H "Authorization: Bearer <token>" http://localhost:10721/api/workflows/${props.workflowId}`);

/**
 * 生成文本参数示例值：有候选项时使用候选提交值 value（多选拼接），否则使用通用占位
 * @param p 参数
 */
function sampleTextValue(p: WorkflowParam): string {
  const candidates = p.candidates ?? [];
  if (candidates.length === 0) return 'a string value';
  // 多选：取前两个候选项的提交值（value）拼接演示英文逗号拼接规则（仅一个候选时取该值）
  if (p.multiple === true) {
    return candidates.slice(0, 2).map((c) => c.value).join(',');
  }
  return candidates[0].value;
}

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
 * @param p 参数（可选；带候选项时示例值取自候选项）
 */
function sampleJsonValue(paramType: string, p?: WorkflowParam): string {
  if (p && isCandidateParam(p)) return q(sampleTextValue(p));
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return 'true';
    default: return '"a string value"';
  }
}

/**
 * 生成 Python 格式的示例值
 * @param paramType 参数类型
 * @param p 参数（可选；带候选项时示例值取自候选项）
 */
function samplePyValue(paramType: string, p?: WorkflowParam): string {
  if (p && isCandidateParam(p)) return q(sampleTextValue(p));
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return 'True';
    default: return '"a string value"';
  }
}

/**
 * 生成 PowerShell 格式的示例值
 * @param paramType 参数类型
 * @param p 参数（可选；带候选项时示例值取自候选项）
 */
function samplePSValue(paramType: string, p?: WorkflowParam): string {
  if (p && isCandidateParam(p)) return q(sampleTextValue(p));
  switch (paramType) {
    case 'number': return '1';
    case 'boolean': return '$true';
    default: return '"a string value"';
  }
}

/**
 * 生成 JSON 请求体示例（含可选保留键 providerId）
 * @param id 工作流 ID
 * @param params 已配置别名的参数列表
 */
function genJsonSnippet(id: string, params: Array<WorkflowParam & { alias: string }>) {
  const pairs = params.map(p => `    ${q(p.alias)}: ${sampleJsonValue(p.paramType, p)}`).join(',\n');
  // 末尾附可选保留键 providerId（本次执行显式指定提供商；调用方可不传或替换为实际实例 ID）
  const jsonBody = `{\n${pairs}${pairs !== '' ? ',\n' : ''}    ${q('providerId')}: "REPLACE_WITH_PROVIDER_ID"\n}`;
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

  const textPairs = textParams.map(p => `${q(p.alias)}: ${sampleJsonValue(p.paramType, p)}`).join(', ');
  const textJsonObj = `{ ${textPairs} }`;
  const textPyPairs = textParams.map(p => `${q(p.alias)}: ${samplePyValue(p.paramType, p)}`).join(', ');
  const textPyObj = `{ ${textPyPairs} }`;

  // providerId 示例占位值（调用方替换为实际实例 ID；可在「设置 → 执行提供商」中查看）
  const providerIdValue = 'REPLACE_WITH_PROVIDER_ID';
  // providerId 参数说明注释（按各语言注释语法生成；说明可选性与缺省时的解析行为）
  const providerCommentHash = '# 可选：providerId 指定本次执行的提供商实例 ID；不传则按 工作流配置 → 全局默认 解析';
  const providerCommentSlash = '// 可选：providerId 指定本次执行的提供商实例 ID；不传则按 工作流配置 → 全局默认 解析';

  return {
    curl: {
      json: `${providerCommentHash}
curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -H "Content-Type: application/json" \\
  -d '${jsonBody}'`,
      multipart: mediaParams.length > 0
        ? `${providerCommentHash}
curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -F 'params=${textJsonObj}' \\
  -F 'providerId=${providerIdValue}' \\
${mediaParams.map(p => `  -F "${p.alias}=@/path/to/${p.alias}.png"`).join(' \\\n')}`
        : '',
    },
    powershell: {
      json: `${providerCommentHash}
$body = @{
${params.map(p => `  ${p.alias} = ${samplePSValue(p.paramType, p)}`).join('\n')}
  providerId = "${providerIdValue}"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + '-Method Post -Body $body -ContentType "application/json"',
      multipart: mediaParams.length > 0
        ? `${providerCommentHash}
$params = @{
${textParams.map(p => `  ${p.alias} = ${samplePSValue(p.paramType, p)}`).join('\n')}
} | ConvertTo-Json

$form = @{
  params = $params
  providerId = "${providerIdValue}"
${mediaParams.map(p => `  ${p.alias} = Get-Item -Path "C:\\path\\to\\${p.alias}.png"`).join('\n')}
}

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" `
        + '-Method Post -Form $form'
        : '',
    },
    python: {
      json: `import requests

${providerCommentHash}
url = "http://localhost:10721/api/workflows/${id}/execute"
payload = {
${params.map(p => `    ${q(p.alias)}: ${samplePyValue(p.paramType, p)},`).join('\n')}
    ${q('providerId')}: ${q(providerIdValue)},
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
${providerCommentHash}
resp = requests.post(url, data={"params": json.dumps(payload), "providerId": ${q(providerIdValue)}}, files=files)
print(resp.json())`
        : '',
    },
    nodejs: {
      json: `${providerCommentSlash}
const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = {
${params.map(p => `  ${q(p.alias)}: ${sampleJsonValue(p.paramType, p)},`).join('\n')}
  ${q('providerId')}: ${q(providerIdValue)},
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
${providerCommentSlash}
formData.append("providerId", ${q(providerIdValue)});
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

${providerCommentSlash}
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

${providerCommentSlash}
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
// providerId field（可选）
bos.write(("--" + boundary + "\\r\\n").getBytes());
bos.write("Content-Disposition: form-data; name=\\"providerId\\"\\r\\n\\r\\n".getBytes());
bos.write("${providerIdValue}".getBytes());
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
    // 静态参数（有别名）与动态字段声明合并为可调用参数：按 alias 去重、静态优先
    const callableParams = (detail.params ?? []).filter(hasAlias);
    const seen = new Set(callableParams.map((p) => p.alias));
    for (const dp of detail.declaredParams ?? []) {
      if (seen.has(dp.alias)) continue;
      seen.add(dp.alias);
      callableParams.push({
        id: 0,
        workflowId: '',
        nodeId: '',
        fieldName: '',
        alias: dp.alias,
        label: dp.label,
        paramType: dp.paramType || 'text',
        defaultValue: dp.defaultValue,
        // 动态声明字段不对应真实节点，无 rawJson 原值
        nodeRawValue: null,
        // 候选项/多选随声明透传（仅 text 类型有效），供示例值与说明区使用
        candidates: (dp.paramType || 'text') === 'text' ? (dp.candidates ?? []) : [],
        multiple: dp.multiple === true,
      });
    }
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
.candidate-alias {
  background: rgba(128, 128, 128, 0.15);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
