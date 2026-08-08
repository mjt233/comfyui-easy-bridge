<template>
  <v-app-bar color="primary">
    <v-app-bar-title>系统设置</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">
      返回
    </v-btn>
  </v-app-bar>

  <v-container>
    <!-- 常规设置卡片：仅保留输出下载方式（ComfyUI 地址/并发已迁移到执行提供商） -->
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

        <v-radio-group
          v-model="downloadMode"
          label="输出文件下载方式"
          class="mb-4"
        >
          <v-radio label="通过桥接服务代理下载（推荐）" value="proxy" />
          <v-radio label="直连 ComfyUI 下载" value="direct" />
        </v-radio-group>

        <v-btn color="primary" :loading="saving" @click="handleSave">
          保存
        </v-btn>
      </v-card-text>
    </v-card>

    <!-- 执行提供商卡片：实例列表 + 全局默认选择 + 新建/编辑弹窗 -->
    <v-card class="mb-4">
      <v-card-title>执行提供商</v-card-title>
      <v-card-text>
        <v-alert
          v-if="providerError"
          type="error"
          closable
          class="mb-4"
          @click:close="providerError = ''"
        >
          {{ providerError }}
        </v-alert>

        <v-alert
          v-if="providers.length === 0"
          type="info"
          class="mb-4"
        >
          尚未配置任何执行提供商，请先新建一个。
        </v-alert>

        <v-select
          v-model="defaultProviderId"
          :items="providers.map((p) => ({ title: p.name, value: p.id }))"
          label="全局默认提供商实例"
          hint="所有未指定提供商的工作流将使用此实例执行"
          persistent-hint
          variant="outlined"
          class="mb-4"
          clearable
          @update:model-value="handleDefaultChange"
        />

        <v-btn
          color="primary"
          prepend-icon="mdi-plus"
          @click="openCreateDialog"
        >
          新建提供商
        </v-btn>

        <v-list v-if="providers.length > 0" class="mt-4">
          <v-list-item
            v-for="p in providers"
            :key="p.id"
            :title="p.name"
            :subtitle="providerSubtitle(p)"
            :prepend-icon="p.type === 'runninghub' ? 'mdi-cloud' : 'mdi-server'"
          >
            <template #append>
              <v-btn
                size="small"
                variant="text"
                :loading="testingId === p.id"
                @click="handleTest(p)"
              >
                测试
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                @click="openEditDialog(p)"
              >
                编辑
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                color="error"
                @click="handleDelete(p)"
              >
                删除
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>

    <!-- 提供商新建/编辑弹窗 -->
    <v-dialog v-model="providerDialog.show" max-width="520">
      <v-card>
        <v-card-title>{{ providerDialog.isEdit ? '编辑提供商' : '新建提供商' }}</v-card-title>
        <v-card-text>
          <v-alert
            v-if="providerTestResult"
            :type="providerTestResult.ok ? 'success' : 'error'"
            class="mb-4"
          >
            {{ providerTestResult.message }}
          </v-alert>

          <v-text-field
            v-model="providerForm.name"
            label="名称"
            variant="outlined"
            class="mb-4"
          />

          <v-select
            v-model="providerForm.type"
            :items="[
              { title: 'ComfyUI 原生', value: 'comfyui' },
              { title: 'RunningHub', value: 'runninghub' },
            ]"
            label="提供商类型"
            variant="outlined"
            class="mb-4"
          />

          <!-- comfyui 类型：仅需服务地址 -->
          <template v-if="providerForm.type === 'comfyui'">
            <v-text-field
              v-model="providerForm.baseUrl"
              label="服务地址"
              hint="例如: http://localhost:8188"
              variant="outlined"
              class="mb-4"
              placeholder="http://localhost:8188"
            />
          </template>

          <!-- runninghub 类型：API Key + GPU 显存档位 -->
          <template v-else>
            <v-text-field
              v-model="providerForm.apiKey"
              label="API Key"
              variant="outlined"
              class="mb-4"
              :hint="providerDialog.isEdit ? '编辑时留空表示不修改，沿用原 Key' : undefined"
            />
            <v-radio-group
              v-model="providerForm.gpuSize"
              label="GPU 显存"
              class="mb-4"
            >
              <v-radio label="24G" value="24G" />
              <v-radio label="48G" value="48G" />
            </v-radio-group>
          </template>

          <v-text-field
            v-model.number="providerForm.concurrency"
            label="并发上限"
            type="number"
            min="1"
            variant="outlined"
            class="mb-4"
          />

          <v-switch
            v-model="providerForm.enabled"
            label="启用"
            color="primary"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="providerDialog.show = false">
            取消
          </v-btn>
          <v-btn :loading="testing" @click="handleDialogTest">
            测试连接
          </v-btn>
          <v-btn color="primary" :loading="savingProvider" @click="handleSaveProvider">
            保存
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProviderById,
  testProviderConfig,
  updateProvider,
  type ProviderCreateInput,
  type TestConnectionResult,
} from '@/api/providers';
import type { ProviderConfigInput, ProviderSummary, ProviderType } from '@/types';

