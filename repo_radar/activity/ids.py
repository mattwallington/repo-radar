import re, secrets, uuid

ACTIVITY_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN_RE = re.compile(r"^[0-9a-f]{8}$")

def mint_activity_id() -> str:
    return str(uuid.uuid4())

def valid_activity_id(s) -> bool:
    return isinstance(s, str) and bool(ACTIVITY_ID_RE.fullmatch(s))

def mint_token() -> str:
    return secrets.token_hex(4)

def valid_token(s) -> bool:
    return isinstance(s, str) and bool(TOKEN_RE.fullmatch(s))
