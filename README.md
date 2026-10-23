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
| **登录** | `/login` 浏览器端哈希登录，后端二次哈希后存库；无注册通道 |
| **管理后台** | `https://localhost:6768`，HTTP 跳转 `http://localhost:8081` |

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
| `geoip-lite` | ^2.x | 管理后台 IP 定位 |

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
| `auth` | object | 登录认证配置（用户表、会话表、登录历史表、Cookie、头像限制） |
| `admin` | object | 管理后台配置（端口、证书、用户表、会话表、Cookie） |
| `logging` | object | 主系统操作日志开关与日志表名 |

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

#### 认证、密码与个人中心

登录认证相关配置位于 `config.auth`：

```js
auth: {
  usersTable: "todo_users",
  sessionsTable: "todo_sessions",
  loginHistoryTable: "todo_login_history",
  cookieName: "sid",
  sessionDays: 7,
  locationLookup: true,
  avatarMaxBytes: 512 * 1024,
}
```

`avatarMaxBytes` 限制后端接收并保存的头像数据大小，默认 `512 KB`。浏览器会先把用户选择的长图裁剪并压缩为 256×256 WebP。

密码不会以明文形式提交或保存：

1. 浏览器计算 `clientHash = SHA-256(规范化账号:密码)` 并提交给后端。
2. 后端再次计算 `v2:SHA-256(规范化账号:clientHash)` 后存入数据库。
3. 登录校验兼容迁移前的旧 64 位十六进制哈希。

密码哈希字段使用 `VARCHAR(128)`。服务启动时会自动将旧哈希升级为 `v2:` 二次哈希；也可手动执行幂等迁移：

```bash
npm run migrate:hash
```

重复执行不会再次加密已有记录。主系统和管理后台使用相同的密码存储规则。

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

Windows 下可直接双击 `start.bat` 一键启动主系统和管理后台；脚本会先检测端口，已在运行的实例会自动跳过，不会重复启动。

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
✅ 数据表 todo_login_history 已就绪（ljz-data.todo_login_history）。
```

### 5. 访问页面

| 地址 | 页面 |
|------|------|
| `https://localhost:6767/` | 欢迎首页 GUI |
| `https://localhost:6767/add` | 添加待办表单 |
| `https://localhost:6767/list` | 待办任务列表 |
| `https://localhost:6767/{id}` | 待办详情页（如 `/1`） |

> 也可用 `http://localhost:8080` 访问，会自动 301 跳转到 HTTPS。

登录后，主系统页面右上角会显示用户头像菜单，支持：

- 上传或恢复默认头像。浏览器会将图片居中裁剪并压缩为 256×256 WebP，后端校验格式和大小后保存到 `todo_users.avatar_data`。
- 查看历史登录记录，包括设备、登录时间、IP 和 IP 定位。退出登录或会话过期后记录仍会保留。
- 查看自己的操作日志。仅返回当前账号产生的主系统日志，支持中文自然语言展示和查看原始日志。
- 退出登录。

个人中心不需要单独页面，所有功能均从右上角头像菜单打开。

### 6. 管理后台

管理后台自身登录使用独立的端口、后台用户表/会话表和 Cookie（`admin_sid`），登录校验规则与主系统一致；后台的“用户管理/登录设备”读写主系统的 `auth.usersTable` / `auth.sessionsTable`（默认 `todo_users` / `todo_sessions`），“操作日志”读取 `logging.table`（默认 `operation_logs`）。

```bash
# 启动管理后台
npm run admin

# 开发模式（文件变更自动重启）
npm run dev:admin
```

- 管理地址：`https://localhost:6768`
- HTTP 跳转：`http://localhost:8081 -> https://localhost:6768`
- 默认管理员：`admin / ebs_admin`（可在配置中修改，仅首次启动创建）
- 左侧栏：用户管理、登录设备、操作日志
- 用户管理：读写主系统用户列表、添加主系统用户、强制重置密码；添加用户时可设置 `user` 或 `admin` 级别，密码留空时默认 `123456`
- 登录设备：展示账号、设备、时间、IP+定位；可强制踢下线
- 操作日志：查看主系统的全部结构化日志，并在前端生成中文自然语言解释；数据库中不保存翻译文本
- 重置主系统用户密码后，该用户的所有主系统登录会话会立即失效
- 密码存储与校验规则与主系统一致：浏览器提交 `SHA-256(规范化账号:密码)`，后端二次哈希后以 `v2:` 格式存库

管理后台配置集中在 `config.admin`：

```js
admin: {
  port: 6768,                            // 管理后台 HTTPS 监听端口
  https: {                              // 与主系统同一套证书
    enabled: true,
    keyPath: "certs/key.pem",
    certPath: "certs/cert.pem",
    redirectHttp: true,
    httpRedirectPort: 8081,
  },
  usersTable: "admin_users",
  sessionsTable: "admin_sessions",
  cookieName: "admin_sid",
  sessionDays: 7,
  locationLookup: true,                 // 是否进行 IP 定位
  initialAdmin: {
    account: "admin",
    password: "ebs_admin",
  },
}
```

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
| ❌ 管理后台端口 6768 被占用 | 修改 `admin.port` 为其他端口 |
| ❌ 管理后台 HTTP 跳转 8081 被占用 | 修改 `admin.https.httpRedirectPort` 或设 `admin.https.redirectHttp: false` |
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

