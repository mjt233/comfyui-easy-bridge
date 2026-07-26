<template>
  <v-container class="fill-height login-wrapper" fluid pa-0>
    <!-- Decorative background shapes -->
    <div class="bg-shapes">
      <div class="shape shape-1" />
      <div class="shape shape-2" />
      <div class="shape shape-3" />
    </div>

    <v-row class="fill-height align-center justify-center ma-0">
      <v-col
        cols="12"
        sm="8"
        md="5"
        lg="4"
      >
        <v-fade-transition appear>
          <v-card
            class="login-card pa-6"
            elevation="12"
            rounded="xl"
          >
            <!-- Logo / Icon -->
            <div class="text-center mb-2">
              <v-avatar
                color="primary"
                size="72"
                class="mb-3 logo-avatar elevation-6"
              >
                <v-icon size="36" color="white">
                  mdi-palette-swatch
                </v-icon>
              </v-avatar>
              <h1 class="text-h5 font-weight-bold mb-1">
                ComfyUI Easy Bridge
              </h1>
              <p class="text-body-2 text-medium-emphasis">
                管理员登录
              </p>
            </div>

            <v-divider class="my-4" />

            <v-card-text class="pa-0">
              <!-- Error alert -->
              <v-alert
                v-if="error"
                type="error"
                closable
                variant="tonal"
                class="mb-4"
                density="compact"
                @click:close="error = ''"
              >
                <template #prepend>
                  <v-icon icon="mdi-alert-circle-outline" />
                </template>
                {{ error }}
              </v-alert>

              <!-- Password field -->
              <v-text-field
                v-model="password"
                label="密码"
                type="password"
                variant="outlined"
                prepend-inner-icon="mdi-lock-outline"
                :disabled="loading"
                :error="!!error"
                hide-details="auto"
                class="mb-2"
                @keyup.enter="handleLogin"
              />

              <!-- Hint -->
              <p class="text-caption text-medium-emphasis mb-2">
                请输入管理员密码以继续
              </p>
            </v-card-text>

            <v-card-actions class="pa-0 mt-2">
              <v-btn
                color="primary"
                size="large"
                block
                rounded="lg"
                :loading="loading"
                @click="handleLogin"
              >
                <template #prepend>
                  <v-icon>mdi-login</v-icon>
                </template>
                登 录
              </v-btn>
            </v-card-actions>

            <!-- Footer -->
            <div class="text-center mt-4">
              <p class="text-caption text-disabled">
                ComfyUI Easy Bridge v1.0
              </p>
            </div>
          </v-card>
        </v-fade-transition>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '@/api/auth';

const router = useRouter();
const password = ref('');
const error = ref('');
const loading = ref(false);

// Hide scrollbar on this page (login is full-screen, no scrolling needed)
onMounted(() => {
  document.documentElement.style.overflow = 'hidden';
});
onUnmounted(() => {
  document.documentElement.style.overflow = '';
});

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
.login-wrapper {
  height: 100vh;
  max-height: 100vh;
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #1a237e 0%, #283593 25%, #1565c0 50%, #42a5f5 100%);
}

/* Decorative floating shapes */
.bg-shapes {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.shape {
  position: absolute;
  border-radius: 50%;
  opacity: 0.08;
  background: white;
}

.shape-1 {
  width: 600px;
  height: 600px;
  top: -200px;
  right: -150px;
  animation: float 20s ease-in-out infinite;
}

.shape-2 {
  width: 400px;
  height: 400px;
  bottom: -100px;
  left: -100px;
  animation: float 25s ease-in-out infinite reverse;
}

.shape-3 {
  width: 200px;
  height: 200px;
  top: 40%;
  left: 10%;
  animation: float 15s ease-in-out infinite 5s;
}

@keyframes float {
  0%, 100% {
    transform: translate(0, 0) scale(1);
  }
  33% {
    transform: translate(30px, -30px) scale(1.05);
  }
  66% {
    transform: translate(-20px, 20px) scale(0.95);
  }
}

/* Card styling */
.login-card {
  backdrop-filter: blur(20px);
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.logo-avatar {
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.logo-avatar:hover {
  transform: scale(1.08);
}
</style>
