"""Check visible editor input after a startup overlay closes in a real Pi TUI."""

import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import termios
import time


def wait_for(fd, marker, timeout):
    deadline = time.monotonic() + timeout
    tail = b""
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        tail += chunk
        if marker in tail:
            return True
        tail = tail[-len(marker):]
    return False


test_dir = Path(__file__).resolve().parent
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))
    os.environ["TERM"] = "xterm-256color"
    os.execlp(
        "pi", "pi", "--offline", "--no-session", "--no-extensions",
        "-e", str(test_dir / "startup-overlay.ts"),
        "-e", str(test_dir.parent / "src/index.ts"),
    )

try:
    assert wait_for(fd, b"Startup overlay closed", 12), "Pi did not finish the startup overlay"
    assert not termios.tcgetattr(fd)[3] & termios.ICANON, "Pi did not enable raw terminal input"
    probe = b"startupfocusprobe"
    os.write(fd, probe)
    assert wait_for(fd, probe, 3), "Typed text did not appear in the focused prompt editor"
    print("Pi accepted input after the startup overlay closed")
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
    os.waitpid(pid, 0)
