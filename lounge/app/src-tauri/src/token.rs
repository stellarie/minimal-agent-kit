use std::fs;
use std::path::Path;

use serde_json::Value;

pub fn read_owner_token(home: &Path) -> Result<String, String> {
    let path = home.join("tokens.json");
    let text = fs::read_to_string(&path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    let tokens: Value = serde_json::from_str(&text)
        .map_err(|err| format!("{} is not JSON: {err}", path.display()))?;
    tokens
        .get("owner")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no owner token", path.display()))
}

#[cfg(test)]
mod tests {
    use super::read_owner_token;
    use crate::test_support::temp_home;
    use std::fs;

    #[test]
    fn reads_the_owner_token() {
        let home = temp_home("token-ok");
        fs::write(home.join("tokens.json"), r#"{"owner":"abc","ada":"def"}"#).expect("write");
        assert_eq!(read_owner_token(&home).expect("token"), "abc");
    }

    #[test]
    fn reports_a_missing_file() {
        let home = temp_home("token-missing");
        let error = read_owner_token(&home).expect_err("no token");
        assert!(error.contains("tokens.json"), "{error}");
    }

    #[test]
    fn reports_a_missing_owner_key() {
        let home = temp_home("token-no-key");
        fs::write(home.join("tokens.json"), r#"{"ada":"def"}"#).expect("write");
        let error = read_owner_token(&home).expect_err("no token");
        assert!(error.contains("owner"), "{error}");
    }
}
