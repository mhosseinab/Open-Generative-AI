#!/usr/bin/env python3
"""Install the Studio provider credential without shell history or terminal echo."""
import getpass
import os
from pathlib import Path

if os.geteuid() != 0:
    raise SystemExit('Run this command as root')
key = getpass.getpass('MuAPI API key (hidden): ').strip()
if not key or any(c.isspace() for c in key):
    raise SystemExit('Key must be nonempty and contain no whitespace; unchanged')
path = Path('/opt/open-generative-ai/secrets/muapi_api_key')
# Update the existing inode: Docker bind mount reads the new key immediately.
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o440)
try:
    os.fchmod(fd, 0o440)
    os.fchown(fd, 0, 1000)
    os.write(fd, key.encode())
    os.fsync(fd)
finally:
    os.close(fd)
print('Shared MuAPI key installed. Reload Studio; no restart is needed.')
