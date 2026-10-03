# 第三方许可证与合规记录

> 这份文件回答两个问题：**这套程序里有哪些别人的代码**，以及**它们的协议允许我这样分发吗**。
>
> 铁律（项目立项时就定的，不得违反）：**全链路禁用 GPL / AGPL / SSPL 等传染性或禁止商用协议**。
> 每次打包前由构建脚本自动重跑扫描，一旦命中直接中止 —— 依赖会升级、协议会变，
> 今天扫过不等于下个版本还干净。

- 扫描日期：2026-10-03
- 后端依赖：**43 个**（`scripts/scan_py_licenses.py`）
- 前端生产依赖：**43 个**（`scripts/scan_web_licenses.mjs`）
- **结论：未发现任何 GPL / AGPL / SSPL / EUPL 等传染性或禁商用协议。**

---

## 一、概念先说清：为什么「能商用」不等于「随便用」

三种协议混在一起说会糊涂，分开看就清楚了：

| 类型 | 例子 | 能不能用在闭源商业软件里 |
|---|---|---|
| **宽松型** | MIT / ISC / BSD / Apache-2.0 | ✅ 可以。**唯一义务是保留版权声明** —— 所以才有这份文件和随包的 `THIRD-PARTY-NOTICES.txt` |
| **弱著佐权** | MPL-2.0 / LGPL | ✅ 可以。条件是「你改了它的源文件，那个文件得开源」。我们不改它 → 无额外义务 |
| **强著佐权 / 禁商用** | GPL / AGPL / SSPL | ❌ **不行**。会传染整个程序。本项目一律不用 |

**Apache-2.0 还多一条**：它包含专利授权条款，同时也要求你保留 `NOTICE` 文件（如果有）。这比 MIT 更「安全」，不是更危险。

---

## 二、后端（Python）依赖清单

来源：`requirements.txt`（运行必需）与 `requirements-vision.txt`（可选识别引擎）。
开发依赖（pytest 等）不进分发包，不计。

| 包 | 版本 | 协议 | 归类 |
|---|---|---|---|
| `annotated-doc` | 0.0.5 | MIT | 传递依赖 |
| `annotated-types` | 0.8.0 | MIT | 传递依赖 |
| `antlr4-python3-runtime` | 4.9.3 | BSD | 可选·识别引擎 |
| `anyio` | 4.15.1 | MIT | 传递依赖 |
| `certifi` | 2026.7.22 | Mozilla Public License 2.0 (MPL 2.0) | 传递依赖 |
| `charset-normalizer` | 3.5.2 | MIT | 传递依赖 |
| `click` | 8.5.0 | BSD-3-Clause | 传递依赖 |
| `colorama` | 0.4.6 | BSD License | 传递依赖 |
| `colorlog` | 6.12.0 | MIT License | 可选·识别引擎 |
| `fastapi` | 0.142.1 | MIT | 运行必需 |
| `flatbuffers` | 25.12.19 | Apache Software License | 可选·识别引擎 |
| `h11` | 0.16.0 | MIT License | 传递依赖 |
| `httpcore` | 1.0.9 | BSD-3-Clause | 传递依赖 |
| `httptools` | 0.8.0 | MIT | 传递依赖 |
| `httpx` | 0.28.1 | BSD License | 运行必需 |
| `idna` | 3.20 | BSD-3-Clause | 传递依赖 |
| `numpy` | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | 可选·识别引擎 |
| `omegaconf` | 2.3.1 | BSD License | 可选·识别引擎 |
| `onnxruntime` | 1.30.0 | MIT License | 可选·识别引擎 |
| `opencv-python` | 5.0.0.93 | Apache Software License | 可选·识别引擎 |
| `opencv-python-headless` | 5.0.0.93 | Apache Software License | 可选·识别引擎 |
| `opentelemetry-api` | 1.45.0 | Apache-2.0 | 可选·识别引擎 |
| `pillow` | 12.3.0 | MIT-CMU | 可选·识别引擎 |
| `protobuf` | 7.36.2 | 3-Clause BSD License | 可选·识别引擎 |
| `pyclipper` | 1.4.0 | OSI Approved | 可选·识别引擎 |
| `pydantic` | 2.13.5 | MIT | 传递依赖 |
| `pydantic_core` | 2.46.5 | MIT | 传递依赖 |
| `python-dotenv` | 1.2.3 | BSD-3-Clause | 传递依赖 |
| `python-frontmatter` | 1.3.0 | MIT | 运行必需 |
| `python-multipart` | 0.0.32 | Apache-2.0 | 运行必需 |
| `PyYAML` | 6.0.3 | MIT License | 运行必需 |
| `rapidocr` | 3.9.2 | Apache-2.0 | 可选·识别引擎 |
| `requests` | 2.34.2 | Apache Software License | 可选·识别引擎 |
| `shapely` | 2.1.2 | BSD License | 可选·识别引擎 |
| `six` | 1.17.0 | MIT License | 可选·识别引擎 |
| `starlette` | 1.7.0 | BSD-3-Clause | 传递依赖 |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT | 可选·识别引擎 |
| `typing-inspection` | 0.4.4 | MIT | 传递依赖 |
| `typing_extensions` | 4.16.0 | PSF-2.0 | 传递依赖 |
| `urllib3` | 2.8.0 | MIT | 传递依赖 |
| `uvicorn` | 0.54.0 | BSD-3-Clause | 运行必需 |
| `watchfiles` | 1.3.0 | MIT License | 传递依赖 |
| `websockets` | 17.1 | BSD-3-Clause | 传递依赖 |

