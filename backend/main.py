"""
SmartAnalysis Pro — Backend Entry Point

A FastAPI application that provides:
- File upload & data ingestion (CSV / Excel)
- Data cleaning & summarization services
- LLM proxy (Text-to-Pandas) with pluggable configuration
- Online ML training (scikit-learn) with weight extraction
"""

import logging
import shutil
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services.data_engine import process_dataframe, get_advanced_analysis
from services.llm_agent import ask_data
from services.ml_trainer import train_linear_regression

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="SmartAnalysis Pro API",
    description="智能问数与销售模拟沙盘 — 后端服务",
    version="0.1.0",
)

# Directory for uploaded files (relative to the backend package)
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Utility: fast DataFrame loading (CSV cache)
# ---------------------------------------------------------------------------

def _ensure_csv_cache(file_path: Path) -> Path:
    """If *file_path* is an Excel file, create a CSV sibling for fast reads."""
    if file_path.suffix.lower() in (".xls", ".xlsx"):
        csv_path = file_path.with_suffix(".csv")
        if not csv_path.exists():
            try:
                df = pd.read_excel(file_path)
                df.to_csv(csv_path, index=False)
                logger.info("Cached CSV: %s", csv_path.name)
            except Exception:
                logger.warning("Failed to cache CSV for %s", file_path.name)
        return csv_path
    return file_path


def _load_dataframe(filename: str) -> pd.DataFrame:
    """Load a previously-uploaded file, preferring the CSV cache."""
    path = UPLOAD_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"文件 '{filename}' 不存在")
    # Prefer CSV if available
    csv_path = path.with_suffix(".csv")
    if csv_path.exists():
        return pd.read_csv(csv_path)
    if path.suffix.lower() in (".xls", ".xlsx"):
        return pd.read_excel(path)
    return pd.read_csv(path)

# ---------------------------------------------------------------------------
# CORS — allow all origins during development
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health-check / ping
# ---------------------------------------------------------------------------
@app.get("/ping", tags=["system"])
async def ping():
    """Lightweight health-check endpoint."""
    return {"status": "ok", "service": "SmartAnalysis Pro API", "version": "0.1.0"}


# ---------------------------------------------------------------------------
# File upload & schema extraction
# ---------------------------------------------------------------------------
@app.post("/upload", tags=["data"])
async def upload_file(file: UploadFile = File(...)):
    """Accept a CSV or Excel file, persist it, and return a structural schema.

    The response includes total row/column counts, per-column metadata
    (inferred type, missing rate, basic stats), and the first 3 rows
    as sample data — all without any hard-coded column assumptions.
    """
    # --- validate extension ------------------------------------------------
    filename = file.filename or "unknown"
    suffix = Path(filename).suffix.lower()
    if suffix not in (".csv", ".xls", ".xlsx"):
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件格式 '{suffix}'。请上传 CSV 或 Excel 文件。",
        )

    # --- persist to disk ---------------------------------------------------
    save_path = UPLOAD_DIR / filename
    try:
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        logger.info("File saved: %s (%.1f KB)", filename, save_path.stat().st_size / 1024)
    except Exception as exc:
        logger.exception("Failed to save uploaded file")
        raise HTTPException(status_code=500, detail=f"文件保存失败: {exc}")

    # --- cache a CSV copy for fast subsequent reads ------------------------
    _ensure_csv_cache(save_path)

    # --- process & return schema -------------------------------------------
    try:
        schema = process_dataframe(str(save_path))
        logger.info(
            "Schema extracted: %d rows x %d cols (%s)",
            schema["total_rows"],
            schema["total_columns"],
            filename,
        )
        return schema
    except ValueError as exc:
        # Known business-logic errors (bad encoding, empty file, …)
        logger.warning("Data engine rejected file: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Unexpected error during schema extraction")
        raise HTTPException(status_code=500, detail=f"数据处理异常: {exc}")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    """Payload sent by the frontend for each conversational turn."""

    query: str = Field(..., description="用户自然语言提问", min_length=1)
    table_schema: dict = Field(..., description="前端缓存的表结构（含列信息和样本数据）")
    api_key: str = Field(..., description="LLM API Key（阅后即焚）")
    base_url: str = Field(..., description="LLM Base URL")
    model_name: str = Field(..., description="LLM Model Name")


class ChatResponse(BaseModel):
    """Plain-text answer returned to the frontend."""

    answer: str = ""
    error: str | None = None


