# 视频字幕校时 Web 工作台（SubSync Bench）

本地运行的视频字幕校时工具：导入**逐词转写**（带起止毫秒）与**镜头切点**，按可配置规则自动排出字幕，
人工校对/锁定后确认导出 **WebVTT**。Node.js + Express + SQLite（better-sqlite3）+ 原生浏览器前端，无外部服务依赖。

## 功能与约束

排片引擎（`src/arrange.js`，动态规划求可行解，非贪心）保证：

- **按原词序覆盖全部未锁定转写词**，逐词归属一条字幕，无遗漏；
- **字幕互不重叠**（相邻允许端点相接），起始严格等于首词起点，结束不早于末词终点——**不缩短、不错位任何词的时段**，只允许利用词后空隙向后延伸；
- **不跨越镜头切点**；切点落在某词内部属于无法消除的结构冲突；
- 每条字幕满足三条规则：**最大字数**、**最短显示时长 (ms)**、**每秒最多字数 (CPS)**；
- **规则无法同时满足时不输出任何字幕结果**，而是列出每条冲突的：
  - 类型（`RULES_INFEASIBLE` / `OVER_MAX_CHARS` / `CUT_INSIDE_WORD`）、
  - 受影响词段（词序号范围与文本）、
  - 冲突条件（实际可用时长 vs 最短时长需求 / CPS 需求时长）。

校对与版本控制：

- 可**锁定/解锁**任意字幕；再次排片只删除并重建未锁定字幕，锁定字幕（含其词段归属、时间、文本）原样保留；
- 规则设置带 `settings_version`、单条字幕修订带 `cue.version`：过期提交返回 **409** 与当前完整内容，不覆盖他人/较新的修改；
- 导出确认带内容指纹版本：确认后又被改动的内容无法用旧指纹蒙混导出。

导入校验：

- 时间必须是 `0 <= start_ms < end_ms` 的整数毫秒；
- 词段必须按时间严格递增且不重叠（`下一词.start >= 上一词.end`），否则拒绝整个导入；
- 切点必须为非负整数、严格递增且唯一。

导出：

- 确认后按时间升序生成 WebVTT（导出前再次检查重叠，重叠则拒绝）；
- VTT 全文作为**不可变快照**存入 SQLite，之后继续修改字幕不影响旧文件，可在「已确认导出」列表随时再次下载。

## 一条命令启动（Docker）

```bash
docker compose up --build
```

启动后访问：

- **地址：** http://localhost:3000
- **端口：** `3000`（容器内与宿主机均为 3000）

镜像构建时安装全部依赖（含 better-sqlite3；无预编译二进制时自动现场编译），
容器启动命令先执行 `node src/seed.js` 初始化数据库表并在数据为空时写入示例数据，然后启动服务。
SQLite 数据文件保存在 Docker 卷 `subsync-data`（容器内 `/data/subsync.db`），重建容器不丢数据。

停止：`docker compose down`（加 `-v` 可同时删除数据卷）。

## 本地直接运行（无 Docker）

要求 Node.js >= 18。

```bash
npm install
npm start
```

访问 http://localhost:3000 。数据默认写到 `./data/subsync.db`，首次启动自动建表并写入示例数据。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DATA_DIR` | 本地：`./data`；Docker：`/data` | SQLite 数据目录（自动创建） |
| `DB_PATH` | `$DATA_DIR/subsync.db` | 数据库文件完整路径 |
| `SEED_SAMPLE` | `1` | 首次初始化且词表为空时写入示例数据；设为 `0` 则建空库 |

默认排片规则（可在界面修改）：每条最大 18 字、最短显示 800 ms、CPS 上限 12。

## 使用流程

1. **导入**：粘贴 JSON 并点击「导入转写与切点」：
   ```json
   {
     "words": [
       { "start_ms": 0, "end_ms": 300, "text": "我们" },
       { "start_ms": 320, "end_ms": 600, "text": "今天" }
     ],
     "cuts": [1750, 3700]
   }
   ```
2. **设规则**：改最大字数 / 最短显示 / CPS 后「保存规则」（基于旧版本的保存会被拒绝并载入当前值）。
3. **排片校对**：点「自动排片」生成字幕；可逐条改文本、延长结束时间（不允许改起点/缩短），校验不过会列出全部原因；锁定已校对条目后再次排片只动其余部分；出现冲突时顶部红框列出受影响词段与具体冲突条件，数据不发生任何改动。
4. **确认导出**：点「确认并导出 VTT」，在导出列表中下载 `.vtt`；旧快照永久可下载，与后续修改无关。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态（规则+版本、词、切点、字幕、导出列表） |
| POST | `/api/import` | 导入/替换转写与切点（严格校验；锁定词范围越界时 409） |
| POST | `/api/reset` | 清空转写/切点/字幕（导出快照保留） |
| PUT | `/api/settings` | 改规则，需带 `expected_version` |
| POST | `/api/arrange` | 排片；冲突时 422 + `conflicts[]`，不改动数据 |
| PATCH | `/api/cues/:id` | 修订一条字幕，需带 `expected_version`（该条版本号） |
| POST | `/api/cues/:id/lock` | 锁定/解锁（body `{"lock":true/false}`） |
| POST | `/api/exports` | 确认并生成不可变 VTT 快照 |
| GET | `/api/exports/:id/download` | 再次下载历史快照 |

冲突对象示例：

```json
{
  "type": "RULES_INFEASIBLE",
  "word_start_seq": 7,
  "word_end_seq": 8,
  "text": "逐词 转写",
  "details": "词段「逐词 转写」(5 字, 2750-3500ms) 无法同时满足规则：可用时长 200ms < 最短显示 800ms；按 CPS 上限 12 字/秒需 417ms，可用仅 200ms"
}
```

## 测试

```bash
node test/engine.test.js
```

覆盖：全覆盖/不重叠/不缩短、三条规则、镜头切点分块与切点落词冲突、锁定保留与锁定夹逼冲突、
导入校验（倒序/重叠/非法时间/重复切点）、VTT 升序与重叠拒绝，共 10 项断言。

## 目录结构

```
server.js            Express 入口与全部 HTTP API（乐观锁、快照导出）
src/db.js            SQLite 连接、表结构与默认设置
src/seed.js          建表与示例数据初始化
src/arrange.js       排片引擎：校验 + DP 可行性求解 + 冲突诊断（纯函数）
src/vtt.js           WebVTT 序列化（升序、重叠拒绝）
public/              浏览器前端（原生 HTML/CSS/JS，无构建步骤）
test/engine.test.js  引擎测试
Dockerfile           依赖安装 + 数据初始化 + 启动
docker-compose.yml   一条命令启动（端口 3000、卷持久化）
```
