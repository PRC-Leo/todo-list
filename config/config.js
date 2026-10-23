// ============================================================
// Todo List 后端服务 —— 配置参数（外置）
// 修改本文件即可调整数据库连接、端口、时区、颜色映射、分类预设等。
// server.js 通过 require("./config/config.js") 读取，无需改动源码。
// ============================================================

module.exports = {
  // 数据库连接池
  db: {
    host: "localhost",            // 数据库主机地址
    port: 3306,                   // 数据库端口（MariaDB/MySQL 默认 3306）
    user: "root",                 // 数据库用户名
    password: "1204",           // 数据库密码
    database: "ljz-data",         // 使用的数据库名称
    table: "todos",               // 数据表名
    connectionLimit: 10,          // 连接池最大连接数
    acquireTimeout: 10000,        // 获取连接的超时时间（毫秒）
  },

  // 登录认证配置
  auth: {
    // 密码流程：前端提交 SHA-256(账号:密码)，后端再二次哈希后存库
    // 默认使用独立表名；若库中已有同名旧表且结构不同，改用本配置即可避开冲突
    usersTable: "todo_users",     // 登录用户表名
    sessionsTable: "todo_sessions", // 登录会话表名
    loginHistoryTable: "todo_login_history", // 历史登录记录表名
    cookieName: "sid",            // 会话 Cookie 名称
    sessionDays: 7,               // 会话有效期（天）
    locationLookup: true,         // 是否记录并解析登录设备的 IP 定位
    avatarMaxBytes: 512 * 1024,   // 后端接收并保存的头像最大字节数（前端会先压缩到 256×256）
  },

  // 管理后台配置（独立端口运行，认证逻辑与主系统一致）
  // 后端同样对前端提交的 SHA-256 哈希做二次哈希后存库
  // admin.usersTable / admin.sessionsTable 仅用于后台自身登录；
  // “用户管理/登录设备”读写上面的 auth.usersTable / auth.sessionsTable（主系统）。
  admin: {
    port: 6768,                   // 管理后台 HTTPS 监听端口
    https: {
      enabled: true,              // 是否启用 HTTPS（与主系统同一套证书）
      keyPath: "certs/key.pem",
      certPath: "certs/cert.pem",
      redirectHttp: true,         // 是否启动 HTTP→HTTPS 跳转
      httpRedirectPort: 8081,     // 管理后台 HTTP 跳转端口
    },
    usersTable: "admin_users",    // 管理后台自身登录用户表
    sessionsTable: "admin_sessions", // 管理后台自身会话表
    cookieName: "admin_sid",      // 管理后台会话 Cookie，与主系统区分
    sessionDays: 7,               // 管理后台会话有效期（天）
    locationLookup: true,         // 是否进行 IP 定位
    initialAdmin: {               // 首次启动自动创建的管理员（后续重启不覆盖）
      account: "admin",
      password: "ebs_admin",
    },
  },

  // 操作日志：只记录主系统操作，保存在数据库表中
  logging: {
    enabled: true,                // 是否记录操作日志
    table: "operation_logs",      // 统一操作日志表名
  },

  // 服务监听端口
  port: 6767,

  // HTTPS 配置（升级为 HTTPS 协议）
  https: {
    enabled: true,                 // 是否启用 HTTPS
    keyPath: "certs/key.pem",      // 私钥文件相对路径（相对项目根目录）
    certPath: "certs/cert.pem",    // 证书文件相对路径
    redirectHttp: true,            // 是否同时启动 HTTP→HTTPS 跳转服务
    httpRedirectPort: 8080,        // HTTP 跳转服务监听端口
  },

  // 时区偏移（小时），UTC+8 即 8
  timezoneOffsetHours: 8,

  // 紧急程度颜色映射：色值 -> { label, cssColor }
  urgencyMap: {
    "#AAAAAA": { label: "无",    cssColor: "#AAAAAA" },
    "#28A745": { label: "不急",  cssColor: "#28A745" },
    "#007BFF": { label: "中等",  cssColor: "#007BFF" },
    "#FFC107": { label: "紧急",  cssColor: "#FFC107" },
    "#DC3545": { label: "最高",  cssColor: "#DC3545" },
  },

  // 分类预设列表（/add 表单下拉选项，按顺序展示）
  categories: [
    "前端开发",
    "后端开发",
    "UI设计",
    "DevOps",
    "文档",
    "Bug修复",
    "代码审查",
    "学习研究",
    "会议",
    "其他",
  ],
};
