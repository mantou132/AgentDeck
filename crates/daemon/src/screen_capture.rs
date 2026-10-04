//! `screen_capture` RPC: one frame of an app the agent launched on this
//! machine, for the client's `agentdeck-screen` block. The client polls frame
//! by frame, so nothing here keeps state between calls.
//!
//! Targets:
//! - `ios:<udid|booted>`: iOS Simulator via `simctl`. Its alpha mask carries
//!   the exact screen shape (corners, Dynamic Island).
//! - `android:<serial>`: device or emulator via `adb`. The shape comes from
//!   `dumpsys display` when the system reports it.
//! - `browser:<tabId>`: browser tab via the browser4agent extension's local
//!   MCP service; `mobile` marks a tab under DevTools device emulation.
//!
//! Every result reports the native `width` / `height` and a `frame` the client
//! draws around the picture; the picture itself is a JPEG at most `maxWidth`
//! wide. Shape geometry is in native pixels.

use std::{
    env,
    path::PathBuf,
    process::{Command, Output},
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

const DEFAULT_MAX_WIDTH: u32 = 800;
const JPEG_QUALITY: u8 = 80;
const BROWSER4AGENT_MCP_URL: &str = "http://127.0.0.1:39271/mcp";

pub async fn capture(
    target: &str,
    max_width: Option<u64>,
) -> Result<(Value, Option<Vec<u8>>), String> {
    let max_width = max_width
        .map(|width| width.clamp(160, 2000) as u32)
        .unwrap_or(DEFAULT_MAX_WIDTH);
    let (kind, id) = target
        .trim()
        .split_once(':')
        .filter(|(kind, id)| ["ios", "android", "browser"].contains(kind) && !id.is_empty())
        .ok_or_else(|| format!("Unsupported screen target: {target}"))?;
    // Browser tabs arrive over async MCP; simulators and devices go through
    // blocking CLIs, and image work is blocking for all.
    let browser = match kind {
        "browser" => Some(capture_browser(id).await?),
        _ => None,
    };
    let (kind, id) = (kind.to_string(), id.to_string());
    tokio::task::spawn_blocking(move || {
        let (image, frame) = match browser {
            Some((png, frame)) => (decode_png(&png)?.into_rgb8(), frame),
            None if kind == "ios" => capture_ios(&id)?,
            None => capture_android(&id)?,
        };
        let (width, height) = (image.width(), image.height());
        let jpeg = encode_jpeg(image, max_width)?;
        Ok((
            json!({ "width": width, "height": height, "frame": frame }),
            Some(jpeg),
        ))
    })
    .await
    .map_err(|err| format!("Screen capture task failed: {err}"))?
}

fn encode_jpeg(image: RgbImage, max_width: u32) -> Result<Vec<u8>, String> {
    let image = if image.width() > max_width {
        let height = (image.height() as u64 * max_width as u64 / image.width() as u64) as u32;
        imageops::resize(&image, max_width, height.max(1), FilterType::Triangle)
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

fn run(command: &mut Command, name: &str) -> Result<Output, String> {
    let output = command
        .output()
        .map_err(|err| format!("Failed to run {name}: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{name} failed: {}", stderr.trim()));
    }
    Ok(output)
}

fn capture_ios(udid: &str) -> Result<(RgbImage, Value), String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS Simulator is only available on macOS".into());
    }
    let output = run(
        Command::new("/usr/bin/xcrun").args([
            "simctl",
            "io",
            udid,
            "screenshot",
            "--type=png",
            "--mask=alpha",
            "-",
        ]),
        "simctl",
    )?;
    let image = decode_png(&output.stdout)?.into_rgba8();
    let corner_radius = alpha_corner_radius(&image);
    // simctl premultiplies the mask, so dropping alpha leaves the masked
    // corners and Dynamic Island black.
    let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
    Ok((
        rgb,
        json!({ "kind": "phone", "cornerRadius": corner_radius }),
    ))
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

fn capture_android(serial: &str) -> Result<(RgbImage, Value), String> {
    let adb = adb_path();
    let (screencap, display) = std::thread::scope(|scope| {
        let display = scope.spawn(|| {
            run(
                Command::new(&adb).args(["-s", serial, "shell", "dumpsys", "display"]),
                "adb",
            )
        });
        let screencap = run(
            Command::new(&adb).args(["-s", serial, "exec-out", "screencap", "-p"]),
            "adb",
        );
        (screencap, display.join())
    });
    let image = decode_png(&screencap?.stdout)?.into_rgb8();
    // The shape is decoration: a failed dumpsys still shows the screen.
    let shape = display
        .ok()
        .and_then(Result::ok)
        .map(|output| android_shape(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    let mut frame = json!({ "kind": "phone", "cornerRadius": shape.corner_radius });
    if !shape.cutouts.is_empty() {
        frame["cutouts"] = json!(shape.cutouts);
    }
    Ok((image, frame))
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

/// A tab's PNG and its title / URL through browser4agent's local MCP service,
/// one short session per frame.
async fn capture_browser(tab_id: &str) -> Result<(Vec<u8>, Value), String> {
    let tab_id: i64 = tab_id
        .parse()
        .map_err(|_| format!("Invalid browser tab id: {tab_id}"))?;
    let client = connect_browser4agent().await?;
    let result = async {
        let tab = find_tab(&client, tab_id)
            .await?
            .ok_or_else(|| format!("Browser tab {tab_id} is closed"))?;
        let shot = call_tool(&client, "screenshot_tab", json!({ "tab_id": tab_id })).await?;
        let data = shot
            .content
            .iter()
            .find_map(|content| content.as_image())
            .ok_or("browser4agent returned no screenshot")?;
        let png = STANDARD
            .decode(&data.data)
            .map_err(|err| format!("Invalid browser screenshot: {err}"))?;
        let frame = json!({
            "kind": "browser",
            "title": tab.get("title").cloned().unwrap_or_default(),
            "url": tab.get("url").cloned().unwrap_or_default(),
            "mobile": tab_is_mobile(&client, tab_id).await,
        });
        Ok((png, frame))
    }
    .await;
    let _ = client.cancel().await;
    result
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
        let dumpsys = "DisplayDeviceInfo{\"Built-in Screen\": roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=47, center=Point(47, 47)}]} cutout DisplayCutout{cutoutPathParserInfo={CutoutPathParserInfo{displayWidth=1080 displayHeight=2400 physicalDisplayWidth=1080 physicalDisplayHeight=2400 density={2.625} cutoutSpec={M 506,68 a 34,34 0 1 0 68,0 34,34 0 1 0 -68,0 Z @left} rotation={0}}}}, rotation 0\n  mBaseDisplayInfo=DisplayInfo{, rotation 0, }\n  mOverrideDisplayInfo=DisplayInfo{, real 2400 x 1080, rotation 1, }";
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
}
