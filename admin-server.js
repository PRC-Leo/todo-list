// ============================================================
// EBS 管理后台独立服务
// 与主系统共用 config/config.js、MariaDB 和 HTTPS 证书。
// 独立端口运行，登录逻辑与主系统一致：
//   前端计算 SHA-256(规范化账号 + ":" + 密码)，后端只接收哈希。
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

const app = express();
app.disable("x-powered-by");

// 解析 JSON 与 URL 编码请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求体不是合法 JSON 时返回 400
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "请求体不是合法 JSON" });
  }
  next(err);
});

// ------------------------------------------------------------
// 配置读取
// ------------------------------------------------------------
const ADMIN = config.admin || {};
const ADMIN_PORT = ADMIN.port || 6768;
const ADMIN_HTTPS = ADMIN.https || { enabled: false };
const ADMIN_USERS_TABLE = ADMIN.usersTable || "admin_users";
const ADMIN_SESSIONS_TABLE = ADMIN.sessionsTable || "admin_sessions";
const ADMIN_COOKIE = ADMIN.cookieName || "admin_sid";
const ADMIN_SESSION_DAYS = ADMIN.sessionDays || 7;
const ADMIN_LOCATION_LOOKUP = ADMIN.locationLookup !== false;
const TIMEZONE_OFFSET_HOURS = config.timezoneOffsetHours === undefined ? 8 : config.timezoneOffsetHours;
const LOGGING = config.logging || {};
const LOG_TABLE = LOGGING.table || "operation_logs";

// 后台管理的数据对象：主系统的登录用户与会话表
const AUTH = config.auth || {};
const MANAGED_USERS_TABLE = AUTH.usersTable || "users";
const MANAGED_SESSIONS_TABLE = AUTH.sessionsTable || "sessions";

const AUTH_ERROR_MESSAGE = "账号或密码错误";
const AUTH_UNAUTHORIZED_MESSAGE = "未登录";

// ------------------------------------------------------------
// MariaDB 连接池
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

// ------------------------------------------------------------
// 时间工具（UTC+8）
// ------------------------------------------------------------
function getUTC8Time() {
  const offsetMs = TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  const utc8 = new Date(Date.now() + offsetMs);
  return utc8.toISOString().replace("T", " ").substring(0, 19);
}

function getUTC8TimeAfterDays(days) {
  const offsetMs = TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + offsetMs);
  return future.toISOString().replace("T", " ").substring(0, 19);
}

// ------------------------------------------------------------
// 密码哈希与账号规范化（与主系统完全一致）
// ------------------------------------------------------------
function canonicalAccount(account) {
  return String(account || "").trim().toLowerCase();
}

// ------------------------------------------------------------
// Cookie 解析
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 设备识别与 IP 定位
// ------------------------------------------------------------
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
  if (!ADMIN_LOCATION_LOOKUP) return "";
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
  if (/Windows NT 10\.0/.test(text)) os = "Windows";
  else if (/Windows/.test(text)) os = "Windows";
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

// ------------------------------------------------------------
// 数据库初始化与测试
// ------------------------------------------------------------
async function testDatabaseConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log("✅ 管理后台数据库连接成功！");
    console.log(`   主机：${config.db.host}:${config.db.port} | 数据库：${config.db.database}`);
  } catch (err) {
    console.error("❌ 管理后台数据库连接失败：", err.message);
    console.error("   请确保 MariaDB 服务已启动，且数据库 " + config.db.database + " 已创建。");
  } finally {
    if (conn) conn.release();
  }
}

// 确保主系统认证表存在并包含管理所需的字段
async function ensureManagedAuthSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${MANAGED_USERS_TABLE} (
      id            INT AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID，自增主键',
      account       VARCHAR(64) NOT NULL UNIQUE COMMENT '规范化账号',
      password_hash VARCHAR(128) NOT NULL COMMENT '后端二次哈希 v2:+SHA-256(account:clientHash)',
      display_name  VARCHAR(50) NULL COMMENT '展示名称',
      is_active     BOOLEAN DEFAULT TRUE COMMENT '账号是否启用',
      \`level\`     ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别',
      created_at    DATETIME NOT NULL COMMENT '创建时间（UTC+8）',
      updated_at    DATETIME NOT NULL COMMENT '更新时间（UTC+8）',
      last_login_at DATETIME NULL COMMENT '最近登录时间（UTC+8）'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='主系统登录用户表';
  `);
  console.log(`✅ 主系统用户表 ${MANAGED_USERS_TABLE} 已就绪（${config.db.database}.${MANAGED_USERS_TABLE}）。`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${MANAGED_SESSIONS_TABLE} (
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
        REFERENCES ${MANAGED_USERS_TABLE}(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='主系统登录会话表';
  `);
  console.log(`✅ 主系统会话表 ${MANAGED_SESSIONS_TABLE} 已就绪（${config.db.database}.${MANAGED_SESSIONS_TABLE}）。`);

  const dbName = config.db.database;
  const userCols = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, MANAGED_USERS_TABLE]
  );
  const userColSet = new Set((userCols || []).map((row) => row.name));
  if (!userColSet.has("level")) {
    try {
      await conn.query(
        `ALTER TABLE ${MANAGED_USERS_TABLE}
         ADD COLUMN \`level\` ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别' AFTER \`is_active\``
      );
      console.log(`⬆️ 数据表 ${MANAGED_USERS_TABLE} 已补充 level 字段。`);
    } catch (err) {
      if (err && err.code === "ER_DUP_FIELDNAME") return;
      throw err;
    }
  }

  const sessionCols = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, MANAGED_SESSIONS_TABLE]
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
        `ALTER TABLE ${MANAGED_SESSIONS_TABLE} ADD COLUMN ${columnName} ${definition} AFTER expires_at`
      );
      console.log(`⬆️ 数据表 ${MANAGED_SESSIONS_TABLE} 已补充 ${columnName} 字段。`);
    } catch (err) {
      if (err && err.code === "ER_DUP_FIELDNAME") continue;
      throw err;
    }
  }
}

