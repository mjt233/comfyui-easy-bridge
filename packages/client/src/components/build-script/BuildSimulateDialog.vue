<template>
  <v-dialog v-model="show" max-width="980">
    <v-card>
      <v-card-title>模拟构建</v-card-title>
      <v-card-text>
        <!-- 步骤 1：填写参数 -->
        <template v-if="step === 1">
          <p class="text-body-2 text-grey mb-3">
            填写本次构建使用的参数，脚本会基于这些参数动态调整工作流。
          </p>

          <div v-for="p in aliasParams" :key="p.id" class="mb-3">
            <v-switch
              v-if="p.paramType === 'boolean'"
              v-model="booleanValues[p.alias!]"
              :label="paramLabel(p)"
              density="compact"
              hide-details
              color="primary"
            />
            <v-text-field
              v-else
              v-model="stringValues[p.alias!]"
              :label="paramLabel(p)"
              :type="p.paramType === 'number' ? 'number' : 'text'"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>

          <v-divider class="my-3" />

          <div class="d-flex align-center mb-2">
            <span class="text-subtitle-2">自定义字段</span>
            <v-spacer />
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addFreeField">
              添加自定义字段
            </v-btn>
          </div>
          <div
            v-for="(f, i) in freeFields"
            :key="i"
            class="d-flex align-center ga-2 mb-2"
          >
            <v-text-field
              v-model="f.key"
              label="字段名"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 220px"
            />
            <v-select
              v-model="f.type"
              :items="['text', 'number', 'boolean']"
              label="类型"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 130px"
            />
            <v-text-field
              v-model="f.value"
              label="值"
              density="compact"
              variant="outlined"
              hide-details
            />
            <v-btn icon="mdi-close" size="small" variant="text" @click="freeFields.splice(i, 1)" />
          </div>
        </template>

        <!-- 步骤 2：模拟结果 -->
        <template v-else>
          <v-alert
            v-if="errorText"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            <pre class="text-caption ma-0" style="white-space: pre-wrap">{{ errorText }}</pre>
          </v-alert>

          <template v-else>
            <v-tabs v-model="resultTab" color="primary">
              <v-tab value="table">节点与参数表</v-tab>
              <v-tab value="canvas">画布</v-tab>
              <v-tab value="json">JSON</v-tab>
            </v-tabs>

            <v-window v-model="resultTab" class="mt-3">
              <v-window-item value="table">
                <v-table v-if="graphNodes.length > 0">
                  <thead>
                    <tr>
                      <th>节点 ID</th>
                      <th>节点标题</th>
                      <th>字段名</th>
                      <th>值</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="node in graphNodes" :key="node.id">
                      <tr v-for="(input, fi) in node.inputs" :key="fi">
                        <td>{{ node.id }}</td>
                        <td>{{ node.title }}</td>
                        <td>{{ input.name }}</td>
                        <td class="text-caption">
                          <span v-if="input.connected">连线 → {{ input.source }}[{{ input.sourceSlot }}]</span>
                          <span v-else>{{ input.displayValue ?? '-' }}</span>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </v-table>
                <p v-else class="text-grey text-center py-4 ma-0">
                  构建结果中没有可展示的节点
                </p>
              </v-window-item>

              <v-window-item value="canvas">
                <!-- 仅画布 Tab 激活时挂载：保证 vue-flow viewport 以真实尺寸初始化，避免隐藏挂载报错（项目既有教训，见 WorkflowDetailPage） -->
                <WorkflowCanvas
                  v-if="builtJson && resultTab === 'canvas'"
                  :raw-json="builtJson"
                  :height="'460px'"
                />
              </v-window-item>

              <v-window-item value="json">
                <v-textarea
                  :model-value="formattedJson"
                  readonly
                  rows="16"
                  variant="outlined"
                  class="mb-2"
                />
                <v-btn color="primary" variant="tonal" @click="downloadJson">
                  下载 JSON
                </v-btn>
              </v-window-item>
            </v-window>
          </template>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="step === 2" variant="text" @click="step = 1">
          返回修改参数
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="close">
          关闭
        </v-btn>
        <v-btn
          v-if="step === 1"
          color="primary"
          variant="flat"
          :loading="simulating"
          @click="runSimulate"
        >
          开始模拟
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkflowDetail, WorkflowParam } from '@/types';
import { simulateBuild } from '@/api/workflows';
import { parseWorkflowGraph, type GraphNode } from '../workflow-canvas/workflowGraph';
import WorkflowCanvas from '../workflow-canvas/WorkflowCanvas.vue';

