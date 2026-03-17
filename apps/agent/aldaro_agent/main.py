import asyncio
import httpx
import os
import sys

try:
    from .detector import detect_repo
    from .executor import run_command
    from .net import with_retries
    from .protocol import Envelope
    from .settings import Settings
except ImportError:
    from detector import detect_repo
    from executor import run_command
    from net import with_retries
    from protocol import Envelope
    from settings import Settings

AGENT_VERSION = "1.0.0-alpha.1"

async def main():
    s = Settings()
    if not s.run_id or not s.agent_token:
        print("Missing ALDARO_RUN_ID or ALDARO_AGENT_TOKEN")
        sys.exit(1)

    headers = {"Authorization": f"Bearer {s.agent_token}"}
    async with httpx.AsyncClient(base_url=s.api_base, headers=headers, timeout=30) as client:

        # handshake
        hello = {
            "run_id": s.run_id, 
            "agent_version": AGENT_VERSION, 
            "capabilities": {"repo_clone": True},
            "system": {
                "hostname": os.uname()[1],
                "gpu_info": "Detected GPU" # Stub
            }
        }
        
        print(f"Handshaking with {s.api_base}...")
        resp = await with_retries(lambda: client.post("/v1/agent/handshake", json=hello))
        resp.raise_for_status()
        hs = resp.json()
        agent_session_token = hs.get("token")
        if not agent_session_token:
            raise RuntimeError("Handshake did not return an agent session token")
        client.headers["Authorization"] = f"Bearer {agent_session_token}"
        print("Handshake successful.")

        # detect
        print(f"Scanning repo in {s.workdir}...")
        det = detect_repo(s.workdir)

        async def emit_status(step: str, state: str, detail: str, progress: float):
            msg = Envelope.build(s.run_id, "STATUS", {"state": state, "step": step, "detail": detail, "progress": progress})
            await with_retries(lambda: client.post(f"/v1/runs/{s.run_id}/events", json=msg.model_dump()))

        async def emit_log(stream: str, line: str, seq: int):
            msg = Envelope.build(s.run_id, "LOG", {"stream": stream, "line": line, "seq": seq})
            await with_retries(lambda: client.post(f"/v1/runs/{s.run_id}/events", json=msg.model_dump()))

        await emit_status("detect", "initializing", f"workload={det.workload}, dependency={det.dependency_strategy}", 0.1)

        # install deps (stub)
        if det.dependency_strategy == "uv":
            await emit_status("install", "initializing", "installing dependencies with uv", 0.2)
            # In a real agent, we would run: uv pip install -r requirements.txt
            print("Stub: Installing dependencies with uv...")
            await asyncio.sleep(1)

        # execute
        cmd = det.run_command_default
        print(f"Executing: {cmd}")
        await emit_status("execute", "running", f"running command: {cmd}", 0.5)
        
        seq = 0
        async def on_out(line: str):
            nonlocal seq
            seq += 1
            print(f"[stdout] {line}")
            await emit_log("stdout", line, seq)

        async def on_err(line: str):
            nonlocal seq
            seq += 1
            print(f"[stderr] {line}")
            await emit_log("stderr", line, seq)

        exit_code = await run_command(cmd, on_out, on_err)

        if exit_code == 0:
            print("Run completed successfully. Discovering artifacts...")
            await emit_status("upload", "uploading_artifacts", "discovering artifacts", 0.9)
            
            # Artifact discovery stub
            for path in det.artifact_paths:
                p = os.path.join(s.workdir, path.rstrip('/'))
                if os.path.exists(p):
                    print(f"Found artifact path: {path}")
                    # In real agent: hash file, get presigned URL, upload
                    msg = Envelope.build(s.run_id, "ARTIFACT", {
                        "path": path,
                        "kind": "dir" if os.path.isdir(p) else "file",
                        "bytes": 0, # Stub
                        "sha256": "stub-hash"
                    })
                    await with_retries(lambda: client.post(f"/v1/runs/{s.run_id}/events", json=msg.model_dump()))

            await emit_status("cleanup", "completed", "run finished", 1.0)
        else:
            print(f"Run failed with exit code {exit_code}")
            await emit_status("cleanup", "failed", f"exit_code={exit_code}", 1.0)

if __name__ == "__main__":
    asyncio.run(main())
