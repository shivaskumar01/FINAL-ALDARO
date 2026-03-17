import click
import httpx
import yaml
import os
import json
from pathlib import Path
from rich.console import Console
from rich.table import Table

CLI_VERSION = "1.0.0-alpha.1"
console = Console()
CONFIG_DIR = Path.home() / ".aldaro"
AUTH_FILE = CONFIG_DIR / "auth.json"
REPO_CONFIG = Path(".aldaro") / "config.yaml"

def get_api_base():
    return os.getenv("ALDARO_API_BASE", "http://localhost:4000")

def save_auth(token):
    CONFIG_DIR.mkdir(exist_ok=True)
    AUTH_FILE.write_text(json.dumps({"token": token}))

def get_token():
    if not AUTH_FILE.exists(): return None
    return json.loads(AUTH_FILE.read_text()).get("token")

@click.group()
def main():
    """Aldaro.AI CLI (hourly GPU runs)"""
    pass

@main.command()
def version():
    """Show Aldaro CLI version"""
    console.print(f"Aldaro CLI version: [bold]{CLI_VERSION}[/bold]")

@main.command()
@click.option("--email", prompt=True)
@click.option("--password", prompt=True, hide_input=True)
def login(email, password):
    """Login to Aldaro.AI"""
    try:
        resp = httpx.post(
            f"{get_api_base()}/auth/login",
            json={"email": email, "password": password},
            headers={"x-aldaro-client": "cli"},
        )
        if resp.status_code == 200:
            data = resp.json()
            token = data.get("token")
            if token:
                save_auth(token)
                console.print("[green]Logged in.[/green]")
                console.print(f"User: {email}")
            else:
                console.print("[yellow]Warning: Login successful but no token returned.[/yellow]")
        else:
            console.print(f"[red]Login failed.[/red] Reason: {resp.json().get('error', 'unknown')}")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")

@main.command()
def init():
    """Initialize Aldaro project config"""
    Path(".aldaro").mkdir(exist_ok=True)
    config = {
        "project_id": "",
        "ignore": ["node_modules", ".git", "__pycache__"]
    }
    REPO_CONFIG.write_text(yaml.dump(config))
    console.print(f"Initialized Aldaro project config at {REPO_CONFIG}")

@main.command()
@click.option("--name", required=True)
@click.option("--repo", required=True)
def project_create(name, repo):
    """Create a project"""
    token = get_token()
    if not token: return console.print("[red]Please login first.[/red]")
    
    headers = {"Authorization": f"Bearer {token}"}
    try:
        resp = httpx.post(f"{get_api_base()}/v1/projects", json={"name": name, "repo_url": repo}, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        console.print("[green]Project created.[/green]")
        console.print(f"id: {data['id']}")
        console.print(f"name: {data['name']}")
        console.print(f"repo: {data['repoUrl']}")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")

@main.command()
@click.option("--project", required=True)
@click.option("--gpu", required=True)
@click.option("--command", required=True)
@click.option("--hours-max", default=2)
def run_create(project, gpu, command, hours_max):
    """Create a run"""
    token = get_token()
    if not token: return console.print("[red]Please login first.[/red]")
    
    headers = {"Authorization": f"Bearer {token}"}
    try:
        resp = httpx.post(
            f"{get_api_base()}/v1/projects/{project}/runs", 
            json={"gpu_type": gpu, "command": command, "hours_max": hours_max},
            headers=headers
        )
        resp.raise_for_status()
        data = resp.json()
        console.print("[green]Run created.[/green]")
        console.print(f"id: {data['id']}")
        console.print(f"status: {data['status']}")
        console.print(f"gpu: {data['gpuType']} x{data['gpuCount']}")
        console.print(f"hours_max: {data['hoursMax']}")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")

@main.command()
@click.argument("run_id")
def run_status(run_id):
    """Get run status"""
    token = get_token()
    if not token: return console.print("[red]Please login first.[/red]")
    
    headers = {"Authorization": f"Bearer {token}"}
    try:
        resp = httpx.get(f"{get_api_base()}/v1/runs/{run_id}", headers=headers)
        resp.raise_for_status()
        data = resp.json()
        
        table = Table(title=f"Run Status: {run_id}")
        table.add_column("Field", style="cyan")
        table.add_column("Value", style="magenta")
        
        table.add_row("Status", data["status"])
        table.add_row("GPU", f"{data['gpuType']} x{data['gpuCount']}")
        table.add_row("Command", data["command"])
        table.add_row("Started", str(data.get("startedAt") or "N/A"))
        table.add_row("Finished", str(data.get("finishedAt") or "N/A"))
        if data.get("errorMessage"):
            table.add_row("Error", data["errorMessage"], style="red")
            
        console.print(table)
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")

@main.command()
@click.argument("run_id")
def run_logs(run_id):
    """Stream run logs"""
    token = get_token()
    if not token: return console.print("[red]Please login first.[/red]")
    
    headers = {"Authorization": f"Bearer {token}"}
    console.print(f"Connecting to log stream for {run_id}...")
    
    # Simple polling/streaming implementation for MVP
    last_seq = 0
    while True:
        try:
            # We use the SSE endpoint but for simple CLI we'll just parse the lines
            with httpx.stream("GET", f"{get_api_base()}/v1/runs/{run_id}/logs?since_seq={last_seq}", headers=headers, timeout=None) as response:
                for line in response.iter_lines():
                    if line.startswith("data: "):
                        log_data = json.loads(line[6:])
                        stream = log_data["stream"]
                        text = log_data["line"]
                        seq = log_data["seq"]
                        last_seq = max(last_seq, seq)
                        
                        color = "green" if stream == "stdout" else "red" if stream == "stderr" else "yellow"
                        console.print(f"[[{color}]{stream}[/{color}]] {text}")
            
            # Check if run is finished
            resp = httpx.get(f"{get_api_base()}/v1/runs/{run_id}", headers=headers)
            status = resp.json().get("status")
            if status in ["completed", "failed", "canceled", "timed_out"]:
                console.print(f"Run finished: [bold]{status}[/bold]")
                break
                
            import time
            time.sleep(2)
        except KeyboardInterrupt:
            break
        except Exception as e:
            console.print(f"[red]Stream error:[/red] {e}")
            break

@main.command()
@click.argument("run_id")
@click.option("--path", required=True)
@click.option("--out", required=True)
def artifact_download(run_id, path, out):
    """Download an artifact"""
    token = get_token()
    if not token: return console.print("[red]Please login first.[/red]")
    
    console.print(f"Downloading {path} from {run_id} -> {out}")
    # Stub: In a real app, get presigned URL from API and download
    console.print("[green]Done.[/green]")

if __name__ == "__main__":
    main()
