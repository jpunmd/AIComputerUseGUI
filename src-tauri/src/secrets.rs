//! API keys live in the operating system's credential store (Windows
//! Credential Manager), never in settings, sessions or exports. The webview
//! can save or remove a key but has no command that reads one back.
//!
//! A key is filed under the origin (scheme, host and port) of the endpoint it
//! was saved for, and is only ever attached to requests for that origin.
//! Pointing the app at a different server therefore sends no key.

use std::net::IpAddr;

pub const MAX_KEY_CHARS: usize = 512;

/// A secret that never appears in `Debug` output or logs.
#[derive(Clone, PartialEq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Accepts what a provider issues: printable ASCII without spaces. This
    /// also keeps line breaks out of the HTTP header the key is sent in.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let key = raw.trim();
        if key.is_empty() {
            return Err("Enter an API key".into());
        }
        if key.chars().count() > MAX_KEY_CHARS {
            return Err(format!(
                "API keys are limited to {MAX_KEY_CHARS} characters"
            ));
        }
        if !key.chars().all(|c| c.is_ascii_graphic()) {
            return Err(
                "API keys cannot contain spaces, line breaks or non-ASCII characters".into(),
            );
        }
        Ok(Self(key.into()))
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

fn is_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            // Loopback, unique-local (fc00::/7) and link-local (fe80::/10).
            ip.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
        Err(_) => false,
    }
}

/// A key may travel over plain HTTP only to this machine or a private network
/// address. Anywhere else it would cross the network unencrypted.
pub fn require_safe_transport(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() == "https" || url.host_str().is_some_and(is_private_host) {
        return Ok(());
    }
    Err(format!(
        "An API key is only sent over HTTPS, or over HTTP to this computer or a private network address. Use https:// for {}.",
        url.host_str().unwrap_or("this server")
    ))
}

/// The credential-store account for an endpoint: its origin.
pub fn account(endpoint: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(endpoint.trim()).map_err(|_| "Invalid API endpoint")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Invalid API endpoint".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn save(endpoint: &str, key: &str) -> Result<(), String> {
    let key = ApiKey::parse(key)?;
    let account = account(endpoint)?;
    require_safe_transport(&reqwest::Url::parse(&account).map_err(|_| "Invalid API endpoint")?)?;
    store::write(&account, key.expose())
}

pub fn load(endpoint: &str) -> Result<Option<ApiKey>, String> {
    // A stored value that no longer parses is treated as absent, never sent.
    Ok(store::read(&account(endpoint)?)?.and_then(|key| ApiKey::parse(&key).ok()))
}

pub fn remove(endpoint: &str) -> Result<(), String> {
    store::delete(&account(endpoint)?)
}

#[cfg(windows)]
mod store {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn target(account: &str) -> Vec<u16> {
        wide(&format!("AI Computer Use API key:{account}"))
    }

    fn failure(what: &str) -> String {
        // SAFETY: reads the calling thread's last-error value.
        let code = unsafe { GetLastError() };
        format!("Could not {what} the API key in Windows Credential Manager (error {code})")
    }

    pub fn write(account: &str, key: &str) -> Result<(), String> {
        let mut target = target(account);
        let mut user = wide(account);
        let mut blob = key.as_bytes().to_vec();
        // SAFETY: CREDENTIALW is plain data; zero is a valid "unset" value for
        // every field not assigned below.
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_mut_ptr();
        credential.UserName = user.as_mut_ptr();
        credential.CredentialBlobSize = blob.len() as u32;
        credential.CredentialBlob = blob.as_mut_ptr();
        // Stays on this computer for this Windows user; not roamed.
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        // SAFETY: every pointer refers to a buffer that outlives the call.
        let saved = unsafe { CredWriteW(&credential, 0) } != 0;
        let result = if saved { Ok(()) } else { Err(failure("save")) };
        blob.fill(0);
        result
    }

