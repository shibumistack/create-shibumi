"""Run a command on a real pty and answer its prompts.

The Ship client renders its plan and asks its questions only when stdin and
stdout are both terminals, so the plan path cannot be tested through pipes.
Keystrokes come from PTY_KEYS (a JSON array) and are sent one at a time once
the child has gone quiet, which keeps them from arriving before the prompt
that reads them. Everything the child printed goes to stdout; the exit status
is the child's.

Used by test/setup.plan.test.ts. python3 ships with macOS and with the
ubuntu-latest runner, so this needs no dependency.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

QUIET = 0.4          # seconds of silence before the next keystroke
IDLE_GIVE_UP = 6.0   # seconds of silence with no keystrokes left
TIMEOUT = 120.0

keys = json.loads(os.environ.get("PTY_KEYS") or "[]")
command = sys.argv[1:]
if not command:
    sys.exit("usage: pty-run.py <command> [args...]")

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

# A pty forked with no window size reports zero columns, and clack then wraps
# every single character onto its own line.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

out = bytearray()
last = time.time()
started = time.time()
alive = True
while time.time() - started < TIMEOUT:
    readable, _, _ = select.select([fd], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        last = time.time()
        continue
    quiet = time.time() - last
    if keys and quiet > QUIET:
        try:
            os.write(fd, keys.pop(0).encode())
        except OSError:
            break
        last = time.time()
    elif not keys and quiet > IDLE_GIVE_UP:
        os.kill(pid, signal.SIGTERM)
        alive = False
        break

sys.stdout.buffer.write(bytes(out))
sys.stdout.buffer.flush()
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
if not alive:
    # Killed for going quiet with no keystrokes left: the run hung, and a zero
    # exit here would let a test pass on a transcript that stopped early.
    sys.stderr.write("pty-run: child went idle and was terminated\n")
    sys.exit(124)
sys.exit(os.waitstatus_to_exitcode(status))
