use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, RgbaImage, imageops::FilterType};
use screenshots::Screen;
use thiserror::Error;

/// Default maximum dimension (width or height) for screenshots sent to the model
/// This helps reduce token usage while maintaining enough detail for the model
const DEFAULT_MAX_SCREENSHOT_DIMENSION: u32 = 1280;

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
fn resize_image(img: RgbaImage, max_dimension: u32) -> RgbaImage {
    let (width, height) = (img.width(), img.height());
    let (new_width, new_height) = calculate_resized_dimensions(width, height, max_dimension);
    
    // Check if resizing is needed
    if new_width == width && new_height == height {
        return img;
    }
    
    println!("Resizing screenshot from {}x{} to {}x{}", width, height, new_width, new_height);
    
    // Resize using Lanczos3 filter for good quality
    image::imageops::resize(&img, new_width, new_height, FilterType::Lanczos3)
}

/// Screenshot result containing the base64 image and dimensions
#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    pub base64_image: String,
    pub image_width: u32,
    pub image_height: u32,
    pub actual_screen_width: u32,
    pub actual_screen_height: u32,
}

/// Capture a screenshot of the primary screen and return it with metadata
/// max_dimension: Optional maximum dimension for resizing. If None, uses DEFAULT_MAX_SCREENSHOT_DIMENSION.
pub fn capture_screen_with_metadata(max_dimension: Option<u32>) -> Result<ScreenshotResult, ScreenshotError> {
    let max_dim = max_dimension.unwrap_or(DEFAULT_MAX_SCREENSHOT_DIMENSION);
    
    // Get all screens
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Get the primary screen (first one)
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    let actual_width = screen.display_info.width;
    let actual_height = screen.display_info.height;
    let _screen_x = screen.display_info.x;
    let _screen_y = screen.display_info.y;
    
    // Capture the screenshot
    let image = screen
        .capture()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Convert to RgbaImage for resizing
    let rgba_image = RgbaImage::from_raw(image.width(), image.height(), image.into_raw())
        .ok_or_else(|| ScreenshotError::EncodeError("Failed to create RGBA image".to_string()))?;

    // Resize the image to reduce token usage
    let resized = resize_image(rgba_image, max_dim);
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
    
    println!("Screenshot captured: {}x{} (actual: {}x{}), {} bytes base64", 
        image_width, image_height, actual_width, actual_height, base64_image.len());
    
    Ok(ScreenshotResult {
        base64_image,
        image_width,
        image_height,
        actual_screen_width: actual_width,
        actual_screen_height: actual_height,
    })
}

/// Capture a screenshot of the primary screen and return it as a base64-encoded PNG
/// (Legacy function for compatibility)
pub fn capture_screen(max_dimension: Option<u32>) -> Result<String, ScreenshotError> {
    capture_screen_with_metadata(max_dimension).map(|r| r.base64_image)
}

/// A zoomed-in crop of the screen, plus the crop's geometry expressed as
/// fractions of the full screen so callers can map crop-local coordinates back
/// to full-screen coordinates.
#[derive(Debug, Clone)]
pub struct ZoomCrop {
    pub base64_image: String,
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

/// Set a single pixel, ignoring out-of-bounds coordinates.
fn put_px(img: &mut RgbaImage, x: i64, y: i64, color: [u8; 4]) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(x as u32, y as u32, image::Rgba(color));
    }
}

/// Draw a center-gap crosshair centered at (cx, cy). `gap` leaves the exact
/// target pixel uncovered; `len` is the arm length; `thick` adds pixels on each
/// side of the 1px line (thick=1 -> 3px wide).
fn draw_cross(img: &mut RgbaImage, cx: i64, cy: i64, gap: i64, len: i64, thick: i64, color: [u8; 4]) {
    for d in gap..=len {
        for t in -thick..=thick {
            put_px(img, cx + d, cy + t, color); // right arm
            put_px(img, cx - d, cy + t, color); // left arm
            put_px(img, cx + t, cy + d, color); // bottom arm
            put_px(img, cx + t, cy - d, color); // top arm
        }
    }
}

