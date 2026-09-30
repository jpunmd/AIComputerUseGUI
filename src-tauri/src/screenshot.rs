use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::PngEncoder;
use image::{imageops::FilterType, ImageEncoder, RgbaImage};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use xcap::Monitor;

/// Default maximum dimension (width or height) for screenshots sent to the model
/// This helps reduce token usage while maintaining enough detail for the model
const DEFAULT_MAX_SCREENSHOT_DIMENSION: u32 = 1920;

/// Screen-change fingerprint: the capture averaged down to a fixed grid of
/// luminance cells (8x8 px each on a 1080p screen, 16x16 on 4K).
const FINGERPRINT_SIZE: (u32, u32) = (240, 135);
/// A cell counts as changed when its average luminance moves by more than this,
/// so a single changed pixel never does but a line of text or an icon does.
const CELL_DELTA: u8 = 8;
/// Frames closer than this are "the same screen": a blinking caret or the
/// taskbar clock (a few cells) stays below it; a 40x20 px change does not.
/// The frontend uses the same value to tell the model nothing visibly changed.
pub const STABLE_FRACTION: f64 = 0.0002;
const SETTLE_POLL: Duration = Duration::from_millis(150);

#[derive(Error, Debug)]
pub enum ScreenshotError {
    #[error("No screens found")]
    NoScreens,
    #[error("Failed to capture screenshot: {0}")]
    CaptureError(String),
    #[error("Failed to encode image: {0}")]
    EncodeError(String),
}

/// Calculate the resized dimensions for a given image size
fn calculate_resized_dimensions(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    if width <= max_dimension && height <= max_dimension {
        return (width, height);
    }

    if width > height {
        let ratio = max_dimension as f64 / width as f64;
        (max_dimension, (height as f64 * ratio) as u32)
    } else {
        let ratio = max_dimension as f64 / height as f64;
        ((width as f64 * ratio) as u32, max_dimension)
    }
}

/// Resize an image to fit within max_dimension while maintaining aspect ratio
fn resize_image(img: &RgbaImage, max_dimension: u32) -> RgbaImage {
    let (width, height) = (img.width(), img.height());
    let (new_width, new_height) = calculate_resized_dimensions(width, height, max_dimension);

    // Check if resizing is needed
    if new_width == width && new_height == height {
        return img.clone();
    }

    println!(
        "Resizing screenshot from {}x{} to {}x{}",
        width, height, new_width, new_height
    );

    // Resize using Lanczos3 filter for good quality
    image::imageops::resize(img, new_width, new_height, FilterType::Lanczos3)
}

/// Screenshot result containing the base64 image and dimensions
#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    pub native_image: Arc<RgbaImage>,
    pub fingerprint: Vec<u8>,
    pub base64_image: String,
    pub image_width: u32,
    pub image_height: u32,
    pub actual_screen_width: u32,
    pub actual_screen_height: u32,
    pub geometry: ScreenGeometry,
}

/// A full-resolution capture of the primary monitor.
struct NativeCapture {
    image: RgbaImage,
    geometry: ScreenGeometry,
}

fn capture_native() -> Result<NativeCapture, ScreenshotError> {
    let screen = primary_monitor()?;
    let geometry = geometry(&screen)?;
    let image = screen
        .capture_image()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    let image = RgbaImage::from_raw(image.width(), image.height(), image.into_raw())
        .ok_or_else(|| ScreenshotError::EncodeError("Failed to create RGBA image".to_string()))?;
    if (image.width(), image.height()) != (geometry.width, geometry.height) {
        return Err(ScreenshotError::CaptureError(
            "Captured image and monitor geometry differ; capture again".into(),
        ));
    }
    Ok(NativeCapture { image, geometry })
}

pub fn fingerprint(image: &RgbaImage) -> Vec<u8> {
    image::imageops::thumbnail(image, FINGERPRINT_SIZE.0, FINGERPRINT_SIZE.1)
        .pixels()
        .map(|p| {
            let [r, g, b, _] = p.0;
            ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8
        })
        .collect()
}

/// Fraction of fingerprint cells that changed between two captures (1.0 when
/// they cannot be compared).
pub fn changed_fraction(a: &[u8], b: &[u8]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 1.0;
    }
    let changed = a
        .iter()
        .zip(b)
        .filter(|(x, y)| x.abs_diff(**y) > CELL_DELTA)
        .count();
    changed as f64 / a.len() as f64
}

/// Wait for animations and page loads to finish: poll until two consecutive
/// frames match, the timeout passes, or the run is cancelled.
pub fn wait_until_stable(
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), ScreenshotError> {
    if timeout.is_zero() {
        return Ok(());
    }
    let deadline = Instant::now() + timeout;
    let mut previous = fingerprint(&capture_native()?.image);
    while Instant::now() < deadline && !cancel.is_cancelled() {
        std::thread::sleep(SETTLE_POLL);
        let next = fingerprint(&capture_native()?.image);
        if changed_fraction(&previous, &next) < STABLE_FRACTION {
            break;
        }
        previous = next;
    }
    Ok(())
}

