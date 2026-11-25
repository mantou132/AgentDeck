use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::ImageFormat;
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResult, ClientConfig},
    service::{RoleClient, RunningService},
    transport::StreamableHttpClientTransport,
};
use serde_json::{Value, json};

use super::{Captured, JPEG_QUALITY, ScreenDriver, normalized_to_css};

const BROWSER4AGENT_MCP_URL: &str = "http://127.0.0.1:39271/mcp";

pub(super) type BrowserPeer = rmcp::service::Peer<RoleClient>;

pub(super) struct BrowserDriver {
    client: Option<RunningService<RoleClient, ClientConfig>>,
    tab_id: i64,
    frame: Value,
}

impl BrowserDriver {
    pub(super) async fn connect(tab_id: i64) -> Result<Self, String> {
        let client = connect_browser4agent().await?;
        let peer = client.peer();
        let tab = find_tab(peer, tab_id)
            .await?
            .ok_or_else(|| format!("Browser tab {tab_id} is closed"))?;
        let frame = json!({
            "kind": "browser",
            "title": tab.get("title").cloned().unwrap_or_default(),
            "url": tab.get("url").cloned().unwrap_or_default(),
            "mobile": tab_is_mobile(peer, tab_id).await,
        });
        Ok(Self {
            client: Some(client),
            tab_id,
            frame,
        })
    }
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
            client.peer(),
            self.tab_id,
            self.frame.clone(),
        ))
    }

    fn browser_peer(&self) -> Option<BrowserPeer> {
        self.client.as_ref().map(|client| client.peer().clone())
    }

    fn detach_cdp(
        &mut self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            if let Some(client) = &self.client {
                detach_cdp(client.peer(), self.tab_id).await;
            }
        })
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

pub(super) async fn connect_browser4agent()
-> Result<RunningService<RoleClient, ClientConfig>, String> {
    ClientConfig::default()
        .serve(StreamableHttpClientTransport::from_uri(
            BROWSER4AGENT_MCP_URL,
        ))
        .await
        .map_err(|err| {
            format!("browser4agent is not running (install its browser extension): {err}")
        })
}

async fn find_tab(peer: &BrowserPeer, tab_id: i64) -> Result<Option<Value>, String> {
    let tabs = call_tool(peer, "list_tabs", json!({})).await?;
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
        let tab = find_tab(client.peer(), tab_id).await.ok().flatten();
        let _ = client.cancel().await;
        tab
    };
    tokio::time::timeout(Duration::from_secs(1), check)
        .await
        .ok()
        .flatten()
        .is_some_and(|tab| tab.get("url").and_then(Value::as_str) == Some(url))
}

fn detect_image_format(mime_type: &str, bytes: &[u8]) -> Result<ImageFormat, String> {
    if let Ok(format) = image::guess_format(bytes) {
        return Ok(format);
    }
    let mime = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Ok(ImageFormat::Jpeg),
        "image/png" => Ok(ImageFormat::Png),
        _ => Err(format!("Unsupported screenshot format ({mime_type})")),
    }
}

async fn capture_browser_fast(
    peer: &BrowserPeer,
    tab_id: i64,
    frame: Value,
) -> Result<Captured, String> {
    let shot = call_tool(
        peer,
        "screenshot_tab",
        json!({ "tab_id": tab_id, "format": "jpeg", "quality": JPEG_QUALITY }),
    )
    .await?;
    let data = shot
        .content
        .iter()
        .find_map(|content| content.as_image())
        .ok_or("browser4agent returned no screenshot")?;
    let bytes = STANDARD
        .decode(&data.data)
        .map_err(|err| format!("Invalid browser screenshot: {err}"))?;
    let format = detect_image_format(&data.mime_type, &bytes)?;
    Ok(Captured::Frame(bytes, frame, format))
}

/// Whether the tab emulates a phone (DevTools device mode sets a mobile UA
/// and coarse pointer). Pages that reject scripts, like `chrome://`, count as
/// desktop.
async fn tab_is_mobile(peer: &BrowserPeer, tab_id: i64) -> bool {
    let script = json!({
        "tab_id": tab_id,
        "func_str": "() => !!navigator.userAgentData?.mobile || matchMedia('(pointer: coarse)').matches",
    });
    let Ok(result) = call_tool(peer, "execute_script", script).await else {
        return false;
    };
    tool_text(&result)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("result")?.as_bool())
        .unwrap_or(false)
}

