//! `screen_capture`, `screen_stream`, and `screen_input` RPCs: single frame,
//! live push stream, and remote tap input of an app the agent launched on this
//! machine, for the client's `agentdeck-screen` block and live view.
//!
//! Targets:
//! - `ios:<udid|booted>`: iOS Simulator via `simctl` (`ios.rs`). Its alpha mask
//!   carries the exact screen shape (corners, Dynamic Island).
//! - `android:<serial>`: device or emulator via `adb` (`android.rs`). The shape
//!   comes from `dumpsys display` when the system reports it; taps use `adb
//!   shell input tap`.
//! - `browser:<tabId>`: browser tab via the browser4agent extension's local MCP
//!   service (`browser.rs`); `mobile` marks a tab under DevTools device
//!   emulation; taps use CDP `Input.dispatchMouseEvent`.
//!
//! Every result reports the native `width` / `height` and a `frame` the client
//! draws around the picture; the picture itself is a JPEG at most `maxWidth`
//! wide. Shape geometry is in native pixels.

mod android;
mod browser;
mod ios;

use std::{
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    io::Cursor,
    process::Output,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

pub use browser::browser_has_tab;
use image::{
    ImageFormat, ImageReader, RgbImage,
    codecs::jpeg::JpegEncoder,
    imageops::{self, FilterType},
};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_WIDTH: u32 = 800;
const JPEG_QUALITY: u8 = 80;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RawPixelFormat {
    Rgba8888,
    Rgbx8888,
    Rgb888,
    Bgra8888,
}

impl RawPixelFormat {
    fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Rgb888 => 3,
            Self::Rgba8888 | Self::Rgbx8888 | Self::Bgra8888 => 4,
        }
    }
}

enum Captured {
    IosPng(Vec<u8>, RgbImage, Value),
    Frame(Vec<u8>, Value, ImageFormat),
    RawPixels {
        bytes: Vec<u8>,
        offset: usize,
        width: u32,
        height: u32,
        format: RawPixelFormat,
        frame: Value,
    },
}

