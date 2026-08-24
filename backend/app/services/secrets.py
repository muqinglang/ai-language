"""Encrypt user-supplied API keys at rest.

A third-party API key is a spendable credential: whoever holds it can bill
its owner. So it never sits in the database as plaintext, and it never
travels back to the browser — the API only ever returns a mask
("sk-…4f2a") built from the decrypted value at read time.

Keying: CREDENTIAL_ENC_KEY from the environment. Any string works — a
real 32-byte urlsafe-base64 Fernet key is used directly, anything else is
stretched with SHA-256 so an operator can paste a passphrase without
having to know what Fernet wants. Rotating the value makes every stored
key undecryptable, which surfaces as "配置已失效，请重新填写" rather than
a crash.

When CREDENTIAL_ENC_KEY is unset the whole feature is off: encrypt()
raises and the router turns that into a 503. Storing keys in the clear
because the operator forgot to set a variable is worse than not offering
the feature.
"""

from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

log = logging.getLogger("justspeak.secrets")

_fernet: Fernet | None = None
_fernet_for: str | None = None


class SecretsUnavailable(Exception):
    """No CREDENTIAL_ENC_KEY configured — the feature must stay off."""


def _valid_fernet_key(raw: str) -> bytes | None:
    """The raw value if it's already a well-formed Fernet key, else None."""
    try:
        decoded = base64.urlsafe_b64decode(raw.encode())
    except Exception:
        return None
    return raw.encode() if len(decoded) == 32 else None


def _cipher() -> Fernet:
    global _fernet, _fernet_for
    raw = (settings.credential_enc_key or "").strip()
    if not raw:
        raise SecretsUnavailable(
            "CREDENTIAL_ENC_KEY is not set — refusing to store API keys unencrypted"
        )
    # Rebuild when the env value changes (only really happens in tests).
    if _fernet is not None and _fernet_for == raw:
        return _fernet
    key = _valid_fernet_key(raw)
    if key is None:
        # Stretch an arbitrary passphrase into the 32 bytes Fernet needs.
        key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest())
    _fernet = Fernet(key)
    _fernet_for = raw
    return _fernet


def secrets_enabled() -> bool:
    return bool((settings.credential_enc_key or "").strip())


def encrypt(plaintext: str) -> str:
    return _cipher().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str | None:
    """Plaintext, or None when the ciphertext can't be read.

    Returns None (rather than raising) for the realistic failure — the
    encryption key was rotated — so callers can treat it as "this stored
    credential is gone" and ask the user to re-enter it.
    """
    if not token:
        return None
    try:
        return _cipher().decrypt(token.encode()).decode()
    except (InvalidToken, SecretsUnavailable):
        return None
    except Exception as e:  # pragma: no cover - defensive
        log.warning("credential decrypt failed: %s", e)
        return None


def mask(plaintext: str) -> str:
    """'sk-proj-abc…4f2a' — enough to recognise which key it is, useless to steal.

    Short strings collapse to bare dots: showing 4 of 6 characters would
    give away most of the secret.
    """
    if not plaintext:
        return ""
    if len(plaintext) <= 12:
        return "•" * len(plaintext)
    return f"{plaintext[:6]}…{plaintext[-4:]}"