/** 对话框显示控制（v-model） */
const show = defineModel<boolean>({ required: true });

/** 组件 props：工作流详情与当前脚本内容 */
const props = defineProps<{
  workflow: WorkflowDetail;
  script: string;
}>();

/** 当前步骤：1=填写参数，2=模拟结果 */
const step = ref<1 | 2>(1);
/** 模拟请求中 */
const simulating = ref(false);
/** 模拟错误信息 */
const errorText = ref('');
/** 构建后的 JSON 字符串 */
const builtJson = ref('');
/** 结果视图 tab */
const resultTab = ref('table');

/** 可传参的别名参数（alias 非空） */
const aliasParams = computed<WorkflowParam[]>(() =>
  props.workflow.params.filter((p) => p.alias != null && p.alias !== ''),
);

/** 文本/数字参数值（key 为别名） */
const stringValues = ref<Record<string, string>>({});

/** 布尔参数值（key 为别名） */
const booleanValues = ref<Record<string, boolean>>({});

/** 自定义自由字段行 */
interface FreeField {
  key: string;
  type: string;
  value: string;
}
const freeFields = ref<FreeField[]>([]);

/** 参数展示标签：别名 + 可选 label */
function paramLabel(p: WorkflowParam): string {
  return p.label ? `${p.alias}（${p.label}）` : (p.alias ?? '');
}

/** 添加一行自定义字段 */
function addFreeField(): void {
  freeFields.value.push({ key: '', type: 'text', value: '' });
}

/** 关闭对话框并复位 */
function close(): void {
  show.value = false;
  step.value = 1;
  errorText.value = '';
  builtJson.value = '';
  resultTab.value = 'table';
}

/** 组装请求参数（含类型转换） */
function buildParams(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // 别名参数：按 paramType 做类型转换
  for (const p of aliasParams.value) {
    if (!p.alias) continue;
    if (p.paramType === 'boolean') {
      result[p.alias] = booleanValues.value[p.alias] ?? false;
    } else if (p.paramType === 'number') {
      const v = stringValues.value[p.alias] ?? '';
      result[p.alias] = v === '' ? '' : Number(v);
    } else {
      result[p.alias] = stringValues.value[p.alias] ?? '';
    }
  }
  // 自定义自由字段：同样按类型转换
  for (const f of freeFields.value) {
    const key = f.key.trim();
    if (!key) continue;
    if (f.type === 'boolean') {
      result[key] = f.value === 'true' || f.value === '1';
    } else if (f.type === 'number') {
      result[key] = f.value === '' ? '' : Number(f.value);
    } else {
      result[key] = f.value;
    }
  }
  return result;
}

/** 执行模拟构建 */
async function runSimulate(): Promise<void> {
  simulating.value = true;
  errorText.value = '';
  try {
    const res = await simulateBuild(props.workflow.id, {
      script: props.script,
      params: buildParams(),
    });
    builtJson.value = res.json;
    step.value = 2;
  } catch (err) {
    // 后端失败返回 HTTP 400 {error, code}，axios reject 后在此展示错误
    errorText.value = err instanceof Error ? err.message : String(err);
    step.value = 2;
  } finally {
    simulating.value = false;
  }
}

/** 格式化 JSON 展示 */
const formattedJson = computed(() => {
  try {
    return JSON.stringify(JSON.parse(builtJson.value), null, 2);
  } catch {
    return builtJson.value;
  }
});

/** 节点表数据：解析构建后的 JSON */
const graphNodes = computed<GraphNode[]>(() => {
  if (!builtJson.value) return [];
  const parsed = parseWorkflowGraph(builtJson.value);
  return parsed.ok ? parsed.nodes : [];
});

/** 下载构建结果 JSON */
function downloadJson(): void {
  const blob = new Blob([formattedJson.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workflow-${props.workflow.id}-build.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 打开对话框时用已保存别名初始化参数值（仅初始化一次）
watch(show, (val) => {
  if (val) {
    stringValues.value = {};
    booleanValues.value = {};
    for (const p of aliasParams.value) {
      if (!p.alias) continue;
      if (p.paramType === 'boolean') {
        booleanValues.value[p.alias] = false;
      } else {
        stringValues.value[p.alias] = '';
      }
    }
    freeFields.value = [];
    step.value = 1;
    errorText.value = '';
    builtJson.value = '';
    resultTab.value = 'table';
  }
});
</script>
