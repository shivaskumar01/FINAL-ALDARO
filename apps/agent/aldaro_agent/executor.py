import asyncio
from asyncio.subprocess import PIPE
from typing import Callable, Awaitable

async def run_command(cmd: str, on_stdout: Callable[[str], Awaitable[None]], on_stderr: Callable[[str], Awaitable[None]]) -> int:
    if not cmd:
        print("No command to run")
        return 0
        
    proc = await asyncio.create_subprocess_shell(cmd, stdout=PIPE, stderr=PIPE)

    async def pump(stream, cb):
        while True:
            line = await stream.readline()
            if not line:
                break
            await cb(line.decode(errors="ignore").rstrip("\n"))

    await asyncio.gather(
        pump(proc.stdout, on_stdout),
        pump(proc.stderr, on_stderr),
    )
    return await proc.wait()