async function initDatabase() {
  let conn;
  try {
    conn = await pool.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${ADMIN_USERS_TABLE} (
        id            INT AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
        account       VARCHAR(64) NOT NULL UNIQUE COMMENT '规范化账号',
        password_hash VARCHAR(128) NOT NULL COMMENT '后端二次哈希 v2:+SHA-256(account:clientHash)',
        \`level\`     ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别',
        created_at    DATETIME NOT NULL COMMENT '创建时间（UTC+8）',
        updated_at    DATETIME NOT NULL COMMENT '更新时间（UTC+8）',
        last_login_at DATETIME NULL COMMENT '最近登录时间（UTC+8）'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理后台用户表';
    `);
    console.log(`✅ 数据表 ${ADMIN_USERS_TABLE} 已就绪（${config.db.database}.${ADMIN_USERS_TABLE}）。`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${ADMIN_SESSIONS_TABLE} (
        token          CHAR(64) PRIMARY KEY COMMENT '随机会话令牌',
        user_id        INT NOT NULL COMMENT '关联用户ID',
        device_label   VARCHAR(200) NULL COMMENT '解析后的设备名称',
        user_agent     VARCHAR(500) NULL COMMENT '原始 User-Agent',
        ip_address     VARCHAR(64) NULL COMMENT '登录IP',
        location       VARCHAR(200) NULL COMMENT 'IP定位',
        created_at     DATETIME NOT NULL COMMENT '会话创建时间（UTC+8）',
        expires_at     DATETIME NOT NULL COMMENT '会话过期时间（UTC+8）',
        last_active_at DATETIME NULL COMMENT '最近活跃时间（UTC+8）',
        INDEX idx_admin_sessions_user (user_id),
        INDEX idx_admin_sessions_expired (expires_at),
        CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id)
          REFERENCES ${ADMIN_USERS_TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理后台登录设备/会话表';
    `);
    console.log(`✅ 数据表 ${ADMIN_SESSIONS_TABLE} 已就绪（${config.db.database}.${ADMIN_SESSIONS_TABLE}）。`);

    await ensureManagedAuthSchema(conn);

    await passwordHashStore.ensurePasswordHashColumn(conn, ADMIN_USERS_TABLE);
    const adminPasswordMigration = await passwordHashStore.migrateLegacyPasswordHashes(conn, ADMIN_USERS_TABLE);
    if (adminPasswordMigration.migrated > 0) {
      console.log(`🔐 数据表 ${ADMIN_USERS_TABLE} 已完成 ${adminPasswordMigration.migrated} 条密码哈希二次加密迁移。`);
    }
    await passwordHashStore.ensurePasswordHashColumn(conn, MANAGED_USERS_TABLE);
    const managedPasswordMigration = await passwordHashStore.migrateLegacyPasswordHashes(conn, MANAGED_USERS_TABLE);
    if (managedPasswordMigration.migrated > 0) {
      console.log(`🔐 数据表 ${MANAGED_USERS_TABLE} 已完成 ${managedPasswordMigration.migrated} 条密码哈希二次加密迁移。`);
    }
    const skippedAccounts = adminPasswordMigration.skipped.concat(managedPasswordMigration.skipped);
    if (skippedAccounts.length > 0) {
      console.warn(`⚠️ 有 ${skippedAccounts.length} 条非标准哈希记录未迁移：${skippedAccounts.join("、")}`);
    }

    if (LOGGING.enabled) {
      await operationLog.ensureOperationLogTable(conn, LOG_TABLE);
      console.log(`✅ 操作日志表 ${LOG_TABLE} 已就绪。`);
    }

    const [countRow] = await conn.query(`SELECT COUNT(*) AS total FROM ${ADMIN_USERS_TABLE}`);
    const total = Number(countRow && countRow.total);
    if (total === 0) {
      const initial = ADMIN.initialAdmin || {};
      if (initial.account && initial.password) {
        const account = canonicalAccount(initial.account);
        const clientHash = passwordHashStore.hashPassword(account, String(initial.password));
        const passwordHash = passwordHashStore.createStoredHash(account, clientHash);
        const now = getUTC8Time();
        await conn.query(
          `INSERT INTO ${ADMIN_USERS_TABLE} (account, password_hash, \`level\`, created_at, updated_at)
           VALUES (?, ?, 'admin', ?, ?)`,
          [account, passwordHash, now, now]
        );
        console.log(`✅ 已创建初始管理员账号：${account}`);
      } else {
        console.log("⚠️ 用户表为空且未配置 initialAdmin，请手动写入管理员账号。");
      }
    }
  } catch (err) {
    console.error("❌ 管理后台数据库初始化失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 用户与会话数据访问
// ------------------------------------------------------------
async function findAdminUser(account) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
      `SELECT id, account, password_hash, \`level\`, created_at, updated_at, last_login_at
       FROM ${ADMIN_USERS_TABLE} WHERE account = ?`,
      [account]
    );
    return row || null;
  } catch (err) {
    console.error("❌ 查询管理后台用户失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

async function createAdminSession(userId, req) {
  let conn;
  try {
    conn = await pool.getConnection();
    const token = crypto.randomBytes(32).toString("hex");
    const rawUa = String(req.headers["user-agent"] || "");
    const userAgent = rawUa.slice(0, 500);
    const ipAddress = getClientIp(req);
    const location = lookupDeviceLocation(ipAddress);
    await conn.query(
      `INSERT INTO ${ADMIN_SESSIONS_TABLE}
        (token, user_id, device_label, user_agent, ip_address, location, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token,
        userId,
        parseDeviceLabel(userAgent),
        userAgent,
        ipAddress,
        location,
        getUTC8Time(),
        getUTC8TimeAfterDays(ADMIN_SESSION_DAYS),
        getUTC8Time(),
      ]
    );
    return { success: true, token };
  } catch (err) {
    console.error("❌ 创建管理后台会话失败：", err.message);
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function findAdminSessionWithUser(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
      `SELECT s.token, s.expires_at,
              u.id AS uid, u.account, u.\`level\`
       FROM ${ADMIN_SESSIONS_TABLE} s
       INNER JOIN ${ADMIN_USERS_TABLE} u ON u.id = s.user_id
       WHERE s.token = ?`,
      [token]
    );
    if (!row) return null;
    return {
      token: row.token,
      expires_at: row.expires_at,
      uid: row.uid,
      account: row.account,
      level: row.level,
    };
  } catch (err) {
    console.error("❌ 查询管理后台会话失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

async function findAdminSessionOnly(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
      `SELECT token, user_id FROM ${ADMIN_SESSIONS_TABLE}
       WHERE token = ? AND expires_at >= ?`,
      [token, getUTC8Time()]
    );
    return row || null;
  } catch (err) {
    console.error("❌ 查询管理后台会话失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

async function deleteAdminSession(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`DELETE FROM ${ADMIN_SESSIONS_TABLE} WHERE token = ?`, [token]);
    sessionTouchTimes.delete(token);
  } catch (err) {
    console.error("❌ 删除管理后台会话失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

async function deleteExpiredAdminSessions() {
  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `DELETE FROM ${ADMIN_SESSIONS_TABLE} WHERE expires_at < ?`,
      [getUTC8Time()]
    );
    const affected = Number(result.affectedRows || 0);
    if (affected > 0) {
      console.log(`🧹 已清理 ${affected} 条过期管理会话。`);
    }
  } catch (err) {
    console.error("❌ 清理管理后台过期会话失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// 登录后每 60 秒刷新一次最近活跃时间，避免每次请求都写库
const SESSION_TOUCH_WINDOW_MS = 60 * 1000;
const sessionTouchTimes = new Map();

async function touchAdminSession(token) {
  const now = Date.now();
  if (now - (sessionTouchTimes.get(token) || 0) < SESSION_TOUCH_WINDOW_MS) return;
  sessionTouchTimes.set(token, now);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `UPDATE ${ADMIN_SESSIONS_TABLE} SET last_active_at = ? WHERE token = ?`,
      [getUTC8Time(), token]
    );
  } catch {
    // 活跃时间刷新失败不阻断请求
  } finally {
    if (conn) conn.release();
  }
}

function isExpiredValue(value) {
  if (value instanceof Date) return value.getTime() < Date.now();
  const text = String(value).replace(" ", "T");
  return new Date(text).getTime() < Date.now();
}

async function authenticateRequest(req) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return null;

  const session = await findAdminSessionWithUser(token);
  if (!session) return null;
  if (isExpiredValue(session.expires_at)) {
    await deleteAdminSession(token);
    return null;
  }

  touchAdminSession(token);
  return {
    id: session.uid,
    account: session.account,
    level: session.level,
    token: session.token,
  };
}

// ------------------------------------------------------------
// 登录失败限速：账号 + IP，5 分钟最多 5 次
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 鉴权中间件
// ------------------------------------------------------------
function redirectToLogin(req, res) {
  const target = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/login?next=${target}`);
}

async function requirePageAuth(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) return redirectToLogin(req, res);
  req.authUser = user;
  req.sessionToken = user.token;
  next();
}

async function requireAdminPageAuth(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) return redirectToLogin(req, res);
  if (user.level !== "admin") {
    return res.status(403).send("无权限访问管理后台");
  }
  req.authUser = user;
  req.sessionToken = user.token;
  next();
}

async function requireApiAuth(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  req.authUser = user;
  req.sessionToken = user.token;
  next();
}

async function requireAdminApi(req, res, next) {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  if (user.level !== "admin") {
    return res.status(403).json({ success: false, message: "无权限执行此操作" });
  }
  req.authUser = user;
  req.sessionToken = user.token;
  next();
}

function formatAuthUser(user) {
  return {
    id: user.id,
    account: user.account,
    level: user.level,
  };
}

function formatDateValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function formatUserRow(row) {
  return {
    id: Number(row.id),
    account: row.account,
    level: row.level,
    createdAt: formatDateValue(row.created_at),
    updatedAt: formatDateValue(row.updated_at),
    lastLoginAt: formatDateValue(row.last_login_at),
  };
}

function formatDeviceRow(row, currentToken) {
  return {
    token: row.token,
    userId: Number(row.user_id),
    account: row.account,
    deviceLabel: row.device_label || "未知设备",
    userAgent: row.user_agent || "",
    ipAddress: row.ip_address || "",
    location: row.location || "未知",
    createdAt: formatDateValue(row.created_at),
    lastActiveAt: formatDateValue(row.last_active_at || row.created_at),
    current: Boolean(currentToken && row.token === currentToken),
  };
}

async function queryManagedUsers() {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, account, \`level\`, is_active, created_at, updated_at, last_login_at
       FROM ${MANAGED_USERS_TABLE} ORDER BY id ASC`
    );
    return rows.map(formatUserRow);
  } finally {
    if (conn) conn.release();
  }
}

async function insertManagedUser(account, passwordHash, level) {
  let conn;
  try {
    conn = await pool.getConnection();
    const now = getUTC8Time();
    const storedHash = passwordHashStore.createStoredHash(account, passwordHash);
    const result = await conn.query(
      `INSERT INTO ${MANAGED_USERS_TABLE} (account, password_hash, \`level\`, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [account, storedHash, level, now, now]
    );
    const insertedId = Number(result.insertId);
    const [row] = await conn.query(
      `SELECT id, account, \`level\`, is_active, created_at, updated_at, last_login_at
       FROM ${MANAGED_USERS_TABLE} WHERE id = ?`,
      [insertedId]
    );
    return formatUserRow(row);
  } finally {
    if (conn) conn.release();
  }
}

async function resetManagedUserPassword(userId, passwordHash) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [user] = await conn.query(
      `SELECT id, account FROM ${MANAGED_USERS_TABLE} WHERE id = ?`,
      [userId]
    );
    if (!user) {
      await conn.rollback();
      return null;
    }
    const storedHash = passwordHashStore.createStoredHash(user.account, passwordHash);
    await conn.query(
      `UPDATE ${MANAGED_USERS_TABLE} SET password_hash = ?, updated_at = ? WHERE id = ?`,
      [storedHash, getUTC8Time(), userId]
    );
    await conn.query(
      `DELETE FROM ${MANAGED_SESSIONS_TABLE} WHERE user_id = ?`,
      [userId]
    );
    await conn.commit();
    return { id: Number(user.id), account: user.account };
  } catch (err) {
    if (conn) await conn.rollback();
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

async function queryManagedDevices() {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT s.token, s.user_id, s.device_label, s.user_agent,
              s.ip_address, s.location, s.created_at, s.last_active_at,
              u.account
       FROM ${MANAGED_SESSIONS_TABLE} s
       INNER JOIN ${MANAGED_USERS_TABLE} u ON u.id = s.user_id
       WHERE s.expires_at >= ?
       ORDER BY COALESCE(s.last_active_at, s.created_at) DESC, s.created_at DESC`,
      [getUTC8Time()]
    );
    return rows.map((row) => formatDeviceRow(row, null));
  } finally {
    if (conn) conn.release();
  }
}

async function findManagedSessionOnly(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query(
      `SELECT s.token, s.user_id, s.ip_address, u.account
       FROM ${MANAGED_SESSIONS_TABLE} s
       INNER JOIN ${MANAGED_USERS_TABLE} u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at >= ?`,
      [token, getUTC8Time()]
    );
    return row || null;
  } catch (err) {
    console.error("❌ 查询主系统登录设备失败：", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

async function deleteManagedSession(token) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`DELETE FROM ${MANAGED_SESSIONS_TABLE} WHERE token = ?`, [token]);
  } catch (err) {
    console.error("❌ 踢出主系统登录设备失败：", err.message);
  } finally {
    if (conn) conn.release();
  }
}

function sanitizeNextPath(value) {
  if (typeof value !== "string" || value.length > 300) return "/users";
  if (!value.startsWith("/")) return "/users";
  if (value.startsWith("//") || value.includes("\\")) return "/users";
  if (value.startsWith("/login") || value.startsWith("/api")) return "/users";
  return value;
}

// ------------------------------------------------------------
// HTML 工具
// ------------------------------------------------------------
function escapeHtmlForServer(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeJsonForScript(value) {
  return JSON.stringify(value || {}).replace(/</g, "\\u003c");
}

// ------------------------------------------------------------
// 公共页面脚本：401 跳登录 + 退出 + fetch 封装
// ------------------------------------------------------------
function buildSharedScriptHtml() {
  return `
    (function () {
      var nativeFetch = window.fetch;
      if (!nativeFetch) return;
      window.fetch = function () {
        var args = arguments;
        return nativeFetch.apply(window, args).then(function (response) {
          if (response.status === 401 && window.location.pathname.indexOf("/login") !== 0) {
            window.location.href = "/login";
          }
          return response;
        });
      };
    })();

    async function apiFetch(url, options) {
      options = options || {};
      options.headers = options.headers || {};
      if (options.body && typeof options.body !== "string") {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.body);
      }
      var response = await fetch(url, options);
      if (response.status === 401) {
        window.location.href = "/login";
        throw new Error("未登录");
      }
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(result.message || result.error || "操作失败");
      }
      return result;
    }

    async function logoutCurrentUser() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch (err) {
        // 网络异常也回登录页
      }
      window.location.href = "/login";
    }

    function esc(value) {
      return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function fmtTime(value) {
      if (!value) return "-";
      var d = new Date(value);
      if (isNaN(d.getTime())) return String(value);
      var pad = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    async function sha256Hex(text) {
      var data = new TextEncoder().encode(text);
      var digest = await crypto.subtle.digest("SHA-256", data);
      return Array.prototype.map.call(new Uint8Array(digest), function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    }
  `;
}

// ------------------------------------------------------------
// 页面外壳：左侧侧边栏 + 主内容区
// ------------------------------------------------------------
function buildShellPage(opts) {
  const h = escapeHtmlForServer;
  const isAdmin = opts.user.level === "admin";

  let navHtml = "";
  if (isAdmin) {
    navHtml += `<a class="nav-item${opts.activeNav === "users" ? " active" : ""}" href="/users"><span>用户管理</span></a>`;
  }
  navHtml += `<a class="nav-item${opts.activeNav === "devices" ? " active" : ""}" href="/devices"><span>登录设备</span></a>`;
  if (isAdmin) {
    navHtml += `<a class="nav-item${opts.activeNav === "logs" ? " active" : ""}" href="/logs"><span>日志</span></a>`;
  }

  const userBadge = isAdmin
    ? '<span class="badge badge-admin">管理员</span>'
    : '<span class="badge badge-user">用户</span>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(opts.title)} - EBS 管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f0f2f5;
      color: #1f2937;
      min-height: 100vh;
    }
    .layout { display: flex; min-height: 100vh; }
    .sidebar {
      width: 224px;
      flex: 0 0 224px;
      background: #fff;
      border-right: 1px solid #e5e7eb;
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      display: flex;
      flex-direction: column;
      z-index: 20;
    }
    .brand { padding: 22px 18px 16px; border-bottom: 1px solid #eef0f3; }
    .brand-title { font-size: 18px; font-weight: 700; color: #111827; }
    .brand-sub { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .nav {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 14px 10px;
      overflow-y: auto;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 12px;
      border-radius: 8px;
      color: #374151;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }
    .nav-item:hover { background: #f3f4f6; }
    .nav-item.active { background: #e5f7f5; color: #0d9488; }
    .sidebar-footer {
      padding: 14px 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .side-user {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      overflow-wrap: anywhere;
    }
    .logout-btn { width: 100%; }
    .main { flex: 1; margin-left: 224px; min-width: 0; }
    .content { max-width: 1120px; margin: 0 auto; padding: 28px 32px 56px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .page-title { font-size: 22px; font-weight: 700; color: #111827; }
    .panel {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      overflow: hidden;
    }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th {
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
      background: #f9fafb;
      padding: 12px 14px;
      border-bottom: 1px solid #e5e7eb;
      white-space: nowrap;
    }
    td {
      padding: 13px 14px;
      border-bottom: 1px solid #f3f4f6;
      font-size: 14px;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    .account-cell { font-weight: 700; color: #111827; }
    .cell-sub { color: #9ca3af; font-size: 12px; margin-top: 4px; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-admin { background: #e0f2fe; color: #0369a1; }
    .badge-user { background: #f1f5f9; color: #475569; }
    .badge-current { background: #dcfce7; color: #15803d; }
    .badge-source {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-source-main { background: #eef2ff; color: #4338ca; }
    .badge-source-admin { background: #ecfdf5; color: #047857; }
    .log-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .log-seg {
      display: inline-flex;
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      overflow: hidden;
    }
    .log-seg button {
      height: 34px;
      padding: 0 14px;
      border: none;
      background: #fff;
      color: #6b7280;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
    }
    .log-seg button + button { border-left: 1px solid #e5e7eb; }
    .log-seg button.active { background: #0d9488; color: #fff; }
    .log-count { font-size: 13px; color: #6b7280; }
    .log-action {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      background: #f3f4f6;
      color: #374151;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .log-content-cell { min-width: 380px; max-width: 560px; }
    .log-raw {
      margin: 0;
      padding: 10px 12px;
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      color: #334155;
      font-family: Consolas, "Cascadia Code", monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
    }
    .log-zh {
      padding: 10px 12px;
      background: #f0fdfa;
      border: 1px solid #ccfbf1;
      border-radius: 8px;
      color: #134e4a;
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;
    }
    .load-more-wrap {
      padding: 14px;
      text-align: center;
      border-top: 1px solid #e5e7eb;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 36px;
      padding: 0 14px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: #fff;
      color: #374151;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
    }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-primary { background: #0d9488; color: #fff; }
    .btn-primary:hover { background: #0f766e; }
    .btn-danger { border-color: #fecaca; background: #fff; color: #b91c1c; }
    .btn-danger:hover { background: #fef2f2; }
    .btn-ghost { border-color: #d1d5db; background: #fff; color: #374151; }
    .btn-ghost:hover { background: #f3f4f6; }
    .btn-sm { height: 30px; padding: 0 10px; font-size: 13px; }
    .empty { padding: 42px 20px; text-align: center; color: #9ca3af; font-size: 14px; }
    .muted { color: #9ca3af; }
    .modal-mask {
      position: fixed;
      inset: 0;
      background: rgba(17, 24, 39, 0.45);
      display: none;
      align-items: flex-start;
      justify-content: center;
      z-index: 50;
      padding: 72px 16px 24px;
      overflow-y: auto;
    }
    .modal-mask.open { display: flex; }
    .modal {
      background: #fff;
      border-radius: 10px;
      width: 430px;
      max-width: 100%;
      padding: 24px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.16);
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
    }
    .modal-title { font-size: 18px; font-weight: 700; color: #111827; }
    .modal-close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 8px;
      background: #f3f4f6;
      color: #6b7280;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
    }
    .modal-close:hover { background: #e5e7eb; color: #111827; }
    .modal-detail { font-size: 14px; color: #111827; font-weight: 600; }
    .form-row { margin-bottom: 16px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }
    input[type="text"],
    input[type="password"],
    select {
      width: 100%;
      height: 40px;
      padding: 0 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      background: #fff;
      color: #111827;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #0d9488;
      box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.12);
    }
    .form-error {
      display: none;
      color: #b91c1c;
      font-size: 13px;
      font-weight: 600;
      margin-top: 6px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 22px;
    }
    @media (max-width: 760px) {
      .layout { display: block; }
      .sidebar {
        position: static;
        width: 100%;
        flex: none;
        border-right: none;
        border-bottom: 1px solid #e5e7eb;
        padding-bottom: 12px;
      }
      .brand { padding: 16px 16px 12px; }
      .nav {
        flex-direction: row;
        overflow-x: auto;
        padding: 4px 12px 8px;
      }
      .nav-item { flex: 0 0 auto; }
      .sidebar-footer { flex-direction: row; align-items: center; }
      .logout-btn { width: auto; margin-left: auto; }
      .main { margin-left: 0; }
      .content { padding: 20px 16px 40px; }
      table { min-width: 680px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title">EBS 管理后台</div>
        <div class="brand-sub">Workstation Management</div>
      </div>
      <nav class="nav">${navHtml}</nav>
      <div class="sidebar-footer">
        <div class="side-user">${h(opts.user.account)} ${userBadge}</div>
        <button type="button" class="btn btn-ghost btn-sm logout-btn" onclick="logoutCurrentUser()">退出登录</button>
      </div>
    </aside>
    <main class="main">
      <div class="content">
        ${opts.bodyHtml}
      </div>
    </main>
  </div>
  <script>
    window.PAGE_DATA = ${safeJsonForScript(opts.pageData || {})};
    ${buildSharedScriptHtml()}
  </script>
  <script>
    ${opts.scriptHtml}
  </script>
</body>
</html>`;
}

// ------------------------------------------------------------
// 登录页 HTML
// ------------------------------------------------------------
function buildLoginPage(nextPath, insecure) {
  const safeNext = JSON.stringify(sanitizeNextPath(nextPath));
  const warning = insecure
    ? `<div class="proto-warning">当前运行在未加密的 HTTP 模式下，登录存在安全风险，请使用 HTTPS 访问。</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - EBS 管理后台</title>
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
      padding: 38px;
      border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    }
    .brand { text-align: center; }
    .brand-sub { font-size: 13px; color: #6b7280; margin-bottom: 8px; }
    h1 { font-size: 24px; color: #111827; margin-bottom: 30px; }
    .proto-warning {
      background: #fffbe6;
      border: 1px solid #ffe58f;
      color: #ad6800;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      margin-bottom: 18px;
      line-height: 1.5;
    }
    .form-group { margin-bottom: 18px; }
    label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 8px;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      height: 44px;
      padding: 0 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      background: #fafafa;
    }
    input:focus {
      outline: none;
      border-color: #0d9488;
      background: #fff;
      box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.12);
    }
    .password-wrap { position: relative; }
    .password-toggle {
      position: absolute;
      right: 5px;
      top: 50%;
      transform: translateY(-50%);
      height: 34px;
      padding: 0 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #6b7280;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }
    .password-toggle:hover { background: #f3f4f6; color: #111827; }
    .error-text {
      display: none;
      color: #b91c1c;
      font-size: 13px;
      font-weight: 600;
      margin: -4px 0 12px;
    }
    .login-btn {
      width: 100%;
      height: 44px;
      background: #0d9488;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
    }
    .login-btn:hover { background: #0f766e; }
    .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .footer {
      position: fixed;
      bottom: 14px;
      left: 0;
      width: 100%;
      text-align: center;
      color: #9ca3af;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="brand">
      <div class="brand-sub">EBS Workstation</div>
      <h1>管理后台登录</h1>
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
          <button type="button" class="password-toggle" id="passwordToggle">显示</button>
        </div>
      </div>
      <button type="submit" class="login-btn" id="loginBtn">登录</button>
    </form>
  </div>
  <div class="footer">EBS Workstation Management By PRC-Leo</div>

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
        passwordToggle.textContent = show ? "隐藏" : "显示";
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
        if (!window.crypto || !window.crypto.subtle) {
          showError("当前环境不支持浏览器加密，请使用 HTTPS 访问");
          return;
        }

        var account = accountRaw.trim().toLowerCase();
        submitting = true;
        loginBtn.disabled = true;
        loginBtn.textContent = "登录中...";
        clearError();

        try {
          var passwordHash = await sha256Hex(account + ":" + password);
          var response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: account, passwordHash: passwordHash })
          });
          var result = await response.json();
          if (!response.ok) {
            showError(result.message || "登录失败");
            return;
          }
          var home = result.user && result.user.level === "admin"
            ? (nextPath && nextPath.indexOf("/login") !== 0 ? nextPath : "/users")
            : "/devices";
          window.location.href = home;
        } catch (err) {
          showError("登录失败，请重试");
        } finally {
          submitting = false;
          loginBtn.disabled = false;
          loginBtn.textContent = "登录";
        }
      });
    })();
  </script>
</body>
</html>`;
}

// ------------------------------------------------------------
// 用户管理页
// ------------------------------------------------------------
function buildUsersPageHtml(user) {
  const bodyHtml = `
    <div class="topbar">
      <h2 class="page-title">用户管理</h2>
      <button type="button" class="btn btn-primary" id="addUserBtn">添加用户</button>
    </div>
    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>级别</th>
              <th>最近登录</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="userRows"></tbody>
        </table>
      </div>
      <div class="empty" id="emptyRow" style="display:none">暂无用户</div>
    </div>

    <div class="modal-mask" id="addModal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-title">添加用户</div>
          <button type="button" class="modal-close" id="addModalClose" aria-label="关闭">×</button>
        </div>
        <form id="addForm">
          <div class="form-row">
            <label for="newAccount">用户名</label>
            <input type="text" id="newAccount" maxlength="64" autocomplete="off">
            <div class="form-error" id="addError"></div>
          </div>
          <div class="form-row">
            <label for="newPassword">密码</label>
            <input type="password" id="newPassword" maxlength="128" placeholder="留空默认 123456" autocomplete="new-password">
          </div>
          <div class="form-row">
            <label for="newLevel">级别</label>
            <select id="newLevel">
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" id="addCancel">取消</button>
            <button type="submit" class="btn btn-primary" id="addSubmit">添加用户</button>
          </div>
        </form>
      </div>
    </div>

    <div class="modal-mask" id="resetModal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-title">重置密码</div>
          <button type="button" class="modal-close" id="resetModalClose" aria-label="关闭">×</button>
        </div>
        <form id="resetForm">
          <div class="form-row">
            <label>用户</label>
            <div class="modal-detail" id="resetAccount"></div>
          </div>
          <div class="form-row">
            <label for="resetPassword">新密码</label>
            <input type="password" id="resetPassword" maxlength="128" placeholder="留空默认 123456" autocomplete="new-password">
            <div class="form-error" id="resetError"></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" id="resetCancel">取消</button>
            <button type="submit" class="btn btn-primary" id="resetSubmit">确认重置</button>
          </div>
        </form>
      </div>
    </div>`;

  const scriptHtml = `(function () {
    var tbody = document.getElementById("userRows");
    var emptyRow = document.getElementById("emptyRow");
    var addUserBtn = document.getElementById("addUserBtn");
    var addModal = document.getElementById("addModal");
    var resetModal = document.getElementById("resetModal");
    var addForm = document.getElementById("addForm");
    var resetForm = document.getElementById("resetForm");
    var submitting = false;
    var resetTarget = null;

    function openModal(modal) { modal.classList.add("open"); }
    function closeModal(modal) { modal.classList.remove("open"); }
    function showError(id, message) {
      var el = document.getElementById(id);
      el.textContent = message;
      el.style.display = "block";
    }

    function renderUsers(list) {
      if (!list.length) {
        tbody.innerHTML = "";
        emptyRow.style.display = "block";
        return;
      }
      emptyRow.style.display = "none";
      tbody.innerHTML = list.map(function (u) {
        var levelBadge = u.level === "admin"
          ? '<span class="badge badge-admin">管理员</span>'
          : '<span class="badge badge-user">用户</span>';
        return "<tr>"
          + "<td class='account-cell'>" + esc(u.account) + "</td>"
          + "<td>" + levelBadge + "</td>"
          + "<td>" + fmtTime(u.lastLoginAt) + "</td>"
          + "<td>" + fmtTime(u.createdAt) + "</td>"
          + "<td><button type='button' class='btn btn-ghost btn-sm' data-reset='1' data-id='" + u.id
          + "' data-account='" + esc(u.account) + "'>重置密码</button></td>"
          + "</tr>";
      }).join("");
    }

    async function loadUsers() {
      var result = await apiFetch("/api/admin/users");
      renderUsers(result.users || []);
    }

    addUserBtn.addEventListener("click", function () {
      addForm.reset();
      document.getElementById("addError").style.display = "none";
      openModal(addModal);
      document.getElementById("newAccount").focus();
    });
    document.getElementById("addModalClose").addEventListener("click", function () { closeModal(addModal); });
    document.getElementById("addCancel").addEventListener("click", function () { closeModal(addModal); });
    document.getElementById("resetModalClose").addEventListener("click", function () { closeModal(resetModal); });
    document.getElementById("resetCancel").addEventListener("click", function () { closeModal(resetModal); });
    addModal.addEventListener("click", function (e) { if (e.target === addModal) closeModal(addModal); });
    resetModal.addEventListener("click", function (e) { if (e.target === resetModal) closeModal(resetModal); });

    tbody.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-reset]");
      if (!btn) return;
      resetTarget = {
        id: Number(btn.getAttribute("data-id")),
        account: btn.getAttribute("data-account") || ""
      };
      document.getElementById("resetAccount").textContent = resetTarget.account;
      document.getElementById("resetPassword").value = "";
      document.getElementById("resetError").style.display = "none";
      openModal(resetModal);
      document.getElementById("resetPassword").focus();
    });

    addForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (submitting) return;
      var accountRaw = document.getElementById("newAccount").value;
      var account = accountRaw.trim().toLowerCase();
      var level = document.getElementById("newLevel").value;
      var submitBtn = document.getElementById("addSubmit");
      if (!account) {
        showError("addError", "请输入用户名");
        return;
      }
      if (!window.crypto || !window.crypto.subtle) {
        showError("addError", "当前环境不支持浏览器加密");
        return;
      }
      submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "添加中...";
      document.getElementById("addError").style.display = "none";
      try {
        var password = document.getElementById("newPassword").value || "123456";
        var passwordHash = await sha256Hex(account + ":" + password);
        await apiFetch("/api/admin/users", {
          method: "POST",
          body: { account: account, passwordHash: passwordHash, level: level }
        });
        closeModal(addModal);
        addForm.reset();
        await loadUsers();
      } catch (err) {
        showError("addError", err.message);
      } finally {
        submitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "添加用户";
      }
    });

    resetForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!resetTarget || submitting) return;
      var submitBtn = document.getElementById("resetSubmit");
      if (!window.crypto || !window.crypto.subtle) {
        showError("resetError", "当前环境不支持浏览器加密");
        return;
      }
      submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "重置中...";
      document.getElementById("resetError").style.display = "none";
      try {
        var password = document.getElementById("resetPassword").value || "123456";
        var passwordHash = await sha256Hex(resetTarget.account + ":" + password);
        await apiFetch("/api/admin/users/" + resetTarget.id + "/password", {
          method: "POST",
          body: { passwordHash: passwordHash }
        });
        closeModal(resetModal);
        alert("密码已重置，该用户的登录设备已全部下线");
        await loadUsers();
      } catch (err) {
        showError("resetError", err.message);
      } finally {
        submitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "确认重置";
      }
    });

    loadUsers().catch(function (err) {
      alert(err.message);
    });
  })();`;

  return buildShellPage({
    title: "用户管理",
    user,
    activeNav: "users",
    bodyHtml,
    scriptHtml,
    pageData: { page: "users" },
  });
}

// ------------------------------------------------------------
// 登录设备页
// ------------------------------------------------------------
function buildDevicesPageHtml(user, currentToken) {
  const bodyHtml = `
    <div class="topbar">
      <h2 class="page-title">登录设备</h2>
    </div>
    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>设备</th>
              <th>登录时间</th>
              <th>最近活跃</th>
              <th>IP + 定位</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="deviceRows"></tbody>
        </table>
      </div>
      <div class="empty" id="emptyRow" style="display:none">暂无登录设备</div>
    </div>`;

  const scriptHtml = `(function () {
    var tbody = document.getElementById("deviceRows");
    var emptyRow = document.getElementById("emptyRow");

    function trimText(value, max) {
      var text = String(value || "");
      return text.length <= max ? text : text.slice(0, max) + "...";
    }

    function renderDevices(list) {
      if (!list.length) {
        tbody.innerHTML = "";
        emptyRow.style.display = "block";
        return;
      }
      emptyRow.style.display = "none";
      tbody.innerHTML = list.map(function (d) {
        var currentBadge = d.current ? '<span class="badge badge-current">当前设备</span>' : "";
        var action = d.current
          ? '<span class="muted">-</span>'
          : '<button type="button" class="btn btn-danger btn-sm" data-kick="' + d.token + '">踢下线</button>';
        return "<tr>"
          + "<td class='account-cell'>" + esc(d.account) + "</td>"
          + "<td><div>" + esc(d.deviceLabel) + "</div>"
          + (d.userAgent ? "<div class='cell-sub'>" + esc(trimText(d.userAgent, 42)) + "</div>" : "")
          + "</td>"
          + "<td>" + fmtTime(d.createdAt) + "</td>"
          + "<td>" + fmtTime(d.lastActiveAt) + "</td>"
          + "<td><div>" + esc(d.ipAddress || "未知") + "</div>"
          + "<div class='cell-sub'>" + esc(d.location || "未知") + "</div></td>"
          + "<td>" + currentBadge + " " + action + "</td>"
          + "</tr>";
      }).join("");
    }

    async function loadDevices() {
      var result = await apiFetch("/api/admin/devices");
      renderDevices(result.devices || []);
    }

    tbody.addEventListener("click", async function (e) {
      var btn = e.target.closest("button[data-kick]");
      if (!btn) return;
      if (!window.confirm("确认将该设备踢下线？")) return;
      btn.disabled = true;
      try {
        await apiFetch("/api/admin/devices/" + encodeURIComponent(btn.getAttribute("data-kick")), {
          method: "DELETE"
        });
        await loadDevices();
      } catch (err) {
        alert(err.message);
      }
    });

    loadDevices().catch(function (err) {
      alert(err.message);
    });
  })();`;

  return buildShellPage({
    title: "登录设备",
    user,
    activeNav: "devices",
    bodyHtml,
    scriptHtml,
    pageData: { page: "devices", currentToken: currentToken || null },
  });
}

// ------------------------------------------------------------
// 操作日志页
// ------------------------------------------------------------
function buildLogsPageHtml(user) {
  const bodyHtml = `
    <div class="topbar">
      <h2 class="page-title">操作日志</h2>
    </div>
    <div class="log-toolbar">
      <div class="log-seg" id="logSeg">
        <button type="button" id="viewRawBtn" class="active">原文</button>
        <button type="button" id="viewZhBtn">中文翻译</button>
      </div>
      <span class="log-count" id="logCount">加载中...</span>
    </div>
    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>账号</th>
              <th>操作</th>
              <th>IP + 定位</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody id="logRows"></tbody>
        </table>
      </div>
      <div class="empty" id="emptyRow" style="display:none">暂无操作日志</div>
      <div class="load-more-wrap" id="loadMoreWrap" style="display:none">
        <button type="button" class="btn btn-ghost btn-sm" id="loadMoreBtn">加载更多</button>
      </div>
    </div>`;

  const scriptHtml = `(function () {
    var tbody = document.getElementById("logRows");
    var emptyRow = document.getElementById("emptyRow");
    var logCount = document.getElementById("logCount");
    var loadMoreWrap = document.getElementById("loadMoreWrap");
    var loadMoreBtn = document.getElementById("loadMoreBtn");
    var viewRawBtn = document.getElementById("viewRawBtn");
    var viewZhBtn = document.getElementById("viewZhBtn");
    var currentView = "raw";
    var allLogs = [];
    var offset = 0;
    var limit = 100;
    var total = 0;
    var loading = false;

    function sourceBadge(source) {
      if (source === "admin") {
        return '<span class="badge badge-source badge-source-admin">管理后台</span>';
      }
      return '<span class="badge badge-source badge-source-main">主系统</span>';
    }

    function parseRawLog(log) {
      try {
        var parsed = JSON.parse(log.raw || "");
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (err) {
        return null;
      }
    }

    function statusLabel(value) {
      return value ? "已完成" : "未完成";
    }

    function levelLabel(value) {
      return value === "admin" ? "管理员" : "用户";
    }

    var fieldLabels = {
      title: "标题",
      description: "描述",
      category: "分类",
      color: "紧急程度",
      completed: "完成状态",
      todoId: "待办ID",
      targetAccount: "目标账号",
      level: "级别",
      changes: "变更字段",
      ipAddress: "IP地址"
    };

    function formatDetailValue(key, value) {
      if (value === null || value === undefined || value === "") return "";
      if (key === "completed") return statusLabel(value);
      if (key === "level") return levelLabel(value);
      if (key === "changes" && Array.isArray(value)) {
        return value.map(function (name) {
          return fieldLabels[name] || name;
        }).join("、");
      }
      return String(value);
    }

    function translateLog(log) {
      var parsed = parseRawLog(log);
      var rawAction = (parsed && parsed.action) || log.action || "";
      var account = (parsed && parsed.account) || log.account || "";
      var details = (parsed && parsed.details) || {};
      var source = (parsed && parsed.source) || log.source || "main";
      var sourceText = source === "admin" ? "管理后台" : "主系统";
      var prefix = account ? "账号 " + account + " " : "";
      var tail = "（来源：" + sourceText + "）";
      var text = "";

      switch (rawAction) {
        case "main.login.success":
          text = "登录主系统成功";
          break;
        case "main.login.failed":
          text = "尝试登录主系统失败，请检查账号名或密码";
          break;
        case "main.logout":
          text = "退出主系统";
          break;
        case "main.todo.create":
          text = "创建待办《" + (details.title || "未命名") + "》"
            + (details.todoId ? "（ID " + details.todoId + "）" : "");
          break;
        case "main.todo.toggle":
          text = "更新待办《" + (details.title || "未命名") + "》的完成状态为"
            + statusLabel(details.completed)
            + (details.todoId ? "（ID " + details.todoId + "）" : "");
          break;
        case "main.todo.update":
          text = "更新待办《" + (details.title || "未命名") + "》的"
            + (Array.isArray(details.changes) && details.changes.length
              ? details.changes.map(function (name) { return fieldLabels[name] || name; }).join("、")
              : "内容")
            + (details.todoId ? "（ID " + details.todoId + "）" : "");
          break;
        case "main.todo.delete":
          text = "删除待办《" + (details.title || "未命名") + "》"
            + (details.todoId ? "（ID " + details.todoId + "）" : "");
          break;
        case "admin.login.success":
          text = "登录管理后台成功";
          break;
        case "admin.login.failed":
          text = "尝试登录管理后台失败，请检查账号名或密码";
          break;
        case "admin.logout":
          text = "退出管理后台";
          break;
        case "admin.user.create":
          text = "创建用户账号 " + (details.targetAccount || "-")
            + "，级别为 " + levelLabel(details.level);
          break;
        case "admin.user.reset_password":
          text = "强制重置用户 " + (details.targetAccount || "-")
            + " 的密码，该用户全部登录设备已下线";
          break;
        case "admin.device.kick":
          text = "将用户 " + (details.targetAccount || "-")
            + " 的登录设备强制下线"
            + (details.ipAddress ? "（IP " + details.ipAddress + "）" : "");
          break;
        default:
          text = "执行操作 " + rawAction;
          var detailParts = Object.keys(details).map(function (key) {
            var value = formatDetailValue(key, details[key]);
            return value ? ((fieldLabels[key] || key) + "：" + value) : "";
          }).filter(Boolean);
          if (detailParts.length) {
            text += "，明细：" + detailParts.join("；");
          }
      }

      return prefix + text + tail;
    }

    function contentHtml(log) {
      if (currentView === "zh") {
        return '<div class="log-zh">' + esc(translateLog(log)) + '</div>';
      }
      return '<pre class="log-raw">' + esc(log.raw || "-") + '</pre>';
    }

    function renderRows() {
      emptyRow.style.display = allLogs.length ? "none" : "block";
      tbody.innerHTML = allLogs.map(function (log) {
        return "<tr>"
          + "<td>" + fmtTime(log.createdAt) + "</td>"
          + "<td>" + sourceBadge(log.source) + "</td>"
          + "<td class='account-cell'>" + esc(log.account || "-") + "</td>"
          + "<td><span class='log-action'>" + esc(log.action || "-") + "</span></td>"
          + "<td><div>" + esc(log.ipAddress || "未知") + "</div>"
          + "<div class='cell-sub'>" + esc(log.location || "未知") + "</div></td>"
          + "<td class='log-content-cell'>" + contentHtml(log) + "</td>"
          + "</tr>";
      }).join("");
      logCount.textContent = "共 " + total + " 条日志";
    }

    async function loadLogs(reset) {
      if (loading) return;
      if (reset) {
        offset = 0;
        allLogs = [];
      }
      loading = true;
      loadMoreBtn.disabled = true;
      try {
        var result = await apiFetch("/api/admin/logs?limit=" + limit + "&offset=" + offset);
        total = Number(result.total || 0);
        allLogs = allLogs.concat(result.logs || []);
        offset += (result.logs || []).length;
        renderRows();
        var finished = offset >= total;
        loadMoreWrap.style.display = finished ? "none" : "block";
      } catch (err) {
        alert(err.message);
      } finally {
        loading = false;
        loadMoreBtn.disabled = false;
      }
    }

    function setView(view) {
      currentView = view;
      viewRawBtn.classList.toggle("active", view === "raw");
      viewZhBtn.classList.toggle("active", view === "zh");
      renderRows();
    }

    viewRawBtn.addEventListener("click", function () { setView("raw"); });
    viewZhBtn.addEventListener("click", function () { setView("zh"); });
    loadMoreBtn.addEventListener("click", function () { loadLogs(false); });
    loadLogs(true);
  })();`;

  return buildShellPage({
    title: "操作日志",
    user,
    activeNav: "logs",
    bodyHtml,
    scriptHtml,
    pageData: { page: "logs" },
  });
}

// ------------------------------------------------------------
// 路由：页面
// ------------------------------------------------------------
app.get("/", async (req, res) => {
  const user = await authenticateRequest(req);
  if (user) {
    return res.redirect("/users");
  }
  res.redirect("/login");
});

app.get("/login", async (req, res) => {
  const currentUser = await authenticateRequest(req);
  if (currentUser) {
    const next = sanitizeNextPath(req.query.next);
    return res.redirect(next);
  }
  res.send(buildLoginPage(req.query.next, !req.secure));
});

app.get("/users", requireAdminPageAuth, (req, res) => {
  res.send(buildUsersPageHtml(req.authUser));
});

app.get("/devices", requireAdminPageAuth, (req, res) => {
  res.send(buildDevicesPageHtml(req.authUser, req.sessionToken));
});

app.get("/logs", requireAdminPageAuth, (req, res) => {
  res.send(buildLogsPageHtml(req.authUser));
});

// ------------------------------------------------------------
// 路由：登录 / 登出
// ------------------------------------------------------------
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

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (isLoginRateLimited(canonical, ip)) {
    return res.status(429).json({ success: false, message: "尝试次数过多，请稍后再试" });
  }

  const user = await findAdminUser(canonical);
  const storedHash = user ? user.password_hash : "0".repeat(64);
  const matched = passwordHashStore.matchesStoredHash(canonical, passwordHash, storedHash);

  if (!user || !matched) {
    recordLoginFailure(canonical, ip);
    return res.status(401).json({ success: false, message: AUTH_ERROR_MESSAGE });
  }

  clearLoginFailures(canonical, ip);

  const session = await createAdminSession(user.id, req);
  if (!session.success) {
    return res.status(500).json({ success: false, message: "服务器内部错误" });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `UPDATE ${ADMIN_USERS_TABLE} SET last_login_at = ?, updated_at = ? WHERE id = ?`,
      [getUTC8Time(), getUTC8Time(), user.id]
    );
  } catch (err) {
    console.error("❌ 更新管理后台最近登录时间失败：", err.message);
  } finally {
    if (conn) conn.release();
  }

  await deleteExpiredAdminSessions();

  res.cookie(ADMIN_COOKIE, session.token, {
    httpOnly: true,
    secure: Boolean(req.secure),
    sameSite: "lax",
    maxAge: ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
  res.json({
    success: true,
    user: {
      id: user.id,
      account: user.account,
      level: user.level,
    },
  });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }
  res.json({ success: true, user: formatAuthUser(user) });
});

app.post("/api/logout", async (req, res) => {
  const user = await authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, message: AUTH_UNAUTHORIZED_MESSAGE });
  }

  const token = getCookie(req, ADMIN_COOKIE);
  if (token) await deleteAdminSession(token);

  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    secure: Boolean(req.secure),
    sameSite: "lax",
    path: "/",
  });
  res.json({ success: true });
});

