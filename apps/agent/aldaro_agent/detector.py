from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Dict, Optional, Set
import re

@dataclass
class DetectionResult:
    language: str = "unknown"
    workload: str = "unknown"
    dependency_strategy: str = "unknown"
    run_command_default: str = ""
    ports: List[int] = field(default_factory=list)
    artifact_paths: List[str] = field(default_factory=list)
    accelerators: List[str] = field(default_factory=list)

def detect_repo(root: str) -> DetectionResult:
    p = Path(root)
    res = DetectionResult()
    res.artifact_paths = ["outputs/", "artifacts/", "checkpoints/", "runs/"]

    # 1. Devcontainer check (High precedence)
    if (p / ".devcontainer" / "devcontainer.json").exists() or (p / "devcontainer.json").exists():
        res.dependency_strategy = "devcontainer"
        res.language = "mixed"
        # We'd parse devcontainer.json for more details in a real implementation
        return res

    # 2. Language & Dependency Strategy
    if (p / "pyproject.toml").exists() or (p / "requirements.txt").exists() or (p / "setup.py").exists() or (p / "environment.yml").exists():
        res.language = "python"
        if (p / "pyproject.toml").exists():
            content = (p / "pyproject.toml").read_text()
            if "[tool.poetry]" in content:
                res.dependency_strategy = "poetry"
            elif "[project]" in content:
                res.dependency_strategy = "uv"
            else:
                res.dependency_strategy = "pip"
        elif (p / "environment.yml").exists():
            res.dependency_strategy = "conda"
        elif (p / "requirements.txt").exists():
            res.dependency_strategy = "uv" # Preferred per spec
        else:
            res.dependency_strategy = "pip"

    elif (p / "package.json").exists():
        res.language = "node"
        if (p / "pnpm-lock.yaml").exists():
            res.dependency_strategy = "pnpm"
        elif (p / "yarn.lock").exists():
            res.dependency_strategy = "yarn"
        else:
            res.dependency_strategy = "npm"

    elif (p / "go.mod").exists():
        res.language = "go"
        res.dependency_strategy = "go"

    elif (p / "Cargo.toml").exists():
        res.language = "rust"
        res.dependency_strategy = "rust"
    
    # Fallback to python if .py files exist
    elif list(p.glob("*.py")):
        res.language = "python"
        res.dependency_strategy = "pip"

    # 3. Workload Detection
    if res.language == "python":
        # Check for training markers
        training_files = {"train.py", "training.py", "finetune.py"}
        found_training = any((p / f).exists() for f in training_files)
        
        # Check file content for ML libraries
        content_markers = {
            "torch": "import torch",
            "tf": "import tensorflow",
            "hf": "from transformers import Trainer",
            "lightning": "import lightning",
            "fastapi": "from fastapi import FastAPI",
            "flask": "from flask import Flask",
            "gradio": "import gradio",
            "streamlit": "import streamlit"
        }
        
        found_markers = set()
        for f in p.glob("**/*.py"):
            try:
                # Only check root and src files for performance
                if len(f.relative_to(p).parts) > 2: continue 
                txt = f.read_text()
                for key, marker in content_markers.items():
                    if marker in txt:
                        found_markers.add(key)
            except: pass

        if any(m in found_markers for m in ["fastapi", "flask", "gradio", "streamlit"]) or (p / "app.py").exists():
            res.workload = "inference_api"
            res.ports = [8000]
            if "fastapi" in found_markers:
                res.run_command_default = "uvicorn app:app --host 0.0.0.0 --port 8000"
            elif "flask" in found_markers:
                res.run_command_default = "flask run --host=0.0.0.0 --port=8000"
        elif found_training or any(m in found_markers for m in ["torch", "tf", "hf", "lightning"]):
            res.workload = "training"
            if (p / "train.py").exists():
                res.run_command_default = "python train.py"
            elif (p / "finetune.py").exists():
                res.run_command_default = "python finetune.py"
        
        if "torch" in found_markers: res.accelerators.append("torch")
        if "tf" in found_markers: res.accelerators.append("tf")

    elif res.language == "node":
        content = (p / "package.json").read_text()
        if '"next"' in content:
            res.workload = "inference_api"
            res.run_command_default = "npm run dev" # or build/start
            res.ports = [3000]
        else:
            res.workload = "batch"

    # 4. Artifact Guessing
    possible_dirs = ["outputs", "artifacts", "checkpoints", "runs", "wandb", "mlruns", "logs", "results"]
    res.artifact_paths = [f"{d}/" for d in possible_dirs if (p / d).is_dir()] or ["outputs/"]

    return res
