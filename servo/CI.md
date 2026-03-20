# NightGlow / Servoshell — CI Pipeline

## Overview

```
build → test-unit → test-integration → cleanup
                                      ↑ (main only)
```

| Stage              | Job                  | Runs on        | Purpose                                      |
|--------------------|----------------------|----------------|----------------------------------------------|
| `build`            | `build`              | main/master    | Build Docker image, push to registry         |
| `test`             | `test-unit`          | every push     | `cargo test -p nightglow` inside builder     |
| `test`             | `test-integration`   | every push     | Spawn servoshell binary, drive via WebDriver |
| `cleanup`          | `cleanup`            | main/master    | Prune stale SHA-tagged images from registry  |

---

## Stages

### `build`
Builds the full `servoshell` binary in release mode inside Docker (multi-stage build).
Pushes two tags to `registry.noogoo.ch/orderout/nightglow`:
- `:latest`
- `:<short-sha>`

The `servoshell` binary is copied into the runtime image as `/app/nightglow`.
Cache is reused via `--cache-from :latest` to speed up Rust incremental builds.

Timeout: **3 hours** (Servo is a large codebase).

### `test-unit`
Runs inside a dedicated Rust builder image (not DinD).
Does **not** require the Docker build to complete first — runs in parallel against the source.

```bash
cargo test -p nightglow
```

Tests the NightGlow library: profile pool acquire/release, resource-tree classification,
telemetry metric registration.

### `test-integration`
Runs after `build` — uses the pushed image.
Spins up the container, launches `servoshell` in headless mode with WebDriver enabled, then
runs a Python test suite against it.

**Why WebDriver, not CDP?**
Servo does not implement the Chrome DevTools Protocol. It has its own W3C-compliant WebDriver
server (port 7000 by default). The test client uses the standard `POST /session` WebDriver
REST API — no Selenium dependency, plain `requests` calls.

**What gets tested:**
1. Browser starts and responds to WebDriver `/status`
2. New session can be created
3. Navigation to a URL succeeds (`GET /url`)
4. `document.title` is retrievable via script execution
5. Screenshot endpoint returns a valid PNG
6. The `navigator.webdriver` flag is `false` (stealth — NightGlow hides automation marker)
7. User-agent matches the profile injected via `--user-agent`

See [`tests/integration/`](tests/integration/) for the test scripts.

### `cleanup`
Deletes short-SHA image tags from the registry after a successful build.
Keeps `:latest` and any semver tags.
Runs with `allow_failure: true` — registry cleanup never blocks deployment.

---

## Local Reproduction

### Unit tests
```bash
cd servo
cargo test -p nightglow
```

### Integration tests (requires built binary)
```bash
# Build the image
docker build -t nightglow-local .

# Run the integration suite
docker run --rm nightglow-local /app/nightglow --headless --webdriver 7000 &
python3 tests/integration/webdriver_tests.py --url http://localhost:7000
```

Or run servoshell directly if you have a local build:
```bash
./target/release/servoshell --headless --webdriver 7000 about:blank &
python3 tests/integration/webdriver_tests.py
```

---

## Variables

| Variable               | Where set        | Description                              |
|------------------------|------------------|------------------------------------------|
| `CI_REGISTRY_USER`     | GitLab CI        | Registry login user                      |
| `CI_REGISTRY_PASSWORD` | GitLab CI        | Registry login password                  |
| `CI_REGISTRY_IMAGE`    | GitLab CI        | Full image path (`registry.noogoo.ch/…`) |
| `GITLAB_CLEANUP_TOKEN` | CI/CD secret var | Token for registry tag deletion API      |
| `WEBDRIVER_PORT`       | pipeline var     | Port for integration tests (default 7000)|

---

## Adding Tests

- **Unit:** add `#[test]` / `#[tokio::test]` inside `components/nightglow/src/`
- **Integration:** add a test function to `tests/integration/webdriver_tests.py`
  following the existing pattern (each test is a method on `WebDriverSession`)
