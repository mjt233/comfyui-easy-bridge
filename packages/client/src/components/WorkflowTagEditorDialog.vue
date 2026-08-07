<template>
  <v-dialog
    :model-value="modelValue"
    max-width="560"
    :persistent="saving"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card>
      <v-card-title>编辑标签</v-card-title>
      <v-card-text>
        <!-- 层级不变量提示：打子标签必须先打父标签 -->
        <p class="text-caption text-grey mb-2">
          勾选子标签需先勾选其父标签
        </p>

        <!-- 空标签提示：标签树为空时给出引导 -->
        <p v-if="allTags.length === 0" class="text-grey text-center py-4">
          暂无可用标签，请先在标签管理页创建
        </p>

        <!-- 顶层标签 checkbox -->
        <template v-for="parent in allTags" :key="parent.id">
          <v-checkbox
            :model-value="checkedParents.has(parent.id)"
            :label="parent.name"
            hide-details
            density="compact"
            @update:model-value="toggleParent(parent, $event)"
          />

          <!-- 子标签区：父标签未勾选时禁用，保证「子必带父」不变量 -->
          <div v-if="parent.children.length > 0" class="ml-8">
            <!-- 每个子标签的 checkbox 与其元数据编辑区在同一 v-for 内，编辑区紧跟该子标签下方 -->
            <template v-for="child in parent.children" :key="child.id">
              <v-checkbox
                :model-value="checkedChildren.has(child.id)"
                :label="child.name"
                :disabled="!checkedParents.has(parent.id)"
                hide-details
                density="compact"
                class="ml-4"
                @update:model-value="toggleChild(child, $event)"
              />

              <!-- 元数据编辑区：仅选中的且带元数据定义的子标签，默认收起 -->
              <div
                v-if="checkedChildren.has(child.id) && child.metadataDef.length > 0"
                class="ml-4 mb-3"
              >
                <div class="d-flex align-center">
                  <span class="text-caption text-grey">{{ child.name }} 元数据</span>
                  <v-spacer />
                  <v-btn
                    size="small"
                    variant="text"
                    density="compact"
                    :prepend-icon="expandedMetadata[child.id] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    @click="toggleMetadata(child.id)"
                  >
                    {{ expandedMetadata[child.id] ? '收起' : '展开' }}
                  </v-btn>
                </div>
                <v-expand-transition>
                  <!-- 展开/收起由 v-if 控制（不能用 v-show：v-expand-transition 会覆盖 v-show 的
                       display:none，导致内容在收起态仍可见）；输入值绑定在持久的 metadataInputs 上，重建不丢数据 -->
                  <div v-if="expandedMetadata[child.id]" class="d-flex flex-column ga-2 pt-1">
                    <!-- 按字段类型渲染输入控件：number→数字框 / string→文本框 / boolean→开关 -->
                    <template v-for="field in child.metadataDef" :key="field.key">
                      <v-text-field
                        v-if="field.type === 'number'"
                        v-model.number="metadataForChild(child.id)[field.key]"
                        :label="field.label"
                        type="number"
                        density="compact"
                        variant="outlined"
                        hide-details
                      />
                      <v-text-field
                        v-else-if="field.type === 'string'"
                        v-model="metadataForChild(child.id)[field.key]"
                        :label="field.label"
                        density="compact"
                        variant="outlined"
                        hide-details
                      />
                      <v-switch
                        v-else
                        v-model="metadataForChild(child.id)[field.key]"
                        :label="field.label"
                        color="primary"
                        density="compact"
                        hide-details
                      />
                    </template>
                  </div>
                </v-expand-transition>
              </div>
            </template>
          </div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <!-- 保存中禁用取消/保存，防止异步保存期间误操作 -->
        <v-btn variant="text" :disabled="saving" @click="close">
          取消
        </v-btn>
        <v-btn color="primary" :loading="saving" :disabled="saving" @click="handleSave">
          保存
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type {
  TagMetadataValues,
  TagTreeNode,
  WorkflowTagGroup,
  WorkflowTagInput,
} from '@/types';

/**
 * 组件 props：弹窗可见性、可用标签树、当前工作流标签分组、保存中状态
 */
const props = withDefaults(defineProps<{
  /** 弹窗可见性（v-model） */
  modelValue: boolean;
  /** 可用标签树 */
  allTags: TagTreeNode[];
  /** 当前工作流的标签分组 */
  currentTags: WorkflowTagGroup[];
  /** 是否正在保存（保存中禁用取消/保存按钮；由父组件在保存成功后关闭弹窗） */
  saving?: boolean;
}>(), {
  /** 默认非保存中 */
  saving: false,
});

/**
 * 组件事件：可见性变更与保存
 */
const emit = defineEmits<{
  /** 弹窗可见性变更（v-model） */
  (e: 'update:modelValue', value: boolean): void;
  /** 保存：返回整组标签（tagId + 用户元数据） */
  (e: 'save', tags: WorkflowTagInput[]): void;
}>();

/** 选中的父标签 ID 集合 */
const checkedParents = ref<Set<string>>(new Set());
/** 选中的子标签 ID 集合 */
const checkedChildren = ref<Set<string>>(new Set());
/** 元数据输入：tagId → { key: 当前值 } */
const metadataInputs = ref<Record<string, TagMetadataValues>>({});
/** 元数据展开状态：tagId → boolean（默认 false，默认收起） */
const expandedMetadata = ref<Record<string, boolean>>({});

/**
 * 在标签树中查找子标签节点
 * @param childId 子标签 ID
 * @returns 子标签节点；未找到返回 null
 */
