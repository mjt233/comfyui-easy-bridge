<template>
  <v-dialog :model-value="modelValue" max-width="800" @update:model-value="$emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center">
        <span>代码案例：{{ workflowName }}</span>
        <v-spacer />
        <v-chip
          v-if="hasMedia"
          size="small"
          color="warning"
          variant="tonal"
          class="mr-2"
        >
          含文件上传（Multipart）
        </v-chip>
        <v-chip
          v-if="hasOverrides"
          size="small"
          color="info"
          variant="tonal"
          class="mr-2"
        >
          含类型覆盖
        </v-chip>
        <v-chip
          v-if="hasProviderId"
          size="small"
          color="success"
          variant="tonal"
          class="mr-2"
        >
          指定提供商
        </v-chip>
      </v-card-title>
      <v-card-text>
        <v-tabs v-model="codeTab" color="primary">
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
        <div class="code-block mt-4">
          <div class="code-header d-flex align-center">
            <span class="text-caption ml-2">
              {{ hasMedia ? 'Multipart 文件上传请求' : 'JSON 请求' }}
            </span>
            <v-spacer />
            <v-tooltip text="复制代码" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  icon
                  variant="text"
                  density="compact"
                  size="small"
                  :color="codeCopying ? 'success' : undefined"
                  @click="copyCode"
                >
                  <v-icon>{{ codeCopying ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
                </v-btn>
              </template>
            </v-tooltip>
          </div>
          <pre><code v-html="highlightedCode()" /></pre>
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
import { ref, computed } from 'vue';
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

/** 代码案例对话框入参：当前执行表单的请求快照 */
const props = defineProps<{
  /** 对话框可见性 */
  modelValue: boolean;
  /** 工作流 ID */
  workflowId: string;
  /** 工作流名称（展示用） */
  workflowName: string;
  /** 提交的 JSON 别名值（媒体文件字段不在其中） */
  aliasValues: Record<string, string | number | boolean>;
  /** 媒体文件：别名 → 文件名列表（示例路径占位用） */
  files: Record<string, string[]>;
  /** 本次执行类型覆盖（别名 → 类型），可空 */
  paramTypeOverrides: Record<string, string>;
  /** 本次执行显式指定的提供商实例 ID；null 表示缺省（由后端按工作流配置解析） */
  providerId: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

function close() {
  emit('update:modelValue', false);
}

/** 当前选中的编程语言标签 */
const codeTab = ref('curl');
/** 复制中的短暂状态（显示对勾） */
const codeCopying = ref(false);

/** 是否存在媒体文件（决定展示 Multipart 或 JSON 示例） */
const hasMedia = computed(() => Object.keys(props.files).length > 0);
/** 是否存在类型覆盖（示例中需携带 paramTypeOverrides 字段） */
const hasOverrides = computed(() => Object.keys(props.paramTypeOverrides).length > 0);
/** 是否显式指定了执行提供商（示例中需携带 providerId 字段） */
const hasProviderId = computed(() => typeof props.providerId === 'string' && props.providerId !== '');

/** JSON 字符串字面量（带双引号） */
function q(s: string): string {
  return JSON.stringify(s);
}

/** Java 字符串转义：反斜杠/双引号/换行 */
function javaEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * 生成 PowerShell 字面量：布尔 $true/$false，数字原样，字符串转义双引号与 $ 符号
 * @param v 值
 * @returns PowerShell 字面量文本
 */
function psLiteral(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? '$true' : '$false';
  if (typeof v === 'number') return String(v);
  return `"${String(v).replace(/[`"$]/g, '`$&')}"`;
}

/**
 * 生成 Python 字面量：布尔 True/False，数字原样，字符串用 JSON 双引号形式（合法 Python 字符串）
 * @param v 值
 * @returns Python 字面量文本
 */
function pyLiteral(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(String(v));
}

/**
 * 构建各语言调用示例代码（json / multipart 两种格式）。
 * 基于当前表单的 aliasValues / files / paramTypeOverrides 生成，
 * 与实际提交到 /execute 的请求体保持一致。
 * @returns lang → format → 代码文本
 */
function buildCode(): Record<string, Record<'json' | 'multipart', string>> {
  const id = props.workflowId;
  const entries = Object.entries(props.aliasValues);
  const overrides = Object.entries(props.paramTypeOverrides);
  const mediaEntries = Object.entries(props.files);
  // 本次执行显式指定的提供商（非空时示例中携带 providerId 保留键）
  const providerId = props.providerId;
  const hasProviderId = typeof providerId === 'string' && providerId !== '';

  // ---- 多行 JSON body（含可选 paramTypeOverrides / providerId） ----
  const jsonLines: string[] = entries.map(([alias, value]) => `    ${q(alias)}: ${JSON.stringify(value)}`);
  if (overrides.length > 0) {
    jsonLines.push(`    ${q('paramTypeOverrides')}: {`);
    for (const [alias, type] of overrides) jsonLines.push(`      ${q(alias)}: ${q(type)}`);
    jsonLines.push('    }');
  }
  if (hasProviderId) {
    jsonLines.push(`    ${q('providerId')}: ${q(providerId)}`);
  }
  const jsonBody = `{\n${jsonLines.join(',\n')}\n}`;

  // ---- 单行 params JSON（multipart 用） ----
  const paramsInline = `{ ${entries.map(([alias, value]) => `${q(alias)}: ${JSON.stringify(value)}`).join(', ')} }`;
  const overridesInline = `{ ${overrides.map(([alias, type]) => `${q(alias)}: ${q(type)}`).join(', ')} }`;
  // 后端读取的 paramTypeOverrides JSON 字符串（multipart 文本字段）
  const overridesJson = JSON.stringify(props.paramTypeOverrides);

  // ==================== curl ====================
  const curlJson = `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\
  -H "Content-Type: application/json" \\
  -d '${jsonBody}'`;

  const curlLines: string[] = [
    `curl -X POST http://localhost:10721/api/workflows/${id}/execute \\`,
    `  -F 'params=${paramsInline}' \\`,
  ];
  if (overrides.length > 0) curlLines.push(`  -F 'paramTypeOverrides=${overridesInline}' \\`);
  if (hasProviderId) curlLines.push(`  -F 'providerId=${providerId}' \\`);
  for (const [alias, names] of mediaEntries) {
    for (const name of names) curlLines.push(`  -F "${alias}=@/path/to/${name}"`);
  }
  // 末行去掉续行符
  curlLines[curlLines.length - 1] = curlLines[curlLines.length - 1].replace(/ \\$/, '');
  const curlMultipart = curlLines.join('\n');

  // ==================== PowerShell ====================
  const psBodyLines: string[] = entries.map(([alias, value]) => `  ${alias} = ${psLiteral(value)}`);
  if (overrides.length > 0) {
    psBodyLines.push('  paramTypeOverrides = @{');
    for (const [alias, type] of overrides) psBodyLines.push(`    ${alias} = "${type}"`);
    psBodyLines.push('  }');
  }
  if (hasProviderId) psBodyLines.push(`  providerId = "${providerId}"`);
  const psJson = `$body = @{
${psBodyLines.join('\n')}
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" -Method Post -Body $body -ContentType "application/json"`;

  const psFormLines: string[] = [
    '$params = @{',
    ...entries.map(([alias, value]) => `  ${alias} = ${psLiteral(value)}`),
    '} | ConvertTo-Json',
    '',
    '$form = @{',
    '  params = $params',
  ];
  if (overrides.length > 0) psFormLines.push(`  paramTypeOverrides = '${overridesJson}'`);
  if (hasProviderId) psFormLines.push(`  providerId = '${providerId}'`);
  for (const [alias, names] of mediaEntries) {
    for (const name of names) psFormLines.push(`  ${alias} = Get-Item -Path "C:\\path\\to\\${name}"`);
  }
  psFormLines.push('}', '', `Invoke-RestMethod -Uri "http://localhost:10721/api/workflows/${id}/execute" -Method Post -Form $form`);
  const psMultipart = psFormLines.join('\n');

  // ==================== Python ====================
  const pyPayloadLines: string[] = entries.map(([alias, value]) => `    ${q(alias)}: ${pyLiteral(value)},`);
  if (overrides.length > 0) {
    pyPayloadLines.push(`    ${q('paramTypeOverrides')}: {`);
    for (const [alias, type] of overrides) pyPayloadLines.push(`        ${q(alias)}: ${q(type)},`);
    pyPayloadLines.push('    },');
  }
  if (hasProviderId) pyPayloadLines.push(`    ${q('providerId')}: ${q(providerId)},`);
  const pyJson = `import requests

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = {
${pyPayloadLines.join('\n')}
}
resp = requests.post(url, json=payload)
print(resp.json())`;

  const pyDataArgs: string[] = ['"params": json.dumps(payload)'];
  if (overrides.length > 0) pyDataArgs.push(`"paramTypeOverrides": json.dumps(${overridesJson})`);
  if (hasProviderId) pyDataArgs.push(`"providerId": ${q(providerId)}`);
  const pyFileLines: string[] = [];
  for (const [alias, names] of mediaEntries) {
    for (const name of names) {
      pyFileLines.push(`files[${q(alias)}] = (${q(name)}, open("/path/to/${name}", "rb"), "application/octet-stream")`);
    }
  }
  const pyMultipart = `import requests
import json

url = "http://localhost:10721/api/workflows/${id}/execute"
payload = ${paramsInline}
files = {}
${pyFileLines.join('\n')}
resp = requests.post(url, data={${pyDataArgs.join(', ')}}, files=files)
print(resp.json())`;

  // ==================== Node.js ====================
  const jsPayloadLines: string[] = entries.map(([alias, value]) => `  ${q(alias)}: ${JSON.stringify(value)},`);
  if (overrides.length > 0) {
    jsPayloadLines.push(`  ${q('paramTypeOverrides')}: {`);
    for (const [alias, type] of overrides) jsPayloadLines.push(`    ${q(alias)}: ${q(type)},`);
    jsPayloadLines.push('  },');
  }
  if (hasProviderId) jsPayloadLines.push(`  ${q('providerId')}: ${q(providerId)},`);
  const nodeJson = `const url = "http://localhost:10721/api/workflows/${id}/execute";
const payload = {
${jsPayloadLines.join('\n')}
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const data = await res.json();
console.log(data);`;

  const jsFormLines: string[] = [
    'import { readFile } from \'fs/promises\';',
    '',
    `const url = "http://localhost:10721/api/workflows/${id}/execute";`,
    `const payload = ${paramsInline};`,
    'const formData = new FormData();',
    'formData.append("params", JSON.stringify(payload));',
  ];
  if (overrides.length > 0) {
    jsFormLines.push(`formData.append("paramTypeOverrides", JSON.stringify(${overridesJson}));`);
  }
  if (hasProviderId) {
    jsFormLines.push(`formData.append("providerId", ${q(providerId)});`);
  }
  for (const [alias, names] of mediaEntries) {
    for (const name of names) {
      // 变量名用别名去特殊字符，避免重复时覆盖（每文件一个读取变量）
      const varName = `${alias.replace(/[^A-Za-z0-9_]/g, '_')}File`;
      jsFormLines.push(`const ${varName} = await readFile("/path/to/${name}");`);
      jsFormLines.push(`formData.append(${q(alias)}, new Blob([${varName}]), ${q(name)});`);
    }
  }
  jsFormLines.push(
    '',
    'const res = await fetch(url, {',
    '  method: "POST",',
    '  body: formData,',
    '});',
    'const data = await res.json();',
    'console.log(data);',
  );
  const nodeMultipart = jsFormLines.join('\n');

  // ==================== Java ====================
  const javaJson = `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

String url = "http://localhost:10721/api/workflows/${id}/execute";
String json = "${javaEscape(jsonBody)}";

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(json))
    .build();

HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(res.body());`;

  const jmLines: string[] = [
    'import java.net.URI;',
    'import java.net.http.HttpClient;',
    'import java.net.http.HttpRequest;',
    'import java.net.http.HttpResponse;',
    'import java.nio.file.Files;',
    'import java.nio.file.Path;',
    'import java.util.UUID;',
    '',
    'String boundary = UUID.randomUUID().toString();',
    `String url = "http://localhost:10721/api/workflows/${id}/execute";`,
    `String paramsJson = "${javaEscape(paramsInline)}";`,
  ];
  if (overrides.length > 0) {
    jmLines.push(`String overridesJson = "${javaEscape(overridesJson)}";`);
  }
  jmLines.push(
    '',
    '// Build multipart body',
    'var bos = new java.io.ByteArrayOutputStream();',
    '// params field',
    'bos.write(("--" + boundary + "\\r\\n").getBytes());',
    'bos.write("Content-Disposition: form-data; name=\\"params\\"\\r\\n\\r\\n".getBytes());',
    'bos.write(paramsJson.getBytes());',
    'bos.write("\\r\\n".getBytes());',
  );
  if (overrides.length > 0) {
    jmLines.push(
      '// paramTypeOverrides field',
      'bos.write(("--" + boundary + "\\r\\n").getBytes());',
      'bos.write("Content-Disposition: form-data; name=\\"paramTypeOverrides\\"\\r\\n\\r\\n".getBytes());',
      'bos.write(overridesJson.getBytes());',
      'bos.write("\\r\\n".getBytes());',
    );
  }
  if (hasProviderId) {
    jmLines.push(
      '// providerId field',
      'bos.write(("--" + boundary + "\\r\\n").getBytes());',
      'bos.write("Content-Disposition: form-data; name=\\"providerId\\"\\r\\n\\r\\n".getBytes());',
      `bos.write(${q(providerId)}.getBytes());`,
      'bos.write("\\r\\n".getBytes());',
    );
  }
  for (const [alias, names] of mediaEntries) {
    for (const name of names) {
      jmLines.push(
        `// File field: ${alias}`,
        'bos.write(("--" + boundary + "\\r\\n").getBytes());',
        `bos.write(("Content-Disposition: form-data; name=\\"${alias}\\"; filename=\\"${name}\\"\\r\\n").getBytes());`,
        'bos.write("Content-Type: application/octet-stream\\r\\n\\r\\n".getBytes());',
        `bos.write(Files.readAllBytes(Path.of("/path/to/${name}")));`,
        'bos.write("\\r\\n".getBytes());',
      );
    }
  }
  jmLines.push(
    'bos.write(("--" + boundary + "--\\r\\n").getBytes());',
    '',
    'HttpClient client = HttpClient.newHttpClient();',
    'HttpRequest request = HttpRequest.newBuilder()',
    '    .uri(URI.create(url))',
    '    .header("Content-Type", "multipart/form-data; boundary=" + boundary)',
    '    .POST(HttpRequest.BodyPublishers.ofByteArray(bos.toByteArray()))',
    '    .build();',
    '',
    'HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());',
    'System.out.println(res.body());',
  );
  const javaMultipart = jmLines.join('\n');

  return {
    curl: { json: curlJson, multipart: curlMultipart },
    powershell: { json: psJson, multipart: psMultipart },
    python: { json: pyJson, multipart: pyMultipart },
    nodejs: { json: nodeJson, multipart: nodeMultipart },
    java: { json: javaJson, multipart: javaMultipart },
  };
}

/** 当前语言 + 格式对应的代码（根据 props 响应式重建） */
const code = computed(() => buildCode());

/** 当前展示的代码文本（按 hasMedia 决定 json/multipart 格式） */
function currentCode(): string {
  const format = hasMedia.value ? 'multipart' : 'json';
  return code.value[codeTab.value]?.[format] ?? '';
}

/**
 * 高亮当前选中的代码
 * @returns 高亮后的 HTML
 */
function highlightedCode(): string {
  const langMap: Record<string, string> = {
    curl: 'bash',
    powershell: 'powershell',
    python: 'python',
    nodejs: 'json',
    java: 'java',
  };
  return hljs.highlight(currentCode(), { language: langMap[codeTab.value] || 'plaintext' }).value;
}

/**
 * 复制当前代码到剪贴板
 */
async function copyCode() {
  const text = currentCode();
  if (!text) return;
  codeCopying.value = true;
  try {
    await navigator.clipboard.writeText(text);
    setTimeout(() => { codeCopying.value = false; }, 1500);
  } catch {
    codeCopying.value = false;
  }
}
</script>

<style scoped>
.code-block {
  background: #1e1e1e;
  border-radius: 4px;
  overflow: hidden;
}
.code-header {
  background: #2d2d2d;
  padding: 4px 8px;
  border-bottom: 1px solid #3c3c3c;
}
.code-block pre {
  margin: 0;
  padding: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 400px;
}
.code-block code {
  background: transparent !important;
  color: #d4d4d4;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}
</style>
