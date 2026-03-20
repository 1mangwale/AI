# Architecture Reference — Data & ML Pipelines

## Pipeline Architecture Patterns

| Pattern | When to use |
|---------|------------|
| Batch ETL | Nightly aggregations, reporting, large transforms |
| Streaming | Real-time events, fraud detection, live dashboards |
| Lambda (batch + stream) | Accuracy + recency both matter |
| Kappa (stream only) | Simplify by treating batch as slow stream |

---

## Recommended Stack

| Layer | Technology |
|-------|-----------|
| Orchestration | Apache Airflow or Prefect |
| Streaming | Apache Kafka + Faust (Python) |
| Batch transform | dbt (SQL) or Spark |
| Feature store | Feast or Tecton |
| ML training | PyTorch + Lightning |
| Experiment tracking | MLflow or Weights & Biases |
| Model serving | FastAPI + Triton (GPU) or BentoML |
| Data warehouse | Snowflake, BigQuery, or DuckDB (smaller scale) |
| Data lake | S3 + Delta Lake or Apache Iceberg |

---

## Folder Structure

```
pipeline-name/
├── dags/                   # Airflow DAGs
│   └── [pipeline_name].py
├── transforms/             # dbt or Spark transforms
│   ├── models/
│   └── tests/
├── src/
│   ├── ingestion/          # Source connectors
│   ├── processing/         # Business logic transforms
│   ├── features/           # Feature engineering
│   ├── training/           # Model training scripts
│   └── serving/            # Inference API
├── config/
│   └── pipelines.yaml      # Pipeline config (overridden by DB)
├── tests/
│   ├── unit/
│   └── integration/        # Test with real (small) datasets
└── Makefile
```

---

## Config-Driven Pipeline Pattern

All pipeline parameters must come from DB or config — never hardcoded:

```python
# config/pipeline_config.py
from dataclasses import dataclass
from src.db import config_db

@dataclass
class PipelineConfig:
    batch_size: int
    lookback_days: int
    feature_columns: list[str]
    model_version: str
    output_table: str

def load_config(pipeline_name: str) -> PipelineConfig:
    """Load pipeline config from database — no hardcoded values."""
    rows = config_db.query(
        "SELECT key, value, value_type FROM pipeline_config WHERE pipeline = %s",
        (pipeline_name,)
    )
    params = {r['key']: cast(r['value'], r['value_type']) for r in rows}
    return PipelineConfig(**params)
```

```sql
CREATE TABLE pipeline_config (
  pipeline    VARCHAR(255) NOT NULL,
  key         VARCHAR(255) NOT NULL,
  value       TEXT NOT NULL,
  value_type  VARCHAR(50) NOT NULL DEFAULT 'string',
  PRIMARY KEY (pipeline, key)
);

INSERT INTO pipeline_config VALUES
  ('user_churn_model', 'batch_size', '1000', 'number'),
  ('user_churn_model', 'lookback_days', '30', 'number'),
  ('user_churn_model', 'model_version', 'v2.3.1', 'string');
```

---

## Data Quality Gates

Every pipeline stage must validate before proceeding:

```python
from great_expectations import DataContext

def validate_data(df, expectation_suite: str) -> bool:
    """Halt pipeline if data quality checks fail."""
    context = DataContext()
    results = context.run_validation_operator(
        "action_list_operator",
        assets_to_validate=[df],
        run_id=expectation_suite
    )
    if not results["success"]:
        raise DataQualityError(f"Validation failed: {results}")
    return True
```

---

## ML Model Registry Pattern

Never deploy a model without tracking:

```python
import mlflow

def train_and_register(config: PipelineConfig):
    with mlflow.start_run():
        # Log all config — nothing undocumented
        mlflow.log_params(asdict(config))

        model = train_model(config)

        mlflow.log_metrics({
            "val_auc": model.val_auc,
            "val_f1": model.val_f1,
        })

        # Register with stage: Staging → (manual approval) → Production
        mlflow.sklearn.log_model(
            model,
            artifact_path="model",
            registered_model_name=config.pipeline_name
        )
```

---

## Idempotent Pipeline Stages

Every stage must be re-runnable without side effects:

```python
def process_batch(batch_date: date):
    """Idempotent: deletes and re-inserts for the given date."""
    with db.transaction():
        db.execute(
            "DELETE FROM processed_events WHERE event_date = %s",
            (batch_date,)
        )
        events = fetch_raw_events(batch_date)
        transformed = transform(events)
        db.bulk_insert("processed_events", transformed)
        db.execute(
            "INSERT INTO pipeline_runs (pipeline, run_date, record_count, status) "
            "VALUES (%s, %s, %s, 'success') ON CONFLICT (pipeline, run_date) "
            "DO UPDATE SET record_count=EXCLUDED.record_count, status='success'",
            (PIPELINE_NAME, batch_date, len(transformed))
        )
```