/// Draw a magenta reticle (with a black halo for contrast on any background) at
/// the coarse-prediction point, leaving the center clear so it anchors pass 2
/// on the target without occluding it.
fn draw_reticle(img: &mut RgbaImage, cx: i64, cy: i64) {
    let gap = 7i64;
    let len = 26i64;
    draw_cross(img, cx, cy, gap, len, 2, [0, 0, 0, 255]); // 5px black halo
    draw_cross(img, cx, cy, gap, len, 1, [255, 0, 255, 255]); // 3px magenta
}

/// Capture the screen and return a zoomed crop centered on a normalized point.
/// `center_fx`/`center_fy` are in [0,1]; `crop_frac` is the crop size as a
/// fraction of the full screen (e.g. 0.3 = a 30% window). The window is clamped
/// (shifted, not shrunk) so edge targets stay fully framed, then upscaled to
/// `max_dimension`. Cropping happens on the NATIVE capture, not a downsample,
/// so the model gets real detail it never saw in the coarse pass.
pub fn capture_zoom_crop(
    center_fx: f64,
    center_fy: f64,
    crop_frac: f64,
    max_dimension: u32,
) -> Result<ZoomCrop, ScreenshotError> {
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    let image = screen
        .capture()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;

    let full_w = image.width();
    let full_h = image.height();
    let rgba = RgbaImage::from_raw(full_w, full_h, image.into_raw())
        .ok_or_else(|| ScreenshotError::EncodeError("Failed to create RGBA image".to_string()))?;

    let crop_frac = crop_frac.clamp(0.05, 1.0);
    let cw = (((full_w as f64) * crop_frac).round() as u32).clamp(1, full_w);
    let ch = (((full_h as f64) * crop_frac).round() as u32).clamp(1, full_h);

    // Center on the point, then shift the window so it stays within bounds.
    let cx = (center_fx.clamp(0.0, 1.0) * full_w as f64).round() as i64;
    let cy = (center_fy.clamp(0.0, 1.0) * full_h as f64).round() as i64;
    let x0 = (cx - cw as i64 / 2).clamp(0, (full_w - cw) as i64) as u32;
    let y0 = (cy - ch as i64 / 2).clamp(0, (full_h - ch) as i64) as u32;

    let cropped = image::imageops::crop_imm(&rgba, x0, y0, cw, ch).to_image();
    let mut zoomed = resize_to_max(cropped, max_dimension);
    let (zw, zh) = (zoomed.width(), zoomed.height());

    // Draw a reticle at the coarse point so pass 2 has a visual anchor on the
    // intended target — robust even when edge-clamping pushed the target away
    // from the crop center.
    let lx = ((cx - x0 as i64) as f64 / cw as f64).clamp(0.0, 1.0);
    let ly = ((cy - y0 as i64) as f64 / ch as f64).clamp(0.0, 1.0);
    draw_reticle(
        &mut zoomed,
        (lx * zw as f64).round() as i64,
        (ly * zh as f64).round() as i64,
    );

    println!(
        "Zoom crop: center ({:.3},{:.3}) frac {:.2} -> native {}x{} at ({},{}) of {}x{}, upscaled to {}x{}",
        center_fx, center_fy, crop_frac, cw, ch, x0, y0, full_w, full_h, zw, zh
    );

    let mut buffer = Vec::new();
    PngEncoder::new(&mut buffer)
        .write_image(zoomed.as_raw(), zw, zh, image::ExtendedColorType::Rgba8)
        .map_err(|e| ScreenshotError::EncodeError(e.to_string()))?;
    let base64_image = STANDARD.encode(&buffer);

    Ok(ZoomCrop {
        base64_image,
        origin_fx: x0 as f64 / full_w as f64,
        origin_fy: y0 as f64 / full_h as f64,
        frac_w: cw as f64 / full_w as f64,
        frac_h: ch as f64 / full_h as f64,
    })
}

/// Get screen dimensions (returns actual screen dimensions, not resized)
pub fn get_screen_dimensions() -> Result<(u32, u32), ScreenshotError> {
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    Ok((screen.display_info.width, screen.display_info.height))
}
