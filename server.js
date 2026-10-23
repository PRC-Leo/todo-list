// ============================================================
// Todo List 后端服务
// 使用 Express 框架 + MariaDB 数据库连接池
// ============================================================

const express = require("express");
const mariadb = require("mariadb");
const config = require("./config/config.js");
const operationLog = require("./operation-log.js");
const passwordHashStore = require("./password-hash.js");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const geoip = require("geoip-lite");

// ------------------------------------------------------------
// 1. 创建 Express 应用实例
// ------------------------------------------------------------
const app = express();

// ------------------------------------------------------------
// 2. 中间件配置
// ------------------------------------------------------------
// 解析 JSON 格式的请求体
app.use(express.json({ limit: "1mb" }));
// 解析 URL 编码的请求体（表单数据）
app.use(express.urlencoded({ extended: true }));

// 请求体不是合法 JSON 时按 400 格式错误处理，而不是 500
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "请求体不是合法 JSON" });
  }
  next(err);
});

// ------------------------------------------------------------
// 3. 创建 MariaDB 数据库连接池
// ------------------------------------------------------------
const pool = mariadb.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  acquireTimeout: config.db.acquireTimeout,
});

// 数据表名（统一引用，便于改名）
const TABLE = config.db.table;

// 登录认证相关配置（表名、会话 Cookie、有效期）
const AUTH = config.auth || {};
const USERS_TABLE = AUTH.usersTable || "users";
const SESSIONS_TABLE = AUTH.sessionsTable || "sessions";
const LOGIN_HISTORY_TABLE = AUTH.loginHistoryTable || "todo_login_history";
const SESSION_COOKIE = AUTH.cookieName || "sid";
const SESSION_DAYS = AUTH.sessionDays || 7;
const AUTH_LOCATION_LOOKUP = AUTH.locationLookup !== false;
const AVATAR_MAX_BYTES = AUTH.avatarMaxBytes || 512 * 1024;

const AUTH_ERROR_MESSAGE = "账号或密码错误";
const AUTH_UNAUTHORIZED_MESSAGE = "未登录";
const TIMEZONE_OFFSET_HOURS = config.timezoneOffsetHours === undefined ? 8 : config.timezoneOffsetHours;
const LOGGING = config.logging || {};
const LOG_TABLE = LOGGING.table || "operation_logs";

// ------------------------------------------------------------
// 4. 初始化数据库 —— 自动创建 todos 数据表（如果不存在）
// ------------------------------------------------------------
async function initDatabase() {
  let conn;
  try {
    conn = await pool.getConnection();

    // 创建 todos 表的 SQL 语句（如果表已存在则跳过）
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id          INT AUTO_INCREMENT PRIMARY KEY COMMENT '任务ID，自增主键',
        title       VARCHAR(255)  NOT NULL    COMMENT '任务标题',
        description TEXT          NULL        COMMENT '具体事项描述',
        category    VARCHAR(100)  NULL        COMMENT '分类名称',
        color       VARCHAR(7)    NULL        COMMENT '分组颜色，十六进制色值如 #FF6B6B',
        completed   BOOLEAN       DEFAULT FALSE COMMENT '是否已完成',
        created_at  DATETIME      NOT NULL    COMMENT '创建时间',
        updated_at  DATETIME      NOT NULL    COMMENT '最后更新时间'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='待办任务表';
    `;

    await conn.query(createTableSQL);
    console.log(`✅ 数据表 ${TABLE} 已就绪（${config.db.database}.${TABLE}）。`);

    // 创建 users 表（登录用户，只保存账号与密码哈希）
    const createUsersTableSQL = `
      CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
        id            INT AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID，自增主键',
        account       VARCHAR(64) NOT NULL UNIQUE COMMENT '规范化账号',
        password_hash VARCHAR(128) NOT NULL COMMENT '后端二次哈希 v2:+SHA-256(account:clientHash)',
        display_name  VARCHAR(50) NULL COMMENT '展示名称',
        avatar_data   MEDIUMTEXT NULL COMMENT '用户头像（压缩后的 data URL）',
        is_active     BOOLEAN DEFAULT TRUE COMMENT '账号是否启用',
        \`level\`     ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别',
        created_at    DATETIME NOT NULL COMMENT '创建时间（UTC+8）',
        updated_at    DATETIME NOT NULL COMMENT '更新时间（UTC+8）',
        last_login_at DATETIME NULL COMMENT '最近登录时间（UTC+8）'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录用户表';
    `;
    await conn.query(createUsersTableSQL);
    console.log(`✅ 数据表 ${USERS_TABLE} 已就绪（${config.db.database}.${USERS_TABLE}）。`);

    // 创建 sessions 表（数据库会话，服务重启后登录态不丢失）
    const createSessionsTableSQL = `
      CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
        token          CHAR(64) PRIMARY KEY COMMENT '随机会话令牌',
        user_id        INT NOT NULL COMMENT '关联用户ID',
        device_label   VARCHAR(200) NULL COMMENT '解析后的设备名称',
        user_agent     VARCHAR(500) NULL COMMENT '原始 User-Agent',
        ip_address     VARCHAR(64) NULL COMMENT '登录IP',
        location       VARCHAR(200) NULL COMMENT 'IP定位',
        created_at     DATETIME NOT NULL COMMENT '会话创建时间（UTC+8）',
        expires_at     DATETIME NOT NULL COMMENT '会话过期时间（UTC+8）',
        last_active_at DATETIME NULL COMMENT '最近活跃时间（UTC+8）',
        INDEX idx_sessions_user_id (user_id),
        INDEX idx_sessions_expires_at (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
          REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录会话表';
    `;
    await conn.query(createSessionsTableSQL);
    console.log(`✅ 数据表 ${SESSIONS_TABLE} 已就绪（${config.db.database}.${SESSIONS_TABLE}）。`);

    // 独立保存成功登录历史，退出登录或会话过期后仍可查询
    const createLoginHistoryTableSQL = `
      CREATE TABLE IF NOT EXISTS ${LOGIN_HISTORY_TABLE} (
        id             BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '登录历史ID',
        user_id        INT NOT NULL COMMENT '关联用户ID',
        account        VARCHAR(64) NOT NULL COMMENT '登录账号',
        session_token  CHAR(64) NULL UNIQUE COMMENT '对应会话令牌（仅用于去重）',
        device_label   VARCHAR(200) NULL COMMENT '解析后的设备名称',
        user_agent     VARCHAR(500) NULL COMMENT '原始 User-Agent',
        ip_address     VARCHAR(64) NULL COMMENT '登录IP',
        location       VARCHAR(200) NULL COMMENT 'IP定位',
        login_at       DATETIME NOT NULL COMMENT '登录时间（UTC+8）',
        INDEX idx_login_history_user (user_id, login_at),
        CONSTRAINT fk_login_history_user FOREIGN KEY (user_id)
          REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='主系统登录历史表';
    `;
    await conn.query(createLoginHistoryTableSQL);
    await conn.query(
      `INSERT IGNORE INTO ${LOGIN_HISTORY_TABLE}
        (user_id, account, session_token, device_label, user_agent, ip_address, location, login_at)
       SELECT s.user_id, u.account, s.token, s.device_label, s.user_agent,
              s.ip_address, s.location, s.created_at
       FROM ${SESSIONS_TABLE} s
       INNER JOIN ${USERS_TABLE} u ON u.id = s.user_id`
    );
    console.log(`✅ 数据表 ${LOGIN_HISTORY_TABLE} 已就绪（${config.db.database}.${LOGIN_HISTORY_TABLE}）。`);
    await ensureAuthSchemaColumns(conn);
    await passwordHashStore.ensurePasswordHashColumn(conn, USERS_TABLE);
    const passwordMigration = await passwordHashStore.migrateLegacyPasswordHashes(conn, USERS_TABLE);
    if (passwordMigration.migrated > 0) {
      console.log(`🔐 数据表 ${USERS_TABLE} 已完成 ${passwordMigration.migrated} 条密码哈希二次加密迁移。`);
    }
    if (passwordMigration.skipped.length > 0) {
      console.warn(`⚠️ 数据表 ${USERS_TABLE} 跳过 ${passwordMigration.skipped.length} 条非标准哈希记录：${passwordMigration.skipped.join("、")}`);
    }

    if (LOGGING.enabled) {
      await operationLog.ensureOperationLogTable(conn, LOG_TABLE);
      console.log(`✅ 操作日志表 ${LOG_TABLE} 已就绪。`);
    }
  } catch (err) {
    console.error("❌ 数据库初始化失败：", err.message);
    console.error("   请确保 MariaDB 服务已启动，且数据库 " + config.db.database + " 已创建。");
  } finally {
    if (conn) conn.release();
  }
}

