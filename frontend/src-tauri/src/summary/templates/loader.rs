use super::defaults;
use super::types::Template;
use std::path::PathBuf;
use tracing::{debug, info, warn};
use once_cell::sync::Lazy;
use std::sync::RwLock;

// Global storage for the bundled templates directory path
static BUNDLED_TEMPLATES_DIR: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// Set the bundled templates directory path (called once at app startup)
pub fn set_bundled_templates_dir(path: PathBuf) {
    info!("Bundled templates directory set to: {:?}", path);
    if let Ok(mut dir) = BUNDLED_TEMPLATES_DIR.write() {
        *dir = Some(path);
    }
}

/// Get the user's custom templates directory path
///
/// Returns the platform-specific application data directory for custom templates:
/// - macOS: ~/Library/Application Support/Meetily/templates/
/// - Windows: %APPDATA%\Meetily\templates\
/// - Linux: ~/.config/Meetily/templates/
fn get_custom_templates_dir() -> Option<PathBuf> {
    let mut path = dirs::data_dir()?;
    path.push("Meetily");
    path.push("templates");
    Some(path)
}

/// Load a template from the bundled resources directory
///
/// # Arguments
/// * `template_id` - Template identifier (without .json extension)
///
/// # Returns
/// The template JSON content if found, None otherwise
fn load_bundled_template(template_id: &str) -> Option<String> {
    let bundled_dir = BUNDLED_TEMPLATES_DIR.read().ok()?.clone()?;
    let template_path = bundled_dir.join(format!("{}.json", template_id));

    debug!("Checking for bundled template at: {:?}", template_path);

    match std::fs::read_to_string(&template_path) {
        Ok(content) => {
            info!("Loaded bundled template '{}' from {:?}", template_id, template_path);
            Some(content)
        }
        Err(e) => {
            debug!("No bundled template '{}' found: {}", template_id, e);
            None
        }
    }
}

/// Load a template from the user's custom templates directory
///
/// # Arguments
/// * `template_id` - Template identifier (without .json extension)
///
/// # Returns
/// The template JSON content if found, None otherwise
fn load_custom_template(template_id: &str) -> Option<String> {
    let custom_dir = get_custom_templates_dir()?;
    let template_path = custom_dir.join(format!("{}.json", template_id));

    debug!("Checking for custom template at: {:?}", template_path);

    match std::fs::read_to_string(&template_path) {
        Ok(content) => {
            info!("Loaded custom template '{}' from {:?}", template_id, template_path);
            Some(content)
        }
        Err(e) => {
            debug!("No custom template '{}' found: {}", template_id, e);
            None
        }
    }
}

/// Load and parse a template by identifier
///
/// This function implements a fallback strategy:
/// 1. Check user's custom templates directory
/// 2. Check bundled resources directory (app templates)
/// 3. Fall back to built-in embedded templates
/// 4. Return error if not found in any location
///
/// # Arguments
/// * `template_id` - Template identifier (e.g., "daily_standup", "standard_meeting")
///
/// # Returns
/// Parsed and validated Template struct
pub fn get_template(template_id: &str) -> Result<Template, String> {
    info!("Loading template: {}", template_id);

    // Try custom template first, then bundled, then built-in
    let json_content = if let Some(custom_content) = load_custom_template(template_id) {
        debug!("Using custom template for '{}'", template_id);
        custom_content
    } else if let Some(bundled_content) = load_bundled_template(template_id) {
        debug!("Using bundled template for '{}'", template_id);
        bundled_content
    } else if let Some(builtin_content) = defaults::get_builtin_template(template_id) {
        debug!("Using built-in template for '{}'", template_id);
        builtin_content.to_string()
    } else {
        return Err(format!(
            "Template '{}' not found. Available templates: {}",
            template_id,
            list_template_ids().join(", ")
        ));
    };

    // Parse and validate
    validate_and_parse_template(&json_content)
}

/// Validate and parse template JSON
///
/// # Arguments
/// * `json_content` - Raw JSON string
///
/// # Returns
/// Parsed and validated Template struct
pub fn validate_and_parse_template(json_content: &str) -> Result<Template, String> {
    let template: Template = serde_json::from_str(json_content)
        .map_err(|e| format!("Failed to parse template JSON: {}", e))?;

    template.validate()?;

    Ok(template)
}

