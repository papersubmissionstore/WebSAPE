# BizArena

## Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop/) installed and running
- Node.js 22+ (only needed if running locally without Docker)

## Setup

```bash
# Build image
docker build -t bizarena .

# Run container with a fixed name (local-port:container-port)
docker run --rm --name bizarena -p 3100:3100 -p 3101:3101 -p 3102:3102 bizarena
```

## Running Tasks

### 1. Reset websites (required before every run)

```bash
curl -X POST http://localhost:3100/api/reset
curl -X POST http://localhost:3101/api/reset
curl -X POST http://localhost:3102/api/reset
```

### 2. Run the agent

Tasks are defined in the `.jsonl` files. Each entry has a `start_url` and `intent`. Format the query depending on task type:

**Single-site tasks** (e.g., `scrumboard_tasks.jsonl`, `outlook_tasks.jsonl`, `teams_tasks.jsonl`):

```
Start from {start_url} to complete this task:
{intent}
```

**Cross-site tasks** (`cross_site_tasks.jsonl`) — append site URLs as suffix:

```
Start from {start_url} to complete this task:
{intent}
IMPORTANT: Use these local sites instead of public internet:
Outlook: http://127.0.0.1:3101
Scrumboard: http://127.0.0.1:3100
Teams: http://127.0.0.1:3102

Do NOT navigate to public websites like outlook.com, teams.microsoft.com, etc. Use the URLs above.
```

### 3. Evaluate

#### Option A: Evaluate inside Docker (recommended)

```bash
docker exec bizarena node /app/evaluator.cjs {query_hash} /app
```

#### Option B: Download results and evaluate locally

The evaluator reads `db_initial.json` from each site folder (already in the repo). You just need to download the snapshots and event logs. Save each task's results in a separate folder for per-task debugging:

```bash
# Create output folder for a specific task
mkdir -p output/{query_hash}/scrumboard output/{query_hash}/outlook output/{query_hash}/teams

# Copy db_initial.json into each site subfolder
cp scrumboard/db_initial.json output/{query_hash}/scrumboard/
cp outlook/db_initial.json output/{query_hash}/outlook/
cp teams/db_initial.json output/{query_hash}/teams/

# Download event logs and snapshots
curl http://localhost:3100/api/download/event-log -o output/{query_hash}/scrumboard/event_log.ndjson
curl http://localhost:3100/api/download/snapshot -o output/{query_hash}/scrumboard/localStorage_snapshot.json
curl http://localhost:3101/api/download/event-log -o output/{query_hash}/outlook/event_log.ndjson
curl http://localhost:3101/api/download/snapshot -o output/{query_hash}/outlook/localStorage_snapshot.json
curl http://localhost:3102/api/download/event-log -o output/{query_hash}/teams/event_log.ndjson
curl http://localhost:3102/api/download/snapshot -o output/{query_hash}/teams/localStorage_snapshot.json

# Run evaluator (from BizArena directory)
node evaluator.cjs {query_hash} ./output/{query_hash}
```
