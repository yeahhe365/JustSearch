# JustSearch

<p align="center">
  <a href="./README.md">中文</a> | <a href="./README.en.md">English</a>
</p>

An autonomous AI deep-search agent powered by a self-hosted Chrome extension bridge, iterative task planning, deep web crawling, and cited multi-source synthesis.

## Overview

An autonomous AI deep-search agent powered by a self-hosted Chrome extension bridge, iterative task planning, deep web crawling, and cited multi-source synthesis. It drives your real, logged-in Chrome over a local WebSocket bridge — reusing your cookies/login state to bypass simple anti-bot defenses.

## Features

- Breaks search goals into iterative investigation steps.
- Drives your real Chrome via the browser bridge for deeper web access (login state reused, far fewer captchas than headless browsers).
- Synthesizes multi-source findings with citation traces.
- Provides Docker, helper scripts, and manual developer workflows.
- Multilingual UI: Chinese / English / follow-system, switchable in Settings → General without a reload.

## Quick Start

- Run `./run.sh` or `run.bat` to start the project.
- Load the self-hosted Chrome extension from `extension/` (see `extension/README.md`).
- For development, enter `backend` and install the Python dependencies from `backend/requirements.txt`.
- Docker users can use the included `Dockerfile` and `docker-compose.yml`.

## Configuration

- Configure model, search, and browser bridge settings through backend environment variables.
- When captcha or anti-bot checks appear, follow the captcha guidance in the Chinese README.

## Tech Stack

- Python (FastAPI)
- Self-hosted Chrome extension bridge (MV3 + `chrome.debugger` CDP)
- Docker

## Project Structure

- `backend`
- `extension`
- `tests`

## Contributing

Issues and pull requests are welcome. Before submitting changes, review the existing structure and keep contributions focused and verifiable.

---

## Related Community

- [Linux.do](https://linux.do/): an active Chinese tech community focused on AI, software development, resource sharing, and frontier technology discussions. Its vision is "a new ideal community", and its community culture emphasizes sincerity, friendliness, unity, and professionalism.

## License

License information is available in the repository `LICENSE` file.
