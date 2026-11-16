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
use chrono::{DateTime, Datelike, Local, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;

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
/// A turn without any update for this long is cancelled (`prompt`'s idle timeout).
const IDLE_TIMEOUT_SECS: u64 = 10 * 60;
/// An unanswered permission request or question is refused after this long.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DEFAULT_TIMEOUT_MINUTES: u32 = 60;
/// Successful runs kept per task; their sessions are deleted with them.
const KEPT_SUCCESSES: usize = 20;
/// Failed runs are kept longer, to look into.
const KEPT_FAILURE_DAYS: i64 = 90;
const SUMMARY_CHARS: usize = 200;

const UNATTENDED_SYSTEM_PROMPT: &str = "This turn is a scheduled task running unattended: \
     nobody is watching the session. Don't ask the user questions, and don't wait for \
     confirmation. Permission requests are sent to the user's phone and rejected if not \
     answered in time; if an action is rejected, carry on with the rest. If you can't \
     finish, say why. End with one short line stating the result.";

/// When a task runs, in the host's local time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Schedule {
    /// At each `HH:MM` of `times`, on `weekdays` (1 = Monday … 7 = Sunday; empty
    /// means every day).
    Daily {
        times: Vec<String>,
        #[serde(default)]
        weekdays: Vec<u32>,
    },
    /// Every `minutes`, counted from the task's creation.
    Interval { minutes: u32 },
}

impl Schedule {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Daily { times, weekdays } => {
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

