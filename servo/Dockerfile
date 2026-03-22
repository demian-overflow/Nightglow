# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: build environment
# ──────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_VERSION=1.92.0

# System dependencies (from python/servo/platform/linux_packages/apt/)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    ccache \
    clang \
    cmake \
    curl \
    g++ \
    git \
    gperf \
    libdbus-1-dev \
    libfreetype6-dev \
    libgl1-mesa-dri \
    libgles2-mesa-dev \
    libglib2.0-dev \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-plugins-base \
    libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-libav \
    libgstrtspserver-1.0-dev \
    gstreamer1.0-tools \
    libges-1.0-dev \
    libharfbuzz-dev \
    liblzma-dev \
    libudev-dev \
    libunwind-dev \
    libvulkan1 \
    libx11-dev \
    libxcb-render0-dev \
    libxcb-shape0-dev \
    libxcb-xfixes0-dev \
    libxmu-dev \
    libxmu6 \
    libegl1-mesa-dev \
    llvm-dev \
    m4 \
    xorg-dev \
    libxkbcommon0 \
    libxkbcommon-x11-0 \
    libgstreamer-plugins-good1.0-dev \
    python3 \
    python3-pip \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain
RUN curl https://sh.rustup.rs -sSf | sh -s -- \
        --default-toolchain ${RUST_VERSION} -y \
        --component clippy,llvm-tools,llvm-tools-preview,rustc-dev,rustfmt,rust-src \
    && rustup --version && cargo --version && rustc --version

# Install uv for Python tooling
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /build
COPY . .

# Build in release mode (headless/offscreen rendering target)
RUN cargo build --release -p servoshell 2>&1 | tail -20

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime image
# ──────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libdbus-1-3 \
    libfreetype6 \
    libgl1 \
    libglib2.0-0 \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-base \
    gstreamer1.0-libav \
    libgstreamer1.0-0 \
    libharfbuzz0b \
    liblzma5 \
    libunwind8 \
    libvulkan1 \
    libx11-6 \
    libxcb1 \
    libxkbcommon0 \
    libxkbcommon-x11-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/servoshell /app/nightglow
COPY --from=builder /build/resources /app/resources

ENV SERVO_RESOURCES_PATH=/app/resources

EXPOSE 7000
ENTRYPOINT ["/app/nightglow"]
CMD ["--headless", "--webdriver", "7000", "about:blank"]
