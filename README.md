# LANraragi XTC Bridge

Browse a LANraragi library and convert archives to XTC files for an XTEink X4 running compatible Crosspoint firmware. The web interface can download converted files or upload them to the reader. An OPDS catalog supports conversion on demand.

## How it works

A TypeScript/Hono server connects to LANraragi, serves a React web interface, and runs the bundled Python conversion scripts. By default it retrieves pages through LANraragi and builds a temporary CBZ. It can fall back to downloading ZIP/CBZ archives directly; other archive formats use page extraction.

The temporary archive is converted by `cbz2xtc.py` and `png2xtc.py`. Output is streamed to the browser, OPDS client, or device and cleaned up afterward. The bridge does not maintain a permanent XTC library.

The UI supports search, sorting, thumbnails, batch conversion, conversion previews, device uploads, and saved conversion defaults.

## Requirements

- A reachable LANraragi server and its API key if authentication is enabled.
- Docker Compose for container deployment.
- For local development: Bun, Node.js 20 or later for the `tsx` development server, Python 3.9 or later, and Pillow.
- For device upload: an XTEink reader with a compatible HTTP file-upload interface enabled and reachable from the bridge.

The repository pins Bun 1.2.0 for packaging. Conversion scripts are included under `tools/`.

## Docker setup

```sh
git clone https://github.com/ChronoStriker1/lanraragi-xtc-bridge.git
cd lanraragi-xtc-bridge
cp docker/server.env.example docker/server.env
```

Edit `docker/server.env` before starting. Replace the example LANraragi and device addresses with your own:

| Setting | Meaning |
| --- | --- |
| `SERVER_PUBLIC_URL` | Bridge URL reachable by your browser and reader, for example `http://bridge.local:3000` |
| `LANRARAGI_BASE_URL` | LANraragi base URL |
| `LANRARAGI_API_KEY` | LANraragi API key |
| `XTEINK_BASE_URL` | Reader's HTTP server URL |

Keep the container paths for `CBZ2XTC_PATH`, `PNG2XTC_PATH`, and `PYTHON_BIN` from the Docker example. A container's `localhost` refers to itself, so use reachable LAN addresses for separate services.

```sh
docker compose up -d --build
docker compose logs -f
```

Open the bridge at port 3000. The OPDS feed is at `http://bridge.local:3000/opds`, using your configured bridge hostname.

Compose stores device settings in `data/runtime`, logs in `data/logs`, and temporary conversion files in `data/tmp`. Change the host volume paths in `docker-compose.yml` if needed. Use `docker compose down` to stop the service.

## Use

1. Open the web interface and confirm the library loads.
2. Choose conversion settings and try one archive with **Convert and download XTC**.
3. Open the result on the reader and adjust settings for its display.
4. For direct transfers, configure the reader URL and destination, then use **Convert and upload to XTEink**.
5. For OPDS, add the bridge's `/opds` URL in the reader's catalog settings. Downloading an entry starts conversion.

Defaults use overlapping thirds, Floyd-Steinberg dithering, contrast 4, and no margin crop. Advanced settings expose additional converter options.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install Pillow==11.3.0
cp apps/server/.env.example apps/server/.env
```

Set your server and device addresses in `apps/server/.env`. Replace the temporary converter paths in that example with absolute paths inside your clone:

```dotenv
CBZ2XTC_PATH=/absolute/path/to/lanraragi-xtc-bridge/tools/cbz2xtc/cbz2xtc.py
PNG2XTC_PATH=/absolute/path/to/lanraragi-xtc-bridge/tools/epub2xtc/png2xtc.py
PYTHON_BIN=/absolute/path/to/lanraragi-xtc-bridge/.venv/bin/python
```

```sh
bun run dev
```

The development UI is at `http://localhost:5173`, the API at `http://localhost:3000`, and OPDS at `http://localhost:3000/opds`. Set `SERVER_PUBLIC_URL` to a LAN-reachable address if testing with a separate reader.

```sh
bun run typecheck
bun run build
```

## Troubleshooting

- Library unavailable: check `LANRARAGI_BASE_URL`, API key, and `/api/health`.
- Python or converter not found: verify the three local absolute paths above, or use the Docker-specific paths inside the container.
- Pillow missing: install it into the interpreter selected by `PYTHON_BIN`.
- OPDS links use the wrong host: correct `SERVER_PUBLIC_URL` and restart the server.
- Upload fails: check that the reader's HTTP server is enabled and reachable from the bridge.
- Incomplete pages: inspect the backend log and LANraragi's extraction results. `USE_LRR_PAGE_EXTRACTION=true` is the default; disabling it makes ZIP/CBZ downloads the first choice.

Keep the bridge on a trusted network. Its routes expose library access and device operations; the LANraragi API key does not add authentication to the bridge itself.

## Converter credits

- [tazua/cbz2xtc](https://github.com/tazua/cbz2xtc), vendored in `tools/cbz2xtc/`.
- [jonasdiemer/epub2xtc](https://github.com/jonasdiemer/epub2xtc), with `png2xtc.py` vendored in `tools/epub2xtc/`.
