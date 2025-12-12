use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, RgbaImage, imageops::FilterType};
use screenshots::Screen;
use thiserror::Error;

/// Maximum dimension (width or height) for screenshots sent to the model
/// This helps reduce token usage while maintaining enough detail for the model
const MAX_SCREENSHOT_DIMENSION: u32 = 1280;

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
fn calculate_resized_dimensions(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_SCREENSHOT_DIMENSION && height <= MAX_SCREENSHOT_DIMENSION {
        return (width, height);
    }
    
    if width > height {
        let ratio = MAX_SCREENSHOT_DIMENSION as f64 / width as f64;
        (MAX_SCREENSHOT_DIMENSION, (height as f64 * ratio) as u32)
    } else {
        let ratio = MAX_SCREENSHOT_DIMENSION as f64 / height as f64;
        ((width as f64 * ratio) as u32, MAX_SCREENSHOT_DIMENSION)
    }
}

/// Resize an image to fit within MAX_SCREENSHOT_DIMENSION while maintaining aspect ratio
fn resize_image(img: RgbaImage) -> RgbaImage {
    let (width, height) = (img.width(), img.height());
    let (new_width, new_height) = calculate_resized_dimensions(width, height);
    
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
pub fn capture_screen_with_metadata() -> Result<ScreenshotResult, ScreenshotError> {
    // Get all screens
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Get the primary screen (first one)
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    let actual_width = screen.display_info.width;
    let actual_height = screen.display_info.height;
    
    // Capture the screenshot
    let image = screen
        .capture()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Convert to RgbaImage for resizing
    let rgba_image = RgbaImage::from_raw(image.width(), image.height(), image.into_raw())
        .ok_or_else(|| ScreenshotError::EncodeError("Failed to create RGBA image".to_string()))?;
    
    // Resize the image to reduce token usage
    let resized = resize_image(rgba_image);
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
pub fn capture_screen() -> Result<String, ScreenshotError> {
    capture_screen_with_metadata().map(|r| r.base64_image)
}

/// Get screen dimensions (returns actual screen dimensions, not resized)
pub fn get_screen_dimensions() -> Result<(u32, u32), ScreenshotError> {
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    Ok((screen.display_info.width, screen.display_info.height))
}
