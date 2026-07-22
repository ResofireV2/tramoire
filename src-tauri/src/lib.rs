mod commands;
mod model;
mod naming;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::create_project,
            commands::read_scene,
            commands::write_scene,
            commands::rename_scene,
            commands::move_scene,
            commands::create_scene,
            commands::delete_scene,
            commands::create_act,
            commands::rename_act,
            commands::move_act,
            commands::delete_act,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
