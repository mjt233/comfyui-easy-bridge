/**
 * 运行时参数模型（当次执行有效）。
 * 由 DB 静态配置转换而来，或由动态构建脚本声明返回。
 */

import type { CandidateOption } from './param-candidates';

/** 运行时参数声明 */
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
  /** 媒体参数：取 files[alias][fileIndex]，缺省 0（可选以兼容 DB 静态配置行转换） */
  fileIndex?: number;
}

/** 上传文件元数据（脚本构建阶段可见，未上传到 ComfyUI） */
export interface FileMeta {
  /** 用户上传的原始文件名 */
  originalname: string;
  /** MIME 类型 */
  mimetype: string;
  /** 文件字节数 */
  size: number;
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
  /** 候选项列表（仅 text 类型生效，供执行表单下拉选择；label 展示 / value 提交）；缺省/空数组表示未配置 */
  candidates?: CandidateOption[];
  /** 是否多选（仅 text 且配置了候选项时生效）；多选时表单值以英文逗号拼接 */
  multiple?: boolean;
}