// ------------------------------------------------------------
// 路由：用户管理 API（仅管理员）
// ------------------------------------------------------------
app.get("/api/admin/users", requireAdminApi, async (req, res) => {
  const users = await queryManagedUsers();
  res.json({ success: true, users });
});

app.post("/api/admin/users", requireAdminApi, async (req, res) => {
  const { account, passwordHash, level } = req.body || {};
  if (typeof account !== "string" || typeof passwordHash !== "string") {
    return res.status(400).json({ success: false, message: "用户名和密码哈希为必填项" });
  }

  const canonical = canonicalAccount(account);
  if (!canonical || canonical.length > 64) {
    return res.status(400).json({ success: false, message: "用户名必填且不能超过 64 个字符" });
  }
  if (!/^[0-9a-f]{64}$/.test(passwordHash)) {
    return res.status(400).json({ success: false, message: "密码哈希格式错误" });
  }
  const userLevel = level === "admin" ? "admin" : "user";

  try {
    const user = await insertManagedUser(canonical, passwordHash, userLevel);
    res.status(201).json({ success: true, user });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "用户名已存在" });
    }
    throw err;
  }
});

app.post("/api/admin/users/:id/password", requireAdminApi, async (req, res) => {
  const userId = Number(req.params.id);
  const { passwordHash } = req.body || {};
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ success: false, message: "用户 ID 格式错误" });
  }
  if (typeof passwordHash !== "string" || !/^[0-9a-f]{64}$/.test(passwordHash)) {
    return res.status(400).json({ success: false, message: "密码哈希格式错误" });
  }

  const result = await resetManagedUserPassword(userId, passwordHash);
  if (!result) {
    return res.status(404).json({ success: false, message: "用户不存在" });
  }
  res.json({ success: true, message: "密码已重置，登录设备已全部下线" });
});

