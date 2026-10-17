"""Generate the VAPID key pair for web push and write it into backend/.env.

    cd backend && python -m scripts.generate_vapid_keys              # refuses if keys are already set
    python -m scripts.generate_vapid_keys --env /path/to/backend/.env

Sets VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY (P-256, base64url: the raw private key and the
uncompressed public point) and adds VAPID_SUBJECT if it's missing. Prints only the public key.
Generate once: browsers' subscriptions are tied to the public key, so new keys mean every device
must subscribe again. The server gets the same keys with deploy/copy-to-server.sh.
"""

import argparse
import base64
import re
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import BACKEND_DIR

DEFAULT_SUBJECT = "https://jazrs1.github.io"   # change to the frontend origin once the domain exists


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate() -> tuple[str, str]:
    """(private, public), both base64url without padding."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64url(private), b64url(public)


def _value(text: str, name: str) -> str | None:
    """The last value of NAME= in an env file's text (quotes stripped), or None if absent."""
    found = re.findall(rf"^\s*(?:export\s+)?{name}=(.*)$", text, flags=re.M)
    return found[-1].strip().strip("'\"") if found else None


def write_keys(env_path: Path, private: str, public: str) -> None:
    """Fill VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY (replacing empty lines) and add VAPID_SUBJECT if absent.
    Raises FileExistsError if either key already has a value."""
    text = env_path.read_text() if env_path.exists() else ""
    if _value(text, "VAPID_PRIVATE_KEY") or _value(text, "VAPID_PUBLIC_KEY"):
        raise FileExistsError(f"{env_path} already has VAPID keys")
    lines = [ln for ln in text.splitlines() if not re.match(r"^\s*(?:export\s+)?VAPID_(PRIVATE|PUBLIC)_KEY=", ln)]
    lines += ["", "# Web push (python -m scripts.generate_vapid_keys). Never change after browsers subscribe.",
              f"VAPID_PRIVATE_KEY={private}", f"VAPID_PUBLIC_KEY={public}"]
    if _value(text, "VAPID_SUBJECT") is None:
        lines.append(f"VAPID_SUBJECT={DEFAULT_SUBJECT}")
    tmp = env_path.with_name(env_path.name + ".tmp")
    tmp.write_text("\n".join(lines).lstrip("\n") + "\n")
    tmp.chmod(0o600)
    tmp.replace(env_path)   # atomic: the .env is never half-written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env", type=Path, default=BACKEND_DIR / ".env")
    args = parser.parse_args()
    private, public = generate()
    try:
        write_keys(args.env, private, public)
    except FileExistsError as err:
        sys.exit(f"{err}; not replacing them (every subscribed device would have to subscribe again).")
    print(f"Wrote VAPID keys to {args.env}")
    print(f"VAPID_PUBLIC_KEY={public}")


if __name__ == "__main__":
    main()
