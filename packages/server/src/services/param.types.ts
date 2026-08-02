/**
 * 运行时参数模型（当次执行有效）。
 * 由 DB 静态配置转换而来，或由动态构建脚本声明返回。
 */

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
