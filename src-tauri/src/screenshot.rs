use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::PngEncoder;
use image::ImageEncoder;
use screenshots::Screen;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ScreenshotError {
    #[error("No screens found")]
    NoScreens,
    #[error("Failed to capture screenshot: {0}")]
    CaptureError(String),
    #[error("Failed to encode image: {0}")]
    EncodeError(String),
}

/// Capture a screenshot of the primary screen and return it as a base64-encoded PNG
pub fn capture_screen() -> Result<String, ScreenshotError> {
    // Get all screens
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Get the primary screen (first one)
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    // Capture the screenshot
    let image = screen
        .capture()
        .map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    
    // Convert to PNG bytes
    let mut buffer = Vec::new();
    let encoder = PngEncoder::new(&mut buffer);
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| ScreenshotError::EncodeError(e.to_string()))?;
    
    // Encode as base64
    let base64_image = STANDARD.encode(&buffer);
    
    Ok(base64_image)
}

/// Get screen dimensions
pub fn get_screen_dimensions() -> Result<(u32, u32), ScreenshotError> {
    let screens = Screen::all().map_err(|e| ScreenshotError::CaptureError(e.to_string()))?;
    let screen = screens.first().ok_or(ScreenshotError::NoScreens)?;
    
    Ok((screen.display_info.width, screen.display_info.height))
}