/** 输出文件下载方式 */
const downloadMode = ref('proxy');
/** 是否启用身份验证（本地镜像，与全局 authEnabled 同步） */
const authEnabledLocal = ref(true);
/** 常规设置区错误提示 */
const error = ref('');
/** 常规设置是否保存中 */
const saving = ref(false);
/** 顶部提示条 */
const snackbar = ref({ show: false, text: '', color: 'success' });

/** 执行提供商实例列表 */
const providers = ref<ProviderSummary[]>([]);
/** 全局默认提供商实例 ID（null 表示未设置） */
const defaultProviderId = ref<string | null>(null);
/** 执行提供商区错误提示 */
const providerError = ref('');
/** 提供商编辑弹窗状态 */
const providerDialog = ref<{
  /** 是否显示弹窗 */
  show: boolean;
  /** 是否为编辑模式 */
  isEdit: boolean;
  /** 编辑中的实例 ID */
  id: string;
  /** 编辑前的实例摘要（用于判断字段是否被改动，避免打码值回写） */
  original: ProviderSummary | null;
}>({ show: false, isEdit: false, id: '', original: null });
/** 提供商表单模型 */
const providerForm = ref<{
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** comfyui 服务地址 */
  baseUrl: string;
  /** runninghub API Key */
  apiKey: string;
  /** runninghub GPU 显存档位 */
  gpuSize: '24G' | '48G';
  /** 并发上限 */
  concurrency: number;
  /** 是否启用 */
  enabled: boolean;
}>({
  name: '',
  type: 'comfyui',
  baseUrl: '',
  apiKey: '',
  gpuSize: '24G',
  concurrency: 1,
  enabled: true,
});
/** 弹窗内测试连接结果 */
const providerTestResult = ref<TestConnectionResult | null>(null);
/** 弹窗内是否测试中 */
const testing = ref(false);
/** 列表中正在测试的实例 ID */
const testingId = ref('');
/** 提供商是否保存中 */
const savingProvider = ref(false);

/**
 * 保存常规设置（输出下载方式）。
 */
async function handleSave() {
  saving.value = true;
  error.value = '';
  try {
    await updateSetting('output_download_mode', downloadMode.value);
    snackbar.value = { show: true, text: '已保存', color: 'success' };
  } catch {
    error.value = '保存失败';
  } finally {
    saving.value = false;
  }
}

/**
 * 切换身份验证开关。
 * @param val 开关目标值（null 忽略）
 */
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

/**
 * 加载执行提供商列表与全局默认实例设置。
 */
async function loadProviders() {
  try {
    // 并行拉取实例列表与设置（default_provider_id 在其中）
    const [list, settings] = await Promise.all([listProviders(), getSettings()]);
    providers.value = list;
    // 空串（未设置）归一化为 null，保证本地状态一致
    defaultProviderId.value = settings.default_provider_id || null;
  } catch {
    providerError.value = '加载执行提供商失败';
  }
}

/**
 * 打开新建提供商弹窗（重置表单）。
 */
function openCreateDialog() {
  providerDialog.value = { show: true, isEdit: false, id: '', original: null };
  providerForm.value = {
    name: '',
    type: 'comfyui',
    baseUrl: '',
    apiKey: '',
    gpuSize: '24G',
    concurrency: 1,
    enabled: true,
  };
  providerTestResult.value = null;
  providerError.value = '';
}

/**
 * 打开编辑提供商弹窗（用摘要预填表单；config 为判别联合，需用 in 收窄读取）。
 * @param p 待编辑的实例摘要
 */
function openEditDialog(p: ProviderSummary) {
  const config = p.config;
  // 防御式读取：配置可能缺失字段（服务端 config 损坏时为空对象）
  const baseUrl = 'baseUrl' in config ? config.baseUrl : '';
  const gpuSize = 'gpuSize' in config ? config.gpuSize : '24G';
  // API Key 不回显：编辑时始终留空，留空表示不修改（沿用原 Key）
  const apiKey = '';
  providerDialog.value = { show: true, isEdit: true, id: p.id, original: p };
  providerForm.value = {
    name: p.name,
    type: p.type,
    baseUrl,
    apiKey,
    gpuSize,
    concurrency: p.concurrency,
    enabled: p.enabled,
  };
  providerTestResult.value = null;
  providerError.value = '';
}

