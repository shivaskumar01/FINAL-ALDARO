import pytest
from pathlib import Path
import tempfile
import shutil
from aldaro_agent.detector import detect_repo

@pytest.fixture
def temp_repo():
    path = tempfile.mkdtemp()
    yield Path(path)
    shutil.rmtree(path)

def test_det_001_requirements_txt(temp_repo):
    (temp_repo / "requirements.txt").write_text("torch")
    res = detect_repo(str(temp_repo))
    assert res.language == "python"
    assert res.dependency_strategy == "uv"

def test_det_002_poetry(temp_repo):
    (temp_repo / "pyproject.toml").write_text("[tool.poetry]\nname = 'test'")
    res = detect_repo(str(temp_repo))
    assert res.language == "python"
    assert res.dependency_strategy == "poetry"

def test_det_003_fastapi(temp_repo):
    (temp_repo / "app.py").write_text("from fastapi import FastAPI\napp = FastAPI()")
    res = detect_repo(str(temp_repo))
    assert res.workload == "inference_api"
    assert 8000 in res.ports
    assert "uvicorn" in res.run_command_default

def test_det_004_devcontainer(temp_repo):
    (temp_repo / ".devcontainer").mkdir()
    (temp_repo / ".devcontainer" / "devcontainer.json").write_text("{}")
    res = detect_repo(str(temp_repo))
    assert res.dependency_strategy == "devcontainer"

def test_det_005_unknown(temp_repo):
    res = detect_repo(str(temp_repo))
    assert res.language == "unknown"
    assert res.workload == "unknown"
