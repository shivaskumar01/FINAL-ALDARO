from pydantic import BaseModel
from typing import Any, Dict, Literal, Optional
from datetime import datetime
import uuid

MsgType = Literal["HELLO","STATUS","LOG","METRIC","ARTIFACT","HEARTBEAT","ERROR","COMMAND"]

class Envelope(BaseModel):
    schema_version: str = "1.0"
    message_id: str = ""
    run_id: str
    sent_at: str = ""
    type: MsgType
    payload: Dict[str, Any]

    @staticmethod
    def build(run_id: str, type: MsgType, payload: Dict[str, Any]) -> "Envelope":
        return Envelope(
            message_id=str(uuid.uuid4()),
            run_id=run_id,
            sent_at=datetime.utcnow().isoformat() + "Z",
            type=type,
            payload=payload,
        )
