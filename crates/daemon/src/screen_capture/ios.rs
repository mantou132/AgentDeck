use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use image::{DynamicImage, ImageFormat, RgbImage};
use serde_json::{Value, json};
use tokio::process::Command;

use super::{Captured, ScreenDriver, run};

pub(super) struct IosDriver {
    udid: String,
    frame: Option<Value>,
}

impl IosDriver {
    pub(super) fn new(udid: String) -> Self {
        Self { udid, frame: None }
    }
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

            let png = capture_ios_png(&self.udid).await?;
            let (png, image, frame) = tokio::task::spawn_blocking(move || {
                let (image, frame) = decode_ios_png(&png)?;
                Ok::<_, String>((png, image, frame))
            })
            .await
            .map_err(|err| format!("iOS screenshot decode task failed: {err}"))??;
            self.frame = Some(frame.clone());
            Ok(Captured::IosPng(png, image, frame))
        })
    }
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

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn capture_ios_png(udid: &str) -> Result<Vec<u8>, String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS Simulator is only available on macOS".into());
    }
    simctl_screenshot(udid, "png", "alpha").await
}

async fn capture_ios_jpeg(udid: &str, frame: Value) -> Result<Captured, String> {
    if !cfg!(target_os = "macos") {
        return Err("iOS Simulator is only available on macOS".into());
    }
    let jpeg = simctl_screenshot(udid, "jpeg", "black").await?;
    Ok(Captured::Frame(jpeg, frame, ImageFormat::Jpeg))
}

async fn simctl_screenshot(udid: &str, format: &str, mask: &str) -> Result<Vec<u8>, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Declared before `command` so when the future is dropped mid-capture, the
    // child process is killed first and the temp file is removed afterwards.
    let temp_file = TempFile(std::env::temp_dir().join(format!(
        "agentdeck-simctl-{}-{count}.{format}",
        std::process::id()
    )));
    let simctl = simctl_path().await?;
    let mut command = Command::new(simctl);
    let type_arg = format!("--type={format}");
    let mask_arg = format!("--mask={mask}");
    command.args(["io", udid, "screenshot", &type_arg, &mask_arg]);
    command.arg(&temp_file.0);
    run(&mut command, "simctl").await?;
    tokio::fs::read(&temp_file.0)
        .await
        .map_err(|err| format!("Failed to read simctl screenshot: {err}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_file_is_removed_on_drop() {
        let path =
            std::env::temp_dir().join(format!("agentdeck-temp-file-test-{}", std::process::id()));
        std::fs::write(&path, b"test").unwrap();
        {
            let _temp = TempFile(path.clone());
            assert!(path.exists());
        }
        assert!(!path.exists());
    }
}
