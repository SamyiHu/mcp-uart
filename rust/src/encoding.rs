//! Byte ↔ text conversion.
//!
//! Same set the Node build advertises: utf8/ascii/latin1/gbk/gb2312/gb18030/
//! big5/shift_jis/euc-kr plus the two binary flavours (hex/base64).

use base64::Engine as _;
use encoding_rs::{BIG5, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_8, WINDOWS_1252};

/// Decode bytes into the display string for one frame.
pub fn decode(bytes: &[u8], encoding: &str) -> String {
    match encoding.to_ascii_lowercase().as_str() {
        "hex" | "binary" => hex_upper(bytes),
        "base64" => base64::engine::general_purpose::STANDARD.encode(bytes),
        "ascii" => bytes
            .iter()
            .map(|b| if *b < 0x80 { *b as char } else { '.' })
            .collect::<String>(),
        "latin1" | "iso-8859-1" => WINDOWS_1252
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
        "gbk" => GBK.decode_without_bom_handling(bytes).0.into_owned(),
        "gb2312" => GBK.decode_without_bom_handling(bytes).0.into_owned(),
        "gb18030" => GB18030.decode_without_bom_handling(bytes).0.into_owned(),
        "big5" => BIG5.decode_without_bom_handling(bytes).0.into_owned(),
        "shift_jis" => SHIFT_JIS.decode_without_bom_handling(bytes).0.into_owned(),
        "euc-kr" => EUC_KR.decode_without_bom_handling(bytes).0.into_owned(),
        _ => UTF_8.decode_without_bom_handling(bytes).0.into_owned(),
    }
}

/// Encode user input into bytes for the port.
pub fn encode(text: &str, encoding: &str) -> Vec<u8> {
    match encoding.to_ascii_lowercase().as_str() {
        "hex" | "binary" => parse_hex(text),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .unwrap_or_default(),
        "latin1" | "iso-8859-1" => text
            .chars()
            .map(|c| if (c as u32) < 256 { c as u8 } else { b'?' })
            .collect(),
        "gbk" | "gb2312" => GBK.encode(text).0.into_owned(),
        "gb18030" => GB18030.encode(text).0.into_owned(),
        "big5" => BIG5.encode(text).0.into_owned(),
        "shift_jis" => SHIFT_JIS.encode(text).0.into_owned(),
        "euc-kr" => EUC_KR.encode(text).0.into_owned(),
        _ => text.as_bytes().to_vec(),
    }
}

pub fn hex_upper(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02X}", b));
    }
    out
}

pub fn parse_hex(text: &str) -> Vec<u8> {
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16);
        let lo = (bytes[i + 1] as char).to_digit(16);
        match (hi, lo) {
            (Some(h), Some(l)) => out.push(((h << 4) | l) as u8),
            _ => return out,
        }
        i += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip() {
        let text = "温度过高";
        let bytes = encode(text, "gbk");
        assert_eq!(bytes.len(), text.chars().count() * 2);
        assert_eq!(decode(&bytes, "gbk"), text);
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(hex_upper(&[0x4c, 0x49]), "4C49");
        assert_eq!(parse_hex("4C 49"), vec![0x4c, 0x49]);
    }
}
