<template>
  <v-app-bar color="primary">
    <v-app-bar-title>{{ isEdit ? '编辑工作流' : '新建工作流' }}</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">
      返回
    </v-btn>
  </v-app-bar>

  <v-container>
    <v-card>
      <v-card-text>
        <v-alert
          v-if="error"
          type="error"
          closable
          class="mb-4"
        >
          {{ error }}
        </v-alert>

        <v-text-field
          v-model="form.id"
          label="工作流 ID"
          hint="唯一标识，修改后会影响历史任务记录的关联"
          variant="outlined"
          class="mb-3"
        />
        <v-btn
          size="small"
          variant="text"
          class="mb-3"
          @click="generateId"
        >
          随机生成
        </v-btn>

        <v-text-field
          v-model="form.name"
          label="工作流名称"
          variant="outlined"
          class="mb-3"
        />

        <!-- 执行提供商选择：仅展示已启用实例，留空表示使用全局默认实例 -->
        <v-select
          v-model="providerId"
          :items="providerOptions"
          label="执行提供商"
          hint="留空使用全局默认提供商实例"
          persistent-hint
          variant="outlined"
          clearable
          class="mb-4"
        />

        <div class="d-flex align-center mb-2">
          <span class="text-subtitle-1">备注说明（Markdown）</span>
        </div>
        <!-- 备注说明使用 Monaco 编辑器：Markdown 语法高亮，可拖拽调整高度 -->
        <MonacoEditor
          v-model="form.description"
          language="markdown"
          height="240px"
          resizable
          class="mb-1"
        />
        <div class="text-caption text-grey mb-3">
          支持 Markdown 语法，可在工作流详情页与执行对话框中展开渲染展示
        </div>

        <div class="d-flex align-center mb-2">
          <span class="text-subtitle-1">ComfyUI API JSON</span>
          <v-spacer />
          <v-btn
            size="small"
            variant="tonal"
            prepend-icon="mdi-format-json"
            @click="formatRawJson"
          >
            格式化
          </v-btn>
        </div>
        <!-- 工作流 JSON 统一用 Monaco 编辑器呈现，支持语法高亮/折叠/校验 -->
        <MonacoEditor
          v-model="form.rawJson"
          language="json"
          height="360px"
          class="mb-3"
        />

        <v-file-input
          label="或上传 JSON 文件"
          variant="outlined"
          accept=".json"
          @update:model-value="handleFileUpload"
        />
      </v-card-text>
      <v-card-actions class="pa-4">
        <v-spacer />
        <v-btn variant="text" to="/admin">
          取消
        </v-btn>
        <v-btn color="primary" :loading="saving" @click="handleSave">
          保存
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- 附件管理：编辑模式直接上传/下载/删除；新建模式暂存到保存后自动上传 -->
    <v-card class="mt-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <span>附件</span>
        <v-chip
          v-if="attachments.length + pendingFiles.length > 0"
          size="small"
          color="primary"
          variant="tonal"
        >
          {{ attachments.length + pendingFiles.length }}
        </v-chip>
        <v-spacer />
        <v-file-input
          ref="attachmentInput"
          label="添加附件"
          variant="outlined"
          density="compact"
          multiple
          hide-details
          class="attachment-input"
          @update:model-value="onAttachmentsSelected"
        />
      </v-card-title>
      <v-divider />
      <v-card-text
        v-if="attachments.length === 0 && pendingFiles.length === 0"
        class="text-center py-6 text-grey"
      >
        {{ isEdit ? '暂无附件，可通过右上角添加' : '暂无附件，保存工作流后自动上传所选文件' }}
      </v-card-text>
      <v-list v-else>
        <v-list-item
          v-for="att in attachments"
          :key="`server-${att.id}`"
          :title="att.filename"
          :subtitle="formatSize(att.size)"
        >
          <template #append>
            <v-btn
              icon="mdi-download"
              size="small"
              variant="text"
              @click="handleDownload(att)"
            />
            <v-btn
              icon="mdi-delete"
              size="small"
              variant="text"
              color="error"
              :loading="deletingId === att.id"
              @click="handleDeleteAttachment(att)"
            />
          </template>
        </v-list-item>
        <v-list-item
          v-for="(file, index) in pendingFiles"
          :key="`pending-${index}`"
          :title="file.name"
          :subtitle="`${formatSize(file.size)} · 待保存后上传`"
        >
          <template #append>
            <v-btn
              icon="mdi-close"
              size="small"
              variant="text"
              @click="removePending(index)"
            />
          </template>
        </v-list-item>
      </v-list>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  listAttachments,
  uploadAttachment,
  downloadAttachment,
  deleteAttachment,
} from '@/api/workflows';
import type { WorkflowAttachment } from '@/types';
import { listProviders } from '@/api/providers';
import MonacoEditor from '@/components/MonacoEditor.vue';

const route = useRoute();
const router = useRouter();
const isEdit = computed(() => !!route.params.id);

const form = ref({ id: '', name: '', rawJson: '', description: '' });
/** 选中的执行提供商实例 ID；null 表示使用全局默认实例 */
const providerId = ref<string | null>(null);
/** 可选执行提供商下拉选项（仅已启用实例） */
const providerOptions = ref<Array<{ title: string; value: string }>>([]);
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

