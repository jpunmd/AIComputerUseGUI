fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "start_run",
            "stop_run",
            "capture_screenshot_with_metadata",
            "process_computer_use",
            "refine_coordinate",
            "prepare_action",
            "approve_action",
            "execute_action",
            "test_api_connection",
            "fetch_available_models",
            "api_key_status",
            "save_api_key",
            "delete_api_key",
            "get_screen_size",
            "export_sessions",
            "list_displays",
            "identify_displays",
        ]),
    ))
    .expect("failed to build application permissions");
}
