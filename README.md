# Todo List 后端服务 — EBS 待办工作站

基于 **Node.js + Express + MariaDB** 的待办任务后端服务，提供完整的 REST API 和网页 GUI 界面。

---

## 基本信息

| 项目 | 说明 |
|------|------|
| **应用名称** | EBS 待办工作站 (Todo List by PRC-Leo) |
| **版本** | 1.0.0 |
| **运行环境** | Node.js v24+ |
| **框架** | Express v5 |
| **数据库** | MariaDB（兼容 MySQL） |
| **默认端口** | `6767` |
| **协议** | HTTPS（自签名证书），另在 `8080` 提供 HTTP→HTTPS 跳转 |
| **时区** | UTC+8 |

---

## 环境配置与部署

### 1. 前置要求

- **Node.js** v24 或以上：[下载地址](https://nodejs.org/)
- **MariaDB**（或 MySQL）：已安装并运行中
- **创建数据库**：在 MariaDB 中创建数据库 `ljz-data`：
  ```sql
  CREATE DATABASE IF NOT EXISTS `ljz-data` DEFAULT CHARSET utf8mb4;
  ```

### 2. 安装依赖

```bash
# 进入项目目录
cd todo-list

# 安装项目依赖
npm install
```

安装的依赖包：
| 包名 | 版本 | 用途 |
|------|------|------|
| `express` | ^5.x | Web 框架 |
| `mariadb` | ^3.x | MariaDB 数据库连接池 |

### 3. 配置参数

所有可配置参数集中在 **`config/config.js`** 中。`server.js` 启动时通过 `require("./config/config.js")` 读取，修改配置无需改动源码。

`config/config.js` 顶层结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `db` | object | 数据库连接池配置 |
| `port` | number | 服务监听端口 |
| `https` | object | HTTPS 配置（证书路径、HTTP 跳转服务） |
| `timezoneOffsetHours` | number | 时区偏移（小时），`8` 即 UTC+8 |
| `urgencyMap` | object | 紧急程度颜色映射 |
| `categories` | string[] | 分类预设列表 |

#### 数据库连接池

在 `config.db` 中修改：

```js
db: {
  host: "localhost",            // 数据库主机地址
  port: 3306,                   // 数据库端口（MariaDB/MySQL 默认 3306）
  user: "root",                 // 数据库用户名
  password: "1204",             // 数据库密码
  database: "ljz-data",         // 使用的数据库名称
  table: "todos",               // 数据表名
  connectionLimit: 10,          // 连接池最大连接数
  acquireTimeout: 10000,        // 获取连接的超时时间（毫秒）
}
```

#### 服务端口

```js
port: 6767,
```

#### 数据表名

```js
table: "todos",
```

启动时由 `initDatabase()` 自动创建，无需手动建表。

#### 时区

```js
timezoneOffsetHours: 8,   // UTC+8
```

所有时间按此偏移计算（`getUTC8Time()`）。

#### 紧急程度颜色预设

```js
urgencyMap: {
  "#AAAAAA": { label: "无",    cssColor: "#AAAAAA" },
  "#28A745": { label: "不急",  cssColor: "#28A745" },
  "#007BFF": { label: "中等",  cssColor: "#007BFF" },
  "#FFC107": { label: "紧急",  cssColor: "#FFC107" },
  "#DC3545": { label: "最高",  cssColor: "#DC3545" },
}
```

页面与服务端共用此映射（`/list` 页面通过 `JSON.stringify` 注入）。

#### 分类预设

```js
categories: [
  "前端开发", "后端开发", "UI设计", "DevOps", "文档",
  "Bug修复", "代码审查", "学习研究", "会议", "其他",
]
```

`/add` 表单下拉选项由该列表生成，末尾自动附带「自定义分类」选项。

### 4. 启动服务

```bash
# 生产模式
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

启动成功后会显示：
```
============================================
🚀 Todo List 后端服务启动完毕（HTTPS）！
🔒 HTTPS 已启用（自签名证书）。
📍 访问地址：https://localhost:6767
📋 添加待办：https://localhost:6767/add
📖 待办列表：https://localhost:6767/list
   首次访问浏览器会提示证书不受信任，点击「高级 → 继续」即可。
============================================
↩️  HTTP→HTTPS 跳转服务已启动：http://localhost:8080 → https://localhost:6767
✅ 数据库连接成功！MariaDB 连接池已就绪。
   主机：localhost:3306 | 数据库：ljz-data
✅ 数据表 todos 已就绪（ljz-data.todos）。
```

### 5. 访问页面

| 地址 | 页面 |
|------|------|
| `https://localhost:6767/` | 欢迎首页 GUI |
| `https://localhost:6767/add` | 添加待办表单 |
| `https://localhost:6767/list` | 待办任务列表 |
| `https://localhost:6767/{id}` | 待办详情页（如 `/1`） |

> 也可用 `http://localhost:8080` 访问，会自动 301 跳转到 HTTPS。

---

## HTTPS 与证书说明

本服务已升级为 HTTPS（自签名证书）。证书位于 `certs/`，已加入 `.gitignore` 不入库。

`config/config.js` 中的 `https` 段控制 HTTPS 行为：

```js
https: {
  enabled: true,              // 是否启用 HTTPS
  keyPath: "certs/key.pem",   // 私钥路径（相对项目根目录）
  certPath: "certs/cert.pem", // 证书路径
  redirectHttp: true,         // 是否启动 HTTP→HTTPS 跳转
  httpRedirectPort: 8080,     // 跳转服务端口
}
```

- `enabled: false` 时仍以原 HTTP 模式启动（向后兼容）。
- 证书读取失败时会打印错误并自动回退为 HTTP，保证服务可用。
- 首次用浏览器访问 `https://localhost:6767` 会提示证书不受信任，依次点击「高级 → 继续前往 localhost」即可。

### 重新生成自签名证书

使用随 Git 附带的 OpenSSL（如 `D:\Git\usr\bin\openssl.exe`）：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

### 生产环境建议

自签名证书仅适用于本地/内网。正式域名部署建议用 Let's Encrypt（Certbot）或 [mkcert](https://github.com/FiloSottile/mkcert) 签发受信任证书，替换 `certs/` 内文件即可，无需改动代码。

## 常见部署问题

| 问题 | 解决方案 |
|------|----------|
| ❌ 数据库连接失败 | 确保 MariaDB 服务已启动，检查 `config/config.js` 中 `db` 配置 |
| ❌ 数据库 `ljz-data` 不存在 | 手动创建：`CREATE DATABASE IF NOT EXISTS \`ljz-data\` DEFAULT CHARSET utf8mb4;` |
| ❌ 端口 6767 被占用 | 在 `config/config.js` 中修改 `port` 为其他端口 |
| ❌ HTTPS 证书读取失败 | 服务会自动回退为 HTTP；检查 `config/config.js` 中 `https.keyPath`/`certPath` 或重新生成证书 |
| ❌ 端口 8080 被占用 | HTTP 跳转端口冲突；改 `https.httpRedirectPort` 或设 `https.redirectHttp: false` |
| ❌ 浏览器提示证书不受信任 | 自签名证书的预期行为，点「高级 → 继续」即可；正式部署换受信任证书 |
| ❌ `npm install` 失败 | 检查 Node.js 版本 ≥ v24，尝试 `npm install --registry https://registry.npmmirror.com` |
| ❌ 页面中文乱码 | MariaDB 字符集需设置为 `utf8mb4` |

---

## 数据表结构

表名：`todos`（自动创建）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT（自增主键） | 任务唯一 ID，系统自动分配 |
| `title` | VARCHAR(255) NOT NULL | 任务标题，必填 |
| `description` | TEXT | 具体事项描述 |
| `category` | VARCHAR(100) | 分类名称 |
| `color` | VARCHAR(7) | 分组颜色（十六进制色值） |
| `completed` | BOOLEAN | 是否已完成，默认 false |
| `created_at` | DATETIME | 创建时间，系统自动写入（UTC+8） |
| `updated_at` | DATETIME | 更新时间，系统自动写入（UTC+8） |

---

## API 接口

### 根路由

```
GET /
```
返回欢迎首页 HTML 页面（GUI）。

### 获取所有待办

```
GET /api/todos
```

**响应：**
```json
{
  "success": true,
  "data": [{ "id": 1, "title": "...", ... }],
  "total": 1
}
```

### 获取单条待办

```
GET /api/todos/:id
```

### 添加待办

```
POST /api/todos
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 任务标题 |
| `description` | string | | 具体事项 |
| `category` | string | | 分类名称 |
| `color` | string | | 颜色色值 |
| `completed` | boolean | | 是否已完成 |

### 更新待办

```
PUT /api/todos/:id
Content-Type: application/json
```

支持部分更新，只需传要修改的字段。

### 切换完成状态

```
PATCH /api/todos/:id
```
无需请求体，自动翻转 `completed` 状态。

### 删除待办

```
DELETE /api/todos/:id
```
删除后返回 `{ success: true }`。

### 健康检查

```
GET /api/health
```

---

## 页面路由

| 路由 | 说明 |
|------|------|
| `/` | 欢迎首页 GUI（动画入场） |
| `/add` | 添加待办表单页 |
| `/list` | 待办列表页（切换状态、删除） |
| `/:id` | 待办详情页（切换状态、删除） |

---

## JSON 数据结构示例

```json
{
  "id": 1,
  "title": "重构用户认证模块",
  "description": "将现有 session 认证迁移为 JWT 方案。",
  "category": "后端开发",
  "color": "#DC3545",
  "completed": false,
  "createdAt": "2026-06-27T08:00:00.000Z",
  "updatedAt": "2026-06-27T08:00:00.000Z"
}
```

> `id`、`createdAt`、`updatedAt` 由系统自动写入，不可手动修改。

---

## 技术栈

- **运行时**：Node.js v24+
- **框架**：Express v5
- **数据库驱动**：MariaDB Connector/Node.js v3
- **数据库**：MariaDB / MySQL
- **字符集**：utf8mb4
