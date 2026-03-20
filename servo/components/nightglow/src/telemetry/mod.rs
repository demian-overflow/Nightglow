/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! OpenTelemetry instrumentation for NightGlow.
//!
//! Call [`Telemetry::init`] once at startup.  Then use the returned
//! [`Telemetry`] handle to record metrics about profile usage, request
//! outcomes, and fingerprint events.

use opentelemetry::metrics::{Counter, Histogram, Meter, UpDownCounter};
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::{runtime, Resource};
use opentelemetry_semantic_conventions::resource::SERVICE_NAME;

/// Central telemetry handle.
pub struct Telemetry {
    /// Number of profiles successfully acquired from the pool.
    pub profiles_acquired: Counter<u64>,
    /// Number of acquire attempts that had to wait (pool exhausted).
    pub pool_wait_total: Counter<u64>,
    /// Currently in-use profiles.
    pub profiles_in_use: UpDownCounter<i64>,
    /// Time (ms) from acquire call to profile becoming available.
    pub acquire_latency_ms: Histogram<f64>,
    /// Number of resource-tree entries recorded.
    pub resource_events: Counter<u64>,
    /// Number of page navigations initiated.
    pub navigations_total: Counter<u64>,
}

impl Telemetry {
    /// Initialise OTel with an OTLP gRPC exporter pointing at `endpoint`
    /// (e.g. `"http://otel-collector.monitoring:4317"`).
    ///
    /// Returns the handle and installs a global meter provider.
    pub fn init(endpoint: &str, service_name: &str) -> anyhow::Result<Self> {
        let resource = Resource::new(vec![KeyValue::new(SERVICE_NAME, service_name.to_owned())]);

        let exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()?;

        let reader = PeriodicReader::builder(exporter, runtime::Tokio).build();

        let provider = SdkMeterProvider::builder()
            .with_resource(resource)
            .with_reader(reader)
            .build();

        opentelemetry::global::set_meter_provider(provider);

        let meter = opentelemetry::global::meter("nightglow");
        Ok(Self::from_meter(&meter))
    }

    fn from_meter(meter: &Meter) -> Self {
        Self {
            profiles_acquired: meter
                .u64_counter("nightglow.profiles.acquired")
                .with_description("Total profiles successfully acquired from the pool")
                .build(),
            pool_wait_total: meter
                .u64_counter("nightglow.pool.wait_total")
                .with_description("Acquire calls that blocked waiting for a free profile")
                .build(),
            profiles_in_use: meter
                .i64_up_down_counter("nightglow.profiles.in_use")
                .with_description("Number of profiles currently held by active sessions")
                .build(),
            acquire_latency_ms: meter
                .f64_histogram("nightglow.pool.acquire_latency_ms")
                .with_description("Time in ms from acquire() call to profile becoming available")
                .with_unit("ms")
                .build(),
            resource_events: meter
                .u64_counter("nightglow.resource_tree.events")
                .with_description("Third-party resource requests recorded in the resource tree")
                .build(),
            navigations_total: meter
                .u64_counter("nightglow.navigations.total")
                .with_description("Page navigations initiated by the automation engine")
                .build(),
        }
    }

    // ── Convenience helpers ────────────────────────────────────────────────────

    pub fn record_acquired(&self, profile_label: &str) {
        self.profiles_acquired
            .add(1, &[KeyValue::new("profile", profile_label.to_owned())]);
        self.profiles_in_use
            .add(1, &[KeyValue::new("profile", profile_label.to_owned())]);
    }

    pub fn record_released(&self, profile_label: &str) {
        self.profiles_in_use
            .add(-1, &[KeyValue::new("profile", profile_label.to_owned())]);
    }

    pub fn record_navigation(&self, url: &str) {
        self.navigations_total
            .add(1, &[KeyValue::new("url", url.to_owned())]);
    }

    pub fn record_resource_event(&self, resource_type: &str) {
        self.resource_events
            .add(1, &[KeyValue::new("type", resource_type.to_owned())]);
    }
}
