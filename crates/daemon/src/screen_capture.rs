//! `screen_capture` RPC: one frame of an app the agent launched on this
//! machine, for the client's `agentdeck-screen` block. The client polls frame
//! by frame, so nothing here keeps state between calls.
//!
//! Targets:
//! - `ios:<udid|booted>`: iOS Simulator via `simctl`. Its alpha mask carries
//!   the exact screen shape (corners, Dynamic Island).
//! - `android:<serial>`: device or emulator via `adb`. The shape comes from
//!   `dumpsys display` when the system reports it.
//! - `browser:<tabId>`: browser tab via the browser4agent extension's local MCP
//!   service; `mobile` marks a tab under DevTools device emulation.
//!
//! Every result reports the native `width` / `height` and a `frame` the client
//! draws around the picture; the picture itself is a JPEG at most `maxWidth`
//! wide. Shape geometry is in native pixels.

use std::{
    collections::HashMap,
    env,
    hash::{DefaultHasher, Hash, Hasher},
    path::PathBuf,
    process::Output,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageFormat, RgbImage,
    codecs::jpeg::JpegEncoder,
    imageops::{self, FilterType},
};
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResult, ClientConfig},
    service::{RoleClient, RunningService},
    transport::StreamableHttpClientTransport,
};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_WIDTH: u32 = 800;
const JPEG_QUALITY: u8 = 80;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const BROWSER4AGENT_MCP_URL: &str = "http://127.0.0.1:39271/mcp";

enum Captured {
    Ios(Vec<u8>),
    Frame(Vec<u8>, Value, ImageFormat),
}

impl Captured {
    fn raw_bytes(&self) -> &[u8] {
        match self {
            Captured::Ios(bytes) => bytes,
            Captured::Frame(bytes, _, _) => bytes,
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
        Captured::Ios(png) => {
            let (image, frame) = decode_ios_png(&png)?;
            let (width, height) = (image.width(), image.height());
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
    }
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
            Self::Ios(udid) => Ok(Box::new(IosDriver {
                udid: udid.clone(),
                frame: None,
            })),
            Self::Android(serial) => Ok(Box::new(AndroidDriver {
                serial: serial.clone(),
            })),
            Self::Browser(tab_id) => {
                let client = connect_browser4agent().await?;
                let tab = find_tab(&client, *tab_id)
                    .await?
                    .ok_or_else(|| format!("Browser tab {tab_id} is closed"))?;
                let frame = json!({
                    "kind": "browser",
                    "title": tab.get("title").cloned().unwrap_or_default(),
                    "url": tab.get("url").cloned().unwrap_or_default(),
                    "mobile": tab_is_mobile(&client, *tab_id).await,
                });
                Ok(Box::new(BrowserDriver {
                    client: Some(client),
                    tab_id: *tab_id,
                    frame,
                }))
            }
        }
    }
}

