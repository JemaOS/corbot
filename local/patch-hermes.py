#!/usr/bin/env python3
"""Stop Hermes from corrupting images in a conversation.

Hermes redacts secrets in everything it stores and sends. Its JWT rule looks for "eyJ" followed by
base64 characters, and random bytes inside a screenshot's base64 contain that by chance: the
redactor then replaces a run of the image with "…". The stored or re-sent image is no longer valid
base64, and the provider rejects the request with "Non-base64 digit found" — after a long hang.
Every following turn of that conversation fails the same way.

This patch teaches the redactor to leave base64 image payloads ("data:image/png;base64,…") alone.
Everything else is redacted as before. It is idempotent and does nothing if a newer Hermes has its
own protection.

Run it inside the container, or from `local/corbot deploy` (install-app.sh calls it):
    python3 local/patch-hermes.py [/root/.hermes/hermes-agent/agent/redact.py]
"""
import re
import sys

MARK = "# corbot: data URL payloads are images, not secrets"
WRAPPER = f'''

{MARK}
_DATA_URL_PAYLOAD_RE = re.compile(
    r"data:[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\\s]+"
)


def _corbot_split_data_urls(text):
    """Replace each base64 data URL with a token, and return the URLs alongside."""
    kept = []

    def keep(match):
        kept.append(match.group(0))
        return f"\\x00corbot-data-url-{{len(kept) - 1}}\\x00"

    return _DATA_URL_PAYLOAD_RE.sub(keep, text), kept


def redact_sensitive_text(text, **kwargs):
    """``_redact_sensitive_text_plain``, with base64 image payloads left untouched (they are not text
    and masking a run inside them makes the image invalid, which providers reject)."""
    if not isinstance(text, str) or "base64," not in text or "data:" not in text:
        return _redact_sensitive_text_plain(text, **kwargs)
    protected, kept = _corbot_split_data_urls(text)
    out = _redact_sensitive_text_plain(protected, **kwargs)
    for i, url in enumerate(kept):
        out = out.replace(f"\\x00corbot-data-url-{{i}}\\x00", url)
    return out
'''


def patch(path: str) -> str:
    src = open(path, encoding="utf-8").read()
    if MARK in src:
        return "already patched"
    if "def redact_sensitive_text(" not in src:
        return "SKIPPED: redact_sensitive_text not found (a newer Hermes?); nothing changed"
    # Rename the original and add the wrapper at the end, so every existing caller gets it.
    src = src.replace("def redact_sensitive_text(", "def _redact_sensitive_text_plain(", 1)
    src = src.rstrip("\n") + "\n" + WRAPPER
    open(path, "w", encoding="utf-8").write(src)
    return "patched"


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/root/.hermes/hermes-agent/agent/redact.py"
    print(f"{target}: {patch(target)}")
