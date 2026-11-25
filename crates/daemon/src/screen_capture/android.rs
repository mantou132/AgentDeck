use std::{env, path::PathBuf, sync::OnceLock};

use image::ImageFormat;
use serde_json::{Value, json};
use tokio::process::Command;

use super::{Captured, RawPixelFormat, ScreenDriver, run};

pub(super) struct AndroidDriver {
    serial: String,
    frame: Option<Value>,
    last_dimensions: Option<(u32, u32)>,
    use_png: bool,
}

impl AndroidDriver {
    pub(super) fn new(serial: String) -> Self {
        Self {
            serial,
            frame: None,
            last_dimensions: None,
            use_png: false,
        }
    }

    async fn capture_frame(&mut self) -> Result<Captured, String> {
        if !self.use_png {
            let (raw_res, initial_frame) = if self.frame.is_none() {
                let (raw_res, frame) = tokio::join!(
                    screencap_raw(&self.serial),
                    fetch_display_frame(&self.serial),
                );
                (raw_res, Some(frame))
            } else {
                (screencap_raw(&self.serial).await, None)
            };
            if let Some(frame) = initial_frame {
                self.frame = Some(frame);
            }
            let raw = raw_res?;
            if let Some(header) = parse_raw_screencap(&raw) {
                let dims = (header.width, header.height);
                let frame = self.frame_for_dimensions(Some(dims)).await;
                return Ok(Captured::RawPixels {
                    bytes: raw,
                    offset: header.offset,
                    width: header.width,
                    height: header.height,
                    format: header.format,
                    frame,
                });
            }
            self.use_png = true;
        }

        let (png_res, initial_frame) = if self.frame.is_none() {
            let (png_res, frame) = tokio::join!(
                screencap_png(&self.serial),
                fetch_display_frame(&self.serial),
            );
            (png_res, Some(frame))
        } else {
            (screencap_png(&self.serial).await, None)
        };
        if let Some(frame) = initial_frame {
            self.frame = Some(frame);
        }
        let png = png_res?;
        let dims = parse_png_dimensions(&png);
        let frame = self.frame_for_dimensions(dims).await;
        Ok(Captured::Frame(png, frame, ImageFormat::Png))
    }

    async fn frame_for_dimensions(&mut self, dims: Option<(u32, u32)>) -> Value {
        if let Some(dims) = dims {
            if self.last_dimensions.is_some() && self.last_dimensions != Some(dims) {
                // Screen rotated or resized: refresh cutouts and rotation
                // transform.
                self.frame = Some(fetch_display_frame(&self.serial).await);
            }
            self.last_dimensions = Some(dims);
        }
        self.frame
            .clone()
            .unwrap_or_else(|| json!({ "kind": "phone", "cornerRadius": 0 }))
    }
}

impl ScreenDriver for AndroidDriver {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>
    {
        Box::pin(self.capture_frame())
    }
}

static ADB_PATH: OnceLock<PathBuf> = OnceLock::new();

fn adb_path() -> &'static PathBuf {
    ADB_PATH.get_or_init(resolve_adb_path)
}

fn resolve_adb_path() -> PathBuf {
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

async fn screencap_raw(serial: &str) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(adb_path());
    cmd.args(["-s", serial, "exec-out", "screencap"]);
    Ok(run(&mut cmd, "adb").await?.stdout)
}

async fn screencap_png(serial: &str) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(adb_path());
    cmd.args(["-s", serial, "exec-out", "screencap", "-p"]);
    Ok(run(&mut cmd, "adb").await?.stdout)
}

