// ============================================================
// 预置登录账号工具（不提交账号、密码或哈希到仓库）
// 用法：
//   node scripts/seed-user.js <账号> <密码>
//   或设置环境变量 AUTH_ACCOUNT / AUTH_PASSWORD 后运行 npm run seed:auth
// ============================================================

const mariadb = require("mariadb");
const config = require("../config/config.js");
const passwordHashStore = require("../password-hash.js");

const args = process.argv.slice(2);
const account = (args[0] || process.env.AUTH_ACCOUNT || "").trim().toLowerCase();
const password = args[1] || process.env.AUTH_PASSWORD || "";
const displayName = process.env.AUTH_DISPLAY_NAME || null;

if (!account || !password) {
  console.error("❌ 请提供账号与密码：");
  console.error("   node scripts/seed-user.js <账号> <密码>");
  console.error("   或设置环境变量 AUTH_ACCOUNT / AUTH_PASSWORD 后运行 npm run seed:auth");
  process.exit(1);
}
if (account.length > 64) {
  console.error("❌ 账号不能超过 64 个字符。");
  process.exit(1);
}
if (password.length < 8) {
  console.error("❌ 密码至少 8 个字符。");
  process.exit(1);
}

// 与前端完全一致的哈希公式：SHA-256(规范化账号 + ":" + 密码)
const clientHash = passwordHashStore.hashPassword(account, password);
const storedPasswordHash = passwordHashStore.createStoredHash(account, clientHash);

const USERS_TABLE = config.auth.usersTable || "users";

function getUtc8String(date) {
  const offsetMs = config.timezoneOffsetHours * 60 * 60 * 1000;
  return new Date(date.getTime() + offsetMs).toISOString().replace("T", " ").substring(0, 19);
}

async function ensureUsersTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
      id            INT AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID，自增主键',
      account       VARCHAR(64) NOT NULL UNIQUE COMMENT '规范化账号',
      password_hash VARCHAR(128) NOT NULL COMMENT '后端二次哈希 v2:+SHA-256(account:clientHash)',
      display_name  VARCHAR(50) NULL COMMENT '展示名称',
      is_active     BOOLEAN DEFAULT TRUE COMMENT '账号是否启用',
      \`level\`     ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别',
      created_at    DATETIME NOT NULL COMMENT '创建时间（UTC+8）',
      updated_at    DATETIME NOT NULL COMMENT '更新时间（UTC+8）',
      last_login_at DATETIME NULL COMMENT '最近登录时间（UTC+8）'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录用户表'
  `);

  const cols = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [config.db.database, USERS_TABLE]
  );
  const colSet = new Set((cols || []).map((row) => row.name));
  if (!colSet.has("level")) {
    try {
      await conn.query(
        `ALTER TABLE ${USERS_TABLE}
         ADD COLUMN \`level\` ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '用户级别' AFTER \`is_active\``
      );
      console.log(`⬆️ 数据表 ${USERS_TABLE} 已补充 level 字段。`);
    } catch (err) {
      if (err && err.code === "ER_DUP_FIELDNAME") return;
      throw err;
    }
  }
}

async function main() {
  const pool = mariadb.createPool(config.db);
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureUsersTable(conn);
    await passwordHashStore.ensurePasswordHashColumn(conn, USERS_TABLE);
    const migration = await passwordHashStore.migrateLegacyPasswordHashes(conn, USERS_TABLE);
    if (migration.migrated > 0) {
      console.log(`🔐 数据表 ${USERS_TABLE} 已完成 ${migration.migrated} 条密码哈希二次加密迁移。`);
    }

    const now = getUtc8String(new Date());
    await conn.query(
      `INSERT INTO ${USERS_TABLE} (account, password_hash, display_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         display_name = VALUES(display_name),
         updated_at = VALUES(updated_at)`,
      [account, storedPasswordHash, displayName, now, now]
    );

    console.log(`✅ 登录账号已预置：${account}（账号、密码与哈希均不会打印到日志）。`);
  } catch (err) {
    console.error("❌ 预置账号失败：", err.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

main();
