/** 标签元数据字段类型 */
export type TagMetadataFieldType = 'number' | 'string' | 'boolean';

/** 标签元数据字段定义（metadataDef 数组元素） */
export interface TagMetadataFieldDef {
  /** 字段键，如 "maxImageCount" */
  key: string;
  /** 显示名，如 "图片数量" */
  label: string;
  /** 字段类型 */
  type: TagMetadataFieldType;
  /** 默认值（类型与 type 匹配） */
  defaultValue: number | string | boolean;
}

/** 标签元数据值（工作流配置的原始值 / 合并默认值后的完整值） */
export type TagMetadataValues = Record<string, number | string | boolean>;

/** 工作流打标签的输入项 */
export interface WorkflowTagInput {
  /** 标签 ID */
  tagId: string;
  /** 用户配置的元数据原始值（可选；缺省空对象） */
  metadataValues?: TagMetadataValues;
}
