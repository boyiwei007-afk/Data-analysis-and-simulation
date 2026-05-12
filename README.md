# SmartAnalysis Pro

智能问数与预测模拟沙盘 — 通用领域数据分析 Web 应用。

支持上传任意 CSV/Excel 表格，自动完成数据探查、自然语言问答、多元线性回归建模，并通过交互式滑块沙盘进行 What-If 模拟预测。

---

## 目录

- [架构概览](#架构概览)
- [项目结构](#项目结构)
- [快速启动](#快速启动)
- [五板块功能说明](#五板块功能说明)
  - [Tab 1：数据接入](#tab-1数据接入)
  - [Tab 2：数据分析](#tab-2数据分析)
  - [Tab 3：智能问数](#tab-3智能问数)
  - [Tab 4：模型训练](#tab-4模型训练)
  - [Tab 5：预测沙盘](#tab-5预测沙盘)
- [API 接口文档](#api-接口文档)
- [技术栈](#技术栈)
- [设计原则](#设计原则)

---

## 架构概览

```
┌──────────────────────┐        ┌─────────────────────────────┐
│   前端 (Vanilla JS)   │  HTTP  │     后端 (FastAPI)           │
│                      │ ◄────► │                             │
│  index.html          │  JSON  │  main.py                    │
│  app.js              │        │  services/                  │
│  style.css           │        │    ├─ data_engine.py        │
│                      │        │    ├─ llm_agent.py          │
│  sessionStorage      │        │    └─ ml_trainer.py         │
│  (LLM 配置 / 模型)    │        │                             │
│                      │        │  uploads/                   │
│  ECharts 渲染         │        │  (CSV/Excel + CSV 缓存)     │
└──────────────────────┘        └─────────────────────────────┘
```

- **前端**：纯静态 HTML/CSS/JS，通过 `python -m http.server` 或任意 HTTP 服务器托管
- **后端**：Python FastAPI，端口 8000，提供 RESTful JSON API
- **状态管理**：前端 sessionStorage 保存 LLM 配置和模型参数，后端无状态
- **LLM 安全**：API Key 仅存浏览器端，每次请求随 Body 透传，后端"阅后即焚"

---

## 项目结构

```
wby/
├── README.md
├── start_windows.bat            # Windows 一键启动脚本
│
├── backend/
│   ├── main.py                  # FastAPI 入口，5 个路由
│   ├── services/
│   │   ├── __init__.py
│   │   ├── data_engine.py       # 通用表格读取 + Schema 提取 + 自动 EDA
│   │   ├── llm_agent.py         # LLM 代理（自然语言问答）
│   │   └── ml_trainer.py        # 线性回归训练管道（4 阶段清洗）
│   └── uploads/                 # 用户上传文件存放处
│
├── frontend/
│   ├── index.html               # 5 个 Tab 面板 + 顶部导航栏
│   ├── app.js                   # 全前端逻辑（~1100 行）
│   └── style.css                # 设计系统（~760 行）
│
└── data/
    └── Online Retail.xlsx       # 示例数据集
```

---

## 快速启动

### 前置条件

- Python 3.9+
- Conda 环境（推荐 `python-project`）
- 依赖包：`fastapi`, `uvicorn`, `pandas`, `numpy`, `scikit-learn`, `openpyxl`, `httpx`

```bash
conda activate python-project
pip install fastapi uvicorn pandas numpy scikit-learn openpyxl httpx
```

### 一键启动（Windows）

双击项目根目录的 `start_windows.bat`，自动打开三个窗口：

| 窗口 | 端口 | 说明 |
|---|---|---|
| SmartAnalysis-Backend | 8000 | FastAPI + Swagger Docs |
| SmartAnalysis-Frontend | 3000 | 静态页面服务 |
| 浏览器 | 3000 | 自动打开前端页面 |

### 手动启动

**终端 1 — 后端：**

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

访问 `http://localhost:8000/docs` 查看 Swagger API 文档。

**终端 2 — 前端：**

```bash
cd frontend
python -m http.server 3000
```

浏览器打开 `http://localhost:3000`。

---

## 五板块功能说明

### Tab 1：数据接入

- **拖拽上传** CSV / Excel 文件（.csv / .xls / .xlsx）
- **自动 Schema 提取**：列名、类型推断（数值/分类/日期/文本/布尔）、缺失率、样本数据
- **编码容错**：UTF-8 → GBK → GB18030 → Latin-1 逐级回退
- 左侧实时展示数据概览面板（行列数 + 字段列表 + 缺失率进度条）
- **条件解锁**：数据解析成功后，若 ≥2 列数值型则自动激活 Tab 4/5

### Tab 2：数据分析

上传后自动跳转，无需手动触发。包含四类自动化分析：

| 分析类型 | 计算方式 | 可视化 |
|---|---|---|
| 数值分布 | `np.histogram(bins=30)` | 柱状图（支持列切换） |
| 相关性矩阵 | `df.corr()`（上限 10 列） | 热力图 |
| 分类分布 | `value_counts().head(5)` | 环形饼图（支持列切换） |
| 时间趋势 | `resample('M'/'D'/'QE')` | 折线图 |

另有 **数值统计摘要表**：计数、均值、标准差、四分位数、偏度、峰度。

**性能保障**：≥ 50k 行时自动采样，Excel 文件首次上传后自动生成 CSV 缓存（38s → 2s）。

### Tab 3：智能问数

- **左侧**：LLM 配置面板（API Key / Base URL / Model Name），保存到 sessionStorage
- **右侧**：类 ChatGPT 对话界面
- LLM 只接收表结构 + 前 3 行样本数据，**不传输完整数据集**
- **纯自然语言回答**，不生成代码、不画图表
- 支持"清空配置"按钮清除已保存的 Key

### Tab 4：模型训练

**工业级 5 阶段清洗管道：**

```
原始数据 → 数值化转换 → Y 缺失删行 → X 缺失中位数填补 → 拟合 + 统计量提取
```

- **目标变量 Y**：单选下拉框（仅数值列）
- **影响因素 X**：多选 chip 组件 + "全选所有"/"清空"批量操作
- **互斥防御**：切换 Y 时自动从 X 中移除同名列
- **训练过程**：4 步伪日志动画（清洗 → 剔除 → 提取 → 拟合）
- **结果展示**：R² 环形仪表盘 + 回归方程 + 系数列表（正负分色）
- **极值绑定**：返回每个特征的 min / max / mean，传给沙盘限制滑块范围

### Tab 5：预测沙盘 (What-If Simulation)

- **左列（38%）**：每个特征一个滑块卡片
  - `<input type="range">` 绑定真实 min/max（来自训练数据）
  - `<input type="number">` 双向同步
  - 默认值 = 特征均值
  - "↺ 恢复默认" 一键重置
- **右列（62%）**：
  - 超大预测数字 + **CountUp 滚动动画**（400ms easeOutCubic）
  - ECharts 仪表盘（4 段配色 + 数值缩写 + 动态最大刻度）

**预测公式：**

```
Y = intercept + Σ(coefficient_i × slider_value_i)
```

---

## API 接口文档

Base URL: `http://localhost:8000`

### `GET /ping`

健康检查。

**响应：**
```json
{"status": "ok", "service": "SmartAnalysis Pro API", "version": "0.1.0"}
```

---

### `POST /upload`

上传 CSV/Excel 文件，返回表结构 Schema。

**请求：** `multipart/form-data`，字段 `file`

**响应：**
```json
{
  "filename": "Online Retail.xlsx",
  "total_rows": 541909,
  "total_columns": 8,
  "columns": [
    {
      "name": "Quantity",
      "dtype": "numeric",
      "missing_count": 0,
      "missing_rate": 0.0,
      "unique_values": 1004,
      "stats": {"min": -80995, "max": 80995, "mean": 9.55, "std": 218.08}
    }
  ],
  "sample_data": [{"InvoiceNo": "536365", "Quantity": 6, ...}, ...]
}
```

---

### `POST /advanced-analysis`

自动化探索性数据分析（EDA）。

**请求：**
```json
{"filename": "Online Retail.xlsx"}
```

**响应：**
```json
{
  "exploratory": [{"column": "Quantity", "mean": 9.55, "skewness": 1.2, ...}],
  "histograms": {"Quantity": {"bins": [...], "counts": [...]}},
  "correlation": {"columns": ["Quantity", "UnitPrice"], "matrix": [[1.0, -0.01], [-0.01, 1.0]]},
  "categorical": [{"column": "Country", "data": [{"name": "UK", "value": 495478}]}],
  "timeseries": {"date_col": "InvoiceDate", "metric_col": "Quantity", "data": [{"date": "2010-12-01", "value": 1234}]}
}
```

---

### `POST /chat`

自然语言问答。

**请求：**
```json
{
  "query": "数据的基本统计特征是什么？",
  "table_schema": {...},
  "api_key": "sk-...",
  "base_url": "https://api.openai.com/v1",
  "model_name": "gpt-4o"
}
```

**响应：**
```json
{
  "answer": "该数据集包含 541,909 条交易记录，共 8 个字段。其中数值型字段有 Quantity（均值 9.55）...",
  "error": null
}
```

---

### `POST /train`

训练多元线性回归模型。

**请求：**
```json
{
  "filename": "Online Retail.xlsx",
  "target_col": "Quantity",
  "feature_cols": ["UnitPrice", "CustomerID"]
}
```

**响应：**
```json
{
  "target": "Quantity",
  "features": ["UnitPrice", "CustomerID"],
  "intercept": 9.57,
  "coefficients": {"UnitPrice": -0.003, "CustomerID": 1e-05},
  "r2_score": 0.000009,
  "feature_stats": {
    "UnitPrice": {"min": -11062, "max": 38970, "mean": 4.61},
    "CustomerID": {"min": 12346, "max": 18287, "mean": 15253}
  },
  "n_samples": 541909,
  "n_dropped": 0,
  "n_imputed": 135080,
  "error": null
}
```

---

## 技术栈

| 层 | 技术 | 用途 |
|---|---|---|
| 后端框架 | FastAPI (Python) | REST API + 自动文档 |
| 数据处理 | Pandas + NumPy | 表格读写、清洗、统计 |
| 机器学习 | scikit-learn | LinearRegression + SimpleImputer |
| LLM 集成 | OpenAI-compatible API | 自然语言问答（可插拔） |
| 前端渲染 | Vanilla HTML/CSS/JS | 零框架依赖 |
| 样式 | Tailwind CSS (CDN) + 自定义 CSS | 浅色极简设计系统 |
| 图表 | ECharts 5.5 | 仪表盘、热力图、柱状图、饼图、折线图 |
| 字体 | Inter (Google Fonts) | 全局排版 |

---

## 设计原则

1. **零硬编码列名**：数据处理管道完全由 Schema 驱动，适配任意 CSV/Excel 表格
2. **前后端严格解耦**：后端只返回 JSON，前端负责全部渲染和状态管理
3. **LLM 可插拔**：API Key / Base URL / Model 均可在前端动态配置，支持任意 OpenAI-compatible 服务
4. **安全第一**：API Key 仅存浏览器 sessionStorage，后端不落盘；Text-to-Pandas 已替换为纯 NL 问答，避免 exec() 安全风险
5. **工业级容错**：编码回退链、静默数值化、中位数填补、JSON 序列化安全 — 脏数据不崩溃
6. **性能优先**：50k+ 行采样、Excel→CSV 缓存、rAF 批量图表更新、CountUp 动画
7. **领域无关**：从"销售沙盘"完全通用化为"预测模拟沙盘"，支持金融/医疗/工业/气象等任意领域
