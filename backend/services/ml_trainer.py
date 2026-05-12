"""
ML Trainer — Industrial-Grade Linear Regression Pipeline

Provides ``train_linear_regression()`` with a 4-stage data-cleaning pipeline:

1. **Input unwrap & validation** — unwrap single-element arrays, verify
   column existence.
2. **Forced numeric conversion** — ``pd.to_numeric(errors="coerce")`` on
   every selected column; non-numeric values silently become NaN.
3. **Smart imputation** — rows with NaN in Y are dropped; NaN cells in X
   are filled via ``SimpleImputer(strategy="median")``.
4. **Type coercion** — all NumPy scalars cast to native Python ``float`` /
   ``int`` before JSON serialisation.

Zero hard-coded column names — fully data-driven.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def train_linear_regression(
    df: pd.DataFrame,
    target_col: str | list[str],
    feature_cols: list[str],
) -> dict[str, Any]:
    """Train a linear regression model with automatic data cleaning.

    Args:
        df:           The full DataFrame (already loaded by the data engine).
        target_col:   Column name (or single-element list) for Y.
        feature_cols: Column names for X.

    Returns:
        ``{target, features, intercept, coefficients, r2_score,
           n_samples, n_dropped, n_imputed}`` — all values are native
        Python types, ready for JSON serialisation.

    Raises:
        ValueError: If a column is missing, the cleaned dataset is empty,
                    or the feature set is invalid.
    """
    # =====================================================================
    # Stage 0 — defensive input unwrap
    # =====================================================================
    if isinstance(target_col, (list, tuple)):
        if len(target_col) == 0:
            raise ValueError("目标变量 (Y) 为空，请选择一个数值型列。")
        target_col = str(target_col[0])
        logger.info("Unwrapped target_col from list → '%s'", target_col)

    target_col = str(target_col).strip()
    if not target_col:
        raise ValueError("目标变量 (Y) 不能为空，请选择一个数值型列。")

    feature_cols = [str(c).strip() for c in feature_cols if str(c).strip()]
    if not feature_cols:
        raise ValueError("影响因素 (X) 不能为空，请至少选择一个特征列。")

    # =====================================================================
    # Stage 1 — column existence check
    # =====================================================================
    all_cols = set(df.columns)
    missing: list[str] = []
    if target_col not in all_cols:
        missing.append(target_col)
    for c in feature_cols:
        if c not in all_cols:
            missing.append(c)
    if missing:
        raise ValueError(
            f"以下列在数据中不存在: {missing}。"
            f"当前数据列: {sorted(all_cols)}"
        )

    # =====================================================================
    # Stage 2 — forced numeric conversion (silent coercion)
    # =====================================================================
    cols_to_use = [target_col] + feature_cols
    sub = df[cols_to_use].copy()
    total_before = len(sub)

    for col in cols_to_use:
        sub[col] = pd.to_numeric(sub[col], errors="coerce")

    # =====================================================================
    # Stage 3a — drop rows where Y is NaN (useless for training)
    # =====================================================================
    before_y_drop = len(sub)
    sub = sub.dropna(subset=[target_col])
    n_dropped_y = before_y_drop - len(sub)

    if len(sub) == 0:
        raise ValueError(
            f"目标变量 '{target_col}' 在数值化后全部为空，无法训练模型。"
            f"原始 {total_before} 行数据均无法使用，请检查该列是否包含有效数值。"
        )

    # =====================================================================
    # Stage 3b — impute X NaN cells with median (preserve sample size)
    # =====================================================================
    X_raw = sub[feature_cols].values
    y_raw = sub[target_col].values

    nan_mask = np.isnan(X_raw)
    n_nan_cells = int(np.sum(nan_mask))

    imputer = SimpleImputer(strategy="median")
    X_clean = imputer.fit_transform(X_raw)

    n_samples = len(sub)

    if n_samples < len(feature_cols) * 2:
        logger.warning(
            "Sample size (%d) small vs feature count (%d). R² may be unreliable.",
            n_samples, len(feature_cols),
        )

    # =====================================================================
    # Stage 4 — train model
    # =====================================================================
    model = LinearRegression()
    model.fit(X_clean, y_raw)

    r2 = float(model.score(X_clean, y_raw))
    intercept = float(model.intercept_)
    coefficients: dict[str, float] = {}
    for i, col in enumerate(feature_cols):
        coefficients[col] = float(model.coef_[i])

    # =====================================================================
    # Stage 5 — feature statistics (for sandbox slider bounds)
    # =====================================================================
    feature_stats: dict[str, dict[str, float]] = {}
    for i, col in enumerate(feature_cols):
        col_vals = X_clean[:, i]
        feature_stats[col] = {
            "min": float(np.min(col_vals)),
            "max": float(np.max(col_vals)),
            "mean": float(np.mean(col_vals)),
        }

    logger.info(
        "Model trained: target=%s, features=%s, R²=%.4f, n=%d, dropped_y=%d, imputed=%d",
        target_col, feature_cols, r2, n_samples, n_dropped_y, n_nan_cells,
    )

    return {
        "target": target_col,
        "features": feature_cols,
        "intercept": round(intercept, 6),
        "coefficients": {k: round(v, 6) for k, v in coefficients.items()},
        "r2_score": round(r2, 6),
        "feature_stats": {k: {kk: round(vv, 6) for kk, vv in v.items()} for k, v in feature_stats.items()},
        "n_samples": int(n_samples),
        "n_dropped": int(n_dropped_y),
        "n_imputed": int(n_nan_cells),
    }
