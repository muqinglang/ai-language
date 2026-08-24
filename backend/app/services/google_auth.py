"""Verify Google Identity Services ID tokens.

The frontend runs Google's button, gets back a signed JWT ("credential"),
and posts it to /api/auth/google.  This module checks that JWT is really
from Google and really for us, then hands back the claims we care about.

We verify the signature locally against Google's published JWKS rather
than calling the tokeninfo endpoint, so a single cert fetch (cached for
an hour) covers every sign-in instead of one round trip per login.

Networking caveat: the cert fetch still has to reach Google.  From the
mainland ECS that is blocked, so Google sign-in only works where the
server can reach googleapis.com.  Failures raise GoogleAuthError with a
message the router turns into a 503 — never a silent pass.
"""

from __future__ import annotations

import time

import httpx
from jose import jwt
from jose.exceptions import JWTError

_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
# Google mints tokens with either form of the issuer claim.
_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
_CACHE_TTL_SEC = 3600

_certs_cache: dict | None = None
_certs_fetched_at: float = 0.0


class GoogleAuthError(Exception):
    """Raised when an ID token can't be verified, for any reason."""


async def _jwks(force: bool = False) -> dict:
    """Google's signing keys, cached for an hour.

    `force` re-fetches even on a warm cache — used once when a token's
    kid is missing, since Google rotates keys and our copy may predate
    the rotation.
    """
    global _certs_cache, _certs_fetched_at
    fresh = _certs_cache is not None and (time.time() - _certs_fetched_at) < _CACHE_TTL_SEC
    if fresh and not force:
        return _certs_cache
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(_CERTS_URL)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        # Keep serving a stale cache if we have one — a transient network
        # blip shouldn't lock out sign-in when the keys are still valid.
        if _certs_cache is not None:
            return _certs_cache
        raise GoogleAuthError(f"cannot reach Google to verify sign-in ({e})") from e
    _certs_cache = data
    _certs_fetched_at = time.time()
    return data


def _find_key(jwks: dict, kid: str) -> dict | None:
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return key
    return None


async def verify_id_token(credential: str, client_id: str) -> dict:
    """Return {sub, email, email_verified, name, picture} or raise.

    `client_id` is the OAuth client the token must be addressed to — a
    token minted for someone else's app is rejected even though its
    signature is perfectly valid.
    """
    if not client_id:
        raise GoogleAuthError("Google sign-in is not configured on this server")
    if not credential or not credential.strip():
        raise GoogleAuthError("missing Google credential")

    try:
        kid = jwt.get_unverified_header(credential).get("kid")
    except JWTError as e:
        raise GoogleAuthError(f"malformed Google credential ({e})") from e
    if not kid:
        raise GoogleAuthError("Google credential has no key id")

    jwks = await _jwks()
    key = _find_key(jwks, kid)
    if key is None:
        # Unknown kid usually means Google rotated keys since our fetch.
        jwks = await _jwks(force=True)
        key = _find_key(jwks, kid)
    if key is None:
        raise GoogleAuthError("Google credential signed with an unknown key")

    try:
        # Issuer is checked by hand below: Google uses two spellings and
        # jose's `issuer=` only compares against one.
        claims = jwt.decode(
            credential,
            key,
            algorithms=["RS256"],
            audience=client_id,
            options={"verify_at_hash": False},
        )
    except JWTError as e:
        raise GoogleAuthError(f"invalid Google credential ({e})") from e

    if claims.get("iss") not in _ISSUERS:
        raise GoogleAuthError("Google credential has an unexpected issuer")

    email = (claims.get("email") or "").strip().lower()
    if not email:
        raise GoogleAuthError("Google account has no email address")
    # An unverified email would let someone claim an address they don't
    # own — and email is our account key, so that's account takeover.
    if not claims.get("email_verified"):
        raise GoogleAuthError("Google account email is not verified")

    return {
        "sub": claims.get("sub") or "",
        "email": email,
        "email_verified": True,
        "name": (claims.get("name") or "").strip(),
        "picture": claims.get("picture") or "",
    }