async fn call_tool(
    peer: &BrowserPeer,
    name: &str,
    arguments: Value,
) -> Result<CallToolResult, String> {
    let Value::Object(arguments) = arguments else {
        unreachable!("tool arguments are an object");
    };
    let result = peer
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

fn parse_cdp_viewport(metrics: &Value) -> Result<(f64, f64), String> {
    for key in [
        "cssVisualViewport",
        "visualViewport",
        "cssLayoutViewport",
        "layoutViewport",
    ] {
        let Some(viewport) = metrics.get(key) else {
            continue;
        };
        let width = viewport.get("clientWidth").and_then(Value::as_f64);
        let height = viewport.get("clientHeight").and_then(Value::as_f64);
        if let (Some(w), Some(h)) = (width, height)
            && w.is_finite()
            && h.is_finite()
            && w > 0.0
            && h > 0.0
        {
            return Ok((w, h));
        }
    }
    Err("Failed to read browser viewport dimensions via CDP".to_string())
}

async fn cdp_command(
    peer: &BrowserPeer,
    tab_id: i64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let result = call_tool(
        peer,
        "debugger_send_command",
        json!({ "tab_id": tab_id, "method": method, "params": params }),
    )
    .await?;
    let Some(text) = tool_text(&result) else {
        return Ok(Value::Null);
    };
    serde_json::from_str(text).map_err(|err| format!("Invalid CDP {method} response: {err}"))
}

pub(super) async fn detach_cdp(peer: &BrowserPeer, tab_id: i64) {
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        call_tool(peer, "debugger_detach", json!({ "tab_id": tab_id })),
    )
    .await;
}

const BATCH_CDP_CLICK_SCRIPT: &str = r#"async (tabId, x, y) => {
  const target = { tabId };
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return true;
}"#;

async fn batch_cdp_click(
    peer: &BrowserPeer,
    tab_id: i64,
    css_x: f64,
    css_y: f64,
) -> Result<(), String> {
    call_tool(
        peer,
        "execute_script_in_background",
        json!({
            "func_str": BATCH_CDP_CLICK_SCRIPT,
            "args": [tab_id, css_x, css_y],
        }),
    )
    .await?;
    Ok(())
}

async fn sequential_cdp_click(
    peer: &BrowserPeer,
    tab_id: i64,
    css_x: f64,
    css_y: f64,
) -> Result<(), String> {
    cdp_command(
        peer,
        tab_id,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": css_x, "y": css_y }),
    )
    .await?;
    cdp_command(
        peer,
        tab_id,
        "Input.dispatchMouseEvent",
        json!({
            "type": "mousePressed",
            "x": css_x,
            "y": css_y,
            "button": "left",
            "buttons": 1,
            "clickCount": 1,
        }),
    )
    .await?;
    cdp_command(
        peer,
        tab_id,
        "Input.dispatchMouseEvent",
        json!({
            "type": "mouseReleased",
            "x": css_x,
            "y": css_y,
            "button": "left",
            "buttons": 0,
            "clickCount": 1,
        }),
    )
    .await?;
    Ok(())
}

/// Dispatches a click at normalized `(x, y)` and returns the CSS viewport size
/// used, so callers can reuse it across subsequent taps while the frame size is
/// unchanged.
pub(super) async fn tap(
    peer: &BrowserPeer,
    tab_id: i64,
    x: f64,
    y: f64,
    cached_viewport: Option<(f64, f64)>,
) -> Result<(f64, f64), String> {
    if let Some((width, height)) = cached_viewport {
        let css_x = normalized_to_css(x, width);
        let css_y = normalized_to_css(y, height);
        if batch_cdp_click(peer, tab_id, css_x, css_y).await.is_ok() {
            return Ok((width, height));
        }
    }

    // Attaches CDP through browser4agent's tracked debugger path and reads the
    // live viewport metrics.
    let metrics = cdp_command(peer, tab_id, "Page.getLayoutMetrics", json!({})).await?;
    let (width, height) = parse_cdp_viewport(&metrics)?;
    let css_x = normalized_to_css(x, width);
    let css_y = normalized_to_css(y, height);

    if batch_cdp_click(peer, tab_id, css_x, css_y).await.is_err() {
        sequential_cdp_click(peer, tab_id, css_x, css_y).await?;
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use image::{RgbImage, codecs::jpeg::JpegEncoder};

    use super::*;

    #[test]
    fn detects_jpeg_and_png_formats() {
        assert_eq!(
            detect_image_format("image/jpeg", &[]).unwrap(),
            ImageFormat::Jpeg
        );
        assert_eq!(
            detect_image_format("image/PNG; charset=utf-8", &[]).unwrap(),
            ImageFormat::Png
        );

        let image = RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]));
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&image)
            .unwrap();
        assert_eq!(detect_image_format("", &jpeg).unwrap(), ImageFormat::Jpeg);
        assert_eq!(
            detect_image_format("image/jpeg", b"\x89PNG\r\n\x1a\n").unwrap(),
            ImageFormat::Png
        );
    }

    #[test]
    fn parses_cdp_layout_metrics_viewport() {
        let metrics = json!({
            "visualViewport": { "clientWidth": 800.0, "clientHeight": 600.0 },
            "cssVisualViewport": { "clientWidth": 390.0, "clientHeight": 844.0 },
        });
        assert_eq!(parse_cdp_viewport(&metrics).unwrap(), (390.0, 844.0));

        let fallback = json!({
            "layoutViewport": { "clientWidth": 1280, "clientHeight": 720 },
        });
        assert_eq!(parse_cdp_viewport(&fallback).unwrap(), (1280.0, 720.0));
        assert!(parse_cdp_viewport(&json!({})).is_err());
    }
}
