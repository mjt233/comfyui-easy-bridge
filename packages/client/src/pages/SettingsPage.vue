<template>
  <v-app-bar color="primary">
    <v-app-bar-title>系统设置</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">
      返回
    </v-btn>
  </v-app-bar>

  <v-container>
    <v-card class="mb-4">
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
          v-model="comfyuiUrl"
          label="ComfyUI 服务地址"
          hint="例如: http://localhost:8188"
          variant="outlined"
          class="mb-4"
          placeholder="http://localhost:8188"
        />

        <v-text-field
          v-model="concurrency"
          label="ComfyUI 任务执行并发数"
          type="number"
          min="1"
          variant="outlined"
          class="mb-4"
        />

        <v-btn color="primary" :loading="saving" @click="handleSave">
          保存
        </v-btn>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-title>安全设置</v-card-title>
      <v-card-text>
        <v-switch
          v-model="authEnabledLocal"
          label="需要身份验证"
          hint="关闭后所有页面和接口无需登录即可访问"
          persistent-hint
          color="primary"
          @update:model-value="handleAuthToggle"
        />
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getSettings, updateSetting } from '@/api/settings';
import { getAuthStatus } from '@/api/auth';
import { authEnabled } from '@/api/auth-status';

const comfyuiUrl = ref('');
const concurrency = ref('1');
const authEnabledLocal = ref(true);
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

async function handleSave() {
  saving.value = true;
  error.value = '';
  try {
    await updateSetting('comfyui_base_url', comfyuiUrl.value);
    await updateSetting('comfyui_concurrency', concurrency.value);
    snackbar.value = { show: true, text: '已保存', color: 'success' };
  } catch {
    error.value = '保存失败';
  } finally {
    saving.value = false;
  }
}

async function handleAuthToggle(val: boolean | null) {
  if (val === null) return;
  try {
    await updateSetting('auth_enabled', val ? '1' : '0');
    authEnabled.value = val;
    snackbar.value = { show: true, text: val ? '身份验证已开启' : '身份验证已关闭', color: 'success' };
  } catch {
    error.value = '保存身份验证设置失败';
    authEnabledLocal.value = !val;
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings();
    comfyuiUrl.value = settings.comfyui_base_url ?? '';
    concurrency.value = settings.comfyui_concurrency ?? '1';
  } catch {
    error.value = '加载设置失败';
  }

  try {
    const status = await getAuthStatus();
    authEnabledLocal.value = status.authEnabled;
  } catch {
    // keep default
  }
});
</script>
