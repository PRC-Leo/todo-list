// ============================================================
// 统一操作日志
// 只记录主系统操作并保存在数据库表中，只保存结构化原文；
// 中文自然语言翻译由管理后台前端根据 raw_log 动态生成。
// ============================================================

function normalizeSource(source) {
  return source === "admin" ? "admin" : "main";
}

function truncateText(value, maxLength) {
  const text = String(value === null || value === undefined ? "" : value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function buildRawOperationLog(entry) {
  return JSON.stringify(
    {
      source: normalizeSource(entry.source),
      account: entry.account || "",
      action: entry.action,
      details: entry.details || {},
      ipAddress: entry.ipAddress || "",
      location: entry.location || "",
    },
    null,
    2
  );
}

async function ensureOperationLogTable(conn, table) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '日志ID',
      source      ENUM('main','admin') NOT NULL DEFAULT 'main' COMMENT '日志来源',
      account     VARCHAR(64) NOT NULL DEFAULT '' COMMENT '操作账号',
      action      VARCHAR(64) NOT NULL COMMENT '操作标识',
      raw_log     TEXT NOT NULL COMMENT '日志原文',
      ip_address  VARCHAR(64) NULL COMMENT '操作IP',
      location    VARCHAR(200) NULL COMMENT 'IP定位',
      created_at  DATETIME NOT NULL COMMENT '操作时间（UTC+8）',
      INDEX idx_operation_logs_created (created_at),
      INDEX idx_operation_logs_source (source),
      INDEX idx_operation_logs_account (account)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='统一操作日志表';
  `);

  const columns = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  const hasZhColumn = (columns || []).some((row) => row.name === "zh_log");
  if (hasZhColumn) {
    try {
      await conn.query(`ALTER TABLE ${table} DROP COLUMN zh_log`);
      console.log(`⬆️ 数据表 ${table} 已移除 zh_log 列，翻译改由前端生成。`);
    } catch (err) {
      if (err && err.code !== "ER_CANT_DROP_FIELD_OR_KEY") throw err;
    }
  }
}

function buildClockString(offsetHours) {
  const offset = (Number.isFinite(offsetHours) ? offsetHours : 8) * 60 * 60 * 1000;
  return new Date(Date.now() + offset).toISOString().replace("T", " ").substring(0, 19);
}

async function writeOperationLog(options) {
  if (!options || !options.pool || !options.table || !options.action) return;

  const source = normalizeSource(options.source);
  let conn;
  try {
    conn = await options.pool.getConnection();
    await conn.query(
      `INSERT INTO ${options.table}
        (source, account, action, raw_log, ip_address, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        source,
        truncateText(options.account, 64),
        truncateText(options.action, 64),
        buildRawOperationLog(options),
        truncateText(options.ipAddress, 64),
        truncateText(options.location, 200),
        options.createdAt || buildClockString(options.timezoneOffsetHours),
      ]
    );
  } catch (err) {
    console.error("❌ 写入操作日志失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

function formatDateValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function formatOperationLogRow(row) {
  return {
    id: Number(row.id),
    source: row.source,
    account: row.account || "",
    action: row.action,
    raw: row.raw_log || "",
    ipAddress: row.ip_address || "",
    location: row.location || "",
    createdAt: formatDateValue(row.created_at),
  };
}

async function queryOperationLogs(pool, table, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 500));
  const offset = Math.max(0, Number(opts.offset) || 0);
  let conn;
  try {
    conn = await pool.getConnection();
    const [countRow] = await conn.query(`SELECT COUNT(*) AS total FROM ${table}`);
    const rows = await conn.query(
      `SELECT id, source, account, action, raw_log, ip_address, location, created_at
       FROM ${table}
       ORDER BY id DESC
       LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`
    );
    return {
      success: true,
      total: Number(countRow && countRow.total) || 0,
      logs: rows.map(formatOperationLogRow),
    };
  } catch (err) {
    console.error("❌ 查询操作日志失败：", err.message);
    return { success: false, error: err.message, total: 0, logs: [] };
  } finally {
    if (conn) conn.release();
  }
}

async function queryOperationLogsForAccount(pool, table, account, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  const offset = Math.max(0, Number(opts.offset) || 0);
  let conn;
  try {
    conn = await pool.getConnection();
    const [countRow] = await conn.query(
      `SELECT COUNT(*) AS total FROM ${table}
       WHERE source = 'main' AND account = ?`,
      [account]
    );
    const rows = await conn.query(
      `SELECT id, source, account, action, raw_log, ip_address, location, created_at
       FROM ${table}
       WHERE source = 'main' AND account = ?
       ORDER BY id DESC
       LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
      [account]
    );
    return {
      success: true,
      total: Number(countRow && countRow.total) || 0,
      logs: rows.map(formatOperationLogRow),
    };
  } catch (err) {
    console.error("❌ 查询用户操作日志失败：", err.message);
    return { success: false, error: err.message, total: 0, logs: [] };
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  ensureOperationLogTable,
  writeOperationLog,
  queryOperationLogs,
  queryOperationLogsForAccount,
  buildClockString,
};