# ---------------------------------------------------------------------------
# Chat / LLM proxy endpoint
# ---------------------------------------------------------------------------
@app.post("/chat", tags=["chat"], response_model=ChatResponse)
async def chat_query(req: ChatRequest):
    """Natural-language Q&A about the uploaded table.

    The LLM receives only the table schema (column names, types, stats,
    and a few sample rows) — **not** the full dataset.  It answers in
    plain natural language without generating code or charts.
    """
    credentials = {
        "api_key": req.api_key,
        "base_url": req.base_url,
        "model_name": req.model_name,
    }

    try:
        result = ask_data(
            query=req.query,
            schema=req.table_schema,
            api_credentials=credentials,
        )
        return ChatResponse(answer=result["answer"])
    except ValueError as exc:
        logger.warning("LLM agent error: %s", exc)
        return ChatResponse(answer="", error=str(exc))
    except Exception as exc:
        logger.exception("Unexpected /chat error")
        raise HTTPException(status_code=500, detail=f"对话服务异常: {exc}")


# ---------------------------------------------------------------------------
# Pydantic schemas — training
# ---------------------------------------------------------------------------

class TrainRequest(BaseModel):
    """Payload for the model-training endpoint."""

    filename: str = Field(..., description="当前已上传的文件名")
    target_col: str = Field(..., description="目标变量 Y 的列名", min_length=1)
    feature_cols: list[str] = Field(..., description="特征变量 X 的列名列表", min_length=1)


class TrainResponse(BaseModel):
    """Training result returned to the frontend."""

    target: str
    features: list[str]
    intercept: float
    coefficients: dict[str, float]
    r2_score: float
    feature_stats: dict[str, dict[str, float]] = {}
    n_samples: int
    n_dropped: int
    n_imputed: int = 0
    error: str | None = None


# ---------------------------------------------------------------------------
# Model training endpoint
# ---------------------------------------------------------------------------
@app.post("/train", tags=["train"], response_model=TrainResponse)
async def train_model(req: TrainRequest):
    """Train a linear regression model on user-selected columns.

    The backend loads the previously-uploaded DataFrame, extracts the
    specified target & feature columns, trains a ``LinearRegression``,
    and returns the fitted weights + R² score.

    All columns are referenced by name — no hard-coded business logic.
    """
    file_path = UPLOAD_DIR / req.filename
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"文件 '{req.filename}' 不存在，请先上传数据。",
        )

    try:
        df = _load_dataframe(req.filename)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"无法读取数据文件: {exc}")

    try:
        result = train_linear_regression(
            df=df,
            target_col=req.target_col,
            feature_cols=req.feature_cols,
        )
        return TrainResponse(
            target=result["target"],
            features=result["features"],
            intercept=result["intercept"],
            coefficients=result["coefficients"],
            r2_score=result["r2_score"],
            feature_stats=result["feature_stats"],
            n_samples=result["n_samples"],
            n_dropped=result["n_dropped"],
            n_imputed=result["n_imputed"],
        )
    except ValueError as exc:
        logger.warning("Training validation error: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Unexpected /train error")
        raise HTTPException(status_code=500, detail=f"模型训练异常: {exc}")


# ---------------------------------------------------------------------------
# Pydantic schemas — advanced analysis
# ---------------------------------------------------------------------------

class AdvancedAnalysisRequest(BaseModel):
    """Payload for the automated EDA endpoint."""

    filename: str = Field(..., description="当前已上传的文件名")


# ---------------------------------------------------------------------------
# Advanced analysis endpoint
# ---------------------------------------------------------------------------
@app.post("/advanced-analysis", tags=["analysis"])
async def advanced_analysis(req: AdvancedAnalysisRequest):
    """Run automated exploratory data analysis on the uploaded file.

    Returns chart-ready data for histograms, correlation heatmap,
    categorical pie charts, and time-series line charts.
    All heavy computations are sampled to ensure responsiveness
    even on 500k+ row datasets.
    """
    file_path = UPLOAD_DIR / req.filename
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"文件 '{req.filename}' 不存在，请先上传数据。",
        )

    try:
        result = get_advanced_analysis(str(file_path))
        return result
    except ValueError as exc:
        logger.warning("Advanced analysis error: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Unexpected /advanced-analysis error")
        raise HTTPException(status_code=500, detail=f"数据分析异常: {exc}")
