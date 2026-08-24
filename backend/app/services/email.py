"""Outbound email — currently only the signup verification code.

Deliberately dependency-free: uses the stdlib smtplib. The call is
blocking, so callers run it via asyncio.to_thread.

If no SMTP host is configured the code is written to the log instead of
sent. That keeps local dev / staging working without a mail account, and
is why AUTH_REQUIRE_EMAIL_VERIFICATION must only be turned ON once SMTP_*
is filled in — otherwise real users would never receive their code.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage

from ..config import settings

log = logging.getLogger("justspeak.email")


def send_verification_code(to_email: str, code: str) -> None:
    ttl = settings.email_code_ttl_minutes
    subject = "justSpeak 注册验证码"
    body = (
        f"你的 justSpeak 验证码是：{code}\n\n"
        f"请在 {ttl} 分钟内在页面填入完成注册。\n"
        f"如果这不是你本人的操作，忽略本邮件即可。"
    )

    if not settings.smtp_host:
        # No sender configured — log the code so dev/staging can still test
        # the flow. NEVER rely on this in production: turn the feature on
        # only after SMTP is set.
        log.warning(
            "[email] SMTP not configured; verification code for %s is %s",
            to_email, code,
        )
        return

    from_addr = settings.email_from or settings.smtp_user
    msg = EmailMessage()
    msg["From"] = f"{settings.email_from_name} <{from_addr}>"
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    ctx = ssl.create_default_context()
    if settings.smtp_use_ssl:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ctx) as s:
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as s:
            s.starttls(context=ctx)
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)
    log.info("[email] sent verification code to %s", to_email)
