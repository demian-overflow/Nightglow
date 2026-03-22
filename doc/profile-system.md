# Profile & Browser Data Management System

## Overview

Three systems manage browser profiles: **WebProfileManager** (Python/FastAPI), **SmilingFriend** (TypeScript), and **Nightglow** (Rust). This design unifies them — WPM becomes the single authority. Others call it.

---

## Data Model

```mermaid
erDiagram
    profiles {
        uuid id PK
        string name
        string description
        string preset
        enum status "active|archived"
        string user_agent
        enum platform "Win32|MacIntel|Linux x86_64"
        string app_version
        string language
        string accept_language
        string timezone
        int timezone_offset
        int screen_width
        int screen_height
        int screen_avail_width
        int screen_avail_height
        int inner_width
        int inner_height
        int outer_width
        int outer_height
        float device_pixel_ratio
        int hardware_concurrency
        float device_memory
        int max_touch_points
        bigint canvas_noise_seed
        bigint audio_noise_seed
        string webgl_vendor
        string webgl_renderer
        string webgl_unmasked_vendor
        string webgl_unmasked_renderer
        bool hide_webdriver
        enum proxy_type "none|http|socks5"
        string proxy_host
        int proxy_port
        float geo_latitude
        float geo_longitude
        float traj_jitter
        float traj_bias
        int traj_steps
        int timing_base_delay
        int timing_burst_delay
        float timing_rhythmicity
        int typing_char_delay
        float scroll_speed
    }

    profile_extras {
        uuid profile_id PK FK
        jsonb plugins
        jsonb fonts
        jsonb client_hints
        jsonb webgl_params
    }

    profile_instances {
        uuid id PK
        uuid profile_id FK
        string domain
        enum lifecycle_status "fresh|warming|active|worn|burned|retired"
        jsonb lifecycle_metadata
        int use_count
        timestamp last_used_at
        timestamp burned_at
        string burn_reason
    }

    profile_browser_states {
        uuid id PK
        uuid profile_id FK
        string domain
        jsonb cookies
        jsonb local_storage
        timestamp last_updated_at
    }

    profile_acquisitions {
        uuid id PK
        uuid profile_id FK
        uuid profile_instance_id FK
        uuid resource_tree_id FK
        string worker_id
        string session_id
        timestamp acquired_at
        timestamp expires_at
        timestamp released_at
        string release_reason
    }

    resource_trees {
        uuid id PK
        string name
        string primary_domain
        int max_concurrent
    }

    resource_tree_domains {
        uuid resource_tree_id FK
        string domain
    }

    resource_tree_tracker_exposure {
        uuid id PK
        uuid profile_id FK
        uuid resource_tree_id FK
        string tracker_origin
        enum resource_type "analytics|advertising|fingerprinting|social_media|cdn|other"
        timestamp first_seen_at
        timestamp last_seen_at
    }

    profiles ||--o| profile_extras : "side-car"
    profiles ||--o{ profile_instances : "per domain"
    profiles ||--o{ profile_browser_states : "per domain"
    profiles ||--o{ resource_tree_tracker_exposure : "exposure log"
    profiles ||--o{ profile_acquisitions : "sessions"
    profile_instances ||--o{ profile_acquisitions : "tracks"
    resource_trees ||--o{ resource_tree_domains : "contains"
    resource_trees ||--o{ profile_acquisitions : "scopes"
    resource_trees ||--o{ resource_tree_tracker_exposure : "observed in"
```

---

## Component Architecture

```mermaid
graph TD
    AdminUI["AdminUI\n(React SPA)"]
    WPM["WebProfileManager\n(Python / FastAPI)"]
    SF["SmilingFriend\n(TypeScript / Puppeteer)"]
    NG["Nightglow\n(Rust / Servo)"]
    PG["ProfileGenerator\n(presets → coherent profiles)"]
    PS["ProfileSelector\n(lifecycle + tracker safety)"]
    AE["AcquisitionEngine\n(acquire / release)"]
    DB["PostgreSQL\n(unified schema)"]
    Kafka["Kafka\n(profile events)"]

    AdminUI -->|CRUD| WPM
    WPM --> PG
    WPM --> AE
    AE --> PS
    PS --> DB
    AE --> DB
    AE -->|events| Kafka

    SF -->|POST /profiles/acquire| WPM
    WPM -->|profile JSON + cookies| SF
    SF -->|--nightglow-profile JSON| NG
    SF -->|restore cookies via WebDriver JS| NG
    NG -->|GET /nightglow/resource-events| SF
    SF -->|POST /profiles/release + tracker_events| WPM
```

---

## Profile Lifecycle

```mermaid
stateDiagram-v2
    [*] --> fresh : generate()

    fresh --> warming : first acquire\nuse_count = 1

    warming --> active : use_count > 3\n(warming_threshold)

    active --> worn : use_count > 50\nOR age > 30 days

    worn --> burned : use_count > 200\nOR tracker feedback\nOR explicit burn signal

    active --> burned : fingerprinting tracker seen\nOR captcha / login blocked\nOR explicit burn signal

    burned --> retired : manual admin action\nOR GC policy

    retired --> [*]

    note right of fresh : No tracker exposure\nBrowser state empty
    note right of warming : Cookies building up\nDeprioritized in pool
    note right of active : Normal operation\nFull browser state
    note right of worn : Deprioritized\nStill usable
    note right of burned : Never acquired again\nState preserved for audit
```

