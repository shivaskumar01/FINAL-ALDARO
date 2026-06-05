import os, json, time, hmac, hashlib, requests, subprocess

API_BASE = os.getenv("ALDARO_API_BASE_URL")
# A3: prefer the per-workspace secret injected at provision time; fall back to the
# global shared secret only for legacy/dev. The global secret should NOT be present
# in production workspace VMs.
SECRET = os.getenv("ALDARO_WORKSPACE_AGENT_SECRET") or os.getenv("ALDARO_AGENT_SHARED_SECRET")
WORKSPACE_ID = os.getenv("ALDARO_WORKSPACE_ID")

def sign(body: bytes) -> str:
    return hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()

def gpu_util_pct() -> int:
    try:
        out = subprocess.check_output("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits", shell=True, timeout=5).decode().strip()
        return int(out.splitlines()[0])
    except Exception:
        return 0

def net_totals_mb():
    try:
        data = open("/proc/net/dev","r").read().splitlines()
        rx, tx = 0, 0
        for line in data:
            if ":" not in line: continue
            iface, rest = line.split(":")
            if iface.strip() == "lo": continue
            parts = rest.split()
            rx += int(parts[0])
            tx += int(parts[8])
        return int(rx / (1024*1024)), int(tx / (1024*1024))
    except Exception:
        return 0, 0

def main():
    while True:
        util = gpu_util_pct()
        rx_mb, tx_mb = net_totals_mb()
        event = {"workspace_id": WORKSPACE_ID, "gpu_utilization_pct": util, "network_rx_mb": rx_mb, "network_tx_mb": tx_mb, "ts": int(time.time())}
        body = json.dumps(event).encode()
        headers = {"Content-Type": "application/json", "X-Aldaro-Signature": sign(body)}
        try:
            requests.post(f"{API_BASE}/internal/agent/heartbeat", data=body, headers=headers, timeout=10)
        except Exception:
            pass
        time.sleep(30)

if __name__ == "__main__":
    main()