async fn fetch_display_frame(serial: &str) -> Value {
    let mut display_cmd = Command::new(adb_path());
    display_cmd.args(["-s", serial, "shell", "dumpsys", "display"]);
    // The shape is decoration: a failed dumpsys still shows the screen.
    let shape = run(&mut display_cmd, "adb")
        .await
        .ok()
        .map(|output| android_shape(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    let mut frame = json!({ "kind": "phone", "cornerRadius": shape.corner_radius });
    if !shape.cutouts.is_empty() {
        frame["cutouts"] = json!(shape.cutouts);
    }
    frame
}

#[derive(Debug, PartialEq, Eq)]
struct RawScreencapHeader {
    offset: usize,
    width: u32,
    height: u32,
    format: RawPixelFormat,
}

/// Parses Android's raw `screencap` header: 12 bytes (`w, h, format`) on
/// Android < 9, or 16 bytes (`w, h, format, colorspace`) on Android >= 9.
fn parse_raw_screencap(bytes: &[u8]) -> Option<RawScreencapHeader> {
    if bytes.len() < 12 {
        return None;
    }
    let width = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    let height = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let format_code = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return None;
    }
    let format = match format_code {
        1 => RawPixelFormat::Rgba8888,
        2 => RawPixelFormat::Rgbx8888,
        3 => RawPixelFormat::Rgb888,
        5 => RawPixelFormat::Bgra8888,
        _ => return None,
    };
    let pixel_bytes = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(format.bytes_per_pixel())?;
    let offset = if bytes.len() == 16usize.checked_add(pixel_bytes)? {
        16
    } else if bytes.len() == 12usize.checked_add(pixel_bytes)? {
        12
    } else {
        return None;
    };
    Some(RawScreencapHeader {
        offset,
        width,
        height,
        format,
    })
}

/// Reads `(width, height)` from a PNG IHDR chunk without decoding pixels.
fn parse_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
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

fn parse_android_override_size(dumpsys: &str) -> Option<(u32, u32)> {
    let start = dumpsys.find("mOverrideDisplayInfo=")?;
    let real = field(&dumpsys[start..], ", real ", ',')?;
    let (w, h) = real.split_once('x')?;
    let width: u32 = w.trim().parse().ok()?;
    let height: u32 = h.trim().parse().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

fn parse_wm_size(output: &str) -> Option<(u32, u32)> {
    let mut parsed = None;
    for line in output.lines() {
        let Some((_, dims)) = line.split_once(':') else {
            continue;
        };
        let Some((w, h)) = dims.trim().split_once('x') else {
            continue;
        };
        if let (Ok(width), Ok(height)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>())
            && width > 0
            && height > 0
        {
            parsed = Some((width, height));
        }
    }
    parsed
}

pub(super) async fn display_size(serial: &str) -> Result<(u32, u32), String> {
    let adb = adb_path();
    let mut display_cmd = Command::new(adb);
    display_cmd.args(["-s", serial, "shell", "dumpsys", "display"]);
    if let Ok(output) = run(&mut display_cmd, "adb").await
        && let Some(size) = parse_android_override_size(&String::from_utf8_lossy(&output.stdout))
    {
        return Ok(size);
    }

    let mut wm_cmd = Command::new(adb);
    wm_cmd.args(["-s", serial, "shell", "wm", "size"]);
    let output = run(&mut wm_cmd, "adb").await?;
    parse_wm_size(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("Failed to determine display size for android:{serial}"))
}

pub(super) async fn tap(serial: &str, x: u32, y: u32) -> Result<(), String> {
    let mut command = Command::new(adb_path());
    command.args([
        "-s",
        serial,
        "shell",
        "input",
        "tap",
        &x.to_string(),
        &y.to_string(),
    ]);
    run(&mut command, "adb").await?;
    Ok(())
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

    #[test]
    fn parses_android_display_sizes() {
        let dumpsys = "mOverrideDisplayInfo=DisplayInfo{, real 2400 x 1080, rotation 1, }";
        assert_eq!(parse_android_override_size(dumpsys), Some((2400, 1080)));
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\nOverride size: 720x1600\n"),
            Some((720, 1600))
        );
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\n"),
            Some((1080, 2400))
        );
    }

    #[test]
    fn parses_raw_screencap_12_and_16_byte_headers() {
        let mut v12 = Vec::new();
        v12.extend_from_slice(&4u32.to_le_bytes());
        v12.extend_from_slice(&2u32.to_le_bytes());
        v12.extend_from_slice(&1u32.to_le_bytes());
        v12.extend_from_slice(&vec![0u8; 4 * 2 * 4]);
        assert_eq!(
            parse_raw_screencap(&v12),
            Some(RawScreencapHeader {
                offset: 12,
                width: 4,
                height: 2,
                format: RawPixelFormat::Rgba8888,
            })
        );

        let mut v16 = Vec::new();
        v16.extend_from_slice(&3u32.to_le_bytes());
        v16.extend_from_slice(&5u32.to_le_bytes());
        v16.extend_from_slice(&5u32.to_le_bytes());
        v16.extend_from_slice(&0u32.to_le_bytes());
        v16.extend_from_slice(&vec![0u8; 3 * 5 * 4]);
        assert_eq!(
            parse_raw_screencap(&v16),
            Some(RawScreencapHeader {
                offset: 16,
                width: 3,
                height: 5,
                format: RawPixelFormat::Bgra8888,
            })
        );

        // Truncated or unsupported format falls back to PNG.
        assert_eq!(parse_raw_screencap(&v16[..v16.len() - 1]), None);
        let mut unsupported = Vec::new();
        unsupported.extend_from_slice(&2u32.to_le_bytes());
        unsupported.extend_from_slice(&2u32.to_le_bytes());
        unsupported.extend_from_slice(&4u32.to_le_bytes()); // RGB_565
        unsupported.extend_from_slice(&vec![0u8; 2 * 2 * 2]);
        assert_eq!(parse_raw_screencap(&unsupported), None);
    }

    #[test]
    fn parses_png_ihdr_dimensions() {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1080u32.to_be_bytes());
        png.extend_from_slice(&2400u32.to_be_bytes());
        assert_eq!(parse_png_dimensions(&png), Some((1080, 2400)));
        assert_eq!(parse_png_dimensions(b"not a png"), None);
    }
}
