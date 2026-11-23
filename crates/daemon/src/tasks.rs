//! Scheduled tasks: a prompt the daemon runs on a schedule in a fresh session,
//! unattended. Permission requests and questions go to every device (with a
//! push) and are rejected after `APPROVAL_TIMEOUT`; agents' own "always allow"
//! rules (e.g. Claude Code's project settings) keep known actions from asking.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Datelike, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    acp_agent::{AgentSessionManager, Notifier, SessionContext},
    app_data::{self, AppPaths},
    push::PushKind,
    render_skills::SkillSelection,
};

/// How often the scheduler compares the wall clock with the schedules. Polling
/// the wall clock (instead of sleeping until the next run) also notices runs
/// missed while the computer slept, when monotonic timers stop.
const TICK: Duration = Duration::from_secs(30);
/// A run missed by up to this long (computer asleep, daemon stopped) runs once
/// when the daemon notices; older ones are skipped.
const MISSED_WINDOW: chrono::Duration = chrono::Duration::hours(6);
/// A turn without any update for this long is cancelled (`prompt`'s idle
/// timeout).
const IDLE_TIMEOUT_SECS: u64 = 10 * 60;
/// An unanswered permission request or question is refused after this long.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DEFAULT_TIMEOUT_MINUTES: u32 = 60;
/// Successful runs kept per task; their sessions are deleted with them.
const KEPT_SUCCESSES: usize = 20;
/// Failed runs are kept longer, to look into.
const KEPT_FAILURE_DAYS: i64 = 90;
const SUMMARY_CHARS: usize = 200;

