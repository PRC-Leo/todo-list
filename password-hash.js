// ============================================================
// 密码哈希存储
// 浏览器端先计算 SHA-256(account:password) 并提交给后端；
// 后端再对 clientHash 做一次 SHA-256(account:clientHash)，
// 以 "v2:" 前缀存入数据库，避免数据库中的哈希可直接用于登录。
// 旧数据（64 位 hex）会在启动时自动迁移为 v2 格式。
// ============================================================

const crypto = require("crypto");

const STORED_PREFIX = "v2:";
const CLIENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const STORED_HASH_PATTERN = /^v2:[0-9a-f]{64}$/i;

function normalizeAccount(account) {
  return String(account || "").trim().toLowerCase();
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// 与前端登录/添加用户/重置密码完全一致的客户端哈希公式
function hashPassword(account, password) {
  return sha256Hex(normalizeAccount(account) + ":" + String(password));
}

// 后端对前端提交的 clientHash 再加密一次
function hashClientPassword(account, clientHash) {
  return sha256Hex(normalizeAccount(account) + ":" + String(clientHash));
}

function createStoredHash(account, clientHash) {
  return STORED_PREFIX + hashClientPassword(account, clientHash);
}

function isStoredDoubleHash(value) {
  return typeof value === "string" && STORED_HASH_PATTERN.test(value);
}

function constantTimeHexEqual(hexA, hexB) {
  const a = Buffer.from(String(hexA || ""), "hex");
  const b = Buffer.from(String(hexB || ""), "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// 兼容已迁移（v2:）和未迁移（纯 64 位 hex）两种存储格式
function matchesStoredHash(account, clientHash, storedHash) {
  if (typeof clientHash !== "string" || typeof storedHash !== "string") return false;
  if (isStoredDoubleHash(storedHash)) {
    return constantTimeHexEqual(
      createStoredHash(account, clientHash).slice(STORED_PREFIX.length),
      storedHash.slice(STORED_PREFIX.length)
    );
  }
  if (CLIENT_HASH_PATTERN.test(storedHash)) {
    return constantTimeHexEqual(clientHash.toLowerCase(), storedHash.toLowerCase());
  }
  return false;
}

// 将旧列扩容，允许保存 "v2:" + 64 位 hex
async function ensurePasswordHashColumn(conn, table) {
  await conn.query(
    `ALTER TABLE ${table}
     MODIFY COLUMN password_hash VARCHAR(128) NOT NULL
     COMMENT '后端二次哈希 v2:+SHA-256(account:clientHash)'`
  );
}

// 把当前库中的旧哈希逐条升级为二次哈希；重复执行不会重复加密
async function migrateLegacyPasswordHashes(conn, table) {
  const rows = await conn.query(
    `SELECT id, account, password_hash FROM ${table}`
  );
  let migrated = 0;
  const skipped = [];

  for (const row of rows) {
    const current = String(row.password_hash || "");
    if (isStoredDoubleHash(current)) continue;
    if (!CLIENT_HASH_PATTERN.test(current)) {
      skipped.push(row.account);
      continue;
    }

    const next = createStoredHash(row.account, current);
    const result = await conn.query(
      `UPDATE ${table}
       SET password_hash = ?
       WHERE id = ? AND password_hash = ?`,
      [next, row.id, current]
    );
    if (Number(result.affectedRows) > 0) migrated += 1;
  }

  return { migrated, skipped };
}

module.exports = {
  STORED_PREFIX,
  hashPassword,
  hashClientPassword,
  createStoredHash,
  isStoredDoubleHash,
  matchesStoredHash,
  ensurePasswordHashColumn,
  migrateLegacyPasswordHashes,
};
