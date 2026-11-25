//! When scheduled tasks run: daily times in a time zone, or a fixed interval.

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Datelike, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// When a task runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Schedule {
    /// At each `HH:MM` of `times`, on `weekdays` (1 = Monday … 7 = Sunday;
    /// empty means every day), in `time_zone`: the user's, set by the device
    /// that saves it.
    #[serde(rename_all = "camelCase")]
    Daily {
        times: Vec<String>,
        #[serde(default)]
        weekdays: Vec<u32>,
        time_zone: Tz,
    },
    /// Every `minutes`, counted from the task's creation.
    Interval { minutes: u32 },
}

impl Schedule {
    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Daily {
                times, weekdays, ..
            } => {
                if times.is_empty() {
                    bail!("schedule.times must not be empty");
                }
                for time in times {
                    parse_time(time)?;
                }
                if weekdays.iter().any(|day| !(1..=7).contains(day)) {
                    bail!("schedule.weekdays must be 1 (Monday) to 7 (Sunday)");
                }
            }
            Self::Interval { minutes } => {
                if *minutes < 5 {
                    bail!("schedule.minutes must be at least 5");
                }
            }
        }
        Ok(())
    }

    /// Scheduled times of a daily schedule on the dates `now` plus `days`
    /// (in its time zone); a time skipped by a daylight saving change doesn't
    /// run.
    fn daily_times(&self, now: DateTime<Utc>, days: i64) -> Vec<DateTime<Utc>> {
        let Self::Daily {
            times,
            weekdays,
            time_zone,
        } = self
        else {
            return Vec::new();
        };
        let date = now.with_timezone(time_zone).date_naive() + chrono::Duration::days(days);
        if !weekdays.is_empty() && !weekdays.contains(&date.weekday().number_from_monday()) {
            return Vec::new();
        }
        times
            .iter()
            .filter_map(|time| parse_time(time).ok())
            .filter_map(|time| {
                time_zone
                    .from_local_datetime(&date.and_time(time))
                    .earliest()
            })
            .map(|at| at.with_timezone(&Utc))
            .collect()
    }

    /// The latest scheduled time at or before `now`.
    pub(super) fn previous(
        &self,
        now: DateTime<Utc>,
        created: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        match self {
            Self::Daily { .. } => (0..8).find_map(|days_back| {
                self.daily_times(now, -days_back)
                    .into_iter()
                    .filter(|at| *at <= now)
                    .max()
            }),
            Self::Interval { minutes } => {
                if now < created {
                    return None;
                }
                let step = i64::from(*minutes) * 60;
                let periods = (now - created).num_seconds() / step;
                (periods > 0).then(|| created + chrono::Duration::seconds(periods * step))
            }
        }
    }

    /// The first scheduled time after `now`.
    pub(super) fn next(&self, now: DateTime<Utc>, created: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Daily { .. } => (0..8).find_map(|days_ahead| {
                self.daily_times(now, days_ahead)
                    .into_iter()
                    .filter(|at| *at > now)
                    .min()
            }),
            Self::Interval { minutes } => {
                let step = i64::from(*minutes) * 60;
                if now < created {
                    return Some(created + chrono::Duration::seconds(step));
                }
                let periods = (now - created).num_seconds() / step + 1;
                Some(created + chrono::Duration::seconds(periods * step))
            }
        }
    }
}

fn parse_time(time: &str) -> Result<NaiveTime> {
    NaiveTime::parse_from_str(time, "%H:%M")
        .with_context(|| format!("invalid time {time}, expected HH:MM"))
}

#[cfg(test)]
pub(super) mod tests {
    use serde_json::json;

    use super::*;

    const SHANGHAI: Tz = chrono_tz::Asia::Shanghai;
    const NEW_YORK: Tz = chrono_tz::America::New_York;

