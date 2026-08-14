# 客户资料解析指引（ACS 客户洞察 skill）

给定客户资料（文件夹或单个文件，任意常见格式），先把全部内容提取为纯文本再分析。本 skill 自带提取脚本：`scripts/extract_materials.py`。

## 运行提取

```bash
# Python 定位：优先 PATH 中的 python；本机典型回退路径：
PY=python; command -v python >/dev/null 2>&1 || PY="$LOCALAPPDATA/Programs/Python/Python312/python.exe"

"$PY" "<skill目录>/scripts/extract_materials.py" "<客户资料路径>" "<工作区>/customer-extracted"
```

- 输出目录每个源文件对应一个 `.txt`，外加 `manifest.json`（来源、状态、字符数）。
- 支持格式：`.pdf .pptx .docx .xlsx .xls .txt .md .csv .json .log .html .xml`。

## 依赖缺失时安装

脚本依赖 `pdfplumber python-pptx python-docx openpyxl xlrd`。检测到 `ModuleNotFoundError` 时安装（本机访问官方 PyPI 会超时，用阿里云镜像）：

```bash
"$PY" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ pdfplumber python-pptx python-docx openpyxl xlrd
```

本机未装 Python 时：`winget install --id Python.Python.3.12 --scope user`。

## 解析 manifest 的规则

`manifest.json` 中每项 status 的含义与后续动作：

| status | 含义 | 分析时的处理 |
|---|---|---|
| `ok` 且 chars>0 | 已提取到文本 | 正常阅读分析 |
| `empty` | 文件存在但无文本（常见为扫描件 PDF、纯图 PPT） | 记入缺失资料表单：该文件内容不可读，需人工查阅或索取可编辑版本 |
| `failed` | 格式损坏或加密 | 同上，注明原因 |
| `skipped` | 不支持的扩展名 | 若疑似重要资料（如 .msg 邮件、图片），记入缺失表单 |

**重要**：`empty/failed/skipped` 的文件名本身也是信息——文件名能说明客户方有什么资料主题（如"2026年预算表.xlsx"提取失败，说明存在预算表但内容未知），在缺失表单中应写"已有文件但无法读取，需人工提供内容"。

## 无 Python 环境的降级方案

仅当无法安装 Python 时使用（效果打折）：

1. PPTX/XLSX/DOCX 本质是 zip：`unzip -p <file> "ppt/slides/*.xml"` 后用 `sed 's/<[^>]*>/ /g'` 剥标签可读出部分文字（表格结构丢失）。
2. PDF 若为未压缩文本流可用 `strings` 碰运气；压缩流读不出，直接列入缺失表单。
3. 明确告知用户哪些资料未能解析。

## 分析前的阅读顺序

1. 先读 `manifest.json`，对资料全貌建立清单（有多少文件、哪些可读、覆盖哪些主题）。
2. 按可读文件名判断资料覆盖了 ACS 哪些域（01 战略洞察 / 02 联合创新 / 04 客户关系）。
3. 逐文件阅读提取文本；表格竖线分隔的行要还原为字段结构理解。
4. 汇总"已知信息"与"框架应有信息"（见 references/acs-01/02/04）的差集 → 缺失资料表单。
