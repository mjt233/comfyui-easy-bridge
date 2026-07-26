<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card width="400" class="pa-4">
      <v-card-title class="text-h5 text-center">ComfyUI Easy Bridge</v-card-title>
      <v-card-subtitle class="text-center mb-4">管理员登录</v-card-subtitle>
      <v-card-text>
        <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>
        <v-text-field
          v-model="password"
          label="密码"
          type="password"
          variant="outlined"
          @keyup.enter="handleLogin"
          :disabled="loading"
        />
      </v-card-text>
      <v-card-actions class="justify-center pb-4">
        <v-btn
          color="primary"
          size="large"
          :loading="loading"
          @click="handleLogin"
        >登录</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '@/api/auth';

const router = useRouter();
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
  if (!password.value) {
    error.value = '请输入密码';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const res = await login(password.value);
    localStorage.setItem('token', res.token);
    router.push('/admin');
  } catch {
    error.value = '密码错误';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.fill-height {
  min-height: 100vh;
}
</style>
