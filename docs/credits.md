# 致谢与开源声明

> 这个工具是站在别人肩膀上搭起来的。这里把那些肩膀一一写清楚。
>
> 面向普通用户的是「关于」页里那段简版；这份是完整版，给想看细节的人。

---

## 一、这段程序靠什么跑起来

### 后端

| 项目 | 干了什么 | 协议 |
|---|---|---|
| [FastAPI](https://fastapi.tiangolo.com/) | Web 框架，负责所有接口 | MIT |
| [Uvicorn](https://www.uvicorn.org/) | ASGI 服务器，就是它把程序跑起来的 | BSD-3-Clause |
| [Pydantic](https://docs.pydantic.dev/) | 数据校验，接口收进来的东西先过它 | MIT |
| [Starlette](https://www.starlette.io/) | FastAPI 底下的 ASGI 工具箱 | BSD-3-Clause |
| [PyYAML](https://pyyaml.org/) | 读写 YAML（实体档案的头部信息） | MIT |
| [python-frontmatter](https://github.com/eyeseast/python-frontmatter) | 解析 Markdown 的 YAML 头部 | MIT |
| [HTTPX](https://www.python-httpx.org/) | 调 AI 服务与云端识别 | BSD-3-Clause |
| [python-multipart](https://github.com/Kludex/python-multipart) | 处理上传文件（导入设定稿、贴底图） | Apache-2.0 |

### 前端

| 项目 | 干了什么 | 协议 |
|---|---|---|
| [React](https://react.dev/) | 界面框架 | MIT |
| [Vite](https://vitejs.dev/) | 前端构建工具 | MIT |
| [dockview](https://dockview.dev/) | **面板能自由拖拽停靠**，就是它 | MIT |
| [Three.js](https://threejs.org/) | 三维渲染引擎 | MIT |
| [@react-three/fiber](https://github.com/pmndrs/react-three-fiber) | 让 Three.js 能用 React 写 | MIT |
| [3d-force-graph](https://github.com/vasturiano/3d-force-graph) | 三维关系图的力导向布局 | MIT |
| [D3](https://d3js.org/) | 各种布局算法（力导向 / 放射 / 树形 / 环形…） | ISC |
| [ECharts](https://echarts.apache.org/) | 统计图表 | Apache-2.0 |

### 打包与运行环境

| 项目 | 干了什么 | 协议 |
|---|---|---|
| [Python](https://www.python.org/) | 语言本身；分发包里带的是官方**嵌入式版** | PSF License |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | 安装程序（你在安装向导里看到的那些页面） | Inno Setup License —— **允许商用**（见下方说明） |
| [SQLite](https://sqlite.org/) | 那个可以随时删掉重建的索引文件 | Public Domain |

---

## 二、特别说明：三个「没用」

写下来是因为这几个选择都是刻意的，不是不知道：

### 1. 没用任何 GPL / AGPL / SSPL 的组件

这类协议会「传染」—— 一旦用上，整个程序就得跟着开源，或者干脆不许商用。
这个工具从第一天起就把「全链路协议必须可商用」写成了铁律，每次打包前自动重扫一遍依赖树，
命中就中止打包。审计记录见 `licenses.md`。

### 2. 没用系统托盘库（pystray 之类）

最常见的 Python 托盘方案是 `pystray`，但它是 **LGPL-3.0** —— 不符合上面那条铁律。
所以这个托盘是用 Python 自带的 `ctypes` 直接调 Windows 接口写的，零第三方依赖。
代价是多写了一百来行，换来的是协议上一点疑问都没有。

### 3. 没用 PyInstaller 打包（列在这里是因为很多人会问）

PyInstaller 其实**可以**商用（GPL-2.0 但带 Bootloader 例外，官方明确说明打包产物可按任意协议发布），
只是它的元数据里只标了 GPLv2，容易被误判，还得专门解释一遍。
官方嵌入式 Python 没有这个问题，而且更轻。同理排除掉了 Nuitka（AGPL-3.0）。

---

## 二·补：Inno Setup 的协议要说清楚

这条容易被误读，所以单列。Inno Setup 官网首页写着一句
「Using Inno Setup commercially? Please purchase a license.」

**但那是一句礼貌请求，不是法律要求。** 它的许可原文（`LICENSE.TXT`）是许可式的：

> Permission is granted to anyone to use this software for any purpose,
> **including commercial applications**, and to alter and redistribute it…

附带的条件只有三条，都很轻：保留版权声明、不得声称是自己写的、改动过的版本要标明是改动版。
所以**用它打包并商用是允许的**。

不过作者确实希望商业用户自觉买一份授权（三十来美元），他的请求写得很客气（"Please"、"Thank you"）。
要不要买是个人的事 —— 记在这儿，是因为**这件事该让你知道，而不是被含糊过去**。

另外：我们只是**用它来生成安装程序**，并不随包分发 Inno Setup 本体 ——
所以许可里那条「二进制分发要保留 About 框里的版权声明」对我们不适用。

---

## 三、数据格式与互操作性

| 用到的东西 | 说明 |
|---|---|
| **Markdown** | 你的实体档案就是 Markdown 文件。用记事本、VS Code、Obsidian、Typora 都能直接打开 —— 这是刻意的，**你永远有退路** |
| **YAML frontmatter** | 档案头部的结构化信息，是 Markdown 生态的通行做法 |
| **JSON** | 视图布局、样式包、主题包的格式 |
| **PNG / JPG / WEBP / SVG / WOFF2** | 素材格式，全是开放标准 |

没有任何私有格式、没有需要联网才能读的数据、没有藏在数据库里的孤本。
就算哪天这个程序装不上了，你的稿子和设定一个字符都不会少。

---

## 四、图标与素材来源

| 素材 | 来源 |
|---|---|
| 演示用节点图标 | `scripts/make_demo_icons.py` 用图形库现画（几何图形），**非第三方素材** |
| 内置示例书 | `app/api/sample.py` **按同一套数据规范现生成**（不是预置的数据文件），书名、地名、人名均为虚构 |
| 打赏二维码 | 本人收款码 |

> 示例书只在你主动点「新建示例书」时生成，落盘后跟手建的书没有任何区别，随时可删。
> 之所以不做成「预置数据文件」，是为了不让数据长在程序目录里 —— 那会咬伤「程序目录 ≠ 数据目录」这条铁律。

---

## 五、最后

如果这里漏了谁，请告诉我，我补上 —— 遗漏署名是不该发生的。

以及：**这个工具不生成、不续写、不润色你正文里的任何一个字。**
它只负责把你写下的东西整理清楚。那些字是你的。
