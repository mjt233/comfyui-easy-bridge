<template>
  <v-dialog v-model="show" max-width="960">
    <v-card>
      <v-card-title class="d-flex align-center ga-2 pr-4">
        <span>节点速查表</span>
        <span class="text-caption text-grey font-weight-regular">
          搜索 ComfyUI 节点类型，辅助编写动态构建脚本
        </span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          @click="show = false"
        />
      </v-card-title>

      <v-card-text>
        <!-- 搜索与分类筛选 -->
        <div class="d-flex align-center ga-3 mb-3 flex-wrap">
          <v-text-field
            v-model="query"
            label="搜索节点"
            placeholder="类名 / 展示名 / 分类 / 字段 / 输出类型"
            prepend-inner-icon="mdi-magnify"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            class="flex-grow-1"
            style="min-width: 240px"
          />
          <v-select
            v-model="category"
            label="分类"
            :items="categories"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="max-width: 220px"
          />
          <span class="text-caption text-grey">
            共 {{ filteredNodes.length }} 个节点
          </span>
        </div>

        <!-- 加载 / 错误 / 空状态 -->
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          <div class="d-flex align-center ga-2">
            <span class="flex-grow-1">{{ error }}</span>
            <v-btn
              size="small"
              variant="text"
              color="primary"
              @click="load"
            >
              重试
            </v-btn>
          </div>
        </v-alert>
        <v-alert
          v-else-if="loading"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          正在加载 ComfyUI 节点信息...
        </v-alert>
        <p
          v-else-if="loaded && filteredNodes.length === 0"
          class="text-grey text-center py-4"
        >
          没有匹配的节点
        </p>

        <!-- 节点列表（虚拟滚动 + 可展开查看字段详情） -->
        <v-virtual-scroll
          v-if="!loading && !error && filteredNodes.length > 0"
          :items="filteredNodes"
          :height="listHeight"
          :item-height="48"
          item-key="name"
          class="node-list"
        >
          <template #default="{ item }">
            <!-- 每行一个独立展开面板；nodeOf 收窄虚拟滚动插槽条目类型 -->
            <v-expansion-panels v-model="expanded" multiple>
              <v-expansion-panel :value="nodeOf(item).name">
                <v-expansion-panel-title>
                  <div class="d-flex align-center ga-2 w-100 flex-wrap">
                    <code class="text-body-2 font-weight-medium">{{ nodeOf(item).name }}</code>
                    <v-chip size="x-small" variant="tonal" color="primary">
                      {{ nodeOf(item).display_name }}
                    </v-chip>
                    <v-chip v-if="nodeOf(item).category" size="x-small" variant="outlined">
                      {{ nodeOf(item).category }}
                    </v-chip>
                    <v-spacer />
                    <v-btn
                      size="x-small"
                      variant="flat"
                      color="primary"
                      prepend-icon="mdi-code-tags"
                      @click.stop="insertNode(nodeOf(item))"
                    >
                      插入
                    </v-btn>
                  </div>
                </v-expansion-panel-title>

                <v-expansion-panel-text>
                  <!-- 必填输入 -->
                  <p class="text-subtitle-2 text-primary mb-1">
                    必填输入
                  </p>
                  <v-table v-if="nodeOf(item).required_inputs.length > 0" density="compact">
                    <thead>
                      <tr>
                        <th>字段名</th>
                        <th>类型 / 选项</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="f in nodeOf(item).required_inputs" :key="f.name">
                        <td>
                          <code>{{ f.name }}</code>
                        </td>
                        <td>
                          <code>{{ f.type }}</code>
                          <span
                            v-if="f.options && f.options.length > 0"
                            class="text-caption text-grey ml-1"
                          >
                            {{ f.options.join(' / ') }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                  <p v-else class="text-caption text-grey mb-2">
                    无必填输入
                  </p>

                  <!-- 可选输入 -->
                  <p class="text-subtitle-2 text-primary mt-3 mb-1">
                    可选输入
                  </p>
                  <v-table v-if="nodeOf(item).optional_inputs.length > 0" density="compact">
                    <thead>
                      <tr>
                        <th>字段名</th>
                        <th>类型 / 选项</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="f in nodeOf(item).optional_inputs" :key="f.name">
                        <td>
                          <code>{{ f.name }}</code>
                        </td>
                        <td>
                          <code>{{ f.type }}</code>
                          <span
                            v-if="f.options && f.options.length > 0"
                            class="text-caption text-grey ml-1"
                          >
                            {{ f.options.join(' / ') }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                  <p v-else class="text-caption text-grey mb-2">
                    无可选输入
                  </p>

                  <!-- 输出 -->
                  <p class="text-subtitle-2 text-primary mt-3 mb-1">
                    输出
                  </p>
                  <div class="d-flex flex-wrap ga-1 mb-3">
                    <v-chip
                      v-for="(o, oi) in nodeOf(item).outputs"
                      :key="oi"
                      size="x-small"
                      variant="tonal"
                      color="secondary"
                    >
                      {{ nodeOf(item).output_names[oi] && nodeOf(item).output_names[oi] !== o ? `${nodeOf(item).output_names[oi]} (${o})` : o }}
                    </v-chip>
                    <span v-if="nodeOf(item).outputs.length === 0" class="text-caption text-grey">无输出</span>
                  </div>

                  <!-- 代码片段预览 -->
                  <div class="code-preview">
                    <pre>{{ buildInsertSnippet(nodeOf(item)) }}</pre>
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </template>
        </v-virtual-scroll>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import axios from 'axios';
import { getNodeInfo } from '@/api/workflows';
import type { ComfyNodeReference, ComfyNodeField } from '@/types';

/** 对话框显示控制（v-model） */
const show = defineModel<boolean>({ required: true });

/** 事件：点击"插入"上抛要插入编辑器的代码片段 */
const emit = defineEmits<{
  insert: [text: string];
}>();

/** 搜索关键字 */
const query = ref('');
/** 分类筛选（null 表示全部） */
const category = ref<string | null>(null);
/** 已拉取的节点速查列表 */
const nodes = ref<ComfyNodeReference[]>([]);
/** 是否正在拉取 */
const loading = ref(false);
/** 是否已成功拉取过 */
const loaded = ref(false);
/** 加载错误信息 */
const error = ref('');
/** 已展开的节点类名列表 */
const expanded = ref<string[]>([]);

/** 节点列表最大高度（px），超出时按视口 60% 缩放 */
const LIST_MAX_HEIGHT = 560;
/** 节点列表可视高度（跟随窗口尺寸变化） */
const listHeight = ref(Math.min(window.innerHeight * 0.6, LIST_MAX_HEIGHT));

/**
 * 根据当前窗口尺寸刷新节点列表可视高度。
 */
function updateListHeight(): void {
  listHeight.value = Math.min(window.innerHeight * 0.6, LIST_MAX_HEIGHT);
}

onMounted(() => {
  updateListHeight();
  window.addEventListener('resize', updateListHeight);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateListHeight);
});

/** 分类列表（去重后按字母序） */
const categories = computed(() => {
  const set = new Set<string>();
  for (const n of nodes.value) {
    if (n.category) set.add(n.category);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

/**
 * 生成节点的可搜索文本（类名/展示名/分类/字段/输出），供关键字过滤。
 * @param n 节点速查条目
 * @returns 小写拼接文本
 */
function searchText(n: ComfyNodeReference): string {
  const fields = [...n.required_inputs, ...n.optional_inputs]
    .map((f) => `${f.name} ${f.type} ${(f.options ?? []).join(' ')}`)
    .join(' ');
  const outputs = [...n.outputs, ...n.output_names].join(' ');
  return `${n.name} ${n.display_name} ${n.category ?? ''} ${fields} ${outputs}`.toLowerCase();
}

/** 按关键字与分类过滤后的节点列表 */
const filteredNodes = computed(() => {
  // 点击清空（×）时 Vuetify 会将 v-model 置为 null，此处归一化为空串再处理
  const q = (query.value ?? '').trim().toLowerCase();
  return nodes.value.filter((n) => {
    if (category.value && n.category !== category.value) return false;
    if (!q) return true;
    return searchText(n).includes(q);
  });
});

// 过滤条件变化后清理已不在结果中的展开状态，避免数组无限增长
watch(filteredNodes, (list) => {
  const names = new Set(list.map((n) => n.name));
  expanded.value = expanded.value.filter((name) => names.has(name));
});

/**
 * 收窄虚拟滚动默认插槽中的条目类型（Vuetify 插槽类型为 unknown）。
 * @param item 虚拟滚动渲染的原始条目
 * @returns 节点速查条目
 */
function nodeOf(item: unknown): ComfyNodeReference {
  return item as ComfyNodeReference;
}

/**
 * 拉取 ComfyUI 节点速查表；失败时记录错误供重试。
 */
async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await getNodeInfo();
    loaded.value = true;
  } catch (e) {
    error.value = axios.isAxiosError(e) && e.response?.status === 503
      ? 'ComfyUI 节点信息不可用：请确认已在设置中配置 ComfyUI 地址且服务可达'
      : '加载节点信息失败，请重试';
  } finally {
    loading.value = false;
  }
}

// 首次打开时拉取（失败后可点"重试"再次拉取）
watch(show, (v) => {
  if (v && !loaded.value && !loading.value) {
    void load();
  }
});

/**
 * 为 INT/FLOAT/BOOLEAN/STRING/COMBO 生成占位值，其余类型（连线输入）用空字符串。
 * @param field 字段速查条目
 * @returns TS 字面量文本
 */
function placeholderFor(field: ComfyNodeField): string {
  if (field.type === 'INT') return '0';
  if (field.type === 'FLOAT') return '0.0';
  if (field.type === 'BOOLEAN') return 'true';
  if (field.type === 'STRING') return "''";
  if (field.type === 'COMBO') {
    return field.options && field.options.length > 0 ? JSON.stringify(field.options[0]) : "''";
  }
  return "''";
}

/**
 * 生成节点的 addNode 插入片段（必填输入带占位值）。
 * @param n 节点速查条目
 * @returns 代码片段文本
 */
function buildInsertSnippet(n: ComfyNodeReference): string {
  const required = n.required_inputs;
  if (required.length === 0) {
    return `ctx.addNode('node_new', '${n.name}', {});`;
  }
  const body = required.map((f) => `  ${JSON.stringify(f.name)}: ${placeholderFor(f)},`).join('\n');
  return `ctx.addNode('node_new', '${n.name}', {\n${body}\n});`;
}

/**
 * 点击"插入"：生成代码片段并上抛给编辑器。
 * @param n 节点速查条目
 */
function insertNode(n: ComfyNodeReference): void {
  emit('insert', buildInsertSnippet(n));
}
</script>

<style scoped>
.node-list {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
}

/* 虚拟滚动每行独立展开面板：用细分隔线区分行 */
.node-list :deep(.v-expansion-panel-title) {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.node-list :deep(.v-expansion-panel--active .v-expansion-panel-title) {
  border-bottom: none;
}

.code-preview {
  margin-top: 8px;
  background: #f5f5f5;
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
}

.code-preview pre {
  margin: 0;
  font-size: 12px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  white-space: pre;
}
</style>
