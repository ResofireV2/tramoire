mod commands;
mod entities;
mod frontmatter;
mod model;
mod naming;
mod paths;
mod settings;

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
            commands::create_chapter,
            commands::rename_chapter,
            commands::move_chapter,
            commands::delete_chapter,
            entities::list_entities,
            entities::create_entity,
            entities::write_entity,
            entities::delete_entity,
            settings::load_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
