import re

_FORMS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-]{16,}"), "[REDACTED authorization]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED github token]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED github token]"),
    (re.compile(r"sk-(?:ant-)?[A-Za-z0-9._\-]{16,}"), "[REDACTED api key]"),
    (re.compile(r"AIza[A-Za-z0-9_\-]{20,}"), "[REDACTED google key]"),
    (re.compile(r"//[^/@\s]+@"), "//<redacted>@"),
]

class Redactor:
    def __init__(self, configured_secrets):
        self._secrets = sorted({s for s in configured_secrets if s}, key=len, reverse=True)

    def scrub(self, text):
        if text is None:
            return text
        s = str(text)
        for secret in self._secrets:            # configured values first (longest-first)
            s = s.replace(secret, "[REDACTED]")
        for pat, repl in _FORMS:
            s = pat.sub(repl, s)
        return s
