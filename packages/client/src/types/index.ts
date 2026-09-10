/** 执行提供商类型 */
export type ProviderType = 'comfyui' | 'runninghub';

/**
 * 提供商配置（按类型区分的判别联合）。
 * - comfyui: { baseUrl, autoCleanup?, inputDir? }
 *   - autoCleanup: 是否在任务终态后自动清理本次上传的资产文件（默认 false）
 *   - inputDir: ComfyUI 输入目录的本地文件系统路径（仅同机部署有效；为空时无法清理）
 * - runninghub: { apiKey, gpuSize }
 */
export type ProviderConfigInput =
  | { baseUrl: string; autoCleanup?: boolean; inputDir?: string }
  | { apiKey: string; gpuSize: '24G' | '48G' };

/**
 * 提供商实例摘要（API 返回；runninghub 的 apiKey 已打码）
 */
export interface ProviderSummary {
  /** 实例 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 配置（apiKey 已打码） */
  config: ProviderConfigInput;
  /** 并发上限 */
  concurrency: number;
  /** 是否启用 */
  enabled: boolean;
  /** 解析后的执行地址 */
  resolvedBaseUrl: string;
  /** 任务跟踪模式 */
  trackingMode: 'websocket' | 'polling';
}

/**
 * 工作流解析后的提供商摘要（详情响应中返回；未解析到可用实例时为 null）
 */
export interface ResolvedProvider {
  /** 实例 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 解析后的执行地址 */
  resolvedBaseUrl: string;
}

