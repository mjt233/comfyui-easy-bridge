export interface Workflow {
  id: string;
  name: string;
  rawJson: string;
  createdAt: string;
  updatedAt: string;
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
}

export interface WorkflowDetail extends Workflow {
  params: WorkflowParam[];
  /** 动态构建脚本源码 */
  buildScript: string;
  /** 是否启用动态构建 */
  buildScriptEnabled: boolean;
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
