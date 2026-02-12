# LANraragi XTC Bridge

A Bun-first TypeScript + React project that:

- Browses LANraragi archives with cover, title, tags, and summary.
- Converts selected archives to `.xtc` using `cbz2xtc` settings from a web UI.
- Exposes an OPDS catalog for XTEink X4 (Crosspoint firmware).
- Performs conversion on demand and deletes generated files after transfer.

## Bun Quick Commands

```bash
bun install
bun run dev
bun run typecheck
bun run build
```

## Docker (Unraid / Compose)

This repo includes a minimal multi-stage Docker build that:

- Builds the React web UI
- Runs the API/OPDS backend and serves the built web UI at `/`
- Bundles Python + Pillow for `cbz2xtc`/`png2xtc`

### 1. Prepare env file

```bash
cp docker/server.env.example docker/server.env
```

Edit `docker/server.env`:

- `SERVER_PUBLIC_URL` to your Unraid host URL (e.g. `http://192.168.2.10:3000`)
- `LANRARAGI_BASE_URL`
- `LANRARAGI_API_KEY`
- `XTEINK_BASE_URL`

### 2. Start with compose

```bash
docker compose up -d --build
```

### 3. Data persistence

`docker-compose.yml` mounts:

- `./data/runtime` -> device defaults/settings
- `./data/logs` -> backend logs
- `./data/tmp` -> conversion workspace

For Unraid, you can point these to `/mnt/user/appdata/...` paths by editing the compose volumes.

## Stack

- Backend: TypeScript + Hono (Node/Bun compatible)
- Frontend: React + Vite + TypeScript
- Runtime package manager: Bun

## Features

- Archive listing/search/sort via LANraragi `/api/search`
- Includes `Date` sort using LANraragi `date_added` tag namespace sorting
- Thumbnail proxy via LANraragi `/api/archives/:id/thumbnail`
- Manual conversion/download from web UI
- OPDS feed with pagination + sorting query params (`q`, `page`, `pageSize`, `sortby`, `order`)
- OPDS download endpoint that auto-converts with default settings
- Conversion settings mapped to `cbz2xtc.py` flags
- Basic options UI (xtcjs-style defaults) with optional advanced toggle
- Cover thumbnail crop toggle (LANraragi-like behavior)

### Archive handling strategy

- Direct-download-first: for `cbz`/`zip`, conversion uses LANraragi `/api/archives/:id/download` directly.
- Compatibility fallback: for `cbr`, `cb7`, `rar`, `7z` (and other non-cbz), pages are fetched via `/files` + `/page` and packed into a temporary CBZ in memory/disk workspace, then converted.
- No persistent `.xtc` storage: output is streamed to the client and temp data is deleted after stream close.

## Default conversion profile

The default profile matches `xtcjs` XTEink-focused settings:

- Split mode: `overlap` (overlapping thirds)
- Dithering: `Floyd-Steinberg`
- Contrast: `4`
- Margin crop: `0`

## Requirements

- Bun 1.1+ or Node 20+
- Python 3.9+
- `cbz2xtc.py` ([tazua/cbz2xtc](https://github.com/tazua/cbz2xtc))
- `png2xtc.py` ([jonasdiemer/epub2xtc](https://github.com/jonasdiemer/epub2xtc))

## Upstream Tool Sources

This repository vendors the minimum required conversion scripts under `tools/`:

- `tools/cbz2xtc/cbz2xtc.py` from [tazua/cbz2xtc](https://github.com/tazua/cbz2xtc)
- `tools/epub2xtc/png2xtc.py` from [jonasdiemer/epub2xtc](https://github.com/jonasdiemer/epub2xtc)

The Docker image and runtime conversion flow rely on these two scripts being present in-repo.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure server env

```bash
cp apps/server/.env.example apps/server/.env
```

Update values in `apps/server/.env`:

- `LANRARAGI_BASE_URL` (example: `http://localhost:3001`)
- `LANRARAGI_API_KEY` (if your server requires one)
- `XTEINK_BASE_URL` (example: `http://xteink.local`)
- `CBZ2XTC_PATH`
- `PNG2XTC_PATH`

Optional frontend env:

```bash
cp apps/web/.env.example apps/web/.env
```

### 3. Run dev

```bash
bun run dev
```

- API: `http://localhost:3000`
- UI: `http://localhost:5173`
- OPDS: `http://localhost:3000/opds`

## API endpoints

- `GET /api/health`
- `GET /api/settings/defaults`
- `GET /api/archives?q=&start=&sortby=&order=`
- `GET /api/archives/:id`
- `GET /api/archives/:id/thumbnail`
- `POST /api/convert/:id`
- `GET /opds`
- `GET /opds/download/:id.xtc`

## Validation performed

- Workspace typecheck/build passed.
- Live LANraragi connectivity validated in a local network test setup.
- Real conversion test succeeded with temporary artifacts removed after completion.
