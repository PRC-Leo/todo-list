// ============================================================
// Todo List 后端服务
// 使用 Express 框架 + MariaDB 数据库连接池
// ============================================================

const express = require("express");
const mariadb = require("mariadb");

// ------------------------------------------------------------
// 1. 创建 Express 应用实例
// ------------------------------------------------------------
const app = express();

// ------------------------------------------------------------
// 2. 中间件配置
// ------------------------------------------------------------
// 解析 JSON 格式的请求体
app.use(express.json());
// 解析 URL 编码的请求体（表单数据）
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------
// 3. 创建 MariaDB 数据库连接池
// ------------------------------------------------------------
const pool = mariadb.createPool({
  host: "localhost",        // 数据库主机地址
  port: 3306,               // 数据库端口（MariaDB/MySQL 默认端口）
  user: "root",             // 数据库用户名
  password: "123456",             // 数据库密码（默认空）
  database: "ljz-data",    // 使用的数据库名称
  connectionLimit: 10,      // 连接池最大连接数
  acquireTimeout: 10000,    // 获取连接的超时时间（毫秒）
});

// ------------------------------------------------------------
// 4. 测试数据库连接
// ------------------------------------------------------------
async function testDatabaseConnection() {
  let conn;
  try {
    // 从连接池中获取一个连接
    conn = await pool.getConnection();
    console.log("✅ 数据库连接成功！MariaDB 连接池已就绪。");
    console.log(`   主机：localhost:3306 `);
  } catch (err) {
    console.error("❌ 数据库连接失败：", err.message);
    console.error("   请确保 MariaDB 服务已启动，且数据库 todo_list 已创建。");
  } finally {
    // 释放连接，归还到连接池
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 5. 路由定义
// ------------------------------------------------------------

// 根路由 —— 服务基本信息
app.get("/", (req, res) => {
  res.json({
    message: "欢迎访问Todo-List by PRC-Leo",
    version: "1.0.0",
    status: "运行中",
  });
});

// 健康检查接口
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ------------------------------------------------------------
// 6. 404 处理 —— 未匹配到任何路由时
// ------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "接口不存在", path: req.originalUrl });
});

// ------------------------------------------------------------
// 7. 全局错误处理中间件
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("服务器内部错误：", err.message);
  res.status(500).json({ error: "服务器内部错误", detail: err.message });
});

// ------------------------------------------------------------
// 8. 启动服务器
// ------------------------------------------------------------
const PORT = 5580;

app.listen(PORT, async () => {
  console.log("============================================");
  console.log("🚀 Todo List 后端服务启动完毕！");
  console.log(`📍 访问地址：http://localhost:${PORT}`);
  console.log("============================================");

  // 服务启动后立即测试数据库连接
  await testDatabaseConnection();
});