use crate::storage::Result;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

pub fn physical_rect(
    s: &Selection,
    image_width: u32,
    image_height: u32,
) -> Result<(u32, u32, u32, u32)> {
    if [s.x1, s.y1, s.x2, s.y2, s.viewport_width, s.viewport_height]
        .iter()
        .any(|n| !n.is_finite())
        || s.viewport_width <= 0.0
        || s.viewport_height <= 0.0
        || image_width == 0
        || image_height == 0
    {
        return Err("The screen selection was invalid. Try selecting the area again.".into());
    }
    let x_scale = image_width as f64 / s.viewport_width;
    let y_scale = image_height as f64 / s.viewport_height;
    let left = (s.x1.min(s.x2) * x_scale)
        .floor()
        .clamp(0.0, image_width as f64) as u32;
    let top = (s.y1.min(s.y2) * y_scale)
        .floor()
        .clamp(0.0, image_height as f64) as u32;
    let right = (s.x1.max(s.x2) * x_scale)
        .ceil()
        .clamp(0.0, image_width as f64) as u32;
    let bottom = (s.y1.max(s.y2) * y_scale)
        .ceil()
        .clamp(0.0, image_height as f64) as u32;
    if right <= left || bottom <= top {
        return Err("Drag to select an area with a width and height".into());
    }
    Ok((left, top, right - left, bottom - top))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scale_reversed_and_secondary_local_coordinates() {
        for (scale, expected) in [
            (1.0, (100, 50, 100, 50)),
            (1.25, (125, 62, 125, 63)),
            (1.5, (150, 75, 150, 75)),
            (2.0, (200, 100, 200, 100)),
        ] {
            let s = Selection {
                x1: 200.0,
                y1: 100.0,
                x2: 100.0,
                y2: 50.0,
                viewport_width: 1920.0 / scale,
                viewport_height: 1080.0 / scale,
            };
            assert_eq!(physical_rect(&s, 1920, 1080).unwrap(), expected);
        }
    }
    #[test]
    fn clamp_and_reject_empty_nan() {
        let mut s = Selection {
            x1: -20.0,
            y1: -20.0,
            x2: 300.0,
            y2: 300.0,
            viewport_width: 200.0,
            viewport_height: 200.0,
        };
        assert_eq!(physical_rect(&s, 200, 200).unwrap(), (0, 0, 200, 200));
        s.x1 = 300.0;
        assert!(physical_rect(&s, 200, 200).is_err());
        s.x1 = f64::NAN;
        assert!(physical_rect(&s, 200, 200).is_err());
    }
}
