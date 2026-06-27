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
  password: "123456",       // 数据库密码
  database: "ljz-data",     // 使用的数据库名称
  connectionLimit: 10,      // 连接池最大连接数
  acquireTimeout: 10000,    // 获取连接的超时时间（毫秒）
});

// ------------------------------------------------------------
// 4. 初始化数据库 —— 自动创建 todos 数据表（如果不存在）
// ------------------------------------------------------------
async function initDatabase() {
  let conn;
  try {
    conn = await pool.getConnection();

    // 创建 todos 表的 SQL 语句（如果表已存在则跳过）
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS todos (
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
    console.log("✅ 数据表 todos 已就绪（ljz-data.todos）。");
  } catch (err) {
    console.error("❌ 数据库初始化失败：", err.message);
    console.error("   请确保 MariaDB 服务已启动，且数据库 ljz-data 已创建。");
  } finally {
    if (conn) conn.release();
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
    console.log(`   主机：localhost:3306 | 数据库：ljz-data`);
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
  // UTC+8 = 当前 UTC 毫秒数 + 8 小时偏移
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  // 转换为 MySQL DATETIME 格式：YYYY-MM-DD HH:mm:ss
  return utc8.toISOString().replace("T", " ").substring(0, 19);
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
      INSERT INTO todos (title, description, category, color, completed, created_at, updated_at)
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
    const [row] = await conn.query("SELECT * FROM todos WHERE id = ?", [insertedId]);

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
      "SELECT * FROM todos ORDER BY created_at DESC"
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
      "SELECT completed FROM todos WHERE id = ?",
      [id]
    );
    if (!current) {
      return { success: false, error: "未找到该待办任务，ID=" + id };
    }

    // 翻转完成状态
    const newCompleted = current.completed ? 0 : 1;
    const now = getUTC8Time();

    await conn.query(
      "UPDATE todos SET completed = ?, updated_at = ? WHERE id = ?",
      [newCompleted, now, id]
    );

    // 返回更新后的完整记录
    const [row] = await conn.query("SELECT * FROM todos WHERE id = ?", [id]);
    return { success: true, data: formatTodoRow(row) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ------------------------------------------------------------
// 11. 服务端辅助函数
// ------------------------------------------------------------

// 紧急程度颜色映射表
const URGENCY_MAP = {
  "#AAAAAA": { label: "无",    cssColor: "#AAAAAA" },
  "#28A745": { label: "不急",  cssColor: "#28A745" },
  "#007BFF": { label: "中等",  cssColor: "#007BFF" },
  "#FFC107": { label: "紧急",  cssColor: "#FFC107" },
  "#DC3545": { label: "最高",  cssColor: "#DC3545" },
};

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
// 12. 根据 ID 查询单条待办
// ------------------------------------------------------------
async function getTodoById(id) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [row] = await conn.query("SELECT * FROM todos WHERE id = ?", [id]);
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
// 13. 构建 HTML 页面的辅助函数
// ------------------------------------------------------------

// 构建待办详情页面
function buildDetailPage(todo) {
  const urgency = URGENCY_MAP[todo.color] || { label: "其他", cssColor: todo.color || "#AAAAAA" };
  const h = escapeHtmlForServer;
  const ft = formatTimeForServer;

  const statusBadge = todo.completed
    ? '<span class="status-badge done">✅ 已完成</span>'
    : '<span class="status-badge pending">⏳ 未完成</span>';

  const toggleLabel = todo.completed ? "⬜ 标记为未完成" : "✅ 标记为已完成";

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
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <a href="/list" class="back-link">← 返回列表</a>
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
      <a href="/list" class="btn btn-list">📖 返回列表</a>
      <button class="btn btn-toggle" id="toggleBtn" onclick="toggleFromDetail(${todo.id})">
        ${toggleLabel}
      </button>
    </div>
  </div>

  <script>
    async function toggleFromDetail(id) {
      var btn = document.getElementById("toggleBtn");
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "⏳……";

      try {
        var response = await fetch("/api/todos/" + id, { method: "PATCH" });
        var result = await response.json();
        if (!result.success) {
          alert("操作失败：" + (result.error || "未知错误"));
          btn.disabled = false;
          return;
        }
        location.reload();
      } catch (err) {
        alert("网络错误：" + err.message);
        btn.disabled = false;
      }
    }
  </script>
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
</body>
</html>`
  );
}

// ------------------------------------------------------------
// 14. 路由定义
// ------------------------------------------------------------

// 根路由 —— 服务基本信息
app.get("/", (req, res) => {
  res.json({
    message: "欢迎访问Todo-List by PRC-Leo",
    version: "1.0.0",
    status: "运行中",
  });
});

// /add 路由 —— 返回添加待办的 HTML 表单页面
app.get("/add", (req, res) => {
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
    h1 {
      text-align: center;
      color: #1a1a2e;
      margin-bottom: 32px;
      font-size: 24px;
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
    <h1>📋 添加待办任务</h1>

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
          <option value="前端开发">前端开发</option>
          <option value="后端开发">后端开发</option>
          <option value="UI设计">UI设计</option>
          <option value="DevOps">DevOps</option>
          <option value="文档">文档</option>
          <option value="Bug修复">Bug修复</option>
          <option value="代码审查">代码审查</option>
          <option value="学习研究">学习研究</option>
          <option value="会议">会议</option>
          <option value="其他">其他</option>
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
</body>
</html>
  `);
});

// /list 路由 —— 查看所有待办，可切换完成状态
app.get("/list", (req, res) => {
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
    .loading { text-align: center; padding: 40px; color: #aaa; }
    .empty { text-align: center; padding: 60px 20px; color: #aaa; }
    .empty-icon { font-size: 48px; margin-bottom: 12px; }
    .error { text-align: center; padding: 40px; color: #cf1322; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📋 待办任务列表</h1>
      <a href="/add" class="btn-add">+ 添加待办</a>
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

  <script>
    // 紧急程度颜色映射表（中文标签）
    const URGENCY_MAP = {
      "#AAAAAA": { label: "无",    cssColor: "#AAAAAA" },
      "#28A745": { label: "不急",  cssColor: "#28A745" },
      "#007BFF": { label: "中等",  cssColor: "#007BFF" },
      "#FFC107": { label: "紧急",  cssColor: "#FFC107" },
      "#DC3545": { label: "最高",  cssColor: "#DC3545" },
    };

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
            '</button>';

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
</body>
</html>
  `);
});

// POST /api/todos —— 接收待办数据并写入数据库
app.post("/api/todos", async (req, res) => {
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
    res.status(201).json(result);
  } else {
    res.status(500).json(result);
  }
});

// GET /api/todos —— 获取所有待办列表
app.get("/api/todos", async (req, res) => {
  const result = await getAllTodos();
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// PATCH /api/todos/:id —— 切换待办完成状态
app.patch("/api/todos/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: "无效的 ID" });
  }
  const result = await toggleTodoStatus(id);
  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error.includes("未找到") ? 404 : 500).json(result);
  }
});

// GET /api/todos/:id —— 根据 ID 获取单条待办（JSON）
app.get("/api/todos/:id", async (req, res) => {
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

// /:id 路由 —— 待办详情页面
app.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).send("<h1>无效的 ID</h1>");
  }
  const result = await getTodoById(id);
  if (!result.success) {
    return res.status(404).send(buildNotFoundPage(id));
  }
  res.send(buildDetailPage(result.data));
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
// 17. 启动服务器
// ------------------------------------------------------------
const PORT = 5580;

app.listen(PORT, async () => {
  console.log("============================================");
  console.log("🚀 Todo List 后端服务启动完毕！");
  console.log(`📍 访问地址：http://localhost:${PORT}`);
  console.log(`📋 添加待办：http://localhost:${PORT}/add`);
  console.log(`📖 待办列表：http://localhost:${PORT}/list`);
  console.log("============================================");

  // 测试数据库连接
  await testDatabaseConnection();
  // 初始化数据库表结构
  await initDatabase();
});