const UNATTENDED_SYSTEM_PROMPT: &str =
    "This turn is a scheduled task running unattended: nobody is watching the session. Don't ask \
     the user questions, and don't wait for confirmation. Permission requests are sent to the \
     user's phone and rejected if not answered in time; if an action is rejected, carry on with \
     the rest. If you can't finish, say why. End your final reply with an `agentdeck-speech` \
     comment as described above, holding one plain sentence that states the result: it becomes \
     the run's summary.";

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
    fn validate(&self) -> Result<()> {
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
    fn previous(&self, now: DateTime<Utc>, created: DateTime<Utc>) -> Option<DateTime<Utc>> {
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
    fn next(&self, now: DateTime<Utc>, created: DateTime<Utc>) -> Option<DateTime<Utc>> {
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

/// A task as stored in `tasks.json` and sent to clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub cwd: String,
    pub prompt: String,
    pub schedule: Schedule,
    /// Session config options set before prompting, e.g. `{ "model": "sonnet"
    /// }`.
    #[serde(default)]
    pub config_options: HashMap<String, String>,
    /// Wall-clock limit of a run; it is cancelled after this long.
    #[serde(default = "default_timeout_minutes")]
    pub timeout_minutes: u32,
    /// Extra attempts after a failed or timed-out run.
    #[serde(default)]
    pub retries: u32,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// The session the task was created from; changes continue there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    /// When the task was last saved or re-enabled: scheduled times up to here
    /// don't run. Set by the daemon and stored, so a restart doesn't catch up
    /// on them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_from: Option<DateTime<Utc>>,
}

fn default_timeout_minutes() -> u32 {
    DEFAULT_TIMEOUT_MINUTES
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Success,
    Failed,
    Timeout,
}

/// One run, appended to `task_runs/<task id>.jsonl`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub session_id: Option<String>,
    /// The scheduled time it ran for; `None` for "run now".
    pub scheduled_for: Option<DateTime<Utc>>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub status: RunStatus,
    /// The agent's last line, or the error.
    pub summary: String,
    pub attempt: u32,
}

/// What the scheduler needs from the connection to the devices.
pub trait TaskHost: Send + Sync {
    /// Sends the notifications of a run of `task_id` to every connected device;
    /// its pushes name the task, where the run's requests are answered.
    fn notifier(&self, task_id: &str) -> Notifier;
    /// Pushes to every device with a push token.
    fn push(&self, kind: PushKind, agent: &str, session_id: &str);
    /// Notifies every connected device.
    fn broadcast(&self, method: &str, params: Value);
    /// Skills of the latest attaching device.
    fn skills(&self) -> SkillSelection;
}

#[derive(Clone)]
struct RunningTask {
    session_id: Option<String>,
    cancel: CancellationToken,
}

pub struct Tasks {
    paths: AppPaths,
    sessions: Arc<AgentSessionManager>,
    host: OnceLock<Arc<dyn TaskHost>>,
    tasks: Mutex<Vec<Task>>,
    /// The scheduled time each task last fired for.
    fired: Mutex<HashMap<String, DateTime<Utc>>>,
    /// Running tasks, with their cancellation token and current attempt session
    /// once created.
    running: Mutex<HashMap<String, RunningTask>>,
    /// Sessions created by runs, for `agent_session_list`.
    run_sessions: Mutex<HashMap<String, String>>,
    /// Stops the scheduler loop and cancels in-flight runs during daemon
    /// shutdown.
    shutdown: CancellationToken,
}

impl Tasks {
    pub fn load(paths: AppPaths, sessions: Arc<AgentSessionManager>) -> Arc<Self> {
        let tasks: Vec<Task> = fs::read_to_string(paths.tasks_file())
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
        let this = Arc::new(Self {
            paths,
            sessions,
            host: OnceLock::new(),
            tasks: Mutex::new(Vec::new()),
            fired: Mutex::default(),
            running: Mutex::default(),
            run_sessions: Mutex::default(),
            shutdown: CancellationToken::new(),
        });
        for task in &tasks {
            this.remember_runs(task);
        }
        *this.tasks.lock().expect("lock poisoned") = tasks;
        this
    }

    /// Stops the scheduler loop and cancels any in-flight runs silently.
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    /// Restores the last fired time and the run sessions of a task.
    fn remember_runs(&self, task: &Task) {
        let runs = self.runs(&task.id);
        let fired = runs
            .iter()
            .filter_map(|run| run.scheduled_for)
            .max()
            .unwrap_or(task.created_at)
            .max(task.scheduled_from.unwrap_or(task.created_at));
        self.fired
            .lock()
            .expect("lock poisoned")
            .insert(task.id.clone(), fired);
        let mut sessions = self.run_sessions.lock().expect("lock poisoned");
        for session_id in runs.into_iter().filter_map(|run| run.session_id) {
            sessions.insert(session_id, task.id.clone());
        }
    }

    /// Starts the scheduler once the connection to the devices exists.
    pub fn start(self: &Arc<Self>, host: Arc<dyn TaskHost>) {
        if self.host.set(host).is_err() {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                if this.shutdown.is_cancelled() {
                    break;
                }
                this.tick(Utc::now());
                tokio::select! {
                    _ = tokio::time::sleep(TICK) => {}
                    _ = this.shutdown.cancelled() => break,
                }
            }
        });
    }

    fn tick(self: &Arc<Self>, now: DateTime<Utc>) {
        let due = {
            let tasks = self.tasks.lock().expect("lock poisoned");
            let mut fired = self.fired.lock().expect("lock poisoned");
            due_runs(&tasks, &mut fired, now)
        };
        for (task, scheduled_for) in due {
            self.spawn_run(task, Some(scheduled_for));
        }
    }

    /// Runs a task unless it is already running; `false` if it is.
    fn spawn_run(self: &Arc<Self>, task: Task, scheduled_for: Option<DateTime<Utc>>) -> bool {
        if self.shutdown.is_cancelled() {
            return false;
        }
        let cancel = self.shutdown.child_token();
        {
            let mut running = self.running.lock().expect("lock poisoned");
            if running.contains_key(&task.id) {
                tracing::info!("Task {} is still running; skipped a run", task.id);
                return false;
            }
            running.insert(
                task.id.clone(),
                RunningTask {
                    session_id: None,
                    cancel: cancel.clone(),
                },
            );
        }
        if self.shutdown.is_cancelled() || !self.has_task(&task.id) {
            self.running.lock().expect("lock poisoned").remove(&task.id);
            return false;
        }
        self.broadcast_update(&task.id);
        let this = self.clone();
        tokio::spawn(async move {
            for attempt in 0..=task.retries {
                if cancel.is_cancelled() {
                    break;
                }
                if let Some(entry) = this
                    .running
                    .lock()
                    .expect("lock poisoned")
                    .get_mut(&task.id)
                {
                    entry.session_id = None;
                }
                let run = this.run_once(&task, scheduled_for, attempt, &cancel).await;
                if cancel.is_cancelled() || !this.has_task(&task.id) {
                    // Deleted while running or daemon shutting down: drop
                    // without recording.
                    if !this.shutdown.is_cancelled()
                        && let Some(session_id) = run.session_id
                    {
                        this.delete_run_session(&task.agent, &session_id).await;
                    }
                    break;
                }
                let done = run.status == RunStatus::Success || attempt == task.retries;
                let session_id = run.session_id.clone();
                let recorded = this.record(&task, run);
                if !recorded {
                    if !this.shutdown.is_cancelled()
                        && let Some(session_id) = session_id
                    {
                        this.delete_run_session(&task.agent, &session_id).await;
                    }
                    break;
                }
                if done
                    && let Some(session_id) = session_id
                    && let Some(host) = this.host.get()
                {
                    host.push(PushKind::ResponseComplete, &task.agent, &session_id);
                }
                if done {
                    break;
                }
            }
            this.running.lock().expect("lock poisoned").remove(&task.id);
            this.broadcast_update(&task.id);
        });
        true
    }

    async fn run_once(
        &self,
        task: &Task,
        scheduled_for: Option<DateTime<Utc>>,
        attempt: u32,
        cancel: &CancellationToken,
    ) -> Run {
        let started_at = Utc::now();
        let mut run = Run {
            session_id: None,
            scheduled_for,
            started_at,
            ended_at: started_at,
            status: RunStatus::Failed,
            summary: String::new(),
            attempt,
        };
        let Some(host) = self.host.get() else {
            run.summary = "Scheduler not started".to_string();
            return run;
        };
        let context = SessionContext {
            system_prompt: Some(format!(
                "{}\n\n{UNATTENDED_SYSTEM_PROMPT}",
                crate::agent_rpc::remote_app_system_prompt()
            )),
            skills: host.skills(),
            notifier: Some(host.notifier(&task.id)),
            input_timeout: Some(APPROVAL_TIMEOUT),
        };
        let created = tokio::select! {
            created = self.sessions.create_session(&task.agent, Some(PathBuf::from(&task.cwd)), context) => created,
            _ = cancel.cancelled() => return run,
        };
        let session_id = match created {
            Ok(created) => created.session_id,
            Err(err) => {
                run.ended_at = Utc::now();
                run.summary = format!("Failed to start the session: {err}");
                return run;
            }
        };
        run.session_id = Some(session_id.clone());
        if cancel.is_cancelled() {
            self.finish(task, &session_id, &mut run).await;
            return run;
        }
        self.run_sessions
            .lock()
            .expect("lock poisoned")
            .insert(session_id.clone(), task.id.clone());
        // Devices answer the run's permission requests from its task.
        if let Some(entry) = self
            .running
            .lock()
            .expect("lock poisoned")
            .get_mut(&task.id)
        {
            entry.session_id = Some(session_id.clone());
        }
        self.broadcast_update(&task.id);

        let mut options: Vec<_> = task.config_options.iter().collect();
        options.sort();
        for (config_id, value) in options {
            let applied = tokio::select! {
                res = self.sessions.set_config_option(&task.agent, &session_id, config_id, value) => res,
                _ = cancel.cancelled() => {
                    self.finish(task, &session_id, &mut run).await;
                    return run;
                }
            };
            if let Err(err) = applied {
                tracing::warn!("Task {}: failed to set {config_id}: {err}", task.id);
            }
        }

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move { while event_rx.recv().await.is_some() {} });
        let prompt = self.sessions.prompt(
            &task.agent,
            &session_id,
            task.prompt.clone(),
            Vec::new(),
            IDLE_TIMEOUT_SECS,
            event_tx,
            Some(host.notifier(&task.id)),
        );
        tokio::pin!(prompt);
        let limit = Duration::from_secs(u64::from(task.timeout_minutes.max(1)) * 60);
        let result = tokio::select! {
            outcome = tokio::time::timeout(limit, &mut prompt) => match outcome {
                Ok(result) => result,
                Err(_) => {
                    self.sessions.cancel(&task.agent, &session_id).await;
                    let _ = prompt.await;
                    run.status = RunStatus::Timeout;
                    run.summary = format!("Timed out after {} minutes", task.timeout_minutes);
                    self.finish(task, &session_id, &mut run).await;
                    return run;
                }
            },
            _ = cancel.cancelled() => {
                self.finish(task, &session_id, &mut run).await;
                return run;
            }
        };
        match result {
            Ok(answer) => {
                run.status = RunStatus::Success;
                run.summary = summary_of(&answer);
            }
            Err(err) => run.summary = err.to_string(),
        }
        self.finish(task, &session_id, &mut run).await;
        run
    }

    async fn finish(&self, task: &Task, session_id: &str, run: &mut Run) {
        run.ended_at = Utc::now();
        self.sessions.close_session(&task.agent, session_id).await;
    }

    /// Appends a run, prunes old ones (deleting their sessions) and tells
    /// devices. Returns `false` if the task was deleted before recording.
    fn record(self: &Arc<Self>, task: &Task, run: Run) -> bool {
        let dropped = {
            let tasks = self.tasks.lock().expect("lock poisoned");
            if !tasks.iter().any(|existing| existing.id == task.id) {
                return false;
            }
            let mut runs = self.runs(&task.id);
            runs.push(run);
            let (kept, dropped) = prune(runs, Utc::now());
            if let Err(err) = self.write_runs(&task.id, &kept) {
                tracing::warn!("Task {}: failed to save runs: {err:#}", task.id);
            }
            dropped
        };
        if !dropped.is_empty() {
            let this = self.clone();
            let agent = task.agent.clone();
            tokio::spawn(async move {
                for session_id in dropped.into_iter().filter_map(|run| run.session_id) {
                    this.delete_run_session(&agent, &session_id).await;
                }
            });
        }
        if let Some(host) = self.host.get() {
            host.broadcast("task_updated", json!({ "id": task.id }));
        }
        true
    }

    fn has_task(&self, id: &str) -> bool {
        let tasks = self.tasks.lock().expect("lock poisoned");
        tasks.iter().any(|task| task.id == id)
    }

    /// Deletes the session of a run whose record is dropped.
    async fn delete_run_session(&self, agent: &str, session_id: &str) {
        self.run_sessions
            .lock()
            .expect("lock poisoned")
            .remove(session_id);
        let _ = self.sessions.delete_session(agent, session_id).await;
    }

    pub fn runs(&self, task_id: &str) -> Vec<Run> {
        fs::read_to_string(self.paths.task_runs_file(task_id))
            .map(|content| {
                content
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn write_runs(&self, task_id: &str, runs: &[Run]) -> Result<()> {
        let path = self.paths.task_runs_file(task_id);
        if let Some(dir) = path.parent() {
            app_data::ensure_dir(dir)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut file = fs::File::create(&temporary)?;
        for run in runs {
            writeln!(file, "{}", serde_json::to_string(run)?)?;
        }
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    fn save(&self, tasks: &[Task]) -> Result<()> {
        app_data::ensure_dir(self.paths.root())?;
        let path = self.paths.tasks_file();
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, serde_json::to_string_pretty(tasks)?)?;
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    /// Tasks with their next run and latest run, for clients.
    pub fn list(&self) -> Value {
        let now = Utc::now();
        let running = self.running.lock().expect("lock poisoned").clone();
        let tasks = self.tasks.lock().expect("lock poisoned").clone();
        let list: Vec<Value> = tasks
            .into_iter()
            .map(|task| {
                let next = task
                    .enabled
                    .then(|| task.schedule.next(now, task.created_at))
                    .flatten();
                let last = self.runs(&task.id).pop();
                let mut value = serde_json::to_value(&task).unwrap_or_default();
                value["nextRunAt"] = json!(next);
                value["lastRun"] = json!(last);
                value["running"] = json!(running.contains_key(&task.id));
                value["runningSessionId"] =
                    json!(running.get(&task.id).and_then(|r| r.session_id.as_deref()));
                value
            })
            .collect();
        json!({ "tasks": list })
    }

    /// Creates a task (without `id`) or replaces one; returns it.
    pub fn upsert(&self, mut value: Value) -> Result<Task> {
        let id = value.get("id").and_then(Value::as_str).map(str::to_string);
        let mut tasks = self.tasks.lock().expect("lock poisoned");
        let existing = id
            .as_ref()
            .and_then(|id| tasks.iter().position(|task| &task.id == id));
        if id.is_some() && existing.is_none() {
            bail!("unknown task");
        }
        let created_at = existing.map_or_else(Utc::now, |index| tasks[index].created_at);
        value["id"] = json!(id.unwrap_or_else(new_id));
        value["createdAt"] = json!(created_at);
        // A new or rescheduled task waits for its next time instead of catching
        // up.
        let now = Utc::now();
        value["scheduledFrom"] = json!(now);
        let task: Task = serde_json::from_value(value).context("invalid task")?;
        if task.name.trim().is_empty() || task.prompt.trim().is_empty() || task.agent.is_empty() {
            bail!("name, agent and prompt must not be empty");
        }
        if !PathBuf::from(&task.cwd).is_dir() {
            bail!("cwd {} is not a directory", task.cwd);
        }
        task.schedule.validate()?;
        let mut next = tasks.clone();
        match existing {
            Some(index) => next[index] = task.clone(),
            None => next.push(task.clone()),
        }
        self.save(&next)?;
        *tasks = next;
        drop(tasks);
        self.fired
            .lock()
            .expect("lock poisoned")
            .insert(task.id.clone(), now);
        self.broadcast_update(&task.id);
        Ok(task)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        // A re-enabled task waits for its next time, like a rescheduled one.
        let now = Utc::now();
        self.update(id, |task| {
            task.enabled = enabled;
            if enabled {
                task.scheduled_from = Some(now);
            }
        })?;
        if enabled {
            self.fired
                .lock()
                .expect("lock poisoned")
                .insert(id.to_string(), now);
        }
        Ok(())
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Task)) -> Result<()> {
        let mut tasks = self.tasks.lock().expect("lock poisoned");
        let mut next = tasks.clone();
        let Some(task) = next.iter_mut().find(|task| task.id == id) else {
            bail!("unknown task");
        };
        change(task);
        self.save(&next)?;
        *tasks = next;
        drop(tasks);
        self.broadcast_update(id);
        Ok(())
    }

    /// Deletes a task, its run history and the sessions of its runs; a run
    /// in progress is stopped and dropped (see `spawn_run`).
    pub async fn delete(&self, id: &str) -> Result<()> {
        let (removed, run_session_ids) = {
            let mut tasks = self.tasks.lock().expect("lock poisoned");
            let Some(index) = tasks.iter().position(|task| task.id == id) else {
                bail!("unknown task");
            };
            let mut next = tasks.clone();
            let removed = next.remove(index);
            self.save(&next)?;
            *tasks = next;
            let session_ids: Vec<String> = self
                .runs(id)
                .into_iter()
                .filter_map(|run| run.session_id)
                .collect();
            let _ = fs::remove_file(self.paths.task_runs_file(id));
            (removed, session_ids)
        };
        let running = self.running.lock().expect("lock poisoned").get(id).cloned();
        if let Some(running) = running {
            running.cancel.cancel();
            if let Some(session_id) = running.session_id {
                self.sessions
                    .close_session(&removed.agent, &session_id)
                    .await;
            }
        }
        for session_id in run_session_ids {
            self.delete_run_session(&removed.agent, &session_id).await;
        }
        self.fired.lock().expect("lock poisoned").remove(id);
        self.broadcast_update(id);
        Ok(())
    }

    pub fn run_now(self: &Arc<Self>, id: &str) -> Result<bool> {
        let task = self
            .tasks
            .lock()
            .expect("lock poisoned")
            .iter()
            .find(|task| task.id == id)
            .cloned()
            .context("unknown task")?;
        Ok(self.spawn_run(task, None))
    }

    fn broadcast_update(&self, id: &str) {
        if let Some(host) = self.host.get() {
            host.broadcast("task_updated", json!({ "id": id }));
        }
    }

    /// Adds `task: { id, name }` to sessions created by runs.
    pub fn annotate_sessions(&self, mut list: Value) -> Value {
        let run_sessions = self.run_sessions.lock().expect("lock poisoned").clone();
        if run_sessions.is_empty() {
            return list;
        }
        let names: HashMap<String, String> = self
            .tasks
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|task| (task.id.clone(), task.name.clone()))
            .collect();
        let Some(sessions) = list.get_mut("sessions").and_then(Value::as_array_mut) else {
            return list;
        };
        for session in sessions {
            let Some(task_id) = session
                .get("sessionId")
                .and_then(Value::as_str)
                .and_then(|id| run_sessions.get(id))
            else {
                continue;
            };
            if let (Some(name), Some(session)) = (names.get(task_id), session.as_object_mut()) {
                session.insert("task".to_string(), json!({ "id": task_id, "name": name }));
            }
        }
        list
    }
}

/// Tasks whose latest scheduled time passed since they last fired, with that
/// time. Each scheduled time fires at most once, and one missed by more than
/// `MISSED_WINDOW` is skipped. Updates `fired`.
fn due_runs(
    tasks: &[Task],
    fired: &mut HashMap<String, DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Vec<(Task, DateTime<Utc>)> {
    tasks
        .iter()
        .filter(|task| task.enabled)
        .filter_map(|task| {
            let previous = task.schedule.previous(now, task.created_at)?;
            let last = fired.entry(task.id.clone()).or_insert(previous);
            if previous <= *last {
                return None;
            }
            *last = previous;
            (now - previous <= MISSED_WINDOW).then(|| (task.clone(), previous))
        })
        .collect()
}

fn new_id() -> String {
    format!("t{}", Utc::now().timestamp_millis())
}

/// The agent's last `agentdeck-speech` comment, else the last non-empty line
/// outside HTML comments (agents that don't read the system prompt), shortened.
fn summary_of(answer: &str) -> String {
    let mut outside = String::new();
    let mut speech = None;
    let mut rest = answer;
    while let Some(start) = rest.find("<!--") {
        outside.push_str(&rest[..start]);
        let comment = &rest[start + "<!--".len()..];
        let Some(end) = comment.find("-->") else {
            rest = "";
            break;
        };
        if let Some(text) = comment[..end].trim_start().strip_prefix("agentdeck-speech") {
            speech = Some(text);
        }
        rest = &comment[end + "-->".len()..];
    }
    outside.push_str(rest);
    let line = match speech.map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ")) {
        Some(text) if !text.is_empty() => text,
        _ => outside
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or_default()
            .to_string(),
    };
    match line.char_indices().nth(SUMMARY_CHARS) {
        Some((end, _)) => format!("{}…", &line[..end]),
        None => line,
    }
}

/// Keeps the latest `KEPT_SUCCESSES` successful runs and failures younger than
/// `KEPT_FAILURE_DAYS`; returns `(kept, dropped)` in their original order.
fn prune(runs: Vec<Run>, now: DateTime<Utc>) -> (Vec<Run>, Vec<Run>) {
    let successes = runs
        .iter()
        .filter(|run| run.status == RunStatus::Success)
        .count();
    let mut skip_successes = successes.saturating_sub(KEPT_SUCCESSES);
    let oldest_failure = now - chrono::Duration::days(KEPT_FAILURE_DAYS);
    runs.into_iter().partition(|run| {
        if run.status == RunStatus::Success {
            if skip_successes > 0 {
                skip_successes -= 1;
                return false;
            }
            true
        } else {
            run.started_at >= oldest_failure
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHANGHAI: Tz = chrono_tz::Asia::Shanghai;
    const NEW_YORK: Tz = chrono_tz::America::New_York;

    /// A time in Shanghai, where the tests' schedules are.
    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        in_zone(SHANGHAI, y, m, d, h, min)
    }

    fn in_zone(zone: Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        zone.with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn daily(times: &[&str], weekdays: &[u32]) -> Schedule {
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

    #[test]
    fn summary_is_the_speech_comment_else_the_last_line() {
        assert_eq!(
            summary_of("Checked 3 inboxes.\n\nDone: 2 drafts.\n"),
            "Done: 2 drafts."
        );
        assert_eq!(
            summary_of(
                "Sorted the inbox.\n\n<!-- agentdeck-speech\nSorted 12 mails.\nTwo need a \
                 reply.\n-->\n"
            ),
            "Sorted 12 mails. Two need a reply."
        );
        assert_eq!(
            summary_of("Done: 2 drafts.\n<!-- note -->\n<!-- agentdeck-speech\n-->\n<!-- cut"),
            "Done: 2 drafts."
        );
        assert_eq!(
            summary_of(&"x".repeat(300)).chars().count(),
            SUMMARY_CHARS + 1
        );
    }

    fn run(status: RunStatus, days_ago: i64, now: DateTime<Utc>) -> Run {
        let at = now - chrono::Duration::days(days_ago);
        Run {
            session_id: Some(format!("s{days_ago}")),
            scheduled_for: None,
            started_at: at,
            ended_at: at,
            status,
            summary: String::new(),
            attempt: 0,
        }
    }

    #[test]
    fn prune_keeps_recent_successes_and_failures() {
        let now = Utc::now();
        let mut runs: Vec<Run> = (0..25)
            .rev()
            .map(|day| run(RunStatus::Success, day, now))
            .collect();
        runs.insert(0, run(RunStatus::Failed, 100, now));
        runs.insert(1, run(RunStatus::Timeout, 30, now));
        let (kept, dropped) = prune(runs, now);
        assert_eq!(
            kept.iter()
                .filter(|r| r.status == RunStatus::Success)
                .count(),
            KEPT_SUCCESSES
        );
        assert!(kept.iter().any(|r| r.status == RunStatus::Timeout));
        assert!(!kept.iter().any(|r| r.status == RunStatus::Failed));
        // The oldest successes go first.
        assert_eq!(dropped.len(), 6);
        assert!(
            dropped
                .iter()
                .any(|r| r.session_id.as_deref() == Some("s24"))
        );
    }

    fn task(schedule: Schedule, created_at: DateTime<Utc>) -> Task {
        Task {
            id: "t1".to_string(),
            name: "Inbox".to_string(),
            agent: "claude-acp".to_string(),
            cwd: "/".to_string(),
            prompt: "Sort the inbox".to_string(),
            schedule,
            config_options: HashMap::new(),
            timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
            retries: 0,
            enabled: true,
            origin_session_id: None,
            created_at,
            scheduled_from: None,
        }
    }

    #[test]
    fn each_scheduled_time_fires_once_and_old_misses_are_skipped() {
        let created = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let tasks = vec![task(daily(&["09:00", "20:00"], &[]), created)];
        let mut fired = HashMap::from([("t1".to_string(), local(2026, 11, 15, 20, 0))]);

        // Before 09:00 nothing is due.
        assert!(due_runs(&tasks, &mut fired, local(2026, 11, 16, 8, 59)).is_empty());
        // Woke up at 10:30: the 09:00 run is missed by less than the window, so
        // it runs once.
        let due = due_runs(&tasks, &mut fired, local(2026, 11, 16, 10, 30));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1, local(2026, 11, 16, 9, 0));
        assert!(due_runs(&tasks, &mut fired, local(2026, 11, 16, 10, 31)).is_empty());
        // Asleep from 19:00 until 03:00: the 20:00 run is too old to catch up.
        assert!(due_runs(&tasks, &mut fired, local(2026, 11, 17, 3, 0)).is_empty());
        assert!(due_runs(&tasks, &mut fired, local(2026, 11, 17, 3, 1)).is_empty());

        let mut disabled = tasks.clone();
        disabled[0].enabled = false;
        assert!(due_runs(&disabled, &mut fired, local(2026, 11, 17, 9, 1)).is_empty());
    }

    #[test]
    fn saved_and_re_enabled_tasks_do_not_catch_up_after_a_restart() {
        let root = std::env::temp_dir().join(format!("agentdeck-tasks-{}", new_id()));
        let load = || {
            Tasks::load(
                AppPaths::new(root.clone()),
                Arc::new(AgentSessionManager::new(None)),
            )
        };
        let fired = |tasks: &Tasks, id: &str| tasks.fired.lock().unwrap()[id];

        let tasks = load();
        let id = tasks
            .upsert(json!({
                "name": "Inbox", "agent": "claude-acp", "cwd": "/", "prompt": "Sort",
                "schedule": { "type": "daily", "times": ["09:00"], "timeZone": "Asia/Shanghai" },
            }))
            .unwrap()
            .id;
        let saved = fired(&tasks, &id);
        assert_eq!(fired(&load(), &id), saved);

        tasks.set_enabled(&id, false).unwrap();
        assert_eq!(fired(&load(), &id), saved);
        tasks.set_enabled(&id, true).unwrap();
        let enabled = fired(&tasks, &id);
        assert!(enabled > saved);
        assert_eq!(fired(&load(), &id), enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tasks_round_trip_with_defaults() {
        let value = json!({
            "id": "t1", "name": "Inbox", "agent": "claude-acp", "cwd": "/", "prompt": "Sort",
            "schedule": { "type": "daily", "times": ["09:00"], "timeZone": "Asia/Shanghai" },
            "createdAt": "2026-11-16T00:00:00Z"
        });
        let parsed: Task = serde_json::from_value(value).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.timeout_minutes, DEFAULT_TIMEOUT_MINUTES);
        assert_eq!(parsed.schedule, daily(&["09:00"], &[]));
        let created = Utc.with_ymd_and_hms(2026, 11, 16, 0, 0, 0).unwrap();
        let back = serde_json::to_value(task(daily(&["09:00"], &[]), created)).unwrap();
        assert_eq!(back["schedule"]["type"], "daily");
        assert_eq!(back["schedule"]["timeZone"], "Asia/Shanghai");
        assert_eq!(back["createdAt"], "2026-11-16T00:00:00Z");
    }

    #[tokio::test]
    async fn delete_cancels_running_task_and_blocks_late_record() {
        let root = std::env::temp_dir().join(format!("agentdeck-tasks-delete-{}", new_id()));
        let tasks = Tasks::load(
            AppPaths::new(root.clone()),
            Arc::new(AgentSessionManager::new(None)),
        );
        let created = tasks
            .upsert(json!({
                "name": "Inbox", "agent": "claude-acp", "cwd": "/", "prompt": "Sort",
                "schedule": { "type": "daily", "times": ["09:00"], "timeZone": "Asia/Shanghai" },
            }))
            .unwrap();
        let mut initial_run = run(RunStatus::Success, 0, Utc::now());
        initial_run.session_id = None;
        assert!(tasks.record(&created, initial_run));
        assert!(tasks.paths.task_runs_file(&created.id).exists());

        let cancel = tasks.shutdown.child_token();
        tasks.running.lock().unwrap().insert(
            created.id.clone(),
            RunningTask {
                session_id: None,
                cancel: cancel.clone(),
            },
        );

        tasks.delete(&created.id).await.unwrap();
        assert!(cancel.is_cancelled());
        assert!(!tasks.paths.task_runs_file(&created.id).exists());

        assert!(!tasks.record(&created, run(RunStatus::Success, 0, Utc::now())));
        assert!(!tasks.paths.task_runs_file(&created.id).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_running_tasks_and_blocks_new_runs() {
        let root = std::env::temp_dir().join(format!("agentdeck-tasks-shutdown-{}", new_id()));
        let tasks = Tasks::load(
            AppPaths::new(root.clone()),
            Arc::new(AgentSessionManager::new(None)),
        );
        let created = tasks
            .upsert(json!({
                "name": "Inbox", "agent": "claude-acp", "cwd": "/", "prompt": "Sort",
                "schedule": { "type": "daily", "times": ["09:00"], "timeZone": "Asia/Shanghai" },
            }))
            .unwrap();
        let cancel = tasks.shutdown.child_token();
        tasks.running.lock().unwrap().insert(
            created.id.clone(),
            RunningTask {
                session_id: None,
                cancel: cancel.clone(),
            },
        );

        tasks.shutdown();
        assert!(cancel.is_cancelled());

        tasks.running.lock().unwrap().remove(&created.id);
        assert!(!tasks.run_now(&created.id).unwrap());
        assert!(tasks.runs(&created.id).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