// ------------------------------------------------------------
// 路由：登录设备 API（只展示主系统登录设备）
// ------------------------------------------------------------
app.get("/api/admin/devices", requireAdminApi, async (req, res) => {
  const devices = await queryManagedDevices();
  res.json({ success: true, devices });
});

app.delete("/api/admin/devices/:token", requireAdminApi, async (req, res) => {
  const token = String(req.params.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json({ success: false, message: "会话令牌格式错误" });
  }

  const session = await findManagedSessionOnly(token);
  if (!session) {
    return res.status(404).json({ success: false, message: "登录设备不存在或已过期" });
  }

  await deleteManagedSession(token);
  res.json({ success: true, message: "该设备已下线" });
});

app.get("/api/admin/logs", requireAdminApi, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await operationLog.queryOperationLogs(pool, LOG_TABLE, { limit, offset });
  if (!result.success) return res.status(500).json(result);
  res.json(result);
});

// ------------------------------------------------------------
// 健康检查、404、错误处理
// ------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: "接口不存在", path: req.originalUrl });
});

app.use((err, req, res, next) => {
  console.error("管理后台内部错误：", err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "服务器内部错误" });
});

// ------------------------------------------------------------
// 启动服务（HTTPS 优先，证书失败回退 HTTP）
// ------------------------------------------------------------
function buildAccessUrl(protocol, urlPath) {
  const defaultPort = protocol === "https" ? 443 : 80;
  const portPart = ADMIN_PORT === defaultPort ? "" : ":" + ADMIN_PORT;
  return `${protocol}://localhost${portPart}${urlPath}`;
}

