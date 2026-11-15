//! Features this host offers clients, set with `--features` and saved in
//! `daemon.json` (e.g. a cloud host without a desktop offers `basic` only).
//! Features are the client's skills; the client assigns each to a group in
//! `peer_attach`, so a listed group offers all its skills, including ones
//! added in later client versions. The daemon knows no skill or group name.

use std::{collections::HashMap, sync::OnceLock};

/// Group of each feature, as the client assigns them.
pub type FeatureGroups = HashMap<String, String>;

/// Offered features and groups; unset or `None` offers everything.
static OFFERED: OnceLock<Option<Vec<String>>> = OnceLock::new();

pub fn init(offered: Option<Vec<String>>) {
    let _ = OFFERED.set(offered);
}

fn offers(offered: Option<&[String]>, feature: &str, groups: &FeatureGroups) -> bool {
    offered.is_none_or(|offered| {
        offered
            .iter()
            .any(|name| name == feature || groups.get(feature) == Some(name))
    })
}

/// Whether this host offers the feature; one in no group is offered only by name.
pub fn allows(feature: &str, groups: &FeatureGroups) -> bool {
    offers(OFFERED.get().cloned().flatten().as_deref(), feature, groups)
}

/// The client's features this host doesn't offer, for it to disable.
pub fn restricted(groups: &FeatureGroups) -> Vec<String> {
    let mut restricted: Vec<String> = groups
        .keys()
        .filter(|feature| !allows(feature, groups))
        .cloned()
        .collect();
    restricted.sort();
    restricted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_listed_features_and_groups() {
        let groups = FeatureGroups::from([
            ("chart".to_string(), "basic".to_string()),
            ("job".to_string(), "desktop".to_string()),
        ]);
        assert!(offers(None, "job", &groups));
        let offered = ["basic".to_string(), "screen".to_string()];
        assert!(offers(Some(&offered), "chart", &groups));
        assert!(!offers(Some(&offered), "job", &groups));
        assert!(offers(Some(&offered), "screen", &groups));
        assert!(!offers(Some(&offered), "map", &groups));
    }
}