/// Capture a screenshot of the primary screen and return it with metadata
/// max_dimension: Optional maximum dimension for resizing. If None, uses DEFAULT_MAX_SCREENSHOT_DIMENSION.
pub fn capture_screen_with_metadata(
    max_dimension: Option<u32>,
) -> Result<ScreenshotResult, ScreenshotError> {
    let max_dim = checked_dimension(max_dimension.unwrap_or(DEFAULT_MAX_SCREENSHOT_DIMENSION))?;
    let NativeCapture {
        image: rgba_image,
        geometry,
    } = capture_native()?;
    let actual_width = geometry.width;
    let actual_height = geometry.height;

    // Resize the image to reduce token usage
    let resized = resize_image(&rgba_image, max_dim);
    let image_width = resized.width();
    let image_height = resized.height();

    // Convert to PNG bytes
    let mut buffer = Vec::new();
    let encoder = PngEncoder::new(&mut buffer);
    encoder
        .write_image(
            resized.as_raw(),
            image_width,
            image_height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| ScreenshotError::EncodeError(e.to_string()))?;

    // Encode as base64
    let base64_image = STANDARD.encode(&buffer);

    println!(
        "Screenshot captured: {}x{} (actual: {}x{}), {} bytes base64",
        image_width,
        image_height,
        actual_width,
        actual_height,
        base64_image.len()
    );

    Ok(ScreenshotResult {
        fingerprint: fingerprint(&rgba_image),
        native_image: Arc::new(rgba_image),
        base64_image,
        image_width,
        image_height,
        actual_screen_width: actual_width,
        actual_screen_height: actual_height,
        geometry,
    })
}

/// A zoomed-in crop of the screen, plus the crop's geometry expressed as
/// fractions of the full screen so callers can map crop-local coordinates back
/// to full-screen coordinates.
#[derive(Debug, Clone)]
pub struct ZoomCrop {
    pub base64_image: String,
    pub image_width: u32,
    pub image_height: u32,
    /// Crop origin as a fraction of the full capture, [0,1].
    pub origin_fx: f64,
    pub origin_fy: f64,
    /// Crop size as a fraction of the full capture, (0,1].
    pub frac_w: f64,
    pub frac_h: f64,
}

/// Resize so the longer side equals `max_dimension`, preserving aspect ratio.
/// Unlike `resize_image` this also UPSCALES — a small crop is magnified so the
/// target spans many more patches than it did in the full frame (the whole
/// point of the zoom pass).
fn resize_to_max(img: RgbaImage, max_dimension: u32) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return img;
    }
    let (new_w, new_h) = if w >= h {
        let ratio = max_dimension as f64 / w as f64;
        (max_dimension, ((h as f64 * ratio).round() as u32).max(1))
    } else {
        let ratio = max_dimension as f64 / h as f64;
        (((w as f64 * ratio).round() as u32).max(1), max_dimension)
    };
    if new_w == w && new_h == h {
        return img;
    }
    image::imageops::resize(&img, new_w, new_h, FilterType::Lanczos3)
}

