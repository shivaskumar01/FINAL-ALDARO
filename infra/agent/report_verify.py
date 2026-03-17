import os, json, hmac, hashlib, requests

API_BASE = os.getenv("ALDARO_API_BASE_URL")
SECRET = os.getenv("ALDARO_AGENT_SHARED_SECRET")
WORKSPACE_ID = os.getenv("ALDARO_WORKSPACE_ID")

def sign(body: bytes) -> str:
    return hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()

def main():
    try:
        with open("/opt/aldaro/verification.json", "r") as f:
            payload = json.load(f)
        body = json.dumps({
            "workspace_id": WORKSPACE_ID,
            "verification": payload["result"],
            "raw_log": payload["raw_log"]
        }).encode()
        headers = {
            "Content-Type": "application/json",
            "X-Aldaro-Signature": sign(body)
        }
        r = requests.post(f"{API_BASE}/internal/agent/verify-result", data=body, headers=headers, timeout=10)
        print(r.status_code, r.text)
    except Exception as e:
        print(f"Error reporting verification: {e}")

if __name__ == "__main__":
    main()
