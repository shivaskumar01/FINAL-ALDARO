from pydantic import BaseModel
import os

class Settings(BaseModel):
    api_base: str = os.getenv("ALDARO_API_BASE", "http://localhost:4000")
    run_id: str = os.getenv("ALDARO_RUN_ID", "")
    agent_token: str = os.getenv("ALDARO_AGENT_TOKEN", "")
    workdir: str = os.getenv("ALDARO_WORKDIR", "/workspace")
    heartbeat_seconds: int = int(os.getenv("ALDARO_HEARTBEAT_SECONDS", "5"))
