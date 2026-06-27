# Todo List 后端服务

一个基于 **Node.js + Express + MariaDB** 的待办任务后端服务，提供完整的 REST API 和网页界面。

---

## 基本信息

| 项目 | 说明 |
|------|------|
| **应用名称** | Todo List by PRC-Leo |
| **版本** | 1.0.0 |
| **运行环境** | Node.js v24+ |
| **框架** | Express v5 |
| **数据库** | MariaDB（兼容 MySQL） |
| **默认端口** | `5580` |
| **时区** | UTC+8 |

---

## 快速启动

```bash
# 安装依赖
npm install

# 启动服务（生产模式）
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

启动后访问：
- 服务信息：`http://localhost:5580/`
- 添加待办：`http://localhost:5580/add`
- 待办列表：`http://localhost:5580/list`

---

## 数据库配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 主机 | `localhost` | 数据库地址 |
| 端口 | `3306` | MariaDB/MySQL 端口 |
| 用户 | `root` | 数据库用户 |
| 密码 | `123456` | 数据库密码 |
| 数据库 | `ljz-data` | 数据库名 |
| 数据表 | `todos` | 自动创建 |
| 连接池上限 | `10` | 最大并发连接数 |

修改配置：编辑 `server.js` 第 25-33 行的 `pool` 对象。

---

## 数据表结构

表名：`todos`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT（自增主键） | 任务唯一 ID，系统自动分配 |
| `title` | VARCHAR(255) NOT NULL | 任务标题，必填 |
| `description` | TEXT | 具体事项描述 |
| `category` | VARCHAR(100) | 分类名称 |
| `color` | VARCHAR(7) | 分组颜色（十六进制色值） |
| `completed` | BOOLEAN | 是否已完成，默认 false |
| `created_at` | DATETIME | 创建时间，系统自动写入 |
| `updated_at` | DATETIME | 更新时间，系统自动写入 |

> 服务启动时会自动检查并创建数据表，无需手动建表。

---

## 紧急程度颜色预设

| 颜色 | 色值 | 含义 |
|------|------|------|
| <span style="color:#AAAAAA">⬤</span> 灰 | `#AAAAAA` | 无 |
| <span style="color:#28A745">⬤</span> 绿 | `#28A745` | 不急 |
| <span style="color:#007BFF">⬤</span> 蓝 | `#007BFF` | 中等 |
| <span style="color:#FFC107">⬤</span> 黄 | `#FFC107` | 紧急 |
| <span style="color:#DC3545">⬤</span> 红 | `#DC3545` | 最高 |

---

## 分类预设

`前端开发` `后端开发` `UI设计` `DevOps` `文档` `Bug修复` `代码审查` `学习研究` `会议` `其他`

也支持自定义分类。

---

## API 接口

### 根路由 —— 服务信息

```
GET /
```

返回服务基本信息（名称、版本、状态）。

---

### 获取所有待办

```
GET /api/todos
```

**响应示例：**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "重构用户认证模块",
      "description": "将现有 session 认证迁移为 JWT 方案",
      "category": "后端开发",
      "color": "#DC3545",
      "completed": false,
      "createdAt": "2026-06-27T08:00:00.000Z",
      "updatedAt": "2026-06-27T08:00:00.000Z"
    }
  ],
  "total": 1
}
```

---

### 获取单条待办

```
GET /api/todos/:id
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 待办 ID |

---

### 添加待办

```
POST /api/todos
Content-Type: application/json
```

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 任务标题 |
| `description` | string | | 具体事项 |
| `category` | string | | 分类名称 |
| `color` | string | | 颜色色值 |
| `completed` | boolean | | 是否已完成 |

**请求示例：**

```json
{
  "title": "修复登录页面样式",
  "description": "调整移动端响应式布局，修复按钮间距问题",
  "category": "前端开发",
  "color": "#FFC107",
  "completed": false
}
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "title": "修复登录页面样式",
    "description": "调整移动端响应式布局，修复按钮间距问题",
    "category": "前端开发",
    "color": "#FFC107",
    "completed": false,
    "createdAt": "2026-06-27T16:30:00.000Z",
    "updatedAt": "2026-06-27T16:30:00.000Z"
  }
}
```

---

### 切换完成状态

```
PATCH /api/todos/:id
```

将待办的 `completed` 状态翻转（未完成 → 已完成，或已完成 → 未完成），同时自动更新 `updated_at` 时间。

**无需请求体。**

---

### 健康检查

```
GET /api/health
```

---

## 页面路由

| 路由 | 说明 |
|------|------|
| `/` | 服务基本信息（JSON） |
| `/add` | 添加待办的表单页面 |
| `/list` | 待办任务列表页，可切换完成状态 |
| `/:id` | 待办详情页，查看完整信息并可切换状态 |

---

## JSON 数据结构示例

```json
{
  "id": 1,
  "title": "重构用户认证模块",
  "description": "将现有 session 认证迁移为 JWT 方案，更新中间件和前端拦截器。",
  "category": "后端开发",
  "color": "#DC3545",
  "completed": false,
  "createdAt": "2026-06-27T08:00:00.000Z",
  "updatedAt": "2026-06-27T08:00:00.000Z"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 有序数字 ID，自增唯一标识 |
| `title` | string | 任务标题 |
| `description` | string | 具体事项描述 |
| `category` | string | 分类名称 |
| `color` | string | 分组颜色，十六进制色值 |
| `completed` | boolean | 是否已完成 |
| `createdAt` | string | 创建时间（ISO 格式，UTC+8） |
| `updatedAt` | string | 最后更新时间（ISO 格式，UTC+8） |

> `id`、`createdAt`、`updatedAt` 由系统自动写入，不可手动修改。

---

## 技术栈

- **运行时**：Node.js
- **框架**：Express v5
- **数据库驱动**：MariaDB Connector/Node.js (mariadb v3)
- **数据库**：MariaDB / MySQL
- **字符集**：utf8mb4