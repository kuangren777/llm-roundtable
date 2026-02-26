"""Security helpers using only Python stdlib (no external crypto deps)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import get_settings

PBKDF2_ALGO = "sha256"
PBKDF2_ITERATIONS = 390000
PBKDF2_SALT_BYTES = 16
PASSWORD_PREFIX = "pbkdf2_sha256"


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str) -> str:
    salt = os.urandom(PBKDF2_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        PBKDF2_ALGO,
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return (
        f"{PASSWORD_PREFIX}${PBKDF2_ITERATIONS}$"
        f"{_b64url_encode(salt)}${_b64url_encode(digest)}"
    )


def verify_password(password: str, password_hash: str) -> bool:
    try:
        prefix, iter_str, salt_b64, digest_b64 = password_hash.split("$", 3)
        if prefix != PASSWORD_PREFIX:
            return False
        iterations = int(iter_str)
        salt = _b64url_decode(salt_b64)
        expected = _b64url_decode(digest_b64)
    except Exception:
        return False

    actual = hashlib.pbkdf2_hmac(
        PBKDF2_ALGO,
        password.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(actual, expected)


def create_access_token(payload: dict[str, Any]) -> str:
    settings = get_settings()
    if settings.jwt_algorithm.upper() != "HS256":
        raise ValueError("Only HS256 is supported")

    exp = datetime.now(timezone.utc) + timedelta(days=settings.jwt_expire_days)
    body = {**payload, "exp": int(exp.timestamp())}
    header = {"alg": "HS256", "typ": "JWT"}

    header_b64 = _b64url_encode(
        json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    payload_b64 = _b64url_encode(
        json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    sig = hmac.new(
        settings.jwt_secret_key.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    return f"{header_b64}.{payload_b64}.{_b64url_encode(sig)}"


def decode_access_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        header_b64, payload_b64, signature_b64 = token.split(".", 2)
    except ValueError as exc:
        raise ValueError("Invalid token format") from exc

    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    expected_sig = hmac.new(
        settings.jwt_secret_key.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    actual_sig = _b64url_decode(signature_b64)
    if not hmac.compare_digest(actual_sig, expected_sig):
        raise ValueError("Invalid token signature")

    header = json.loads(_b64url_decode(header_b64).decode("utf-8"))
    alg = header.get("alg")
    if (alg if isinstance(alg, str) else str(alg or "")).upper() != "HS256":
        raise ValueError("Unsupported token algorithm")

    payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    exp = payload.get("exp")
    try:
        exp_int = int(exp)
    except Exception as exc:
        raise ValueError("Invalid token exp") from exc
    if exp_int <= int(time.time()):
        raise ValueError("Token expired")
    return payload