trait ScreenDriver: Send {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>;
    fn close(&mut self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

struct IosDriver {
    udid: String,
    frame: Option<Value>,
}

impl ScreenDriver for IosDriver {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>
    {
        Box::pin(async move {
            if let Some(frame) = &self.frame {
                return capture_ios_jpeg(&self.udid, frame.clone()).await;
            }

            let captured = capture_ios(&self.udid).await?;
            let Captured::Ios(png) = &captured else {
                unreachable!("the initial iOS capture is a PNG")
            };
            let (_, frame) = decode_ios_png(png)?;
            self.frame = Some(frame);
            Ok(captured)
        })
    }
}

struct AndroidDriver {
    serial: String,
}

impl ScreenDriver for AndroidDriver {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>
    {
        Box::pin(capture_android(&self.serial))
    }
}

struct BrowserDriver {
    client: Option<RunningService<RoleClient, ClientConfig>>,
    tab_id: i64,
    frame: Value,
}

impl ScreenDriver for BrowserDriver {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>
    {
        let Some(client) = &self.client else {
            return Box::pin(async { Err("Browser service already closed".to_string()) });
        };
        Box::pin(capture_browser_fast(
            client,
            self.tab_id,
            self.frame.clone(),
        ))
    }

    fn close(&mut self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let client = self.client.take();
        Box::pin(async move {
            if let Some(client) = client {
                let _ = client.cancel().await;
            }
        })
    }
}

async fn capture_raw(target: &str) -> Result<Captured, String> {
    let target = ScreenTarget::parse(target)?;
    let mut driver = target.connect().await?;
    let captured = tokio::time::timeout(CAPTURE_TIMEOUT, driver.capture())
        .await
        .map_err(|_| format!("Timed out capturing target"))??;
    driver.close().await;
    Ok(captured)
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

/// Tracks active screen streams, cancelling the previous loop when a client
/// starts a new stream or disconnects.
#[derive(Clone, Default)]
pub struct ScreenStreamManager {
    streams: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl ScreenStreamManager {
    pub fn stop_stream(&self, target: &str) {
        if let Some(token) = self.streams.lock().expect("lock poisoned").remove(target) {
            token.cancel();
        }
    }

    pub async fn start_stream(
        &self,
        target: &str,
        max_width: Option<u64>,
        ctx: crate::peer::CallCtx,
    ) -> Result<Value, String> {
        let max_width = max_width
            .map(|width| width.clamp(160, 2000) as u32)
            .unwrap_or(DEFAULT_MAX_WIDTH);
        let parsed_target = ScreenTarget::parse(target)?;
        let mut driver = parsed_target.connect().await?;

        let token = CancellationToken::new();
        {
            let mut streams = self.streams.lock().expect("lock poisoned");
            if let Some(old) = streams.insert(target.to_string(), token.clone()) {
                old.cancel();
            }
        }

        let target_str = target.to_string();
        let loop_token = token.clone();
        let loop_mgr = self.clone();

        let mut last_hash: Option<u64> = None;
        let mut consecutive_errors = 0;

        while !loop_token.is_cancelled() {
            let frame_start = tokio::time::Instant::now();
            tokio::select! {
                _ = loop_token.cancelled() => break,
                res = tokio::time::timeout(CAPTURE_TIMEOUT, driver.capture()) => {
                    let res = match res {
                        Ok(inner) => inner,
                        Err(_) => Err(format!("Timed out capturing {target_str}")),
                    };
                    match res {
                        Ok(captured) => {
                            consecutive_errors = 0;
                            let current_hash = hash_bytes(captured.raw_bytes());
                            if last_hash == Some(current_hash) {
                                // Screen unchanged: zero-bandwidth static detection.
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                continue;
                            }
                            last_hash = Some(current_hash);

                            let processed = tokio::task::spawn_blocking(move || {
                                process_captured(captured, max_width)
                            })
                            .await;

                            match processed {
                                Ok(Ok((info, bytes))) => {
                                    ctx.emit_with_bytes(info, bytes);
                                }
                                Ok(Err(err)) => {
                                    tracing::warn!("Failed to process screen frame for {target_str}: {err}");
                                }
                                Err(err) => {
                                    tracing::warn!("Screen process task panicked for {target_str}: {err}");
                                }
                            }
                            // Pace active frames up to ~30 FPS without extra latency
                            let elapsed = frame_start.elapsed();
                            let min_frame_duration = Duration::from_millis(33);
                            if elapsed < min_frame_duration {
                                tokio::time::sleep(min_frame_duration - elapsed).await;
                            }
                        }
                        Err(err) => {
                            consecutive_errors += 1;
                            tracing::debug!("Screen capture error for {target_str}: {err}");
                            if consecutive_errors >= 5 {
                                driver.close().await;
                                loop_mgr.stop_stream(&target_str);
                                return Err(err);
                            }
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            }
        }

        driver.close().await;
        loop_mgr.stop_stream(&target_str);
        Ok(json!({ "stopped": true }))
    }
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

fn decode_png(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|err| format!("Failed to decode screenshot: {err}"))
}

fn decode_ios_png(bytes: &[u8]) -> Result<(RgbImage, Value), String> {
    let image = decode_png(bytes)?.into_rgba8();
    let corner_radius = alpha_corner_radius(&image);
    // simctl premultiplies the mask, so dropping alpha leaves the masked
    // corners and Dynamic Island black.
    let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
    Ok((
        rgb,
        json!({ "kind": "phone", "cornerRadius": corner_radius }),
    ))
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

static SIMCTL_PATH: tokio::sync::OnceCell<PathBuf> = tokio::sync::OnceCell::const_new();

async fn simctl_path() -> Result<&'static PathBuf, String> {
    SIMCTL_PATH
        .get_or_try_init(|| async {
            let output = Command::new("/usr/bin/xcrun")
                .args(["--find", "simctl"])
                .output()
                .await
                .map_err(|err| format!("Failed to locate simctl: {err}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to locate simctl: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            let path = String::from_utf8(output.stdout)
                .map_err(|err| format!("Invalid simctl path: {err}"))?;
            let path = PathBuf::from(path.trim());
            if !path.is_absolute() {
                return Err(format!("Invalid simctl path: {}", path.display()));
            }
            Ok(path)
        })
        .await
}

async fn capture_ios(udid: &str) -> Result<Captured, String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS Simulator is only available on macOS".into());
    }
    let png = simctl_screenshot(udid, "png", "alpha").await?;
    Ok(Captured::Ios(png))
}

async fn capture_ios_jpeg(udid: &str, frame: Value) -> Result<Captured, String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS Simulator is only available on macOS".into());
    }
    let jpeg = simctl_screenshot(udid, "jpeg", "black").await?;
    Ok(Captured::Frame(jpeg, frame, ImageFormat::Jpeg))
}

async fn simctl_screenshot(udid: &str, format: &str, mask: &str) -> Result<Vec<u8>, String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp_path = std::env::temp_dir().join(format!(
        "agentdeck-simctl-{}-{count}.{format}",
        std::process::id()
    ));
    let simctl = simctl_path().await?;
    let mut command = Command::new(simctl);
    let type_arg = format!("--type={format}");
    let mask_arg = format!("--mask={mask}");
    command.args(["io", udid, "screenshot", &type_arg, &mask_arg]);
    command.arg(&temp_path);
    let output = run(&mut command, "simctl").await;
    let result = match output {
        Ok(_) => tokio::fs::read(&temp_path)
            .await
            .map_err(|err| format!("Failed to read simctl screenshot: {err}")),
        Err(err) => Err(err),
    };
    let _ = tokio::fs::remove_file(&temp_path).await;
    result
}

/// Radius of the transparent top-left corner: the diagonal meets a circle of
/// radius r centered at (r, r) at r(1 - 1/√2) from the edge.
fn alpha_corner_radius(image: &image::RgbaImage) -> u32 {
    let size = image.width().min(image.height());
    let inset = (0..size)
        .find(|&i| image.get_pixel(i, i)[3] >= 128)
        .unwrap_or(0);
    (inset as f64 / (1.0 - std::f64::consts::FRAC_1_SQRT_2)).round() as u32
}

fn adb_path() -> PathBuf {
    let sdk = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .find_map(env::var_os)
        .map(PathBuf::from)
        .or_else(|| {
            // Android Studio's default SDK locations; the daemon's service PATH
            // rarely includes platform-tools.
            if cfg!(target_os = "macos") {
                dirs::home_dir().map(|home| home.join("Library/Android/sdk"))
            } else if cfg!(windows) {
                dirs::data_local_dir().map(|dir| dir.join("Android/Sdk"))
            } else {
                dirs::home_dir().map(|home| home.join("Android/Sdk"))
            }
        });
    let name = if cfg!(windows) { "adb.exe" } else { "adb" };
    sdk.map(|sdk| sdk.join("platform-tools").join(name))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

async fn capture_android(serial: &str) -> Result<Captured, String> {
    let adb = adb_path();
    let mut screencap_cmd = Command::new(&adb);
    screencap_cmd.args(["-s", serial, "exec-out", "screencap", "-p"]);
    let mut display_cmd = Command::new(&adb);
    display_cmd.args(["-s", serial, "shell", "dumpsys", "display"]);
    let (screencap, display) =
        tokio::join!(run(&mut screencap_cmd, "adb"), run(&mut display_cmd, "adb"),);
    let png = screencap?.stdout;
    // The shape is decoration: a failed dumpsys still shows the screen.
    let shape = display
        .ok()
        .map(|output| android_shape(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    let mut frame = json!({ "kind": "phone", "cornerRadius": shape.corner_radius });
    if !shape.cutouts.is_empty() {
        frame["cutouts"] = json!(shape.cutouts);
    }
    Ok(Captured::Frame(png, frame, ImageFormat::Png))
}

#[derive(Debug, Default, PartialEq)]
struct AndroidShape {
    corner_radius: u32,
    cutouts: Vec<Value>,
}

/// Text after `key` up to the next `end`.
fn field<'a>(text: &'a str, key: &str, end: char) -> Option<&'a str> {
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    Some(&rest[..rest.find(end)?])
}

/// Screen shape from `dumpsys display`. The first entries belong to the
/// built-in display; the cutout spec is in its natural orientation, so the
/// returned paths carry a transform into the current rotation.
fn android_shape(dumpsys: &str) -> AndroidShape {
    let corner_radius = field(dumpsys, "position=TopLeft, radius=", ',')
        .and_then(|radius| radius.trim().parse().ok())
        .unwrap_or(0);
    let rotation: u32 = dumpsys
        .find("mOverrideDisplayInfo=")
        .and_then(|start| field(&dumpsys[start..], ", rotation ", ','))
        .and_then(|rotation| rotation.trim().parse().ok())
        .unwrap_or(0);
    let cutouts = (|| {
        let spec = field(dumpsys, "cutoutSpec={", '}')?;
        let width: f64 = field(dumpsys, "displayWidth=", ' ')?.parse().ok()?;
        let height: f64 = field(dumpsys, "displayHeight=", ' ')?.parse().ok()?;
        let density: f64 = field(dumpsys, "density={", '}')?.parse().ok()?;
        Some(cutout_paths(spec, width, height, density, rotation))
    })()
    .unwrap_or_default();
    AndroidShape {
        corner_radius,
        cutouts,
    }
}

/// SVG paths of an Android cutout spec (`config_mainBuiltInDisplayCutout`):
/// x is relative to the center unless `@left` / `@right`, a part after
/// `@bottom` is relative to the bottom edge, `@dp` scales by density.
fn cutout_paths(spec: &str, width: f64, height: f64, density: f64, rotation: u32) -> Vec<Value> {
    let flag = |name: &str| spec.split_whitespace().any(|token| token == name);
    let scale = if flag("@dp") { density } else { 1.0 };
    let x = if flag("@left") {
        0.0
    } else if flag("@right") {
        width
    } else {
        width / 2.0
    };
    let top_y = if flag("@center_vertical") {
        height / 2.0
    } else {
        0.0
    };
    let rotate = match rotation {
        1 => format!("translate(0 {width}) rotate(-90) "),
        2 => format!("translate({width} {height}) rotate(180) "),
        3 => format!("translate({height} 0) rotate(90) "),
        _ => String::new(),
    };
    let mut parts = spec.splitn(2, "@bottom");
    let top = parts.next().unwrap_or_default();
    let bottom = parts.next();
    [(top, top_y), (bottom.unwrap_or_default(), height)]
        .into_iter()
        .filter_map(|(part, y)| {
            let path = part
                .split_whitespace()
                .filter(|token| !token.starts_with('@'))
                .collect::<Vec<_>>()
                .join(" ");
            (!path.is_empty()).then(|| {
                json!({
                    "path": path,
                    "transform": format!("{rotate}translate({x} {y}) scale({scale})"),
                })
            })
        })
        .collect()
}

async fn connect_browser4agent() -> Result<RunningService<RoleClient, ClientConfig>, String> {
    ClientConfig::default()
        .serve(StreamableHttpClientTransport::from_uri(
            BROWSER4AGENT_MCP_URL,
        ))
        .await
        .map_err(|err| {
            format!("browser4agent is not running (install its browser extension): {err}")
        })
}

async fn find_tab(
    client: &RunningService<RoleClient, ClientConfig>,
    tab_id: i64,
) -> Result<Option<Value>, String> {
    let tabs = call_tool(client, "list_tabs", json!({})).await?;
    Ok(tool_text(&tabs)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|tabs| {
            tabs.get("tabs")?
                .as_array()?
                .iter()
                .find(|tab| tab.get("id").and_then(Value::as_i64) == Some(tab_id))
                .cloned()
        }))
}

/// Whether browser4agent on this machine drives the browser holding this tab.
/// Tab ids are per browser, so the URL must match too.
pub async fn browser_has_tab(tab_id: i64, url: &str) -> bool {
    let check = async {
        let client = connect_browser4agent().await.ok()?;
        let tab = find_tab(&client, tab_id).await.ok().flatten();
        let _ = client.cancel().await;
        tab
    };
    tokio::time::timeout(Duration::from_secs(1), check)
        .await
        .ok()
        .flatten()
        .is_some_and(|tab| tab.get("url").and_then(Value::as_str) == Some(url))
}

async fn capture_browser_fast(
    client: &RunningService<RoleClient, ClientConfig>,
    tab_id: i64,
    frame: Value,
) -> Result<Captured, String> {
    let shot = call_tool(client, "screenshot_tab", json!({ "tab_id": tab_id })).await?;
    let data = shot
        .content
        .iter()
        .find_map(|content| content.as_image())
        .ok_or("browser4agent returned no screenshot")?;
    let png = STANDARD
        .decode(&data.data)
        .map_err(|err| format!("Invalid browser screenshot: {err}"))?;
    Ok(Captured::Frame(png, frame, ImageFormat::Png))
}

/// Whether the tab emulates a phone (DevTools device mode sets a mobile UA
/// and coarse pointer). Pages that reject scripts, like `chrome://`, count as
/// desktop.
async fn tab_is_mobile(client: &RunningService<RoleClient, ClientConfig>, tab_id: i64) -> bool {
    let script = json!({
        "tab_id": tab_id,
        "func_str": "() => !!navigator.userAgentData?.mobile || matchMedia('(pointer: coarse)').matches",
    });
    let Ok(result) = call_tool(client, "execute_script", script).await else {
        return false;
    };
    tool_text(&result)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("result")?.as_bool())
        .unwrap_or(false)
}

async fn call_tool(
    client: &RunningService<RoleClient, ClientConfig>,
    name: &str,
    arguments: Value,
) -> Result<CallToolResult, String> {
    let Value::Object(arguments) = arguments else {
        unreachable!("tool arguments are an object");
    };
    let result = client
        .call_tool(CallToolRequestParams::new(name.to_string()).with_arguments(arguments))
        .await
        .map_err(|err| format!("browser4agent {name} failed: {err}"))?;
    if result.is_error == Some(true) {
        let text = tool_text(&result).unwrap_or_default();
        return Err(format!("browser4agent {name} failed: {text}"));
    }
    Ok(result)
}

fn tool_text(result: &CallToolResult) -> Option<&str> {
    result
        .content
        .iter()
        .find_map(|content| Some(content.as_text()?.text.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_android_shape() {
        let dumpsys =
            "DisplayDeviceInfo{\"Built-in Screen\": roundedCorners \
             RoundedCorners{[RoundedCorner{position=TopLeft, radius=47, center=Point(47, 47)}]} \
             cutout DisplayCutout{cutoutPathParserInfo={CutoutPathParserInfo{displayWidth=1080 \
             displayHeight=2400 physicalDisplayWidth=1080 physicalDisplayHeight=2400 \
             density={2.625} cutoutSpec={M 506,68 a 34,34 0 1 0 68,0 34,34 0 1 0 -68,0 Z @left} \
             rotation={0}}}}, rotation 0\n  mBaseDisplayInfo=DisplayInfo{, rotation 0, }\n  \
             mOverrideDisplayInfo=DisplayInfo{, real 2400 x 1080, rotation 1, }";
        let shape = android_shape(dumpsys);
        assert_eq!(shape.corner_radius, 47);
        assert_eq!(
            shape.cutouts,
            vec![json!({
                "path": "M 506,68 a 34,34 0 1 0 68,0 34,34 0 1 0 -68,0 Z",
                "transform": "translate(0 1080) rotate(-90) translate(0 0) scale(1)",
            })]
        );
    }

    #[test]
    fn places_centered_dp_and_bottom_cutouts() {
        let paths = cutout_paths(
            "M 0,0 H -24 V 64 H 24 Z @dp @bottom M 0,0 h 10 v -10 Z",
            1080.0,
            2400.0,
            3.0,
            0,
        );
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0]["transform"], "translate(540 0) scale(3)");
        assert_eq!(paths[1]["path"], "M 0,0 h 10 v -10 Z");
        assert_eq!(paths[1]["transform"], "translate(540 2400) scale(3)");
    }

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
    fn processes_jpeg_frames_with_cached_frame_metadata() {
        let image = RgbImage::from_pixel(32, 64, image::Rgb([12, 34, 56]));
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&image)
            .unwrap();
        let frame = json!({ "kind": "phone", "cornerRadius": 48 });

        let (info, output) = process_captured(
            Captured::Frame(jpeg, frame.clone(), ImageFormat::Jpeg),
            DEFAULT_MAX_WIDTH,
        )
        .unwrap();

        assert_eq!(info["width"], 32);
        assert_eq!(info["height"], 64);
        assert_eq!(info["frame"], frame);
        assert!(output.starts_with(&[0xff, 0xd8]));
    }

    #[tokio::test]
    async fn screen_stream_manager_cancels_active_stream() {
        let manager = ScreenStreamManager::default();
        let token = CancellationToken::new();
        manager
            .streams
            .lock()
            .unwrap()
            .insert("test:target".to_string(), token.clone());

        assert!(!token.is_cancelled());
        manager.stop_stream("test:target");
        assert!(token.is_cancelled());
        assert!(!manager.streams.lock().unwrap().contains_key("test:target"));
    }
}