impl Captured {
    fn raw_bytes(&self) -> &[u8] {
        match self {
            Captured::IosPng(bytes, _, _) => bytes,
            Captured::Frame(bytes, _, _) => bytes,
            Captured::RawPixels { bytes, offset, .. } => &bytes[*offset..],
        }
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn process_captured(captured: Captured, max_width: u32) -> Result<(Value, Vec<u8>), String> {
    match captured {
        Captured::IosPng(_raw, image, frame) => {
            let (width, height) = (image.width(), image.height());
            let jpeg = encode_jpeg(image, max_width)?;
            Ok((
                json!({ "width": width, "height": height, "frame": frame }),
                jpeg,
            ))
        }
        Captured::Frame(bytes, frame, ImageFormat::Jpeg) => {
            let (width, height) = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Jpeg)
                .into_dimensions()
                .map_err(|err| format!("Failed to read JPEG dimensions: {err}"))?;
            if width <= max_width {
                return Ok((
                    json!({ "width": width, "height": height, "frame": frame }),
                    bytes,
                ));
            }
            let image = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
                .map_err(|err| format!("Failed to decode screenshot: {err}"))?
                .into_rgb8();
            let jpeg = encode_jpeg(image, max_width)?;
            Ok((
                json!({ "width": width, "height": height, "frame": frame }),
                jpeg,
            ))
        }
        Captured::Frame(bytes, frame, format) => {
            let image = image::load_from_memory_with_format(&bytes, format)
                .map_err(|err| format!("Failed to decode screenshot: {err}"))?
                .into_rgb8();
            let (width, height) = (image.width(), image.height());
            let jpeg = encode_jpeg(image, max_width)?;
            Ok((
                json!({ "width": width, "height": height, "frame": frame }),
                jpeg,
            ))
        }
        Captured::RawPixels {
            bytes,
            offset,
            width,
            height,
            format,
            frame,
        } => {
            let jpeg = encode_raw_pixels_jpeg(&bytes[offset..], width, height, format, max_width)?;
            Ok((
                json!({ "width": width, "height": height, "frame": frame }),
                jpeg,
            ))
        }
    }
}

fn encode_raw_pixels_jpeg(
    pixels: &[u8],
    width: u32,
    height: u32,
    format: RawPixelFormat,
    max_width: u32,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("Raw screenshot has zero dimensions".to_string());
    }
    let bpp = format.bytes_per_pixel();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(bpp))
        .ok_or_else(|| "Raw screenshot dimensions overflow".to_string())?;
    if pixels.len() < expected {
        return Err("Truncated raw screenshot buffer".to_string());
    }

    let (out_w, out_h) = if width > max_width {
        let h = (height as u64 * max_width as u64 / width as u64) as u32;
        (max_width, h.max(1))
    } else {
        (width, height)
    };
    let src_w = width as usize;
    let src_h = height as usize;
    let dst_w = out_w as usize;
    let dst_h = out_h as usize;
    let sx_offsets: Vec<usize> = (0..dst_w).map(|x| (x * src_w / dst_w) * bpp).collect();

    let mut rgb = vec![0u8; dst_w * dst_h * 3];
    for y in 0..dst_h {
        let src_row = (y * src_h / dst_h) * src_w * bpp;
        let dst_row = y * dst_w * 3;
        for (x, &sx_off) in sx_offsets.iter().enumerate() {
            let s = src_row + sx_off;
            let d = dst_row + x * 3;
            match format {
                RawPixelFormat::Rgba8888 | RawPixelFormat::Rgbx8888 | RawPixelFormat::Rgb888 => {
                    rgb[d] = pixels[s];
                    rgb[d + 1] = pixels[s + 1];
                    rgb[d + 2] = pixels[s + 2];
                }
                RawPixelFormat::Bgra8888 => {
                    rgb[d] = pixels[s + 2];
                    rgb[d + 1] = pixels[s + 1];
                    rgb[d + 2] = pixels[s];
                }
            }
        }
    }

    let image = RgbImage::from_raw(out_w, out_h, rgb)
        .ok_or_else(|| "Failed to build RGB image from raw screenshot".to_string())?;
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&image)
        .map_err(|err| format!("Failed to encode screenshot: {err}"))?;
    Ok(jpeg)
}

fn encode_jpeg(image: RgbImage, max_width: u32) -> Result<Vec<u8>, String> {
    let image = if image.width() > max_width {
        let height = (image.height() as u64 * max_width as u64 / image.width() as u64) as u32;
        imageops::resize(&image, max_width, height.max(1), FilterType::Nearest)
    } else {
        image
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&image)
        .map_err(|err| format!("Failed to encode screenshot: {err}"))?;
    Ok(jpeg)
}

async fn run(command: &mut Command, name: &str) -> Result<Output, String> {
    let output = command
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|err| format!("Failed to run {name}: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{name} failed: {}", stderr.trim()));
    }
    Ok(output)
}

fn validate_ratio(name: &str, value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(format!("Invalid screen {name} coordinate: {value}"));
    }
    Ok(value)
}

fn normalized_to_pixel(ratio: f64, size: u32) -> u32 {
    if size == 0 {
        return 0;
    }
    let clamped = ratio.clamp(0.0, 1.0);
    ((clamped * (size as f64 - 1.0)).round() as u32).min(size - 1)
}

fn normalized_to_css(ratio: f64, size: f64) -> f64 {
    let clamped = ratio.clamp(0.0, 1.0);
    let max_coord = (size - 1.0).max(0.0);
    (clamped * size).min(max_coord)
}

enum ScreenTarget {
    Ios(String),
    Android(String),
    Browser(i64),
}