function findChild(childId: string): TagTreeNode | null {
  for (const parent of props.allTags) {
    const child = parent.children.find((c) => c.id === childId);
    if (child) return child;
  }
  return null;
}

/**
 * 从当前工作流标签分组中查找某子标签的已配置元数据
 * @param childId 子标签 ID
 * @returns 已配置元数据；未找到返回空对象
 */
function findConfiguredMetadata(childId: string): TagMetadataValues {
  for (const group of props.currentTags) {
    for (const node of group.tags) {
      if (node.id === childId) return node.configuredMetadata;
    }
  }
  return {};
}

/**
 * 依据已配置值初始化某子标签的元数据输入；未配置的键用字段默认值，保证输入框有合理初值
 * @param childId 子标签 ID
 * @param configured 已配置的元数据（缺省空对象）
 * @returns 初始化后的输入对象
 */
function seedMetadataInputs(childId: string, configured: TagMetadataValues = {}): TagMetadataValues {
  const child = findChild(childId);
  // 标签树中找不到定义时，仅保留已配置值
  if (!child) return { ...configured };
  const out: TagMetadataValues = {};
  for (const def of child.metadataDef) {
    // 已配置值优先，否则用字段默认值
    out[def.key] = configured[def.key] ?? def.defaultValue;
  }
  return out;
}

/**
 * 获取子标签的元数据输入对象；未初始化时按「已配置值 → 字段默认值」惰性初始化
 * @param childId 子标签 ID
 * @returns 该子标签的元数据输入对象（v-model 绑定的目标）
 */
function metadataForChild(childId: string): TagMetadataValues {
  let inputs = metadataInputs.value[childId];
  if (!inputs) {
    // 惰性初始化：保证 v-model 绑定的记录已存在
    inputs = seedMetadataInputs(childId, findConfiguredMetadata(childId));
    metadataInputs.value[childId] = inputs;
  }
  return inputs;
}

/**
 * 切换父标签选中状态；取消父标签时级联取消其下所有子标签，保证「子必带父」不变量
 * @param parent 顶层标签节点
 * @param val checkbox 事件值（可能为 null）
 */
function toggleParent(parent: TagTreeNode, val: unknown): void {
  if (val === true) {
    checkedParents.value.add(parent.id);
    return;
  }
  checkedParents.value.delete(parent.id);
  // 父标签取消时，其下子标签一并取消，避免保存出「有子无父」的非法组合
  for (const child of parent.children) {
    checkedChildren.value.delete(child.id);
  }
}

/**
 * 切换子标签选中状态
 * @param child 子标签节点
 * @param val checkbox 事件值（可能为 null）
 */
function toggleChild(child: TagTreeNode, val: unknown): void {
  if (val === true) {
    checkedChildren.value.add(child.id);
    // 选中时初始化元数据输入，保证元数据区渲染时可绑定
    metadataForChild(child.id);
  } else {
    checkedChildren.value.delete(child.id);
  }
}

/**
 * 切换子标签元数据编辑区的展开/收起
 * @param childId 子标签 ID
 */
function toggleMetadata(childId: string): void {
  expandedMetadata.value[childId] = !expandedMetadata.value[childId];
}

/**
 * 过滤元数据：仅保留与字段默认值不同的非空值；空串/未填写省略，服务端回落默认值
 * @param child 子标签节点
 * @returns 过滤后的用户元数据
 */
function filterMetadata(child: TagTreeNode): TagMetadataValues {
  const inputs = metadataInputs.value[child.id] ?? {};
  const out: TagMetadataValues = {};
  for (const def of child.metadataDef) {
    const value = inputs[def.key];
    // 空串/未定义省略；与默认值相同也省略（服务端合并规则会用默认值）
    if (value === '' || value === undefined) continue;
    if (value === def.defaultValue) continue;
    out[def.key] = value;
  }
  return out;
}

/**
 * 构建保存结果：父标签恒携带空元数据；子标签仅保留与默认值不同的用户输入
 * @returns 保存结果数组（父标签在前、其子标签随后，保持分组顺序）
 */
function buildResult(): WorkflowTagInput[] {
  const result: WorkflowTagInput[] = [];
  for (const parent of props.allTags) {
    if (checkedParents.value.has(parent.id)) {
      // 父标签无元数据定义，恒为空对象
      result.push({ tagId: parent.id, metadataValues: {} });
    }
    for (const child of parent.children) {
      if (checkedChildren.value.has(child.id)) {
        result.push({ tagId: child.id, metadataValues: filterMetadata(child) });
      }
    }
  }
  return result;
}

/**
 * 保存：构建结果数组并触发 save 事件；不在此处关闭弹窗，
 * 由父组件在异步保存成功后通过 modelValue=false 关闭，避免保存失败时丢失编辑内容
 */
function handleSave(): void {
  const result = buildResult();
  emit('save', result);
}

/**
 * 取消：仅关闭弹窗，不保存
 */
function close(): void {
  emit('update:modelValue', false);
}

/**
 * 监听弹窗可见性：打开时按当前工作流标签初始化选中状态与元数据输入，元数据区默认收起
 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    // 父标签：当前工作流的每个分组 ID
    checkedParents.value = new Set(props.currentTags.map((g) => g.id));
    checkedChildren.value = new Set();
    metadataInputs.value = {};
    for (const group of props.currentTags) {
      for (const node of group.tags) {
        checkedChildren.value.add(node.id);
        // 依据已配置值（缺省用字段默认值）初始化元数据输入
        metadataInputs.value[node.id] = seedMetadataInputs(node.id, node.configuredMetadata);
      }
    }
    // 元数据区默认收起
    expandedMetadata.value = {};
  },
);
</script>