// 已存在的旧表自动补充管理所需的字段（不破坏既有账号与会话）
async function ensureAuthSchemaColumns(conn) {
  const dbName = config.db.database;
  const userCols = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, USERS_TABLE]
  );
  const userColSet = new Set((userCols || []).map((row) => row.name));
  if (!userColSet.has("level")) {
    try {
      await conn.query(
        `ALTER TABLE ${USERS_TABLE}
         ADD COLUMN \`level\` ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别' AFTER \`is_active\``
      );
      console.log(`⬆️ 数据表 ${USERS_TABLE} 已补充 level 字段。`);
    } catch (err) {
      // 两个服务同时启动时可能已由另一方补列，重复列名可忽略
      if (!err || err.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }
  if (!userColSet.has("avatar_data")) {
    try {
      await conn.query(
        `ALTER TABLE ${USERS_TABLE}
         ADD COLUMN avatar_data MEDIUMTEXT NULL COMMENT '用户头像（压缩后的 data URL）'
         AFTER display_name`
      );
      console.log(`⬆️ 数据表 ${USERS_TABLE} 已补充 avatar_data 字段。`);
    } catch (err) {
      if (!err || err.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }

  const sessionCols = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, SESSIONS_TABLE]
  );
  const sessionColSet = new Set((sessionCols || []).map((row) => row.name));
  const sessionAdds = [
    ["device_label", "VARCHAR(200) NULL COMMENT '解析后的设备名称'"],
    ["user_agent", "VARCHAR(500) NULL COMMENT '原始 User-Agent'"],
    ["ip_address", "VARCHAR(64) NULL COMMENT '登录IP'"],
    ["location", "VARCHAR(200) NULL COMMENT 'IP定位'"],
    ["last_active_at", "DATETIME NULL COMMENT '最近活跃时间（UTC+8）'"],
  ];
  for (const [columnName, definition] of sessionAdds) {
    if (sessionColSet.has(columnName)) continue;
    try {
      await conn.query(
        `ALTER TABLE ${SESSIONS_TABLE} ADD COLUMN ${columnName} ${definition} AFTER expires_at`
      );
      console.log(`⬆️ 数据表 ${SESSIONS_TABLE} 已补充 ${columnName} 字段。`);
    } catch (err) {
      // 两个服务同时启动时可能已由另一方补列，重复列名可忽略
      if (err && err.code === "ER_DUP_FIELDNAME") continue;
      throw err;
    }
  }
}

// ------------------------------------------------------------
// 5. 测试数据库连接（启动时调用）
// ------------------------------------------------------------
async function testDatabaseConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log("✅ 数据库连接成功！MariaDB 连接池已就绪。");
    console.log(`   主机：${config.db.host}:${config.db.port} | 数据库：${config.db.database}`);
  } catch (err) {
    console.error("❌ 数据库连接失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 6. 获取当前 UTC+8 时间的格式化字符串
// ------------------------------------------------------------
function getUTC8Time() {
  const now = new Date();
  // 按配置的时区偏移（小时）计算，默认 UTC+8
  const offsetMs = config.timezoneOffsetHours * 60 * 60 * 1000;
  const utc8 = new Date(now.getTime() + offsetMs);
  // 转换为 MySQL DATETIME 格式：YYYY-MM-DD HH:mm:ss
  return utc8.toISOString().replace("T", " ").substring(0, 19);
}

// 获取当前时间 + N 天后的 UTC+8 格式化字符串（会话过期时间）
function getUTC8TimeAfterDays(days) {
  const offsetMs = config.timezoneOffsetHours * 60 * 60 * 1000;
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + offsetMs);
  return future.toISOString().replace("T", " ").substring(0, 19);
}

// ------------------------------------------------------------
// 7. 写入待办任务到数据库
// ------------------------------------------------------------
async function insertTodo({ title, description, category, color, completed }) {
  let conn;
  try {
    conn = await pool.getConnection();

    const now = getUTC8Time();
    const sql = `
      INSERT INTO ${TABLE} (title, description, category, color, completed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      title,
      description || null,
      category || null,
      color || null,
      completed === true || completed === "true" ? 1 : 0,
      now,
      now,
    ];

    const result = await conn.query(sql, params);
    // result.insertId 是 MariaDB 驱动返回的自增ID（BigInt）
    const insertedId = Number(result.insertId);

    // 查询刚插入的记录，返回完整数据
    const [row] = await conn.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [insertedId]);

    return {
      success: true,
      data: formatTodoRow(row),
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 8. 将数据库行转为前端 JSON 格式
// ------------------------------------------------------------
function formatTodoRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    color: row.color,
    completed: Boolean(row.completed),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  };
}

// ------------------------------------------------------------
// 9. 查询所有待办任务
// ------------------------------------------------------------
async function getAllTodos() {
  let conn;
  try {
    conn = await pool.getConnection();
    // 按创建时间倒序排列，最新的在上面
    const rows = await conn.query(
      `SELECT * FROM ${TABLE} ORDER BY created_at DESC`
    );
    return {
      success: true,
      data: rows.map(formatTodoRow),
      total: rows.length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 10. 切换待办完成状态
// ------------------------------------------------------------
async function toggleTodoStatus(id) {
  let conn;
  try {
    conn = await pool.getConnection();

    // 先查询当前状态
    const [current] = await conn.query(
      `SELECT completed FROM ${TABLE} WHERE id = ?`,
      [id]
    );
    if (!current) {
      return { success: false, error: "未找到该待办任务，ID=" + id };
    }

    // 翻转完成状态
    const newCompleted = current.completed ? 0 : 1;
    const now = getUTC8Time();

    await conn.query(
      `UPDATE ${TABLE} SET completed = ?, updated_at = ? WHERE id = ?`,
      [newCompleted, now, id]
    );

    // 返回更新后的完整记录
    const [row] = await conn.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    return { success: true, data: formatTodoRow(row) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 11. 更新待办任务字段
// ------------------------------------------------------------
async function updateTodo(id, fields) {
  let conn;
  try {
    conn = await pool.getConnection();

    // 先检查记录是否存在
    const [existing] = await conn.query(`SELECT id, title FROM ${TABLE} WHERE id = ?`, [id]);
    if (!existing) {
      return { success: false, error: "未找到该待办任务，ID=" + id };
    }

    const now = getUTC8Time();
    // 动态构建 SET 子句
    const setClauses = [];
    const params = [];

    if (fields.title !== undefined) {
      setClauses.push("title = ?");
      params.push(fields.title);
    }
    if (fields.description !== undefined) {
      setClauses.push("description = ?");
      params.push(fields.description || null);
    }
    if (fields.category !== undefined) {
      setClauses.push("category = ?");
      params.push(fields.category || null);
    }
    if (fields.color !== undefined) {
      setClauses.push("color = ?");
      params.push(fields.color || null);
    }
    if (fields.completed !== undefined) {
      setClauses.push("completed = ?");
      params.push(fields.completed ? 1 : 0);
    }

    // 始终更新时间
    setClauses.push("updated_at = ?");
    params.push(now);
    params.push(id);

    await conn.query(
      `UPDATE ${TABLE} SET ${setClauses.join(", ")} WHERE id = ?`,
      params
    );

    // 返回更新后的完整记录
    const [row] = await conn.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    return { success: true, data: formatTodoRow(row) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 12. 服务端辅助函数
// ------------------------------------------------------------

// 紧急程度颜色映射表
const URGENCY_MAP = config.urgencyMap;

// HTML 转义（服务端渲染用）
function escapeHtmlForServer(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 格式化时间（友好显示）
function formatTimeForServer(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ------------------------------------------------------------
// 13. 根据 ID 查询单条待办
// ------------------------------------------------------------
async function getTodoById(id) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    if (!row) {
      return { success: false, error: "未找到该待办任务，ID=" + id };
    }
    return { success: true, data: formatTodoRow(row) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 14. 构建 HTML 页面的辅助函数
// ------------------------------------------------------------

// 构建待办详情页面
function buildDetailPage(todo, authUser) {
  const urgency = URGENCY_MAP[todo.color] || { label: "其他", cssColor: todo.color || "#AAAAAA" };
  const h = escapeHtmlForServer;
  const ft = formatTimeForServer;

  const statusBadge = todo.completed
    ? '<span class="status-badge done">✅ 已完成</span>'
    : '<span class="status-badge pending">⏳ 未完成</span>';

  const toggleLabel = todo.completed ? "⬜ 标记为未完成" : "✅ 标记为已完成";
  const deleteButtonHtml = authUser && authUser.level === "admin"
    ? `<button class="btn btn-delete" onclick="deleteFromDetail(${todo.id})">🗑 删除</button>`
    : "";

  let descBlock = "";
  if (todo.description) {
    descBlock =
      '<div class="info-row">\n' +
      '  <span class="info-label">具体事项</span>\n' +
      '  <span class="info-value desc">' + h(todo.description) + '</span>\n' +
      '</div>\n';
  }

  return (
`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(todo.title)} — 待办详情</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5; min-height: 100vh;
      display: flex; justify-content: center; align-items: center;
      padding: 24px;
    }
    .card {
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.08);
      width: 600px; max-width: 100%;
      overflow: hidden;
    }
    .card-header {
      padding: 32px 32px 20px;
      border-bottom: 1px solid #f0f0f0;
    }
    .detail-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .detail-top .back-link { margin-bottom: 0; }
    .auth-box {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .auth-account {
      font-size: 13px;
      color: #555;
    }
    .auth-logout {
      padding: 6px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #fff;
      color: #555;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    .auth-logout:hover {
      border-color: #4ECDC4;
      color: #4ECDC4;
    }
    .back-link {
      color: #4ECDC4; text-decoration: none; font-size: 14px;
      margin-bottom: 16px; display: inline-block;
    }
    .back-link:hover { text-decoration: underline; }
    .title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .title-text { font-size: 22px; font-weight: 700; color: #1a1a2e; word-break: break-word; }
    .status-badge {
      font-size: 13px; padding: 4px 14px; border-radius: 16px;
      white-space: nowrap; font-weight: 600;
    }
    .status-badge.done { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
    .status-badge.pending { background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
    .card-body { padding: 24px 32px; }
    .info-row {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 0; border-bottom: 1px solid #f5f5f5;
    }
    .info-row:last-child { border-bottom: none; }
    .info-label {
      font-size: 13px; font-weight: 600; color: #888;
      width: 80px; flex-shrink: 0;
    }
    .info-value { font-size: 15px; color: #333; word-break: break-word; flex: 1; }
    .info-value.desc { line-height: 1.7; white-space: pre-wrap; }
    .color-sample {
      width: 20px; height: 20px; border-radius: 50%;
      display: inline-block; vertical-align: middle; margin-right: 6px;
      border: 1px solid #d9d9d9;
    }
    .card-actions {
      padding: 20px 32px 32px;
      display: flex; gap: 12px; flex-wrap: wrap;
    }
    .btn {
      padding: 10px 24px; border-radius: 8px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      border: none; text-decoration: none; display: inline-block;
      transition: all 0.2s; font-family: inherit;
    }
    .btn-toggle {
      background: #fff; border: 2px solid #d9d9d9; color: #555;
    }
    .btn-toggle:hover { border-color: #aaa; }
    .btn-list { background: #4ECDC4; color: #fff; }
    .btn-list:hover { background: #3dbdb5; }
    .btn-delete { background: #fff; border: 2px solid #ff4d4f; color: #cf1322; }
    .btn-delete:hover { background: #fff2f0; }

  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="detail-top">
        <a href="/list" class="back-link">← 返回列表</a>
        ${authUser ? buildAuthBarHtml(authUser) : ""}
      </div>
      <div class="title-row">
        <span class="title-text">${h(todo.title)}</span>
        ${statusBadge}
      </div>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">ID</span>
        <span class="info-value">#${todo.id}</span>
      </div>

      ${descBlock}
      <div class="info-row">
        <span class="info-label">分类</span>
        <span class="info-value">${h(todo.category || "未分类")}</span>
      </div>

      <div class="info-row">
        <span class="info-label">紧急程度</span>
        <span class="info-value">
          <span class="color-sample" style="background:${todo.color || "#AAAAAA"}"></span>
          ${urgency.label}
          <span style="color:#aaa; margin-left:6px; font-size:13px;">${todo.color || "#AAAAAA"}</span>
        </span>
      </div>

      <div class="info-row">
        <span class="info-label">创建时间</span>
        <span class="info-value">${ft(todo.createdAt)}</span>
      </div>

      <div class="info-row">
        <span class="info-label">更新时间</span>
        <span class="info-value">${ft(todo.updatedAt)}</span>
      </div>
    </div>

    <div class="card-actions">
      <button class="btn btn-toggle" id="toggleBtn" onclick="toggleFromDetail(${todo.id})">
        ${toggleLabel}
      </button>
      ${deleteButtonHtml}
    </div>
  </div>

  ${buildAuthScriptHtml(authUser)}
  <script>
    // 删除待办
    async function deleteFromDetail(id) {
      if (!confirm("确认删除 ID=" + id + " 的待办任务？此操作不可恢复。")) return;
      var dbtn = document.querySelector(".btn-delete");
      if (dbtn) { dbtn.disabled = true; dbtn.textContent = "\u23f3\u2026\u2026"; }
      try {
        var response = await fetch("/api/todos/" + id, { method: "DELETE" });
        var result = await response.json();
        if (result.success) {
          window.location.href = "/list";
        } else {
          alert("\u5220\u9664\u5931\u8d25\uff1a" + (result.error || "\u672a\u77e5\u9519\u8bef"));
          if (dbtn) { dbtn.disabled = false; dbtn.textContent = "\u{1F5D1} \u5220\u9664"; }
        }
      } catch (err) {
        alert("\u7f51\u7edc\u9519\u8bef\uff1a" + err.message);
        if (dbtn) { dbtn.disabled = false; dbtn.textContent = "\u{1F5D1} \u5220\u9664"; }
      }
    }

    // 切换完成状态
    async function toggleFromDetail(id) {
      var btn = document.getElementById("toggleBtn");
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "\u23f3\u2026\u2026";

      try {
        var response = await fetch("/api/todos/" + id, { method: "PATCH" });
        var result = await response.json();
        if (!result.success) {
          alert("\u64cd\u4f5c\u5931\u8d25\uff1a" + (result.error || "\u672a\u77e5\u9519\u8bef"));
          btn.disabled = false;
          return;
        }
        location.reload();
      } catch (err) {
        alert("\u7f51\u7edc\u9519\u8bef\uff1a" + err.message);
        btn.disabled = false;
      }
    }
  </script>


  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>
</body>
</html>`
  );
}

// 构建"待办不存在"页面
function buildNotFoundPage(id) {
  return (
`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>待办不存在</title>
  <style>
    body { font-family: "Microsoft YaHei", sans-serif; text-align: center; padding: 80px 20px; color: #555; }
    a { color: #4ECDC4; text-decoration: none; }
  </style>
</head>
<body>
  <h1>📭 待办不存在</h1>
  <p>未找到 ID 为 ${id} 的任务。</p>
  <p><a href="/list">← 返回列表</a></p>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>
</body>
</html>`
  );
}

// ------------------------------------------------------------
// 14b. 删除待办任务
// ------------------------------------------------------------
async function deleteTodo(id) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [existing] = await conn.query(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (!existing) {
      return { success: false, error: "未找到该待办任务，ID=" + id };
    }
    await conn.query(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    return { success: true, title: existing.title, message: "已删除 ID=" + id + " 的待办任务" };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 14c. 登录认证辅助函数
// ------------------------------------------------------------

// 账号规范化：去掉首尾空格并转为小写，前后端必须一致
function canonicalAccount(account) {
  return String(account || "").trim().toLowerCase();
}

// 简单解析 Cookie 请求头（不引入额外依赖）
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  String(cookieHeader).split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  });
  return cookies;
}

function getCookie(req, name) {
  return parseCookies(req.headers.cookie || "")[name] || null;
}

// 设备识别与 IP 定位（与管理后台共用同一套解析规则）
function normalizeClientIp(ip) {
  return String(ip || "").replace(/^::ffff:/i, "");
}

function isPrivateIp(ip) {
  const patterns = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d)\./,
    /^fe[89ab]c?[0-9a-f]*:/i,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^::1$/,
  ];
  return patterns.some((pattern) => pattern.test(ip));
}

function lookupDeviceLocation(ip) {
  if (!AUTH_LOCATION_LOOKUP) return "";
  const normalized = normalizeClientIp(ip);
  if (!normalized || normalized === "unknown" || isPrivateIp(normalized)) {
    return normalized ? "内网" : "未知";
  }
  try {
    const info = geoip.lookup(normalized);
    if (!info) return "未知";
    return [info.city, info.region, info.country].filter(Boolean).join(" · ") || "未知";
  } catch {
    return "未知";
  }
}

function parseDeviceLabel(ua) {
  const text = String(ua || "");
  let browser = "";
  if (/Edg\//.test(text)) browser = "Edge";
  else if (/Chrome\//.test(text)) browser = "Chrome";
  else if (/Firefox\//.test(text)) browser = "Firefox";
  else if (/Safari\//.test(text)) browser = "Safari";
  else if (/MSIE|Trident/.test(text)) browser = "IE";

  let os = "";
  if (/Windows/.test(text)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(text)) os = "iOS";
  else if (/Android/.test(text)) os = "Android";
  else if (/Mac OS X/.test(text)) os = "macOS";
  else if (/Linux/.test(text)) os = "Linux";

  let kind = "桌面端";
  if (/iPad/.test(text)) kind = "平板端";
  else if (/Mobi|Android|iPhone/.test(text)) kind = "移动端";

  return [browser, os, kind].filter(Boolean).join(" · ") || "未知设备";
}

function getClientIp(req) {
  return normalizeClientIp(req.ip || req.socket.remoteAddress || "unknown");
}

// 写入主系统操作日志（只保存结构化原文，翻译由管理后台前端生成）
async function logOperation(action, account, details, req) {
  if (!LOGGING.enabled || !action) return;
  const ipAddress = getClientIp(req || {});
  await operationLog.writeOperationLog({
    pool,
    table: LOG_TABLE,
    action,
    account,
    details,
    ipAddress,
    location: lookupDeviceLocation(ipAddress),
    source: "main",
    timezoneOffsetHours: TIMEZONE_OFFSET_HOURS,
  });
}

// 按规范化账号查询用户（仅用于登录流程，不返回任何哈希给客户端）
async function findLoginUser(account) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
      `SELECT id, account, password_hash, display_name, avatar_data, is_active, \`level\`, last_login_at
       FROM ${USERS_TABLE} WHERE account = ?`,
      [account]
    );
    return row || null;
  } catch (err) {
    console.error("❌ 查询用户失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

// 创建数据库会话并返回随机会话令牌
async function createSessionForUser(userId, req) {
  let conn;
  try {
    conn = await pool.getConnection();
    const token = crypto.randomBytes(32).toString("hex");
    const rawUa = String((req && req.headers && req.headers["user-agent"]) || "");
    const userAgent = rawUa.slice(0, 500);
    const ipAddress = getClientIp(req || {});
    const location = lookupDeviceLocation(ipAddress);
    const now = getUTC8Time();
    await conn.query(
      `INSERT INTO ${SESSIONS_TABLE}
        (token, user_id, device_label, user_agent, ip_address, location, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token,
        userId,
        parseDeviceLabel(userAgent),
        userAgent,
        ipAddress,
        location,
        now,
        getUTC8TimeAfterDays(SESSION_DAYS),
        now,
      ]
    );
    return { success: true, token };
  } catch (err) {
    console.error("❌ 创建会话失败：", err.message);
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// 成功登录后独立记录，避免退出或会话过期后历史丢失
async function recordLoginHistory(user, sessionToken, req) {
  const rawUa = String((req && req.headers && req.headers["user-agent"]) || "");
  const userAgent = rawUa.slice(0, 500);
  const ipAddress = getClientIp(req || {});
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `INSERT INTO ${LOGIN_HISTORY_TABLE}
        (user_id, account, session_token, device_label, user_agent, ip_address, location, login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE login_at = VALUES(login_at)`,
      [
        user.id,
        user.account,
        sessionToken,
        parseDeviceLabel(userAgent),
        userAgent,
        ipAddress,
        lookupDeviceLocation(ipAddress),
        getUTC8Time(),
      ]
    );
  } catch (err) {
    console.error("❌ 写入登录历史失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

async function queryLoginHistory(userId, limit) {
  let conn;
  try {
    conn = await pool.getConnection();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
    const rows = await conn.query(
      `SELECT device_label, ip_address, location, login_at
       FROM ${LOGIN_HISTORY_TABLE}
       WHERE user_id = ?
       ORDER BY login_at DESC, id DESC
       LIMIT ${Math.floor(safeLimit)}`,
      [userId]
    );
    return rows.map((row) => ({
      device: row.device_label || "未知设备",
      ipAddress: row.ip_address || "",
      location: row.location || "未知",
      loginAt: row.login_at instanceof Date ? row.login_at.toISOString() : String(row.login_at),
    }));
  } catch (err) {
    console.error("❌ 查询登录历史失败：", err.message);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

// 查询会话并关联用户信息
async function findSessionWithUser(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
    `SELECT s.token, s.expires_at,
            u.id AS uid, u.account, u.display_name, u.avatar_data, u.is_active, u.\`level\`
     FROM ${SESSIONS_TABLE} s
     INNER JOIN ${USERS_TABLE} u ON u.id = s.user_id
     WHERE s.token = ?`,
      [token]
    );
    if (!row) return null;
    return {
      token: row.token,
      expires_at: row.expires_at,
      user: {
        id: row.uid,
        account: row.account,
        displayName: row.display_name,
        avatarData: row.avatar_data || "",
        isActive: row.is_active,
        level: row.level,
      },
    };
  } catch (err) {
    console.error("❌ 查询会话失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

// 判断会话是否过期（兼容字符串与 Date 两种返回形式）
function isExpiredValue(value) {
  if (value instanceof Date) return value.getTime() < Date.now();
  const text = String(value).replace(" ", "T");
  return new Date(text).getTime() < Date.now();
}

async function deleteSession(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`DELETE FROM ${SESSIONS_TABLE} WHERE token = ?`, [token]);
    sessionTouchTimes.delete(token);
  } catch (err) {
    console.error("❌ 删除会话失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// 清理过期会话（启动时与登录时调用）
async function deleteExpiredSessions() {
  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `DELETE FROM ${SESSIONS_TABLE} WHERE expires_at < ?`,
      [getUTC8Time()]
    );
    if (result.affectedRows > 0) {
      console.log(`🧹 已清理 ${result.affectedRows} 条过期会话。`);
    }
  } catch (err) {
    console.error("❌ 清理过期会话失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// 主系统会话活跃时间节流刷新（避免每次请求都写库）
const SESSION_TOUCH_WINDOW_MS = 60 * 1000;
const sessionTouchTimes = new Map();

async function touchMainSession(token) {
  const now = Date.now();
  if (now - (sessionTouchTimes.get(token) || 0) < SESSION_TOUCH_WINDOW_MS) return;
  sessionTouchTimes.set(token, now);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `UPDATE ${SESSIONS_TABLE} SET last_active_at = ? WHERE token = ?`,
      [getUTC8Time(), token]
    );
  } catch {
    // 活跃时间刷新失败不阻断请求
  } finally {
    if (conn) conn.release();
  }
}

// 从请求中解析当前登录用户；未登录或会话过期返回 null
async function authenticateRequest(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const session = await findSessionWithUser(token);
  if (!session) return null;

  const expired = isExpiredValue(session.expires_at);
  const inactive = !session.user || !session.user.isActive;
  if (expired || inactive) {
    await deleteSession(token);
    return null;
  }

  touchMainSession(token);

  return {
    id: session.user.id,
    account: session.user.account,
    displayName: session.user.displayName,
    avatarData: session.user.avatarData,
    level: session.user.level || "user",
  };
}

// 页面路由保护：未登录重定向到 /login
async function requirePageAuth(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) {
    const target = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(`/login?next=${target}`);
  }
  req.authUser = user;
  next();
}

// API 路由保护：未登录返回 401 JSON
async function requireApiAuth(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  req.authUser = user;
  next();
}

// 管理员 API 保护：未登录返回 401，非管理员返回 403
async function requireAdminApi(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  if (user.level !== "admin") {
    return res.status(403).json({
      success: false,
      error: "无权限，仅管理员可删除待办",
      message: "无权限，仅管理员可删除待办",
    });
  }
  req.authUser = user;
  next();
}

function formatAuthUser(user) {
  return {
    account: user.account,
    displayName: user.displayName || user.account,
    avatarData: user.avatarData || user.avatar_data || "",
    level: user.level || "user",
  };
}

const AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function validateAvatarData(value) {
  if (value === null || value === "") return { valid: true, value: "" };
  if (typeof value !== "string") {
    return { valid: false, error: "头像格式错误" };
  }
  const match = value.match(AVATAR_DATA_URL_PATTERN);
  if (!match) {
    return { valid: false, error: "仅支持 PNG、JPEG 或 WebP 图片" };
  }

  let image;
  try {
    image = Buffer.from(match[2], "base64");
  } catch {
    return { valid: false, error: "头像图片数据无效" };
  }
  if (image.length === 0 || image.length > AVATAR_MAX_BYTES) {
    return { valid: false, error: `头像不能超过 ${Math.round(AVATAR_MAX_BYTES / 1024)} KB` };
  }

  const type = match[1];
  const isPng = type === "png" && image.length > 8 &&
    image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const isJpeg = type === "jpeg" && image.length > 3 &&
    image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isWebp = type === "webp" && image.length > 12 &&
    image.subarray(0, 4).toString("ascii") === "RIFF" &&
    image.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    return { valid: false, error: "头像图片内容与格式不符" };
  }
  return { valid: true, value };
}

// 登录失败限速：按账号 + IP 统计，5 分钟内最多 5 次失败
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAIL_MAX = 5;
const loginFailures = new Map();

function loginFailKey(account, ip) {
  return `${account}|${ip}`;
}

function isLoginRateLimited(account, ip) {
  const record = loginFailures.get(loginFailKey(account, ip));
  if (!record) return false;
  if (Date.now() - record.last > LOGIN_FAIL_WINDOW_MS) {
    loginFailures.delete(loginFailKey(account, ip));
    return false;
  }
  return record.count >= LOGIN_FAIL_MAX;
}

function recordLoginFailure(account, ip) {
  const key = loginFailKey(account, ip);
  const now = Date.now();
  const record = loginFailures.get(key) || { count: 0, last: now };
  record.count += 1;
  record.last = now;
  loginFailures.set(key, record);
}

function clearLoginFailures(account, ip) {
  loginFailures.delete(loginFailKey(account, ip));
}

// ?next= 回跳参数：只接受站内相对路径
function sanitizeNextPath(value) {
  if (typeof value !== "string" || value.length > 300) return "/list";
  if (!value.startsWith("/")) return "/list";
  if (value.startsWith("//") || value.includes("\\")) return "/list";
  if (value.startsWith("/login") || value.startsWith("/api")) return "/list";
  return value;
}

function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// 页面右上角用户头像菜单（/list、/add、详情页、首页共用）
function buildAuthBarHtml(user) {
  const h = escapeHtmlForServer;
  const displayName = user.displayName || user.account;
  const initial = String(displayName).trim().charAt(0).toUpperCase() || "U";
  const avatarHtml = user.avatarData
    ? `<img src="${h(user.avatarData)}" alt="">`
    : `<span>${h(initial)}</span>`;

  return `
  <style>
    .user-menu { position: relative; font-family: inherit; z-index: 20000; }
    .user-menu-trigger {
      display: flex; align-items: center; gap: 8px; min-height: 42px;
      padding: 4px 10px 4px 4px; border: 1px solid #e1e5e9;
      border-radius: 22px; background: #fff; color: #333;
      cursor: pointer; font-family: inherit; box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }
    .user-menu-trigger:hover { border-color: #4ECDC4; }
    .user-menu-avatar {
      width: 32px; height: 32px; border-radius: 50%; overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; background: linear-gradient(135deg, #4ECDC4, #2fa8a0);
      color: #fff; font-size: 14px; font-weight: 700;
    }
    .user-menu-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .user-menu-name {
      max-width: 130px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-size: 13px;
    }
    .user-menu-caret { color: #999; font-size: 10px; }
    .user-menu.open .user-menu-caret { transform: rotate(180deg); }
    .user-menu-dropdown {
      display: none; position: absolute; top: calc(100% + 8px); right: 0;
      width: 224px; padding: 6px; border: 1px solid #e7eaee;
      border-radius: 10px; background: #fff; color: #333;
      box-shadow: 0 14px 40px rgba(20,30,50,0.16);
    }
    .user-menu.open .user-menu-dropdown { display: block; }
    .user-menu-summary { padding: 10px 12px; text-align: left; }
    .user-menu-summary strong { display: block; color: #1a1a2e; font-size: 14px; }
    .user-menu-summary span { display: block; color: #999; font-size: 12px; margin-top: 3px; }
    .user-menu-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 12px; border: 0; border-radius: 7px;
      background: transparent; color: #444; cursor: pointer;
      text-align: left; font: inherit; font-size: 13px;
    }
    .user-menu-item:hover { background: #f3fbfa; color: #198f88; }
    .user-menu-item-icon { width: 18px; text-align: center; }
    .user-menu-divider { height: 1px; margin: 5px 8px; background: #eef0f3; }
    .user-modal {
      display: none; position: fixed; inset: 0; z-index: 30000;
      align-items: center; justify-content: center; padding: 20px;
      background: rgba(15, 20, 30, 0.48); backdrop-filter: blur(3px);
    }
    .user-modal.open { display: flex; }
    .user-modal-card {
      width: 660px; max-width: 100%; max-height: min(82vh, 760px);
      display: flex; flex-direction: column; overflow: hidden;
      border-radius: 12px; background: #fff; color: #333;
      box-shadow: 0 24px 70px rgba(0,0,0,0.24);
    }
    .user-modal-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 20px 22px; border-bottom: 1px solid #eef0f3;
    }
    .user-modal-head h2 { margin: 0; color: #1a1a2e; font-size: 18px; }
    .user-modal-close {
      width: 34px; height: 34px; border: 0; border-radius: 50%;
      background: #f2f4f7; color: #666; cursor: pointer; font-size: 22px;
      line-height: 1;
    }
    .user-modal-close:hover { background: #e7ebef; color: #222; }
    .user-modal-body { padding: 18px 22px 24px; overflow: auto; }
    .user-list { display: flex; flex-direction: column; gap: 10px; }
    .user-list-row {
      display: grid; grid-template-columns: 38px minmax(0,1fr) auto;
      gap: 12px; align-items: center; padding: 13px 14px;
      border: 1px solid #edf0f3; border-radius: 8px; background: #fbfcfd;
    }
    .user-list-icon {
      width: 38px; height: 38px; border-radius: 50%; display: flex;
      align-items: center; justify-content: center; background: #e9f8f7;
      color: #198f88; font-size: 17px;
    }
    .user-list-main { min-width: 0; }
    .user-list-main strong {
      display: block; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-size: 14px; color: #2d3340;
    }
    .user-list-main span { display: block; margin-top: 4px; color: #8b93a0; font-size: 12px; }
    .user-list-time { color: #8b93a0; font-size: 12px; white-space: nowrap; }
    .user-log-row {
      padding: 13px 14px; border: 1px solid #edf0f3;
      border-radius: 8px; background: #fbfcfd;
    }
    .user-log-top { display: flex; justify-content: space-between; gap: 12px; }
    .user-log-top strong { color: #2d3340; font-size: 14px; }
    .user-log-meta { margin-top: 6px; color: #8b93a0; font-size: 12px; }
    .user-log-raw { margin-top: 9px; color: #777; font-size: 12px; }
    .user-log-raw summary { cursor: pointer; color: #198f88; }
    .user-log-raw pre {
      margin: 8px 0 0; padding: 10px; overflow: auto;
      border-radius: 6px; background: #f2f4f7; color: #555;
      font: 11px/1.5 Consolas, monospace; white-space: pre-wrap; word-break: break-word;
    }
    .user-modal-state {
      padding: 42px 16px; text-align: center; color: #9299a5; font-size: 14px;
    }
    .user-avatar-file { display: none; }
    .user-toast {
      position: fixed; right: 22px; bottom: 22px; z-index: 40000;
      padding: 11px 16px; border-radius: 8px; background: #1f2937;
      color: #fff; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      opacity: 0; transform: translateY(8px); pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
    }
    .user-toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 560px) {
      .user-menu-name { display: none; }
      .user-menu-trigger { min-height: 38px; padding: 3px; border-radius: 50%; }
      .user-modal { padding: 10px; }
      .user-modal-card { max-height: 88vh; }
      .user-list-row { grid-template-columns: 34px minmax(0,1fr); }
      .user-list-time { grid-column: 2; }
      .user-log-top { flex-direction: column; gap: 4px; }
    }
  </style>
  <div class="user-menu" id="userMenu">
    <button type="button" class="user-menu-trigger" id="userMenuTrigger"
            aria-haspopup="menu" aria-expanded="false">
      <span class="user-menu-avatar" data-user-avatar>${avatarHtml}</span>
      <span class="user-menu-name">${h(displayName)}</span>
      <span class="user-menu-caret">▼</span>
    </button>
    <div class="user-menu-dropdown" role="menu">
      <div class="user-menu-summary">
        <strong>${h(displayName)}</strong>
        <span>@${h(user.account)}</span>
      </div>
      <button type="button" class="user-menu-item" data-user-action="avatar" role="menuitem">
        <span class="user-menu-item-icon">▧</span>自定义头像
      </button>
      <button type="button" class="user-menu-item" data-user-action="reset-avatar" role="menuitem"
              ${user.avatarData ? "" : 'style="display:none"'}>
        <span class="user-menu-item-icon">↺</span>恢复默认头像
      </button>
      <button type="button" class="user-menu-item" data-user-action="history" role="menuitem">
        <span class="user-menu-item-icon">◷</span>历史登录记录
      </button>
      <button type="button" class="user-menu-item" data-user-action="activity" role="menuitem">
        <span class="user-menu-item-icon">≡</span>我的操作日志
      </button>
      <div class="user-menu-divider"></div>
      <button type="button" class="user-menu-item" onclick="logoutCurrentUser()" role="menuitem">
        <span class="user-menu-item-icon">↪</span>退出登录
      </button>
    </div>
  </div>
  <input class="user-avatar-file" id="userAvatarFile" type="file" accept="image/png,image/jpeg,image/webp">
  <div class="user-modal" id="userModal" aria-hidden="true">
    <div class="user-modal-card" role="dialog" aria-modal="true" aria-labelledby="userModalTitle">
      <div class="user-modal-head">
        <h2 id="userModalTitle">用户信息</h2>
        <button type="button" class="user-modal-close" id="userModalClose" aria-label="关闭">×</button>
      </div>
      <div class="user-modal-body" id="userModalBody"></div>
    </div>
  </div>
  <div class="user-toast" id="userToast" role="status" aria-live="polite"></div>`;
}

// 头像菜单、登录历史、个人操作日志和上传逻辑
function buildAuthScriptHtml(user) {
  const initialState = jsonForInlineScript(formatAuthUser(user));
  return `
  <script>
    (function () {
      var nativeFetch = window.fetch;
      if (!nativeFetch) return;
      window.fetch = function () {
        var args = arguments;
        return nativeFetch.apply(window, args).then(function (response) {
          if (response.status === 401 && window.location.pathname.indexOf("/login") !== 0) {
            var current = window.location.pathname + window.location.search;
            window.location.href = "/login?next=" + encodeURIComponent(current);
          }
          return response;
        });
      };
    })();

    async function logoutCurrentUser() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch (err) {
        // 网络异常也不残留登录态，直接回登录页
      }
      window.location.href = "/login";
    }

    (function () {
      var currentUser = ${initialState};
      var menu = document.getElementById("userMenu");
      var trigger = document.getElementById("userMenuTrigger");
      var modal = document.getElementById("userModal");
      var modalTitle = document.getElementById("userModalTitle");
      var modalBody = document.getElementById("userModalBody");
      var closeButton = document.getElementById("userModalClose");
      var fileInput = document.getElementById("userAvatarFile");
      var toast = document.getElementById("userToast");
      var toastTimer = null;
      if (!menu || !trigger || !modal || !modalBody) return;

      function escapeHtml(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function showToast(message) {
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2600);
      }

      function setMenuOpen(open) {
        menu.classList.toggle("open", open);
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
      }

      function avatarMarkup(data) {
        if (data) return '<img src="' + escapeHtml(data) + '" alt="">';
        var name = currentUser.displayName || currentUser.account || "U";
        return "<span>" + escapeHtml(String(name).trim().charAt(0).toUpperCase() || "U") + "</span>";
      }

      function refreshAvatar(data) {
        currentUser.avatarData = data || "";
        document.querySelectorAll("[data-user-avatar]").forEach(function (node) {
          node.innerHTML = avatarMarkup(currentUser.avatarData);
        });
        var resetButton = document.querySelector('[data-user-action="reset-avatar"]');
        if (resetButton) resetButton.style.display = currentUser.avatarData ? "flex" : "none";
      }

      function openModal(title) {
        modalTitle.textContent = title;
        modalBody.innerHTML = '<div class="user-modal-state">正在加载...</div>';
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        setMenuOpen(false);
      }

      function closeModal() {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }

      function formatDate(value) {
        if (!value) return "";
        var d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toLocaleString("zh-CN", { hour12: false });
      }

      function parseLog(log) {
        try { return JSON.parse(log.raw || "{}"); } catch (err) { return {}; }
      }

      function translateLog(log) {
        var raw = parseLog(log);
        var details = raw.details || {};
        var title = details.title ? '"' + details.title + '"' : "";
        var id = details.todoId ? "#" + details.todoId : "";
        var map = {
          "main.login.success": "登录成功",
          "main.login.failed": "登录失败",
          "main.logout": "退出登录",
          "main.todo.create": "创建待办 " + title,
          "main.todo.toggle": "将待办 " + id + (details.completed ? " 标记为已完成" : " 标记为未完成"),
          "main.todo.update": "更新待办 " + id,
          "main.todo.delete": "删除待办 " + id + (title ? " " + title : ""),
          "main.profile.avatar_update": "更新个人头像",
          "main.profile.avatar_reset": "恢复默认头像"
        };
        return map[log.action] || log.action || "系统操作";
      }

      async function loadHistory() {
        try {
          var response = await fetch("/api/me/login-history?limit=30");
          var result = await response.json();
          if (!result.success) throw new Error(result.message || "读取失败");
          if (!result.history.length) {
            modalBody.innerHTML = '<div class="user-modal-state">暂无历史登录记录</div>';
            return;
          }
          modalBody.innerHTML = '<div class="user-list">' + result.history.map(function (item) {
            return '<div class="user-list-row">' +
              '<span class="user-list-icon">◷</span>' +
              '<div class="user-list-main"><strong>' + escapeHtml(item.device) + '</strong>' +
              '<span>' + escapeHtml(item.location || "未知") + ' · ' + escapeHtml(item.ipAddress || "IP 未知") + '</span></div>' +
              '<time class="user-list-time">' + escapeHtml(formatDate(item.loginAt)) + '</time></div>';
          }).join("") + '</div>';
        } catch (err) {
          modalBody.innerHTML = '<div class="user-modal-state">加载失败：' + escapeHtml(err.message) + '</div>';
        }
      }

      async function loadActivity() {
        try {
          var response = await fetch("/api/me/activity?limit=100");
          var result = await response.json();
          if (!result.success) throw new Error(result.message || "读取失败");
          if (!result.logs.length) {
            modalBody.innerHTML = '<div class="user-modal-state">暂无操作日志</div>';
            return;
          }
          modalBody.innerHTML = '<div class="user-list">' + result.logs.map(function (log) {
            return '<div class="user-log-row">' +
              '<div class="user-log-top"><strong>' + escapeHtml(translateLog(log)) + '</strong>' +
              '<time class="user-list-time">' + escapeHtml(formatDate(log.createdAt)) + '</time></div>' +
              '<div class="user-log-meta">' + escapeHtml(log.location || "未知") + ' · ' + escapeHtml(log.ipAddress || "IP 未知") + '</div>' +
              '<details class="user-log-raw"><summary>查看原文</summary><pre>' +
              escapeHtml(log.raw) + '</pre></details></div>';
          }).join("") + '</div>';
        } catch (err) {
          modalBody.innerHTML = '<div class="user-modal-state">加载失败：' + escapeHtml(err.message) + '</div>';
        }
      }

      async function saveAvatar(avatarData) {
        showToast("正在保存头像...");
        try {
          var response = await fetch("/api/me/avatar", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ avatarData: avatarData })
          });
          var result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.message || "保存失败");
          refreshAvatar(result.user.avatarData);
          showToast(result.message);
        } catch (err) {
          showToast("头像保存失败：" + err.message);
        }
      }

      function compressAvatar(file) {
        return new Promise(function (resolve, reject) {
          if (!file || !/^image\\/(png|jpeg|webp)$/.test(file.type)) {
            return reject(new Error("请选择 PNG、JPEG 或 WebP 图片"));
          }
          if (file.size > 10 * 1024 * 1024) {
            return reject(new Error("原始图片不能超过 10 MB"));
          }
          var reader = new FileReader();
          reader.onerror = function () { reject(new Error("无法读取图片")); };
          reader.onload = function () {
            var image = new Image();
            image.onerror = function () { reject(new Error("图片解析失败")); };
            image.onload = function () {
              var size = 256;
              var canvas = document.createElement("canvas");
              canvas.width = size;
              canvas.height = size;
              var context = canvas.getContext("2d");
              context.fillStyle = "#ffffff";
              context.fillRect(0, 0, size, size);
              var scale = Math.max(size / image.width, size / image.height);
              var width = image.width * scale;
              var height = image.height * scale;
              context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
              var data = canvas.toDataURL("image/webp", 0.84);
              if (data.indexOf("data:image/webp") !== 0) {
                data = canvas.toDataURL("image/jpeg", 0.86);
              }
              resolve(data);
            };
            image.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
      }

      trigger.addEventListener("click", function (event) {
        event.stopPropagation();
        setMenuOpen(!menu.classList.contains("open"));
      });
      menu.querySelector(".user-menu-dropdown").addEventListener("click", function (event) {
        event.stopPropagation();
      });
      document.addEventListener("click", function () { setMenuOpen(false); });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeModal();
          setMenuOpen(false);
        }
      });
      closeButton.addEventListener("click", closeModal);
      modal.addEventListener("click", function (event) {
        if (event.target === modal) closeModal();
      });

      menu.querySelectorAll("[data-user-action]").forEach(function (button) {
        button.addEventListener("click", async function () {
          var action = button.getAttribute("data-user-action");
          if (action === "avatar") {
            setMenuOpen(false);
            fileInput.value = "";
            fileInput.click();
          } else if (action === "reset-avatar") {
            setMenuOpen(false);
            await saveAvatar(null);
          } else if (action === "history") {
            openModal("历史登录记录");
            await loadHistory();
          } else if (action === "activity") {
            openModal("我的操作日志");
            await loadActivity();
          }
        });
      });

      fileInput.addEventListener("change", async function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
          var avatarData = await compressAvatar(file);
          await saveAvatar(avatarData);
        } catch (err) {
          showToast("头像处理失败：" + err.message);
        }
      });
    })();
  </script>`;
}

// 登录页 HTML（第 4.1 节样式：浅灰背景 + 白色卡片 + 青色主按钮）
function buildLoginPage(nextPath, insecure) {
  const safeNext = JSON.stringify(sanitizeNextPath(nextPath));
  const warning = insecure
    ? `<div class="proto-warning">⚠️ 当前运行在未加密的 HTTP 模式下，登录存在安全风险，请使用 HTTPS 访问。</div>`
    : "";

  return (
`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 — EBS 待办工作站</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }
    .login-card {
      background: #fff;
      width: 400px;
      max-width: 92vw;
      padding: 40px;
      border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .brand { text-align: center; }
    .brand-sub {
      font-size: 13px;
      color: #888;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 24px;
      color: #1a1a2e;
      margin-bottom: 32px;
    }
    .proto-warning {
      background: #fffbe6;
      border: 1px solid #ffe58f;
      color: #ad6800;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .form-group { margin-bottom: 18px; }
    label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #333;
      margin-bottom: 8px;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      height: 44px;
      padding: 0 14px;
      border: 1px solid #d9d9d9;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      background: #fafafa;
      transition: border-color 0.2s, background 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #4ECDC4;
      background: #fff;
    }
    .password-wrap { position: relative; }
    .password-toggle {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      width: 36px;
      height: 36px;
      border: none;
      background: transparent;
      color: #888;
      font-size: 18px;
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .password-toggle:hover { color: #333; background: #f0f2f5; }
    .error-text {
      display: none;
      color: #cf1322;
      font-size: 13px;
      font-weight: 600;
      margin: -4px 0 12px;
    }
    .login-btn {
      width: 100%;
      height: 44px;
      background: #4ECDC4;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.2s;
    }
    .login-btn:hover { background: #3dbdb5; }
    .login-btn:disabled { background: #b3e5e1; cursor: not-allowed; }
    .footer {
      position: fixed;
      bottom: 14px;
      left: 0;
      width: 100%;
      text-align: center;
      color: #aaa;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="brand">
      <div class="brand-sub">EBS 待办工作站</div>
      <h1>登录</h1>
    </div>
    ${warning}
    <form id="loginForm" novalidate>
      <div class="form-group">
        <label for="account">账号</label>
        <input type="text" id="account" name="account" autocomplete="username" maxlength="64" required>
      </div>
      <div class="error-text" id="errorText">账号或密码错误</div>
      <div class="form-group">
        <label for="password">密码</label>
        <div class="password-wrap">
          <input type="password" id="password" name="password" autocomplete="current-password" required>
          <button type="button" class="password-toggle" id="passwordToggle" title="显示/隐藏密码">👁</button>
        </div>
      </div>
      <button type="submit" class="login-btn" id="loginBtn">登录</button>
    </form>
  </div>
  <div class="footer">EBS Workstation Todo List By PRC-Leo</div>

  <script>
    (function () {
      var form = document.getElementById("loginForm");
      var accountInput = document.getElementById("account");
      var passwordInput = document.getElementById("password");
      var passwordToggle = document.getElementById("passwordToggle");
      var errorText = document.getElementById("errorText");
      var loginBtn = document.getElementById("loginBtn");
      var nextPath = ${safeNext};
      var submitting = false;

      passwordToggle.addEventListener("click", function () {
        var show = passwordInput.type === "password";
        passwordInput.type = show ? "text" : "password";
        passwordToggle.textContent = show ? "🙈" : "👁";
        passwordInput.focus();
      });

      function showError(message) {
        errorText.textContent = message;
        errorText.style.display = "block";
      }

      function clearError() {
        errorText.style.display = "none";
      }

      accountInput.addEventListener("input", clearError);
      passwordInput.addEventListener("input", clearError);

      async function sha256Hex(text) {
        var data = new TextEncoder().encode(text);
        var digest = await crypto.subtle.digest("SHA-256", data);
        return Array.prototype.map.call(new Uint8Array(digest), function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
      }

      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (submitting) return;

        var accountRaw = accountInput.value;
        var password = passwordInput.value;
        if (!accountRaw.trim() || !password) {
          showError("账号或密码错误");
          return;
        }

        var account = accountRaw.trim().toLowerCase();

        if (!window.crypto || !window.crypto.subtle) {
          showError("当前环境不支持浏览器加密，请使用 HTTPS 访问");
          return;
        }

        submitting = true;
        loginBtn.disabled = true;
        loginBtn.textContent = "登录中…";
        clearError();

        try {
          var passwordHash = await sha256Hex(account + ":" + password);
          var response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              account: account,
              passwordHash: passwordHash
            })
          });
          var result = await response.json();

          if (response.status === 401 || !result.success) {
            showError("账号或密码错误");
            submitting = false;
            loginBtn.disabled = false;
            loginBtn.textContent = "登录";
            return;
          }

          if (response.status === 429) {
            showError("尝试过于频繁，请稍后再试");
            submitting = false;
            loginBtn.disabled = false;
            loginBtn.textContent = "登录";
            return;
          }

          var target = nextPath;
          if (!target ||
              target.indexOf("/") !== 0 ||
              target.indexOf("//") === 0 ||
              target.indexOf("\\\\") !== -1 ||
              target.indexOf("/login") === 0 ||
              target.indexOf("/api") === 0) {
            target = "/list";
          }
          window.location.href = target;
        } catch (err) {
          showError("网络错误，请稍后再试");
          submitting = false;
          loginBtn.disabled = false;
          loginBtn.textContent = "登录";
        }
      });
    })();
  </script>
</body>
</html>`
  );
}

// ------------------------------------------------------------
// 15. 路由定义
// ------------------------------------------------------------

// 根路由 —— 服务基本信息
// 根路由 —— 欢迎首页 GUI
app.get("/", async (req, res) => {
  const homeUser = await authenticateRequest(req);
  const listHref = homeUser ? "/list" : "/login";
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EBS 待办工作站</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    /* 背景粒子动画 */
    .particles {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 0;
    }
    .particle {
      position: absolute;
      background: rgba(255,255,255,0.08);
      border-radius: 50%;
      animation: float linear infinite;
    }
    @keyframes float {
      0% { transform: translateY(100vh) scale(0); opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { transform: translateY(-10vh) scale(1); opacity: 0; }
    }
    .main-content {
      position: relative; z-index: 1;
      text-align: center;
    }
    .welcome-text {
      font-size: 42px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 8px;
      opacity: 0;
      animation: fadeInUp 1.2s ease-out 0.3s forwards;
      text-shadow: 0 2px 20px rgba(78,205,196,0.4);
    }
    .welcome-sub {
      font-size: 18px;
      color: rgba(255,255,255,0.65);
      margin-bottom: 48px;
      opacity: 0;
      animation: fadeInUp 1.2s ease-out 0.8s forwards;
      letter-spacing: 2px;
    }
    .btn-start {
      display: inline-block;
      padding: 16px 56px;
      font-size: 18px;
      font-weight: 600;
      color: #1a1a2e;
      background: linear-gradient(135deg, #4ECDC4, #44b8b0);
      border: none;
      border-radius: 50px;
      cursor: pointer;
      text-decoration: none;
      opacity: 0;
      animation: fadeInUp 1.2s ease-out 1.3s forwards;
      transition: all 0.3s;
      box-shadow: 0 8px 32px rgba(78,205,196,0.3);
      letter-spacing: 1px;
    }
    .btn-start:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 40px rgba(78,205,196,0.5);
      background: linear-gradient(135deg, #5ddbd3, #4ECDC4);
    }
    .btn-start:active { transform: translateY(0); }
    @keyframes fadeInUp {
      0% { opacity: 0; transform: translateY(30px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    .footer {
      position: fixed; bottom: 24px; left: 0; width: 100%;
      text-align: center; z-index: 1;
      color: rgba(255,255,255,0.3); font-size: 13px;
      opacity: 0;
      animation: fadeInUp 1.2s ease-out 1.8s forwards;
    }
    .home-auth {
      position: fixed; top: 20px; right: 24px; z-index: 2;
      display: flex; align-items: center; gap: 12px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 24px;
      padding: 8px 14px;
      color: #fff; font-size: 13px;
    }
    .home-auth .auth-logout {
      border: none; background: rgba(255,255,255,0.18); color: #fff;
      padding: 6px 12px; border-radius: 14px;
      cursor: pointer; font-size: 12px; font-family: inherit;
    }
  </style>
</head>
<body>
  <!-- 粒子背景 -->
  <div class="particles" id="particles"></div>

  ${homeUser ? `
  <div class="home-auth">
    ${buildAuthBarHtml(homeUser)}
  </div>` : ""}

  <!-- 主体内容 -->
  <div class="main-content">
    <h1 class="welcome-text">欢迎来到 EBS 待办工作站</h1>
    <p class="welcome-sub">高效开发 · 有序工作</p>
    <a href="${listHref}" class="btn-start">📋 待办列表</a>
  </div>

  
  <script>
    // 生成浮动粒子
    (function() {
      var container = document.getElementById("particles");
      var colors = ["rgba(78,205,196,", "rgba(255,255,255,", "rgba(100,180,255,"];
      for (var i = 0; i < 40; i++) {
        var el = document.createElement("div");
        el.className = "particle";
        var size = Math.random() * 6 + 2;
        el.style.width = size + "px";
        el.style.height = size + "px";
        el.style.left = Math.random() * 100 + "%";
        el.style.animationDuration = (Math.random() * 12 + 8) + "s";
        el.style.animationDelay = (Math.random() * 10) + "s";
        var alpha = (Math.random() * 0.12 + 0.04).toFixed(2);
        var colorIdx = Math.floor(Math.random() * colors.length);
        el.style.background = colors[colorIdx] + alpha + ")";
        container.appendChild(el);
      }
})();
</script>

<div class="footer">EBS Workstation Todo List By PRC-Leo</div>
${homeUser ? buildAuthScriptHtml(homeUser) : ""}
</body>
</html>
 `);
});

// /login 路由 —— 登录页（必须注册在通配路由 /:id 之前）
app.get("/login", async (req, res) => {
  const currentUser = await authenticateRequest(req);
  if (currentUser) return res.redirect("/list");

  const next = sanitizeNextPath(req.query.next);
  res.send(buildLoginPage(next, !req.secure));
});

// POST /api/login —— 登录：只接收账号与浏览器端哈希
app.post("/api/login", async (req, res) => {
  const { account, passwordHash } = req.body || {};

  if (typeof account !== "string" || typeof passwordHash !== "string") {
    return res.status(400).json({ success: false, message: "请求格式错误" });
  }

  const canonical = canonicalAccount(account);
  if (!canonical || canonical.length > 64) {
    return res.status(400).json({ success: false, message: "账号必填且不能超过 64 个字符" });
  }
  if (!/^[0-9a-f]{64}$/.test(passwordHash)) {
    return res.status(400).json({ success: false, message: "密码哈希格式错误" });
  }

  if (isLoginRateLimited(canonical, req.ip || "unknown")) {
    return res.status(429).json({ success: false, message: "尝试次数过多，请稍后再试" });
  }

  const user = await findLoginUser(canonical);
  const storedHash = user ? user.password_hash : "0".repeat(64);
  const matched = passwordHashStore.matchesStoredHash(canonical, passwordHash, storedHash);

  if (!user || !user.is_active || !matched) {
    recordLoginFailure(canonical, req.ip || "unknown");
    await logOperation("main.login.failed", canonical, {}, req);
    return res.status(401).json({ success: false, message: AUTH_ERROR_MESSAGE });
  }

  clearLoginFailures(canonical, req.ip || "unknown");

  const session = await createSessionForUser(user.id, req);
  if (!session.success) {
    return res.status(500).json({ success: false, message: "服务器内部错误" });
  }
  await recordLoginHistory(user, session.token, req);

  // 更新最近登录时间（更新失败不影响登录结果）
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `UPDATE ${USERS_TABLE} SET last_login_at = ?, updated_at = ? WHERE id = ?`,
      [getUTC8Time(), getUTC8Time(), user.id]
    );
  } catch (err) {
    console.error("❌ 更新最近登录时间失败：", err.message);
  } finally {
    if (conn) conn.release();
  }

  await deleteExpiredSessions();

  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: Boolean(req.secure),
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
  await logOperation("main.login.success", canonical, {
    deviceLabel: parseDeviceLabel(req.headers && req.headers["user-agent"]),
  }, req);
  res.json({
    success: true,
    user: formatAuthUser({
      ...user,
      displayName: user.display_name,
      avatarData: user.avatar_data,
    }),
  });
});

// GET /api/auth/me —— 返回当前登录用户或 401
app.get("/api/auth/me", async (req, res) => {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  res.json({ success: true, user: formatAuthUser(user) });
});

// PUT /api/me/avatar —— 保存当前用户自定义头像
app.put("/api/me/avatar", requireApiAuth, async (req, res) => {
  const checked = validateAvatarData(req.body && req.body.avatarData);
  if (!checked.valid) {
    return res.status(400).json({ success: false, message: checked.error });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `UPDATE ${USERS_TABLE}
       SET avatar_data = ?, updated_at = ?
       WHERE id = ?`,
      [checked.value || null, getUTC8Time(), req.authUser.id]
    );
    await logOperation(
      checked.value ? "main.profile.avatar_update" : "main.profile.avatar_reset",
      req.authUser.account,
      {},
      req
    );
    res.json({
      success: true,
      message: checked.value ? "头像已更新" : "已恢复默认头像",
      user: formatAuthUser({ ...req.authUser, avatarData: checked.value }),
    });
  } catch (err) {
    console.error("❌ 保存头像失败：", err.message);
    res.status(500).json({ success: false, message: "保存头像失败" });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/me/login-history —— 当前用户的历史登录记录
app.get("/api/me/login-history", requireApiAuth, async (req, res) => {
  const history = await queryLoginHistory(req.authUser.id, req.query.limit);
  res.json({ success: true, history });
});

// GET /api/me/activity —— 当前用户自己的主系统操作日志
app.get("/api/me/activity", requireApiAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await operationLog.queryOperationLogsForAccount(
    pool,
    LOG_TABLE,
    req.authUser.account,
    { limit, offset }
  );
  if (!result.success) {
    return res.status(500).json({ success: false, message: "读取操作日志失败" });
  }
  res.json(result);
});

// POST /api/logout —— 删除会话与 Cookie
app.post("/api/logout", async (req, res) => {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }

  const token = getCookie(req, SESSION_COOKIE);
  if (token) await deleteSession(token);

  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: Boolean(req.secure),
    sameSite: "lax",
    path: "/",
  });
  await logOperation("main.logout", user.account, {}, req);
  res.json({ success: true });
});

// /add 路由 —— 返回添加待办的 HTML 表单页面（受保护）
app.get("/add", requirePageAuth, (req, res) => {
  const authUser = req.authUser;
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>添加待办任务</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 40px;
      width: 480px;
      max-width: 95vw;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 32px;
    }
    .top-bar h1 {
      text-align: left;
      margin-bottom: 0;
    }
    h1 {
      text-align: center;
      color: #1a1a2e;
      margin-bottom: 32px;
      font-size: 24px;
    }
    .auth-box {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .auth-account {
      font-size: 13px;
      color: #555;
    }
    .auth-logout {
      padding: 6px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #fff;
      color: #555;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    .auth-logout:hover {
      border-color: #4ECDC4;
      color: #4ECDC4;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-weight: 600;
      color: #333;
      margin-bottom: 6px;
      font-size: 14px;
    }
    input[type="text"],
    input[type="color"],
    textarea,
    select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
      background: #fafafa;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: #4ECDC4;
      background: #fff;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    /* 预设颜色按钮组 */
    .preset-colors {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .color-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border: 2px solid #d9d9d9;
      border-radius: 20px;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      transition: all 0.2s;
    }
    .color-chip:hover { border-color: #aaa; }
    .color-chip.active {
      border-color: #1a1a2e;
      box-shadow: 0 0 0 2px rgba(26,26,46,0.15);
      font-weight: 600;
    }
    .color-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .color-chip.custom-trigger {
      font-size: 16px;
      padding: 8px 12px;
    }
    .custom-color-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    input[type="color"] {
      width: 48px;
      height: 48px;
      padding: 2px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .color-hex {
      flex: 1;
      font-family: monospace;
    }
    select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      background: #fafafa;
      cursor: pointer;
    }
    select:focus { outline: none; border-color: #4ECDC4; background: #fff; }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .checkbox-row input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
    .readonly-info {
      background: #fffbe6;
      border: 1px solid #ffe58f;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 13px;
      color: #8c6d00;
      margin-bottom: 24px;
    }
    .btn {
      width: 100%;
      padding: 12px;
      background: #4ECDC4;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #3dbdb5; }
    .btn:active { background: #34a89f; }
    .result {
      margin-top: 16px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
    }
    .result.success { display: block; background: #f6ffed; border: 1px solid #b7eb8f; color: #389e0d; }
    .result.error   { display: block; background: #fff2f0; border: 1px solid #ffccc7; color: #cf1322; }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-bar">
      <h1>📋 添加待办任务</h1>
      ${buildAuthBarHtml(authUser)}
    </div>

    <!-- 提示：id、创建时间、更新时间由系统写入 -->
    <div class="readonly-info">
      ℹ️ <strong>id</strong>、<strong>创建时间</strong>、<strong>更新时间</strong> 由系统自动写入，无需手动填写。
    </div>

    <form id="todoForm">
      <!-- 标题 —— 必填 -->
      <div class="form-group">
        <label for="title">标题 <span style="color:red">*</span></label>
        <input type="text" id="title" name="title" placeholder="如：重构用户认证模块" required>
      </div>

      <!-- 描述 —— 具体事项 -->
      <div class="form-group">
        <label for="description">具体事项</label>
        <textarea id="description" name="description" placeholder="详细描述任务的具体内容……"></textarea>
      </div>

      <!-- 分类 -->
      <div class="form-group">
        <label for="category">分类</label>
        <select id="category" name="category" onchange="handleCategoryChange()">
          <option value="">-- 请选择分类 --</option>
          ${config.categories.map((c) => `          <option value="${c}">${c}</option>`).join("\n")}
          <option value="__custom__">✏️ 自定义分类……</option>
        </select>
        <input type="text" id="category_custom" name="category_custom"
               placeholder="输入自定义分类名称"
               style="margin-top:8px; display:none;"
               oninput="document.getElementById('category').value='__custom__'">
      </div>

      <!-- 颜色（紧急程度） -->
      <div class="form-group">
        <label>紧急程度</label>
        <div class="preset-colors">
          <button type="button" class="color-chip active" data-color="#AAAAAA" title="无">
            <span class="color-dot" style="background:#AAAAAA"></span>无
          </button>
          <button type="button" class="color-chip" data-color="#28A745" title="不急">
            <span class="color-dot" style="background:#28A745"></span>不急
          </button>
          <button type="button" class="color-chip" data-color="#007BFF" title="中等">
            <span class="color-dot" style="background:#007BFF"></span>中等
          </button>
          <button type="button" class="color-chip" data-color="#FFC107" title="紧急">
            <span class="color-dot" style="background:#FFC107"></span>紧急
          </button>
          <button type="button" class="color-chip" data-color="#DC3545" title="最高">
            <span class="color-dot" style="background:#DC3545"></span>最高
          </button>
          <button type="button" class="color-chip custom-trigger" id="customColorBtn" title="自定义颜色">
            🎨
          </button>
        </div>
        <div class="custom-color-row" id="customColorRow" style="display:none; margin-top:10px;">
          <input type="color" id="colorPicker" value="#AAAAAA">
          <input type="text" id="color" name="color" class="color-hex" placeholder="#AAAAAA" value="#AAAAAA" readonly>
        </div>
      </div>

      <!-- 是否已完成 -->
      <div class="form-group">
        <div class="checkbox-row">
          <input type="checkbox" id="completed" name="completed">
          <label for="completed" style="margin-bottom:0; cursor:pointer">已完成</label>
        </div>
      </div>

      <!-- 提交按钮 -->
      <button type="submit" class="btn" id="submitBtn">✅ 添加待办</button>
    </form>

    <!-- 操作结果提示 -->
    <div id="result" class="result"></div>
  </div>

  ${buildAuthScriptHtml(authUser)}
  <script>
    // ========== 预设颜色按钮组逻辑 ==========
    const colorChips = document.querySelectorAll(".color-chip");
    const colorInput = document.getElementById("color");
    const colorPicker = document.getElementById("colorPicker");
    const customColorRow = document.getElementById("customColorRow");
    const customColorBtn = document.getElementById("customColorBtn");

    // 当前选中的颜色值
    let selectedColor = "#AAAAAA";

    // 点击预设色块
    colorChips.forEach(function(chip) {
      chip.addEventListener("click", function() {
        // 如果点击的是自定义颜色按钮
        if (chip.id === "customColorBtn") {
          // 切换自定义颜色面板的显示
          if (customColorRow.style.display === "none") {
            customColorRow.style.display = "flex";
            customColorBtn.classList.add("active");
            // 取消其他色块的高亮
            colorChips.forEach(function(c) {
              if (c.id !== "customColorBtn") c.classList.remove("active");
            });
            // 同步颜色拾取器的值
            colorPicker.dispatchEvent(new Event("input"));
          } else {
            customColorRow.style.display = "none";
            customColorBtn.classList.remove("active");
            // 恢复到第一个预设色块
            colorChips[0].classList.add("active");
            selectedColor = colorChips[0].dataset.color;
            colorInput.value = selectedColor;
            colorPicker.value = selectedColor;
          }
          return;
        }

        // 普通色块：隐藏自定义面板
        customColorRow.style.display = "none";
        customColorBtn.classList.remove("active");

        // 切换高亮
        colorChips.forEach(function(c) { c.classList.remove("active"); });
        chip.classList.add("active");

        // 更新颜色值
        selectedColor = chip.dataset.color;
        colorInput.value = selectedColor;
        colorPicker.value = selectedColor;
      });
    });

    // 颜色拾取器变化时同步到隐藏字段
    colorPicker.addEventListener("input", function() {
      selectedColor = colorPicker.value;
      colorInput.value = colorPicker.value;
    });

    // ========== 分类自定义输入逻辑 ==========
    function handleCategoryChange() {
      // 此函数在 select onchange 中调用，全局作用域
    }
    const categorySelect = document.getElementById("category");
    const categoryCustomInput = document.getElementById("category_custom");

    categorySelect.addEventListener("change", function() {
      if (this.value === "__custom__") {
        categoryCustomInput.style.display = "block";
        categoryCustomInput.focus();
      } else {
        categoryCustomInput.style.display = "none";
        categoryCustomInput.value = "";
      }
    });

    // 表单提交
    document.getElementById("todoForm").addEventListener("submit", async function(e) {
      e.preventDefault();

      const submitBtn = document.getElementById("submitBtn");
      const resultDiv = document.getElementById("result");

      // 禁用按钮，防止重复提交
      submitBtn.disabled = true;
      submitBtn.textContent = "⏳ 提交中……";
      resultDiv.className = "result";
      resultDiv.textContent = "";

      // 收集表单数据
      // 分类：如果是自定义模式，取自定义输入值；否则取下拉选择值
      let categoryValue = document.getElementById("category").value;
      if (categoryValue === "__custom__") {
        categoryValue = document.getElementById("category_custom").value.trim();
      }
      const data = {
        title:       document.getElementById("title").value.trim(),
        description: document.getElementById("description").value.trim(),
        category:    categoryValue,
        color:       selectedColor,
        completed:   document.getElementById("completed").checked,
      };

      try {
        const response = await fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await response.json();

        if (result.success) {
          resultDiv.className = "result success";
          resultDiv.innerHTML =
            "✅ 待办添加成功！<br>" +
            "ID：" + result.data.id + " | " +
            "标题：" + result.data.title + "<br>" +
            "创建时间：" + result.data.createdAt;
          // 重置表单（恢复默认颜色和分类状态）
          document.getElementById("todoForm").reset();
          categoryCustomInput.style.display = "none";
          categoryCustomInput.value = "";
          customColorRow.style.display = "none";
          customColorBtn.classList.remove("active");
          colorChips.forEach(function(c) { c.classList.remove("active"); });
          colorChips[0].classList.add("active");
          selectedColor = "#AAAAAA";
          colorInput.value = "#AAAAAA";
          colorPicker.value = "#AAAAAA";
        } else {
          resultDiv.className = "result error";
          resultDiv.textContent = "❌ 添加失败：" + (result.error || "未知错误");
        }
      } catch (err) {
        resultDiv.className = "result error";
        resultDiv.textContent = "❌ 网络错误：" + err.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "✅ 添加待办";
      }
    });
  </script>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>
</body>
</html>
  `);
});

// /list 路由 —— 查看所有待办，可切换完成状态（受保护）
app.get("/list", requirePageAuth, (req, res) => {
  const authUser = req.authUser;
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>待办任务列表</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      padding: 32px 16px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 24px;
    }
    .header-actions {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .auth-box {
      display: flex; align-items: center; gap: 10px;
    }
    .auth-account {
      font-size: 13px; color: #555;
    }
    .auth-logout {
      padding: 6px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #fff;
      color: #555;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    .auth-logout:hover {
      border-color: #4ECDC4;
      color: #4ECDC4;
    }
    h1 { color: #1a1a2e; font-size: 24px; }
    .btn-add {
      padding: 10px 20px;
      background: #4ECDC4; color: #fff;
      border: none; border-radius: 8px;
      font-size: 14px; font-weight: 600;
      cursor: pointer; text-decoration: none;
      transition: background 0.2s;
    }
    .btn-add:hover { background: #3dbdb5; }
    .summary { color: #666; font-size: 14px; margin-bottom: 20px; }
    .todo-list { display: flex; flex-direction: column; gap: 12px; }
    .todo-card {
      background: #fff; border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      padding: 20px 24px; display: flex; align-items: flex-start;
      gap: 16px; transition: box-shadow 0.2s;
      cursor: pointer;
    }
    .todo-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
    .todo-card.completed { opacity: 0.6; }
    .todo-card.completed .todo-title { text-decoration: line-through; }
    /* 左侧色条 —— 表示紧急程度 */
    .color-bar {
      width: 6px; min-height: 60px; border-radius: 3px;
      flex-shrink: 0; align-self: stretch;
    }
    .todo-body { flex: 1; min-width: 0; }
    .todo-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .todo-title { font-size: 16px; font-weight: 600; color: #1a1a2e; }
    .todo-category {
      font-size: 12px; padding: 2px 10px; border-radius: 12px;
      background: #e8e8e8; color: #555; white-space: nowrap;
    }
    .todo-desc {
      font-size: 13px; color: #777; margin-bottom: 8px;
      line-height: 1.5;
    }
    .todo-meta { font-size: 12px; color: #aaa; }
    .todo-meta span { margin-right: 12px; }
    /* 完成状态切换按钮 */
    .toggle-btn {
      flex-shrink: 0; padding: 8px 16px;
      border: 2px solid #d9d9d9; border-radius: 20px;
      background: #fff; cursor: pointer;
      font-size: 13px; font-family: inherit;
      white-space: nowrap; transition: all 0.2s;
    }
    .toggle-btn:hover { border-color: #aaa; }
    .toggle-btn.done {
      border-color: #52c41a; background: #f6ffed; color: #389e0d;
    }
    .toggle-btn.undone {
      border-color: #ff7875; background: #fff2f0; color: #cf1322;
    }
    .toggle-btn.delete-btn {
      border-color: #ff4d4f; background: #fff2f0; color: #cf1322;
    }
    .toggle-btn.delete-btn:hover { background: #ffccc7; }
    .loading { text-align: center; padding: 40px; color: #aaa; }
    .empty { text-align: center; padding: 60px 20px; color: #aaa; }
    .empty-icon { font-size: 48px; margin-bottom: 12px; }
    .error { text-align: center; padding: 40px; color: #cf1322; }
    @media (max-width: 600px) {
      .header {
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
      }
      .header-actions {
        width: 100%;
        justify-content: flex-end;
        gap: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📋 待办任务列表</h1>
      <div class="header-actions">
        ${buildAuthBarHtml(authUser)}
        <a href="/add" class="btn-add">+ 添加待办</a>
      </div>
    </div>

    <div class="summary" id="summary"></div>

    <!-- 加载中 -->
    <div class="loading" id="loading">⏳ 正在加载待办列表……</div>

    <!-- 空状态 -->
    <div class="empty" id="empty" style="display:none;">
      <div class="empty-icon">📭</div>
      <p>还没有待办任务</p>
      <p style="margin-top:8px;"><a href="/add">去添加第一个待办 →</a></p>
    </div>

    <!-- 错误提示 -->
    <div class="error" id="error" style="display:none;"></div>

    <!-- 待办列表容器 -->
    <div class="todo-list" id="todoList"></div>
  </div>

  ${buildAuthScriptHtml(authUser)}
  <script>
    const CAN_DELETE = ${!!authUser && authUser.level === "admin"};

    // 紧急程度颜色映射表（中文标签）
    const URGENCY_MAP = ${JSON.stringify(config.urgencyMap)};

    // 加载待办列表
    async function loadTodos() {
      const loadingEl = document.getElementById("loading");
      const emptyEl   = document.getElementById("empty");
      const errorEl   = document.getElementById("error");
      const listEl    = document.getElementById("todoList");
      const summaryEl = document.getElementById("summary");

      loadingEl.style.display = "block";
      emptyEl.style.display = "none";
      errorEl.style.display = "none";
      listEl.innerHTML = "";

      try {
        const response = await fetch("/api/todos");
        const result = await response.json();

        if (!result.success) {
          errorEl.textContent = "❌ 加载失败：" + (result.error || "未知错误");
          errorEl.style.display = "block";
          loadingEl.style.display = "none";
          return;
        }

        const todos = result.data;
        if (todos.length === 0) {
          emptyEl.style.display = "block";
          loadingEl.style.display = "none";
          return;
        }

        // 统计信息
        const doneCount = todos.filter(function(t) { return t.completed; }).length;
        summaryEl.textContent = "共 " + todos.length + " 个任务，已完成 " + doneCount + " 个";

        // 渲染卡片
        todos.forEach(function(todo) {
          const urgency = URGENCY_MAP[todo.color] || { label: "其他", cssColor: todo.color || "#AAAAAA" };
          const colorHex = todo.color || "#AAAAAA";
          const isCompleted = todo.completed;

          const card = document.createElement("div");
          card.className = "todo-card" + (isCompleted ? " completed" : "");
          card.id = "todo-" + todo.id;

          card.innerHTML =
            '<div class="color-bar" style="background:' + colorHex + '; min-height:60px;"></div>' +
            '<div class="todo-body">' +
              '<div class="todo-header">' +
                '<span class="todo-title">' + escapeHtml(todo.title) + '</span>' +
                (todo.category
                  ? '<span class="todo-category">' + escapeHtml(todo.category) + '</span>'
                  : '') +
              '</div>' +
              (todo.description
                ? '<div class="todo-desc">' + escapeHtml(todo.description) + '</div>'
                : '') +
              '<div class="todo-meta">' +
                '<span>ID: ' + todo.id + '</span>' +
                '<span>紧急: ' + urgency.label + '</span>' +
                '<span>创建于 ' + formatTime(todo.createdAt) + '</span>' +
              '</div>' +
            '</div>' +
            '<button class="toggle-btn ' + (isCompleted ? "done" : "undone") + '" ' +
              'onclick="toggleStatus(' + todo.id + ', this)" title="点击切换完成状态">' +
              (isCompleted ? "✅ 已完成" : "⬜ 未完成") +
            '</button>' +
            (CAN_DELETE
              ? '<button class="toggle-btn delete-btn" onclick="deleteTodo(' + todo.id + ', this, event)" title="删除待办">🗑 删除</button>'
              : '');

          // 点击卡片跳转到待办详情页（/:id）
          card.addEventListener("click", function(e) {
            // 如果点击的是切换按钮则不跳转
            if (e.target.closest(".toggle-btn")) return;
            window.location.href = "/" + todo.id;
          });

          listEl.appendChild(card);
        });

        loadingEl.style.display = "none";
      } catch (err) {
        errorEl.textContent = "❌ 网络错误：" + err.message;
        errorEl.style.display = "block";
        loadingEl.style.display = "none";
      }
    }

    // 删除待办
    async function deleteTodo(id, btn, evt) {
      if (evt) evt.stopPropagation();
      if (!confirm("确认删除 ID=" + id + " 的待办任务？此操作不可恢复。")) return;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "⏳……";
      try {
        var response = await fetch("/api/todos/" + id, { method: "DELETE" });
        var result = await response.json();
        if (result.success) {
          var card = document.getElementById("todo-" + id);
          if (card) card.remove();
          var cards = document.querySelectorAll(".todo-card");
          var doneCards = document.querySelectorAll(".todo-card.completed");
          document.getElementById("summary").textContent = "共 " + cards.length + " 个任务，已完成 " + doneCards.length + " 个";
          if (cards.length === 0) {
            document.getElementById("empty").style.display = "block";
          }
        } else {
          alert("删除失败：" + (result.error || "未知错误"));
          btn.disabled = false;
          btn.textContent = "🗑 删除";
        }
      } catch (err) {
        alert("网络错误：" + err.message);
        btn.disabled = false;
        btn.textContent = "🗑 删除";
      }
    }

    // 切换待办状态
    async function toggleStatus(id, btn) {
      // 防止重复点击
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "⏳……";

      try {
        const response = await fetch("/api/todos/" + id, { method: "PATCH" });
        const result = await response.json();

        if (!result.success) {
          alert("操作失败：" + (result.error || "未知错误"));
          btn.disabled = false;
          btn.textContent = btn.classList.contains("done") ? "✅ 已完成" : "⬜ 未完成";
          return;
        }

        const todo = result.data;
        const card = document.getElementById("todo-" + id);

        if (todo.completed) {
          card.classList.add("completed");
          btn.classList.remove("undone");
          btn.classList.add("done");
          btn.textContent = "✅ 已完成";
        } else {
          card.classList.remove("completed");
          btn.classList.remove("done");
          btn.classList.add("undone");
          btn.textContent = "⬜ 未完成";
        }

        // 更新统计
        const cards = document.querySelectorAll(".todo-card.completed");
        const total = document.querySelectorAll(".todo-card").length;
        document.getElementById("summary").textContent =
          "共 " + total + " 个任务，已完成 " + cards.length + " 个";

        btn.disabled = false;
      } catch (err) {
        alert("网络错误：" + err.message);
        btn.disabled = false;
        btn.textContent = btn.classList.contains("done") ? "✅ 已完成" : "⬜ 未完成";
      }
    }

    // HTML 转义，防止 XSS
    function escapeHtml(text) {
      var div = document.createElement("div");
      div.appendChild(document.createTextNode(text));
      return div.innerHTML;
    }

    // 格式化时间
    function formatTime(isoStr) {
      if (!isoStr) return "";
      var d = new Date(isoStr);
      var month = String(d.getMonth() + 1).padStart(2, "0");
      var day   = String(d.getDate()).padStart(2, "0");
      var hours = String(d.getHours()).padStart(2, "0");
      var mins  = String(d.getMinutes()).padStart(2, "0");
      return month + "-" + day + " " + hours + ":" + mins;
    }

    // 页面加载时获取列表
    loadTodos();
  </script>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>

  <div style="position:fixed; bottom:0; left:0; width:100%; text-align:center; color:#aaa; font-size:12px; padding:12px 0; background:#fff; z-index:9999; box-shadow:0 -2px 8px rgba(0,0,0,0.06);">EBS Workstation Todo List By PRC-Leo</div>
</body>
</html>
  `);
});

// POST /api/todos —— 接收待办数据并写入数据库
app.post("/api/todos", requireApiAuth, async (req, res) => {
  const { title, description, category, color, completed } = req.body;

  // 校验：标题为必填项
  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, error: "标题为必填项，请填写任务标题。" });
  }

  // 调用写入函数
  const result = await insertTodo({
    title: title.trim(),
    description: description ? description.trim() : "",
    category: category ? category.trim() : "",
    color: color ? color.trim() : "",
    completed: completed || false,
  });

  if (result.success) {
    await logOperation("main.todo.create", req.authUser.account, {
      todoId: result.data.id,
      title: result.data.title,
    }, req);
    res.status(201).json(result);
  } else {
    res.status(500).json(result);
  }
});

// GET /api/todos —— 获取所有待办列表
app.get("/api/todos", requireApiAuth, async (req, res) => {
  const result = await getAllTodos();
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// PATCH /api/todos/:id —— 切换待办完成状态
app.patch("/api/todos/:id", requireApiAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: "无效的 ID" });
  }
  const result = await toggleTodoStatus(id);
  if (result.success) {
    await logOperation("main.todo.toggle", req.authUser.account, {
      todoId: result.data.id,
      title: result.data.title,
      completed: result.data.completed,
    }, req);
    res.json(result);
  } else {
    res.status(result.error.includes("未找到") ? 404 : 500).json(result);
  }
});

// GET /api/todos/:id —— 根据 ID 获取单条待办（JSON）
app.get("/api/todos/:id", requireApiAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: "无效的 ID" });
  }
  const result = await getTodoById(id);
  if (result.success) {
    res.json(result);
  } else {
    res.status(404).json(result);
  }
});

// PUT /api/todos/:id —— 更新待办字段（标题/描述/分类/颜色/状态）
app.put("/api/todos/:id", requireApiAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: "无效的 ID" });
  }
  const fields = {};
  if (req.body.title !== undefined) fields.title = req.body.title;
  if (req.body.description !== undefined) fields.description = req.body.description;
  if (req.body.category !== undefined) fields.category = req.body.category;
  if (req.body.color !== undefined) fields.color = req.body.color;
  if (req.body.completed !== undefined) fields.completed = req.body.completed;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ success: false, error: "请至少提供一个要更新的字段" });
  }

  const result = await updateTodo(id, fields);
  if (result.success) {
    await logOperation("main.todo.update", req.authUser.account, {
      todoId: result.data.id,
      title: result.data.title,
      changes: Object.keys(fields),
    }, req);
    res.json(result);
  } else {
    res.status(result.error.includes("未找到") ? 404 : 500).json(result);
  }
});

// DELETE /api/todos/:id —— 删除待办任务（仅管理员）
app.delete("/api/todos/:id", requireAdminApi, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: "无效的 ID" });
  const result = await deleteTodo(id);
  if (result.success) {
    await logOperation("main.todo.delete", req.authUser.account, {
      todoId: id,
      title: result.title,
    }, req);
    res.json(result);
  } else {
    res.status(result.error.includes("未找到") ? 404 : 500).json(result);
  }
});

// /:id 路由 —— 待办详情页面
app.get("/:id", requirePageAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send("<h1>无效的 ID</h1>");
  }
  const result = await getTodoById(id);
  if (!result.success) {
    return res.status(404).send(buildNotFoundPage(id));
  }
  res.send(buildDetailPage(result.data, req.authUser));
});

// 健康检查接口
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ------------------------------------------------------------
// 15. 404 处理 —— 未匹配到任何路由时
// ------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "接口不存在", path: req.originalUrl });
});

// ------------------------------------------------------------
// 16. 全局错误处理中间件
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("服务器内部错误：", err.message);
  res.status(500).json({ error: "服务器内部错误", detail: err.message });
});

// ------------------------------------------------------------
// 17. 启动服务器（HTTP / HTTPS）
// ------------------------------------------------------------
const PORT = config.port;
const httpsConfig = config.https || { enabled: false };

// 计算完整访问地址（带协议与端口）
function buildAccessUrl(protocol, urlPath) {
  const defaultPort = protocol === "https" ? 443 : 80;
  const portPart = PORT === defaultPort ? "" : ":" + PORT;
  return `${protocol}://localhost${portPart}${urlPath}`;
}

// 启动后初始化：测试数据库连接 + 自动建表
async function afterStart() {
  await testDatabaseConnection();
  await initDatabase();
  await deleteExpiredSessions();
}

function listenWithFriendlyError(server, port, label) {
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`❌ ${label}端口 ${port} 已被占用，请先关闭正在运行的实例再启动。`);
      process.exit(1);
    }
    throw err;
  });
  return server;
}

if (httpsConfig.enabled) {
  // -------- HTTPS 模式 --------
  let tlsOptions = null;
  try {
    const key = fs.readFileSync(path.join(__dirname, httpsConfig.keyPath));
    const cert = fs.readFileSync(path.join(__dirname, httpsConfig.certPath));
    tlsOptions = { key, cert };
  } catch (err) {
    console.error("❌ 读取 HTTPS 证书失败：" + err.message);
    console.error("   请检查 config.https.keyPath / certPath 是否存在。");
    console.error("   ⚠️ 暂回退为 HTTP 模式启动。");
  }

  if (tlsOptions) {
    // HTTPS 主服务
    listenWithFriendlyError(https.createServer(tlsOptions, app), PORT, "主系统").listen(PORT, async () => {
      console.log("============================================");
      console.log("🚀 Todo List 后端服务启动完毕（HTTPS）！");
      console.log("🔒 HTTPS 已启用（自签名证书）。");
      console.log(`📍 访问地址：${buildAccessUrl("https", "")}`);
      console.log(`📋 添加待办：${buildAccessUrl("https", "/add")}`);
      console.log(`📖 待办列表：${buildAccessUrl("https", "/list")}`);
      console.log(`🔐 用户登录：${buildAccessUrl("https", "/login")}`);
      console.log("   首次访问浏览器会提示证书不受信任，点击「高级 → 继续」即可。");
      console.log("============================================");
      await afterStart();
    });

    // 可选：HTTP → HTTPS 跳转服务
    if (httpsConfig.redirectHttp) {
      const redirPort = httpsConfig.httpRedirectPort || 8080;
      listenWithFriendlyError(http.createServer((req, res) => {
        const host = (req.headers.host || "localhost").split(":")[0];
        const portPart = PORT === 443 ? "" : ":" + PORT;
        const target = "https://" + host + portPart + req.url;
        res.writeHead(301, { Location: target, "Content-Length": "0" });
        res.end();
      }), redirPort, "主系统 HTTP 跳转").listen(redirPort, () => {
        const fromPart = redirPort === 80 ? "" : ":" + redirPort;
        const toPart = PORT === 443 ? "" : ":" + PORT;
        console.log(`↩️  HTTP→HTTPS 跳转服务已启动：http://localhost${fromPart} → https://localhost${toPart}`);
      });
    }
  } else {
    // 证书缺失：回退 HTTP
    listenWithFriendlyError(app, PORT, "主系统").listen(PORT, async () => {
      console.log("============================================");
      console.log("🚀 Todo List 后端服务启动完毕（HTTP 回退模式）！");
      console.log(`📍 访问地址：${buildAccessUrl("http", "")}`);
      console.log(`📋 添加待办：${buildAccessUrl("http", "/add")}`);
      console.log(`📖 待办列表：${buildAccessUrl("http", "/list")}`);
      console.log("   ⚠️ HTTP 回退模式下登录存在安全风险，请使用 HTTPS 访问 /login。");
      console.log("============================================");
      await afterStart();
    });
  }
} else {
  // -------- HTTP 模式（保持原行为）--------
  listenWithFriendlyError(app, PORT, "主系统").listen(PORT, async () => {
    console.log("============================================");
    console.log("🚀 Todo List 后端服务启动完毕！");
    console.log(`📍 访问地址：${buildAccessUrl("http", "")}`);
    console.log(`📋 添加待办：${buildAccessUrl("http", "/add")}`);
    console.log(`📖 待办列表：${buildAccessUrl("http", "/list")}`);
    console.log("   ⚠️ HTTP 模式下登录存在安全风险，请配置 HTTPS 后再启用登录。");
    console.log("============================================");
    await afterStart();
  });
}
