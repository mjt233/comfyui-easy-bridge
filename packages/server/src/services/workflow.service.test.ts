import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from './workflow.service';

describe('WorkflowService', () => {
  let service: WorkflowService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        alias TEXT,
        label TEXT,
        param_type TEXT NOT NULL DEFAULT 'text',
        default_value TEXT,
        candidates TEXT NOT NULL DEFAULT '[]',
        multiple INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workflow_id, alias)
      );
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, is_preset INTEGER NOT NULL DEFAULT 0, metadata_def TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_tags (workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, metadata_values TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (workflow_id, tag_id));
    `);
    const db = drizzle(sqlite, { schema });
    service = new WorkflowService(db);
  });

  it('creates and retrieves a workflow', () => {
    const wf = service.create({ id: 'my-flow', name: 'Test Flow', rawJson: '{}' });
    expect(wf.id).toBe('my-flow');
    expect(wf.name).toBe('Test Flow');

    const retrieved = service.getById('my-flow');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Flow');
  });

  it('lists all workflows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    const list = service.list();
    expect(list).toHaveLength(2);
  });

  it('returns null for non-existent workflow', () => {
    expect(service.getById('nonexistent')).toBeNull();
  });

  it('updates a workflow', () => {
    service.create({ id: 'wf', name: 'Original', rawJson: '{}' });
    service.update('wf', { name: 'Updated' });
    const wf = service.getById('wf');
    expect(wf!.name).toBe('Updated');
  });

  it('deletes a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.delete('wf');
    expect(service.getById('wf')).toBeNull();
  });

  it('adds and lists params for a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '30:19',
      fieldName: 'value',
      alias: 'img_desc',
    });
    expect(param.alias).toBe('img_desc');

    const params = service.getParams('wf');
    expect(params).toHaveLength(1);
    expect(params[0].alias).toBe('img_desc');
  });

  it('deletes params when workflow is deleted', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.delete('wf');
    const params = service.getParams('wf');
    expect(params).toHaveLength(0);
  });

  it('throws on duplicate alias within same workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'dup' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'v', alias: 'dup' })).toThrow();
  });

  it('allows same alias across different workflows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    service.addParam({ workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: 'shared' });
    expect(() => service.addParam({ workflowId: 'wf2', nodeId: '1', fieldName: 'v', alias: 'shared' })).not.toThrow();
  });

  it('deletes a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.deleteParam(p.id);
    expect(service.getParams('wf')).toHaveLength(0);
  });

  it('updates a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    const updated = service.updateParam(p.id, { alias: 'b', label: '标签' });
    expect(updated.alias).toBe('b');
    expect(updated.label).toBe('标签');
  });

  it('updates workflow ID with cascade to params', () => {
    service.create({ id: 'old-id', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'old-id', nodeId: '1', fieldName: 'v', alias: 'a' });

    service.update('old-id', { id: 'new-id' });

    // 新 ID 可查询
    const wf = service.getById('new-id');
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe('WF');

    // 旧 ID 不可查询
    expect(service.getById('old-id')).toBeNull();

    // 参数的 workflowId 已级联更新
    const params = service.getParams('new-id');
    expect(params).toHaveLength(1);
    expect(params[0].workflowId).toBe('new-id');
  });

  it('throws when updating to an existing ID', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });

    expect(() => service.update('wf1', { id: 'wf2' })).toThrow();
  });

  it('updates name and rawJson without changing ID', () => {
    service.create({ id: 'test', name: 'Old', rawJson: '{"a":1}' });
    service.update('test', { name: 'New Name', rawJson: '{"b":2}' });

    const wf = service.getById('test');
    expect(wf!.name).toBe('New Name');
    expect(wf!.rawJson).toBe('{"b":2}');
  });

  it('creates workflow with description and updates it', () => {
    service.create({ id: 'desc-flow', name: 'Desc', rawJson: '{}', description: '## 说明\n正文' });
    expect(service.getById('desc-flow')!.description).toBe('## 说明\n正文');

    service.update('desc-flow', { description: '新说明' });
    expect(service.getById('desc-flow')!.description).toBe('新说明');
  });

  it('keeps description when renaming workflow ID', () => {
    service.create({ id: 'old-id', name: 'Old', rawJson: '{}', description: '保留说明' });
    service.update('old-id', { id: 'new-id' });
    expect(service.getById('new-id')!.description).toBe('保留说明');
  });

  it('updates ID along with name', () => {
    service.create({ id: 'old', name: 'Old Name', rawJson: '{}' });
    service.update('old', { id: 'new', name: 'New Name' });

    expect(service.getById('old')).toBeNull();
    const wf = service.getById('new');
    expect(wf!.name).toBe('New Name');
  });

  it('cascades ID update to task_logs', () => {
    service.create({ id: 'old-id', name: 'WF', rawJson: '{}' });
    // 直接插入 task_log 记录（模拟执行过的任务）
    const now = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO task_logs (id, workflow_id, workflow_name, alias_values, comfyui_url, status, created_at)
      VALUES ('log-1', 'old-id', 'WF', '{}', 'http://localhost:8188', 'completed', '${now}')
    `);

    service.update('old-id', { id: 'new-id' });

    // 验证 task_log 的 workflow_id 已级联更新
    const rows = sqlite.prepare('SELECT workflow_id FROM task_logs WHERE id = ?').all('log-1') as { workflow_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_id).toBe('new-id');
  });

  it('adds param with only defaultValue and null alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: 'hello',
    });
    expect(param.alias).toBeNull();
    expect(param.defaultValue).toBe('hello');
    expect(param.paramType).toBe('text');
  });

  it('allows multiple null aliases in same workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'a', defaultValue: '1' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'b', defaultValue: '2' })).not.toThrow();
  });

  it('throws when both alias and defaultValue are empty', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    expect(() => service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
    })).toThrow(/alias|defaultValue|required/i);
  });

  it('forces media paramType to text when alias is null', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: 'x',
      paramType: 'image',
    });
    expect(param.paramType).toBe('text');
  });

  it('allows boolean paramType without alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: 'true',
      paramType: 'boolean',
    });
    expect(param.paramType).toBe('boolean');
    expect(param.alias).toBeNull();
  });

  it('allows number paramType without alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: '1.5',
      paramType: 'number',
    });
    expect(param.paramType).toBe('number');
  });

  it('clears defaultValue to null on update', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'a',
      defaultValue: 'old',
    });
    const updated = service.updateParam(p.id, { defaultValue: null });
    expect(updated.defaultValue).toBeNull();
  });

  it('throws when update removes both alias and defaultValue', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'a',
      defaultValue: 'x',
    });
    expect(() => service.updateParam(p.id, { alias: null, defaultValue: null })).toThrow(/alias|defaultValue|required/i);
  });

  it('updateBuildScript saves script and enabled flag', () => {
    service.create({ id: 'wf-build', name: 'Build', rawJson: '{}' });

    const updated = service.updateBuildScript('wf-build', { script: 'export default function build(ctx) { return ctx.workflow; }', enabled: true });

    expect(updated?.buildScript).toContain('export default');
    expect(updated?.buildScriptEnabled).toBe(1);

    const disabled = service.updateBuildScript('wf-build', { script: '', enabled: false });
    expect(disabled?.buildScript).toBe('');
    expect(disabled?.buildScriptEnabled).toBe(0);
  });

  it('update with id rename preserves build script columns', () => {
    service.create({ id: 'wf-old', name: 'Old', rawJson: '{}' });
    service.updateBuildScript('wf-old', { script: '// keep me', enabled: true });

    const renamed = service.update('wf-old', { id: 'wf-new' });

    expect(renamed?.id).toBe('wf-new');
    expect(renamed?.buildScript).toBe('// keep me');
    expect(renamed?.buildScriptEnabled).toBe(1);
  });

  it('getDeclaredParams returns empty array when none configured', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    expect(service.getDeclaredParams('wf')).toEqual([]);
    expect(service.getDeclaredParams('nonexistent')).toEqual([]);
  });

  it('updateDeclaredParams saves and loads declarations', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const list = [
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
      { alias: 'steps', label: '步数', paramType: 'number', defaultValue: '20' },
    ];

    const updated = service.updateDeclaredParams('wf', list);

    expect(updated?.declaredParams).toBe(JSON.stringify(list));
    // 读取时规范化补齐 candidates/multiple（无候选 → 空数组 + 单选）
    expect(service.getDeclaredParams('wf')).toEqual(
      list.map((item) => ({ ...item, candidates: [], multiple: false })),
    );
  });

  it('getDeclaredParams tolerates corrupt or non-array JSON', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    // 直接写入损坏 JSON
    sqlite.exec("UPDATE workflows SET declared_params = '{oops' WHERE id = 'wf'");
    expect(service.getDeclaredParams('wf')).toEqual([]);

    sqlite.exec("UPDATE workflows SET declared_params = '{\"a\":1}' WHERE id = 'wf'");
    expect(service.getDeclaredParams('wf')).toEqual([]);

    // 混入非法条目时仅保留合法条目（并规范化补齐 candidates/multiple）
    sqlite.exec("UPDATE workflows SET declared_params = '[{\"alias\":\"ok\",\"paramType\":\"text\"},{\"alias\":\"\"}]' WHERE id = 'wf'");
    expect(service.getDeclaredParams('wf')).toEqual([
      { alias: 'ok', paramType: 'text', candidates: [], multiple: false },
    ]);
  });

  it('update with id rename preserves declared params', () => {
    service.create({ id: 'wf-old', name: 'Old', rawJson: '{}' });
    service.updateDeclaredParams('wf-old', [{ alias: 'a', label: null, paramType: 'text', defaultValue: null }]);

    const renamed = service.update('wf-old', { id: 'wf-new' });

    expect(renamed?.id).toBe('wf-new');
    expect(service.getDeclaredParams('wf-new')).toEqual([
      { alias: 'a', label: null, paramType: 'text', defaultValue: null, candidates: [], multiple: false },
    ]);
  });

  it('getParamsWithRawValue attaches nodeRawValue from rawJson', () => {
    // rawJson 中字段 seed=1、steps=20
    service.create({
      id: 'raw-flow',
      name: 'Raw',
      rawJson: JSON.stringify({ '1': { inputs: { seed: 1, steps: 20 }, class_type: 'KSampler' } }),
    });
    service.addParam({ workflowId: 'raw-flow', nodeId: '1', fieldName: 'seed', alias: 'seed', defaultValue: null });
    // 即使配置了覆盖值，nodeRawValue 仍取 rawJson 原值
    service.addParam({ workflowId: 'raw-flow', nodeId: '1', fieldName: 'steps', alias: null, defaultValue: '30' });

    const params = service.getParamsWithRawValue('raw-flow');
    expect(params.find((p) => p.fieldName === 'seed')?.nodeRawValue).toBe('1');
    expect(params.find((p) => p.fieldName === 'steps')?.nodeRawValue).toBe('20');
  });

  it('getParamsWithRawValue returns null when field missing or rawJson corrupt', () => {
    service.create({ id: 'raw-flow2', name: 'Raw2', rawJson: 'not-json' });
    service.addParam({ workflowId: 'raw-flow2', nodeId: '1', fieldName: 'missing', alias: 'x', defaultValue: null });

    const params = service.getParamsWithRawValue('raw-flow2');
    // 损坏 rawJson 解析失败 → nodeRawValue 为 null
    expect(params[0].nodeRawValue).toBeNull();
  });

  it('addParam stores candidates and multiple for text type', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'style',
      candidates: [
        { label: '写实', value: 'realism' },
        { label: '动漫', value: 'anime' },
        { label: '水墨', value: 'ink' },
      ],
      multiple: true,
    });
    // 候选项以 {label,value} 结构化 JSON 数组落库；多选落 1
    expect(param.candidates).toBe(JSON.stringify([
      { label: '写实', value: 'realism' },
      { label: '动漫', value: 'anime' },
      { label: '水墨', value: 'ink' },
    ]));
    expect(param.multiple).toBe(1);
  });

  it('addParam clears candidates for non-text type', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'count',
      paramType: 'number',
      candidates: [{ label: '1', value: '1' }, { label: '2', value: '2' }],
      multiple: true,
    });
    // 仅 text 类型支持候选项，number 强制清空并回退单选
    expect(param.candidates).toBe('[]');
    expect(param.multiple).toBe(0);
  });

  it('addParam forces single select when candidates empty', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'style',
      candidates: [],
      multiple: true,
    });
    // 无候选项时多选无意义，强制单选
    expect(param.multiple).toBe(0);
  });

  it('updateParam merges candidates and clears them on type switch', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'style',
      candidates: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      multiple: false,
    });
    // 更新候选项并开启多选
    const updated = service.updateParam(p.id, {
      candidates: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      multiple: true,
    });
    expect(updated.candidates).toBe(JSON.stringify([
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
      { label: 'C', value: 'c' },
    ]));
    expect(updated.multiple).toBe(1);

    // 未传 candidates 时保持原值
    const kept = service.updateParam(p.id, { label: '风格' });
    expect(kept.candidates).toBe(JSON.stringify([
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
      { label: 'C', value: 'c' },
    ]));
    expect(kept.multiple).toBe(1);

    // 切换为非 text 类型后候选项清空、回退单选
    const switched = service.updateParam(p.id, { paramType: 'image' });
    expect(switched.candidates).toBe('[]');
    expect(switched.multiple).toBe(0);
  });

  it('getDeclaredParams normalizes candidates on read', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    // 直接写入带候选项的声明 JSON：含重复 value、无候选多选、旧版字符串项、非法项等脏数据
    sqlite.exec(
      "UPDATE workflows SET declared_params = '["
      + '{"alias":"style","label":null,"paramType":"text","defaultValue":null,'
      + '"candidates":[{"label":"A","value":"a"},{"label":"A2","value":"a"},{"label":"B","value":"b"}],"multiple":true},'
      + '{"alias":"count","label":null,"paramType":"number","defaultValue":null,'
      + '"candidates":[{"label":"1","value":"1"}],"multiple":true},'
      + '{"alias":"dirty","label":null,"paramType":"text","defaultValue":null,'
      + '"candidates":["ok",1,{"label":"写意","value":"xieyi"},{"label":"跳过","value":""}]}'
      + "]' WHERE id = 'wf'",
    );
    const list = service.getDeclaredParams('wf');
    // text 候选按 value 去重保留；number 候选清空；旧版字符串项按 label=value 兼容、非法/空 value 项跳过；
    // multiple 仅 text 且有候选时为 true
    expect(list[0]).toEqual({
      alias: 'style', label: null, paramType: 'text', defaultValue: null,
      candidates: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], multiple: true,
    });
    expect(list[1]).toEqual({
      alias: 'count', label: null, paramType: 'number', defaultValue: null,
      candidates: [], multiple: false,
    });
    expect(list[2]).toEqual({
      alias: 'dirty', label: null, paramType: 'text', defaultValue: null,
      candidates: [{ label: 'ok', value: 'ok' }, { label: '写意', value: 'xieyi' }], multiple: false,
    });
  });

  it('deleteMany removes existing workflows and reports missing ids', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    service.create({ id: 'wf3', name: 'WF3', rawJson: '{}' });

    // wf2 不存在 + 重复的 wf1：去重后按首次出现顺序划分 deleted / missing
    const result = service.deleteMany(['wf1', 'gone', 'wf1', 'wf3']);

    expect(result.deleted).toEqual(['wf1', 'wf3']);
    expect(result.missing).toEqual(['gone']);
    expect(service.getById('wf1')).toBeNull();
    expect(service.getById('wf3')).toBeNull();
    // 未在入参中的工作流不受影响
    expect(service.getById('wf2')).not.toBeNull();
  });

  it('deleteMany cascades params and tags rows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    service.addParam({ workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: 'a1' });
    service.addParam({ workflowId: 'wf2', nodeId: '1', fieldName: 'v', alias: 'a2' });
    // 直接写入关联行，避免依赖标签服务（仅验证 FK 级联清理）
    sqlite.exec(
      "INSERT INTO tags (id, name, parent_id, is_preset, metadata_def, created_at, updated_at) VALUES ('t1', '标签', NULL, 0, '[]', '2026', '2026');"
      + "INSERT INTO workflow_tags (workflow_id, tag_id, metadata_values) VALUES ('wf1', 't1', '{}');",
    );

    service.deleteMany(['wf1']);

    expect(service.getParams('wf1')).toHaveLength(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM workflow_tags WHERE workflow_id = ?').get('wf1')).toEqual({ c: 0 });
    // 其他工作流的数据保持完整
    expect(service.getParams('wf2')).toHaveLength(1);
  });

  it('deleteMany with empty input returns empty result', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    expect(service.deleteMany([])).toEqual({ deleted: [], missing: [] });
    // 空输入不触发删除
    expect(service.getById('wf1')).not.toBeNull();
  });

  it('deleteMany reports all ids as missing when none exist', () => {
    const result = service.deleteMany(['nope1', 'nope2']);
    expect(result.deleted).toEqual([]);
    expect(result.missing).toEqual(['nope1', 'nope2']);
  });
});
