import json
import os
import subprocess
import time
import tempfile
import platform

def sh(cmd: str, timeout_s: int = 20) -> str:
    return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, timeout=timeout_s).decode()

def now_ms() -> int:
    return int(time.time() * 1000)

def disk_benchmark_mb_s(file_mb: int = 256):
    path = os.path.join(tempfile.gettempdir(), "aldaro_disk_test.bin")
    bs = 1024 * 1024
    count = file_mb

    t0 = time.time()
    sh(f"dd if=/dev/zero of={path} bs={bs} count={count} oflag=direct status=none", timeout_s=60)
    t1 = time.time()
    write_s = max(0.001, t1 - t0)
    write_mb_s = file_mb / write_s

    t2 = time.time()
    sh(f"dd if={path} of=/dev/null bs={bs} iflag=direct status=none", timeout_s=60)
    t3 = time.time()
    read_s = max(0.001, t3 - t2)
    read_mb_s = file_mb / read_s

    try:
        os.remove(path)
    except Exception:
        pass

    return read_mb_s, write_mb_s

def net_benchmark_mbps():
    down_mbps = 0
    try:
        t0 = time.time()
        sh("curl -L --max-time 8 -o /dev/null -s https://speed.hetzner.de/100MB.bin", timeout_s=10)
        t1 = time.time()
        down_mbps = (100 * 8) / max(0.5, (t1 - t0))
    except Exception:
        down_mbps = 0
    return down_mbps, 0

def gpu_info():
    try:
        out = sh("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader", timeout_s=10).strip()
        parts = [p.strip() for p in out.split(",")]
        gpu_name = parts[0] if len(parts) > 0 else ""
        driver_version = parts[1] if len(parts) > 1 else ""
        mem_mb = float(parts[2].split()[0]) if len(parts) > 2 else 0.0
        vram_gb = mem_mb / 1024.0

        cuda_version = ""
        try:
            smi = sh("nvidia-smi", timeout_s=10)
            for line in smi.splitlines():
                if "CUDA Version" in line:
                    cuda_version = line.split("CUDA Version")[-1].strip().split()[0]
                    break
        except Exception:
            pass
        return gpu_name, driver_version, cuda_version, vram_gb
    except Exception:
        return "", "", "", 0.0

def torch_gpu_test():
    try:
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("torch.cuda.is_available == false")
        device = torch.device("cuda:0")
        a = torch.randn((4096, 4096), device=device)
        b = torch.randn((4096, 4096), device=device)
        torch.cuda.synchronize()
        t0 = time.time()
        c = a @ b
        torch.cuda.synchronize()
        t1 = time.time()
        return (t1 - t0)
    except Exception:
        return 999.0

def micro_train_test(steps: int = 200):
    try:
        import torch
        import torch.nn as nn
        device = torch.device("cuda:0")
        model = nn.Sequential(
            nn.Linear(2048, 2048),
            nn.ReLU(),
            nn.Linear(2048, 1024),
            nn.ReLU(),
            nn.Linear(1024, 10),
        ).to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
        loss_fn = nn.CrossEntropyLoss()
        x = torch.randn((256, 2048), device=device)
        y = torch.randint(0, 10, (256,), device=device)
        torch.cuda.synchronize()
        t0 = time.time()
        for _ in range(steps):
            opt.zero_grad(set_to_none=True)
            out = model(x)
            loss = loss_fn(out, y)
            loss.backward()
            opt.step()
        torch.cuda.synchronize()
        t1 = time.time()
        return (t1 - t0)
    except Exception:
        return 999.0

def score_metrics(disk_read, disk_write, net_down, micro_train_s):
    score = 100
    if disk_read < 200: score -= 10
    if disk_read < 100: score -= 15
    if disk_write < 200: score -= 10
    if disk_write < 100: score -= 15
    if net_down < 200: score -= 10
    if net_down < 100: score -= 15
    if net_down < 50: score -= 25
    if micro_train_s > 20: score -= 15
    if micro_train_s > 30: score -= 25
    if micro_train_s > 45: score -= 40
    return max(0, min(100, score))

def main():
    log_lines = []
    def log(msg): log_lines.append(msg)
    result = {
        "pass": False, "score_0_100": 0, "gpu_name": "", "vram_gb": 0,
        "cuda_version": "", "driver_version": "", "disk_read_mb_s": 0,
        "disk_write_mb_s": 0, "net_down_mbps": 0, "net_up_mbps": 0,
        "micro_train_seconds": 0, "torch_matmul_seconds": 0,
        "platform": platform.platform(), "ts_ms": now_ms(),
    }
    try:
        log("Step1: GPU info")
        gpu_name, driver_version, cuda_version, vram_gb = gpu_info()
        result.update({"gpu_name": gpu_name, "driver_version": driver_version, "cuda_version": cuda_version, "vram_gb": vram_gb})
        if not gpu_name: raise RuntimeError("GPU name empty")
        log("Step2: Torch GPU test")
        matmul_s = torch_gpu_test()
        result["torch_matmul_seconds"] = matmul_s
        log("Step3: Disk benchmark")
        r, w = disk_benchmark_mb_s()
        result.update({"disk_read_mb_s": r, "disk_write_mb_s": w})
        log("Step4: Net benchmark")
        down, up = net_benchmark_mbps()
        result.update({"net_down_mbps": down, "net_up_mbps": up})
        log("Step5: Micro train")
        mt = micro_train_test()
        result["micro_train_seconds"] = mt
        score = score_metrics(r, w, down, mt)
        result["score_0_100"] = score
        if score < 60: raise RuntimeError(f"Score too low: {score}")
        result["pass"] = True
        log("PASS")
    except Exception as e:
        log(f"FAIL: {repr(e)}")
        result["pass"] = False
    print(json.dumps({"result": result, "raw_log": "\n".join(log_lines)}))

if __name__ == "__main__":
    main()