/// Magnify the original native capture around an approximate point. Never
/// recapture mid-decision: both grounding passes must see the same observation.
pub fn zoom_crop(
    image: &RgbaImage,
    center_fx: f64,
    center_fy: f64,
    crop_frac: f64,
    max_dimension: u32,
) -> Result<ZoomCrop, ScreenshotError> {
    if !center_fx.is_finite() || !center_fy.is_finite() || !crop_frac.is_finite() {
        return Err(ScreenshotError::CaptureError(
            "Invalid crop geometry".into(),
        ));
    }
    let max_dimension = checked_dimension(max_dimension)?;
    let full_w = image.width();
    let full_h = image.height();
    if full_w < 2 || full_h < 2 {
        return Err(ScreenshotError::CaptureError(
            "Invalid source image dimensions".into(),
        ));
    }

    let crop_frac = crop_frac.clamp(0.05, 1.0);
    let cw = (((full_w as f64) * crop_frac).round() as u32).clamp(1, full_w);
    let ch = (((full_h as f64) * crop_frac).round() as u32).clamp(1, full_h);

    // Center on the point, then shift the window so it stays within bounds.
    let cx = (center_fx.clamp(0.0, 1.0) * (full_w - 1) as f64).round() as i64;
    let cy = (center_fy.clamp(0.0, 1.0) * (full_h - 1) as f64).round() as i64;
    let x0 = (cx - cw as i64 / 2).clamp(0, (full_w - cw) as i64) as u32;
    let y0 = (cy - ch as i64 / 2).clamp(0, (full_h - ch) as i64) as u32;

    let cropped = image::imageops::crop_imm(image, x0, y0, cw, ch).to_image();
    let zoomed = resize_to_max(cropped, max_dimension);
    let (zw, zh) = (zoomed.width(), zoomed.height());

    let mut buffer = Vec::new();
    PngEncoder::new(&mut buffer)
        .write_image(zoomed.as_raw(), zw, zh, image::ExtendedColorType::Rgba8)
        .map_err(|e| ScreenshotError::EncodeError(e.to_string()))?;
    let base64_image = STANDARD.encode(&buffer);

    Ok(ZoomCrop {
        base64_image,
        image_width: zw,
        image_height: zh,
        origin_fx: x0 as f64 / (full_w - 1) as f64,
        origin_fy: y0 as f64 / (full_h - 1) as f64,
        frac_w: (cw - 1) as f64 / (full_w - 1) as f64,
        frac_h: (ch - 1) as f64 / (full_h - 1) as f64,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenGeometry {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

fn primary_monitor() -> Result<Monitor, ScreenshotError> {
    Monitor::all()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or(ScreenshotError::NoScreens)
}

fn geometry(m: &Monitor) -> Result<ScreenGeometry, ScreenshotError> {
    let err = |e: xcap::XCapError| ScreenshotError::CaptureError(e.to_string());
    Ok(ScreenGeometry {
        id: m.id().map_err(err)?,
        width: m.width().map_err(err)?,
        height: m.height().map_err(err)?,
        x: m.x().map_err(err)?,
        y: m.y().map_err(err)?,
    })
}

pub fn get_screen_geometry() -> Result<ScreenGeometry, ScreenshotError> {
    geometry(&primary_monitor()?)
}

fn checked_dimension(value: u32) -> Result<u32, ScreenshotError> {
    if !(256..=3840).contains(&value) {
        return Err(ScreenshotError::CaptureError(
            "Screenshot size must be between 256 and 3840".into(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_maps_edges_back_to_physical_pixels_without_changing_the_frame() {
        let original = RgbaImage::from_pixel(1920, 1080, image::Rgba([20, 80, 140, 255]));
        for (x, y) in [(0.0, 0.0), (1.0, 1.0), (0.146, 0.9)] {
            let crop = zoom_crop(&original, x, y, 0.3, 1280).unwrap();
            let decoded = image::load_from_memory(&STANDARD.decode(&crop.base64_image).unwrap())
                .unwrap()
                .into_rgba8();
            assert_eq!(decoded.get_pixel(0, 0), original.get_pixel(0, 0));
            assert_eq!(
                decoded.get_pixel(decoded.width() / 2, decoded.height() / 2),
                original.get_pixel(0, 0)
            ); // No reticle alters the evidence.
            assert_eq!((decoded.width(), decoded.height()), (1280, 720));
            let start_x = (crop.origin_fx * 1919.0).round();
            let end_x = ((crop.origin_fx + crop.frac_w) * 1919.0).round();
            let start_y = (crop.origin_fy * 1079.0).round();
            let end_y = ((crop.origin_fy + crop.frac_h) * 1079.0).round();
            assert_eq!(end_x - start_x, 575.0);
            assert_eq!(end_y - start_y, 323.0);
            assert!(start_x >= 0.0 && end_x <= 1919.0 && start_y >= 0.0 && end_y <= 1079.0);
            if x == 1.0 {
                assert_eq!((end_x, end_y), (1919.0, 1079.0));
            }
        }
    }
    #[test]
    fn fingerprint_separates_visible_changes_from_pixel_noise() {
        let screen = RgbaImage::from_pixel(1920, 1080, image::Rgba([240, 240, 240, 255]));
        let base = fingerprint(&screen);
        assert_eq!(base.len(), 240 * 135);
        assert_eq!(changed_fraction(&base, &fingerprint(&screen)), 0.0);

        let mut pixel = screen.clone();
        pixel.put_pixel(700, 400, image::Rgba([0, 0, 0, 255]));
        assert!(changed_fraction(&base, &fingerprint(&pixel)) < STABLE_FRACTION);

        let mut button = screen.clone();
        for y in 500..520 {
            for x in 900..940 {
                button.put_pixel(x, y, image::Rgba([30, 90, 200, 255]));
            }
        }
        assert!(changed_fraction(&base, &fingerprint(&button)) >= STABLE_FRACTION);
        assert_eq!(changed_fraction(&base, &[]), 1.0);
    }
    #[test]
    #[ignore = "Requires an interactive Windows desktop; captures only, never sends input"]
    fn capture_primary_monitor_smoke() {
        let shot = capture_screen_with_metadata(Some(1280)).unwrap();
        let decoded =
            image::load_from_memory(&STANDARD.decode(shot.base64_image).unwrap()).unwrap();
        assert_eq!(
            (decoded.width(), decoded.height()),
            (shot.image_width, shot.image_height)
        );
        assert!(shot.image_width <= 1280 && shot.image_height <= 1280);
        assert!(shot.geometry.width > 0 && shot.geometry.height > 0);
        assert_eq!(shot.geometry, get_screen_geometry().unwrap());
    }
}
