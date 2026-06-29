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
| **默认端口** | `5580` |
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

所有配置在 `server.js` 文件中修改。主要配置项：

#### 数据库连接池（第 25-33 行）

```js
const pool = mariadb.createPool({
  host: "localhost",        // 数据库主机地址
  port: 3306,               // 数据库端口（MariaDB/MySQL 默认 3306）
  user: "root",             // 数据库用户名
  password: "123456",       // 数据库密码
  database: "ljz-data",     // 使用的数据库名称
  connectionLimit: 10,      // 连接池最大连接数
  acquireTimeout: 10000,    // 获取连接的超时时间（毫秒）
});
```

#### 服务端口（第 1398 行附近）

```js
const PORT = 5580;
```

修改此值可更改服务监听端口。

#### 数据表名

数据表名为 `todos`（固定），在 `initDatabase()` 函数中自动创建，无需手动建表。

#### 时区

所有时间使用 UTC+8，在 `getUTC8Time()` 函数中处理。

#### 紧急程度颜色预设

定义在 `URGENCY_MAP` 常量中（第 222-228 行）：

```js
const URGENCY_MAP = {
  "#AAAAAA": { label: "无" },
  "#28A745": { label: "不急" },
  "#007BFF": { label: "中等" },
  "#FFC107": { label: "紧急" },
  "#DC3545": { label: "最高" },
};
```

#### 分类预设

定义在 `/add` 页面和 `/:id` 修改表单的 `<select>` 选项中：

`前端开发` `后端开发` `UI设计` `DevOps` `文档` `Bug修复` `代码审查` `学习研究` `会议` `其他` + 自定义

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
🚀 Todo List 后端服务启动完毕！
📍 访问地址：http://localhost:5580
📋 添加待办：http://localhost:5580/add
📖 待办列表：http://localhost:5580/list
============================================
✅ 数据库连接成功！MariaDB 连接池已就绪。
   主机：localhost:3306 | 数据库：ljz-data
✅ 数据表 todos 已就绪（ljz-data.todos）。
```

### 5. 访问页面

| 地址 | 页面 |
|------|------|
| `http://localhost:5580/` | 欢迎首页 GUI |
| `http://localhost:5580/add` | 添加待办表单 |
| `http://localhost:5580/list` | 待办任务列表 |
| `http://localhost:5580/{id}` | 待办详情页（如 `/1`） |

---

## 常见部署问题

| 问题 | 解决方案 |
|------|----------|
| ❌ 数据库连接失败 | 确保 MariaDB 服务已启动，检查 `host`/`port`/`user`/`password` 配置 |
| ❌ 数据库 `ljz-data` 不存在 | 手动创建：`CREATE DATABASE IF NOT EXISTS \`ljz-data\` DEFAULT CHARSET utf8mb4;` |
| ❌ 端口 5580 被占用 | 在 `server.js` 中修改 `const PORT = 5580;` 为其他端口 |
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