    /// A time in Shanghai, where the tests' schedules are.
    pub(in crate::tasks) fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        in_zone(SHANGHAI, y, m, d, h, min)
    }

    fn in_zone(zone: Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        zone.with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .with_timezone(&Utc)
    }

    pub(in crate::tasks) fn daily(times: &[&str], weekdays: &[u32]) -> Schedule {
        daily_in(SHANGHAI, times, weekdays)
    }

    fn daily_in(time_zone: Tz, times: &[&str], weekdays: &[u32]) -> Schedule {
        Schedule::Daily {
            times: times.iter().map(|t| t.to_string()).collect(),
            weekdays: weekdays.to_vec(),
            time_zone,
        }
    }

    #[test]
    fn daily_previous_and_next() {
        let created = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        // 2026-11-16 is a Monday.
        let now = local(2026, 11, 16, 12, 0);
        let schedule = daily(&["09:00", "20:00"], &[]);
        assert_eq!(
            schedule.previous(now, created),
            Some(local(2026, 11, 16, 9, 0))
        );
        assert_eq!(
            schedule.next(now, created),
            Some(local(2026, 11, 16, 20, 0))
        );

        let weekdays = daily(&["09:00"], &[1, 2, 3, 4, 5]);
        let saturday = local(2026, 11, 21, 12, 0);
        assert_eq!(
            weekdays.previous(saturday, created),
            Some(local(2026, 11, 20, 9, 0))
        );
        assert_eq!(
            weekdays.next(saturday, created),
            Some(local(2026, 11, 23, 9, 0))
        );
    }

    #[test]
    fn daily_runs_in_its_time_zone() {
        let created = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        // Monday 09:00 in Shanghai is still Sunday evening in New York.
        let monday = daily(&["09:00"], &[1]);
        let sunday_evening = in_zone(NEW_YORK, 2026, 11, 15, 19, 0);
        assert_eq!(
            monday.next(sunday_evening, created),
            Some(in_zone(NEW_YORK, 2026, 11, 15, 20, 0))
        );
        assert_eq!(
            monday.next(sunday_evening, created),
            Some(local(2026, 11, 16, 9, 0))
        );
    }

    #[test]
    fn daily_follows_daylight_saving() {
        let created = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let schedule = daily_in(NEW_YORK, &["09:00", "02:30"], &[]);
        // 09:00 stays 09:00 in New York across the change on 2026-03-08 (UTC-5
        // to UTC-4).
        let before = in_zone(NEW_YORK, 2026, 3, 7, 10, 0);
        let after = in_zone(NEW_YORK, 2026, 3, 8, 10, 0);
        assert_eq!(
            schedule.previous(before, created),
            Some(Utc.with_ymd_and_hms(2026, 3, 7, 14, 0, 0).unwrap())
        );
        assert_eq!(
            schedule.previous(after, created),
            Some(Utc.with_ymd_and_hms(2026, 3, 8, 13, 0, 0).unwrap())
        );
        // 02:30 doesn't exist that day, so the next run after 09:00 on 03-07 is
        // 09:00 on 03-08.
        assert_eq!(
            schedule.next(in_zone(NEW_YORK, 2026, 3, 7, 9, 30), created),
            Some(in_zone(NEW_YORK, 2026, 3, 8, 9, 0))
        );
    }

    #[test]
    fn interval_counts_from_creation() {
        let created = local(2026, 11, 16, 8, 0);
        let schedule = Schedule::Interval { minutes: 120 };
        assert_eq!(schedule.previous(local(2026, 11, 16, 9, 0), created), None);
        assert_eq!(
            schedule.previous(local(2026, 11, 16, 13, 0), created),
            Some(local(2026, 11, 16, 12, 0))
        );
        assert_eq!(
            schedule.next(local(2026, 11, 16, 13, 0), created),
            Some(local(2026, 11, 16, 14, 0))
        );
    }

    #[test]
    fn schedules_are_validated() {
        assert!(daily(&["9:00"], &[]).validate().is_ok());
        let unknown_zone = json!({ "type": "daily", "times": ["09:00"], "timeZone": "Mars/Base" });
        assert!(serde_json::from_value::<Schedule>(unknown_zone).is_err());
        assert!(daily(&["25:00"], &[]).validate().is_err());
        assert!(daily(&[], &[]).validate().is_err());
        assert!(daily(&["09:00"], &[0]).validate().is_err());
        assert!(Schedule::Interval { minutes: 1 }.validate().is_err());
    }
}
