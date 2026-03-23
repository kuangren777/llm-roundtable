"""Prometheus metrics for the application."""
from prometheus_client import Counter, Histogram, Gauge

# HTTP metrics
HTTP_REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status_code"],
)
HTTP_REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "endpoint"],
)

# LLM metrics
LLM_CALL_COUNT = Counter(
    "llm_calls_total",
    "Total LLM API calls",
    ["provider", "model", "status"],
)
LLM_CALL_DURATION = Histogram(
    "llm_call_duration_seconds",
    "LLM API call duration in seconds",
    ["provider", "model"],
)

# Discussion metrics
ACTIVE_DISCUSSIONS = Gauge(
    "active_discussions",
    "Number of currently active discussions",
)
SSE_CONNECTIONS = Gauge(
    "sse_connections_active",
    "Number of active SSE connections",
)