export interface Workflow {
  id: string;
  name: string;
  rawJson: string;
  /** 备注说明（Markdown 格式）；空串表示未填写 */
  description: string;
  /** 指定的执行提供商实例 ID；null 表示使用全局默认实例 */
  providerId: string | null;
  /** 工作流标签（嵌套分组结构） */
  tags: WorkflowTagGroup[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 候选项结构（label 展示用；value 提交用）
 */
export interface CandidateOption {
  /** 展示名（空时回退为 value） */
  label: string;
  /** 提交值（非空；多选拼接时使用） */
  value: string;
}

/**
 * 工作流参数配置
 */
export interface WorkflowParam {
  /** 参数行 ID */
  id: number;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 字段名 */
  fieldName: string;
  /** 对外别名；null 表示仅默认值覆盖 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
  /** 候选项列表（仅 text 类型生效，供执行表单下拉选择；label 展示 / value 提交）；空数组表示未配置 */
  candidates: CandidateOption[];
  /** 是否多选（仅 text 且配置了候选项时生效）；多选时值（value）以英文逗号拼接 */
  multiple: boolean;
  /** rawJson 中该字段的原始值（字符串化）；无对应字段时为 null */
  nodeRawValue: string | null;
}

export interface WorkflowDetail extends Workflow {
  params: WorkflowParam[];
  /** 动态构建脚本源码 */
  buildScript: string;
  /** 是否启用动态构建 */
  buildScriptEnabled: boolean;
  /** 动态字段静态声明（仅用于执行表单与 API 文档） */
  declaredParams: DeclaredParam[];
  /** 解析后的执行提供商摘要；未解析到可用实例时为 null */
  resolvedProvider: ResolvedProvider | null;
}

/**
 * 动态字段静态声明（工作流配置中手动声明）。
 * 仅用于【执行工作流】表单构建与【API 调用说明】示例生成，不参与脚本参数注入。
 */
export interface DeclaredParam {
  /** 对外参数别名（必填，工作流内唯一） */
  alias: string;
  /** 展示标签；可空 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 表单默认值（文本/数字/布尔）；媒体字段无默认值 */
  defaultValue: string | null;
  /** 候选项列表（仅 text 类型生效；label 展示 / value 提交）；空数组/缺省表示未配置 */
  candidates?: CandidateOption[];
  /** 是否多选（仅 text 且有候选项时生效）；多选时值（value）以英文逗号拼接 */
  multiple?: boolean;
}

/**
 * 工作流附件记录
 */
export interface WorkflowAttachment {
  /** 附件行 ID */
  id: number;
  /** 所属工作流 ID */
  workflowId: string;
  /** 用户上传的原始文件名 */
  filename: string;
  /** 服务端磁盘存储名 */
  storedName: string;
  /** 文件字节数 */
  size: number;
  /** MIME 类型；可空 */
  mimetype: string | null;
  /** 创建时间 */
  createdAt: string;
}

/**
 * 批量导入结果摘要
 */
export interface ImportResult {
  /** 成功导入的工作流数量 */
  imported: number;
  /** 因 ID 冲突被改名的工作流映射 */
  renamed: Array<{ old: string; new: string }>;
  /** 导入失败的工作流 */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * 批量删除工作流结果摘要（部分成功语义）
 */
export interface BatchDeleteResult {
  /** 实际删除成功的工作流 ID */
  deleted: string[];
  /** 请求中不存在（或已被并发删除）的工作流 ID */
  missing: string[];
}

export interface Settings {
  [key: string]: string;
}

/**
 * 运行时参数声明（脚本声明返回）
 */
export interface RuntimeParam {
  /** 节点 ID */
  nodeId: string;
  /** 节点 inputs 字段名 */
  fieldName: string;
  /** 对外别名；null 表示不暴露为可传参字段 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
  /** 媒体参数：取 files[alias][fileIndex]，缺省 0 */
  fileIndex?: number;
}

/**
 * 模拟构建结果
 */
export interface SimulateResult {
  /** 构建并应用参数后的最终工作流 JSON 字符串 */
  json: string;
  /** 脚本声明的有效参数配置 */
  params: RuntimeParam[];
}

/**
 * 节点输入字段速查条目
 */
export interface ComfyNodeField {
  /** 字段名 */
  name: string;
  /** ComfyUI 类型名：INT/FLOAT/STRING/COMBO/IMAGE/... */
  type: string;
  /** COMBO 可选值（如有） */
  options?: string[];
}

/**
 * ComfyUI 节点速查条目（构建脚本编辑器节点速查表用）
 */
export interface ComfyNodeReference {
  /** 类名（class_type） */
  name: string;
  /** 展示名 */
  display_name: string;
  /** 分类 */
  category: string | null;
  /** 必填输入 */
  required_inputs: ComfyNodeField[];
  /** 可选输入 */
  optional_inputs: ComfyNodeField[];
  /** 输出类型列表 */
  outputs: string[];
  /** 输出名列表 */
  output_names: string[];
}

/** 标签元数据字段类型 */
export type TagMetadataFieldType = 'number' | 'string' | 'boolean';

/** 标签元数据字段定义 */
export interface TagMetadataFieldDef {
  /** 字段键，如 "maxImageCount" */
  key: string;
  /** 显示名，如 "图片数量" */
  label: string;
  /** 字段类型 */
  type: TagMetadataFieldType;
  /** 默认值 */
  defaultValue: number | string | boolean;
}

/** 标签元数据值 */
export type TagMetadataValues = Record<string, number | string | boolean>;

/** 工作流打标签的输入项 */
export interface WorkflowTagInput {
  /** 标签 ID */
  tagId: string;
  /** 用户配置的元数据原始值（可选；缺省空对象） */
  metadataValues?: TagMetadataValues;
}

/** 标签树节点（/api/tags 响应） */
export interface TagTreeNode {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 父标签 ID；null=顶层 */
  parentId: string | null;
  /** 是否预设只读 */
  isPreset: number;
  /** 元数据字段定义 */
  metadataDef: TagMetadataFieldDef[];
  /** 子标签 */
  children: TagTreeNode[];
}

/** 工作流标签分组中的子标签节点 */
export interface WorkflowTagNode {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 合并默认值后的完整元数据 */
  metadata: TagMetadataValues;
  /** 用户原始配置值 */
  configuredMetadata: TagMetadataValues;
}

/** 工作流标签分组（父标签） */
export interface WorkflowTagGroup {
  /** 父标签 ID */
  id: string;
  /** 父标签显示名 */
  name: string;
  /** 合并默认值后的完整元数据（父标签自身的元数据；无定义时空对象） */
  metadata: TagMetadataValues;
  /** 用户原始配置值（父标签自身的元数据；未配置时空对象） */
  configuredMetadata: TagMetadataValues;
  /** 该父标签下被选中的子标签 */
  tags: WorkflowTagNode[];
}
