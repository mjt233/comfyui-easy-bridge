<template>
  <v-app>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { getAuthStatus } from '@/api/auth';
import { authEnabled } from '@/api/auth-status';

onMounted(async () => {
  try {
    const res = await getAuthStatus();
    authEnabled.value = res.authEnabled;
  } catch {
    authEnabled.value = true;
  }
});
</script>