/**
 * 生成实例列表子标题：类型 + 解析地址/GPU 档位 + 并发 + 启用状态。
 * @param p 提供商实例摘要
 * @returns 子标题文本
 */
function providerSubtitle(p: ProviderSummary): string {
  const typeLabel = p.type === 'runninghub' ? 'RunningHub' : 'ComfyUI 原生';
  let detail = p.resolvedBaseUrl || '';
  const config = p.config;
  // config 为判别联合，用 in 收窄；缺失字段时回退解析地址
  if ('gpuSize' in config) {
    detail = config.gpuSize;
  } else if ('baseUrl' in config) {
    detail = config.baseUrl;
  }
  const status = p.enabled ? '已启用' : '已停用';
  return `${typeLabel} · ${detail} · 并发 ${p.concurrency} · ${status}`;
}

/**
 * 依据表单类型构建配置载荷。
 * @returns 按类型区分的配置对象
 */
function buildConfigPayload(): ProviderConfigInput {
  if (providerForm.value.type === 'runninghub') {
    return { apiKey: providerForm.value.apiKey.trim(), gpuSize: providerForm.value.gpuSize };
  }
  return { baseUrl: providerForm.value.baseUrl.trim() };
}

/**
 * 判断 runninghub 编辑时 API Key 是否被用户修改。
 * 编辑弹窗中 API Key 始终留空不回显：留空视为未修改（沿用原 Key），
 * 输入非空值视为修改为新 Key。
 * @returns 是否修改
 */
function apiKeyChanged(): boolean {
  return providerForm.value.apiKey.trim() !== '';
}

/**
 * 判断编辑模式下 GPU 显存档位是否被修改。
 * 仅 runninghub 且原配置包含 gpuSize 时比较，否则视为未修改。
 * @returns 是否修改
 */
function gpuSizeChanged(): boolean {
  const original = providerDialog.value.original;
  if (!original || original.type !== 'runninghub') return false;
  return 'gpuSize' in original.config && providerForm.value.gpuSize !== original.config.gpuSize;
}

/**
 * 弹窗内测试当前表单配置的连通性（测试失败不阻止保存）。
 * 编辑 runninghub 且 API Key 留空（未修改）时，改用真实存储的 Key 测试。
 */
async function handleDialogTest() {
  // 基础校验：缺必填字段时给出即时提示
  // 编辑且原类型为 runninghub 时，API Key 留空视为沿用原 Key（走已保存实例测试）
  const isEdit = providerDialog.value.isEdit;
  const isRunningHubKeepKey = isEdit
    && providerForm.value.type === 'runninghub'
    && providerDialog.value.original?.type === 'runninghub'
    && !apiKeyChanged();
  // 新建或从其他类型切换为 runninghub 时，必须填写 API Key
  if (providerForm.value.type === 'runninghub' && !isRunningHubKeepKey && !providerForm.value.apiKey.trim()) {
    providerTestResult.value = { ok: false, message: '请先填写 API Key' };
    return;
  }
  if (providerForm.value.type === 'comfyui' && !providerForm.value.baseUrl.trim()) {
    providerTestResult.value = { ok: false, message: '请先填写服务地址' };
    return;
  }
  testing.value = true;
  providerTestResult.value = null;
  try {
    // 编辑模式 + runninghub + API Key 留空（未修改）时，
    // 用真实存储的 Key 测试，避免将空 Key 作为配置提交
    if (isRunningHubKeepKey) {
      providerTestResult.value = await testProviderById(providerDialog.value.id);
    } else {
      providerTestResult.value = await testProviderConfig(providerForm.value.type, buildConfigPayload());
    }
  } catch {
    providerTestResult.value = { ok: false, message: '测试连接失败' };
  } finally {
    testing.value = false;
  }
}

/**
 * 保存提供商实例（新建或更新）。
 * 首个实例创建成功后自动设为全局默认。
 */
