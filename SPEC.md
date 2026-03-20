# NightGlow - Cloud-first stealth browser for scraping and browser automation
The system should have extensive telemetry capabilities (otel, logging, monitoring, alerting) configured through CRDs. There should be explicit browser profiles management (every possible fingerprint metric, including but not limited to: user agent, screen resolution, timezone, language, plugins, fonts, and more). Built-in acquire mechanism for browser profiles against a resource tree (built from requests any given website makes like google/facebook analytics) to avoid concurrent requests with the same fingerprint.
```mermaid
graph TD
    subgraph NightGlow[NightGlow System]
        A[Browser Automation Engine] -->|Uses| B[Browser Profiles Management]
        A -->|Emits| C[Telemetry Layer]
        B -->|Acquires| D[Browser Profile Resource Tree]
        D -->|Built from| E[Website Request Analysis]
        C -->|Configures| F[CRDs: OTel, Logging, Monitoring, Alerting]
        B -->|Manages| G[Fingerprint Metrics]
        G -->|Includes| H[User Agent]
        G -->|Includes| I[Screen Resolution]
        G -->|Includes| J[Timezone]
        G -->|Includes| K[Language]
        G -->|Includes| L[Plugins]
        G -->|Includes| M[Fonts]
        G -->|...| N[Other Metrics]
        D -->|Avoids| O[Concurrent Requests with Same Fingerprint]
    end

    style NightGlow fill:#f9f,stroke:#333
```
