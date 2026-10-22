use crate::storage::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Coordinates use the screenshot's 1000 × 680 SVG space, independent of display DPI.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub id: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub x2: f64,
    #[serde(default)]
    pub y2: f64,
    #[serde(default)]
    pub points: Vec<[f64; 2]>,
    #[serde(default)]
    pub text: String,
}

pub fn validate(items: &[Annotation]) -> Result<()> {
    if items.len() > 500 {
        return Err("Use fewer than 500 annotations per screenshot".into());
    }
    let mut ids = HashSet::new();
    let mut points = 0;
    let valid_point = |x: f64, y: f64| {
        x.is_finite() && y.is_finite() && (0.0..=1000.0).contains(&x) && (0.0..=680.0).contains(&y)
    };
    for item in items {
        points += item.points.len();
        if item.id == 0
            || !ids.insert(item.id)
            || !["pen", "arrow", "rectangle", "ellipse", "pin"].contains(&item.kind.as_str())
            || !["#3b73e0", "#d84c54", "#f8fafc", "#18212b"].contains(&item.color.as_str())
            || !valid_point(item.x, item.y)
            || !valid_point(item.x2, item.y2)
            || item.points.iter().any(|p| !valid_point(p[0], p[1]))
            || item.text.chars().count() > 4000
            || points > 25_000
        {
            return Err("Invalid annotation. Keep drawings inside the screenshot and notes under 4,000 characters.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pin() -> Annotation {
        Annotation {
            id: 1,
            kind: "pin".into(),
            color: "#3b73e0".into(),
            x: 200.0,
            y: 300.0,
            x2: 0.0,
            y2: 0.0,
            points: vec![],
            text: "Keep this aligned.".into(),
        }
    }
    #[test]
    fn rejects_invalid_geometry_duplicates_and_style_injection() {
        assert!(validate(&[pin()]).is_ok());
        assert!(validate(&[pin(), pin()]).is_err());
        let mut bad = pin();
        bad.x = f64::NAN;
        assert!(validate(&[bad]).is_err());
        let mut bad = pin();
        bad.points.push([1001.0, 2.0]);
        assert!(validate(&[bad]).is_err());
        let mut bad = pin();
        bad.color = "url(https://example.com)".into();
        assert!(validate(&[bad]).is_err());
    }
}