### 管理后台用户表 `admin_users`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT（自增主键） | 管理用户 ID |
| `account` | VARCHAR(64) 唯一 | 规范化账号（小写、去首尾空格） |
| `password_hash` | VARCHAR(128) | `v2:SHA-256(账号:clientHash)` 二次哈希 |
| `level` | ENUM(`user`,`admin`) | 用户级别；`admin` 才能进入用户管理 |
| `created_at` | DATETIME | 创建时间（UTC+8） |
| `updated_at` | DATETIME | 更新时间（UTC+8） |
| `last_login_at` | DATETIME NULL | 最近登录时间（UTC+8） |

### 管理后台会话表 `admin_sessions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | CHAR(64) 主键 | 随机会话令牌 |
| `user_id` | INT | 关联管理用户 ID（级联删除） |
| `device_label` | VARCHAR(200) | 从 User-Agent 解析出的设备名称 |
| `user_agent` | VARCHAR(500) | 原始 User-Agent |
| `ip_address` | VARCHAR(64) | 登录 IP |
| `location` | VARCHAR(200) | IP 定位；内网显示「内网」，未识别显示「未知」 |
| `created_at` | DATETIME | 会话创建时间（UTC+8） |
| `expires_at` | DATETIME | 会话过期时间（UTC+8） |
| `last_active_at` | DATETIME NULL | 最近活跃时间（UTC+8） |

### 主系统用户表 `todo_users`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT（自增主键） | 用户 ID |
| `account` | VARCHAR(64) 唯一 | 规范化账号（小写、去首尾空格） |
| `password_hash` | VARCHAR(128) | `v2:SHA-256(账号:clientHash)` 二次哈希 |
| `display_name` | VARCHAR(50) NULL | 展示名称 |
| `avatar_data` | MEDIUMTEXT NULL | 自定义头像，保存为经过校验的图片 data URL |
| `is_active` | BOOLEAN | 账号是否启用，默认 1 |
| `level` | ENUM(`user`,`admin`) | 用户级别，默认 `user` |
| `created_at` | DATETIME | 创建时间（UTC+8） |
| `updated_at` | DATETIME | 更新时间（UTC+8） |
| `last_login_at` | DATETIME NULL | 最近登录时间（UTC+8） |

### 主系统会话表 `todo_sessions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | CHAR(64) 主键 | 随机会话令牌 |
| `user_id` | INT | 关联主系统用户 ID（级联删除） |
| `device_label` | VARCHAR(200) | 从 User-Agent 解析出的设备名称 |
| `user_agent` | VARCHAR(500) | 原始 User-Agent |
| `ip_address` | VARCHAR(64) | 登录 IP |
| `location` | VARCHAR(200) | IP 定位；内网显示「内网」，未识别显示「未知」 |
| `created_at` | DATETIME | 会话创建时间（UTC+8） |
| `expires_at` | DATETIME | 会话过期时间（UTC+8） |
| `last_active_at` | DATETIME NULL | 最近活跃时间（UTC+8） |

### 主系统登录历史表 `todo_login_history`

成功登录时单独写入，不随会话退出或过期而删除。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT（自增主键） | 登录历史 ID |
| `user_id` | INT | 关联主系统用户 ID（用户删除时级联删除） |
| `account` | VARCHAR(64) | 登录账号 |
| `session_token` | CHAR(64) UNIQUE NULL | 对应会话令牌，仅用于避免重复写入 |
| `device_label` | VARCHAR(200) | 从 User-Agent 解析出的设备名称 |
| `user_agent` | VARCHAR(500) | 原始 User-Agent |
| `ip_address` | VARCHAR(64) | 登录 IP |
| `location` | VARCHAR(200) | IP 定位 |
| `login_at` | DATETIME | 登录时间（UTC+8） |

### 操作日志表 `operation_logs`

只记录主系统操作，不记录管理后台自身的操作。数据库中只保存结构化原文，中文自然语言解释由前端动态生成。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT（自增主键） | 日志 ID |
| `source` | ENUM(`main`,`admin`) | 日志来源；当前业务只写入 `main` |
| `account` | VARCHAR(64) | 操作账号 |
| `action` | VARCHAR(64) | 操作标识，如 `main.todo.create` |
| `raw_log` | TEXT | JSON 格式的结构化日志原文 |
| `ip_address` | VARCHAR(64) NULL | 操作 IP |
| `location` | VARCHAR(200) NULL | IP 定位 |
| `created_at` | DATETIME | 操作时间（UTC+8） |

---

## API 接口

### 根路由

```
GET /
```
返回欢迎首页 HTML 页面（GUI）。

### 登录

```
POST /api/login
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `account` | string | ✅ | 登录账号 |
| `passwordHash` | string | ✅ | 浏览器端计算出的 64 位 SHA-256 哈希 |

登录成功后写入会话和登录历史，并通过 HttpOnly Cookie 保持登录态。

### 当前用户

```
GET /api/auth/me
```

返回当前登录账号、展示名称、用户级别和头像数据；未登录返回 `401`。

### 退出登录

```
POST /api/logout
```

删除当前会话和 Cookie。

### 更新个人头像

```
PUT /api/me/avatar
Content-Type: application/json
```

请求体：

```json
{
  "avatarData": "data:image/webp;base64,..."
}
```

支持 PNG、JPEG、WebP，后端会校验图片内容与大小。传入 `null` 可恢复默认头像。

### 查看历史登录记录

```
GET /api/me/login-history?limit=30
```

只返回当前登录用户自己的记录，默认最多 30 条，最多可请求 100 条。

### 查看个人操作日志

```
GET /api/me/activity?limit=50&offset=0
```

只返回当前账号产生的主系统操作日志，默认 50 条，单次最多 200 条。

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