---

## Acquire → Inject → Release Flow

```mermaid
sequenceDiagram
    participant Worker as Worker / SmilingFriend
    participant WPM as WebProfileManager
    participant NG as Nightglow

    Worker->>WPM: POST /profiles/acquire\n{domain, resource_tree_id, worker_id}
    Note over WPM: ProfileSelector:\n- filter lifecycle=active\n- check tracker safety\n- enforce RT concurrency\n- SELECT FOR UPDATE
    WPM->>Worker: {acquisition_id, profile_nightglow_json,\nbrowser_state: {cookies, local_storage}}

    Worker->>NG: spawn container\n--nightglow-profile '{...}'
    Worker->>NG: restore cookies + localStorage\nvia WebDriver JS execution

    Note over NG: automation runs\nResourceTree builds in memory

    Worker->>NG: GET /nightglow/resource-events
    NG->>Worker: [{url, resource_type}, ...]

    Worker->>NG: extract cookies + localStorage\nvia WebDriver JS
    NG->>Worker: {cookies, local_storage}

    Worker->>WPM: POST /profiles/release/{acquisition_id}\n{browser_state_delta, tracker_events, release_reason}
    Note over WPM: UPSERT browser_state\nINSERT tracker exposure rows\nEvaluate lifecycle transition
    WPM->>Worker: {released_at, new_lifecycle_status}
```

---

## Tracker Feedback Loop

```mermaid
flowchart TD
    Session["Session ends"]
    Extract["SmilingFriend extracts\ntracker events from Nightglow\nGET /nightglow/resource-events"]
    Release["POST /profiles/release\n+ tracker_events"]
    Upsert["UPSERT resource_tree_tracker_exposure\nupdate last_seen_at"]

    FPCheck{"fingerprinting\ntracker seen?\ne.g. fpjs.io"}
    BurnAuto["Auto-burn profile\nreason: fingerprinting_detected"]

    NextAcquire["Next acquire for domain"]
    OverlapCheck{"tracker overlap\nwith candidate profile\nin last 7 days?"}
    Skip["Skip candidate\ntry next profile"]
    Assign["Assign profile\nto session"]

    Session --> Extract
    Extract --> Release
    Release --> Upsert
    Upsert --> FPCheck
    FPCheck -->|yes| BurnAuto
    FPCheck -->|no| NextAcquire
    NextAcquire --> OverlapCheck
    OverlapCheck -->|yes| Skip
    OverlapCheck -->|no| Assign
    Skip --> OverlapCheck
```

---

## Profile Generation (Presets)

```mermaid
flowchart LR
    Preset["Preset\ne.g. chrome-win11-us-east"]

    subgraph Generator["ProfileGenerator"]
        UA["Sample UA string\nfrom version pool"]
        Screen["Sample screen resolution\nweighted pool\n1920x1080: 45%\n2560x1440: 25%\n1366x768: 20%\n2560x1600: 10%"]
        HW["Sample hardware\nconcurrency pool\nmemory pool"]
        TZ["Derive timezone_offset\nfrom IANA name\nvia zoneinfo"]
        Seeds["Generate noise seeds\nrandom u64 → signed BIGINT"]
        Fonts["OS-appropriate\nfont list"]
        Plugins["Browser-appropriate\nplugin list"]
        Perturb["Apply small\nrandom perturbations"]
    end

    subgraph Presets["Available Presets"]
        P1["chrome-win11-us-east"]
        P2["chrome-win11-us-west"]
        P3["chrome-win11-ru"]
        P4["chrome-win11-de"]
        P5["chrome-macos-us"]
        P6["firefox-win11-us"]
        P7["safari-macos-us"]
        P8["chrome-linux-us"]
    end

    Preset --> UA
    Preset --> Screen
    Preset --> HW
    Preset --> TZ
    Preset --> Seeds
    Preset --> Fonts
    Preset --> Plugins
    UA & Screen & HW & TZ & Seeds & Fonts & Plugins --> Perturb
    Perturb --> Profile["Coherent BrowserProfile\n(all 40+ fields consistent)"]
```

---

## Migration Phases

```mermaid
gantt
    title Migration Phases
    dateFormat  X
    axisFormat Phase %s

    section Phase 1 — WPM Schema
    Add unified profiles table columns     :p1a, 0, 1
    Add profile_instances table            :p1b, 0, 1
    Add profile_browser_states table       :p1c, 0, 1
    Add resource_tree_tracker_exposure     :p1d, 0, 1
    Keep old endpoints working             :p1e, 0, 1

    section Phase 2 — WPM Acquire/Release
    Enrich acquire response (nightglow JSON + cookies)  :p2a, 1, 2
    Accept tracker_events + browser_state on release    :p2b, 1, 2
    Add ProfileGenerator + preset endpoint              :p2c, 1, 2
    Lifecycle transitions on release                    :p2d, 1, 2

    section Phase 3 — SmilingFriend Switch
    acquireAndInjectProfile calls WPM HTTP              :p3a, 2, 3
    Release path sends browser_state + tracker_events   :p3b, 2, 3
    Local Drizzle profile tables retired                :p3c, 2, 3

    section Phase 4 — Nightglow Events
    Add GET /nightglow/resource-events endpoint         :p4a, 3, 4
    SmilingFriend polls at session end                  :p4b, 3, 4
```
