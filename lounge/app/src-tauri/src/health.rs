use std::fmt::Write;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

const PROOF_CONTEXT: &str = "agent-lounge-health:";

pub fn challenge() -> Option<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(hex(&bytes))
}

pub fn proof(token: &str, challenge: &str) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
    mac.update(PROOF_CONTEXT.as_bytes());
    mac.update(challenge.as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

pub fn proves_identity(body: &str, token: &str, challenge: &str) -> bool {
    let Ok(reply) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let ok = reply.get("ok").and_then(Value::as_bool) == Some(true);
    let sent = reply.get("proof").and_then(Value::as_str);
    ok && sent.is_some() && sent == proof(token, challenge).as_deref()
}

pub fn encode_fragment_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{challenge, encode_fragment_value, proof, proves_identity};

    // Same as the core's vector.
    const VECTOR: &str = "65cee779e01dcf56e78a50808cfc8953c64bb7ee004ad9e7a4d41b5861861148";

    #[test]
    fn proof_matches_the_core_vector() {
        assert_eq!(proof("secret-token", "abc123").as_deref(), Some(VECTOR));
    }

    #[test]
    fn a_plain_ok_server_is_not_trusted() {
        assert!(!proves_identity(r#"{"ok":true}"#, "secret-token", "abc123"));
    }

    #[test]
    fn a_wrong_proof_is_not_trusted() {
        let body = r#"{"ok":true,"proof":"00"}"#;
        assert!(!proves_identity(body, "secret-token", "abc123"));
    }

    #[test]
    fn the_right_proof_is_trusted() {
        let body = format!(r#"{{"ok":true,"proof":"{VECTOR}"}}"#);
        assert!(proves_identity(&body, "secret-token", "abc123"));
        assert!(!proves_identity(&body, "other-token", "abc123"));
        assert!(!proves_identity(&body, "secret-token", "abc124"));
    }

    #[test]
    fn challenges_are_fresh_hex() {
        let first = challenge().expect("challenge");
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(Some(first), challenge());
    }

    #[test]
    fn fragment_values_are_percent_encoded() {
        assert_eq!(
            encode_fragment_value("a+b&c#d%e f"),
            "a%2Bb%26c%23d%25e%20f"
        );
        assert_eq!(encode_fragment_value("Az09-._~"), "Az09-._~");
        assert_eq!(encode_fragment_value("é"), "%C3%A9");
    }
}