impl ScreenTarget {
    fn parse(target: &str) -> Result<Self, String> {
        let (kind, id) = target
            .trim()
            .split_once(':')
            .filter(|(kind, id)| ["ios", "android", "browser"].contains(kind) && !id.is_empty())
            .ok_or_else(|| format!("Unsupported screen target: {target}"))?;
        match kind {
            "ios" => Ok(Self::Ios(id.to_string())),
            "android" => Ok(Self::Android(id.to_string())),
            "browser" => {
                let tab_id = id
                    .parse()
                    .map_err(|_| format!("Invalid browser tab id: {id}"))?;
                Ok(Self::Browser(tab_id))
            }
            _ => unreachable!(),
        }
    }

    async fn connect(&self) -> Result<Box<dyn ScreenDriver>, String> {
        match self {
            Self::Ios(udid) => Ok(Box::new(ios::IosDriver::new(udid.clone()))),
            Self::Android(serial) => Ok(Box::new(android::AndroidDriver::new(serial.clone()))),
            Self::Browser(tab_id) => Ok(Box::new(browser::BrowserDriver::connect(*tab_id).await?)),
        }
    }
}

trait ScreenDriver: Send {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>;
    fn browser_peer(&self) -> Option<browser::BrowserPeer> {
        None
    }
    fn detach_cdp(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
    fn close(&mut self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

async fn capture_raw(target: &str) -> Result<Captured, String> {
    let parsed = ScreenTarget::parse(target)?;
    let mut driver = parsed.connect().await?;
    let captured = tokio::time::timeout(CAPTURE_TIMEOUT, driver.capture())
        .await
        .map_err(|_| format!("Timed out capturing {target}"))
        .and_then(|res| res);
    driver.close().await;
    captured
}

pub async fn capture(
    target: &str,
    max_width: Option<u64>,
) -> Result<(Value, Option<Vec<u8>>), String> {
    let max_width = max_width
        .map(|width| width.clamp(160, 2000) as u32)
        .unwrap_or(DEFAULT_MAX_WIDTH);
    let captured = capture_raw(target).await?;
    tokio::task::spawn_blocking(move || {
        let (info, jpeg) = process_captured(captured, max_width)?;
        Ok((info, Some(jpeg)))
    })
    .await
    .map_err(|err| format!("Screen capture task failed: {err}"))?
}

struct StreamEntry {
    id: u64,
    token: CancellationToken,
    cdp_input: Arc<AtomicBool>,
    browser_peer: Option<browser::BrowserPeer>,
}

struct StreamEntryGuard {
    manager: ScreenStreamManager,
    peer_id: u64,
    target: String,
    stream_id: u64,
}

impl Drop for StreamEntryGuard {
    fn drop(&mut self) {
        self.manager
            .remove_if_matches(self.peer_id, &self.target, self.stream_id);
    }
}

/// Tracks active screen streams per `(peer_id, target)`, cancelling the
/// previous loop when a client starts a new stream, stops it, or disconnects.
#[derive(Clone, Default)]
pub struct ScreenStreamManager {
    streams: Arc<Mutex<HashMap<(u64, String), StreamEntry>>>,
    frame_sizes: Arc<Mutex<HashMap<String, (u32, u32)>>>,
    browser_viewports: Arc<Mutex<HashMap<String, ((u32, u32), (f64, f64))>>>,
    next_id: Arc<AtomicU64>,
}

impl ScreenStreamManager {
    fn register(
        &self,
        peer_id: u64,
        target: &str,
    ) -> (u64, CancellationToken, Arc<AtomicBool>, StreamEntryGuard) {
        let target = target.trim();
        let stream_id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let token = CancellationToken::new();
        let cdp_input = Arc::new(AtomicBool::new(false));
        {
            let mut streams = self.streams.lock().expect("lock poisoned");
            if let Some(old) = streams.insert(
                (peer_id, target.to_string()),
                StreamEntry {
                    id: stream_id,
                    token: token.clone(),
                    cdp_input: cdp_input.clone(),
                    browser_peer: None,
                },
            ) {
                old.token.cancel();
            }
        }
        let guard = StreamEntryGuard {
            manager: self.clone(),
            peer_id,
            target: target.to_string(),
            stream_id,
        };
        (stream_id, token, cdp_input, guard)
    }

    fn attach_browser_peer(
        &self,
        peer_id: u64,
        target: &str,
        stream_id: u64,
        browser_peer: browser::BrowserPeer,
    ) {
        let mut streams = self.streams.lock().expect("lock poisoned");
        let key = (peer_id, target.trim().to_string());
        if let Some(entry) = streams.get_mut(&key)
            && entry.id == stream_id
        {
            entry.browser_peer = Some(browser_peer);
        }
    }

    fn browser_stream(&self, target: &str) -> Option<(browser::BrowserPeer, bool)> {
        let target = target.trim();
        let streams = self.streams.lock().expect("lock poisoned");
        let mut peer = None;
        let mut cdp_attached = false;
        for ((_, t), entry) in streams.iter() {
            if t == target {
                if entry.cdp_input.load(Ordering::Relaxed) {
                    cdp_attached = true;
                }
                if peer.is_none()
                    && let Some(p) = &entry.browser_peer
                {
                    peer = Some(p.clone());
                }
            }
        }
        peer.map(|p| (p, cdp_attached))
    }

    fn remove_if_matches(&self, peer_id: u64, target: &str, stream_id: u64) {
        let mut streams = self.streams.lock().expect("lock poisoned");
        let key = (peer_id, target.trim().to_string());
        if streams.get(&key).is_some_and(|entry| entry.id == stream_id) {
            streams.remove(&key);
        }
    }

    fn has_other_stream(&self, peer_id: u64, target: &str, stream_id: u64) -> bool {
        let target = target.trim();
        self.streams
            .lock()
            .expect("lock poisoned")
            .iter()
            .any(|((pid, t), entry)| t == target && (*pid != peer_id || entry.id != stream_id))
    }

    fn mark_cdp_input(&self, target: &str) -> bool {
        let target = target.trim();
        let streams = self.streams.lock().expect("lock poisoned");
        let mut found = false;
        for ((_, t), entry) in streams.iter() {
            if t == target {
                entry.cdp_input.store(true, Ordering::Relaxed);
                found = true;
            }
        }
        found
    }

    fn record_frame_size(&self, target: &str, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.frame_sizes
                .lock()
                .expect("lock poisoned")
                .insert(target.trim().to_string(), (width, height));
        }
    }

    fn frame_size(&self, target: &str) -> Option<(u32, u32)> {
        self.frame_sizes
            .lock()
            .expect("lock poisoned")
            .get(target.trim())
            .copied()
    }

    fn cached_browser_viewport(&self, target: &str, frame_size: (u32, u32)) -> Option<(f64, f64)> {
        self.browser_viewports
            .lock()
            .expect("lock poisoned")
            .get(target.trim())
            .and_then(|(cached_frame, viewport)| (*cached_frame == frame_size).then_some(*viewport))
    }

    fn record_browser_viewport(&self, target: &str, frame_size: (u32, u32), viewport: (f64, f64)) {
        self.browser_viewports
            .lock()
            .expect("lock poisoned")
            .insert(target.trim().to_string(), (frame_size, viewport));
    }

    fn clear_browser_viewport(&self, target: &str) {
        self.browser_viewports
            .lock()
            .expect("lock poisoned")
            .remove(target.trim());
    }

    pub fn stop_stream(&self, peer_id: u64, target: &str) {
        if let Some(entry) = self
            .streams
            .lock()
            .expect("lock poisoned")
            .remove(&(peer_id, target.trim().to_string()))
        {
            entry.token.cancel();
        }
    }

    pub fn stop_peer(&self, peer_id: u64) {
        let mut streams = self.streams.lock().expect("lock poisoned");
        let keys: Vec<(u64, String)> = streams
            .keys()
            .filter(|(pid, _)| *pid == peer_id)
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = streams.remove(&key) {
                entry.token.cancel();
            }
        }
    }

    pub fn stop_all(&self) {
        let mut streams = self.streams.lock().expect("lock poisoned");
        for (_, entry) in streams.drain() {
            entry.token.cancel();
        }
    }

    pub async fn tap(&self, target: &str, x: f64, y: f64) -> Result<(), String> {
        let x = validate_ratio("x", x)?;
        let y = validate_ratio("y", y)?;
        let target_key = target.trim();
        match ScreenTarget::parse(target_key)? {
            ScreenTarget::Android(serial) => {
                let (width, height) = match self.frame_size(target_key) {
                    Some(size) => size,
                    None => {
                        let size =
                            tokio::time::timeout(INPUT_TIMEOUT, android::display_size(&serial))
                                .await
                                .map_err(|_| {
                                    format!("Timed out querying display size for {target_key}")
                                })??;
                        self.record_frame_size(target_key, size.0, size.1);
                        size
                    }
                };
                let px = normalized_to_pixel(x, width);
                let py = normalized_to_pixel(y, height);
                tokio::time::timeout(INPUT_TIMEOUT, android::tap(&serial, px, py))
                    .await
                    .map_err(|_| format!("Timed out sending tap to {target_key}"))?
            }
            ScreenTarget::Browser(tab_id) => {
                let (peer, temp_client, cdp_attached) = match self.browser_stream(target_key) {
                    Some((peer, cdp_attached)) => {
                        // Mark before dispatch so a concurrent stream shutdown
                        // still detaches CDP.
                        self.mark_cdp_input(target_key);
                        (peer, None, cdp_attached)
                    }
                    None => {
                        let client = browser::connect_browser4agent().await?;
                        let peer = client.peer().clone();
                        (peer, Some(client), false)
                    }
                };
                let frame_size = self.frame_size(target_key);
                let cached_viewport = if cdp_attached {
                    frame_size.and_then(|size| self.cached_browser_viewport(target_key, size))
                } else {
                    None
                };
                let result = tokio::time::timeout(
                    INPUT_TIMEOUT,
                    browser::tap(&peer, tab_id, x, y, cached_viewport),
                )
                .await
                .map_err(|_| format!("Timed out sending tap to {target_key}"))
                .and_then(|res| res);
                match &result {
                    Ok(viewport) => {
                        if let Some(size) = frame_size {
                            self.record_browser_viewport(target_key, size, *viewport);
                        }
                        if !self.mark_cdp_input(target_key) {
                            browser::detach_cdp(&peer, tab_id).await;
                            self.clear_browser_viewport(target_key);
                        }
                    }
                    Err(_) => {
                        self.clear_browser_viewport(target_key);
                    }
                }
                if let Some(client) = temp_client {
                    let _ = client.cancel().await;
                }
                result.map(|_| ())
            }
            ScreenTarget::Ios(_) => {
                Err("Tap input is not supported for iOS Simulator yet".to_string())
            }
        }
    }

    pub async fn start_stream(
        &self,
        peer_id: u64,
        target: &str,
        max_width: Option<u64>,
        ctx: crate::peer::CallCtx,
    ) -> Result<Value, String> {
        let max_width = max_width
            .map(|width| width.clamp(160, 2000) as u32)
            .unwrap_or(DEFAULT_MAX_WIDTH);
        let parsed_target = ScreenTarget::parse(target)?;

        // Register before `connect()` so a stop or disconnect arriving while
        // connecting cancels this stream immediately.
        let (stream_id, loop_token, cdp_input, _guard) = self.register(peer_id, target);
        let mut driver = tokio::select! {
            _ = loop_token.cancelled() => return Ok(json!({ "stopped": true })),
            res = parsed_target.connect() => res?,
        };
        if let Some(browser_peer) = driver.browser_peer() {
            self.attach_browser_peer(peer_id, target, stream_id, browser_peer);
        }

        let target_str = target.trim().to_string();
        let mut last_hash: Option<u64> = None;
        let mut last_emitted = tokio::time::Instant::now();
        let mut consecutive_errors = 0;
        let mut stream_error = None;

        while !loop_token.is_cancelled() {
            let frame_start = tokio::time::Instant::now();
            let capture_res = tokio::select! {
                _ = loop_token.cancelled() => break,
                res = tokio::time::timeout(CAPTURE_TIMEOUT, driver.capture()) => match res {
                    Ok(inner) => inner,
                    Err(_) => Err(format!("Timed out capturing {target_str}")),
                },
            };

            match capture_res {
                Ok(captured) => {
                    consecutive_errors = 0;
                    let current_hash = hash_bytes(captured.raw_bytes());
                    if last_hash == Some(current_hash) {
                        // Screen unchanged: zero-bandwidth static detection,
                        // with a periodic lightweight keepalive so the client's
                        // inactivity timer does not expire on idle screens.
                        if last_emitted.elapsed() >= KEEPALIVE_INTERVAL {
                            ctx.emit(json!({ "keepalive": true }));
                            last_emitted = tokio::time::Instant::now();
                        }
                        tokio::select! {
                            _ = loop_token.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                        }
                        continue;
                    }
                    last_hash = Some(current_hash);

                    let processed = tokio::select! {
                        _ = loop_token.cancelled() => break,
                        res = tokio::task::spawn_blocking(move || {
                            process_captured(captured, max_width)
                        }) => res,
                    };

                    if loop_token.is_cancelled() {
                        break;
                    }

                    match processed {
                        Ok(Ok((info, bytes))) => {
                            if let (Some(w), Some(h)) = (
                                info.get("width").and_then(Value::as_u64),
                                info.get("height").and_then(Value::as_u64),
                            ) {
                                self.record_frame_size(&target_str, w as u32, h as u32);
                            }
                            ctx.emit_with_bytes(info, bytes);
                            last_emitted = tokio::time::Instant::now();
                        }
                        Ok(Err(err)) => {
                            tracing::warn!(
                                "Failed to process screen frame for {target_str}: {err}"
                            );
                        }
                        Err(err) => {
                            tracing::warn!("Screen process task panicked for {target_str}: {err}");
                        }
                    }

                    // Pace active frames up to ~30 FPS without extra latency.
                    let elapsed = frame_start.elapsed();
                    let min_frame_duration = Duration::from_millis(33);
                    if elapsed < min_frame_duration {
                        tokio::select! {
                            _ = loop_token.cancelled() => break,
                            _ = tokio::time::sleep(min_frame_duration - elapsed) => {}
                        }
                    }
                }
                Err(err) => {
                    consecutive_errors += 1;
                    tracing::debug!("Screen capture error for {target_str}: {err}");
                    if consecutive_errors >= 5 {
                        stream_error = Some(err);
                        break;
                    }
                    tokio::select! {
                        _ = loop_token.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                    }
                }
            }
        }

        if !self.has_other_stream(peer_id, &target_str, stream_id) {
            self.clear_browser_viewport(&target_str);
            if cdp_input.load(Ordering::Relaxed) {
                driver.detach_cdp().await;
            }
        }
        driver.close().await;
        match stream_error {
            Some(err) => Err(err),
            None => Ok(json!({ "stopped": true })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_invalid_targets() {
        assert!(capture("ios:", None).await.is_err());
        assert!(capture("window:Safari", None).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_run_kills_the_child_process() {
        let pid_file = std::env::temp_dir().join(format!(
            "agentdeck-screen-capture-pid-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let pid = {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", "echo $$ > \"$1\"; exec sleep 60", "_"])
                .arg(&pid_file);
            let task = run(&mut command, "sleep");
            tokio::pin!(task);
            tokio::select! {
                result = &mut task => panic!("sleep exited unexpectedly: {result:?}"),
                pid = async {
                    loop {
                        if let Ok(content) = std::fs::read_to_string(&pid_file) {
                            let trimmed = content.trim();
                            if !trimmed.is_empty() {
                                return trimmed.to_string();
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } => pid,
            }
        };
        let _ = std::fs::remove_file(&pid_file);

        let mut alive = true;
        for _ in 0..50 {
            let status = Command::new("kill")
                .args(["-0", &pid])
                .output()
                .await
                .unwrap()
                .status;
            if !status.success() {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!alive, "child process {pid} survived after run was dropped");
    }

    #[test]
    fn hashes_detect_screen_changes() {
        let frame1 = b"screen_pixel_data_frame_1";
        let frame2 = b"screen_pixel_data_frame_1";
        let frame3 = b"screen_pixel_data_frame_2";
        assert_eq!(hash_bytes(frame1), hash_bytes(frame2));
        assert_ne!(hash_bytes(frame1), hash_bytes(frame3));
    }

    #[test]
    fn jpeg_within_max_width_passes_through_without_reencoding() {
        let image = RgbImage::from_pixel(32, 64, image::Rgb([12, 34, 56]));
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&image)
            .unwrap();
        let frame = json!({ "kind": "phone", "cornerRadius": 48 });

        let (info, output) = process_captured(
            Captured::Frame(jpeg.clone(), frame.clone(), ImageFormat::Jpeg),
            DEFAULT_MAX_WIDTH,
        )
        .unwrap();

        assert_eq!(info["width"], 32);
        assert_eq!(info["height"], 64);
        assert_eq!(info["frame"], frame);
        assert_eq!(output, jpeg);
    }

    #[test]
    fn jpeg_wider_than_max_width_is_resized() {
        let image = RgbImage::from_pixel(320, 160, image::Rgb([12, 34, 56]));
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&image)
            .unwrap();
        let frame = json!({ "kind": "browser", "title": "t", "url": "https://a", "mobile": false });

        let (info, output) =
            process_captured(Captured::Frame(jpeg, frame.clone(), ImageFormat::Jpeg), 160).unwrap();

        assert_eq!(info["width"], 320);
        assert_eq!(info["height"], 160);
        assert_eq!(info["frame"], frame);
        let (out_w, out_h) = ImageReader::with_format(Cursor::new(&output), ImageFormat::Jpeg)
            .into_dimensions()
            .unwrap();
        assert_eq!((out_w, out_h), (160, 80));
    }

    #[tokio::test]
    async fn screen_stream_manager_cancels_active_stream() {
        let manager = ScreenStreamManager::default();
        let (_id, token, _cdp, _guard) = manager.register(1, "test:target");

        assert!(!token.is_cancelled());
        manager.stop_stream(1, "test:target");
        assert!(token.is_cancelled());
        assert!(
            !manager
                .streams
                .lock()
                .unwrap()
                .contains_key(&(1, "test:target".to_string()))
        );
    }

    #[tokio::test]
    async fn replacing_stream_does_not_let_old_guard_cancel_new_stream() {
        let manager = ScreenStreamManager::default();
        let (_id_a, token_a, _cdp_a, guard_a) = manager.register(1, "test:target");
        let (_id_b, token_b, _cdp_b, _guard_b) = manager.register(1, "test:target");

        assert!(token_a.is_cancelled());
        assert!(!token_b.is_cancelled());

        drop(guard_a);

        assert!(!token_b.is_cancelled());
        assert!(
            manager
                .streams
                .lock()
                .unwrap()
                .contains_key(&(1, "test:target".to_string()))
        );
    }

    #[tokio::test]
    async fn stop_peer_and_stop_all_isolate_streams_by_peer() {
        let manager = ScreenStreamManager::default();
        let (_id1, token1, _c1, _g1) = manager.register(1, "ios:booted");
        let (_id2, token2, _c2, _g2) = manager.register(1, "browser:1");
        let (_id3, token3, _c3, _g3) = manager.register(2, "ios:booted");

        manager.stop_peer(1);
        assert!(token1.is_cancelled());
        assert!(token2.is_cancelled());
        assert!(!token3.is_cancelled());

        manager.stop_all();
        assert!(token3.is_cancelled());
        assert!(manager.streams.lock().unwrap().is_empty());
    }

    #[test]
    fn maps_normalized_coordinates_within_bounds() {
        assert_eq!(normalized_to_pixel(0.0, 1080), 0);
        assert_eq!(normalized_to_pixel(0.5, 1080), 540);
        assert_eq!(normalized_to_pixel(1.0, 1080), 1079);
        assert_eq!(normalized_to_pixel(0.5, 0), 0);

        assert_eq!(normalized_to_css(0.0, 390.0), 0.0);
        assert_eq!(normalized_to_css(0.5, 390.0), 195.0);
        assert_eq!(normalized_to_css(1.0, 390.0), 389.0);
    }

    #[tokio::test]
    async fn tap_validates_coordinates_and_rejects_ios() {
        let manager = ScreenStreamManager::default();
        assert!(manager.tap("android:emu", -0.1, 0.5).await.is_err());
        assert!(manager.tap("android:emu", 0.5, 1.1).await.is_err());
        assert!(manager.tap("android:emu", f64::NAN, 0.5).await.is_err());
        assert!(manager.tap("window:Safari", 0.5, 0.5).await.is_err());
        let err = manager.tap("ios:booted", 0.5, 0.5).await.unwrap_err();
        assert!(err.contains("iOS Simulator"));
    }

    #[tokio::test]
    async fn mark_cdp_input_and_other_stream_track_active_browser_streams() {
        let manager = ScreenStreamManager::default();
        assert!(!manager.mark_cdp_input("browser:7"));

        let (id1, _t1, cdp1, _g1) = manager.register(1, "browser:7");
        let (_id2, _t2, cdp2, _g2) = manager.register(2, "browser:7");
        assert!(manager.mark_cdp_input("browser:7"));
        assert!(cdp1.load(Ordering::Relaxed));
        assert!(cdp2.load(Ordering::Relaxed));
        assert!(manager.has_other_stream(1, "browser:7", id1));

        manager.stop_stream(2, "browser:7");
        assert!(!manager.has_other_stream(1, "browser:7", id1));
    }

    #[test]
    fn raw_pixels_downscales_and_encodes_jpeg() {
        let mut bytes = vec![0u8; 16 + 320 * 160 * 4];
        for px in bytes[16..].chunks_exact_mut(4) {
            px.copy_from_slice(&[20, 40, 200, 255]); // BGRA -> RGB (200, 40, 20)
        }
        let frame = json!({ "kind": "phone", "cornerRadius": 0 });
        let (info, jpeg) = process_captured(
            Captured::RawPixels {
                bytes,
                offset: 16,
                width: 320,
                height: 160,
                format: RawPixelFormat::Bgra8888,
                frame: frame.clone(),
            },
            160,
        )
        .unwrap();

        assert_eq!(info["width"], 320);
        assert_eq!(info["height"], 160);
        assert_eq!(info["frame"], frame);
        let decoded = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
            .unwrap()
            .into_rgb8();
        assert_eq!(decoded.dimensions(), (160, 80));
        let [r, g, b] = decoded.get_pixel(80, 40).0;
        assert!(
            r > 180 && g < 60 && b < 40,
            "unexpected pixel ({r}, {g}, {b})"
        );
    }

    #[test]
    fn browser_viewport_cache_invalidates_when_frame_size_changes() {
        let manager = ScreenStreamManager::default();
        manager.record_browser_viewport("browser:9", (1280, 720), (640.0, 360.0));
        assert_eq!(
            manager.cached_browser_viewport("browser:9", (1280, 720)),
            Some((640.0, 360.0))
        );
        assert_eq!(
            manager.cached_browser_viewport("browser:9", (800, 600)),
            None
        );
        manager.clear_browser_viewport("browser:9");
        assert_eq!(
            manager.cached_browser_viewport("browser:9", (1280, 720)),
            None
        );
    }
}
