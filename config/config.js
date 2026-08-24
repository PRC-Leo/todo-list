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