/// List all available template identifiers
///
/// Returns a combined list of:
/// - Built-in template IDs
/// - Bundled template IDs (from app resources)
/// - Custom template IDs (from user's data directory)
pub fn list_template_ids() -> Vec<String> {
    let mut ids: Vec<String> = defaults::list_builtin_template_ids()
        .into_iter()
        .map(|s| s.to_string())
        .collect();

    // Add bundled templates if directory is set
    if let Ok(bundled_dir_lock) = BUNDLED_TEMPLATES_DIR.read() {
        if let Some(bundled_dir) = bundled_dir_lock.as_ref() {
            if bundled_dir.exists() {
                match std::fs::read_dir(bundled_dir) {
                    Ok(entries) => {
                        for entry in entries.flatten() {
                            if let Some(filename) = entry.file_name().to_str() {
                                if filename.ends_with(".json") {
                                    let id = filename.trim_end_matches(".json").to_string();
                                    if !ids.contains(&id) {
                                        ids.push(id);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Failed to read bundled templates directory: {}", e);
                    }
                }
            }
        }
    }

    // Add custom templates if directory exists
    if let Some(custom_dir) = get_custom_templates_dir() {
        if custom_dir.exists() {
            match std::fs::read_dir(&custom_dir) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        if let Some(filename) = entry.file_name().to_str() {
                            if filename.ends_with(".json") {
                                let id = filename.trim_end_matches(".json").to_string();
                                if !ids.contains(&id) {
                                    ids.push(id);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to read custom templates directory: {}", e);
                }
            }
        }
    }

    // Exclude hidden (deleted) ids and internal files (e.g. _hidden)
    let hidden = read_hidden_ids();
    ids.retain(|id| !id.starts_with('_') && !hidden.contains(id));

    ids.sort();
    ids
}

/// List all available templates with their metadata
///
/// Returns a list of (id, name, description) tuples
pub fn list_templates() -> Vec<(String, String, String)> {
    let mut templates = Vec::new();

    for id in list_template_ids() {
        match get_template(&id) {
            Ok(template) => {
                templates.push((id, template.name, template.description));
            }
            Err(e) => {
                warn!("Failed to load template '{}': {}", id, e);
            }
        }
    }

    templates
}

/// Reject template ids that could escape the templates directory. Ids must be a
/// short slug of ASCII alphanumerics plus `_`/`-`, not starting with `_`
/// (reserved for internal files) and containing no path separators or `..`.
fn validate_template_id(template_id: &str) -> Result<(), String> {
    if template_id.is_empty()
        || template_id.len() > 64
        || template_id.starts_with('_')
        || !template_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("Invalid template id: {:?}", template_id));
    }
    Ok(())
}

/// Path to the file tracking hidden (deleted) built-in/bundled template ids.
fn get_hidden_list_path() -> Option<PathBuf> {
    Some(get_custom_templates_dir()?.join("_hidden.json"))
}

/// Read the set of hidden template ids.
pub fn read_hidden_ids() -> Vec<String> {
    let Some(path) = get_hidden_list_path() else { return Vec::new() };
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_hidden_ids(ids: &[String]) -> Result<(), String> {
    let custom_dir = get_custom_templates_dir().ok_or("No data directory available")?;
    std::fs::create_dir_all(&custom_dir).map_err(|e| format!("Failed to create templates dir: {}", e))?;
    let path = custom_dir.join("_hidden.json");
    let json = serde_json::to_string_pretty(ids).map_err(|e| format!("Failed to serialize hidden list: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write hidden list: {}", e))
}

/// Save (create or overwrite) a custom template. Validates before writing and
/// un-hides the id if it was previously deleted.
pub fn save_custom_template(template_id: &str, json_content: &str) -> Result<(), String> {
    validate_template_id(template_id)?;
    // Validate content
    validate_and_parse_template(json_content)?;

    let custom_dir = get_custom_templates_dir().ok_or("No data directory available")?;
    std::fs::create_dir_all(&custom_dir).map_err(|e| format!("Failed to create templates dir: {}", e))?;
    let template_path = custom_dir.join(format!("{}.json", template_id));
    std::fs::write(&template_path, json_content).map_err(|e| format!("Failed to write template: {}", e))?;

    // Un-hide if it was hidden
    let mut hidden = read_hidden_ids();
    if let Some(pos) = hidden.iter().position(|h| h == template_id) {
        hidden.remove(pos);
        let _ = write_hidden_ids(&hidden);
    }
    info!("Saved custom template '{}' to {:?}", template_id, template_path);
    Ok(())
}

/// Delete a template. Removes the custom override file (if any) and, when a
/// built-in/bundled template with the same id still exists, records it as hidden
/// so it no longer appears in the list.
pub fn delete_template(template_id: &str) -> Result<(), String> {
    validate_template_id(template_id)?;
    // Remove custom override file if present
    if let Some(custom_dir) = get_custom_templates_dir() {
        let template_path = custom_dir.join(format!("{}.json", template_id));
        if template_path.exists() {
            std::fs::remove_file(&template_path).map_err(|e| format!("Failed to delete template file: {}", e))?;
        }
    }

    // If a bundled/built-in with this id still resolves, hide it
    let still_exists = load_bundled_template(template_id).is_some()
        || defaults::get_builtin_template(template_id).is_some();
    if still_exists {
        let mut hidden = read_hidden_ids();
        if !hidden.iter().any(|h| h == template_id) {
            hidden.push(template_id.to_string());
            write_hidden_ids(&hidden)?;
        }
    }
    info!("Deleted template '{}'", template_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_builtin_template() {
        let template = get_template("daily_standup");
        assert!(template.is_ok());

        let template = template.unwrap();
        assert_eq!(template.name, "Daily Standup");
        assert!(!template.sections.is_empty());
    }

    #[test]
    fn test_get_nonexistent_template() {
        let result = get_template("nonexistent_template");
        assert!(result.is_err());
    }

    #[test]
    fn test_list_template_ids() {
        let ids = list_template_ids();
        assert!(ids.contains(&"daily_standup".to_string()));
        assert!(ids.contains(&"standard_meeting".to_string()));
    }

    #[test]
    fn test_validate_invalid_json() {
        let result = validate_and_parse_template("invalid json");
        assert!(result.is_err());
    }
}