async function handleSaveProvider() {
  // 客户端预校验：必填字段缺失时给出明确提示
  if (providerForm.value.name.trim() === '') {
    providerError.value = '名称不能为空';
    return;
  }
  if (providerForm.value.type === 'comfyui' && providerForm.value.baseUrl.trim() === '') {
    providerError.value = '请填写 ComfyUI 服务地址';
    return;
  }
  // runninghub API Key 校验：新建或从其他类型切换为 runninghub 时必须填写；
  // 编辑且原类型为 runninghub 时留空表示不修改（沿用原 Key）
  const isEditMode = providerDialog.value.isEdit;
  const isRunningHubKeepKey = isEditMode
    && providerForm.value.type === 'runninghub'
    && providerDialog.value.original?.type === 'runninghub'
    && providerForm.value.apiKey.trim() === '';
  if (
    providerForm.value.type === 'runninghub'
    && !isRunningHubKeepKey
    && providerForm.value.apiKey.trim() === ''
  ) {
    providerError.value = '请填写 RunningHub API Key';
    return;
  }
  const name = providerForm.value.name.trim();
  // 并发数兜底为 1
  const concurrency = Number(providerForm.value.concurrency) || 1;
  savingProvider.value = true;
  providerError.value = '';
  try {
    if (providerDialog.value.isEdit) {
      const id = providerDialog.value.id;
      const original = providerDialog.value.original;
      // 类型是否被切换（切换时必须同时回传 type 与新的 config）
      const typeChanged = original ? providerForm.value.type !== original.type : true;
      // GPU 显存修改需要重新输入 API Key：留空无法回传 config（空 Key 非法），只能整段提交
      if (!typeChanged && gpuSizeChanged() && !apiKeyChanged()) {
        providerError.value = '修改 GPU 显存需重新输入 API Key 才能生效';
        return;
      }
      // 部分更新：name/concurrency/enabled 始终回传
      const payload: Partial<ProviderCreateInput> = {
        name,
        concurrency,
        enabled: providerForm.value.enabled,
      };
      if (typeChanged) payload.type = providerForm.value.type;
      // 仅在这些情况回传 config：
      // - comfyui：baseUrl 未打码，始终回传
      // - 类型切换：需要新格式的配置
      // - runninghub 且用户输入了新 API Key（留空时省略 config，保留服务端真实 key）
      if (typeChanged || providerForm.value.type === 'comfyui' || apiKeyChanged()) {
        payload.config = buildConfigPayload();
      }
      await updateProvider(id, payload);
      snackbar.value = { show: true, text: '提供商已更新', color: 'success' };
    } else {
      const created = await createProvider({
        name,
        type: providerForm.value.type,
        config: buildConfigPayload(),
        concurrency,
        enabled: providerForm.value.enabled,
      });
      snackbar.value = { show: true, text: '提供商已创建', color: 'success' };
      // 首个实例创建后自动设为全局默认
      if (providers.value.length === 0) {
        await updateSetting('default_provider_id', created.id);
        defaultProviderId.value = created.id;
      }
    }
    providerDialog.value.show = false;
    await loadProviders();
  } catch {
    providerError.value = '保存提供商失败';
  } finally {
    savingProvider.value = false;
  }
}

/**
 * 切换全局默认提供商实例。
 * @param val 新的默认实例 ID（清空时为 null）
 */
async function handleDefaultChange(val: string | null) {
  const prev = defaultProviderId.value;
  // 清空选择时持久化空串，服务端以空串视为未设置默认提供商
  const next = val ?? '';
  try {
    await updateSetting('default_provider_id', next);
    defaultProviderId.value = next;
    snackbar.value = { show: true, text: '默认提供商已更新', color: 'success' };
  } catch {
    // 失败时回滚本地选择，避免与持久化状态不一致
    defaultProviderId.value = prev;
    providerError.value = '设置默认提供商失败';
  }
}

/**
 * 测试列表中的已保存实例连通性。
 * @param p 实例摘要
 */
async function handleTest(p: ProviderSummary) {
  testingId.value = p.id;
  try {
    const result = await testProviderById(p.id);
    snackbar.value = { show: true, text: result.message, color: result.ok ? 'success' : 'error' };
  } catch {
    snackbar.value = { show: true, text: '测试连接失败', color: 'error' };
  } finally {
    testingId.value = '';
  }
}

/**
 * 删除提供商实例（需确认）；默认实例会被后端拒绝删除。
 * @param p 实例摘要
 */
async function handleDelete(p: ProviderSummary) {
  if (!window.confirm(`确定删除提供商「${p.name}」吗？`)) return;
  try {
    await deleteProvider(p.id);
    // 若删除的是本地记录的默认实例，清空本地默认
    if (defaultProviderId.value === p.id) {
      defaultProviderId.value = null;
    }
    snackbar.value = { show: true, text: '提供商已删除', color: 'success' };
    await loadProviders();
  } catch {
    providerError.value = '删除失败：默认实例不可删除或网络错误';
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings();
    downloadMode.value = settings.output_download_mode ?? 'proxy';
  } catch {
    error.value = '加载设置失败';
  }

  try {
    const status = await getAuthStatus();
    authEnabledLocal.value = status.authEnabled;
  } catch {
    // 保持默认值
  }

  // 加载执行提供商列表与默认实例
  await loadProviders();
});
</script>
