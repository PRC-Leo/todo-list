// ============================================================
// 密码哈希迁移工具
// 将当前数据库中旧的单次 SHA-256 哈希升级为 v2: 二次哈希，
// 幂等运行：已经迁移的记录会被跳过，不会二次加密。
// 用法：node scripts/migrate-password-hash.js
// ============================================================

const mariadb = require("mariadb");
const config = require("../config/config.js");
const passwordHashStore = require("../password-hash.js");

const tables = [
  { name: (config.auth && config.auth.usersTable) || "todo_users", label: "主系统用户表" },
  { name: (config.admin && config.admin.usersTable) || "admin_users", label: "管理后台用户表" },
];

async function main() {
  const pool = mariadb.createPool(config.db);
  let conn;
  try {
    conn = await pool.getConnection();
    for (const table of tables) {
      await passwordHashStore.ensurePasswordHashColumn(conn, table.name);
      const result = await passwordHashStore.migrateLegacyPasswordHashes(conn, table.name);
      console.log(`🔐 ${table.label} ${table.name}：迁移 ${result.migrated} 条，跳过 ${result.skipped.length} 条非标准记录。`);
      if (result.skipped.length > 0) {
        console.warn(`  跳过账号：${result.skipped.join("、")}`);
      }
    }
    console.log("✅ 密码哈希迁移完成。");
  } catch (err) {
    console.error("❌ 密码哈希迁移失败：", err.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

main();
