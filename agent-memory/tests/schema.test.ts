/**
 * schema 迁移与 v3 新表测试
 *
 * 覆盖两条路径:
 *   1) 全新 DB:initSchema 一步到位创建 v3 所有表
 *   2) 模拟 v2 旧 DB:手建 v2 schema → 跑 initSchema → 断言新列/新表补齐且旧数据完好
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, getSchemaVersion, SCHEMA_VERSION } from '../src/schema.js';
import {
  DEFAULT_CONSTITUTION_VALUES,
  LEGACY_DEFAULT_CONSTITUTION_VALUES_V42,
} from '../src/constitution_defaults.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

test('fresh DB: initSchema creates current schema with all new tables and columns', () => {
  const db = new Database(':memory:');
  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 43);
  assert.ok(tableExists(db, 'deferred_pushes'), 'v42: deferred push mailbox must exist');

  // v25: 深度推理两表;v26: value-guided 选点列;v27: technique(MAP-Elites 分桶);v28: owner_session_id(渠道隔离);v29: no_progress_rounds(卡死计数)
  assert.ok(tableExists(db, 'reasoning_sessions'));
  assert.ok(tableExists(db, 'reasoning_nodes'));
  assert.ok(hasColumn(db, 'reasoning_nodes', 'value'), 'v26: reasoning_nodes 缺 value');
  assert.ok(hasColumn(db, 'reasoning_nodes', 'visits'), 'v26: reasoning_nodes 缺 visits');
  assert.ok(hasColumn(db, 'reasoning_nodes', 'technique'), 'v27: reasoning_nodes 缺 technique');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'owner_session_id'), 'v28: reasoning_sessions 缺 owner_session_id');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'no_progress_rounds'), 'v29: reasoning_sessions 缺 no_progress_rounds');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'auto_advance'), 'v30: reasoning_sessions 缺 auto_advance');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'mode'), 'v31: reasoning_sessions 缺 mode');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'phase'), 'v32: reasoning_sessions 缺 phase');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'diverge_idle_rounds'), 'v32: reasoning_sessions 缺 diverge_idle_rounds');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'rounds_run'), 'v34: reasoning_sessions 缺 rounds_run');
  assert.ok(hasColumn(db, 'reasoning_nodes', 'settle_basis'), 'v32: reasoning_nodes 缺 settle_basis');

  // v8: 全局时间线 session 行('global')由 initSchema 自动建,作为
  // K0 时间线 bookkeeping 的占位
  const globalRow = db
    .prepare(`SELECT id FROM memory_raw_sessions WHERE id = 'global' LIMIT 1`)
    .get() as { id: string } | undefined;
  assert.ok(globalRow, "v8 应该自动创建 'global' session 行");

  // v7: pursuit 表及声明式 drive 支持
  assert.ok(tableExists(db, 'memory_pursuits'));
  assert.ok(tableExists(db, 'memory_drive_configs'));
  assert.ok(tableExists(db, 'memory_drive_outcomes'));
  // v7: 六张 self 域老表都补了 root_pursuit_id 冗余列
  for (const t of [
    'memory_facts',
    'memory_notes',
    'memory_skills',
    'memory_schedules',
    'memory_calendar',
    'memory_access_log',
  ]) {
    assert.ok(hasColumn(db, t, 'root_pursuit_id'), `${t} 缺 root_pursuit_id`);
  }

  // v4: memory_schedules.created_by
  assert.ok(hasColumn(db, 'memory_schedules', 'created_by'), 'memory_schedules 缺 created_by');

  // v5: memory_skills.kind (positive/negative 极性)
  assert.ok(hasColumn(db, 'memory_skills', 'kind'), 'memory_skills 缺 kind');

  // v6: memory_raw_messages_fts (消息全文索引)
  assert.ok(tableExists(db, 'memory_raw_messages_fts'), '缺 memory_raw_messages_fts');

  // 新表存在
  assert.ok(tableExists(db, 'memory_calendar'));
  assert.ok(tableExists(db, 'memory_schedules'));
  assert.ok(tableExists(db, 'memory_access_log'));

  // memory_facts 时间列
  for (const col of [
    'occurred_at',
    'valid_from',
    'valid_until',
    'last_accessed_at',
    'decay_tau_days',
    'forgotten_at',
    'fact_kind',
  ]) {
    assert.ok(hasColumn(db, 'memory_facts', col), `memory_facts 缺列 ${col}`);
  }

  // memory_notes 新列
  for (const col of ['last_accessed_at', 'forgotten_at']) {
    assert.ok(hasColumn(db, 'memory_notes', col), `memory_notes 缺列 ${col}`);
  }

  // memory_skills 反馈环列
  for (const col of ['success_count', 'failure_count', 'last_failure_at']) {
    assert.ok(hasColumn(db, 'memory_skills', col), `memory_skills 缺列 ${col}`);
  }
  // v33 (H2): callable-recipe columns
  for (const col of ['verification', 'tool_policy']) {
    assert.ok(hasColumn(db, 'memory_skills', col), `memory_skills 缺列 ${col}`);
  }
  // v35 (H3): skill self-repair revision history
  assert.ok(hasColumn(db, 'memory_skills', 'revision_history'), 'memory_skills 缺列 revision_history');

  // memory_actions 回链列
  assert.ok(hasColumn(db, 'memory_actions', 'linked_skill'));

  // v12: routing_rules 表
  assert.ok(tableExists(db, 'routing_rules'));

  // v13: K8 主动性层
  assert.ok(tableExists(db, 'memory_initiatives'));
  assert.ok(tableExists(db, 'autonomous_budget'));
  for (const col of [
    'kind', 'driver', 'target_ref', 'rationale', 'utility', 'status',
    'budget_estimate', 'budget_actual', 'outcome_summary', 'outcome_refs',
    'error', 'created_at', 'started_at', 'completed_at',
  ]) {
    assert.ok(hasColumn(db, 'memory_initiatives', col), `memory_initiatives 缺 ${col}`);
  }
  for (const col of ['user_id', 'date', 'llm_tokens_used', 'tool_calls_used', 'initiatives_run']) {
    assert.ok(hasColumn(db, 'autonomous_budget', col), `autonomous_budget 缺 ${col}`);
  }

  // v14: 主动推送订阅
  assert.ok(tableExists(db, 'push_subscriptions'));
  for (const col of [
    'channel', 'peer', 'enabled',
    'quiet_start_hour', 'quiet_end_hour', 'timezone',
    'digest_min_interval_ms', 'urgent_min_interval_ms',
    'last_digest_at', 'last_urgent_at',
    'created_at', 'updated_at',
  ]) {
    assert.ok(hasColumn(db, 'push_subscriptions', col), `push_subscriptions 缺 ${col}`);
  }
});

test('migration v2 → v3: preserves data, adds missing columns and tables', () => {
  const db = new Database(':memory:');

  // 手建 v2 schema 的子集(facts / notes / skills / actions / meta)
  db.exec(`
    CREATE TABLE memory_facts (
      id            TEXT PRIMARY KEY,
      namespace     TEXT NOT NULL,
      key           TEXT NOT NULL,
      value_json    TEXT NOT NULL,
      confidence    REAL NOT NULL DEFAULT 1.0,
      superseded_by TEXT,
      supersedes    TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE memory_notes (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_skills (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      description      TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      action_template  TEXT NOT NULL,
      use_count        INTEGER NOT NULL DEFAULT 0,
      last_used_at     INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE memory_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      trigger     TEXT,
      tool_name   TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result      TEXT,
      success     INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '2');
  `);

  // 写入 v2 旧数据
  db.prepare(
    `INSERT INTO memory_facts (id, namespace, key, value_json, created_at)
     VALUES ('f1', 'user', 'name', '"张三"', 1000)`
  ).run();
  db.prepare(
    `INSERT INTO memory_notes (id, content, created_at)
     VALUES ('n1', '一条旧笔记', 1000)`
  ).run();
  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, created_at)
     VALUES ('s1', 'skill-x', '测试', '[]', 'template', 1000)`
  ).run();

  // 跑迁移
  initSchema(db);

  // 版本已升级
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);

  // 旧数据保留
  const fact = db
    .prepare(`SELECT * FROM memory_facts WHERE id = ?`)
    .get('f1') as {
    namespace: string;
    value_json: string;
    fact_kind: string;
    occurred_at: number | null;
  };
  assert.equal(fact.namespace, 'user');
  assert.equal(fact.value_json, '"张三"');
  // 新列存在且为默认值
  assert.equal(fact.fact_kind, 'state');
  assert.equal(fact.occurred_at, null);

  const note = db
    .prepare(`SELECT * FROM memory_notes WHERE id = ?`)
    .get('n1') as { content: string; forgotten_at: number | null };
  assert.equal(note.content, '一条旧笔记');
  assert.equal(note.forgotten_at, null);

  const skill = db
    .prepare(`SELECT * FROM memory_skills WHERE id = ?`)
    .get('s1') as {
    name: string;
    success_count: number;
    failure_count: number;
    kind: string;
  };
  assert.equal(skill.name, 'skill-x');
  assert.equal(skill.success_count, 0);
  assert.equal(skill.failure_count, 0);
  // v5 迁移: 老 Skill kind 默认 'positive'
  assert.equal(skill.kind, 'positive');

  // 新表已创建
  assert.ok(tableExists(db, 'memory_calendar'));
  assert.ok(tableExists(db, 'memory_schedules'));
  assert.ok(tableExists(db, 'memory_access_log'));
});

test('idempotent: running initSchema twice is safe', () => {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
});

test('migration v4 → v5: existing memory_skills gets kind=positive default', () => {
  const db = new Database(':memory:');

  // 手建 v4 schema 子集(memory_skills 无 kind 列 + meta 写 '4')
  db.exec(`
    CREATE TABLE memory_skills (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      description      TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      action_template  TEXT NOT NULL,
      use_count        INTEGER NOT NULL DEFAULT 0,
      last_used_at     INTEGER,
      created_at       INTEGER NOT NULL,
      success_count    INTEGER NOT NULL DEFAULT 0,
      failure_count    INTEGER NOT NULL DEFAULT 0,
      last_failure_at  INTEGER
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '4');
  `);

  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, created_at)
     VALUES ('sk1', 'legacy-skill', '老技能', '[]', '步骤', 1000)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_skills', 'kind'));

  const row = db
    .prepare(`SELECT kind FROM memory_skills WHERE id = ?`)
    .get('sk1') as { kind: string };
  assert.equal(row.kind, 'positive', '迁移后老 skill kind 必须默认为 positive');
});

test('migration v34 → v35: memory_skills gets revision_history, existing H2 recipe data intact', () => {
  // 用 initSchema 建出完整 v35 schema(比手搭 20 张表更贴近真实用户 DB — 除了这一列,其余都已在 v34 迁移到位),
  // 再退化成"v34 的样子":删掉这一列 + meta 写回 '34'。比手写整份 v34 DDL 更贴近真实升级场景,也更不容易漏表。
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`ALTER TABLE memory_skills DROP COLUMN revision_history;`);
  db.prepare(`UPDATE memory_meta SET value = '34' WHERE key = 'schema_version'`).run();
  assert.ok(!hasColumn(db, 'memory_skills', 'revision_history'), '退化状态应确实没有这一列');

  // 插入一条真实的 H2 callable recipe(verification + tool_policy 都设了),模拟已有用户数据
  db.prepare(
    `INSERT INTO memory_skills
     (id, name, description, trigger_keywords, action_template, created_at, kind, maturity, verification, tool_policy)
     VALUES ('sk-recipe', 'deploy-recipe', 'deploys the thing', '["deploy"]', 'call shell then curl', 1000,
             'positive', 'stable', '{"kind":"tool_result_ok","check":"curl"}', '["shell","curl"]')`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_skills', 'revision_history'), 'v35 迁移后必须补回 revision_history 列');

  const row = db
    .prepare(`SELECT * FROM memory_skills WHERE id = ?`)
    .get('sk-recipe') as Record<string, unknown>;
  // 老数据必须原样保留 — 这是升级路径最容易悄悄丢数据的地方
  assert.equal(row.name, 'deploy-recipe');
  assert.equal(row.maturity, 'stable');
  assert.equal(row.verification, '{"kind":"tool_result_ok","check":"curl"}');
  assert.equal(row.tool_policy, '["shell","curl"]');
  // 新列对已有行必须是 NULL(从未 revise 过),不是 '[]' 或空字符串
  assert.equal(row.revision_history, null, '迁移前已存在的行 revision_history 应为 NULL,不是空数组');
});

test('migration v5 → v6: adds memory_raw_messages_fts and backfills existing messages', () => {
  const db = new Database(':memory:');

  // 手建 v5 schema 子集(raw_* 表但无 FTS + meta 写 '5')
  db.exec(`
    CREATE TABLE memory_raw_sessions (
      id         TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE TABLE memory_raw_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES memory_raw_sessions(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  INTEGER NOT NULL
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '5');
  `);

  db.prepare(`INSERT INTO memory_raw_sessions (id, started_at) VALUES (?, ?)`).run('s1', 1000);
  db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?)`
  ).run('s1', 'user', '讨论数据库迁移的细节', 2000);
  db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?)`
  ).run('s1', 'assistant', '建议先跑 backfill 再切读路径', 3000);

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(tableExists(db, 'memory_raw_messages_fts'), '迁移后应有 FTS 虚拟表');

  // FTS 被回填:能命中"数据库"与"backfill"
  const hitRows = db
    .prepare(
      `SELECT m.content FROM memory_raw_messages m
       JOIN memory_raw_messages_fts fts ON fts.rowid = m.rowid
       WHERE memory_raw_messages_fts MATCH ?`
    )
    .all('数据库') as { content: string }[];
  assert.equal(hitRows.length, 1, 'FTS 迁移回填后应能检索旧消息');
  assert.ok(hitRows[0].content.includes('数据库'));
});

test('memory_calendar requires timezone (NOT NULL)', () => {
  const db = new Database(':memory:');
  initSchema(db);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO memory_calendar (id, title, starts_at, created_at) VALUES (?, ?, ?, ?)`
    ).run('c1', '会议', 1000, 2000);
  }, /NOT NULL/);

  // 正确写入带 timezone
  db.prepare(
    `INSERT INTO memory_calendar (id, title, starts_at, timezone, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('c1', '会议', 1000, 'Asia/Shanghai', 2000);

  const row = db.prepare(`SELECT * FROM memory_calendar WHERE id = ?`).get('c1') as {
    title: string;
    timezone: string;
  };
  assert.equal(row.title, '会议');
  assert.equal(row.timezone, 'Asia/Shanghai');
});

test('memory_schedules: default enabled=1, required next_run_at', () => {
  const db = new Database(':memory:');
  initSchema(db);

  db.prepare(
    `INSERT INTO memory_schedules (id, name, next_run_at, action_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('s1', '每日反思', 9999, 'reflect', '{}', 2000);

  const row = db.prepare(`SELECT * FROM memory_schedules WHERE id = ?`).get('s1') as {
    enabled: number;
    action_type: string;
  };
  assert.equal(row.enabled, 1);
  assert.equal(row.action_type, 'reflect');
});

// v36: offered_count. A pre-v36 DB must gain the column without losing skill rows — the column is what
// lets the draft-cap prune tell "offered and declined" apart from "never offered", so a botched migration
// would silently resume the FIFO conveyor that deleted untried skills for a week.
test('migration v35 → v36: memory_skills gets offered_count, existing skills intact', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`ALTER TABLE memory_skills DROP COLUMN offered_count;`);
  db.prepare(`UPDATE memory_meta SET value = '35' WHERE key = 'schema_version'`).run();
  assert.ok(!hasColumn(db, 'memory_skills', 'offered_count'), 'degraded state must really lack the column');

  db.prepare(
    `INSERT INTO memory_skills
     (id, name, description, trigger_keywords, action_template, created_at, kind, maturity, use_count)
     VALUES ('sk-old', 'pre-v36-skill', 'existed before v36', '["x"]', 'do x', 1000, 'positive', 'draft', 7)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_skills', 'offered_count'), 'v36 must add offered_count');
  const row = db.prepare(`SELECT use_count, offered_count FROM memory_skills WHERE id = 'sk-old'`).get() as
    { use_count: number; offered_count: number };
  assert.equal(row.use_count, 7, 'pre-existing skill data must survive the migration');
  assert.equal(row.offered_count, 0, 'a skill migrated in has no offer history — it backfills to 0, not to its use_count');
});

// v37: reasoning_sessions.followup_asked_at. Persists the followup ask so the ask-once + auto-archive
// lifecycle survives a restart (the in-memory version was cleared on every restart → stale explorations
// re-asked forever, never auto-archived).
test('migration v36 → v37: reasoning_sessions gets followup_asked_at, existing sessions intact', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`ALTER TABLE reasoning_sessions DROP COLUMN followup_asked_at;`);
  db.prepare(`UPDATE memory_meta SET value = '36' WHERE key = 'schema_version'`).run();
  assert.ok(!hasColumn(db, 'reasoning_sessions', 'followup_asked_at'), 'degraded state must really lack the column');

  db.prepare(
    `INSERT INTO reasoning_sessions (id, goal, status, created_at, updated_at)
     VALUES ('rs-old', 'an old exploration', 'active', 1000, 2000)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 43);
  assert.ok(hasColumn(db, 'reasoning_sessions', 'followup_asked_at'), 'v37 must add followup_asked_at');
  const row = db.prepare(`SELECT goal, followup_asked_at FROM reasoning_sessions WHERE id = 'rs-old'`).get() as
    { goal: string; followup_asked_at: number | null };
  assert.equal(row.goal, 'an old exploration', 'pre-existing session survives the migration');
  assert.equal(row.followup_asked_at, null, 'backfills to null — a migrated session was never asked');
});

// v38: reasoning_nodes.check_criterion — what would confirm or refute the node, stated when it is created.
// A tree of nodes with no acceptance criterion cannot produce a signal: hours of work, and nobody can say
// whether anything moved. Backfills to null, which is exactly what "criterion never stated" means.
test('migration v37 → v38: reasoning_nodes gets check_criterion, existing nodes intact', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`ALTER TABLE reasoning_nodes DROP COLUMN check_criterion;`);
  db.prepare(`UPDATE memory_meta SET value = '37' WHERE key = 'schema_version'`).run();
  assert.ok(!hasColumn(db, 'reasoning_nodes', 'check_criterion'), 'degraded state must really lack the column');

  db.prepare(
    `INSERT INTO reasoning_nodes (id, session_id, parent_id, claim, kind, status, depth, created_at, updated_at)
     VALUES ('rn-old', 'rs-1', NULL, 'an old subgoal', 'subgoal', 'open', 0, 1000, 2000)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 43);
  assert.ok(hasColumn(db, 'reasoning_nodes', 'check_criterion'), 'v38 must add check_criterion');
  const row = db.prepare(`SELECT claim, check_criterion FROM reasoning_nodes WHERE id = 'rn-old'`).get() as
    { claim: string; check_criterion: string | null };
  assert.equal(row.claim, 'an old subgoal', 'pre-existing node survives the migration');
  assert.equal(row.check_criterion, null, 'backfills to null — a migrated node never stated one');
});

// v39: memory_skills.from_disk — positive provenance for the reload-prune. Backfills to 0 for every
// existing row on purpose: the next hot-reload re-stamps every real disk skill within seconds, and until
// then nothing is pruned. The failure direction is "briefly keep a stale row", never "delete a real one" —
// which is exactly the bug being fixed (a plan-failure playbook deleted by an unrelated file event).
test('migration v38 → v39: memory_skills gets from_disk, backfilled to 0', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`ALTER TABLE memory_skills DROP COLUMN from_disk;`);
  db.prepare(`UPDATE memory_meta SET value = '38' WHERE key = 'schema_version'`).run();
  assert.ok(!hasColumn(db, 'memory_skills', 'from_disk'), 'degraded state must really lack the column');

  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, source, created_at)
     VALUES ('sk-old', 'playbook-recovery-009c8741-failed', 'a failure lesson', '[]', 'steps', 'auto-recovery:plan-1', 1000)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 43);
  assert.ok(hasColumn(db, 'memory_skills', 'from_disk'), 'v39 must add from_disk');
  const row = db.prepare(`SELECT name, from_disk FROM memory_skills WHERE id = 'sk-old'`).get() as
    { name: string; from_disk: number };
  assert.equal(row.name, 'playbook-recovery-009c8741-failed', 'the pre-existing skill survives');
  assert.equal(row.from_disk, 0, 'and is NOT prunable until the disk importer says otherwise');
});

// v40: memory_raw_messages.origin_session_id — which CONVERSATION a line came from.
//
// session_id has been 'global' on every row ever written, so it could never answer that question. On
// 2026-07-26 a recency filter was written against it, matched nothing, and the agent ran an entire
// evening with a ZERO-message context window. NULL on pre-v40 rows, and every reader must treat NULL as
// "unknown, include it" — starving the window is the failure, not showing one extra line.
test('migration v39 → v40: memory_raw_messages gets origin_session_id, existing rows intact', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(`INSERT INTO memory_raw_sessions (id, started_at) VALUES (?, ?)`).run('global2', 1000);
  db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
  ).run('global2', 'user', 'written before v40', 2000);
  db.prepare(`UPDATE memory_meta SET value = '39' WHERE key = 'schema_version'`).run();

  initSchema(db);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_raw_messages', 'origin_session_id'), 'v40 must add origin_session_id');
  const row = db
    .prepare(`SELECT content, origin_session_id FROM memory_raw_messages WHERE content = ?`)
    .get('written before v40') as { content: string; origin_session_id: string | null };
  assert.equal(row.origin_session_id, null, 'old rows carry no origin — readers must not drop them');
});

// v41: memory_skills.matched_count — of a skill's showings, how many were RELEVANCE matches.
//
// offered_count counts every showing and the cap evicts a draft at three showings with no use. On
// 2026-08-04 that deleted exact-rational-lrc-tightness-verification and three siblings — the skills most
// obviously about the week's work — each "offered 3x, never chosen", and every one of those offers came
// from `relevance=on(matched 0 → global fallback)` on an unrelated turn. Being shown because the ranker
// had nothing is evidence about the TURN, not about the skill.
test('migration v40 → v41: memory_skills gets matched_count, existing rows keep their offers', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, created_at, offered_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('s41', 'written-before-v41', 'd', '[]', 'a', 1000, 7);
  db.prepare(`UPDATE memory_meta SET value = '40' WHERE key = 'schema_version'`).run();

  initSchema(db);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_skills', 'matched_count'), 'v41 must add matched_count');
  const row = db
    .prepare(`SELECT offered_count, matched_count FROM memory_skills WHERE name = ?`)
    .get('written-before-v41') as { offered_count: number; matched_count: number };
  assert.equal(row.offered_count, 7, 'the offer history survives the migration');
  assert.equal(row.matched_count, 0, 'no pre-v41 showing can be claimed as a relevance match');
});

test('migration v41 → v42: creates the durable deferred-push mailbox', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.exec(`DROP TABLE deferred_pushes`);
  db.prepare(`UPDATE memory_meta SET value = '41' WHERE key = 'schema_version'`).run();

  initSchema(db);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(tableExists(db, 'deferred_pushes'));
});

test('migration v42 → v43: updates an untouched factory identity', () => {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(`UPDATE memory_pursuits SET constitution_values=? WHERE id='default'`)
    .run(LEGACY_DEFAULT_CONSTITUTION_VALUES_V42);
  db.prepare(`UPDATE memory_meta SET value = '42' WHERE key = 'schema_version'`).run();

  initSchema(db);
  const row = db.prepare(`SELECT constitution_values, intent FROM memory_pursuits WHERE id='default'`)
    .get() as { constitution_values: string; intent: string };
  assert.equal(row.constitution_values, DEFAULT_CONSTITUTION_VALUES);
  assert.match(row.constitution_values, /Learn and evolve from actual outcomes/);
  assert.equal(row.intent, 'build a grounded understanding of one owner and advance their directions');
});

test('migration v42 → v43: never overwrites an owner-authored constitution', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const ownerAuthored = 'I chose this constitution explicitly.';
  db.prepare(`UPDATE memory_pursuits SET constitution_values=?, intent=? WHERE id='default'`)
    .run(ownerAuthored, 'my explicitly chosen root intent');
  db.prepare(`UPDATE memory_meta SET value = '42' WHERE key = 'schema_version'`).run();

  initSchema(db);
  const row = db.prepare(`SELECT constitution_values, intent FROM memory_pursuits WHERE id='default'`)
    .get() as { constitution_values: string; intent: string };
  assert.equal(row.constitution_values, ownerAuthored);
  assert.equal(row.intent, 'my explicitly chosen root intent');
});
