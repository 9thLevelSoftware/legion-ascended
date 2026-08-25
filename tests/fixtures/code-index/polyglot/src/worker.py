from pathlib import Path

def resolve_asset(identifier: str) -> Path:
    return Path("assets") / identifier
