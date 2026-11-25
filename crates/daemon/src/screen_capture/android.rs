use std::{env, path::PathBuf};

use image::ImageFormat;
use serde_json::{Value, json};
use tokio::process::Command;

use super::{Captured, ScreenDriver, run};

pub(super) struct AndroidDriver {
    serial: String,
}

impl AndroidDriver {
    pub(super) fn new(serial: String) -> Self {
        Self { serial }
    }
}

impl ScreenDriver for AndroidDriver {
    fn capture(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Captured, String>> + Send + '_>>
    {
        Box::pin(capture_android(&self.serial))
    }
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
    let mut display_cmd = Command::new(&adb);
    display_cmd.args(["-s", serial, "shell", "dumpsys", "display"]);
    if let Ok(output) = run(&mut display_cmd, "adb").await
        && let Some(size) = parse_android_override_size(&String::from_utf8_lossy(&output.stdout))
    {
        return Ok(size);
    }

    let mut wm_cmd = Command::new(&adb);
    wm_cmd.args(["-s", serial, "shell", "wm", "size"]);
    let output = run(&mut wm_cmd, "adb").await?;
    parse_wm_size(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("Failed to determine display size for android:{serial}"))
}

pub(super) async fn tap(serial: &str, x: u32, y: u32) -> Result<(), String> {
    let adb = adb_path();
    let mut command = Command::new(&adb);
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
}