async function afterStart() {
  await testDatabaseConnection();
  await initDatabase();
  await deleteExpiredAdminSessions();
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

if (ADMIN_HTTPS.enabled) {
  let tlsOptions = null;
  try {
    const key = fs.readFileSync(path.join(__dirname, ADMIN_HTTPS.keyPath));
    const cert = fs.readFileSync(path.join(__dirname, ADMIN_HTTPS.certPath));
    tlsOptions = { key, cert };
  } catch (err) {
    console.error("❌ 读取管理后台 HTTPS 证书失败：" + (err.message || err));
    console.error("   请检查 config.admin.https.keyPath / certPath 是否存在。");
    console.error("   ⚠️ 暂回退为 HTTP 模式启动。");
  }

  if (tlsOptions) {
    listenWithFriendlyError(https.createServer(tlsOptions, app), ADMIN_PORT, "管理后台").listen(ADMIN_PORT, async () => {
      console.log("============================================");
      console.log("管理后台服务启动完毕（HTTPS）");
      console.log("访问地址：" + buildAccessUrl("https", ""));
      console.log("用户管理：" + buildAccessUrl("https", "/users"));
      console.log("登录设备：" + buildAccessUrl("https", "/devices"));
      console.log("操作日志：" + buildAccessUrl("https", "/logs"));
      console.log("============================================");
      await afterStart();
    });

    if (ADMIN_HTTPS.redirectHttp) {
      const redirPort = ADMIN_HTTPS.httpRedirectPort || 8081;
      listenWithFriendlyError(http.createServer((req, res) => {
        const host = (req.headers.host || "localhost").split(":")[0];
        const portPart = ADMIN_PORT === 443 ? "" : ":" + ADMIN_PORT;
        const target = "https://" + host + portPart + req.url;
        res.writeHead(301, { Location: target, "Content-Length": "0" });
        res.end();
      }), redirPort, "管理后台 HTTP 跳转").listen(redirPort, () => {
        const fromPart = redirPort === 80 ? "" : ":" + redirPort;
        const toPart = ADMIN_PORT === 443 ? "" : ":" + ADMIN_PORT;
        console.log("↩️  HTTP->HTTPS 跳转服务已启动：http://localhost" + fromPart + " -> https://localhost" + toPart);
      });
    }
  } else {
    listenWithFriendlyError(app, ADMIN_PORT, "管理后台").listen(ADMIN_PORT, async () => {
      console.log("============================================");
      console.log("管理后台服务启动完毕（HTTP 回退模式）");
      console.log("访问地址：" + buildAccessUrl("http", ""));
      console.log("   ⚠️ HTTP 回退模式下登录存在安全风险，请使用 HTTPS 访问 /login。");
      console.log("操作日志：" + buildAccessUrl("http", "/logs"));
      console.log("============================================");
      await afterStart();
    });
  }
} else {
  listenWithFriendlyError(app, ADMIN_PORT, "管理后台").listen(ADMIN_PORT, async () => {
    console.log("============================================");
    console.log("管理后台服务启动完毕（HTTP）");
    console.log("访问地址：" + buildAccessUrl("http", ""));
    console.log("   ⚠️ HTTP 模式下登录存在安全风险，请配置 HTTPS 后再启用登录。");
    console.log("操作日志：" + buildAccessUrl("http", "/logs"));
    console.log("============================================");
    await afterStart();
  });
}
