import pytest
from aldaro_agent.protocol import Envelope
import uuid

def test_proto_001_envelope_validation():
    run_id = "run_123"
    payload = {"state": "running"}
    env = Envelope.build(run_id, "STATUS", payload)
    
    assert env.run_id == run_id
    assert env.type == "STATUS"
    assert env.payload == payload
    assert env.message_id != ""
    assert env.sent_at.endswith("Z")

def test_proto_002_message_id_uniqueness():
    run_id = "run_123"
    env1 = Envelope.build(run_id, "HEARTBEAT", {})
    env2 = Envelope.build(run_id, "HEARTBEAT", {})
    assert env1.message_id != env2.message_id

def test_proto_003_payload_validation():
    # Pydantic handles validation
    with pytest.raises(Exception):
        Envelope(run_id="123", type="INVALID", payload={})