    /// The latest scheduled time at or before `now`.
    fn previous(&self, now: DateTime<Local>, created: DateTime<Utc>) -> Option<DateTime<Local>> {
        match self {
            Self::Daily { times, weekdays } => {
                let times: Vec<NaiveTime> =
                    times.iter().filter_map(|t| parse_time(t).ok()).collect();
                (0..8).find_map(|days_back| {
                    let date = now.date_naive() - chrono::Days::new(days_back);
                    let weekday = date.weekday().number_from_monday();
                    if !weekdays.is_empty() && !weekdays.contains(&weekday) {
                        return None;
                    }
                    times
                        .iter()
                        .filter_map(|time| {
                            Local.from_local_datetime(&date.and_time(*time)).earliest()
                        })
                        .filter(|at| *at <= now)
                        .max()
                })
            }
            Self::Interval { minutes } => {
                let created = created.with_timezone(&Local);
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
    fn next(&self, now: DateTime<Local>, created: DateTime<Utc>) -> Option<DateTime<Local>> {
        match self {
            Self::Daily { times, weekdays } => {
                let times: Vec<NaiveTime> =
                    times.iter().filter_map(|t| parse_time(t).ok()).collect();
                (0..8).find_map(|days_ahead| {
                    let date = now.date_naive() + chrono::Days::new(days_ahead);
                    let weekday = date.weekday().number_from_monday();
                    if !weekdays.is_empty() && !weekdays.contains(&weekday) {
                        return None;
                    }
                    times
                        .iter()
                        .filter_map(|time| {
                            Local.from_local_datetime(&date.and_time(*time)).earliest()
                        })
                        .filter(|at| *at > now)
                        .min()
                })
            }
            Self::Interval { minutes } => {
                let created = created.with_timezone(&Local);
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
    /// Session config options set before prompting, e.g. `{ "model": "sonnet" }`.
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
    /// don't run. Set by the daemon and stored, so a restart doesn't catch up on them.
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

pub struct Tasks {
    paths: AppPaths,
    sessions: Arc<AgentSessionManager>,
    host: OnceLock<Arc<dyn TaskHost>>,
    tasks: Mutex<Vec<Task>>,
    /// The scheduled time each task last fired for.
    fired: Mutex<HashMap<String, DateTime<Local>>>,
    /// Running tasks, with the session of the current attempt once created.
    running: Mutex<HashMap<String, Option<String>>>,
    /// Sessions created by runs, for `agent_session_list`.
    run_sessions: Mutex<HashMap<String, String>>,
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
        });
        for task in &tasks {
            this.remember_runs(task);
        }
        *this.tasks.lock().expect("lock poisoned") = tasks;
        this
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
            .insert(task.id.clone(), fired.with_timezone(&Local));
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
                this.tick(Local::now());
                tokio::time::sleep(TICK).await;
            }
        });
    }

    fn tick(self: &Arc<Self>, now: DateTime<Local>) {
        let due = {
            let tasks = self.tasks.lock().expect("lock poisoned");
            let mut fired = self.fired.lock().expect("lock poisoned");
            due_runs(&tasks, &mut fired, now)
        };
        for (task, scheduled_for) in due {
            self.spawn_run(task, Some(scheduled_for.with_timezone(&Utc)));
        }
    }

    /// Runs a task unless it is already running; `false` if it is.
    fn spawn_run(self: &Arc<Self>, task: Task, scheduled_for: Option<DateTime<Utc>>) -> bool {
        {
            let mut running = self.running.lock().expect("lock poisoned");
            if running.contains_key(&task.id) {
                tracing::info!("Task {} is still running; skipped a run", task.id);
                return false;
            }
            running.insert(task.id.clone(), None);
        }
        self.broadcast_update(&task.id);
        let this = self.clone();
        tokio::spawn(async move {
            for attempt in 0..=task.retries {
                let run = this.run_once(&task, scheduled_for, attempt).await;
                if !this.has_task(&task.id) {
                    // Deleted while running: its history is gone, so this run goes too.
                    if let Some(session_id) = run.session_id {
                        this.delete_run_session(&task.agent, &session_id).await;
                    }
                    break;
                }
                let done = run.status == RunStatus::Success || attempt == task.retries;
                this.record(&task, run);
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
        let created = self
            .sessions
            .create_session(&task.agent, Some(PathBuf::from(&task.cwd)), context)
            .await;
        let session_id = match created {
            Ok(created) => created.session_id,
            Err(err) => {
                run.ended_at = Utc::now();
                run.summary = format!("Failed to start the session: {err}");
                return run;
            }
        };
        run.session_id = Some(session_id.clone());
        self.run_sessions
            .lock()
            .expect("lock poisoned")
            .insert(session_id.clone(), task.id.clone());
        // Devices answer the run's permission requests from its task.
        self.running
            .lock()
            .expect("lock poisoned")
            .insert(task.id.clone(), Some(session_id.clone()));
        self.broadcast_update(&task.id);

        let mut options: Vec<_> = task.config_options.iter().collect();
        options.sort();
        for (config_id, value) in options {
            if let Err(err) = self
                .sessions
                .set_config_option(&task.agent, &session_id, config_id, value)
                .await
            {
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
        let result = match tokio::time::timeout(limit, &mut prompt).await {
            Ok(result) => result,
            Err(_) => {
                self.sessions.cancel(&task.agent, &session_id).await;
                let _ = prompt.await;
                run.status = RunStatus::Timeout;
                run.summary = format!("Timed out after {} minutes", task.timeout_minutes);
                self.finish(task, &session_id, host.as_ref(), &mut run)
                    .await;
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
        self.finish(task, &session_id, host.as_ref(), &mut run)
            .await;
        run
    }

    async fn finish(&self, task: &Task, session_id: &str, host: &dyn TaskHost, run: &mut Run) {
        run.ended_at = Utc::now();
        self.sessions.close_session(&task.agent, session_id).await;
        // A task deleted while running ends silently.
        if self.has_task(&task.id) {
            host.push(PushKind::ResponseComplete, &task.agent, session_id);
        }
    }

    /// Appends a run, prunes old ones (deleting their sessions) and tells devices.
    fn record(self: &Arc<Self>, task: &Task, run: Run) {
        let mut runs = self.runs(&task.id);
        runs.push(run);
        let (kept, dropped) = prune(runs, Utc::now());
        if let Err(err) = self.write_runs(&task.id, &kept) {
            tracing::warn!("Task {}: failed to save runs: {err:#}", task.id);
        }
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
        let now = Local::now();
        let running = self.running.lock().expect("lock poisoned").clone();
        let tasks = self.tasks.lock().expect("lock poisoned").clone();
        let list: Vec<Value> = tasks
            .into_iter()
            .map(|task| {
                let next = task
                    .enabled
                    .then(|| task.schedule.next(now, task.created_at))
                    .flatten()
                    .map(|at| at.with_timezone(&Utc));
                let last = self.runs(&task.id).pop();
                let mut value = serde_json::to_value(&task).unwrap_or_default();
                value["nextRunAt"] = json!(next);
                value["lastRun"] = json!(last);
                value["running"] = json!(running.contains_key(&task.id));
                value["runningSessionId"] = json!(running.get(&task.id).cloned().flatten());
                value
            })
            .collect();
        // Schedules are in the host's local time, which the phone may not share.
        let utc_offset_minutes = now.offset().local_minus_utc() / 60;
        json!({ "tasks": list, "utcOffsetMinutes": utc_offset_minutes })
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
        // A new or rescheduled task waits for its next time instead of catching up.
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
            .insert(task.id.clone(), now.with_timezone(&Local));
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
                .insert(id.to_string(), now.with_timezone(&Local));
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
        let removed = {
            let mut tasks = self.tasks.lock().expect("lock poisoned");
            let Some(index) = tasks.iter().position(|task| task.id == id) else {
                bail!("unknown task");
            };
            let mut next = tasks.clone();
            let removed = next.remove(index);
            self.save(&next)?;
            *tasks = next;
            removed
        };
        let running = self.running.lock().expect("lock poisoned").get(id).cloned();
        if let Some(Some(session_id)) = running {
            self.sessions
                .close_session(&removed.agent, &session_id)
                .await;
        }
        for session_id in self.runs(id).into_iter().filter_map(|run| run.session_id) {
            self.delete_run_session(&removed.agent, &session_id).await;
        }
        let _ = fs::remove_file(self.paths.task_runs_file(id));
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
    fired: &mut HashMap<String, DateTime<Local>>,
    now: DateTime<Local>,
) -> Vec<(Task, DateTime<Local>)> {
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

/// The last non-empty line of the agent's answer, shortened. HTML comments
/// are left out: the client hides them, e.g. the spoken summary
/// `<!-- agentdeck-speech … -->` the remote app asks for.
fn summary_of(answer: &str) -> String {
    let mut text = String::new();
    let mut rest = answer;
    while let Some(start) = rest.find("<!--") {
        text.push_str(&rest[..start]);
        rest = rest[start..]
            .find("-->")
            .map_or("", |end| &rest[start + end + 3..]);
    }
    text.push_str(rest);
    let line = text
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default();
    match line.char_indices().nth(SUMMARY_CHARS) {
        Some((end, _)) => format!("{}…", &line[..end]),
        None => line.to_string(),
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

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    fn daily(times: &[&str], weekdays: &[u32]) -> Schedule {
        Schedule::Daily {
            times: times.iter().map(|t| t.to_string()).collect(),
            weekdays: weekdays.to_vec(),
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
    fn interval_counts_from_creation() {
        let created = local(2026, 11, 16, 8, 0).with_timezone(&Utc);
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
        assert!(daily(&["25:00"], &[]).validate().is_err());
        assert!(daily(&[], &[]).validate().is_err());
        assert!(daily(&["09:00"], &[0]).validate().is_err());
        assert!(Schedule::Interval { minutes: 1 }.validate().is_err());
    }

    #[test]
    fn summary_is_the_last_line() {
        assert_eq!(
            summary_of("Checked 3 inboxes.\n\nDone: 2 drafts.\n"),
            "Done: 2 drafts."
        );
        assert_eq!(
            summary_of(&"x".repeat(300)).chars().count(),
            SUMMARY_CHARS + 1
        );
        assert_eq!(
            summary_of("今天需要跟进 3 条\n\n<!-- agentdeck-speech\n有 3 条要跟进。\n-->\n"),
            "今天需要跟进 3 条"
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
        // Woke up at 10:30: the 09:00 run is missed by less than the window, so it runs once.
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
        let fired = |tasks: &Tasks, id: &str| tasks.fired.lock().unwrap()[id].with_timezone(&Utc);

        let tasks = load();
        let id = tasks
            .upsert(json!({
                "name": "Inbox", "agent": "claude-acp", "cwd": "/", "prompt": "Sort",
                "schedule": { "type": "daily", "times": ["09:00"] },
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
            "schedule": { "type": "daily", "times": ["09:00"] },
            "createdAt": "2026-11-16T00:00:00Z"
        });
        let parsed: Task = serde_json::from_value(value).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.timeout_minutes, DEFAULT_TIMEOUT_MINUTES);
        assert_eq!(parsed.schedule, daily(&["09:00"], &[]));
        let created = Utc.with_ymd_and_hms(2026, 11, 16, 0, 0, 0).unwrap();
        let back = serde_json::to_value(task(daily(&["09:00"], &[]), created)).unwrap();
        assert_eq!(back["schedule"]["type"], "daily");
        assert_eq!(back["createdAt"], "2026-11-16T00:00:00Z");
    }
}