    pub fn read(account: &str) -> Result<Option<String>, String> {
        let target = target(account);
        let mut credential: *mut CREDENTIALW = null_mut();
        // SAFETY: target is NUL-terminated; credential receives an allocation
        // that is released with CredFree below.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            // SAFETY: reads the calling thread's last-error value.
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(failure("read"))
            };
        }
        // SAFETY: on success the pointer is a valid CREDENTIALW whose blob is
        // CredentialBlobSize bytes long (or null when empty).
        let key = unsafe {
            let entry = &*credential;
            let bytes = if entry.CredentialBlob.is_null() {
                &[][..]
            } else {
                std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize)
            };
            let key = String::from_utf8(bytes.to_vec()).ok();
            CredFree(credential as *const _);
            key
        };
        Ok(key)
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let target = target(account);
        // SAFETY: target is NUL-terminated.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
            return Ok(());
        }
        // Removing a key that isn't there is not an error.
        // SAFETY: reads the calling thread's last-error value.
        if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Ok(())
        } else {
            Err(failure("remove"))
        }
    }
}

#[cfg(not(windows))]
mod store {
    const UNSUPPORTED: &str = "Saving API keys is supported on Windows only";

    pub fn write(_account: &str, _key: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn read(_account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_account: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_filed_by_origin_so_another_host_gets_none() {
        assert_eq!(
            account("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com"
        );
        // Path and default port don't change the account; host, scheme and
        // an explicit port do.
        assert_eq!(
            account("https://API.OpenAI.com:443/v1/").unwrap(),
            "https://api.openai.com"
        );
        assert_eq!(
            account("http://localhost:8889/v1").unwrap(),
            "http://localhost:8889"
        );
        assert_ne!(
            account("https://api.openai.com.evil.example/v1").unwrap(),
            account("https://api.openai.com/v1").unwrap()
        );
        assert_ne!(
            account("http://localhost:8000/v1").unwrap(),
            account("http://localhost:8889/v1").unwrap()
        );
        for bad in ["", "not a url", "file:///c:/keys", "ftp://host/v1"] {
            assert!(account(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_only_travel_encrypted_or_on_a_private_network() {
        let allowed = |url: &str| require_safe_transport(&reqwest::Url::parse(url).unwrap());
        for url in [
            "https://openrouter.ai/api/v1",
            "http://localhost:8889/v1",
            "http://llm.localhost/v1",
            "http://127.0.0.1:8000/v1",
            "http://[::1]:8000/v1",
            "http://192.168.1.20:8000/v1",
            "http://10.0.0.5/v1",
            "http://172.16.4.4/v1",
            "http://[fd00::1]/v1",
        ] {
            assert!(allowed(url).is_ok(), "{url}");
        }
        for url in [
            "http://api.openai.com/v1",
            "http://8.8.8.8/v1",
            "http://172.32.0.1/v1",
            "http://localhost.evil.example/v1",
            "http://[2001:db8::1]/v1",
        ] {
            assert!(allowed(url).unwrap_err().contains("HTTPS"), "{url}");
        }
        assert!(save("http://api.openai.com/v1", "sk-test")
            .unwrap_err()
            .contains("HTTPS"));
    }

    #[test]
    fn keys_are_validated_and_never_printed() {
        assert_eq!(
            ApiKey::parse("  sk-abc_123  ").unwrap().expose(),
            "sk-abc_123"
        );
        for bad in ["", "   ", "sk abc", "sk-abc\r\nX-Injected: 1", "clé"] {
            assert!(ApiKey::parse(bad).is_err(), "{bad:?}");
        }
        assert!(ApiKey::parse(&"k".repeat(MAX_KEY_CHARS + 1)).is_err());
        let key = ApiKey::parse("sk-secret-value").unwrap();
        assert!(!format!("{key:?}").contains("secret"));
    }

    #[test]
    #[ignore = "Writes a throwaway entry to the real Windows Credential Manager"]
    fn credential_store_round_trip() {
        let endpoint = "https://credential-test.invalid/v1";
        remove(endpoint).unwrap();
        assert_eq!(load(endpoint).unwrap(), None);
        save(endpoint, "sk-round-trip-1").unwrap();
        save(endpoint, "sk-round-trip-2").unwrap();
        assert_eq!(load(endpoint).unwrap().unwrap().expose(), "sk-round-trip-2");
        // Another origin sees nothing.
        assert_eq!(load("https://other-test.invalid/v1").unwrap(), None);
        remove(endpoint).unwrap();
        remove(endpoint).unwrap();
        assert_eq!(load(endpoint).unwrap(), None);
    }
}