### 两条需要挂备注的

| 包 | 协议 | 说明 |
|---|---|---|
| `certifi` | **MPL-2.0** | 弱著佐权（OSI 认证）。它只提供一份 CA 根证书清单，我们不修改它 → 除保留声明外**无任何额外义务**。 |
| `tqdm` | **MPL-2.0 AND MIT** | **双许可**，选 MIT 那一支即可。而且它属于可选的识别引擎链，核心包不含。 |
| `pillow` | MIT-CMU | 是 MIT 的一个变体（HPND 系），宽松可商用。 |
| `typing_extensions` | PSF-2.0 | Python 软件基金会的协议，宽松可商用。 |

### 可选依赖的取舍

`requirements-vision.txt` 里的识别引擎（OpenCV + RapidOCR + ONNX Runtime + Shapely）**不装也能跑** ——
界面会显示「本地识别不可用」并给出安装命令，其他功能一律不受影响。这跟「AI 可降级」是同一条原则。

**分发包里默认不含它们**（体积会从约 50MB 涨到 500MB+）。需要识别功能的用户按提示自行安装。

---

## 三、前端生产依赖清单

来源：`web/package-lock.json` 里非 dev 的条目。开发依赖（vite / typescript / @types/*）不进构建产物，不计。

> 为什么不读 `npm ls --all`：本次实测它报出了一个**幻影条目** `preact-render-to-string` ——
> 那个包既没装在 `node_modules` 里、也不在 lock 里（是 npm 解析依赖图时的残留）。
> 以它为准会把一个根本不会分发的包写进声明页。lock 文件才是「真正会装上的那份」。

| 包 | 版本 | 协议 |
|---|---|---|
| `@babel/runtime` | 7.29.7 | MIT |
| `@tweenjs/tween.js` | 25.0.0 | MIT |
| `3d-force-graph` | 1.80.1 | MIT |
| `accessor-fn` | 1.5.3 | MIT |
| `d3-array` | 3.2.4 | ISC |
| `d3-binarytree` | 1.0.2 | MIT |
| `d3-color` | 3.1.0 | ISC |
| `d3-dispatch` | 3.0.1 | ISC |
| `d3-force` | 3.0.0 | ISC |
| `d3-force-3d` | 3.0.6 | MIT |
| `d3-format` | 3.1.2 | ISC |
| `d3-interpolate` | 3.0.1 | ISC |
| `d3-octree` | 1.1.0 | MIT |
| `d3-quadtree` | 3.0.1 | ISC |
| `d3-scale` | 4.0.2 | ISC |
| `d3-scale-chromatic` | 3.1.0 | ISC |
| `d3-selection` | 3.0.0 | ISC |
| `d3-time` | 3.1.0 | ISC |
| `d3-time-format` | 4.1.0 | ISC |
| `d3-timer` | 3.0.1 | ISC |
| `data-bind-mapper` | 1.0.3 | MIT |
| `dockview` | 4.13.1 | MIT |
| `dockview-core` | 4.13.1 | MIT |
| `float-tooltip` | 1.7.5 | MIT |
| `internmap` | 2.0.3 | ISC |
| `js-tokens` | 4.0.0 | MIT |
| `kapsule` | 1.16.3 | MIT |
| `lodash-es` | 4.18.1 | MIT |
| `loose-envify` | 1.4.0 | MIT |
| `ngraph.events` | 1.4.0 | BSD-3-Clause |
| `ngraph.forcelayout` | 3.3.1 | BSD-3-Clause |
| `ngraph.graph` | 20.1.2 | BSD-3-Clause |
| `ngraph.merge` | 1.0.0 | MIT |
| `ngraph.random` | 1.2.0 | BSD-3-Clause |
| `polished` | 4.3.1 | MIT |
| `preact` | 10.29.8 | MIT |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `scheduler` | 0.23.2 | MIT |
| `three` | 0.186.1 | MIT |
| `three-forcegraph` | 1.43.6 | MIT |
| `three-render-objects` | 1.43.0 | MIT |
| `tinycolor2` | 1.6.0 | MIT |

**全部为 MIT / ISC / BSD-3-Clause，零传染性协议。**

---

## 四、随分发包附什么

| 文件 | 位置 | 作用 |
|---|---|---|
| `LICENSE.txt` | 安装目录根下 | **本程序自己的协议**（专有，见第六节）。单独放一份，绿色包用户不装程序也能一眼看到 |
| `THIRD-PARTY-NOTICES.txt` | 安装目录 | 上面这些包的**完整许可证全文**（MIT / BSD / Apache-2.0 都要求保留声明） |
| `许可与致谢.txt` | 安装目录 + 开始菜单 | 三份合一：`LICENSE` + `docs/credits.md` + 本文。给不想翻多个文件的人 |
| `docs/licenses.md`（本文） | 源码仓库 | 合规**审计记录**，说明「为什么这么判」 |
| `docs/credits.md` | 源码仓库 | 人话版致谢 |

> **2026-10-03 更正**：本节原先写「`credits.md` → 程序「关于」页」，**那是错的** ——
> 程序里**故意没有**「关于」页（界面是干活的地方，不是读法律文书的地方）。
> 结果是这几份文件一直没有用户可见的入口，只是躺在安装目录里，等于没附。
> 现在补了一条开始菜单快捷方式「许可与致谢」指向 `许可与致谢.txt`。

`THIRD-PARTY-NOTICES.txt` 由构建脚本**自动生成** —— 它遍历实际装进包里的每个依赖，
把各自的 `LICENSE` / `COPYING` 文件原文收拢到一起。手写一定会漏、会过期。

---

## 五、怎么重跑这次审计

```bash
# 后端（在项目根目录）
.venv/Scripts/python.exe scripts/scan_py_licenses.py          # 打印清单
.venv/Scripts/python.exe scripts/scan_py_licenses.py --md     # 输出 Markdown 表格

# 前端
node scripts/scan_web_licenses.mjs                            # 打印清单
node scripts/scan_web_licenses.mjs --json                     # 输出 JSON
```

两个脚本都在**发现传染性协议时以非零码退出** —— 所以它们可以直接串进构建流水线：
红了就停下，别打包。这就是「协议必须可商用」这条铁律的执行方式。

---

## 六、本项目自身的许可

- **协议**：**专有软件，保留所有权利**（proprietary / All rights reserved）
- **版权行**：`Copyright © 2026 世界观查询器`
- **全文位置**：仓库根目录 [`LICENSE`](../LICENSE)；出包后另存一份 `LICENSE.txt` 到安装目录根下
- **拍板日期**：2026-10-03

### 为什么选它

**因为可逆。** 版权全在作者手里，两种方向的风险不对等：

| 现在选 | 以后想改 | 代价 |
|---|---|---|
| 专有 | 改开源 | ✅ 随时能改，换成协议全文即可 |
| 开源（MIT 等） | 改回专有 | ❌ 已发出的版本收不回来，任何人都可继续使用、修改、转售 |

所以拿不准时的正确顺序是**先紧后松**。反过来做没有退路。
本条与打赏不冲突（打赏不是收费授权），也保住了以后上架或收费的可能。

### 它授予了什么

- ✅ 免费安装、运行、用于创作（商业题材或非商业题材都行）
- ✅ 原样转发（不收费、不修改、协议随附完整）
- ❌ 修改 / 演绎 / 再发行 / 销售 / 去除署名与打赏渠道 —— 需事先书面许可

### 两条容易误会的，写清楚

1. **第三方组件的许可不因此改变**。无论本项目用什么协议分发，那些 MIT / BSD /
   Apache-2.0 / MPL-2.0 的版权声明都必须保留 —— 这是对第三方作者的义务，
   与本节选什么无关。所以第四节照旧。
2. **用户的数据仍然是用户的**。协议第五节专门承诺：录入的正文、实体档案、地图、
   时间线与数据目录里的全部文件，版权与所有权**完全归用户**。这条不能省 ——
   一个装着小说的工具，协议若含糊其辞地主张「所有内容」，用户有理由不敢用。

### 以后真要改，动哪几处

1. 仓库根 `LICENSE` 换成新协议全文
2. 本节（第六节）改写
3. `web/package.json` 的 `"license"` 字段（现在是 `UNLICENSED`）
4. `packaging/wkv.iss` 的 `MyAppPublisher` 与 `VersionInfoCompany`
5. 重跑 `packaging/build.py` —— `copy_docs()` 会**检查 `LICENSE` 是否存在，
   缺了直接拒绝出包**，免得发出一份不带自己协议的安装包