// 附件状态：attachments 为服务端已有附件，pendingFiles 为新建模式下待保存后上传的文件
const attachments = ref<WorkflowAttachment[]>([]);
const pendingFiles = ref<File[]>([]);
const uploading = ref(false);
const deletingId = ref<number | null>(null);
/** 文件选择控件引用（用于选择后重置） */
const attachmentInput = ref<{ reset: () => void } | null>(null);

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = 8 + Math.floor(Math.random() * 5); // 8, 9, 10, 11, 12
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  form.value.id = result;
}

function handleFileUpload(files: File | File[]) {
  const file = Array.isArray(files) ? files[0] : files;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    form.value.rawJson = reader.result as string;
  };
  reader.readAsText(file);
}

/**
 * 格式化工作流 JSON（缩进美化）；JSON 无效时保持原样并通过 snackbar 提示
 */
function formatRawJson(): void {
  try {
    form.value.rawJson = JSON.stringify(JSON.parse(form.value.rawJson), null, 2);
  } catch {
    snackbar.value = { show: true, text: 'JSON 格式不正确，无法格式化', color: 'error' };
  }
}

/**
 * 加载已启用的执行提供商列表，填充下拉选项；失败时清空选项
 */
async function loadProviders(): Promise<void> {
  try {
    const list = await listProviders();
    // 仅展示已启用实例，与后端 enabled 门控的解析逻辑保持一致
    providerOptions.value = list
      .filter((p) => p.enabled)
      .map((p) => ({ title: p.name, value: p.id }));
  } catch {
    providerOptions.value = [];
  }
}

async function handleSave() {
  error.value = '';
  if (!form.value.id || !form.value.name || !form.value.rawJson) {
    error.value = '请填写所有必填字段';
    return;
  }
  saving.value = true;
  try {
    if (isEdit.value) {
      const payload: Partial<{
        id: string;
        name: string;
        rawJson: string;
        description: string;
        providerId: string | null;
      }> = {
        name: form.value.name,
        rawJson: form.value.rawJson,
        description: form.value.description,
        providerId: providerId.value,
      };
      if (form.value.id !== route.params.id) {
        payload.id = form.value.id;
      }
      await updateWorkflow(route.params.id as string, payload);
    } else {
      const created = await createWorkflow({
        ...form.value,
        providerId: providerId.value,
      });
      // 新建后自动上传暂存的附件
      if (pendingFiles.value.length > 0) {
        await uploadAttachments(created.id, pendingFiles.value);
        // 上传完成后清空待保存队列，避免附件重复展示
        pendingFiles.value = [];
      }
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    setTimeout(() => router.push('/admin'), 500);
  } catch {
    error.value = '保存失败，请检查 ID 是否重复';
  } finally {
    saving.value = false;
  }
}

/**
 * 处理附件选择：编辑模式立即上传；新建模式加入待保存队列
 * @param files 选中的文件（单个或数组，可为空）
 */
function onAttachmentsSelected(files: File | File[] | null) {
  const list = files ? (Array.isArray(files) ? files : [files]) : [];
  if (list.length > 0) {
    if (isEdit.value) {
      void uploadAttachments(route.params.id as string, list);
    } else {
      pendingFiles.value.push(...list);
    }
  }
  // 重置文件选择控件，允许再次选择同一文件
  attachmentInput.value?.reset();
}

/**
 * 逐个上传附件到指定工作流
 * @param workflowId 工作流 ID
 * @param files 待上传文件列表
 */
async function uploadAttachments(workflowId: string, files: File[]) {
  uploading.value = true;
  try {
    for (const file of files) {
      const att = await uploadAttachment(workflowId, file);
      attachments.value.push(att);
    }
    snackbar.value = { show: true, text: `已上传 ${files.length} 个附件`, color: 'success' };
  } catch {
    snackbar.value = { show: true, text: '附件上传失败', color: 'error' };
  } finally {
    uploading.value = false;
  }
}

/**
 * 加载已有附件（编辑模式）
 */
async function loadAttachments() {
  if (!isEdit.value) return;
  try {
    attachments.value = await listAttachments(route.params.id as string);
  } catch {
    snackbar.value = { show: true, text: '附件加载失败', color: 'error' };
  }
}

/**
 * 下载附件
 * @param att 附件记录
 */
function handleDownload(att: WorkflowAttachment) {
  downloadAttachment(route.params.id as string, att).catch(() => {
    snackbar.value = { show: true, text: '附件下载失败', color: 'error' };
  });
}

/**
 * 删除附件
 * @param att 附件记录
 */
async function handleDeleteAttachment(att: WorkflowAttachment) {
  deletingId.value = att.id;
  try {
    await deleteAttachment(route.params.id as string, att.id);
    attachments.value = attachments.value.filter((a) => a.id !== att.id);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  } finally {
    deletingId.value = null;
  }
}

/**
 * 移除待保存队列中的文件
 * @param index 队列下标
 */
function removePending(index: number) {
  pendingFiles.value.splice(index, 1);
}

/**
 * 格式化文件大小
 * @param bytes 字节数
 * @returns 人类可读大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

onMounted(async () => {
  if (isEdit.value) {
    try {
      const wf = await getWorkflow(route.params.id as string);
      form.value = { id: wf.id, name: wf.name, rawJson: wf.rawJson, description: wf.description ?? '' };
      // 回显工作流已指定的执行提供商
      providerId.value = wf.providerId ?? null;
    } catch {
      error.value = '工作流不存在';
    }
  }
  await loadProviders();
  await loadAttachments();
});
</script>

<style scoped>
/* 限制附件选择控件宽度，避免撑开卡片标题栏 */
.attachment-input {
  max-width: 260px;
}
</style>
