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
          hint="唯一标识，创建后不可修改"
          variant="outlined"
          class="mb-3"
          :disabled="isEdit"
        />
        <v-btn
          v-if="!isEdit"
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

        <v-textarea
          v-model="form.rawJson"
          label="ComfyUI API JSON"
          variant="outlined"
          rows="12"
          class="mb-3"
          :clearable="true"
        />

        <v-file-input
          v-if="!isEdit"
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

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { createWorkflow, getWorkflow, updateWorkflow } from '@/api/workflows';

const route = useRoute();
const router = useRouter();
const isEdit = computed(() => !!route.params.id);

const form = ref({ id: '', name: '', rawJson: '' });
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
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

async function handleSave() {
  error.value = '';
  if (!form.value.id || !form.value.name || !form.value.rawJson) {
    error.value = '请填写所有必填字段';
    return;
  }
  saving.value = true;
  try {
    if (isEdit.value) {
      await updateWorkflow(route.params.id as string, {
        name: form.value.name,
        rawJson: form.value.rawJson,
      });
    } else {
      await createWorkflow(form.value);
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    setTimeout(() => router.push('/admin'), 500);
  } catch {
    error.value = '保存失败，请检查 ID 是否重复';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (isEdit.value) {
    try {
      const wf = await getWorkflow(route.params.id as string);
      form.value = { id: wf.id, name: wf.name, rawJson: wf.rawJson };
    } catch {
      error.value = '工作流不存在';
    }
  }
});
</script>
