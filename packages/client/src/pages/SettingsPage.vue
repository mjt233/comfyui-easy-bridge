<template>
  <v-app-bar>
    <v-app-bar-title>系统设置</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
  </v-app-bar>

  <v-container class="mt-4">
    <v-card>
      <v-card-text>
        <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>

        <v-text-field
          v-model="comfyuiUrl"
          label="ComfyUI 服务地址"
          hint="例如: http://localhost:8188"
          variant="outlined"
          class="mb-4"
          placeholder="http://localhost:8188"
        />

        <v-btn color="primary" :loading="saving" @click="handleSave">保存</v-btn>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getSettings, updateSetting } from '@/api/settings';

const comfyuiUrl = ref('');
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

async function handleSave() {
  saving.value = true;
  error.value = '';
  try {
    await updateSetting('comfyui_base_url', comfyuiUrl.value);
    snackbar.value = { show: true, text: '已保存', color: 'success' };
  } catch {
    error.value = '保存失败';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings();
    comfyuiUrl.value = settings.comfyui_base_url ?? '';
  } catch {
    error.value = '加载设置失败';
  }
});
</script>
